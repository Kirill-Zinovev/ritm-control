import { randomUUID } from "node:crypto";
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
import { doctorColumnIndex } from "./doctorRegistry.js";

function columnLetters(index) {
  let column = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    column = String.fromCharCode(65 + ((n - 1) % 26)) + column;
  return column;
}

async function readFastDataQualityRanges(reader, document, signal, onRequest) {
  onRequest();
  const metadata = await reader.metadata(document.documentId, signal, 100);
  if (metadata.spreadsheetId !== document.documentId)
    throw new Error("spreadsheet_mismatch");
  const metadataById = new Map(
      (metadata.sheets || []).map((sheet) => [sheet.properties.sheetId, sheet]),
    ),
    requested = new Map();
  const addRanges = (rule, role, columns) => {
    const gid = rule[role].gid,
      schema = document.sheets.find((sheet) => sheet.gid === gid),
      target = metadataById.get(gid);
    if (!schema || !target || target.properties.title !== schema.name)
      throw new Error("data_quality_sheet_mismatch");
    if (role === "source" && schema.name !== rule.source.sheet)
      throw new Error("data_quality_source_mismatch");
    const rowLimit = Math.min(
        rule[role].maxRows || schema.maxRows,
        target.properties.gridProperties?.rowCount || 0,
      ),
      gridColumns = target.properties.gridProperties?.columnCount || 0;
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 1)
      throw new Error("data_quality_grid_unavailable");
    let sheetRequest = requested.get(gid);
    if (!sheetRequest) {
      sheetRequest = { schema, target, columns: new Map() };
      requested.set(gid, sheetRequest);
    }
    for (const name of columns.filter(Boolean)) {
      const index = doctorColumnIndex(name);
      if (!Number.isSafeInteger(index) || index < 0 || index >= gridColumns)
        throw new Error("data_quality_column_unavailable");
      sheetRequest.columns.set(
        index,
        Math.max(sheetRequest.columns.get(index) || 0, rowLimit),
      );
    }
  };
  for (const rule of document.dataQuality || []) {
    addRanges(rule, "production", [
      rule.production.articleColumn,
      ...(rule.production.operationColumns || []),
      ...(rule.production.errorColumns || []),
      rule.production.outputGuardColumn,
      // Deployed external registries predate dependencyColumns. Their existing
      // product-kind rule still needs B/C to trace the AP coefficient chain.
      ...(rule.production.dependencyColumns || ["B", "C"]),
    ]);
    addRanges(rule, "source", [
      rule.source.keyColumn,
      rule.source.fieldColumn,
      rule.source.relatedFieldColumn,
    ]);
  }

  const sheets = [];
  let readRequests = 1;
  for (const [gid, item] of requested) {
    const ranges = [...item.columns.entries()].map(([index, rows]) => ({
        index,
        rows,
        range:
          "'" +
          item.schema.name.replaceAll("'", "''") +
          "'!" +
          columnLetters(index) +
          "1:" +
          columnLetters(index) +
          rows,
      })),
      data = [];
    for (let offset = 0; offset < ranges.length; offset += 30) {
      const batch = ranges.slice(offset, offset + 30);
      onRequest();
      readRequests++;
      const payload = await reader.grid(
        document.documentId,
        batch.map((range) => range.range),
        signal,
        100,
      );
      if (payload.spreadsheetId !== document.documentId)
        throw new Error("spreadsheet_mismatch");
      const responseSheet = (payload.sheets || []).find(
        (sheet) => sheet.properties.sheetId === gid,
      );
      if (
        !responseSheet ||
        responseSheet.properties.title !== item.schema.name ||
        !Array.isArray(responseSheet.data) ||
        responseSheet.data.length !== batch.length
      )
        throw new Error("incomplete_data_quality_ranges");
      for (let i = 0; i < batch.length; i++) {
        const block = responseSheet.data[i],
          expected = batch[i];
        if (
          (block.startRow ?? 0) !== 0 ||
          (block.startColumn ?? 0) !== expected.index
        )
          throw new Error("data_quality_range_mismatch");
        data.push(block);
      }
    }
    sheets.push({ ...item.target, data });
  }
  return { spreadsheet: { ...metadata, sheets }, metadata, readRequests };
}

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
    this.runTimeoutMs = Number(config.doctorRunTimeoutMs) || 15 * 60_000;
    this.runHeartbeatMs = Number(config.doctorRunHeartbeatMs) || 10_000;
    this.runs = new Map();
    this.lastRun = this.store.meta("doctorRunState") || null;
    this.activeRun = null;
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
    // Queue this document-scoped run behind any active scan. The scan queue
    // serializes Google reads, while the run metadata lets callers subscribe
    // to this exact scope instead of the cycle that happened to be active.
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
    this.runs ||= new Map();
    const scope = documentId || "all";
    const existing = [...this.runs.values()].find((candidate) =>
      candidate.mode === "deep" && candidate.scope === scope &&
      ["queued", "running", "timing_out"].includes(candidate.status),
    );
    if (existing?.promise) return existing.promise;
    return this.startTrackedRun(
      "deep",
      signal,
      (runSignal, run) => this.inspect(runSignal, documentId, run),
      { scope },
    );
  }
  runFast(signal) {
    this.runs ||= new Map();
    const existing = [...this.runs.values()].find((candidate) =>
      candidate.mode === "fast" && candidate.scope === "fast" &&
      ["queued", "running", "timing_out"].includes(candidate.status),
    );
    if (existing?.promise) return existing.promise;
    return this.startTrackedRun(
      "fast",
      signal,
      (runSignal, run) => this.inspectFast(runSignal, run),
      { scope: "fast" },
    );
  }
  persistRun(run) {
    const { promise, listeners, ...serializable } = run;
    this.lastRun = serializable;
    if (!this.store?.meta) return;
    if (run.status === "queued" && this.activeRun && this.activeRun !== run)
      this.store.meta("doctorQueuedRunState", serializable);
    else {
      this.store.meta("doctorRunState", serializable);
      if (run.status === "running") this.store.meta("doctorQueuedRunState", null);
    }
  }
  touchRun(run, progress = {}) {
    if (!run) return;
    run.lastActivityAt = this.now().toISOString();
    run.progress = { ...run.progress, ...progress };
    this.persistRun(run);
  }
  startTrackedRun(mode, parentSignal, task, { scope = mode } = {}) {
    this.now ||= () => new Date();
    this.runs ||= new Map();
    this.runTimeoutMs ||= 15 * 60_000;
    this.runHeartbeatMs ||= 10_000;
    const run = {
      id: randomUUID(),
      mode,
      scope,
      status: "queued",
      queuedAt: this.now().toISOString(),
      startedAt: null,
      lastActivityAt: this.now().toISOString(),
      finishedAt: null,
      progress: { phase: "В очереди" },
      error: null,
      listeners: new Set(),
      promise: null,
    };
    this.runs.set(run.id, run);
    this.touchRun(run);
    const queued = this.enqueueScan(async () => {
      this.activeRun = run;
      run.status = "running";
      run.startedAt = this.now().toISOString();
      this.touchRun(run, { phase: "Подготовка данных" });
      const timeoutController = new AbortController();
      let timedOut = false;
      const combinedSignal = parentSignal
        ? AbortSignal.any([parentSignal, timeoutController.signal])
        : timeoutController.signal;
      const timeout = setTimeout(() => {
        timedOut = true;
        run.status = "timing_out";
        run.error = `Превышен лимит проверки ${Math.round(this.runTimeoutMs / 60_000)} мин; ожидается остановка текущего чтения.`;
        timeoutController.abort(new Error("doctor_run_timeout"));
        this.touchRun(run, { phase: "Остановка по тайм-ауту" });
      }, this.runTimeoutMs);
      const heartbeat = setInterval(() => this.touchRun(run), this.runHeartbeatMs);
      try {
        const result = await task(combinedSignal, run);
        if (timedOut) {
          run.status = "timed_out";
          run.error ||= "Проверка превысила допустимое время.";
        } else if (parentSignal?.aborted) {
          run.status = "interrupted";
          run.error = "Проверка остановлена вместе с агентом.";
        } else {
          const documents = result?.documents || [];
          run.status = result?.status === "partial" || documents.some((document) =>
            ["unavailable", "not_configured", "degraded"].includes(document.check?.status),
          ) ? "completed_with_warnings" : "completed";
          run.error = null;
        }
        run.resultSummary = this.summarizeRunResult(result);
        return result;
      } catch (error) {
        run.status = timedOut ? "timed_out" : parentSignal?.aborted ? "interrupted" : "failed";
        run.error = timedOut
          ? "Проверка превысила допустимое время; текущая операция завершилась по тайм-ауту."
          : parentSignal?.aborted
            ? "Проверка остановлена вместе с агентом."
            : String(error?.code || error?.message || "Ошибка проверки").slice(0, 240);
        throw error;
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        run.finishedAt = this.now().toISOString();
        this.touchRun(run, { phase: "Завершена" });
        this.activeRun = null;
        for (const listener of run.listeners) {
          try { listener(run); } catch {}
        }
        run.listeners.clear();
      }
    });
    let wrapped;
    wrapped = queued.finally(() => {
      if (mode === "fast" && this.fastCurrent === wrapped) this.fastCurrent = null;
      if (mode === "deep" && this.current === wrapped) this.current = null;
      if (this.activeRun === run) this.activeRun = null;
    });
    run.promise = wrapped;
    if (mode === "fast") this.fastCurrent = wrapped;
    else this.current = wrapped;
    for (const [id, candidate] of this.runs)
      if (candidate.status !== "queued" && candidate.status !== "running" && candidate.status !== "timing_out" && id !== run.id)
        this.runs.delete(id);
    return wrapped;
  }
  summarizeRunResult(result) {
    const state = result?.documents
      ? result
      : this.store && typeof this.state === "function"
        ? this.state()
        : { documents: [] };
    const docs = state.documents || [];
    const sheets = docs.flatMap((doc) => doc.sheets || []);
    const unavailable = sheets.filter((item) => ["unavailable", "not_configured"].includes(item.status)).length;
    const issues = docs.reduce((sum, doc) => sum + Number(doc.check?.issueCount || 0), 0);
    return `Проверено документов: ${docs.length}; листов: ${sheets.length}; недоступных листов: ${unavailable}; проблем по результатам: ${issues}.`;
  }
  getRunStatus(mode = null, scope = null) {
    const pending = [...this.runs.values()].filter((item) =>
      ["queued", "running", "timing_out"].includes(item.status),
    );
    const compatibleScope = (item) =>
      !scope || item.scope === scope || (scope !== "all" && item.scope === "all");
    const run = mode
      ? pending.find((item) => item.mode === mode && item.status !== "queued" && compatibleScope(item)) ||
        pending.find((item) => item.mode === mode && compatibleScope(item)) ||
        (this.lastRun?.mode === mode && compatibleScope(this.lastRun) ? this.lastRun : null)
      : this.activeRun || pending.find((item) => item.status !== "queued") || pending[0] || this.lastRun;
    if (!run) return null;
    const started = run.startedAt ? Date.parse(run.startedAt) : null;
    const ended = run.finishedAt ? Date.parse(run.finishedAt) : this.now().getTime();
    const lastActivity = Date.parse(run.lastActivityAt || "");
    return {
      id: run.id,
      mode: run.mode,
      scope: run.scope || run.mode,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      lastActivityAt: run.lastActivityAt,
      finishedAt: run.finishedAt,
      elapsedMs: started ? Math.max(0, ended - started) : 0,
      heartbeatAgeMs: Number.isFinite(lastActivity)
        ? Math.max(0, this.now().getTime() - lastActivity)
        : null,
      heartbeatStale: ["queued", "running", "timing_out"].includes(run.status) &&
        Number.isFinite(lastActivity) &&
        this.now().getTime() - lastActivity > this.runHeartbeatMs * 3,
      progress: run.progress || {},
      error: run.error || null,
      resultSummary: run.resultSummary || null,
    };
  }
  subscribeRun(runId, listener) {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.finishedAt) {
      queueMicrotask(() => listener(run));
      return true;
    }
    run.listeners.add(listener);
    return true;
  }
  recoverInterruptedRun() {
    const candidates = [
      this.store.meta("doctorRunState"),
      this.store.meta("doctorQueuedRunState"),
    ].filter((run) => run && ["queued", "running", "timing_out"].includes(run.status));
    const recovered = candidates.map((previous) => ({
      ...previous,
      status: "interrupted",
      finishedAt: this.now().toISOString(),
      lastActivityAt: this.now().toISOString(),
      error: "Агент перезапустился до завершения проверки; результат не подтверждён.",
      progress: { ...(previous.progress || {}), phase: "Прервана перезапуском" },
    }));
    if (!recovered.length) return [];
    this.lastRun = recovered.sort((a, b) => String(b.startedAt || b.queuedAt).localeCompare(String(a.startedAt || a.queuedAt)))[0];
    this.store.meta("doctorRunState", this.lastRun);
    this.store.meta("doctorQueuedRunState", null);
    this.store.meta("doctorRecoveredRuns", recovered);
    return recovered;
  }
  async inspectFast(signal, run = null) {
    this.touchRun(run, { phase: "Проверка обязательных данных" });
    const started = performance.now(),
      at = this.now(),
      before = this.reader.telemetry?.() || {},
      qualityScan = await this.runFastDataQuality(signal, at, run),
      { metadataByDocument, ...dataQuality } = qualityScan,
      formulaReport = await this.formulas.fastCheck(this.reader, signal, at, {
        metadataByDocument,
      });
    this.touchRun(run, { phase: "Сравнение утверждённых формул" });
    if (!formulaReport || typeof formulaReport !== "object")
      return formulaReport;
    const after = this.reader.telemetry?.() || {},
      apiStatuses = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(before.statuses || {}),
            ...Object.keys(after.statuses || {}),
          ]),
        ]
          .map((status) => [
            status,
            Math.max(
              0,
              (after.statuses?.[status] || 0) -
                (before.statuses?.[status] || 0),
            ),
          ])
          .filter(([, count]) => count > 0),
      ),
      durationMs = Math.round(performance.now() - started),
      readRequests = formulaReport.readRequests + dataQuality.readRequests,
      dataAcquisitionMs =
        formulaReport.dataAcquisitionMs + dataQuality.dataAcquisitionMs,
      comparisonMs = formulaReport.comparisonMs + dataQuality.comparisonMs,
      report = {
        ...formulaReport,
        at: at.toISOString(),
        status:
          formulaReport.status === "ok" && dataQuality.status !== "partial"
            ? "ok"
            : "partial",
        durationMs,
        readRequests,
        apiReadRequests: Math.max(
          0,
          (after.readRequests || 0) - (before.readRequests || 0),
        ),
        oauthRequests: Math.max(
          0,
          (after.oauthRequests || 0) - (before.oauthRequests || 0),
        ),
        apiStatuses,
        retries: Math.max(0, (after.retries || 0) - (before.retries || 0)),
        responseBytes: Math.max(
          0,
          (after.responseBytes || 0) - (before.responseBytes || 0),
        ),
        dataAcquisitionMs,
        comparisonMs,
        otherProcessingMs: Math.max(
          0,
          durationMs - dataAcquisitionMs - comparisonMs,
        ),
        dataQuality,
      };
    this.store.snapshot("formula-fast-check", report, at.toISOString());
    return report;
  }
  async runFastDataQuality(signal, at, run = null) {
    const documents = (this.config?.doctorDocuments || []).filter(
        (document) =>
          document.enabled &&
          document.adapter === "google" &&
          document.dataQuality?.length,
      ),
      reports = [];
    let readRequests = 0,
      dataAcquisitionMs = 0,
      comparisonMs = 0;
    const metadataByDocument = new Map();
    for (const document of documents) {
      if (signal?.aborted) break;
      this.touchRun(run, {
        phase: "Проверка быстрых зависимостей",
        document: document.name,
      });
      const started = performance.now(),
        acquisitionStarted = performance.now(),
        metricsBefore = this.reader.telemetry?.() || {};
      try {
        const {
          spreadsheet,
          metadata,
          readRequests: documentRequests,
        } = await readFastDataQualityRanges(
          this.reader,
          document,
          signal,
          () => {
            readRequests++;
          },
        );
        metadataByDocument.set(document.id, metadata);
        dataAcquisitionMs += performance.now() - acquisitionStarted;
        const previous =
            this.store.getSnapshot("doctor:source-values:" + document.id)
              ?.value || null,
          comparisonStarted = performance.now(),
          result = diagnoseDataQuality(document, spreadsheet, previous, at);
        comparisonMs += performance.now() - comparisonStarted;
        this.reconcileDataQuality(document, result, at, {
          readComplete: true,
          evidenceKind: "google_sheets_fast_dependency_ranges_read_only",
        });
        reports.push({
          sourceId: document.id,
          name: document.name,
          status: result.complete ? "ok" : "partial",
          complete: result.complete,
          findings: result.findings.length,
          readRequests: documentRequests,
          durationMs: Math.round(performance.now() - started),
          errorCode: null,
        });
      } catch (error) {
        dataAcquisitionMs += performance.now() - acquisitionStarted;
        const after = this.reader.telemetry?.() || {};
        reports.push({
          sourceId: document.id,
          name: document.name,
          status: "partial",
          complete: false,
          findings: null,
          readRequests: Math.max(
            0,
            (after.readRequests || 0) - (metricsBefore.readRequests || 0),
          ),
          durationMs: Math.round(performance.now() - started),
          errorCode:
            typeof error?.code === "string"
              ? error.code
              : error instanceof Error
                ? error.message.slice(0, 80)
                : "read_failed",
        });
      }
    }
    return {
      status:
        signal?.aborted || reports.some((report) => report.status === "partial")
          ? "partial"
          : documents.length
            ? "ok"
            : "not_applicable",
      readRequests,
      findings: reports.reduce(
        (total, report) => total + (report.findings || 0),
        0,
      ),
      dataAcquisitionMs: Math.round(dataAcquisitionMs),
      comparisonMs: Math.round(comparisonMs),
      durationMs: Math.round(dataAcquisitionMs + comparisonMs),
      documents: reports,
      metadataByDocument,
    };
  }
  reconcileDataQuality(
    document,
    dataQuality,
    at,
    {
      readComplete = false,
      evidenceKind = "google_sheets_full_grid_read_only",
    } = {},
  ) {
    const checkedAt = at instanceof Date ? at.toISOString() : at,
      rule = document.dataQuality?.[0];
    if (readComplete)
      this.store.snapshot(
        "doctor:source-values:" + document.id,
        dataQuality.snapshot,
        checkedAt,
      );
    const verified = readComplete && dataQuality.complete;
    this.store.reconcile(
      "doctor:data-quality:" + document.id,
      dataQuality.findings,
      {
        verified,
        at: checkedAt,
        resolution: verified
          ? {
              cause: rule
                ? `Успешная read-only проверка поля «${rule.source.fieldLabel}» и зависимых расчётов не обнаружила активную проблему. Пустой ${rule.production.outputGuardColumn || "признак операции"} означает, что ${rule.production.errorColumns.join(", ")} в этой строке неприменимы.`
                : "Успешная read-only проверка обязательного источника и зависимых расчётов не обнаружила активную проблему.",
              evidence: {
                kind: evidenceKind,
                ...(rule
                  ? {
                      ruleId: rule.id,
                      sourceSheet: rule.source.sheet,
                      sourceField: rule.source.fieldLabel,
                      sourceFieldColumn: rule.source.fieldColumn,
                    }
                  : {}),
                checkedAt,
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
    if (readComplete)
      for (const [gid, cells] of groupedCells)
        this.store.reconcile(`doctor:formula:${document.id}:${gid}`, [], {
          verified: true,
          at: checkedAt,
          onlyCells: cells,
          onlyTypes: new Set(["calculation_error"]),
        });
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
      checkRun: this.getRunStatus(),
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
  async inspect(signal, onlyDocumentId = null, run = null) {
    const documents = (this.config.doctorDocuments || []).filter(
      (d) => d.enabled && (!onlyDocumentId || d.id === onlyDocumentId),
    );
    let completedDocuments = 0;
    for (const document of documents) {
      if (signal?.aborted) return this.state();
      this.touchRun(run, {
        phase: "Чтение и сверка документа",
        document: document.name,
        completedDocuments,
        totalDocuments: documents.length,
      });
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
            this.touchRun(run, {
              phase: "Чтение листа",
              document: document.name,
              sheet: schema.name,
              completedDocuments,
              totalDocuments: documents.length,
            });
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
        if (result.complete)
          this.reconcileDataQuality(document, dataQuality, at, {
            readComplete: true,
          });
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
      completedDocuments++;
      this.touchRun(run, {
        phase: "Документ проверен",
        document: document.name,
        completedDocuments,
        totalDocuments: documents.length,
      });
    }
    this.store.meta("doctorLastCheck", this.now().toISOString());
    return this.state();
  }
}
