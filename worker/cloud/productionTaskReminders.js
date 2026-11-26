import { CloudError } from "./access.js";
import { validBitrixRecipient } from "./bitrixRecipients.js";

export const TASK_REMINDER_KIND = "production-task-reminder";
const intervals = new Set([0, 60, 180, 1440]);
const checks = new Set(["manual", "production", "packing", "catalog-exists"]);
const minute = 60_000;
const statusForCheck = value => value === "closed" || value === "open" ? value : "unconfirmed";
const taskId = control => control.batchId || control.id;
const operation = (scope, kind, id) => scope.operations.get(kind + ":" + id)?.value;

export function normalizeProductionTaskReminder(value, scope) {
  if (value === undefined) return null;
  const invalid = () => new CloudError("task_reminder_invalid", "Проверьте получателя, время и повтор напоминания.", 400);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["recipientId", "remindAt", "intervalMinutes", "check"].includes(key))) throw invalid();
  const { recipientId, remindAt, intervalMinutes = 0, check = "manual" } = value;
  const at = typeof remindAt === "string" ? Date.parse(remindAt) : NaN;
  if (!validBitrixRecipient(recipientId) || !Number.isFinite(at) ||
    new Date(at).toISOString() !== remindAt || !intervals.has(intervalMinutes) ||
    !checks.has(check) || (check === "catalog-exists" && scope !== "article")) throw invalid();
  return { recipientId, remindAt, intervalMinutes, check };
}

export function sameProductionTaskReminder(a, b) {
  if (!a || !b) return !a && !b;
  return a.recipientId === b.recipientId && a.remindAt === b.remindAt &&
    (a.intervalMinutes ?? 0) === b.intervalMinutes && (a.check ?? "manual") === b.check;
}

export function confirmProductionTaskReminder(draft, recipient, now) {
  if (!draft) return null;
  if (Date.parse(draft.remindAt) <= now)
    throw new CloudError("task_reminder_past", "Выберите время напоминания в будущем.", 400);
  if (!recipient || recipient.id !== draft.recipientId || !recipient.name)
    throw new CloudError("task_reminder_recipient", "Получатель больше не подтверждён как сотрудник Битрикс24.", 409);
  return { ...draft, recipientName: recipient.name };
}

export function queueProductionTaskReminder(scope, controls) {
  const first = controls[0], configured = first?.bitrixReminder;
  if (!configured) return;
  const id = taskId(first);
  if (operation(scope, TASK_REMINDER_KIND, id))
    throw new CloudError("task_reminder_conflict", "У этой задачи уже сохранено напоминание.", 409);
  if (!controls.every(control =>
    taskId(control) === id && sameProductionTaskReminder(control.bitrixReminder, configured)))
    throw new Error("Inconsistent task reminder batch");
  scope.putOperation(TASK_REMINDER_KIND, {
    ...configured,
    id,
    taskIds: controls.map(control => control.id),
    status: "scheduled",
    sequence: 0,
    nextAt: configured.remindAt,
    createdAt: first.createdAt,
  });
}

export function productionTaskReminderStatus(scope, control, now = Date.now()) {
  if (!control.bitrixReminder) return control;
  const schedule = operation(scope, TASK_REMINDER_KIND, taskId(control));
  return { ...control, bitrixReminder: {
    ...control.bitrixReminder,
    status: schedule?.status === "sending" && now - Date.parse(schedule.sendingAt) > minute
      ? "uncertain" : schedule?.status || "uncertain",
    ...(schedule?.status === "scheduled" && { nextAt: schedule.nextAt }),
    ...(schedule?.lastSentAt && { lastSentAt: schedule.lastSentAt }),
    ...(schedule?.checkStatus && { checkStatus: schedule.checkStatus }),
  } };
}

function taskRows(scope, schedule) {
  return schedule.taskIds.map(id => operation(scope, "production-control", id));
}

function ended(rows) {
  if (rows.some(row => !row)) return "failed";
  if (rows.some(row => row.status === "active")) return null;
  return rows.every(row => ["completed", "acknowledged"].includes(row.status)) ? "completed" : "cancelled";
}

export function closeInactiveTaskReminder(scope, control) {
  if (!control.bitrixReminder) return;
  const schedule = operation(scope, TASK_REMINDER_KIND, taskId(control));
  if (schedule?.status !== "scheduled") return;
  const status = ended(taskRows(scope, schedule));
  if (status) scope.putOperation(TASK_REMINDER_KIND, { ...schedule, status, nextAt: null });
}

function due(schedule, now) {
  return schedule?.status === "scheduled" && Date.parse(schedule.nextAt) <= now &&
    (!schedule.retryAt || Date.parse(schedule.retryAt) <= now);
}

function currentCycle(scope, saved, now) {
  const current = operation(scope, TASK_REMINDER_KIND, saved.id);
  return due(current, now) && current.sequence === saved.sequence &&
    current.nextAt === saved.nextAt ? current : null;
}

const taskVersion = rows => JSON.stringify(rows.map(row => row && [row.id, row.status, row.updatedAt]));

// Read-only failures can retry. Reserve and persist before the provider send.
// An ambiguous send or a crashed in-flight request never starts a new cycle.
export async function drainProductionTaskReminders(store, { verify, readRecipient, send }) {
  const pending = (await store.readOperationsByKind(TASK_REMINDER_KIND))
    .filter(item => due(item, store.now()))
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
    .slice(0, 8);
  if (!pending.length) return { attempts: 0 };
  const controls = await store.operationReadScope("production-control");
  const locked = fn => store.withScope(fn, { waitMs: 2500 });
  let attempts = 0;
  for (const saved of pending) {
    const rows = taskRows(controls, saved);
    const status = ended(rows);
    const active = rows.filter(row => row?.status === "active");
    const checkStatus = status ? null : await Promise.resolve()
      .then(() => verify(saved, active)).then(statusForCheck, () => "unconfirmed");
    let person = null, directoryUnavailable = false;
    if (!status && checkStatus !== "closed") {
      try { person = await readRecipient(saved.recipientId); }
      catch { directoryUnavailable = true; }
    }
    const reserved = await locked(scope => {
      if (scope.meta("bitrixNotificationsEnabled") === false) return null;
      const current = currentCycle(scope, saved, store.now());
      if (!current) return null;
      const latest = taskRows(scope, current);
      const finalStatus = ended(latest);
      if (finalStatus) {
        scope.putOperation(TASK_REMINDER_KIND, { ...current, status: finalStatus, nextAt: null });
        return null;
      }
      // An edited or completed batch is checked again with its exact membership.
      if (taskVersion(latest) !== taskVersion(rows)) return null;
      if (checkStatus === "closed") {
        scope.putOperation(TASK_REMINDER_KIND, { ...current, status: "completed", checkStatus, nextAt: null });
        return null;
      }
      if (directoryUnavailable) {
        scope.putOperation(TASK_REMINDER_KIND, {
          ...current, checkStatus, retryAt: new Date(store.now() + 5 * minute).toISOString(),
        });
        return null;
      }
      if (!person || person.id !== current.recipientId) {
        scope.putOperation(TASK_REMINDER_KIND, { ...current, status: "failed", checkStatus, nextAt: null });
        return null;
      }
      const sending = { ...current, status: "sending", checkStatus, sendingAt: new Date(store.now()).toISOString(), retryAt: null };
      scope.putOperation(TASK_REMINDER_KIND, sending);
      return sending;
    });
    if (!reserved) continue;
    attempts++;
    const result = await Promise.resolve().then(() => send(reserved, active))
      .catch(() => ({ status: "uncertain" }));
    await locked(scope => {
      const current = operation(scope, TASK_REMINDER_KIND, saved.id);
      if (current?.status !== "sending" || current.sequence !== reserved.sequence) return;
      const sent = result?.status === "sent" && Number.isSafeInteger(result.messageId) && result.messageId > 0;
      const now = store.now();
      const finished = ended(taskRows(scope, current));
      const repeats = sent && !finished && intervals.has(current.intervalMinutes) && current.intervalMinutes > 0;
      scope.putOperation(TASK_REMINDER_KIND, {
        ...current,
        status: repeats ? "scheduled" : sent ? finished || "sent" : result?.status === "failed" ? "failed" : "uncertain",
        nextAt: repeats ? new Date(now + current.intervalMinutes * minute).toISOString() : null,
        sequence: current.sequence + (repeats ? 1 : 0),
        ...(sent && { lastSentAt: new Date(now).toISOString(), messageId: result.messageId }),
      });
      return null;
    });
  }
  return { attempts };
}
