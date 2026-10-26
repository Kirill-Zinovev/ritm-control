import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";

const HELP =
  "Спросите обычным языком: «Как дела на производстве сегодня?», «Кто сколько напечатал?», «Что по порезке у Лукмана?», «Сколько осталось печатать?», «Какие ошибки есть?», «Проверь таблицы». Команды: /status, /problems, /checkstatus. Нажатие «Исправить» запускает только это подтверждённое исправление после повторной проверки RITM.";

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const clean = (value, max = 120) =>
  typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "";
const scalar = (value, fallback = "не указано") => {
  if (typeof value === "string" || typeof value === "number")
    return clean(String(value)) || fallback;
  // Source Recovery returns Google Sheets GridData cells, while other callers
  // may return the inner ExtendedValue directly. Prefer the calculated value.
  if (value?.effectiveValue !== undefined) return scalar(value.effectiveValue, fallback);
  if (value?.userEnteredValue !== undefined) return scalar(value.userEnteredValue, fallback);
  if (typeof value?.formattedValue === "string") return clean(value.formattedValue) || fallback;
  if (value?.stringValue !== undefined) return clean(value.stringValue) || fallback;
  if (value?.numberValue !== undefined) return String(value.numberValue);
  if (value?.formulaValue !== undefined) return clean(value.formulaValue, 1600) || fallback;
  if (value?.errorValue) return `ошибка ${clean(value.errorValue.type || value.errorValue.message, 60) || "вычисления"}`;
  return fallback;
};
const callbackData = (token) => "r:" + token;

export class TelegramAssistant {
  constructor({ assistant, store, fetcher = fetch, now = () => Date.now() }) {
    this.assistant = assistant;
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
    this.token = "";
    this.controller = null;
    this.loop = null;
    this.offset = Number(store.meta("telegramUpdateOffset") || 0);
    this.running = false;
    this.connected = false;
    this.botName = null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_assistant_updates (
      update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_repair_actions (
      token_hash TEXT PRIMARY KEY, incident_id TEXT NOT NULL, generation INTEGER NOT NULL,
      candidate_version TEXT NOT NULL, action TEXT NOT NULL, stage TEXT NOT NULL,
      user_id TEXT NOT NULL, chat_id TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, proposal_id TEXT
    );`);
    const actionColumns = store.db
      .prepare("PRAGMA table_info(telegram_repair_actions)")
      .all()
      .map((column) => column.name);
    if (!actionColumns.includes("proposal_id"))
      store.db.exec("ALTER TABLE telegram_repair_actions ADD COLUMN proposal_id TEXT");
    assistant.attachTelegram(this);
  }
  async setToken(token) {
    const clean = String(token || "").trim();
    if (clean && !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(clean))
      throw new Error("Формат токена Telegram неверный.");
    if (clean === this.token) return;
    await this.stop();
    this.token = clean;
    this.assistant.config.telegram.enabled = !!clean;
    this.connected = false;
    this.store.meta("telegramAssistant", {
      connected: false,
      botName: this.botName,
      checkedAt: new Date(this.now()).toISOString(),
      lastError: null,
    });
    if (clean) {
      this.controller = new AbortController();
      this.running = true;
      this.loop = this.poll(this.controller.signal).finally(() => {
        this.running = false;
      });
    }
  }
  async stop() {
    if (!this.controller) return;
    this.controller.abort();
    await this.loop?.catch(() => {});
    this.controller = null;
    this.loop = null;
    this.running = false;
    this.connected = false;
    this.store.meta("telegramAssistant", {
      connected: false,
      botName: this.botName,
      checkedAt: new Date(this.now()).toISOString(),
      lastError: null,
    });
  }
  async api(method, payload, signal) {
    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.any([
          AbortSignal.timeout(35000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    const data = await response.json();
    if (!response.ok || !data.ok)
      throw Object.assign(
        new Error("Telegram API " + (data.error_code || response.status)),
        { retryAfter: data.parameters?.retry_after },
      );
    return data.result;
  }
  async send(chatId, text, replyMarkup = null) {
    if (!this.token || !chatId) return false;
    const payload = {
      chat_id: chatId,
      text: String(text).slice(0, 3900),
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await this.api("sendMessage", {
      ...payload,
    });
    return true;
  }
  candidateVersion(incident) {
    const candidate = incident?.recoveryCandidate;
    if (!candidate || candidate.status !== "candidate" || (typeof candidate.value?.stringValue !== "string" && typeof candidate.value?.formulaValue !== "string")) return "";
    return candidate.version || hash(JSON.stringify({
      cell: incident.cell,
      value: candidate.value,
      observedAt: candidate.observedAt,
      evidence: candidate.evidence,
    }));
  }
  actionVersion(incident, generation) {
    return hash(JSON.stringify({
      incidentId: incident?.id,
      generation,
      candidate: incident?.recoveryCandidate || null,
    }));
  }
  issueAction(incident, action, stage = "notice", proposalId = null) {
    const owner = this.store.db.prepare("SELECT user_id,chat_id FROM assistant_owner WHERE id=1").get();
    const row = this.store.db.prepare("SELECT generation FROM incidents WHERE id=? AND status='open'").get(incident.id);
    const version = row && this.actionVersion(incident, row.generation);
    if (!owner || !row || !version) return null;
    this.store.db.prepare("DELETE FROM telegram_repair_actions WHERE expires_at<? OR consumed_at IS NOT NULL").run(new Date(this.now() - 2 * 86400_000).toISOString());
    const token = randomBytes(24).toString("hex"), now = this.now();
    this.store.db.prepare(`INSERT INTO telegram_repair_actions
      (token_hash,incident_id,generation,candidate_version,action,stage,user_id,chat_id,created_at,expires_at,proposal_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      hash(token), incident.id, row.generation, version, action, stage,
      owner.user_id, owner.chat_id, new Date(now).toISOString(),
      new Date(now + 10 * 60_000).toISOString(),
      proposalId,
    );
    return token;
  }
  cellUrl(incident) {
    const doc = this.assistant.config.doctorDocuments?.find(
      (item) => item.id === incident.sourceId && item.adapter === "google",
    );
    const sheet = doc?.sheets?.find(
      (item) => item.gid === incident.gid && item.name === incident.sheet,
    );
    if (!doc?.documentId || !sheet || !/^[A-Z]{1,3}\d{1,7}$/.test(incident.cell || "")) return "";
    const range = `'${String(incident.sheet).replaceAll("'", "''")}'!${incident.cell}`;
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(doc.documentId)}/edit?gid=${sheet.gid}&range=${encodeURIComponent(range)}`;
  }
  formatIncident(incident) {
    const candidate = incident.recoveryCandidate;
    const article = scalar(incident.observed?.productKey || incident.article);
    const isFormula = candidate?.kind === "approved_formula";
    const proposed = candidate?.status === "candidate"
      ? isFormula ? "вернуть формулу из утверждённого эталона" : scalar(candidate.value)
      : "нет безопасного предложения";
    const source = candidate?.evidence || (candidate?.origin === "owner_proposal"
      ? "предложено владельцем, не эталон"
      : incident.repairAvailability?.reason
        ? incident.baselineVersion
          ? "версия эталона есть в инциденте, но предложение не подтверждено"
          : "не найден"
        : "не найден");
    const current = isFormula
      ? scalar(incident.observed?.entered, "значение не прочитано")
      : incident.sourceState === "missing" ? "пусто" : scalar(incident.found, "не подтверждено");
    return [
      "⚠️ RITM: требуется проверка",
      clean(incident.title, 160) || "Обнаружена проблема",
      `Артикул: ${article}`,
      `Ячейка: ${clean(incident.sheet, 100) || "лист"}!${clean(incident.cell, 20) || "адрес не указан"}`,
      `Сейчас: ${current}`,
      `Предлагается: ${proposed}`,
      `Источник эталона: ${clean(source, 180) || "не указан"}`,
      incident.repairAvailability?.status === "blocked" && !candidate
        ? `Почему нет исправления: ${clean(incident.repairAvailability.reason, 200)}`
        : "Нажатие «Исправить» разрешит только это изменение; RITM сначала перепроверит ячейку и эталон.",
    ].join("\n");
  }
  async sendIncident(incident) {
    const owner = this.store.db.prepare("SELECT user_id,chat_id FROM assistant_owner WHERE id=1").get();
    if (!owner || !this.token) return false;
    const candidateVersion = this.candidateVersion(incident);
    let replyMarkup;
    const sheetUrl = this.cellUrl(incident);
    if (candidateVersion) {
      const confirm = this.issueAction(incident, "approve", "notice");
      const reject = this.issueAction(incident, "reject", "notice");
      const details = this.issueAction(incident, "details", "notice");
      replyMarkup = { inline_keyboard: [
        [{ text: "Исправить", callback_data: callbackData(confirm) }, { text: "Отклонить", callback_data: callbackData(reject) }],
        [{ text: "Подробнее", callback_data: callbackData(details) }, ...(sheetUrl ? [{ text: "Открыть ячейку", url: sheetUrl }] : [])],
      ] };
    } else {
      const details = this.issueAction(incident, "details", "notice");
      replyMarkup = details ? { inline_keyboard: [[{ text: "Подробнее", callback_data: callbackData(details) }, ...(sheetUrl ? [{ text: "Открыть ячейку", url: sheetUrl }] : [])]] } : undefined;
    }
    await this.send(owner.chat_id, this.formatIncident(incident), replyMarkup);
    this.assistant.audit("telegram", owner.user_id, "incident_notification_sent", "incident", "ok");
    return true;
  }
  currentAction(token, action, stage, userId, chatId) {
    const record = this.store.db.prepare("SELECT * FROM telegram_repair_actions WHERE token_hash=?").get(hash(token));
    if (!record || record.action !== action || record.stage !== stage || record.user_id !== String(userId) || record.chat_id !== String(chatId) || record.consumed_at || Date.parse(record.expires_at) <= this.now()) return null;
    const owner = this.store.db.prepare("SELECT user_id,chat_id FROM assistant_owner WHERE id=1").get();
    if (!owner || owner.user_id !== record.user_id || owner.chat_id !== record.chat_id) return null;
    const incidentRow = this.store.db.prepare("SELECT * FROM incidents WHERE id=?").get(record.incident_id);
    const incident = incidentRow && this.store.incident(incidentRow);
    if (!incidentRow || incidentRow.status !== "open" || incidentRow.generation !== record.generation || !incident || ["ignored", "excepted"].includes(incident.status) || incident.monitorStatus !== "open") return null;
    if (this.actionVersion(incident, incidentRow.generation) !== record.candidate_version) return null;
    return { record, incident };
  }
  consumeAction(tokenHash, at) {
    return this.store.db.prepare("UPDATE telegram_repair_actions SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL").run(at, tokenHash).changes === 1;
  }
  async answerCallback(id, text = "") {
    if (!id) return;
    try { await this.api("answerCallbackQuery", { callback_query_id: id, text: clean(text, 180), show_alert: !!text }); } catch {}
  }
  async processCallback(update) {
    const query = update.callback_query;
    if (!query || !this.assistant.isOwner(update) || query.message?.chat?.type !== "private") {
      this.assistant.audit("telegram", query?.from?.id || "unknown", "telegram_repair_callback_rejected", null, "rejected");
      await this.answerCallback(query?.id, "Доступ запрещён.");
      return false;
    }
    const token = String(query.data || "").match(/^r:([a-f0-9]{48})$/)?.[1];
    if (!token) { await this.answerCallback(query.id, "Кнопка недействительна."); return false; }
    const tokenHash = hash(token), userId = String(query.from.id), chatId = String(query.message.chat.id);
    const peek = this.store.db.prepare("SELECT action,stage FROM telegram_repair_actions WHERE token_hash=?").get(tokenHash);
    if (!peek) { await this.answerCallback(query.id, "Кнопка устарела."); return false; }
    const valid = this.currentAction(token, peek.action, peek.stage, userId, chatId);
    if (!valid) {
      this.assistant.audit("telegram", userId, "telegram_repair_action_stale", peek.action, "rejected");
      await this.answerCallback(query.id, "Проблема или предложение изменились. Запись заблокирована.");
      return false;
    }
    const { record, incident } = valid;
    if (peek.action === "details") {
      if (!this.consumeAction(tokenHash, new Date(this.now()).toISOString())) return false;
      const detail = [
        "Подробнее о проблеме",
        `Причина: ${clean(incident.cause, 500) || clean(incident.recommendation, 500) || "требуется проверка"}`,
        `Лист: ${clean(incident.sheet, 100)} · ${clean(incident.cell, 20)}`,
        `Последняя проверка: ${clean(incident.lastSeen, 80) || "время не указано"}`,
        ...(incident.recoveryCandidate?.kind === "approved_formula"
          ? [`Утверждённая формула: ${clean(incident.recoveryCandidate.value.formulaValue, 1200)}`]
          : incident.repairAvailability?.reason
            ? [`Почему нет исправления: ${clean(incident.repairAvailability.reason, 300)}`]
            : []),
      ].join("\n");
      await this.answerCallback(query.id);
      await this.send(chatId, detail);
      this.assistant.audit("telegram", userId, "telegram_incident_details_viewed", "incident");
      return true;
    }
    if (peek.action === "reject") {
      if (!this.consumeAction(tokenHash, new Date(this.now()).toISOString())) return false;
      this.store.db.prepare("UPDATE telegram_repair_actions SET consumed_at=? WHERE incident_id=? AND generation=? AND consumed_at IS NULL").run(new Date(this.now()).toISOString(), record.incident_id, record.generation);
      await this.answerCallback(query.id);
      await this.send(chatId, "Предложение отклонено. Таблица не менялась; проблема оставлена в списке для проверки.");
      this.assistant.audit("telegram", userId, "telegram_repair_rejected", "source_recovery");
      return true;
    }
    if (peek.action === "approve" && peek.stage === "notice") {
      if (!this.consumeAction(tokenHash, new Date(this.now()).toISOString())) return false;
      const at = new Date(this.now()).toISOString();
      this.store.db.prepare("UPDATE telegram_repair_actions SET consumed_at=? WHERE incident_id=? AND generation=? AND consumed_at IS NULL").run(at, record.incident_id, record.generation);
      const candidate = incident.recoveryCandidate;
      const formulaRepair = candidate?.kind === "approved_formula";
      await this.answerCallback(query.id, "Повторно проверяю заявку и запускаю исправление.");
      if (formulaRepair) {
        const repair = this.assistant.productionRepair;
        if (!repair?.production || typeof repair.prepare !== "function") {
          await this.send(chatId, "Исправление формулы заблокировано: очередь Formula Intelligence или production writer не подключены. Таблица не изменена.");
          this.assistant.audit("telegram", userId, "telegram_repair_blocked", "formula_repair_unavailable", "blocked");
          return false;
        }
        try {
          const prepared = await repair.prepare(incident.id, "repair");
          const proposal = prepared?.proposals?.find((item) =>
            item.status === "pending" &&
            item.direction === "repair" &&
            item.incidentId === incident.id &&
            item.generation === record.generation &&
            item.baselineVersion === candidate.version &&
            item.to?.formulaValue === candidate.value.formulaValue &&
            item.target?.cell === incident.cell &&
            item.target?.sheet === incident.sheet,
          );
          if (!proposal) throw Object.assign(new Error(prepared?.message || "Production Repair не создал точное предложение по текущему эталону."), { code: "formula_proposal_unavailable" });
          const queued = await repair.confirm(proposal.id, {
            version: proposal.version,
            confirmation: proposal.confirmation,
            exclusiveEditingAcknowledged: true,
          });
          this.assistant.audit("telegram", userId, "telegram_formula_repair_authorized", proposal.id, "ok");
          if (queued?.queued !== true) throw Object.assign(new Error("Очередь Formula Intelligence не подтвердила запуск."), { code: "formula_queue_not_started" });
          try { await this.send(chatId, `Исправление запущено: ${clean(incident.sheet, 100)}!${clean(incident.cell, 20)}. RITM проверил заявку и эталон; итог пришлю после проверки Google Sheets.`); } catch {}
          void this.reportFormulaProposal(proposal.id, incident.id, chatId, userId).catch(() => {});
          return true;
        } catch (error) {
          await this.send(chatId, `Исправление не запущено: ${clean(error?.message, 350) || "не удалось повторно проверить формулу"}. Повторной записи не будет.`);
          this.assistant.audit("telegram", userId, "telegram_formula_repair_blocked", error?.code || "prepare_failed", "blocked");
          return false;
        }
      }
      const candidateVersion = this.candidateVersion(incident);
      if (!candidateVersion) {
        await this.send(chatId, "Исправление заблокировано: у заявки нет актуального подтверждённого значения. Таблица не менялась.");
        this.assistant.audit("telegram", userId, "telegram_repair_blocked", "candidate_unavailable", "blocked");
        return false;
      }
      if (!this.assistant.sourceRecovery) {
        await this.send(chatId, "Исправление заблокировано: Source Recovery или production writer не подключён. Таблица не менялась.");
        this.assistant.audit("telegram", userId, "telegram_repair_blocked", "source_recovery_unavailable", "blocked");
        return false;
      }
      try {
        const operation = this.assistant.sourceRecovery.startForIncident(record.incident_id, {
          explicitWriteApproval: true,
          incidentId: record.incident_id,
          ...(candidate.version ? { candidateVersion: candidate.version } : {}),
        }, {
          source: "telegram_owner_button",
          channel: "telegram",
          actor: userId,
          expectedCandidateFingerprint: record.candidate_version,
        });
        this.assistant.audit("telegram", userId, "telegram_source_repair_authorized", operation.id, "ok");
        try { await this.send(chatId, `Исправление запущено: ${clean(incident.sheet, 100)}!${clean(incident.cell, 20)}. RITM повторно проверяет текущее значение и эталон; результат пришлю после проверки.`); } catch {}
        void this.reportOperation(operation.id, record.incident_id, chatId, userId).catch(() => {});
        return true;
      } catch (error) {
        await this.send(chatId, `Исправление не запущено: ${clean(error?.message, 350) || "заявка не прошла повторную проверку"}. Таблица не была изменена.`);
        this.assistant.audit("telegram", userId, "telegram_repair_blocked", error?.code || "source_recovery", "blocked");
        return false;
      }
    }
    await this.answerCallback(query.id, "Действие недействительно.");
    return false;
  }
  webApprovalDetails(token) {
    const record = this.store.db.prepare("SELECT * FROM telegram_repair_actions WHERE token_hash=?").get(hash(token));
    if (!record || !["approve_web", "approve_formula_web"].includes(record.action) || record.stage !== "web") return null;
    const valid = this.currentAction(token, record.action, record.stage, record.user_id, record.chat_id);
    if (!valid) return null;
    const { incident } = valid, candidate = incident.recoveryCandidate;
    let proposal = null;
    if (record.action === "approve_formula_web") {
      if (!record.proposal_id) return null;
      const row = this.store.db.prepare("SELECT * FROM test_repair_proposals WHERE id=? AND incident_id=?").get(record.proposal_id, record.incident_id);
      if (!row || row.status !== "pending") return null;
      proposal = JSON.parse(row.payload);
      if (
        proposal.version !== row.version ||
        proposal.generation !== record.generation ||
        proposal.baselineVersion !== candidate?.version ||
        proposal.to?.formulaValue !== candidate?.value?.formulaValue ||
        proposal.target?.cell !== incident.cell ||
        proposal.target?.sheet !== incident.sheet ||
        this.now() >= proposal.expiresAt
      ) return null;
    }
    return {
      incidentId: incident.id,
      document: clean(incident.sourceName, 120),
      sheet: clean(incident.sheet, 120),
      cell: clean(incident.cell, 20),
      article: scalar(incident.observed?.productKey || incident.article),
      current: proposal ? scalar(proposal.from) : scalar(incident.found, "пусто"),
      proposed: proposal ? scalar(proposal.to) : scalar(candidate?.value),
      evidence: clean(candidate?.evidence, 240) || "не указано",
      requiresExclusiveEditing: !!proposal,
    };
  }
  async confirmWebApproval(token, exclusiveEditingAcknowledged = false) {
    const tokenHash = hash(token),
      peek = this.store.db.prepare("SELECT * FROM telegram_repair_actions WHERE token_hash=?").get(tokenHash);
    if (!peek || !["approve_web", "approve_formula_web"].includes(peek.action) || peek.stage !== "web")
      throw Object.assign(new Error("Ссылка недействительна или уже использована."), { code: "telegram_approval_invalid" });
    const valid = this.currentAction(token, peek.action, peek.stage, peek.user_id, peek.chat_id);
    if (!valid)
      throw Object.assign(new Error("Инцидент или предложение изменились. Запись заблокирована."), { code: "telegram_approval_stale" });
    if (peek.action === "approve_formula_web" && exclusiveEditingAcknowledged !== true)
      throw Object.assign(new Error("Подтвердите отсутствие параллельного редактирования ячейки."), { code: "exclusive_editing_acknowledgement_required", status: 400 });
    const at = new Date(this.now()).toISOString();
    if (!this.consumeAction(tokenHash, at))
      throw Object.assign(new Error("Подтверждение уже использовано."), { code: "telegram_approval_replayed" });
    this.store.db.prepare("UPDATE telegram_repair_actions SET consumed_at=? WHERE incident_id=? AND generation=? AND consumed_at IS NULL").run(at, peek.incident_id, peek.generation);
    this.assistant.audit("telegram", peek.user_id, "telegram_https_owner_confirmation", peek.action === "approve_formula_web" ? "formula_intelligence" : "source_recovery", "ok");
    if (peek.action === "approve_formula_web") {
      const repair = this.assistant.productionRepair;
      const proposal = this.store.db.prepare("SELECT * FROM test_repair_proposals WHERE id=? AND incident_id=?").get(peek.proposal_id, peek.incident_id);
      if (!repair?.production || !proposal || proposal.status !== "pending")
        throw Object.assign(new Error("Предложение Formula Intelligence недоступно или уже использовано; запись не выполнялась."), { code: "formula_proposal_unavailable" });
      const persisted = JSON.parse(proposal.payload);
      if (persisted.version !== proposal.version || persisted.generation !== peek.generation || persisted.baselineVersion !== valid.incident.recoveryCandidate?.version || persisted.to?.formulaValue !== valid.incident.recoveryCandidate?.value?.formulaValue)
        throw Object.assign(new Error("Версия формулы или заявки изменилась; предложение отменено, запись не выполнялась."), { code: "formula_proposal_stale" });
      try {
        const queued = await repair.confirm(peek.proposal_id, {
          version: proposal.version,
          confirmation: persisted.confirmation,
          exclusiveEditingAcknowledged: true,
        });
        await this.send(peek.chat_id, `Владелец подтвердил точную формулу. Она поставлена в очередь Formula Intelligence для ${valid.incident.sheet}!${valid.incident.cell}; очередь выполняет операции последовательно.`);
        void this.reportFormulaProposal(peek.proposal_id, peek.incident_id, peek.chat_id, peek.user_id).catch(() => {});
        return { status: "queued", cell: `${valid.incident.sheet}!${valid.incident.cell}`, queued: queued?.queued === true };
      } catch (error) {
        this.assistant.audit("telegram", peek.user_id, "telegram_formula_repair_blocked", error?.code || "queue_failed", "blocked");
        throw error;
      }
    }
    if (!this.assistant.sourceRecovery)
      throw Object.assign(new Error("Source Recovery или production writer не настроен; запись не выполнялась."), { code: "source_recovery_unavailable" });
    try {
      const writeApproval = {
        explicitWriteApproval: true,
        incidentId: peek.incident_id,
      };
      if (valid.incident.recoveryCandidate?.version)
        writeApproval.candidateVersion = valid.incident.recoveryCandidate.version;
      const operation = this.assistant.sourceRecovery.startForIncident(peek.incident_id, {
        ...writeApproval,
      }, {
        source: "telegram_owner_https",
        channel: "telegram",
        actor: peek.user_id,
        expectedCandidateFingerprint: peek.candidate_version,
      });
      await this.send(peek.chat_id, `Владелец подтвердил точную запись. Исправление запущено для ${valid.incident.sheet}!${valid.incident.cell}; результат будет отправлен после перепроверки.`);
      void this.reportOperation(operation.id, peek.incident_id, peek.chat_id, peek.user_id).catch(() => {});
      return { status: "started", cell: `${valid.incident.sheet}!${valid.incident.cell}` };
    } catch (error) {
      this.assistant.audit("telegram", peek.user_id, "telegram_repair_blocked", error?.code || "source_recovery", "blocked");
      throw error;
    }
  }
  async reportOperation(operationId, incidentId, chatId, userId) {
    try {
      const result = await this.assistant.sourceRecovery.waitForOperation(operationId);
      const status = result?.status;
      const message = status === "verified"
        ? `Исправлено и проверено: ${clean(result.target?.sheet, 100)}!${clean(result.target?.cell, 20)} = ${scalar(result.after)}`
        : status === "already_restored"
          ? `Значение уже было восстановлено; повторной записи не было. Инцидент перепроверен.`
          : `Исправление не подтверждено (${clean(status, 60) || "неизвестный статус"}). ${clean(result?.result?.message, 260) || "Повторная запись заблокирована."}`;
      await this.send(chatId, message);
      this.assistant.audit("telegram", userId, "telegram_repair_result", "source_recovery", status === "verified" || status === "already_restored" ? "ok" : "blocked");
    } catch (error) {
      await this.send(chatId, "Проверка результата не завершена. Повторная запись заблокирована; откройте статус в AI Center.");
      this.assistant.audit("telegram", userId, "telegram_repair_result_unavailable", "source_recovery", "blocked");
    }
  }
  async reportFormulaProposal(proposalId, incidentId, chatId, userId) {
    try {
      const result = await this.assistant.productionRepair.waitForProposal(proposalId);
      const message = result.status === "verified"
        ? `Формула исправлена и проверена: ${clean(result.target?.sheet, 100)}!${clean(result.target?.cell, 20)}. Google Sheets и Table Doctor подтвердили результат.`
        : result.status === "timed_out"
          ? "Очередь Formula Intelligence ещё проверяет исправление. Повторная запись заблокирована; статус сохранён в AI Center."
          : `Исправление формулы не подтверждено (${clean(result.status, 60)}). ${clean(result.message, 300) || "Повторная запись заблокирована; проверьте статус в AI Center."}`;
      await this.send(chatId, message);
      this.assistant.audit("telegram", userId, "telegram_formula_repair_result", "formula_intelligence", result.status === "verified" ? "ok" : "blocked");
    } catch (error) {
      await this.send(chatId, "Не удалось получить итог проверки формулы. Повторная запись заблокирована; откройте очередь исправлений в AI Center.");
      this.assistant.audit("telegram", userId, "telegram_formula_repair_result_unavailable", incidentId, "blocked");
    }
  }
  async sendTest() {
    const owner = this.store.db
      .prepare("SELECT chat_id FROM assistant_owner WHERE id=1")
      .get();
    if (!owner)
      throw new Error(
        "Сначала привяжите личный Telegram через одноразовый код.",
      );
    await this.send(
      owner.chat_id,
      "✅ Тестовое сообщение RITM Assistant. Связь с локальным агентом работает.",
    );
    this.assistant.audit("web", "owner", "telegram_test_sent");
  }
  async poll(signal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await this.assistant.flushCheckNotifications?.();
        if (!this.connected) {
          const bot = await this.api("getMe", {}, signal);
          this.connected = true;
          this.botName = bot.username || bot.first_name || null;
          this.store.meta("telegramAssistant", {
            connected: true,
            botName: this.botName,
            checkedAt: new Date(this.now()).toISOString(),
            lastError: null,
          });
        }
        const updates = await this.api(
          "getUpdates",
          { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
          signal,
        );
        backoff = 1000;
        for (const update of updates || []) {
          await this.process(update);
          this.offset = update.update_id + 1;
          this.store.meta("telegramUpdateOffset", this.offset);
        }
        await this.assistant.flushCheckNotifications?.();
      } catch (error) {
        if (signal.aborted) break;
        this.connected = false;
        this.store.meta("telegramAssistant", {
          connected: false,
          botName: this.botName,
          checkedAt: new Date(this.now()).toISOString(),
          lastError: "Telegram API недоступен; агент повторит подключение.",
        });
        this.store.log(
          "telegram_poll_error",
          "Telegram long polling недоступен; подключение будет восстановлено",
          null,
        );
        await delay(
          Math.max(
            1000,
            Math.min(Number(error.retryAfter) * 1000 || backoff, 60000),
          ),
          undefined,
          { signal },
        ).catch(() => {});
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
  async process(update) {
    if (Number.isSafeInteger(update?.update_id)) {
      const claimed = this.store.db
        .prepare("INSERT OR IGNORE INTO telegram_assistant_updates(update_id,received_at) VALUES(?,?)")
        .run(update.update_id, new Date(this.now()).toISOString());
      if (!claimed.changes) return false;
      this.store.db.exec(`DELETE FROM telegram_assistant_updates
        WHERE update_id NOT IN (SELECT update_id FROM telegram_assistant_updates ORDER BY update_id DESC LIMIT 500)`);
    }
    if (update?.callback_query) return this.processCallback(update);
    const message = update.message,
      text = String(message?.text || "").trim();
    if (
      !message ||
      message.chat?.type !== "private" ||
      message.forward_date ||
      message.forward_origin
    ) {
      this.assistant.audit(
        "telegram",
        message?.from?.id || "unknown",
        "telegram_message_rejected",
        null,
        "rejected",
      );
      return;
    }
    const userId = String(message.from?.id || "");
    if (
      /^\/start\s+[A-F0-9]{8}$/i.test(text) &&
      this.assistant.bindTelegram(update)
    ) {
      await this.send(
        message.chat.id,
        "✅ Личный Telegram привязан к RITM Assistant. " + HELP,
      );
      return;
    }
    if (!this.assistant.isOwner(update)) {
      this.assistant.audit(
        "telegram",
        userId || "unknown",
        "telegram_unauthorized_message",
        null,
        "rejected",
      );
      return;
    }
    this.assistant.audit("telegram", userId, "message_received");
    if (text === "/help" || text === "/start") {
      await this.send(message.chat.id, HELP);
      return;
    }
    if (text === "/status") {
      const state = this.store.overview();
      await this.send(
        message.chat.id,
        `Агент: ${state.agent?.status || "нет данных"}; активных проблем: ${state.active}; последняя проверка: ${state.lastCheck?.at || "нет данных"}.`,
      );
      return;
    }
    if (text === "/checkstatus") {
      await this.send(message.chat.id, this.assistant.formatCheckStatus());
      this.assistant.audit("telegram", userId, "check_status_viewed");
      return;
    }
    if (text === "/problems") {
      await this.send(
        message.chat.id,
        (
          await this.assistant.respond("Какие ошибки сейчас есть?", {
            channel: "telegram",
            actor: userId,
          })
        ).text,
      );
      return;
    }
    if (text === "/history") {
      await this.send(
        message.chat.id,
        (
          await this.assistant.respond("Что изменилось за сегодня?", {
            channel: "telegram",
            actor: userId,
          })
        ).text,
      );
      return;
    }
    if (text === "/fastcheck" || text === "/check") {
      const prompt =
        text === "/fastcheck"
          ? "Проверь таблицы быстро"
          : "Проверь все таблицы глубоко";
      await this.send(
        message.chat.id,
        (
          await this.assistant.respond(prompt, {
            channel: "telegram",
            actor: userId,
          })
        ).text,
      );
      return;
    }
    const reply = await this.assistant.respond(text, {
      channel: "telegram",
      actor: userId,
    });
    await this.send(message.chat.id, reply.text);
  }
}
