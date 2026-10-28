import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, CheckCircle2, ClipboardCheck, Clock3, Flag, Plus, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { Button, Modal } from "./ui";

type ControlKind = "quality_check" | "notification" | "instruction";
type Priority = "attention" | "urgent";
type Trigger = "shipment_received" | "before_packing" | "before_box_close";
type ControlState = "active" | "completed" | "acknowledged" | "cancelled";
type Control = {
  id: string;
  shipmentId: string;
  shipmentIds?: string[];
  batchId?: string | null;
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

function articleKey(value: string) {
  return value.trim().toLocaleUpperCase("ru-RU").replace(/ё/g, "е");
}

function groupControls(controls: Control[]) {
  const groups = new Map<string, Control[]>();
  for (const control of controls) {
    const key = control.batchId || control.id;
    const group = groups.get(key) || [];
    group.push(control);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([id, items]) => ({ id, controls: items }));
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
  const [selectedArticles, setSelectedArticles] = useState<string[]>([]);
  const [articleSearch, setArticleSearch] = useState("");
  const [pasteWarning, setPasteWarning] = useState("");
  const [trigger, setTrigger] = useState<Trigger>("shipment_received");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const batchRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const uniqueArticles = useMemo(() => [...new Map(articles.map((value) => value.trim()).filter(Boolean).map((value) => [articleKey(value), value])).values()], [articles]);
  const articleLookup = useMemo(() => new Map(uniqueArticles.map((value) => [articleKey(value), value])), [uniqueArticles]);
  const filteredArticles = useMemo(() => {
    const query = articleKey(articleSearch);
    return uniqueArticles.filter((value) => !query || articleKey(value).includes(query));
  }, [articleSearch, uniqueArticles]);

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
    setSelectedArticles((current) => current.filter((value) => articleLookup.has(articleKey(value))));
  }, [articleLookup]);

  const toggleArticle = (value: string) => {
    setSelectedArticles((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : current.length < 40 ? [...current, value] : current);
    setPasteWarning("");
  };

  const pasteArticles = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text").trim();
    if (!pasted) return;
    const tokens = pasted.split(/[\s,;|]+/).filter(Boolean);
    const exact = tokens.map((token) => articleLookup.get(articleKey(token)) || "");
    if (tokens.length === 1 && !exact[0]) {
      event.preventDefault();
      setArticleSearch(pasted);
      setPasteWarning(`Артикул «${tokens[0]}» не найден в этой поставке.`);
      return;
    }
    event.preventDefault();
    const found = exact.filter(Boolean);
    const missing = tokens.filter((_, index) => !exact[index]);
    const merged = [...new Set([...selectedArticles, ...found])];
    setSelectedArticles(merged.slice(0, 40));
    setArticleSearch("");
    const warnings = [
      missing.length ? `Не найдены в поставке: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}` : "",
      merged.length > 40 ? "За один раз можно выбрать не более 40 артикулов." : "",
    ].filter(Boolean);
    setPasteWarning(warnings.join(" "));
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeShipmentIds.length || saving) return;
    if (scope === "article" && !selectedArticles.length) {
      setPasteWarning("Найдите и выберите хотя бы один артикул.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const fingerprint = JSON.stringify({
        shipmentIds: activeShipmentIds,
        shipmentName,
        scope,
        articles: scope === "article" ? selectedArticles : [],
        kind,
        priority,
        trigger,
        title: title.trim(),
        note: note.trim(),
      });
      if (batchRequest.current?.fingerprint !== fingerprint) {
        batchRequest.current = { fingerprint, id: crypto.randomUUID() };
      }
      const requestId = batchRequest.current.id;
      await request("/api/production-controls", {
        method: "POST",
        body: JSON.stringify({
          action: scope === "article" ? "create-batch" : "create",
          requestId,
          shipmentId: activeShipmentIds[0],
          shipmentIds: activeShipmentIds,
          shipmentName,
          scope,
          ...(scope === "article" ? { articles: selectedArticles } : {}),
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
      setSelectedArticles([]);
      setArticleSearch("");
      setPasteWarning("");
      batchRequest.current = null;
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
      await request("/api/production-controls", {
        method: "POST",
        body: JSON.stringify(control.batchId
          ? { action: "cancel-batch", batchId: control.batchId }
          : { action: "cancel", controlId: control.id }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отменить задачу.");
    }
  };

  const visibleControls = controls.filter((control) => (control.shipmentIds || [control.shipmentId]).some((id) => activeShipmentIds.includes(id)));
  const activeCount = visibleControls.filter((control) => control.status === "active").length;
  const visibleGroups = groupControls(visibleControls);
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
            {visibleGroups.map(({ id, controls: group }) => {
              const control = group[0];
              const active = group.filter((item) => item.status === "active").length;
              const completed = group.filter((item) => item.status === "completed" || item.status === "acknowledged").length;
              const cancelled = group.filter((item) => item.status === "cancelled").length;
              const groupStatus = group.length === 1
                ? control.status
                : active
                  ? "active"
                  : cancelled === group.length
                    ? "cancelled"
                    : "completed";
              const groupStatusLabel = group.length === 1
                ? stateLabels[control.status]
                : active
                  ? `Активны ${active} из ${group.length}`
                  : cancelled === group.length
                    ? "Отменено"
                    : cancelled
                      ? `Выполнено ${completed} · отменено ${cancelled}`
                      : `Выполнено ${completed} из ${group.length}`;
              const articleList = group.map((item) => item.article).filter(Boolean);
              return (
                <article className={`production-control-row ${control.priority === "urgent" ? "is-urgent" : ""} ${groupStatus !== "active" ? "is-finished" : ""}`} key={id}>
                  <span className="production-control-kind-icon" aria-hidden="true">{control.kind === "notification" ? <Bell size={17} /> : control.priority === "urgent" ? <TriangleAlert size={17} /> : <Flag size={17} />}</span>
                  <div className="production-control-copy">
                    <div className="production-control-title-line"><strong>{control.title}</strong><span className={`production-control-priority ${control.priority}`}>{control.priority === "urgent" ? "Срочно" : "Внимание"}</span></div>
                    <div className="production-control-meta">
                      <span>{kindLabels[control.kind]}</span>
                      <span>{control.scope === "article" ? (articleList.length > 1 ? `Артикулы · ${articleList.length}` : articleList[0] || control.article) : "Вся поставка"}</span>
                      <span>{triggerLabels[control.trigger]}</span>
                    </div>
                    {articleList.length > 1 && <div className="production-control-article-list">{articleList.map((value) => <span key={value}>{value}</span>)}</div>}
                    {control.note && <p>{control.note}</p>}
                    {completed > 0 && group.some((item) => item.completedBy) && <small className="production-control-proof">Отмечено: {completed} из {group.length}</small>}
                  </div>
                  <span className={`production-control-status ${groupStatus}`}>{groupStatus === "completed" ? <Check size={13} /> : groupStatus === "active" ? <Clock3 size={13} /> : null}{groupStatusLabel}</span>
                  {active > 0 && <button className="production-control-cancel" type="button" onClick={() => void cancel(control)} aria-label={`Отменить задачу «${control.title}»`} title={control.batchId ? "Отменить задачу для всех выбранных артикулов" : "Отменить задачу"}><X size={15} /></button>}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Modal open={modalOpen} onClose={() => !saving && setModalOpen(false)} title="Добавить задачу для сборщиков" description="Задача появится в окне упаковки Assembly для выбранной поставки или артикула.">
        <form className="production-control-form" onSubmit={(event) => void create(event)}>
          <div className="production-control-form-grid">
            <label><span>Задача</span><select value={kind} onChange={(event) => setKind(event.target.value as ControlKind)}><option value="quality_check">Проверка качества</option><option value="notification">Уведомление</option><option value="instruction">Инструкция</option></select></label>
            <label><span>Важность</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="attention">Особое внимание</option><option value="urgent">Срочно</option></select></label>
            <label><span>Для кого</span><select value={scope} onChange={(event) => setScope(event.target.value as "shipment" | "article")}><option value="shipment">Вся поставка</option><option value="article">Выбранные артикулы</option></select></label>
            {scope === "article" && (
              <label className="wide"><span>Артикулы <small>найдите или вставьте список</small></span>
                <div className="production-control-article-picker">
                  <div className="production-control-article-search">
                    <Search size={17} aria-hidden="true" />
                    <input
                      type="search"
                      value={articleSearch}
                      onChange={(event) => { setArticleSearch(event.target.value); setPasteWarning(""); }}
                      onPaste={pasteArticles}
                      placeholder="Поиск или вставьте артикулы через пробел / с новой строки"
                      aria-label="Найти артикул в поставке"
                      autoComplete="off"
                    />
                    {articleSearch && <button type="button" aria-label="Очистить поиск" onClick={() => setArticleSearch("")}><X size={15} /></button>}
                  </div>
                  {!!selectedArticles.length && <div className="production-control-selected-articles" aria-label={`Выбрано артикулов: ${selectedArticles.length}`}>
                    {selectedArticles.map((value) => <span key={value}>{value}<button type="button" aria-label={`Убрать ${value}`} onClick={() => toggleArticle(value)}><X size={13} /></button></span>)}
                  </div>}
                  <div className="production-control-article-results" role="group" aria-label="Артикулы поставки">
                    <div className="production-control-article-results-head"><small>{filteredArticles.length ? `${filteredArticles.length} в списке` : "Совпадений нет"}</small><button type="button" disabled={!filteredArticles.length || selectedArticles.length + filteredArticles.filter((value) => !selectedArticles.includes(value)).length > 40} onClick={() => setSelectedArticles((current) => [...new Set([...current, ...filteredArticles])])}>Выбрать найденные</button></div>
                    {filteredArticles.slice(0, 80).map((value) => {
                      const selected = selectedArticles.includes(value);
                      return <button className={`production-control-article-option ${selected ? "selected" : ""}`} type="button" key={value} aria-pressed={selected} onClick={() => toggleArticle(value)} disabled={!selected && selectedArticles.length >= 40}>
                        <span>{selected ? <CheckCircle2 size={16} /> : <span className="production-control-article-checkbox" />}</span>{value}
                      </button>;
                    })}
                    {filteredArticles.length > 80 && <small className="production-control-article-limit">Показаны первые 80. Уточните поиск.</small>}
                  </div>
                  {pasteWarning && <small className="production-control-paste-warning" role="status">{pasteWarning}</small>}
                  <small className="production-control-article-hint">Выбрано {selectedArticles.length}. Можно отметить несколько; сборщик подтвердит задачу отдельно по каждому артикулу. До 40 за раз.</small>
                </div>
              </label>
            )}
            <label className="wide"><span>Когда обратить внимание</span><select value={trigger} onChange={(event) => setTrigger(event.target.value as Trigger)}><option value="shipment_received">При поступлении поставки в Assembly</option><option value="before_packing">Перед упаковкой</option><option value="before_box_close">Перед закрытием короба</option></select></label>
            <label className="wide"><span>Короткое название</span><input required minLength={3} maxLength={90} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "quality_check" ? "Например, проверить комплектность" : kind === "notification" ? "Например, заказ срочный" : "Например, вложить вкладыш"} /></label>
            <label className="wide"><span>Комментарий для сборщиков <small>необязательно</small></span><textarea maxLength={320} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Уточните, на что обратить внимание" /></label>
          </div>
          <div className="production-control-form-footer"><span><ClipboardCheck size={15} /> Участок: Сборка · Упаковка</span><div><Button type="button" onClick={() => setModalOpen(false)} disabled={saving}>Отмена</Button><Button type="submit" kind="primary" disabled={saving || !activeShipmentIds.length || (scope === "article" && !selectedArticles.length)}>{saving ? "Сохраняю…" : scope === "article" ? `Добавить задачу · ${selectedArticles.length || 0}` : "Добавить задачу"}</Button></div></div>
        </form>
      </Modal>
    </>
  );
}
