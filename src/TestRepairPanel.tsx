import { useState } from "react";
import { Badge, Button, Field, Notice } from "./ui";
import { timeLabel } from "./intelligence";
import { useAgentResource } from "./useAgent";
type Proposal = {
  id: string;
  version: string;
  status: string;
  expired: boolean;
  direction: string;
  confirmation: string;
  limitation: string;
  from: {
    numberValue?: number;
    formulaValue?: string;
    stringValue?: string;
    boolValue?: boolean;
  };
  to: {
    numberValue?: number;
    formulaValue?: string;
    stringValue?: string;
    boolValue?: boolean;
  };
  expectedResult: number | null;
  sourceName: string;
  createdAt: string;
  expiresAt: number;
  target: { documentId: string; sheetId: number; sheet: string; cell: string };
  result?: {
    at: string;
    after: {
      cell: unknown;
      effective: {
        numberValue?: number;
        stringValue?: string;
        boolValue?: boolean;
      };
    };
    api: { writeRequests: number };
  } | null;
  events: { at: string; type: string; payload: unknown }[];
};
type RepairState = {
  ok: true;
  enabled: boolean;
  testOnly: boolean;
  isolation: {
    status: string;
    message: string;
    permissionReason?: string | null;
    requiredAction?: string | null;
  };
  proposals: Proposal[];
};
const labels: Record<string, string> = {
  queued: "В очереди",
  checking: "Проверяется после записи",
  needs_review: "Ошибка — требуется решение",
  pending: "Ожидает подтверждения",
  verified: "Изменение проверено",
  cancelled: "Отменено",
  superseded: "Заменено новым предложением",
  uncertain: "Результат неизвестен · повтор запрещён",
  executing: "Выполняется",
  repair_proposed: "Предложение сохранено",
  repair_confirmed: "Владелец подтвердил изменение",
  repair_backup: "Исходное содержимое сохранено",
  repair_write_started: "Условная запись",
  repair_verified: "Повторное чтение и диагностика успешны",
  repair_cancelled: "Изменение отменено",
  repair_uncertain: "Нужна ручная проверка",
};
const value = (v: Proposal["from"]) =>
  v.formulaValue ??
  v.stringValue ??
  String(v.numberValue ?? v.boolValue ?? "(пусто)");
export function TestRepairPanel({
  incidentId,
  production = false,
}: {
  incidentId: string;
  production?: boolean;
}) {
  const base = production
    ? "/api/intelligence/formula-repair"
    : "/api/intelligence/test-repair";
  const resource = useAgentResource<RepairState>(
    base + "?incidentId=" + incidentId,
    true,
    10000,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const p = resource.value?.proposals[0];
  async function act(path: string, payload: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setAck(false);
    setTyped("");
    try {
      const r = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      const result = await r.json();
      if (!r.ok || !result.ok)
        throw new Error(result.message || "Действие не выполнено");
      if (typeof result.message === "string") setNotice(result.message);
      else if (
        result.proposals?.some(
          (proposal: Proposal) => proposal.status === "pending",
        )
      )
        setNotice(
          "Подготовлено точечное предложение. Google Sheets не изменялись; для записи потребуется отдельное подтверждение владельца.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Агент недоступен");
    } finally {
      await resource.reload();
      setBusy(false);
    }
  }
  const blocked = !["verified", "unverified"].includes(
    resource.value?.isolation.status || "",
  );
  return (
    <section className={production ? "panel" : "panel doctor-demo"}>
      <div className="panel-heading">
        <h3>
          {production
            ? "Исправление по твоему подтверждению"
            : "Исправление · только тестовая G247"}
        </h3>
        <Badge>Настоящий Google API</Badge>
      </div>
      <Notice>
        {production ? (
          "Предложение пока ничего не меняет. Формула взята из утверждённого эталона; запись требует подтверждения точного изменения ниже."
        ) : (
          <>
            Производственные таблицы не изменяются. Новый ключ используется
            отдельным тестовым сервисом. Отправка предложения сохраняет план без
            записи в Google Sheets.
          </>
        )}
      </Notice>
      {resource.value && (
        <Notice tone={blocked ? "warning" : "neutral"}>
          {resource.value.isolation.message}
        </Notice>
      )}
      {resource.value?.isolation.requiredAction && (
        <p className="panel-note">
          Следующее действие: {resource.value.isolation.requiredAction}
        </p>
      )}
      {notice && <Notice tone="success">{notice}</Notice>}
      {(error || resource.error) && (
        <Notice tone="warning">{error || resource.error}</Notice>
      )}
      <div className="doctor-actions">
        <Button
          disabled={
            busy ||
            resource.locked ||
            ["queued", "checking", "needs_review"].includes(p?.status || "") ||
            p?.status === "executing" ||
            p?.status === "uncertain"
          }
          onClick={() => void act(base + "/propose", { incidentId })}
        >
          Предложить исправление
        </Button>
        {p?.status === "verified" && p.direction === "repair" && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(base + "/propose", {
                incidentId,
                direction: "rollback",
                previousId: p.id,
              })
            }
          >
            Предложить откат
          </Button>
        )}
      </div>
      {p && (
        <>
          <Badge tone={p.status === "verified" ? "success" : "warning"}>
            {labels[p.status] || p.status}
            {p.expired && p.status === "pending" ? " · срок истёк" : ""}
          </Badge>
          <dl className="ai-details">
            <div>
              <dt>Документ</dt>
              <dd>
                {p.sourceName}
                <small className="ai-block">{p.target.documentId}</small>
              </dd>
            </div>
            <div>
              <dt>Точное изменение</dt>
              <dd>
                {p.target.sheet} · gid {p.target.sheetId} · {p.target.cell}
                <br />
                {value(p.from)} → {value(p.to)}
              </dd>
            </div>
            <div>
              <dt>Ожидаемый результат</dt>
              <dd>
                {p.expectedResult === null
                  ? "Будет проверен после восстановления; числовой результат заранее не рассчитан"
                  : p.expectedResult.toLocaleString("ru-RU")}
              </dd>
            </div>
            <div>
              <dt>Версия предложения</dt>
              <dd>{p.version}</dd>
            </div>
            <div>
              <dt>Создано / действует до</dt>
              <dd>
                {timeLabel(p.createdAt)} /{" "}
                {timeLabel(new Date(p.expiresAt).toISOString())}
              </dd>
            </div>
          </dl>
          <Notice tone="warning">{p.limitation}</Notice>
          {p.status === "pending" && (
            <>
              {!production && (
                <Field
                  label={"Для подтверждения введите: «" + p.confirmation + "»"}
                >
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    disabled={busy || blocked || p.expired}
                  />
                </Field>
              )}
              <label className="ai-block">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy || blocked || p.expired}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                {production
                  ? "Я согласовал отсутствие параллельного редактирования этой ячейки и её зависимостей на время исправления. Понимаю, что Google не блокирует других редакторов."
                  : "Я подтверждаю отсутствие параллельного редактирования G247 и C247/D247 на время теста."}
              </label>
              <Button
                kind="primary"
                disabled={
                  busy ||
                  blocked ||
                  p.expired ||
                  !ack ||
                  (!production && typed !== p.confirmation)
                }
                onClick={() =>
                  void act(base + "/" + p.id + "/confirm", {
                    version: p.version,
                    confirmation: production ? p.confirmation : typed,
                    exclusiveEditingAcknowledged: ack,
                  })
                }
              >
                {busy
                  ? "Проверяю…"
                  : "Подтвердить " + value(p.from) + " → " + value(p.to)}
              </Button>
            </>
          )}
          {p.result && (
            <Notice>
              Повторное чтение: {JSON.stringify(p.result.after.cell)}.
              Результат:{" "}
              {p.result.after.effective.numberValue?.toLocaleString("ru-RU") ??
                p.result.after.effective.stringValue ??
                String(p.result.after.effective.boolValue ?? "не получен")}
              . Проверено {timeLabel(p.result.at)}.
            </Notice>
          )}
          <h4>Журнал этого предложения</h4>
          <ol>
            {p.events.map((e, i) => (
              <li key={i}>
                {timeLabel(e.at)} · {labels[e.type] || e.type}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
