import { GoogleSheetsReader } from "./googleSheets.js";
import { inspectDocument } from "./doctor.js";
import { DemoFixture } from "./doctorDemo.js";
export class TableDoctor {
  constructor(store, config, { reader, now = () => new Date() } = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.reader =
      reader ||
      new GoogleSheetsReader({
        credentialsFile: config.googleCredentialsFile,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      });
    this.fixture = new DemoFixture(config.dataDir);
    this.current = null;
  }
  run(signal) {
    if (this.current) return this.current;
    this.current = this.inspect(signal).finally(() => {
      this.current = null;
    });
    return this.current;
  }
  async setDemo(scenario, signal) {
    if (!this.config.doctorDemoEnabled) throw new Error("Demo disabled");
    if (this.current) throw new Error("Check already running");
    this.fixture.write(scenario);
    this.store.log(
      "demo_changed",
      "ДЕМОНСТРАЦИЯ: источник переведён в состояние " + scenario,
    );
    return this.run(signal);
  }
  state() {
    const checks = this.store
        .overview()
        .checks.filter((c) => c.kind === "table_doctor"),
      last = this.store.meta("doctorLastCheck");
    return {
      ok: true,
      running: !!this.current,
      lastCheck: last,
      lastSuccessfulCheck:
        checks
          .filter((c) => !c.demonstration && c.lastSuccessfulAt)
          .map((c) => c.lastSuccessfulAt)
          .sort()
          .at(-1) || null,
      demoCheckedFormulas: checks
        .filter((c) => c.demonstration && c.status === "ok")
        .reduce((a, c) => a + (c.checkedFormulas || 0), 0),
      checkedFormulas: checks.some((c) => !c.demonstration && c.status === "ok")
        ? checks
            .filter((c) => !c.demonstration && c.status === "ok")
            .reduce((a, c) => a + (c.checkedFormulas || 0), 0)
        : null,
      demoEnabled: !!this.config.doctorDemoEnabled,
      documents: (this.config.doctorDocuments || [])
        .filter((d) => d.enabled)
        .map((d) => ({
          id: d.id,
          name: d.name,
          department: d.department,
          demonstration: d.adapter === "fixture",
          purpose: d.purpose,
          sheets: d.sheets.map((s) => ({ name: s.name, gid: s.gid })),
          pendingRules: d.sheets
            .flatMap((s) => s.rules)
            .filter((r) => r.approval !== "approved").length,
          check: checks.find((c) => c.id === d.id) || null,
          sourceUrl:
            d.adapter === "google"
              ? "https://docs.google.com/spreadsheets/d/" +
                d.documentId +
                "/edit"
              : null,
        })),
    };
  }
  async inspect(signal) {
    for (const document of (this.config.doctorDocuments || []).filter(
      (d) => d.enabled,
    )) {
      if (signal?.aborted) return this.state();
      const at = this.now().toISOString(),
        common = {
          kind: "table_doctor",
          name: document.name,
          department: document.department,
          demonstration: document.adapter === "fixture",
        };
      if (document.adapter === "google" && !this.reader.configured) {
        this.store.check(
          document.id,
          {
            ...common,
            status: "not_configured",
            message:
              "Авторизованный Google Sheets API не настроен; формулы не проверены",
            checkedFormulas: null,
            issueCount: null,
          },
          at,
        );
        continue;
      }
      try {
        let spreadsheet;
        if (document.adapter === "fixture")
          spreadsheet = this.fixture.read().spreadsheet;
        else {
          const metadata = await this.reader.metadata(
              document.documentId,
              signal,
            ),
            batches = [];
          // One bounded sheet per request, at most 100k cells; no entire-document dump.
          for (const schema of document.sheets) {
            const existing = metadata.sheets.find(
              (s) => s.properties.sheetId === schema.gid,
            );
            if (!existing) continue;
            const rows = Math.min(
                schema.maxRows,
                existing.properties.gridProperties.rowCount,
              ),
              title = existing.properties.title.replaceAll("'", "''");
            const payload = await this.reader.grid(
              document.documentId,
              ["'" + title + "'!A1:" + schema.lastColumn + rows],
              signal,
            );
            const sheet = payload.sheets.find(
              (s) => s.properties.sheetId === schema.gid,
            );
            if (!sheet) throw new Error("Missing grid response");
            batches.push(sheet);
          }
          spreadsheet = {
            ...metadata,
            sheets: metadata.sheets.map((s) => ({
              ...s,
              data:
                batches.find(
                  (b) => b.properties.sheetId === s.properties.sheetId,
                )?.data || [],
            })),
          };
        }
        const previous =
          this.store.getSnapshot("doctor-baseline:" + document.id)?.value || {};
        const result = inspectDocument(document, spreadsheet, {
          baseline: previous,
          now: this.now(),
        });
        this.store.reconcile("doctor:data:" + document.id, result.findings, {
          verified: result.complete,
          at,
        });
        this.store.reconcile("doctor:access:" + document.id, [], {
          verified: true,
          at,
        });
        this.store.snapshot(
          "doctor-baseline:" + document.id,
          { ...previous, ...result.baseline },
          at,
        );
        this.store.check(
          document.id,
          {
            ...common,
            status: result.complete ? "ok" : "degraded",
            ...result.stats,
            issueCount: result.findings.length,
            lastSuccessfulAt: result.complete
              ? at
              : this.store.overview().checks.find((c) => c.id === document.id)
                  ?.lastSuccessfulAt || null,
            message: result.complete
              ? "Диапазоны прочитаны; правила проверены"
              : "Структура нарушена; отсутствующие проблемы не закрываются",
          },
          at,
        );
        if (result.complete && !common.demonstration)
          this.store.meta("doctorLastSuccessful", at);
        this.store.log(
          "doctor_check",
          (common.demonstration ? "ДЕМОНСТРАЦИЯ · " : "") +
            "Table Doctor: " +
            document.name +
            "; формул " +
            result.stats.checkedFormulas +
            ", проблем " +
            result.findings.length,
          null,
          at,
        );
      } catch {
        if (signal?.aborted) return this.state();
        this.store.reconcile(
          "doctor:access:" + document.id,
          [
            {
              kind: "table_doctor",
              sourceId: document.id,
              sourceName: document.name,
              department: document.department,
              sheet: "",
              cell: "",
              type: "sheets_api_unavailable",
              severity: "critical",
              title: "Google Sheets API недоступен",
              observed: "Не удалось прочитать документ",
              expected: "Успешное авторизованное чтение",
              cause: "Проверьте доступ, сеть и квоты; причина не подтверждена",
              impact:
                "Текущие формулы не проверены; предыдущие проблемы сохраняются",
              recommendation:
                "Проверить настройки сервисного аккаунта и повторить проверку",
              verification: "rule_confirmed",
              initialStatus: "new",
              sourceUrl:
                "https://docs.google.com/spreadsheets/d/" +
                document.documentId +
                "/edit",
            },
          ],
          { verified: true, at },
        );
        const previous = this.store
          .overview()
          .checks.find((c) => c.id === document.id);
        this.store.check(
          document.id,
          {
            ...common,
            status: "unavailable",
            checkedFormulas: null,
            issueCount: null,
            lastSuccessfulAt: previous?.lastSuccessfulAt || null,
            message: "Чтение недоступно; это не нулевая производительность",
          },
          at,
        );
        this.store.log(
          "doctor_unavailable",
          "Table Doctor: источник недоступен; сведения сохранены",
          null,
          at,
        );
      }
    }
    this.store.meta("doctorLastCheck", this.now().toISOString());
    return this.state();
  }
}
