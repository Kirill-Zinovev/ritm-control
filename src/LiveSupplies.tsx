import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  Package,
  Plus,
  Printer,
  Scissors,
  Trash,
  Truck,
  UploadSimple,
  Warning,
} from "./icons";
import { num, validateSupply } from "./model";
import type { LiveOrder, LivePrinting } from "./livePrinting";
import {
  completeTotal,
  observedTotal,
  rollCut,
  rollPrinted,
  rollPrintRemaining,
} from "./liveSupplyProgress";
import { Button, DataTable, Empty, Field, Modal, Progress } from "./ui";
import {
  createSupplyWorkbook,
  createSupplyTemplate,
  parseSupplyWorkbook,
  saveSupplyWorkbook,
  saveSupplyTemplate,
  type SupplyImportLine,
} from "./supplySpreadsheet";

type SupplySheet = LivePrinting["sheets"][number];
type SheetSummary = {
  sheet: SupplySheet;
  orders: LiveOrder[];
  planned: number;
  plannedArea: number;
  printed: number | null;
  cut: number | null;
  cutObservedOrders: number;
  cutMissingOrders: number;
  remainingPrint: number | null;
};
type WriterState = {
  available: boolean;
  reason: string | null;
  busy?: boolean;
  template?: { sheetId: number; name: string };
  registeredSheets?: { gid: number; name: string }[];
  sheetSync?: {
    status: string;
    checkedAt?: string | null;
    removed?: string[];
    renamed?: { from: string; to: string; gid: number }[];
    error?: string;
    refreshError?: string;
  };
  operations?: Operation[];
};
type Operation = {
  id: string;
  action: "create" | "append" | "delete";
  status: string;
  name: string;
  sheetId: number | null;
  rows: number;
  message: string | null;
  calculations?: { cell: string; error: string }[];
  spreadsheetUrl: string;
};
type Props = {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
};

function buildSummaries(live: LivePrinting | null): SheetSummary[] {
  if (!live) return [];
  return live.sheets
    .filter((sheet) => sheet.sourceId === "roll-printing")
    .map((sheet) => {
      const orders = live.supplies.filter(
        (order) =>
          order.sheetId === sheet.sheetId &&
          (!order.sourceId || order.sourceId === sheet.sourceId),
      );
      const cut = observedTotal(orders.map(rollCut));
      return {
        sheet,
        orders,
        planned: orders.reduce((sum, order) => sum + order.quantity, 0),
        plannedArea: orders.reduce((sum, order) => sum + order.plannedArea, 0),
        printed: completeTotal(orders.map(rollPrinted)),
        cut: cut.total,
        cutObservedOrders: cut.observed,
        cutMissingOrders: cut.missing,
        remainingPrint: completeTotal(orders.map(rollPrintRemaining)),
      };
    });
}

function editableLines(text: string): SupplyImportLine[] {
  const parsed = validateSupply("Поставка", "2026-01-02", "2026-01-01", text);
  if (parsed.errors.lines || !parsed.lines.length)
    throw new Error(
      parsed.errors.lines || "Добавьте хотя бы один артикул и количество.",
    );
  return parsed.lines.map((line) => ({
    article: line.article,
    quantity: line.plan,
  }));
}

function supplyOperationStatus(operation: Operation) {
  if (operation.action === "delete") {
    if (operation.status === "writing") return "Удаляю лист поставки";
    if (operation.status === "checking") return "Проверяю удаление листа";
    if (operation.status === "verified") return "Поставка и лист удалены";
    if (operation.status === "uncertain")
      return "Результат удаления неизвестен — повтор запрещён";
    if (operation.status === "written_unverified")
      return "Удаление отправлено, проверка не завершена";
    if (operation.status === "failed") return "Удаление не выполнено";
  }
  if (operation.status === "writing")
    return operation.action === "append"
      ? "Добавляю товары в поставку"
      : "Создаю лист и записываю состав";
  if (operation.status === "verified")
    return operation.action === "append"
      ? "Товары добавлены и проверены"
      : "Лист создан и проверен";
  if (operation.status === "verified_with_calculation_errors")
    return "Состав записан; формулы требуют проверки";
  if (operation.status === "written_unverified")
    return "Записано, проверка не завершена";
  if (operation.status === "uncertain")
    return "Результат записи неизвестен — повтор запрещён";
  if (operation.status === "failed") return "Операция отклонена";
  if (operation.status === "checking") return "Проверяю запись и формулы";
  return "Записываю в Google Sheets";
}

async function readRollSupplyResponse(response: Response) {
  const isJson = response.headers
    .get("content-type")
    ?.toLocaleLowerCase("en-US")
    .includes("application/json");
  if (!isJson)
    throw new Error(
      "Этот экземпляр агента пока не подключён к управлению поставками. Данные доступны для просмотра; таблица не изменена.",
    );
  const value = await response.json();
  if (!response.ok || !value.ok)
    throw new Error(
      response.status === 401
        ? "Войдите в AI Center как владелец, чтобы управлять поставками."
        : value.reason ||
            value.message ||
            "Основной агент отклонил операцию с поставкой.",
    );
  return value;
}

function ExcelItemsField({
  value,
  onChange,
  error,
  fileName,
  onFile,
  importing,
  onTemplate,
  downloading,
  onExport,
  exporting,
  canExport,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  fileName: string;
  onFile: (file: File | null) => void;
  importing: boolean;
  onTemplate: () => void;
  downloading: boolean;
  onExport: () => void;
  exporting: boolean;
  canExport: boolean;
  readOnly: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor="supply-items">
        Артикулы и количество · одна строка на товар
      </label>
      <div className="supply-items-editor">
        <div className="supply-items-tools">
          <label
            className={`button secondary supply-file-picker ${readOnly ? "disabled" : ""}`}
          >
            <UploadSimple size={17} />
            {importing ? "Читаю Excel…" : "Загрузить Excel"}
            <input
              aria-label="Загрузить Excel со списком товаров"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={importing || exporting || downloading || readOnly}
              onChange={(event) => {
                onFile(event.currentTarget.files?.[0] || null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <Button
            type="button"
            disabled={exporting || downloading || readOnly || !canExport}
            onClick={onExport}
          >
            <DownloadSimple size={17} />
            {exporting ? "Готовлю Excel…" : "Выгрузить список"}
          </Button>
          <Button
            type="button"
            disabled={downloading || exporting || readOnly}
            onClick={onTemplate}
          >
            <DownloadSimple size={17} />
            {downloading ? "Готовлю шаблон…" : "Скачать шаблон"}
          </Button>
          <span className="supply-file-help">
            .xlsx · до 2 МБ · до 500 товаров
          </span>
        </div>
        {fileName && (
          <div className="supply-file-name" role="status">
            <CheckCircle size={16} />
            <span>{fileName}</span>
          </div>
        )}
        <textarea
          id="supply-items"
          className="resize-none"
          rows={5}
          style={{ resize: "none" }}
          value={value}
          aria-invalid={!!error}
          aria-describedby={error ? "supply-items-error" : undefined}
          readOnly={readOnly}
          placeholder={"ST0021.A7447; 500\nST0043.A2180; 300"}
          onChange={(event) => onChange(event.target.value)}
        />
        <small className="supply-items-note">
          Можно загрузить Excel или вставить строки в поле. Перед записью
          проверьте состав.
        </small>
      </div>
      {error && (
        <small id="supply-items-error" className="error-text" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export function LiveSuppliesWorkspace({
  live,
  loading,
  error,
  onRefresh,
}: Props) {
  const [writer, setWriter] = useState<WriterState | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"create" | "append" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    sheetId: number;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [name, setName] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [fileName, setFileName] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationId = useRef("");
  const summaries = useMemo(() => buildSummaries(live), [live]);
  const visible = summaries.filter((summary) =>
    (
      summary.sheet.name +
      " " +
      summary.orders.map((line) => line.article).join(" ")
    )
      .toLocaleLowerCase("ru-RU")
      .includes(search.trim().toLocaleLowerCase("ru-RU")),
  );
  const selected =
    visible.find((summary) => summary.sheet.sheetId === selectedId) ||
    visible[0] ||
    null;
  const canWrite =
    !!writer?.available &&
    !!live &&
    !live.stale &&
    live.quality?.status !== "partial" &&
    !error &&
    !loading &&
    !busy &&
    !writer.busy;
  const writeBlockedReason = !writer?.available
    ? writer?.reason || "Проверьте доступ к управлению поставками"
    : !live || live.stale
      ? "Сначала дождитесь свежей загрузки источника"
      : live.quality?.status === "partial"
        ? "В обновлённых данных есть строки с ошибками; проверьте журнал"
        : error || loading || busy || writer.busy
          ? "Дождитесь завершения обновления"
          : undefined;
  const canDeleteSelected =
    !!writer?.available &&
    !writer.busy &&
    !busy &&
    !!selected &&
    selected.sheet.sheetId !== writer?.template?.sheetId;

  const checkOperation = async (id: string) => {
    try {
      const response = await fetch("/api/roll-supplies/status", {
        cache: "no-store",
      });
      const value = await readRollSupplyResponse(response);
      setWriter(value);
      if (
        value.sheetSync?.status === "updated" ||
        value.sheetSync?.removed?.length ||
        value.sheetSync?.renamed?.length
      )
        await onRefresh();
      const current = (value.operations || []).find(
        (item: Operation) => item.id === id,
      );
      if (current) {
        setOperation(current);
        setNotice(supplyOperationStatus(current));
        setFormError("");
      } else if (value.busy) {
        setNotice(
          "Подготовка ещё выполняется. Повторная отправка заблокирована.",
        );
      } else {
        operationId.current = crypto.randomUUID();
        setOperation(null);
        setNotice(
          "Операция не была зарегистрирована. Состав можно проверить и подтвердить заново.",
        );
      }
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить состояние операции.",
      );
    }
  };

  const reloadWriter = async () => {
    try {
      const response = await fetch("/api/roll-supplies/status", {
        cache: "no-store",
      });
      const value = await readRollSupplyResponse(response);
      setWriter(value);
      if (
        value.sheetSync?.status === "updated" ||
        value.sheetSync?.removed?.length ||
        value.sheetSync?.renamed?.length
      )
        void onRefresh();
    } catch (cause) {
      const unavailable = {
        available: false,
        reason:
          cause instanceof Error
            ? cause.message
            : "Не удалось проверить разрешение на запись.",
      };
      setWriter(unavailable);
    }
  };

  useEffect(() => {
    void reloadWriter();
    const timer = window.setInterval(() => void reloadWriter(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const openDialog = (mode: "create" | "append") => {
    setDialog(mode);
    setName(mode === "append" ? selected?.sheet.name || "" : "");
    setItemsText("");
    setFileName("");
    setFormError("");
    setNotice("");
    setOperation(null);
    operationId.current = crypto.randomUUID();
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    setFormError("");
    try {
      if (!file.name.toLocaleLowerCase("ru-RU").endsWith(".xlsx"))
        throw new Error("Выберите файл Excel в формате .xlsx.");
      const lines = await parseSupplyWorkbook(await file.arrayBuffer());
      setItemsText(
        lines.map((line) => `${line.article}; ${line.quantity}`).join("\n"),
      );
      setFileName(file.name);
    } catch (cause) {
      setFormError(
        cause instanceof Error ? cause.message : "Не удалось прочитать файл.",
      );
    } finally {
      setImporting(false);
    }
  };

  const onTemplate = async () => {
    setDownloading(true);
    setFormError("");
    try {
      saveSupplyTemplate(await createSupplyTemplate());
    } catch {
      setFormError("Не удалось подготовить Excel-шаблон. Повторите попытку.");
    } finally {
      setDownloading(false);
    }
  };

  const onExport = async () => {
    setExporting(true);
    setFormError("");
    try {
      const lines = editableLines(itemsText);
      const bytes = await createSupplyWorkbook(lines);
      const filename =
        dialog === "append" ? selected?.sheet.name || "Состав_поставки" : name;
      saveSupplyWorkbook(bytes, filename);
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Не удалось выгрузить состав в Excel.",
      );
    } finally {
      setExporting(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dialog || (!selected && dialog === "append")) return;
    if (!canWrite) {
      setFormError(
        writer?.reason || "Запись недоступна до проверки источника.",
      );
      return;
    }
    if (operation?.status === "failed") {
      operationId.current = crypto.randomUUID();
      setOperation(null);
    }
    if (dialog === "create" && !name.trim()) {
      setFormError("Укажите название новой поставки.");
      return;
    }
    if (dialog === "create" && /[:\\/?*\[\]]/.test(name.trim())) {
      setFormError("В названии листа нельзя использовать символы : / ? * [ ].");
      return;
    }
    let lines: SupplyImportLine[];
    try {
      lines = editableLines(itemsText);
    } catch (cause) {
      setFormError(
        cause instanceof Error ? cause.message : "Проверьте список товаров.",
      );
      return;
    }
    setBusy(true);
    setFormError("");
    setNotice("");
    const pendingOperation: Operation = {
      id: operationId.current,
      status: "writing",
      action: dialog,
      name: dialog === "append" ? selected!.sheet.name : name.trim(),
      sheetId: dialog === "append" ? selected!.sheet.sheetId : null,
      rows: lines.length,
      message: null,
      spreadsheetUrl: "",
    };
    setOperation(pendingOperation);
    setNotice(supplyOperationStatus(pendingOperation));
    let polling = true;
    const pollTask = (async () => {
      while (polling) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        if (!polling) break;
        await checkOperation(operationId.current);
      }
    })();
    try {
      const payload = {
        action: dialog,
        explicitWriteApproval: true,
        operationId: operationId.current,
        name: dialog === "append" ? selected!.sheet.name : name.trim(),
        lines,
        ...(dialog === "append" ? { sheetId: selected!.sheet.sheetId } : {}),
      };
      const response = await fetch("/api/roll-supplies", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(240000),
      });
      const data = await readRollSupplyResponse(response);
      const result = data.operation as Operation;
      setOperation(result);
      setNotice(supplyOperationStatus(result));
      if (
        result.status === "verified" ||
        result.status === "verified_with_calculation_errors"
      ) {
        await reloadWriter();
        await onRefresh();
        if (result.sheetId) setSelectedId(result.sheetId);
        if (result.status === "verified") {
          setDialog(null);
          setNotice("");
        }
      }
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Результат операции неизвестен. Проверьте историю и лист перед повтором.",
      );
      await checkOperation(operationId.current);
    } finally {
      polling = false;
      await pollTask;
      setBusy(false);
    }
  };

  const submitDelete = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deleteTarget) return;
    if (!canDeleteSelected) {
      setFormError(
        writer?.reason || "Удаление временно недоступно до проверки таблицы.",
      );
      return;
    }
    if (deleteConfirmation !== deleteTarget.name) {
      setFormError("Введите точное название листа для подтверждения удаления.");
      return;
    }
    setBusy(true);
    setFormError("");
    const id = crypto.randomUUID();
    operationId.current = id;
    const pendingOperation: Operation = {
      id,
      action: "delete",
      status: "writing",
      name: deleteTarget.name,
      sheetId: deleteTarget.sheetId,
      rows: 0,
      message: null,
      spreadsheetUrl: "",
    };
    setOperation(pendingOperation);
    setNotice(supplyOperationStatus(pendingOperation));
    let polling = true;
    const pollTask = (async () => {
      while (polling) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        if (!polling) break;
        await checkOperation(id);
      }
    })();
    try {
      const response = await fetch("/api/roll-supplies", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          explicitWriteApproval: true,
          operationId: id,
          name: deleteTarget.name,
          sheetId: deleteTarget.sheetId,
        }),
        signal: AbortSignal.timeout(240000),
      });
      const data = await readRollSupplyResponse(response);
      const result = data.operation as Operation;
      setOperation(result);
      setNotice(supplyOperationStatus(result));
      if (result.status === "verified") {
        await reloadWriter();
        await onRefresh();
        setSelectedId(null);
        setDeleteTarget(null);
        setDeleteConfirmation("");
        setNotice(`Поставка «${result.name}» удалена из таблицы и списка.`);
      }
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подтвердить результат удаления. Проверьте состояние листа.",
      );
      await checkOperation(id);
    } finally {
      polling = false;
      await pollTask;
      setBusy(false);
    }
  };

  return (
    <div className="live-supplies">
      <div className="live-supplies-toolbar">
        <div>
          <h2>Поставки рулонной печати</h2>
          <p>
            Состав и выпуск читаются из «OZON РУЛОННАЯ ПЕЧАТЬ». Вкладка таблицы
            — отдельная поставка.
          </p>
        </div>
        <div className="live-supplies-actions">
          <Button onClick={() => void onRefresh()} disabled={loading}>
            <Package size={17} />
            {loading ? "Обновляю…" : "Обновить данные"}
          </Button>
          <Button
            kind="primary"
            onClick={() => openDialog("create")}
            disabled={!canWrite}
            title={
              !canWrite
                ? writeBlockedReason
                : undefined
            }
          >
            <Plus size={18} />
            Новая поставка
          </Button>
        </div>
      </div>

      {writer && !writer.available && (
        <div className="live-supplies-guard" role="status">
          <Warning size={18} />
          <span>{writer.reason}</span>
        </div>
      )}
      {writer?.sheetSync?.status === "error" && (
        <div className="live-supplies-guard" role="status">
          <Warning size={18} />
          <span>
            Не удалось сверить вкладки поставок с Google Sheets. Список не
            менялся; повторная проверка будет выполнена автоматически.
          </span>
        </div>
      )}
      {!!writer?.sheetSync?.removed?.length && (
        <div className="supply-operation-result success" role="status">
          Удалённые в Google Sheets вкладки исключены из списка поставок: {writer.sheetSync.removed.join(", ")}.
        </div>
      )}
      {error && (
        <div className="live-supplies-guard" role="status">
          <Warning size={18} />
          <span>
            {error} Доступные данные остаются предыдущим проверенным снимком;
            запись отключена.
          </span>
        </div>
      )}
      {live?.stale && !error && (
        <div className="live-supplies-guard" role="status">
          <Warning size={18} />
          <span>
            {live.staleReason || "Снимок производства устарел."} Создание и
            добавление товаров отключены до успешной загрузки; удаление
            сверяется отдельно по точному ID вкладки.
          </span>
        </div>
      )}
      {!!live?.issues?.length && !live.stale && (
        <div className="live-supplies-guard" role="status">
          <Warning size={18} />
          <span>
            Данные обновлены, но в журнале есть некорректные строки (
            {num(live.issues.length)}). Они исключены из расчётов; создание и
            добавление товаров временно отключены до проверки журнала.
          </span>
        </div>
      )}

      {!live && loading ? (
        <section className="panel">
          <Empty title="Читаю рулонную печать">
            Загружаю список листов и журнал производства.
          </Empty>
        </section>
      ) : !live ? (
        <section className="panel">
          <Empty title="Нет проверенного снимка">
            Поставки не показаны нулевыми значениями. Проверьте подключение и
            повторите обновление.
          </Empty>
        </section>
      ) : summaries.length === 0 ? (
        <section className="panel">
          <Empty title="Листы рулонной печати не найдены">
            Источник доступен, но зарегистрированных вкладок поставок нет.
          </Empty>
        </section>
      ) : (
        <div className="live-supplies-layout">
          <section className="panel live-supply-list">
            <div className="live-supply-list-heading">
              <strong>Вкладки поставок</strong>
              <span>{num(summaries.length)}</span>
            </div>
            <div className="live-supply-search">
              <input
                type="search"
                aria-label="Найти поставку или артикул"
                placeholder="Найти поставку или артикул"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="live-supply-list-items">
              {visible.map((summary) => (
                <button
                  className={`live-supply-list-item ${selected?.sheet.sheetId === summary.sheet.sheetId ? "selected" : ""}`}
                  type="button"
                  key={`${summary.sheet.sourceId}:${summary.sheet.sheetId}`}
                  onClick={() => setSelectedId(summary.sheet.sheetId)}
                  aria-pressed={
                    selected?.sheet.sheetId === summary.sheet.sheetId
                  }
                >
                  <span className="live-supply-market">Ozon</span>
                  <strong>{summary.sheet.name}</strong>
                  <small>
                    {num(summary.orders.length)} артикулов ·{" "}
                    {num(summary.planned)} шт. · {num(summary.plannedArea, 2)}{" "}
                    м²
                  </small>
                </button>
              ))}
              {visible.length === 0 && (
                <Empty title="Ничего не найдено">
                  Проверьте название поставки или артикул.
                </Empty>
              )}
            </div>
          </section>

          {selected ? (
            <div className="live-supply-detail">
              <section className="panel">
                <div className="live-supply-detail-heading">
                  <div>
                    <span className="live-supply-kicker">
                      OZON · рулонная печать
                    </span>
                    <h2>{selected.sheet.name}</h2>
                    <a
                      href={
                        selected.sheet.spreadsheetUrl ||
                        `https://docs.google.com/spreadsheets/d/1hojhKS4Av_yy5sUMJcsoeJ_MQRU3V5g9P-fP61PO6Cs/edit#gid=${selected.sheet.sheetId}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ArrowSquareOut size={15} />
                      Открыть исходный лист
                    </a>
                  </div>
                  <div className="live-supplies-actions">
                    {selected.sheet.sheetId === writer?.template?.sheetId ? (
                      <span className="live-supply-template-note">
                        Шаблон · удаление запрещено
                      </span>
                    ) : (
                        <Button
                          kind="danger"
                          onClick={() => {
                            setDeleteTarget({
                              name: selected.sheet.name,
                              sheetId: selected.sheet.sheetId,
                            });
                            setDeleteConfirmation("");
                            setFormError("");
                          }}
                          disabled={!canDeleteSelected}
                          title={
                            !canDeleteSelected
                              ? !writer?.available
                                ? writer?.reason || "Управление недоступно"
                              : writer?.busy
                                ? "Дождитесь завершения текущей операции"
                                : writer?.reason ||
                                  "Google Sheets должно подтвердить точный ID и название перед удалением"
                              : undefined
                          }
                        >
                          <Trash size={16} />
                          Удалить поставку
                        </Button>
                      )}
                    <Button
                      kind="primary"
                      onClick={() => openDialog("append")}
                      disabled={!canWrite}
                      title={!canWrite ? writeBlockedReason : undefined}
                    >
                      <Plus size={17} />
                      Добавить товары
                    </Button>
                  </div>
                </div>
                <div className="live-supply-summary">
                  <div>
                    <small>Артикулов</small>
                    <strong>{num(selected.orders.length)}</strong>
                  </div>
                  <div>
                    <small>План, шт.</small>
                    <strong>{num(selected.planned)}</strong>
                  </div>
                  <div>
                    <small>Площадь по плану</small>
                    <strong>{num(selected.plannedArea, 2)} м²</strong>
                  </div>
                  <div>
                    <small>Напечатано · T/X</small>
                    <strong>
                      {selected.printed === null
                        ? "Нет данных"
                        : `${num(selected.printed)} шт.`}
                    </strong>
                  </div>
                  <div>
                    <small>Порезано · столбец U</small>
                    <strong>
                      {selected.cut === null
                        ? "Нет данных"
                        : `${num(selected.cut)} шт.`}
                    </strong>
                    {selected.cut !== null && (
                      <small>
                        {selected.cutMissingOrders
                          ? `Данные по ${selected.cutObservedOrders} из ${selected.orders.length} артикулов`
                          : `Подтверждено по всем ${selected.cutObservedOrders} артикулам`}
                      </small>
                    )}
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <h2>Готовность производства</h2>
                  <small>
                    Печать — T или план минус X; резка — U
                  </small>
                </div>
                <div className="live-supply-stage-grid">
                  <div
                    className={`live-supply-stage ${selected.printed !== null && selected.printed > selected.planned ? "over-plan" : ""}`}
                  >
                    <Printer size={23} />
                    <div>
                      <strong>Печать</strong>
                      {selected.printed !== null && selected.planned > 0 ? (
                        <Progress
                          value={selected.printed}
                          plan={selected.planned}
                        />
                      ) : (
                        <small>
                          {selected.planned > 0
                            ? selected.remainingPrint === null
                              ? "Нет показаний в T и X"
                              : "T пуст; остаток по X известен"
                            : "Нет активных строк заказа"}
                        </small>
                      )}
                      <small>
                        Осталось по X:{" "}
                        {selected.remainingPrint === null
                          ? "нет данных"
                          : `${num(selected.remainingPrint)} шт.`}
                      </small>
                      {selected.printed !== null &&
                        selected.printed > selected.planned && (
                        <small className="live-supply-overrun">
                          Выше плана на{" "}
                          {num(selected.printed - selected.planned)} шт.
                        </small>
                      )}
                    </div>
                  </div>
                  <div
                    className={`live-supply-stage ${selected.cut !== null && selected.cut > selected.planned ? "over-plan" : ""}`}
                  >
                    <Scissors size={23} />
                    <div>
                      <strong>Резка</strong>
                      {selected.cut !== null && selected.planned > 0 ? (
                        <Progress
                          value={selected.cut}
                          plan={selected.planned}
                        />
                      ) : (
                        <small>
                          {selected.planned > 0
                            ? "Нет показаний в U"
                            : "Нет активных строк заказа"}
                        </small>
                      )}
                      <small>
                        {selected.cut === null
                          ? `План: ${num(selected.planned)} шт.`
                          : selected.cutMissingOrders
                            ? `${num(selected.cut)} шт. подтверждено по ${selected.cutObservedOrders} из ${selected.orders.length} артикулов; без данных ${selected.cutMissingOrders}`
                            : `${num(selected.cut)} из ${num(selected.planned)} шт.`}
                      </small>
                      {selected.cut !== null &&
                        selected.cut > selected.planned && (
                        <small className="live-supply-overrun">
                          Выше плана на {num(selected.cut - selected.planned)}{" "}
                          шт.
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="live-supply-stage unavailable">
                    <Package size={23} />
                    <div>
                      <strong>Упаковка</strong>
                      <small>В таблице нет подтверждённого журнала</small>
                    </div>
                  </div>
                  <div className="live-supply-stage unavailable">
                    <Truck size={23} />
                    <div>
                      <strong>Отправка</strong>
                      <small>В таблице нет подтверждённых данных</small>
                    </div>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Состав поставки</h2>
                    <small>
                      План и производственный факт по каждому артикулу
                    </small>
                  </div>
                  <Button
                    onClick={() => {
                      const text =
                        "Артикул;План, шт.;Печать T, шт.;Резка U, шт.;Остаток печати X, шт.;План, м²\n" +
                        selected.orders
                          .map((order) =>
                            [
                              order.article,
                              order.quantity,
                              rollPrinted(order),
                              rollCut(order),
                              rollPrintRemaining(order),
                              order.plannedArea,
                            ].join(";"),
                          )
                          .join("\n");
                      const blob = new Blob(["\ufeff" + text], {
                        type: "text/csv;charset=utf-8",
                      });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `${selected.sheet.name}.csv`;
                      anchor.click();
                      window.setTimeout(() => URL.revokeObjectURL(url), 0);
                    }}
                  >
                    <DownloadSimple size={17} />
                    Скачать CSV
                  </Button>
                </div>
                <DataTable
                  rows={selected.orders}
                  rowKey={(order) => order.uid}
                  label={`Состав поставки ${selected.sheet.name}`}
                  pageSize={20}
                  columns={[
                    {
                      id: "article",
                      label: "Артикул",
                      render: (order) => <strong>{order.article}</strong>,
                    },
                    {
                      id: "plan",
                      label: "План, шт.",
                      render: (order) => num(order.quantity),
                    },
                    {
                      id: "area",
                      label: "План, м²",
                      render: (order) => num(order.plannedArea, 2),
                    },
                    {
                      id: "printed",
                      label: "Напечатано · T/X",
                      render: (order) =>
                        rollPrinted(order) === null
                          ? "—"
                          : num(rollPrinted(order)!),
                    },
                    {
                      id: "cut",
                      label: "Порезано · U",
                      render: (order) =>
                        rollCut(order) === null ? "—" : num(rollCut(order)!),
                    },
                    {
                      id: "rest",
                      label: "Осталось напечатать · X",
                      render: (order) =>
                        rollPrintRemaining(order) === null
                          ? "—"
                          : num(rollPrintRemaining(order)!),
                    },
                  ]}
                />
              </section>
            </div>
          ) : null}
        </div>
      )}

      <Modal
        open={dialog !== null}
        onClose={() => !busy && setDialog(null)}
        title={
          dialog === "append"
            ? "Добавить товары в поставку"
            : "Создать поставку"
        }
        description={
          dialog === "append"
            ? `Новые строки будут записаны в пустые подготовленные строки листа «${selected?.sheet.name || ""}». Существующие товары и формулы не перезаписываются.`
            : `Будет создана копия листа «${writer?.template?.name || "OZON МОСКВА 10_10"}» в таблице «OZON РУЛОННАЯ ПЕЧАТЬ». В копии заменятся старые строки шаблона на указанный состав; формулы сохранятся, новым товарам назначатся уникальные ID.`
        }
      >
        <form noValidate onSubmit={submit}>
          {dialog === "create" && (
            <Field
              label="Название поставки"
              error={formError && !name.trim() ? formError : undefined}
            >
              <input
                value={name}
                maxLength={100}
                readOnly={
                  busy || (!!operation && operation.status !== "failed")
                }
                onChange={(event) => setName(event.target.value)}
                placeholder="Например, Ozon · Москва · 20 октября"
              />
            </Field>
          )}
          <ExcelItemsField
            value={itemsText}
            onChange={setItemsText}
            error={
              formError && (itemsText.trim() || fileName)
                ? formError
                : undefined
            }
            fileName={fileName}
            onFile={(file) => void onFile(file)}
            importing={importing}
            onTemplate={() => void onTemplate()}
            downloading={downloading}
            onExport={() => void onExport()}
            exporting={exporting}
            canExport={!!itemsText.trim()}
            readOnly={busy || (!!operation && operation.status !== "failed")}
          />
          {formError && !itemsText.trim() && !fileName && (
            <div className="supply-operation-error" role="alert">
              {formError}
            </div>
          )}
          {notice && (
            <div
              className={`supply-operation-result ${operation?.status === "verified" ? "success" : "warning"}`}
              role="status"
              aria-live="polite"
            >
              <strong>{notice}</strong>
              {operation?.message && <span>{operation.message}</span>}
              {!!operation?.calculations?.length && (
                <span>
                  Ошибки формул:{" "}
                  {operation.calculations
                    .map((item) => `${item.cell} ${item.error}`)
                    .join(", ")}
                </span>
              )}
              {operation?.spreadsheetUrl && (
                <a
                  href={operation.spreadsheetUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть вкладку <ArrowSquareOut size={14} />
                </a>
              )}
              {operation &&
                [
                  "uncertain",
                  "written_unverified",
                  "checking",
                  "writing",
                ].includes(operation.status) && (
                  <Button
                    type="button"
                    onClick={() => void checkOperation(operation.id)}
                    disabled={busy}
                  >
                    Проверить состояние
                  </Button>
                )}
            </div>
          )}
          <div className="supply-write-confirmation">
            <strong>Что будет записано</strong>
            <span>
              {dialog === "append"
                ? `Лист «${selected?.sheet.name || ""}»`
                : `Новая копия шаблона в «OZON РУЛОННАЯ ПЕЧАТЬ»`}
            </span>
            <span>
              Будут записаны артикул, количество и уникальные ID новых строк;
              старые строки только в новой копии очистятся. Формулы и
              существующие листы не меняются.
            </span>
            <span>
              Нажатие кнопки подтверждает именно этот состав и это название.
            </span>
          </div>
          <div className="modal-actions">
            <Button
              type="button"
              onClick={() => setDialog(null)}
              disabled={busy}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              kind="primary"
              disabled={
                busy ||
                (!!operation && operation.status !== "failed") ||
                importing ||
                downloading ||
                exporting ||
                !canWrite
              }
            >
              {busy
                ? "Проверяю и записываю…"
                : dialog === "append"
                  ? "Подтвердить и добавить товары"
                  : "Подтвердить и создать лист"}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!busy) {
            setDeleteTarget(null);
            setDeleteConfirmation("");
            setFormError("");
          }
        }}
        title="Удалить поставку и лист?"
        description={
          deleteTarget
            ? `Будет удалён лист «${deleteTarget.name}» вместе с его данными в Google Sheets. Это действие нельзя отменить.`
            : undefined
        }
      >
        <form noValidate onSubmit={submitDelete}>
          <div className="supply-delete-warning" role="alert">
            Удаление затронет только этот лист с ID {deleteTarget?.sheetId}. Другие поставки и шаблон не изменятся.
          </div>
          <Field
            label="Введите название листа точно, чтобы подтвердить удаление"
            error={formError || undefined}
          >
            <input
              autoComplete="off"
              value={deleteConfirmation}
              readOnly={busy}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              aria-label="Точное название удаляемого листа"
            />
          </Field>
          {notice && operation?.action === "delete" && (
            <div
              className={`supply-operation-result ${operation.status === "verified" ? "success" : "warning"}`}
              role="status"
              aria-live="polite"
            >
              <strong>{notice}</strong>
              {operation.message && <span>{operation.message}</span>}
            </div>
          )}
          <div className="modal-actions">
            <Button
              type="button"
              onClick={() => {
                if (!busy) {
                  setDeleteTarget(null);
                  setDeleteConfirmation("");
                  setFormError("");
                }
              }}
              disabled={busy}
            >
              Отмена
            </Button>
            <Button
              kind="danger"
              type="submit"
              disabled={
                busy ||
                !canDeleteSelected ||
                deleteConfirmation !== deleteTarget?.name
              }
            >
              {busy ? "Удаляю и проверяю…" : "Удалить лист и поставку"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
