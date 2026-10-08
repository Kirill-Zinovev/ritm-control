import { setTimeout as delay } from "node:timers/promises";
import { cellLink } from "./registry.js";
import { loadSource, validateApi, todayMoscow } from "./adapters.js";
export function issueFinding(source, issue) {
  const sheet = issue.source || source.sheets[0].name;
  const cell =
    issue.cell || (issue.row ? "A" + issue.row + ":Z" + issue.row : null);
  return {
    type: issue.code || "invalid_record",
    severity: "high",
    sourceId: source.id,
    department: source.department,
    sourceName: source.name,
    sheet,
    row: issue.row || null,
    cell,
    title: issue.message || "Нарушено правило исходных данных",
    found: String(
      issue.found ?? "Диагностика существующего обработчика: " + issue.message,
    ).slice(0, 1000),
    expected:
      issue.expected || "Валидная запись по утверждённым правилам источника",
    cause:
      "Подтверждено нарушение правила проверки. Причина изменения ячейки не установлена.",
    impact:
      source.adapter === "printing"
        ? "Невалидные строки не входят в KPI печати; итог может быть неполным."
        : "Невалидные строки не входят в расчёт; снижение коэффициента нельзя интерпретировать как снижение работы.",
    action:
      "Проверить исходную запись и её историю изменений. Исправления агентом отключены.",
    sourceUrl: cellLink(source, sheet, cell),
    verification: "rule_confirmed",
    layer: "source",
  };
}
function availabilityFinding(id, name, layer, error, source) {
  return {
    type: "unavailable",
    severity: "critical",
    sourceId: source?.id || id,
    department: source?.department || "Система",
    sourceName: source?.name || name,
    sheet: null,
    row: null,
    cell: null,
    title: name + " недоступен",
    found: error.status
      ? "HTTP " + error.status
      : "Тайм-аут или ошибка соединения",
    expected: "Успешный ответ в пределах заданного времени",
    cause: "Запрос не завершился успешно. Причина сбоя не подтверждена.",
    impact:
      "Новый снимок не получен. Предыдущие показатели могут быть устаревшими; отсутствие ответа не равно нулевому выпуску.",
    action: "Проверить доступность источника, сеть и журналы RITM.",
    sourceUrl: source ? cellLink(source, source.sheets[0].name) : name,
    verification: "request_failed",
    layer,
  };
}
export function freshnessFinding(source, payload, now) {
  const rule = source.freshness;
  if (!rule) return { configured: false, active: false, findings: [] };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((x) => x.type === "weekday").value,
  );
  const hour = Number(parts.find((x) => x.type === "hour").value);
  if (
    !rule.activeWeekdays.includes(weekday) ||
    hour < rule.startHour ||
    hour >= rule.endHour
  )
    return { configured: true, active: false, findings: [] };
  const stamp = Date.parse(payload.sourceUpdatedAt);
  if (!Number.isFinite(stamp))
    return {
      configured: true,
      active: true,
      findings: [
        issueFinding(source, {
          code: "freshness_unknown",
          source: source.sheets[0].name,
          message: "Неизвестно время обновления производственных данных",
          found: "Время отсутствует",
          expected: "Исходное время обновления для контроля свежести",
        }),
      ],
    };
  if (now.getTime() - stamp <= rule.maximumAgeMinutes * 60000)
    return { configured: true, active: true, findings: [] };
  return {
    configured: true,
    active: true,
    findings: [
      {
        ...issueFinding(source, {
          code: "stale_source",
          source: source.sheets[0].name,
          message: "Производственные данные давно не обновлялись",
          found: payload.sourceUpdatedAt,
          expected:
            "Не старше " +
            rule.maximumAgeMinutes +
            " минут в утверждённое рабочее окно",
        }),
        verification: "freshness_rule",
        cause:
          "Превышен согласованный срок обновления. Отсутствие новых работ не доказывает простой сотрудников.",
      },
    ],
  };
}
export function retryingFetch(fetcher, config, signal) {
  return async (url, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const signals = [
          AbortSignal.timeout(config.timeoutMs),
          options.signal,
          signal,
        ].filter(Boolean);
        const response = await fetcher(url, {
          ...options,
          signal: AbortSignal.any(signals),
          redirect: "follow",
        });
        if (response.ok) return response;
        const error = Object.assign(new Error("HTTP request failed"), {
          status: response.status,
        });
        if (![408, 429].includes(response.status) && response.status < 500)
          throw Object.assign(error, { noRetry: true });
        throw error;
      } catch (error) {
        if (signal?.aborted || error.noRetry || attempt >= config.retries)
          throw error;
        await delay(Math.min(1000 * 2 ** attempt, 8000), undefined, { signal });
      }
    }
  };
}
function factCount(source, value) {
  return source.adapter === "assembly"
    ? value.history.length
    : source.adapter === "printing"
      ? value.events.length
      : value.recordCount;
}
export class Monitor {
  constructor(
    store,
    config,
    { fetcher = fetch, loaders = {}, now = () => new Date() } = {},
  ) {
    this.store = store;
    this.config = config;
    this.fetcher = fetcher;
    this.loaders = loaders;
    this.now = now;
    this.busy = false;
  }
  async source(source, signal) {
    const at = this.now().toISOString(),
      start = performance.now();
    const fetcher = retryingFetch(this.fetcher, this.config, signal);
    try {
      const value = await (this.loaders[source.adapter] || loadSource)(
        source,
        fetcher,
        this.now(),
      );
      const previous = this.store.getSnapshot(source.id);
      const unexpectedEmpty =
        previous &&
        factCount(source, previous.value) > 0 &&
        factCount(source, value) === 0 &&
        !(value.issues || []).length;
      const findings = (value.issues || []).map((issue) =>
        issueFinding(source, issue),
      );
      if (unexpectedEmpty)
        findings.push(
          issueFinding(source, {
            code: "unexpected_empty",
            source: source.sheets[0].name,
            message: "Источник неожиданно вернул пустую историю",
            found: "0 записей",
            expected: "Проверить исчезновение ранее доступной истории",
          }),
        );
      this.store.reconcile(source.id + ":availability", [], { at });
      this.store.reconcile(source.id + ":data", findings, { at });
      const freshness = freshnessFinding(source, value, this.now());
      this.store.reconcile(source.id + ":freshness", freshness.findings, {
        verified: freshness.active,
        at,
      });
      // A quarantined partial result is evidence, not a complete KPI snapshot.
      if (!findings.length) this.store.snapshot(source.id, value, at);
      this.store.meta(source.id + ":failures", 0);
      this.store.check(
        source.id,
        {
          kind: "source",
          name: source.name,
          sourceId: source.id,
          department: source.department,
          status: findings.length
            ? "partial"
            : freshness.findings.length
              ? "stale"
              : "ok",
          durationMs: Math.round(performance.now() - start),
          records: factCount(source, value),
          issueCount: findings.length,
          sourceUpdatedAt: value.sourceUpdatedAt || null,
          snapshotAt: !findings.length ? at : previous?.at || null,
          freshness: freshness.configured
            ? freshness.active
              ? "checked"
              : "outside_window"
            : "not_configured",
        },
        at,
      );
      return { ok: true, partial: findings.length > 0, value };
    } catch (error) {
      if (signal?.aborted) return { ok: false, aborted: true };
      const issue = error.issue;
      const isSchema =
        issue || /schema|UID column|Duplicate order/.test(error.message);
      const finding = isSchema
        ? issueFinding(
            source,
            issue || {
              code: /Duplicate/.test(error.message)
                ? "duplicate_uid"
                : "schema_changed",
              source: source.sheets[0].name,
              message: "Структура или идентификаторы источника нарушены",
              found: error.message,
              expected: "Утверждённая структура листов и уникальные UID",
            },
          )
        : availabilityFinding(source.id, source.name, "source", error, source);
      this.store.reconcile(source.id + ":availability", [finding], { at });
      // Do not resolve row problems when a source could not be inspected.
      const failures = (this.store.meta(source.id + ":failures") || 0) + 1;
      this.store.meta(source.id + ":failures", failures);
      this.store.check(
        source.id,
        {
          kind: "source",
          name: source.name,
          sourceId: source.id,
          department: source.department,
          status: "error",
          durationMs: Math.round(performance.now() - start),
          issueCount: 1,
          snapshotAt: this.store.getSnapshot(source.id)?.at || null,
          freshness: "unknown",
        },
        at,
      );
      if (failures >= 3)
        this.store.recommend(
          source.id + ":connection",
          {
            title: "Проверить устойчивость подключения " + source.name,
            priority: "high",
            problem: "Источник не удалось проверить несколько раз подряд.",
            evidence: failures + " последовательных неуспешных проверок.",
            solution:
              "Проверить сетевые ограничения, доступ к таблице и ошибки сервера; затем повторить контроль.",
            benefit:
              "Восстановить актуальные данные. Количественная польза пока не измерена.",
            risks:
              "Причина пока неизвестна; изменение прав доступа требует решения владельца.",
            verification:
              "Три последовательные успешные проверки и подтверждённое время снимка.",
          },
          at,
        );
      return { ok: false };
    }
  }
  async api(kind, sources, signal) {
    const id = "api:" + kind,
      at = this.now().toISOString();
    if (!this.config.apiBase) {
      this.store.check(
        id,
        { kind: "api", name: "/api/" + kind, status: "not_configured" },
        at,
      );
      return;
    }
    const path =
      kind === "assembly"
        ? "/api/assembly?date=" + todayMoscow(this.now()) + "&period=day"
        : "/api/printing";
    const url = this.config.apiBase + path,
      start = performance.now();
    let status;
    try {
      const response = await retryingFetch(
        this.fetcher,
        this.config,
        signal,
      )(url);
      status = response.status;
      const text = await response.text();
      if (text.length > 4000000) throw new Error("API schema too large");
      const payload = validateApi(JSON.parse(text), kind);
      const elapsed = Math.round(performance.now() - start);
      const findings = [];
      if (
        this.now().getTime() - Date.parse(payload.updatedAt) >
        this.config.snapshotMaxAgeMs
      )
        findings.push({
          ...availabilityFinding(id, url, "server", {}, null),
          type: "stale_api",
          severity: "high",
          title: "API вернул устаревший снимок",
          found: payload.updatedAt,
          expected:
            "Снимок не старше " +
            this.config.snapshotMaxAgeMs / 1000 +
            " секунд",
          verification: "timestamp_confirmed",
          cause:
            "В ответе API указан просроченный снимок; причина кеширования не подтверждена.",
        });
      const source = this.config.sources.find((s) => s.adapter === kind);
      const sourceValue = sources.get(source?.id)?.value;
      if (
        sourceValue &&
        (kind === "assembly"
          ? sourceValue.history.length > 0 && payload.history.length === 0
          : sourceValue.events.length > 0 && payload.events.length === 0)
      ) {
        findings.push({
          ...availabilityFinding(id, url, "server", {}, null),
          type: "unexpected_empty_api",
          severity: "high",
          title: "API неожиданно вернул пустую историю",
          found: "0 записей в API при непустом прямом чтении источника",
          expected: "Сопоставимая полная история источника",
          cause:
            "Источник при прямом чтении содержит записи. Расхождение с API подтверждено; причина обработки требует анализа.",
          verification: "source_api_mismatch",
        });
      }
      this.store.reconcile(id, findings, { at });
      this.store.check(
        id,
        {
          kind: "api",
          name: path.split("?")[0],
          status: findings.length ? "stale" : "ok",
          durationMs: elapsed,
          httpStatus: status,
          updatedAt: payload.updatedAt,
        },
        at,
      );
      if (elapsed > this.config.slowApiMs)
        this.store.recommend(
          id + ":latency",
          {
            title: "Исследовать время ответа " + path.split("?")[0],
            priority: "medium",
            problem: "Запрос превысил настроенный порог времени ответа.",
            evidence:
              elapsed +
              " мс в последней проверке; порог " +
              this.config.slowApiMs +
              " мс. Время включает сеть и повторные попытки.",
            solution:
              "Измерить отдельные запросы к Sheets. Оценить объединение чтений или безопасный кеш с явным возрастом снимка.",
            benefit:
              "Возможное уменьшение задержки; ускорение ещё не измерено.",
            risks:
              "Кеш может скрывать обновления или ошибки. KPI и источник истины должны сохраниться.",
            verification:
              "Сравнить p50/p95 до и после при одинаковой нагрузке и проверить обновление данных.",
          },
          at,
        );
    } catch (error) {
      if (signal?.aborted) return;
      const source = this.config.sources.find((s) => s.adapter === kind);
      const sourceResult = sources.get(source?.id);
      const schema = status === 200;
      const f = availabilityFinding(
        id,
        url,
        schema
          ? "server"
          : sourceResult?.ok === false
            ? "source_or_network"
            : "server_or_network",
        error,
        null,
      );
      if (schema) {
        f.type = "api_schema";
        f.title = "Ответ API не соответствует контракту";
        f.found = "Успешный HTTP, но некорректные поля или JSON";
      }
      f.cause = sourceResult?.ok
        ? "Прямое чтение источника прошло успешно, а проверка API не прошла. Ошибка серверной обработки или сетевого пути — гипотеза."
        : "Неуспешна проверка API; причина требует отдельной диагностики источника и сети.";
      this.store.reconcile(id, [f], { at });
      this.store.check(
        id,
        {
          kind: "api",
          name: "/api/" + kind,
          status: "error",
          durationMs: Math.round(performance.now() - start),
          httpStatus: status || error.status || null,
          layer: f.layer,
        },
        at,
      );
    }
  }
  async app(signal) {
    const id = "app",
      at = this.now().toISOString();
    if (!this.config.apiBase) {
      this.store.check(
        id,
        { kind: "app", name: "RITM Control", status: "not_configured" },
        at,
      );
      return;
    }
    const start = performance.now();
    try {
      const response = await retryingFetch(
        this.fetcher,
        this.config,
        signal,
      )(this.config.apiBase + "/");
      const text = await response.text();
      if (!text.includes('<div id="root"') && !text.includes("<div id='root'"))
        throw new Error("App shell missing");
      this.store.reconcile(id, [], { at });
      this.store.check(
        id,
        {
          kind: "app",
          name: "RITM Control",
          status: "ok",
          durationMs: Math.round(performance.now() - start),
          scope: "HTML only; frontend runtime not inspected",
        },
        at,
      );
    } catch (error) {
      if (signal?.aborted) return;
      this.store.reconcile(
        id,
        [
          availabilityFinding(
            id,
            this.config.apiBase,
            "frontend_delivery",
            error,
            null,
          ),
        ],
        { at },
      );
      this.store.check(
        id,
        {
          kind: "app",
          name: "RITM Control",
          status: "error",
          durationMs: Math.round(performance.now() - start),
        },
        at,
      );
    }
  }
  async run(signal) {
    if (this.busy) return false;
    this.busy = true;
    try {
      const enabled = this.config.sources.filter((s) => s.enabled);
      const results = await Promise.all(
        enabled.map(async (source) => [
          source.id,
          await this.source(source, signal),
        ]),
      );
      await Promise.all([
        this.api("assembly", new Map(results), signal),
        this.api("printing", new Map(results), signal),
        this.app(signal),
      ]);
      if (!signal?.aborted) {
        const at = this.now().toISOString();
        this.store.meta("lastCheck", at);
        this.store.log(
          "check_completed",
          "Проверка завершена: " +
            enabled.length +
            " источников. Производственные таблицы не изменялись.",
          null,
          at,
        );
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}
