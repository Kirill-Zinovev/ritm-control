import { useEffect, useRef, useState } from "react";
import { Button, Empty, Field, Modal, Notice } from "./ui";
import { ArrowSquareOut, Users, X } from "./icons";
import { num } from "./model";
import "./assemblyTransfer.css";

type Department = "roll" | "box";
type SourceGroup = {
  department: Department;
  name: string;
  sheets: { sheetId: number; name: string }[];
};
type Item = {
  key: string;
  sku: string;
  row: number;
  quantity: number | null;
  issue?: string | null;
  department?: Department;
};
type Source = {
  department: Department;
  sheetId: number;
  name: string;
  fingerprint: string;
  managed: boolean;
  items: Item[];
};
type Preview = {
  id: string;
  name: string;
  destinationName: string | null;
  managed: boolean;
  rows: number;
  quantity: number;
  items: Item[];
};
type Operation = {
  id: string;
  name: string;
  status: "pending" | "delivered" | "conflict";
  attempts: number;
  receipt?: {
    name: string;
    added: number | null;
    existing: number | null;
    message: string;
  } | null;
};
const storageKey = "ritm.assembly-transfer.operation";
const assemblyUrl = import.meta.env.VITE_ASSEMBLY_WEB_APP_URL || "";
async function responseJson(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Передача в сборку ещё не подключена к этому экземпляру RITM.",
    );
  const value = await response.json();
  if (!response.ok || !value.ok)
    throw Object.assign(
      new Error(
        response.status === 401
          ? "Войдите в AI Center как владелец, затем откройте передачу снова."
          : value.message || "Не удалось подготовить передачу.",
      ),
      { status: response.status },
    );
  return value;
}
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Не удалось выполнить действие. Повторите проверку.";
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(storageKey, id);
    else localStorage.removeItem(storageKey);
  } catch {
    /* Storage is optional; the server owns the operation. */
  }
};

export function AssemblyTransfer({ onDelivered }: { onDelivered?: () => void }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<SourceGroup[]>([]);
  const [department, setDepartment] = useState<Department>("roll");
  const [sheetId, setSheetId] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [loading, setLoading] = useState(false);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [missingOperation, setMissingOperation] = useState(false);
  const operationId = useRef("");
  const loadedSource = useRef("");
  const searchInput = useRef<HTMLInputElement>(null);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const lastNotifiedOperation = useRef("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && (preview || operation)) stageHeading.current?.focus();
  }, [open, preview?.id, operation?.status]);

  const checkOperation = async (id: string) => {
    const value = await responseJson(
      await fetch(
        "/api/assembly-transfers/operation?id=" + encodeURIComponent(id),
        { cache: "no-store", credentials: "same-origin" },
      ),
    );
    if (mounted.current && operationId.current === id) {
      setOperation(value.operation);
      setError("");
      setMissingOperation(false);
      if (
        value.operation.status === "delivered" &&
        lastNotifiedOperation.current !== id
      ) {
        lastNotifiedOperation.current = id;
        onDelivered?.();
      }
    }
    return value.operation as Operation;
  };
  useEffect(() => {
    if (!open || operation) return;
    let id = "";
    try {
      id = localStorage.getItem(storageKey) || "";
    } catch {
      /* Optional recovery. */
    }
    if (/^[a-f0-9-]{36}$/i.test(id)) {
      operationId.current = id;
      setOperation({
        id,
        name: "Передача в сборку",
        status: "pending",
        attempts: 0,
      });
    }
  }, [open, operation]);
  useEffect(() => {
    if (operation?.status !== "pending" || busy) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await checkOperation(operation.id);
      } catch (cause) {
        if (active) {
          setError(message(cause));
          setMissingOperation(
            typeof cause === "object" &&
              cause !== null &&
              "status" in cause &&
              cause.status === 404,
          );
        }
      }
      if (active) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [operation?.id, operation?.status, busy]);

  useEffect(() => {
    if (!open || operation) return;
    const controller = new AbortController();
    let active = true;
    setSourcesLoading(true);
    setSourcesError("");
    void fetch("/api/assembly-transfers/sources", {
      cache: "no-store",
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then(responseJson)
      .then((value) => {
        if (active) setSources(value.sources);
      })
      .catch((cause) => {
        if (active) setSourcesError(message(cause));
      })
      .finally(() => {
        if (active) setSourcesLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, retry, operation?.id]);
  useEffect(() => {
    if (!open || operation) return;
    const key = `${department}:${sheetId}:${retry}`;
    if (source && loadedSource.current === key) return;
    setSource(null);
    setPreview(null);
    setSelected(new Set());
    setSearch("");
    if (!sheetId) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    void fetch(
      `/api/assembly-transfers/source?department=${department}&sheetId=${sheetId}`,
      {
        cache: "no-store",
        signal: controller.signal,
        credentials: "same-origin",
      },
    )
      .then(responseJson)
      .then((value) => {
        if (!active) return;
        loadedSource.current = key;
        setSource(value.source);
        setSelected(
          new Set(
            value.source.items
              .filter((item: Item) => !item.issue)
              .map((item: Item) => item.key),
          ),
        );
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, department, sheetId, retry, operation?.id]);

  const prepare = async () => {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      const value = await responseJson(
        await fetch("/api/assembly-transfers/preview", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            department: source.department,
            sheetId: source.sheetId,
            fingerprint: source.fingerprint,
            keys: [...selected],
            ...(matchingRollTarget
              ? { targetRollSheetId: matchingRollTarget.sheetId }
              : {}),
          }),
        }),
      );
      setPreview(value.preview);
      operationId.current = crypto.randomUUID();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!preview) return;
    const id = operationId.current;
    setBusy(true);
    setError("");
    setMissingOperation(false);
    remember(id);
    setOperation({ id, name: preview.name, status: "pending", attempts: 0 });
    try {
      const response = await fetch("/api/assembly-transfers", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: id,
          previewId: preview.id,
          explicitTransferApproval: true,
        }),
      });
      const value = await responseJson(response);
      setOperation(value.operation);
      if (
        value.operation.status === "delivered" &&
        lastNotifiedOperation.current !== id
      ) {
        lastNotifiedOperation.current = id;
        onDelivered?.();
      }
    } catch (cause) {
      setError(message(cause));
      if (typeof cause === "object" && cause && "status" in cause) {
        remember(null);
        setOperation(null);
      }
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    remember(null);
    setOperation(null);
    setPreview(null);
    setSheetId("");
    setSource(null);
    setError("");
    setMissingOperation(false);
    operationId.current = "";
    loadedSource.current = "";
  };
  const items = source?.items || [];
  const visible = items.filter((item) =>
    item.sku
      .toLocaleLowerCase("ru-RU")
      .includes(search.trim().toLocaleLowerCase("ru-RU")),
  );
  const selectionCount = items.filter((item) => selected.has(item.key)).length;
  const matchingRollTarget =
    source?.department === "box" && !source.managed
      ? sources
          .find((group) => group.department === "roll")
          ?.sheets.find((sheet) => sheet.name === source.name) || null
      : null;
  return (
    <>
      <Button
        onClick={(event) => {
          trigger.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <Users size={17} />
        {operation?.status === "pending"
          ? "Передача в сборку…"
          : "Передать в сборку"}
      </Button>
      <Modal
        open={open}
        onCloseAutoFocus={() => trigger.current?.focus()}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Передать в сборку"
        description="Выберите товары из существующего листа печати. Запись выполняется только в Assembly."
      >
        <div className="assembly-transfer">
          {(error || sourcesError) && (
            <div className="supply-operation-error" role="alert">
              {error || sourcesError}
            </div>
          )}
          {operation ? (
            <>
              <Notice
                tone={operation.status === "conflict" ? "warning" : "info"}
              >
                {operation.status === "delivered"
                  ? "Состав подтверждён в Assembly"
                  : operation.status === "conflict"
                    ? "Передача остановлена: источник изменился"
                    : "Передача в Assembly выполняется"}
              </Notice>
              <h3 ref={stageHeading} tabIndex={-1}>
                {operation.receipt?.name || operation.name}
              </h3>
              {operation.status === "pending" && (
                <p>
                  Дождитесь подтверждения сборки. При временной ошибке связь
                  восстановится автоматически. Окно можно закрыть — операция
                  сохранена.
                </p>
              )}
              {operation.status === "delivered" && (
                <p role="status">
                  Добавлено позиций:{" "}
                  <strong>
                    {operation.receipt?.added == null
                      ? "не подтверждено"
                      : num(operation.receipt.added)}
                  </strong>
                  . Уже были в составе:{" "}
                  <strong>
                    {operation.receipt?.existing == null
                      ? "не подтверждено"
                      : num(operation.receipt.existing)}
                  </strong>
                  . Записанная работа сборщиков сохранена.
                </p>
              )}
              {operation.status === "conflict" && (
                <p>
                  {operation.receipt?.message ||
                    "Загрузите свежий состав и проверьте позиции заново."}
                </p>
              )}
              <div className="form-actions">
                {operation.status === "pending" ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void checkOperation(operation.id).catch((cause) =>
                        setError(message(cause)),
                      )
                    }
                  >
                    Проверить статус
                  </Button>
                ) : (
                  <Button disabled={busy} onClick={reset}>
                    Новая передача
                  </Button>
                )}
                <a
                  className="button secondary"
                  href={assemblyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ArrowSquareOut size={17} />
                  Открыть Assembly
                </a>
              </div>
              {missingOperation && !busy && (
                <Button onClick={reset}>Выбрать состав заново</Button>
              )}
            </>
          ) : preview ? (
            <>
              <Notice>Состав проверен по исходным таблицам</Notice>
              <div className="assembly-transfer-review">
                <h3 ref={stageHeading} tabIndex={-1}>
                  {preview.name}
                </h3>
                <span>
                  Позиций: {num(preview.rows)} · План: {num(preview.quantity)}{" "}
                  шт.
                </span>
              </div>
              <p>
                {preview.destinationName && !preview.managed
                  ? `Позиции бокса будут добавлены к существующей поставке «${preview.destinationName}» в Assembly.`
                  : preview.managed
                  ? "Будет обновлён полный состав общей поставки обоих участков."
                  : "Выбранные товары попадут в отдельную поставку Assembly."}{" "}
                Повторные позиции не создадут дубли.
              </p>
              <div className="assembly-transfer-table">
                <table>
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Участок</th>
                      <th>Количество, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item, index) => (
                      <tr key={`${item.department}:${item.row}:${index}`}>
                        <td>{item.sku}</td>
                        <td>
                          {item.department === "box"
                            ? "Бокс"
                            : "Рулонная печать"}
                        </td>
                        <td>{num(item.quantity ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <Button disabled={busy} onClick={() => setPreview(null)}>
                  Изменить выбор
                </Button>
                <Button
                  kind="primary"
                  disabled={busy}
                  onClick={() => void submit()}
                >
                  {busy ? "Подтверждаю…" : "Передать только в сборку"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="assembly-transfer-source">
                <Field label="Участок">
                  <select
                    value={department}
                    disabled={busy}
                    onChange={(event) => {
                      setDepartment(event.target.value as Department);
                      setSheetId("");
                    }}
                  >
                    <option value="roll">Рулонная печать</option>
                    <option value="box">Бокс</option>
                  </select>
                </Field>
                <Field label="Существующий лист">
                  <select
                    value={sheetId}
                    disabled={sourcesLoading || busy || !sources.length}
                    onChange={(event) => setSheetId(event.target.value)}
                  >
                    <option value="">Выберите лист</option>
                    {sources
                      .find((group) => group.department === department)
                      ?.sheets.map((sheet) => (
                        <option key={sheet.sheetId} value={sheet.sheetId}>
                          {sheet.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              {loading || sourcesLoading ? (
                <p role="status">Читаю существующие листы и позиции…</p>
              ) : source ? (
                <>
                  {source.managed && (
                    <Notice>
                      Это общая поставка RITM. Она передаётся целиком, с
                      подтверждённым составом всех связанных участков.
                    </Notice>
                  )}
                  <div className="assembly-transfer-filter">
                    <input
                      ref={searchInput}
                      type="search"
                      aria-label="Поиск артикула для передачи"
                      placeholder="Найти артикул"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {search && (
                      <Button
                        aria-label="Очистить поиск артикула"
                        onClick={() => {
                          setSearch("");
                          searchInput.current?.focus();
                        }}
                      >
                        <X size={16} />
                      </Button>
                    )}
                    <span>
                      {num(selectionCount)} из {num(items.length)} выбрано
                    </span>
                  </div>
                  {!source.managed && (
                    <div className="assembly-transfer-selection">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          setSelected(
                            new Set(
                              items
                                .filter((item) => !item.issue)
                                .map((item) => item.key),
                            ),
                          )
                        }
                      >
                        Выбрать все доступные
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => setSelected(new Set())}
                      >
                        Снять выбор
                      </Button>
                    </div>
                  )}
                  <div className="assembly-transfer-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Передать</th>
                          <th>Артикул</th>
                          <th>Строка</th>
                          <th>Количество, шт.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((item) => (
                          <tr key={item.key}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Передать ${item.sku}, строка ${item.row}`}
                                checked={selected.has(item.key)}
                                disabled={
                                  busy || !!item.issue || source.managed
                                }
                                onChange={(event) =>
                                  setSelected((previous) => {
                                    const next = new Set(previous);
                                    if (event.target.checked)
                                      next.add(item.key);
                                    else next.delete(item.key);
                                    return next;
                                  })
                                }
                              />
                            </td>
                            <td>
                              {item.sku}
                              {item.issue && (
                                <small className="error-text">
                                  {item.issue}
                                </small>
                              )}
                            </td>
                            <td>{item.row}</td>
                            <td>
                              {item.quantity === null
                                ? "Не определено"
                                : num(item.quantity)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {visible.length === 0 && (
                      <Empty
                        title={
                          items.length
                            ? "Артикул не найден"
                            : "В листе нет товаров"
                        }
                      >
                        Выберите другой лист или измените поиск.
                      </Empty>
                    )}
                  </div>
                  <div className="form-actions">
                    <Button
                      disabled={busy}
                      onClick={() => setRetry((n) => n + 1)}
                    >
                      Обновить позиции
                    </Button>
                    <Button
                      kind="primary"
                      disabled={
                        busy ||
                        !selectionCount ||
                        selectionCount > 500 ||
                        (source.managed && items.some((item) => item.issue))
                      }
                      onClick={() => void prepare()}
                    >
                      {busy ? "Проверяю состав…" : "Проверить передачу"}
                    </Button>
                  </div>
                  {selectionCount > 500 && (
                    <p role="alert" className="error-text">
                      За одну передачу можно выбрать до 500 позиций.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {!sources.length && !error && !sourcesError && (
                    <Empty title="Рабочие листы не найдены">
                      Нужен существующий лист с колонками «Артикул» и «Кол-во».
                    </Empty>
                  )}
                  {(error || sourcesError) && (
                    <Button onClick={() => setRetry((n) => n + 1)}>
                      Повторить загрузку
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
