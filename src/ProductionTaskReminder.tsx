import { useEffect, useState } from "react";
import { Bell, RefreshCw } from "lucide-react";
import { inputInstant, moscowInput } from "./productionForecastModel";
import { Busy, Button } from "./ui";
import "./productionTaskReminder.css";

export type BitrixTaskRecipient = { id: string; name: string };
type ReminderInterval = 0 | 60 | 180 | 1440;
type CompletionCheck = "manual" | "packing" | "production" | "catalog-exists";

export type BitrixTaskReminderDraft = {
  recipientId: string;
  moscowTime: string;
  intervalMinutes: ReminderInterval;
  check: CompletionCheck;
};

export type BitrixTaskReminderRequest = {
  recipientId: string;
  remindAt: string;
  intervalMinutes?: ReminderInterval;
  check?: CompletionCheck;
};

export type BitrixTaskReminder = BitrixTaskReminderRequest & {
  recipientName: string;
  status?:
    | "scheduled"
    | "sending"
    | "sent"
    | "failed"
    | "uncertain"
    | "cancelled"
    | "completed";
  nextAt?: string;
  lastSentAt?: string;
  checkStatus?: "open" | "unconfirmed" | "closed";
};

const intervals = [
  { value: 0, label: "Один раз" },
  { value: 60, label: "Каждый час" },
  { value: 180, label: "Каждые 3 часа" },
  { value: 1440, label: "Раз в сутки" },
] as const;
const completionLabels = {
  manual: "По отметке в задаче",
  packing: "После полной упаковки",
  production: "После печати и порезки по таблицам",
  "catalog-exists": "Когда товары появятся в справочнике",
};

export function taskReminderRequest(
  draft: BitrixTaskReminderDraft,
): BitrixTaskReminderRequest {
  if (!draft.recipientId) throw new Error("Выберите получателя в Битриксе.");
  let remindAt: string | null = null;
  try {
    remindAt = inputInstant(draft.moscowTime);
  } catch {
    // The user can correct the time in the existing task editor.
  }
  if (!remindAt) throw new Error("Укажите дату и время напоминания по Москве.");
  return {
    recipientId: draft.recipientId,
    remindAt,
    intervalMinutes: draft.intervalMinutes,
    check: draft.check,
  };
}

type Props = {
  draft: BitrixTaskReminderDraft | null;
  onChange: (draft: BitrixTaskReminderDraft | null) => void;
  loadRecipients: (signal: AbortSignal) => Promise<BitrixTaskRecipient[]>;
  saving: boolean;
  scope: "shipment" | "article";
};

export function ProductionTaskReminder({
  draft,
  onChange,
  loadRecipients,
  saving,
  scope,
}: Props) {
  return (
    <section className="production-task-reminder">
      <label className="production-task-reminder__toggle">
        <input
          type="checkbox"
          checked={draft !== null}
          disabled={saving}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? {
                    recipientId: "",
                    moscowTime: moscowInput(
                      new Date(Date.now() + 3_600_000).toISOString(),
                    ),
                    intervalMinutes: 0,
                    check: "manual",
                  }
                : null,
            )
          }
        />
        <span>
          <Bell size={16} aria-hidden="true" /> Личное напоминание в Битриксе
        </span>
      </label>
      {draft && (
        <>
          <p className="production-task-reminder__hint">
            Аркадий пришлёт название и комментарий задачи в личку Битрикса.
          </p>
          <ReminderFields
            draft={draft}
            onChange={onChange}
            loadRecipients={loadRecipients}
            saving={saving}
            scope={scope}
          />
        </>
      )}
    </section>
  );
}

type DirectoryState =
  | { status: "loading" }
  | { status: "ready"; recipients: BitrixTaskRecipient[] }
  | { status: "error"; message: string };

function ReminderFields({
  draft,
  onChange,
  loadRecipients,
  saving,
  scope,
}: Omit<Props, "draft"> & { draft: BitrixTaskReminderDraft }) {
  const [directory, setDirectory] = useState<DirectoryState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadRecipients(controller.signal).then(
      (recipients) => {
        if (!controller.signal.aborted)
          setDirectory({ status: "ready", recipients });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setDirectory({
            status: "error",
            message:
              cause instanceof Error && cause.name === "Error"
                ? cause.message
                : "Список сотрудников Битрикса недоступен.",
          });
        }
      },
    );
    return () => controller.abort();
  }, [attempt, loadRecipients]);

  if (directory.status === "loading") {
    return (
      <div className="production-task-reminder__state">
        <Busy label="Загружаю сотрудников…" />
      </div>
    );
  }
  if (directory.status === "error") {
    return (
      <div className="production-task-reminder__state">
        <p role="alert">{directory.message}</p>
        <Button
          type="button"
          disabled={saving}
          onClick={() => {
            setDirectory({ status: "loading" });
            setAttempt((value) => value + 1);
          }}
        >
          <RefreshCw size={15} aria-hidden="true" /> Повторить
        </Button>
      </div>
    );
  }
  const recipients = directory.recipients;
  if (recipients.length === 0) {
    return (
      <p className="production-task-reminder__state" role="status">
        В Битриксе нет доступных получателей.
      </p>
    );
  }

  const recipientId = recipients.some(
    (person) => person.id === draft.recipientId,
  )
    ? draft.recipientId
    : "";
  const nameCounts = new Map<string, number>();
  for (const person of recipients) {
    nameCounts.set(person.name, (nameCounts.get(person.name) || 0) + 1);
  }
  return (
    <div className="production-task-reminder__fields">
      <label>
        <span>Получатель напоминания</span>
        <select
          value={recipientId}
          required
          disabled={saving}
          onChange={(event) =>
            onChange({ ...draft, recipientId: event.target.value })
          }
        >
          <option value="">Выберите сотрудника</option>
          {recipients.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {(nameCounts.get(person.name) || 0) > 1
                ? ` · ID ${person.id}`
                : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Первое напоминание (МСК)</span>
        <input
          type="datetime-local"
          value={draft.moscowTime}
          required
          disabled={saving}
          onChange={(event) =>
            onChange({ ...draft, moscowTime: event.target.value })
          }
        />
      </label>
      <label>
        <span>Периодичность</span>
        <select
          value={draft.intervalMinutes}
          disabled={saving}
          onChange={(event) => {
            const selected = intervals.find(
              ({ value }) => String(value) === event.target.value,
            );
            if (selected)
              onChange({ ...draft, intervalMinutes: selected.value });
          }}
        >
          {intervals.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Как проверить выполнение</span>
        <select
          value={draft.check}
          disabled={saving}
          onChange={(event) => {
            const check = event.target.value;
            if (
              check === "manual" ||
              check === "packing" ||
              check === "production" ||
              (scope === "article" && check === "catalog-exists")
            ) {
              onChange({ ...draft, check });
            }
          }}
        >
          <option value="manual">{completionLabels.manual}</option>
          <option value="packing">{completionLabels.packing}</option>
          <option value="production">{completionLabels.production}</option>
          {scope === "article" && (
            <option value="catalog-exists">
              {completionLabels["catalog-exists"]}
            </option>
          )}
        </select>
      </label>
    </div>
  );
}

const reminderDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Moscow",
});
const reminderStatus = {
  scheduled: "Запланировано",
  sending: "Отправляется",
  sent: "Отправлено",
  failed: "Не отправлено",
  uncertain: "Доставка не подтверждена",
  cancelled: "Отменено",
  completed: "Завершено",
};

export function ProductionTaskReminderDetails({
  reminder,
}: {
  reminder: BitrixTaskReminder;
}) {
  const timestamp = Date.parse(reminder.remindAt);
  const nextTimestamp = reminder.nextAt ? Date.parse(reminder.nextAt) : NaN;
  const interval = intervals.find(
    ({ value }) => value === reminder.intervalMinutes,
  );
  return (
    <div className="production-task-reminder__saved">
      <Bell size={14} aria-hidden="true" />
      <span>
        Битрикс · <strong>{reminder.recipientName}</strong>
      </span>
      {Number.isFinite(timestamp) && (
        <span>
          Первое{" "}
          <time dateTime={reminder.remindAt}>
            {reminderDate.format(timestamp)} МСК
          </time>
        </span>
      )}
      {reminder.nextAt &&
        Number.isFinite(nextTimestamp) &&
        nextTimestamp !== timestamp && (
          <span>
            Следующее{" "}
            <time dateTime={reminder.nextAt}>
              {reminderDate.format(nextTimestamp)} МСК
            </time>
          </span>
        )}
      {interval && <span>{interval.label}</span>}
      {reminder.check && <span>{completionLabels[reminder.check]}</span>}
      {reminder.status && (
        <span
          className={`production-task-reminder__status is-${reminder.status}`}
        >
          {reminderStatus[reminder.status]}
        </span>
      )}
      {reminder.checkStatus === "unconfirmed" && (
        <span className="production-task-reminder__status is-uncertain">
          Выполнение пока не подтверждено
        </span>
      )}
    </div>
  );
}
