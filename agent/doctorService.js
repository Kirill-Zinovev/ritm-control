import { DiagnosticGovernance } from "./diagnosticGovernance.js";
import { FormulaIntelligence } from "./formulaIntelligence.js";
import { diagnoseDataQuality } from "./dataQuality.js";
import { reviewDocument } from "./diagnosticReview.js";
import { businessPreview } from "./businessDoctor.js";
import { readDoctorSheet } from "./doctorRead.js";
import { GoogleSheetsReader } from "./googleSheets.js";
import { inspectDocument } from "./doctor.js";
import { formulaInventory } from "./doctorInventory.js";
import { DemoFixture } from "./doctorDemo.js";
import { measureGrid, metricDelta, accessMessage } from "./doctorTelemetry.js";
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
        minIntervalMs: config.googleMinIntervalMs ?? 2000,
      });
    this.governance = new DiagnosticGovernance(store, config, { now });
    this.formulas = new FormulaIntelligence(store, config, { now });
    this.fixture = new DemoFixture(config.dataDir);
    this.current = null;
    this.fastCurrent = null;
    this.scanTail = Promise.resolve();
  }
  enqueueScan(scan) {
    const next = this.scanTail.catch(() => {}).then(scan);
    this.scanTail = next;
    return next;
  }
  run(signal) {
    return this.runInspection(null, signal);
  }
  runDocument(documentId, signal) {
    if (
      !(this.config.doctorDocuments || []).some(
        (document) =>
          document.id === documentId &&
          document.enabled &&
          document.adapter === "google",
      )
    )
      return Promise.reject(
        new Error("Document is outside the real read scope"),
      );
    // A caller requesting a document check needs a fresh document-scoped result.
    // Do not mistake an older/global in-flight scan's state snapshot for this run.
    if (this.current)
      return this.current
        .catch(() => {})
        .then(() => this.runDocument(documentId, signal));
    const startedAt = this.now().toISOString();
    return this.runInspection(documentId, signal).then((result) => {
      const document = result.documents?.find((item) => item.id === documentId),
        check = document?.check,
        checkAt = check?.readVerifiedAt || null,
        complete =
          check?.status === "ok" &&
          !check.errorCode &&
          typeof checkAt === "string" &&
          Number.isFinite(Date.parse(checkAt)) &&
          Date.parse(checkAt) >= Date.parse(startedAt) - 1000;
      return {
        ...result,
        complete,
        documentId,
        startedAt,
        at: checkAt || this.now().toISOString(),
        documentRun: {
          documentId,
          complete,
          startedAt,
          at: checkAt,
          status: check?.status || "unavailable",
          errorCode: check?.errorCode || null,
        },
      };
    });
  }
  runInspection(documentId, signal) {
    if (this.current) return this.current;
    this.current = this.enqueueScan(() =>
      this.inspect(signal, documentId),
    ).finally(() => {
      this.current = null;
    });
    return this.current;
  }
  runFast(signal) {
    if (this.fastCurrent) return this.fastCurrent;
    this.fastCurrent = this.enqueueScan(() =>
      this.formulas.fastCheck(this.reader, signal, this.now()),
    ).finally(() => {
      this.fastCurrent = null;
    });
    return this.fastCurrent;
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
        .checks.filter((c) => c.kind === "table_doctor")
        .map((c) => ({
          ...c,
          stale:
            this.now().getTime() - Date.parse(c.at) >
            this.config.snapshotMaxAgeMs,
        })),
      last = this.store.meta("doctorLastCheck");
    const enabledIds = new Set(
      this.config.doctorDocuments
        .filter((d) => d.enabled && d.adapter === "google")
        .map((d) => d.id),
    );
    const realChecks = checks.filter((c) => enabledIds.has(c.id));
    const validReads = realChecks.filter(
      (c) =>
        c.readVerifiedAt &&
        c.status !== "unavailable" &&
        c.status !== "not_configured" &&
        !c.stale,
    );
    const connection = !this.reader.configured
      ? "not_configured"
      : realChecks.some((c) => c.status === "unavailable")
        ? "unavailable"
        : validReads.length === enabledIds.size && enabledIds.size > 0
          ? "verified"
          : validReads.length
            ? "partial"
            : "awaiting_verification";
    const review = this.governance.state();
    const approved = new Set(
      review.rules.filter((r) => r.approval === "approved").map((r) => r.id),
    );
    return {
      review,
      formulaIntelligence: this.formulas.state(),
      ok: true,
      running: !!this.current,
      fastRunning: !!this.fastCurrent,
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
      checkedFormulas: validReads.length
        ? validReads.reduce((a, c) => a + (c.checkedFormulas || 0), 0)
        : null,
      connection,
      formulasRead: validReads.length
        ? validReads.reduce((a, c) => a + (c.formulasRead || 0), 0)
        : null,
      kpiImpact: null, // Older audit includes sheets excluded from current monitoring.
      manualAudit: this.store.getSnapshot("doctor:manual-audit")?.value || null,
      demoEnabled: !!this.config.doctorDemoEnabled,
      documents: (this.config.doctorDocuments || [])
        .filter((d) => d.enabled)
        .map((d) => ({
          id: d.id,
          name: d.name,
          department: d.department,
          demonstration: d.adapter === "fixture",
          purpose: d.purpose,
          formulaRules: (
            this.store.getSnapshot("doctor-inventory:" + d.id)?.value || []
          ).filter((r) => d.sheets.some((s) => s.gid === r.gid)),
          businessPreview: (() => {
            const p = this.store.getSnapshot("doctor-business:" + d.id)?.value;
            return p
              ? {
                  ...p,
                  checks: p.checks.map((c) => {
                    const rule = review.rules.find((r) => r.id === c.id);
                    return rule
                      ? {
                          ...c,
                          approval: rule.approval,
                          rowsChecked: rule.rowsChecked,
                          observations: rule.deviations,
                        }
                      : c;
                  }),
                }
              : null;
          })(),
          sheets: d.sheets.map((s) => {
            const check = checks.find((c) => c.id === d.id),
              metric = check?.sheetMetrics?.find((m) => m.gid === s.gid);
            return {
              name: s.name,
              gid: s.gid,
              purpose: s.purpose || "",
              lastCheck: metric?.readAt || null,
              status: check?.status || "not_configured",
              formulasRead: metric?.formulasRead ?? null,
              displayedErrors: metric?.displayedErrors ?? null,
              issueCount:
                check?.status === "ok" ? (metric?.issueCount ?? 0) : null,
              activeChecks: [
                ...s.rules
                  .filter((r) => r.approval === "approved")
                  .map((r) => r.id),
                ...(s.businessChecks || [])
                  .filter((r) => approved.has(r.id))
                  .map((r) => r.title),
              ],
              pendingChecks: [
                ...s.rules
                  .filter((r) => r.approval !== "approved")
                  .map((r) => r.id),
                ...(s.businessChecks || [])
                  .filter((r) => !approved.has(r.id))
                  .map((r) => r.title),
              ],
            };
          }),
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
  async inspect(signal, onlyDocumentId = null) {
    for (const document of (this.config.doctorDocuments || []).filter(
      (d) => d.enabled && (!onlyDocumentId || d.id === onlyDocumentId),
    )) {
      if (signal?.aborted) return this.state();
      const started = performance.now();
      const metricsBefore = this.reader.telemetry?.();
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
            formulasRead: null,
            readVerifiedAt: null,
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
            const sheet = await readDoctorSheet(
              this.reader,
              document.documentId,
              schema,
              existing,
              signal,
              { fullGrid: true },
            );
            batches.push(sheet);
          }
          spreadsheet = {
            ...metadata,
            sheets: metadata.sheets.map((s) => ({
              ...s,
              readBounds: batches.find(
                (b) => b.properties.sheetId === s.properties.sheetId,
              )?.readBounds,
              readAt:
                batches.find(
                  (b) => b.properties.sheetId === s.properties.sheetId,
                )?.readAt || null,
              data:
                batches.find(
                  (b) => b.properties.sheetId === s.properties.sheetId,
                )?.data || [],
            })),
          };
        }
        const readStats = measureGrid(document, spreadsheet);
        this.store.snapshot(
          "doctor-inventory:" + document.id,
          formulaInventory(document, spreadsheet),
          at,
        );
        const diagnosticStart = performance.now();
        const previous =
          this.store.getSnapshot("doctor-baseline:" + document.id)?.value || {};
        const result = inspectDocument(document, spreadsheet, {
          baseline: previous,
          now: this.now(),
        });
        const draft = result.complete
          ? businessPreview(document, spreadsheet, this.now(), {
              printingSnapshot: this.store.getSnapshot("printing-seasonal"),
            })
          : {
              at: this.now().toISOString(),
              checks: document.sheets.flatMap((s) =>
                (s.businessChecks || []).map((r) => ({
                  id: r.id,
                  title: r.title,
                  sheet: s.name,
                  gid: s.gid,
                  approval: r.approval,
                  status: "blocked_structure",
                  rowsChecked: 0,
                  observations: 0,
                  samples: [],
                  metrics: {
                    reason:
                      "Структура не подтверждена; бизнес-выводы заблокированы",
                  },
                  limitations: r.limitations,
                })),
              ),
              findings: [],
            };
        this.store.snapshot(
          "doctor-business:" + document.id,
          draft,
          this.now().toISOString(),
        );
        if (result.complete && document.adapter === "google")
          this.store.snapshot(
            "doctor-review:" + document.id,
            reviewDocument(document, spreadsheet, draft, this.now()),
            this.now().toISOString(),
          );
        if (result.complete && document.adapter === "google")
          result.findings = this.governance.reviewLegacy(
            document,
            result.findings,
            at,
          );
        const priorDataQuality =
            this.store.getSnapshot("doctor:source-values:" + document.id)
              ?.value || null,
          dataQuality = result.complete
            ? diagnoseDataQuality(
                document,
                spreadsheet,
                priorDataQuality,
                this.now(),
              )
            : { findings: [], snapshot: priorDataQuality },
          dataQualityErrors = new Set(
            dataQuality.findings.flatMap((finding) =>
              (finding.errorCells || []).map(
                (cell) => cell.gid + ":" + cell.cell,
              ),
            ),
          );
        const formulaFindings = this.formulas.inspect(
          document,
          spreadsheet,
          result.complete,
          at,
          { suppressCalculationCells: dataQualityErrors },
        );
        if (result.complete) {
          this.store.snapshot(
            "doctor:source-values:" + document.id,
            dataQuality.snapshot,
            at,
          );
          this.store.reconcile(
            "doctor:data-quality:" + document.id,
            dataQuality.findings,
            {
              verified: dataQuality.complete,
              at,
              resolution: document.dataQuality?.length
                ? {
                    cause: `Полный успешный read-only цикл не обнаружил активной ошибки в цепочке коэффициента. Пустой ${document.dataQuality[0].production.outputGuardColumn || "защитный признак"} означает, что ${document.dataQuality[0].production.errorColumns.join(", ")} в этой строке неприменимы; источник проверяется по вычисленному значению.`,
                    evidence: {
                      kind: "google_sheets_full_grid_read_only",
                      ruleId: document.dataQuality[0].id,
                      sourceSheet: document.dataQuality[0].source.sheet,
                      sourceField: document.dataQuality[0].source.fieldLabel,
                      sourceFieldColumn:
                        document.dataQuality[0].source.fieldColumn,
                      checkedAt: at,
                      complete: dataQuality.complete,
                    },
                  }
                : null,
            },
          );
          const groupedCells = new Map();
          for (const finding of dataQuality.findings)
            for (const cell of finding.errorCells || []) {
              const cells = groupedCells.get(cell.gid) || new Set();
              cells.add(cell.cell);
              groupedCells.set(cell.gid, cells);
            }
          for (const [gid, cells] of groupedCells)
            this.store.reconcile(`doctor:formula:${document.id}:${gid}`, [], {
              verified: true,
              at,
              onlyCells: cells,
              onlyTypes: new Set(["calculation_error"]),
            });
        }
        for (const metric of readStats.sheetMetrics) {
          const sheet = spreadsheet.sheets.find(
            (s) => s.properties.sheetId === metric.gid,
          );
          metric.readAt = sheet?.readAt || at;
          metric.issueCount =
            [...result.findings, ...formulaFindings].filter(
              (f) => f.sheet === metric.name,
            ).length +
            dataQuality.findings.filter(
              (finding) =>
                finding.sheet === metric.name ||
                finding.affectedCells?.some(
                  (cell) => cell.sheet === metric.name,
                ),
            ).length;
        }
        const diagnosticMs = Math.round(performance.now() - diagnosticStart);
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
            ...readStats,
            durationMs: Math.round(performance.now() - started),
            diagnosticMs,
            api: metricDelta(metricsBefore, this.reader.telemetry?.()),
            readVerifiedAt: at,
            oauthVerifiedAt:
              document.adapter === "google"
                ? this.reader.authorizedAt || null
                : null,
            errorCode: null,
            httpStatus: null,
            issueCount:
              result.findings.length +
              formulaFindings.length +
              dataQuality.findings.length,
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
        if (document.adapter === "google") {
          const policyFindings =
            this.governance.reconcile(document, result.complete, at) || [];
          if (policyFindings.length) {
            const current = this.store
              .overview()
              .checks.find((c) => c.id === document.id);
            this.store.check(
              document.id,
              {
                ...current,
                issueCount: current.issueCount + policyFindings.length,
                sheetMetrics: current.sheetMetrics.map((m) => ({
                  ...m,
                  issueCount:
                    m.issueCount +
                    policyFindings.filter((f) => f.sheet === m.name).length,
                })),
              },
              at,
            );
          }
        }
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
            (result.findings.length +
              formulaFindings.length +
              dataQuality.findings.length),
          null,
          at,
        );
      } catch (error) {
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
              observed: accessMessage(error),
              expected: "Успешное авторизованное чтение",
              cause: accessMessage(error),
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
            durationMs: Math.round(performance.now() - started),
            api: metricDelta(metricsBefore, this.reader.telemetry?.()),
            httpStatus: Number.isInteger(error.status) ? error.status : null,
            errorCode:
              typeof error.code === "string" ? error.code : "read_failed",
            readVerifiedAt: previous?.readVerifiedAt || null,
            formulasRead: null,
            message: accessMessage(error) + "; KPI не обнулён",
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
