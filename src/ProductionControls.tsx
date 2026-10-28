import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Check, ClipboardCheck, Clock3, Flag, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { Button, Modal } from "./ui";

type ControlKind = "quality_check" | "notification" | "instruction";
type Priority = "attention" | "urgent";
type Trigger = "shipment_received" | "before_packing" | "before_box_close";
type ControlState = "active" | "completed" | "acknowledged" | "cancelled";
type Control = {
  id: string;
  shipmentId: string;
  shipmentIds?: string[];
  shipmentName: string;
  scope: "shipment" | "article";
  article: string | null;
  kind: ControlKind;
  priority: Priority;
  trigger: Trigger;
  title: string;
  note: string;
  status: ControlState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: { employeeId: string; employeeName: string; article: string } | null;
};

const kindLabels: Record<ControlKind, string> = {
  quality_check: "Проверка качества",
  notification: "Уведомление",
  instruction: "Инструкция",
};
const triggerLabels: Record<Trigger, string> = {
  shipment_received: "При поступлении в Assembly",
  before_packing: "Перед упаковкой",
  before_box_close: "Перед закрытием короба",
};
const stateLabels: Record<ControlState, string> = {
  active: "Ожидает сборщика",
  completed: "Выполнено",
  acknowledged: "Принято",
  cancelled: "Отменено",
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.headers || {}), ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.message || "Не удалось обновить контроль поставки.");
  return result as T;
}

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function ProductionControls({
  shipmentIds,
  shipmentName,
  articles,
}: {
  shipmentIds: string[];
  shipmentName: string;
  articles: string[];
}) {
  const shipmentIdsKey = Array.from(new Set(shipmentIds.filter(Boolean))).join(",");
  const activeShipmentIds = useMemo(() => shipmentIdsKey ? shipmentIdsKey.split(",") : [], [shipmentIdsKey]);
  const [controls, setControls] = useState<Control[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [kind, setKind] = useState<ControlKind>("quality_check");
  const [priority, setPriority] = useState<Priority>("attention");
  const [scope, setScope] = useState<"shipment" | "article">("shipment");
  const [article, setArticle] = useState(articles[0] || "");
  const [trigger, setTrigger] = useState<Trigger>("shipment_received");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    if (!shipmentIdsKey) { setControls([]); setError(""); setLoading(false); return; }
    setLoading(true);
    try {
      const result = await request<{ controls: Control[] }>(`/api/production-controls?shipmentIds=${encodeURIComponent(shipmentIdsKey)}`);
      setControls(Array.isArray(result.controls) ? result.controls : []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось прочитать контроль поставки.");
    } finally {
      setLoading(false);
    }
  }, [shipmentIdsKey]);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60000);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  useEffect(() => {
    if (articles.length && !articles.includes(article)) setArticle(articles[0]);
  }, [articles, article]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeShipmentIds.length || saving) return;
    setSaving(true);
    setError("");
    try {
      await request("/api/production-controls", {
        method: "POST",
        body: JSON.stringify({
          action: "create",
          requestId: crypto.randomUUID(),
          shipmentId: activeShipmentIds[0],
          shipmentIds: activeShipmentIds,
          shipmentName,
          scope,
          ...(scope === "article" ? { article } : {}),
          kind,
          priority,
          trigger,
          title,
          note,
        }),
      });
      setModalOpen(false);
      setTitle("");
      setNote("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Задача не сохранена.");
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (control: Control) => {
    setError("");
    try {
      await request("/api/production-controls", { method: "POST", body: JSON.stringify({ action: "cancel", controlId: control.id }) });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отменить задачу.");
    }
  };

  const visibleControls = controls.filter((control) => (control.shipmentIds || [control.shipmentId]).some((id) => activeShipmentIds.includes(id)));
  const activeCount = visibleControls.filter((control) => control.status === "active").length;
  return (
    <>
      <section className="production-controls" aria-label="Контроль поставки">
        <div className="production-controls-heading">
          <div className="production-controls-title">
            <span className="production-controls-icon"><ClipboardCheck size={19} /></span>
            <div>
              <h3>Контроль поставки</h3>
              <p>Срочные задачи и проверки в окне упаковки Assembly</p>
            </div>
            {activeCount > 0 && <span className="production-controls-count">{activeCount} активн.</span>}
          </div>
          <div className="production-controls-actions">
            <Button onClick={() => void refresh()} disabled={loading} aria-label="Обновить задачи"><RefreshCw size={15} />{loading ? "Обновляю…" : "Обновить"}</Button>
            <Button kind="primary" onClick={() => setModalOpen(true)} disabled={!activeShipmentIds.length} title={!activeShipmentIds.length ? "Поставка ещё не связана с Assembly" : undefined}><Plus size={16} />Добавить задачу</Button>
          </div>
        </div>
        {!activeShipmentIds.length && <p className="production-controls-message">Поставка пока не связана со сборкой. Задачу можно будет добавить после синхронизации.</p>}
        {error && <div className="production-controls-error" role="alert">{error}</div>}
        {loading && visibleControls.length === 0 ? <p className="production-controls-message">Загружаю задачи…</p> : visibleControls.length === 0 ? (
          <p className="production-controls-message">Пока нет задач. Добавьте напоминание или проверку — сборщики увидят её в окне упаковки выбранного артикула.</p>
        ) : (
          <div className="production-control-list">
            {visibleControls.map((control) => (
              <article className={`production-control-row ${control.priority === "urgent" ? "is-urgent" : ""} ${control.status !== "active" ? "is-finished" : ""}`} key={control.id}>
                <span className="production-control-kind-icon" aria-hidden="true">{control.kind === "notification" ? <Bell size={17} /> : control.priority === "urgent" ? <TriangleAlert size={17} /> : <Flag size={17} />}</span>
                <div className="production-control-copy">
                  <div className="production-control-title-line"><strong>{control.title}</strong><span className={`production-control-priority ${control.priority}`}>{control.priority === "urgent" ? "Срочно" : "Внимание"}</span></div>
                  <div className="production-control-meta">
                    <span>{kindLabels[control.kind]}</span><span>{control.scope === "article" ? control.article : "Вся поставка"}</span><span>{triggerLabels[control.trigger]}</span>
                  </div>
                  {control.note && <p>{control.note}</p>}
                  {control.completedBy && <small className="production-control-proof">{control.completedBy.employeeName} · {control.status === "acknowledged" ? "принял" : "выполнил"} · {dateLabel(control.completedAt)}</small>}
                </div>
                <span className={`production-control-status ${control.status}`}>{control.status === "completed" ? <Check size={13} /> : control.status === "active" ? <Clock3 size={13} /> : null}{stateLabels[control.status]}</span>
                {control.status === "active" && <button className="production-control-cancel" type="button" onClick={() => void cancel(control)} aria-label={`Отменить задачу «${control.title}»`} title="Отменить задачу"><X size={15} /></button>}
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal open={modalOpen} onClose={() => !saving && setModalOpen(false)} title="Добавить задачу для сборщиков" description="Задача появится в окне упаковки Assembly для выбранной поставки или артикула.">
        <form className="production-control-form" onSubmit={(event) => void create(event)}>
          <div className="production-control-form-grid">
            <label><span>Задача</span><select value={kind} onChange={(event) => setKind(event.target.value as ControlKind)}><option value="quality_check">Проверка качества</option><option value="notification">Уведомление</option><option value="instruction">Инструкция</option></select></label>
            <label><span>Важность</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="attention">Особое внимание</option><option value="urgent">Срочно</option></select></label>
            <label><span>Для кого</span><select value={scope} onChange={(event) => setScope(event.target.value as "shipment" | "article")}><option value="shipment">Вся поставка</option><option value="article">Один артикул</option></select></label>
            {scope === "article" && <label><span>Артикул</span><select required value={article} onChange={(event) => setArticle(event.target.value)}>{articles.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
            <label className="wide"><span>Когда обратить внимание</span><select value={trigger} onChange={(event) => setTrigger(event.target.value as Trigger)}><option value="shipment_received">При поступлении поставки в Assembly</option><option value="before_packing">Перед упаковкой</option><option value="before_box_close">Перед закрытием короба</option></select></label>
            <label className="wide"><span>Короткое название</span><input required minLength={3} maxLength={90} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "quality_check" ? "Например, проверить комплектность" : kind === "notification" ? "Например, заказ срочный" : "Например, вложить вкладыш"} /></label>
            <label className="wide"><span>Комментарий для сборщиков <small>необязательно</small></span><textarea maxLength={320} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Уточните, на что обратить внимание" /></label>
          </div>
          <div className="production-control-form-footer"><span><ClipboardCheck size={15} /> Участок: Сборка · Упаковка</span><div><Button type="button" onClick={() => setModalOpen(false)} disabled={saving}>Отмена</Button><Button type="submit" kind="primary" disabled={saving || !activeShipmentIds.length}>{saving ? "Сохраняю…" : "Добавить задачу"}</Button></div></div>
        </form>
      </Modal>
    </>
  );
}
