import { AssemblyOnlyItems } from "./AssemblyOnlyItems";
import { startWriterStatusPolling } from "./writerStatusPolling";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  Package,
  Pencil,
  Plus,
  Printer,
  Scissors,
  Trash,
  Truck,
  UploadSimple,
  Warning,
} from "./icons";
import { num, validateSupply } from "./model";
import {
  ROLL_PRINTING_URL,
  type LiveOrder,
  type LivePrinting,
} from "./livePrinting";
import { supplyMarketplace } from "./liveSupplyMarketplace";
import { ShipmentHero } from "./ShipmentHero";
import { AssemblyTransfer } from "./AssemblyTransfer";
import { ProductionControls } from "./ProductionControls";
import {
  assemblyAreaTotal,
  assemblyPackingTotal,
  completeTotal,
  linkedAssemblyBoxSummary,
  observedTotal,
  plannedAreaTotal,
  rollCut,
  rollPrinted,
  rollPrintRemaining,
  type AssemblyBoxLink,
} from "./liveSupplyProgress";
import { Button, DataTable, Empty, Field, Modal } from "./ui";
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
  areaKnown: boolean;
  areaObservedOrders: number;
  areaMissingOrders: number;
  printed: number | null;
  cut: number | null;
  cutObservedOrders: number;
  cutMissingOrders: number;
  packed: number | null;
  packedObservedOrders: number;
  packedMissingOrders: number;
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
  production?: {
    available: boolean;
    busy: boolean;
    operations: Operation[];
    supplies?: {
      id: string;
      name: string;
      parts: { department: string; sheetId: number }[];
    }[];
  } | null;
};
type Operation = {
  id: string;
  action:
    | "create"
    | "append"
    | "updateItem"
    | "removeItem"
    | "delete"
    | "deletePart";
  status: string;
  name: string;
  sheetId: number | null;
  rows: number;
  message: string | null;
  calculations?: { cell: string; error: string }[];
  spreadsheetUrl: string;
  steps?: {
    department: string;
    name: string;
    status: string;
    rows: number;
    message?: string | null;
    spreadsheetUrl: string;
  }[];
  skippedLines?: {
    article: string;
    quantity: number;
    machine: string;
    issue: string | null;
  }[];
  retryTarget?: { department: "roll" | "box"; sheetId: number } | null;
  department?: "roll" | "box" | null;
};
type RoutingPreview = {
  id: string;
  input: string;
  blocked: boolean;
  acceptedRows: number;
  skippedRows: number;
  lines: {
    article: string;
    extension?: string | null;
    quantity: number;
    machine: string;
    department: string | null;
    issue: string | null;
  }[];
  departments: { id: string; name: string; rows: number; quantity: number }[];
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
    .filter((sheet) =>
      ["roll-printing", "box-printing"].includes(sheet.sourceId || ""),
    )
    .map((sheet) => {
      const orders = live.supplies.filter(
        (order) =>
          order.sheetId === sheet.sheetId &&
          (!order.sourceId || order.sourceId === sheet.sourceId),
      );
      const cut = observedTotal(orders.map(rollCut));
      const area = plannedAreaTotal(orders);
      const packed = observedTotal(
        orders.map((order) =>
          typeof order.packed === "number" ? order.packed : null,
        ),
      );
      return {
        sheet,
        orders,
        planned: orders.reduce((sum, order) => sum + order.quantity, 0),
        plannedArea: area.total ?? 0,
        areaKnown: area.observed > 0 && area.missing === 0,
        areaObservedOrders: area.observed,
        areaMissingOrders: area.missing,
        printed: completeTotal(orders.map(rollPrinted)),
        cut: cut.total,
        cutObservedOrders: cut.observed,
        cutMissingOrders: cut.missing,
        packed: packed.total,
        packedObservedOrders: packed.observed,
        packedMissingOrders: packed.missing,
        remainingPrint: completeTotal(orders.map(rollPrintRemaining)),
      };
    });
}

function stagePercent(value: number | null | undefined, plan: number | null | undefined) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    typeof plan !== "number" ||
    !Number.isFinite(plan) ||
    plan <= 0
  )
    return null;
  return Math.max(0, (value / plan) * 100);
}

function stagePercentLabel(value: number | null, partial = false) {
  if (value === null) return "—";
  return `${partial ? "≥" : ""}${num(Math.round(value))}%`;
}

function observedStageText(
  metric: { total: number | null; observed: number; missing: number },
  plan: number | null,
  positions: number,
) {
  const amount =
    metric.total === null
      ? "нет данных"
      : `${num(metric.total)}${plan === null ? "" : ` / ${num(plan)}`} шт.`;
  return metric.missing > 0
    ? `${amount} · данные по ${num(metric.observed)} из ${num(positions)} позиций`
    : amount;
}

function stageCheckedAt(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function StageMeter({
  value,
  plan,
  label,
  tone,
}: {
  value: number;
  plan: number;
  label: string;
  tone: "blue" | "orange" | "violet";
}) {
  const percent = stagePercent(value, plan);
  if (percent === null) return null;
  const overrunWidth =
    percent > 100
      ? Math.min(12, Math.max(4, (percent - 100) * 0.25))
      : 0;
  return (
    <div
      className={`live-supply-meter tone-${tone}${percent > 100 ? " is-over" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={plan}
      aria-valuenow={Math.min(value, plan)}
      aria-valuetext={`${num(Math.round(percent))}% · ${num(value)} из ${num(plan)} шт.`}
    >
      <span style={{ width: `${Math.min(100, percent)}%` }} />
      {percent > 100 && (
        <i aria-hidden="true" style={{ width: `${overrunWidth}px` }} />
      )}
    </div>
  );
}

function LinkedBoxStageProgress({
  column,
  metric,
  plan,
  positions,
  tone,
}: {
  column: "R" | "S";
  metric: { total: number | null; observed: number; missing: number };
  plan: number | null;
  positions: number;
  tone: "blue" | "orange";
}) {
  const percent = stagePercent(metric.total, plan);
  const stageName = column === "R" ? "Печать" : "Резка";
  return (
    <div className={`live-supply-linked-stage tone-${tone}`}>
      <div className="live-supply-linked-stage-head">
        <span className="live-supply-linked-stage-icon" aria-hidden="true">
          <Package size={13} />
        </span>
        <span className="live-supply-linked-stage-title">
          <strong>Бокс</strong>
          <small>{stageName}</small>
        </span>
        <span className="live-supply-linked-stage-column" aria-label={`Столбец ${column}`}>
          {column}
        </span>
        {percent !== null && (
          <b className="live-supply-linked-stage-percent">
            {stagePercentLabel(percent, metric.missing > 0)}
          </b>
        )}
      </div>
      <div className="live-supply-linked-stage-quantity">
        <strong>
          {metric.total === null
            ? "Нет данных"
            : `${num(metric.total)}${plan === null ? "" : ` / ${num(plan)}`} шт.`}
        </strong>
        {metric.missing > 0 && (
          <small>
            Данные по {num(metric.observed)} из {num(positions)} позиций
          </small>
        )}
      </div>
      {metric.total !== null && plan !== null && percent !== null && (
        <StageMeter
          value={metric.total}
          plan={plan}
          label={`Готовность бокса · ${stageName.toLocaleLowerCase("ru-RU")}`}
          tone={tone}
        />
      )}
    </div>
  );
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
  if (operation.status === "partial")
    return "Загрузка не завершена — требуется сверка или продолжение";
  if (operation.action === "updateItem" || operation.action === "removeItem") {
    const removing = operation.action === "removeItem";
    if (operation.status === "writing")
      return removing
        ? "Удаляю артикул из поставки"
        : "Обновляю количество артикула";
    if (operation.status === "checking") return "Проверяю изменение артикула";
    if (operation.status === "verified")
      return removing
        ? "Артикул удалён и проверен"
        : "Количество обновлено и проверено";
    if (operation.status === "uncertain")
      return "Результат изменения неизвестен — повтор запрещён";
    if (operation.status === "written_unverified")
      return "Изменение отправлено, проверка не завершена";
    if (operation.status === "failed")
      return removing ? "Артикул не удалён" : "Количество не изменено";
  }
  if (operation.action === "delete" || operation.action === "deletePart") {
    if (operation.status === "writing")
      return operation.action === "deletePart"
        ? "Удаляю участок из поставки"
        : "Удаляю лист поставки";
    if (operation.status === "checking")
      return operation.action === "deletePart"
        ? "Проверяю удаление участка"
        : "Проверяю удаление листа";
    if (operation.status === "verified")
      return operation.action === "deletePart"
        ? "Участок удалён и проверен"
        : "Поставка и лист удалены";
    if (operation.status === "uncertain")
      return "Результат удаления неизвестен — повтор запрещён";
    if (operation.status === "written_unverified")
      return "Удаление отправлено, проверка не завершена";
    if (operation.status === "failed") return "Удаление не выполнено";
  }
  if (operation.status === "writing")
    return operation.action === "append"
      ? "Добавляю товары в начало списка"
      : "Создаю лист и записываю состав";
  if (operation.status === "verified")
    return operation.action === "append"
      ? "Товары добавлены в начало списка и проверены"
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
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get("supplySheet"));
  const [search, setSearch] = useState("");
  const [onlyMissingArea, setOnlyMissingArea] = useState(false);
  const [dialog, setDialog] = useState<"create" | "append" | null>(null);
  const [appendTarget, setAppendTarget] = useState<{
    name: string;
    sheetId: number;
    department: "roll" | "box";
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    sheetId: number;
    department: "roll" | "box";
    linked: boolean;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [itemTarget, setItemTarget] = useState<{
    action: "updateItem" | "removeItem";
    order: LiveOrder;
  } | null>(null);
  const [itemQuantity, setItemQuantity] = useState("");
  const [itemFormError, setItemFormError] = useState("");
  const [name, setName] = useState("");
  const [lockAfterCreate, setLockAfterCreate] = useState(false);
  const [itemsText, setItemsText] = useState("");
  const [fileName, setFileName] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [assemblyBoxLinks, setAssemblyBoxLinks] = useState<AssemblyBoxLink[]>(
    [],
  );
  const [routingPreview, setRoutingPreview] = useState<RoutingPreview | null>(
    null,
  );
  const [recoveryError, setRecoveryError] = useState("");
  const operationId = useRef("");
  const routingInputKey = JSON.stringify([dialog, name, itemsText, appendTarget, dialog === "create" && lockAfterCreate]);
  const summaries = useMemo(() => buildSummaries(live), [live]);
  const effectiveBoxLinks = useMemo(() => {
    const links = [...assemblyBoxLinks];
    for (const supply of writer?.production?.supplies || []) {
      const rolls = supply.parts.filter((part) => part.department === "roll");
      const boxes = supply.parts.filter((part) => part.department === "box");
      if (rolls.length !== 1 || boxes.length !== 1) continue;
      const roll = summaries.find((item) => item.sheet.sourceId === "roll-printing" && item.sheet.sheetId === rolls[0].sheetId);
      const box = summaries.find((item) => item.sheet.sourceId === "box-printing" && item.sheet.sheetId === boxes[0].sheetId);
      if (!roll || !box) continue;
      const existing = links.findIndex((link) => link.boxSheetId === box.sheet.sheetId && link.name === roll.sheet.name && (link.targetRollSheetId === null || link.targetRollSheetId === roll.sheet.sheetId));
      if (existing >= 0) {
        if (links[existing].targetRollSheetId === null) links[existing] = { ...links[existing], targetRollSheetId: roll.sheet.sheetId };
        continue;
      }
      links.push({ name: roll.sheet.name, boxSheetId: box.sheet.sheetId, targetRollSheetId: roll.sheet.sheetId, boxRows: box.orders.length, boxQuantity: box.orders.reduce((sum, order) => sum + order.quantity, 0) });
    }
    return links;
  }, [assemblyBoxLinks, summaries, writer?.production?.supplies]);
  const refreshAssemblyBoxLinks = useCallback(async () => {
    try {
      const response = await fetch("/api/assembly-transfers/links", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const value = await response.json();
      if (value.ok && Array.isArray(value.links))
        setAssemblyBoxLinks(value.links);
    } catch {
      // Assembly transfer status is optional and does not block supply data.
    }
  }, []);
  const refreshSupplyData = useCallback(async () => {
    await Promise.all([onRefresh(), refreshAssemblyBoxLinks()]);
  }, [onRefresh, refreshAssemblyBoxLinks]);
  useEffect(() => {
    void refreshAssemblyBoxLinks();
  }, [refreshAssemblyBoxLinks]);
  const productionNotices = (writer?.production?.operations || []).filter(
    (item) =>
      item.status !== "verified" ||
      (!!item.skippedLines?.length &&
        !!writer?.production?.supplies?.some(
          (supply) =>
            supply.name.trim().toLocaleLowerCase("ru-RU") ===
            item.name.trim().toLocaleLowerCase("ru-RU"),
        )),
  );
  const linkedBoxSheetIds = new Set(
    effectiveBoxLinks
      .filter((link) => link.targetRollSheetId !== null)
      .map((link) => link.boxSheetId),
  );
  const visible = summaries.filter((summary) => {
    if (
      summary.sheet.sourceId === "box-printing" &&
      linkedBoxSheetIds.has(summary.sheet.sheetId)
    )
      return false;
    const box = linkedAssemblyBoxSummary(summary, summaries, effectiveBoxLinks);
    return (
      summary.sheet.name +
      " " +
      summary.orders.map((line) => line.article).join(" ") +
      " " +
      (box?.orders || []).map((line) => line.article).join(" ")
    )
      .toLocaleLowerCase("ru-RU")
      .includes(search.trim().toLocaleLowerCase("ru-RU"));
  });
  const selected =
    visible.find(
      (summary) =>
        `${summary.sheet.sourceId}:${summary.sheet.sheetId}` === selectedId,
    ) ||
    visible[0] ||
    null;
  const selectedBox = selected
    ? linkedAssemblyBoxSummary(selected, summaries, effectiveBoxLinks)
    : null;
  const selectedBoxPrintedProgress = selectedBox
    ? observedTotal([
        ...selectedBox.orders.map(rollPrinted),
        ...Array.from({ length: selectedBox.missingPositions }, () => null),
      ])
    : null;
  const selectedBoxCutProgress = selectedBox
    ? observedTotal([
        ...selectedBox.orders.map(rollCut),
        ...Array.from({ length: selectedBox.missingPositions }, () => null),
      ])
    : null;
  const selectedAssemblyPositions = selected
    ? selected.orders.length + (selectedBox?.positions || 0)
    : 0;
  const selectedAssemblyPlan = selected
    ? selectedBox
      ? selectedBox.quantity === null
        ? null
        : selected.planned + selectedBox.quantity
      : selected.planned
    : null;
  const selectedAssemblyOrders = selected
    ? [...selected.orders, ...(selectedBox?.orders || [])]
    : [];
  const selectedLinkedBoxSheetIds = selected
    ? effectiveBoxLinks
        .filter(
          (link) =>
            link.name === selected.sheet.name &&
            (link.targetRollSheetId == null ||
              link.targetRollSheetId === selected.sheet.sheetId),
        )
        .map((link) => link.boxSheetId)
    : [];
  const selectedBoxSheets = (live?.sheets || []).filter(
    (sheet) =>
      sheet.sourceId === "box-printing" &&
      selectedLinkedBoxSheetIds.includes(sheet.sheetId),
  );
  const selectedControlShipmentIds = selected
    ? Array.from(
        new Set(
          [
            selected.sheet.assemblyShipmentId ||
              (selected.sheet.sourceId === "roll-printing"
                ? "RITM-ROLL-" + selected.sheet.sheetId
                : selected.sheet.sourceId === "box-printing"
                  ? "RITM-BOX-" + selected.sheet.sheetId
                  : ""),
            ...selectedAssemblyOrders.map(
              (order) => order.assemblyShipmentId || "",
            ),
            ...selectedBoxSheets.map(
              (sheet) =>
                sheet.assemblyShipmentId || "RITM-BOX-" + sheet.sheetId,
            ),
          ].filter(Boolean),
        ),
      )
    : [];
  const selectedAssemblyArea = selectedBox
    ? assemblyAreaTotal(selectedAssemblyOrders, selectedBox.missingPositions)
    : selected
      ? {
          total: selected.areaObservedOrders ? selected.plannedArea : null,
          observed: selected.areaObservedOrders,
          missing: selected.areaMissingOrders,
        }
      : { total: null, observed: 0, missing: 0 };
  const selectedAssemblyPacking = selectedBox
    ? assemblyPackingTotal(selectedAssemblyOrders, selectedBox.missingPositions)
    : selected
      ? {
          total: selected.packed,
          observed: selected.packedObservedOrders,
          missing: selected.packedMissingOrders,
        }
      : { total: null, observed: 0, missing: 0 };
  const printPercent = selected
    ? stagePercent(selected.printed, selected.planned)
    : null;
  const cutPercent = selected ? stagePercent(selected.cut, selected.planned) : null;
  const packingPercent = selected
    ? stagePercent(selectedAssemblyPacking.total, selectedAssemblyPlan)
    : null;
  const packingPartial = selectedAssemblyPacking.missing > 0;
  const packingCheckedAt = stageCheckedAt(live?.packing?.checkedAt);
  useEffect(() => {
    setOnlyMissingArea(false);
  }, [selected?.sheet.sourceId, selected?.sheet.sheetId]);
  const selectedOrders = useMemo(
    () =>
      onlyMissingArea
        ? selected?.orders.filter((order) => order.areaKnown === false) || []
        : selected?.orders || [],
    [selected, onlyMissingArea],
  );
  const snapshotAtMs = live ? Date.parse(live.snapshotAt || live.updatedAt) : NaN;
  const hasFreshSnapshot =
    Number.isFinite(snapshotAtMs) &&
    Date.now() - snapshotAtMs < 5 * 60 * 1000;
  const pendingProduction = writer?.production?.operations?.find(
    item => !["verified", "cancelled"].includes(item.status),
  );
  const canWrite =
    // Allow writes against a recently verified snapshot while its background
    // refresh is running. Supply creation still performs its own fresh catalog,
    // template, ID and readback preflights on the server.
    hasFreshSnapshot &&
    !!writer?.available &&
    !!live &&
    !live.stale &&
    live.quality?.status !== "partial" &&
    !error &&
    (!loading || hasFreshSnapshot) &&
    !busy &&
    !writer.busy &&
    !pendingProduction;
  const writeBlockedReason = !writer?.available
    ? writer?.reason || "Проверьте доступ к управлению поставками"
    : !live || live.stale || !hasFreshSnapshot
      ? "Сначала дождитесь свежей загрузки источника"
      : live.quality?.status === "partial"
        ? "В обновлённых данных есть строки с ошибками; проверьте журнал"
        : busy
          ? "Проверяем и сохраняем поставку"
          : writer.busy
          ? "Другая операция завершается. Проверяем готовность записи…"
          : pendingProduction
          ? "Предыдущая операция требует проверки. Откройте её состояние ниже."
          : error || (loading && !hasFreshSnapshot)
          ? "Дождитесь завершения обновления"
          : undefined;
  const selectedDepartment =
    selected?.sheet.sourceId === "box-printing" ? "box" : "roll";
  const selectedProductionPart =
    !!selected &&
    !!writer?.production?.supplies?.some((s) =>
      s.parts.some(
        (p) =>
          p.department === selectedDepartment &&
          p.sheetId === selected.sheet.sheetId,
      ),
    );
  const canDeleteSelected =
    !!writer?.available &&
    !writer.busy &&
    !busy &&
    !!selected &&
    !(
      selectedDepartment === "roll" &&
      selected.sheet.sheetId === writer?.template?.sheetId
    ) &&
    (selectedProductionPart ||
      (selectedDepartment === "roll" &&
        selected.sheet.sourceId === "roll-printing"));
  const canRemoveOrder = (order: LiveOrder) =>
    live?.packing?.status === "available" &&
    order.packed === 0 &&
    order.packingRecords === 0 &&
    rollPrinted(order) === 0 &&
    (rollCut(order) === null || rollCut(order) === 0);

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
      const current = [
        ...(value.production?.operations || []),
        ...(value.operations || []),
      ].find((item: Operation) => item.id === id);
      if (current) {
        setOperation(current);
        setNotice(supplyOperationStatus(current));
        setFormError("");
      } else if (value.busy) {
        setNotice(
          "Подготовка ещё выполняется. Повторная отправка заблокирована.",
        );
      } else {
        setOperation(null);
        setRoutingPreview(null);
        setNotice(
          "Сервер пока не подтвердил запись операции. Текущий ID запроса сохранён для безопасной сверки; не запускайте создание с новым ID.",
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

  const reloadWriter = useCallback(async () => {
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
  }, [onRefresh]);

  useEffect(() => {
    void reloadWriter();
    const timer = window.setInterval(() => void reloadWriter(), 60_000);
    return () => window.clearInterval(timer);
  }, [reloadWriter]);

  useEffect(() => {
    if (busy || !(writer?.busy || ["writing", "checking"].includes(pendingProduction?.status || ""))) return;
    return startWriterStatusPolling(reloadWriter);
  }, [writer?.busy, pendingProduction?.status, busy, reloadWriter]);

  const openDialog = (mode: "create" | "append") => {
    setDialog(mode);
    setAppendTarget(
      mode === "append" && selected
        ? {
            name: selected.sheet.name,
            sheetId: selected.sheet.sheetId,
            department:
              selected.sheet.sourceId === "box-printing" ? "box" : "roll",
          }
        : null,
    );
    setName(mode === "append" ? selected?.sheet.name || "" : "");
    setLockAfterCreate(false);
    setItemsText("");
    setFileName("");
    setFormError("");
    setNotice("");
    setOperation(null);
    setRoutingPreview(null);
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
        dialog === "append" ? appendTarget?.name || "Состав_поставки" : name;
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
    if (!dialog || (!appendTarget && dialog === "append")) return;
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
    const inputKey = routingInputKey;
    if (!routingPreview || routingPreview.input !== inputKey) {
      try {
        const response = await fetch("/api/roll-supplies/preview", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: dialog,
            explicitWriteApproval: true,
            operationId: operationId.current,
            name: dialog === "append" ? appendTarget!.name : name.trim(),
            lines,
            ...(dialog === "create" ? { lockAfterCreate } : {}),
            ...(dialog === "append"
              ? {
                  sheetId: appendTarget!.sheetId,
                  department: appendTarget!.department,
                }
              : {}),
          }),
        });
        const value = await readRollSupplyResponse(response);
        setRoutingPreview({ ...value.preview, input: inputKey });
      } catch (cause) {
        setFormError(
          cause instanceof Error
            ? cause.message
            : "Не удалось проверить станки в базе.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (routingPreview.blocked) {
      setFormError(
        "Нет распознанных товаров для добавления. Уточните станки в базе и проверьте список заново.",
      );
      setBusy(false);
      return;
    }
    const pendingOperation: Operation = {
      id: operationId.current,
      status: "writing",
      action: dialog,
      name: dialog === "append" ? appendTarget!.name : name.trim(),
      sheetId: dialog === "append" ? appendTarget!.sheetId : null,
      rows: routingPreview.acceptedRows,
      message: null,
      spreadsheetUrl: "",
    };
    setOperation(pendingOperation);
    setNotice(supplyOperationStatus(pendingOperation));
    const requestOperationId = operationId.current;
    try {
      const payload = {
        action: dialog,
        explicitWriteApproval: true,
        operationId: requestOperationId,
        name: dialog === "append" ? appendTarget!.name : name.trim(),
        lines,
        previewId: routingPreview.id,
        ...(dialog === "create" ? { lockAfterCreate } : {}),
        ...(dialog === "append"
          ? {
              sheetId: appendTarget!.sheetId,
              department: appendTarget!.department,
            }
          : {}),
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
        void reloadWriter();
        void onRefresh();
        if (result.sheetId) setSelectedId(`roll-printing:${result.sheetId}`);
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
      await checkOperation(requestOperationId);
    } finally {
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
      action: deleteTarget.linked ? "deletePart" : "delete",
      status: "writing",
      name: deleteTarget.name,
      sheetId: deleteTarget.sheetId,
      department: deleteTarget.department,
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
          action: deleteTarget.linked ? "deletePart" : "delete",
          explicitWriteApproval: true,
          operationId: id,
          name: deleteTarget.name,
          sheetId: deleteTarget.sheetId,
          ...(deleteTarget.linked
            ? { department: deleteTarget.department }
            : {}),
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
        setNotice(
          result.message ||
            `Поставка «${result.name}» удалена из таблицы и списка.`,
        );
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

  const submitItemChange = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!itemTarget || !selected) return;
    if (!canWrite) {
      setItemFormError(
        writer?.reason || "Запись недоступна до проверки источника.",
      );
      return;
    }
    const { action, order } = itemTarget;
    const quantity = Number(itemQuantity);
    if (
      action === "updateItem" &&
      (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000)
    ) {
      setItemFormError("Укажите целое количество от 1 до 1 000 000.");
      return;
    }
    const id = crypto.randomUUID();
    operationId.current = id;
    setBusy(true);
    setItemFormError("");
    const pendingOperation: Operation = {
      id,
      action,
      status: "writing",
      name: selected.sheet.name,
      sheetId: selected.sheet.sheetId,
      rows: 1,
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
          action,
          explicitWriteApproval: true,
          operationId: id,
          name: selected.sheet.name,
          sheetId: selected.sheet.sheetId,
          uid: order.uid,
          article: order.article,
          expectedQuantity: order.quantity,
          ...(action === "updateItem" ? { quantity } : {}),
        }),
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
        if (result.status === "verified") {
          setItemTarget(null);
          setItemQuantity("");
          setNotice(
            action === "updateItem"
              ? `Количество «${order.article}» обновлено.`
              : `Артикул «${order.article}» удалён из поставки.`,
          );
        }
      }
    } catch (cause) {
      setItemFormError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подтвердить изменение артикула.",
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
          <h2>Производственные поставки</h2>
          <p>
            Товары распределяются по станкам между рулонной печатью и боксом. У
            сборщиков — общий состав поставки.
          </p>
        </div>
        <div className="live-supplies-actions">
          <AssemblyTransfer onDelivered={() => void refreshSupplyData()} />
          <Button onClick={() => void refreshSupplyData()} disabled={loading}>
            <Package size={17} />
            {loading ? "Обновляю…" : "Обновить данные"}
          </Button>
          <Button
            kind="primary"
            onClick={() => openDialog("create")}
            disabled={!canWrite}
            title={!canWrite ? writeBlockedReason : undefined}
          >
            <Plus size={18} />
            Новая поставка
          </Button>
        </div>
      </div>
      {!canWrite && writeBlockedReason && <p className="supply-write-wait" role="status">{writeBlockedReason}</p>}

      {!!(recoveryError || productionNotices.length) && (
        <section className="panel" aria-label="Загрузка поставок по отделам">
          {recoveryError && (
            <div className="supply-operation-error" role="alert">
              {recoveryError}
            </div>
          )}
          {productionNotices.map((item) => (
            <div className="supply-write-confirmation" key={item.id}>
              <strong>
                {item.name} ·{" "}
                {item.status === "verified"
                  ? `Не добавлено позиций: ${num(item.skippedLines?.length || 0)}`
                  : item.action === "deletePart"
                    ? "Удаление требует проверки"
                    : "Загрузка требует проверки"}
              </strong>
              {item.action === "create" && item.status !== "verified" && (
                <Button disabled={busy} onClick={async () => {
                  setBusy(true); setRecoveryError("");
                  try {
                    const response = await fetch("/api/roll-supplies", {
                      method: "POST", credentials: "same-origin",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ action: "cancelAbsentCreate", operationId: item.id, explicitWriteApproval: true }),
                    });
                    await readRollSupplyResponse(response);
                    await reloadWriter();
                  } catch (cause) { setRecoveryError(cause instanceof Error ? cause.message : "Не удалось отменить создание."); }
                  finally { setBusy(false); }
                }}>Отменить незавершённое создание</Button>
              )}
              {item.status !== "verified" && (
                <details>
                  <summary>Подробности</summary>
                  {item.message && <span>{item.message}</span>}
                  {item.steps?.map((step) => (
                    <span key={step.department}>
                      {step.name}: {num(step.rows)} новых позиций ·{" "}
                      {step.status === "verified"
                        ? "записано и проверено"
                        : step.status === "pending"
                          ? "ожидает загрузки"
                          : step.status === "failed"
                            ? "ошибка загрузки"
                            : "требует сверки"}
                      {step.spreadsheetUrl && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={step.spreadsheetUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Открыть таблицу
                          </a>
                        </>
                      )}
                      {step.message && <> · {step.message}</>}
                    </span>
                  ))}
                </details>
              )}
              {!!item.skippedLines?.length && (
                <details>
                  <summary>
                    Не добавлено позиций: {num(item.skippedLines.length)}
                  </summary>
                  <p>
                    Уточните станки в базе, затем дозагрузите эти товары в ту же
                    поставку.
                  </p>
                  <ul>
                    {item.skippedLines.map((line) => (
                      <li key={line.article}>
                        {line.article} · {num(line.quantity)} шт. ·{" "}
                        {line.issue || "Станок не определён"}
                      </li>
                    ))}
                  </ul>
                  <Button
                    disabled={exporting}
                    onClick={async () => {
                      setExporting(true);
                      setRecoveryError("");
                      try {
                        const bytes = await createSupplyWorkbook(
                          item.skippedLines!.map(({ article, quantity }) => ({
                            article,
                            quantity,
                          })),
                        );
                        saveSupplyWorkbook(
                          bytes,
                          `${item.name} — не добавлены`,
                        );
                      } catch {
                        setRecoveryError(
                          "Не удалось выгрузить пропущенные товары в Excel.",
                        );
                      } finally {
                        setExporting(false);
                      }
                    }}
                  >
                    {exporting ? "Готовлю Excel…" : "Скачать пропущенные"}
                  </Button>
                  {item.retryTarget && (
                    <Button
                      disabled={busy || !canWrite || item.status !== "verified"}
                      onClick={() => {
                        setDialog("append");
                        setAppendTarget({
                          ...item.retryTarget!,
                          name: item.name,
                        });
                        setName(item.name);
                        setItemsText(
                          item
                            .skippedLines!.map(
                              (line) => `${line.article};${line.quantity}`,
                            )
                            .join("\n"),
                        );
                        setFileName("");
                        setFormError("");
                        setNotice("");
                        setOperation(null);
                        setRoutingPreview(null);
                        operationId.current = crypto.randomUUID();
                      }}
                    >
                      Дозагрузить пропущенные
                    </Button>
                  )}
                </details>
              )}
              {item.status !== "verified" && (
                <Button
                  disabled={busy || !writer?.production?.available}
                  onClick={async () => {
                    setBusy(true);
                    setRecoveryError("");
                    try {
                      const response = await fetch("/api/roll-supplies", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          action: "resume",
                          operationId: item.id,
                          explicitWriteApproval: true,
                        }),
                      });
                      await readRollSupplyResponse(response);
                      await reloadWriter();
                      await onRefresh();
                    } catch (cause) {
                      setRecoveryError(
                        cause instanceof Error
                          ? cause.message
                          : "Не удалось продолжить загрузку.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {item.action === "deletePart"
                    ? "Проверить и продолжить удаление участка"
                    : "Проверить и продолжить загрузку"}
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

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
              <span>{num(visible.length)}</span>
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
              {visible.map((summary) => {
                const box = linkedAssemblyBoxSummary(
                  summary,
                  summaries,
                  effectiveBoxLinks,
                );
                const area = box
                  ? assemblyAreaTotal(
                      [...summary.orders, ...box.orders],
                      box.missingPositions,
                    )
                  : {
                      total: summary.areaObservedOrders
                        ? summary.plannedArea
                        : null,
                      observed: summary.areaObservedOrders,
                      missing: summary.areaMissingOrders,
                    };
                const marketplace = supplyMarketplace(summary.sheet.name);
                return (
                  <button
                    className={`live-supply-list-item ${selected?.sheet.sheetId === summary.sheet.sheetId && selected?.sheet.sourceId === summary.sheet.sourceId ? "selected" : ""}`}
                    data-marketplace={
                      supplyMarketplace(summary.sheet.name)?.toLowerCase() ||
                      "neutral"
                    }
                    type="button"
                    key={`${summary.sheet.sourceId}:${summary.sheet.sheetId}`}
                    onClick={() =>
                      setSelectedId(
                        `${summary.sheet.sourceId}:${summary.sheet.sheetId}`,
                      )
                    }
                    aria-pressed={
                      selected?.sheet.sheetId === summary.sheet.sheetId &&
                      selected?.sheet.sourceId === summary.sheet.sourceId
                    }
                  >
                    <span
                      className={`live-supply-market ${marketplace === "WB" ? "wb" : marketplace === "Ozon" ? "ozon" : "unknown"}`}
                    >
                      {marketplace || "?"}
                    </span>
                    <strong>{summary.sheet.name}</strong>
                    <small>
                      {box ? (
                        <>
                          Assembly ·{" "}
                          {num(summary.orders.length + box.positions)} позиций
                          {box.quantity !== null
                            ? ` · ${num(summary.planned + box.quantity)} шт.`
                            : ""}
                        </>
                      ) : (
                        <>
                          {summary.sheet.sourceId === "box-printing"
                            ? "Бокс"
                            : "Рулонная печать"}{" "}
                          · {num(summary.orders.length)} артикулов ·{" "}
                          {num(summary.planned)} шт.
                        </>
                      )}
                    </small>
                    {box ? (
                      <span className="live-supply-assembly-link">
                        Рулон: {num(summary.orders.length)} поз. ·{" "}
                        {num(summary.planned)} шт. + Бокс: {num(box.positions)}{" "}
                        поз.
                        {box.quantity !== null
                          ? ` · ${num(box.quantity)} шт.`
                          : " · план нет данных"}
                      </span>
                    ) : null}
                    <small className="live-supply-area-note">
                      {area.observed > 0
                        ? `${num(area.total ?? 0, 2)} м²${area.missing ? ` · без площади: ${num(area.missing)}` : ""}`
                        : "Площадь не определена"}
                    </small>
                  </button>
                );
              })}
              {visible.length === 0 && (
                <Empty title="Ничего не найдено">
                  Проверьте название поставки или артикул.
                </Empty>
              )}
            </div>
          </section>

          {selected ? (
            <div
              className="live-supply-detail"
              data-marketplace={
                supplyMarketplace(selected.sheet.name)?.toLowerCase() ||
                "neutral"
              }
            >
              <ShipmentHero
                marketplace={supplyMarketplace(selected.sheet.name)}
                title={selected.sheet.name}
                department={
                  selected.sheet.sourceId === "box-printing"
                    ? "Бокс"
                    : "Рулонная печать"
                }
                sourceHref={
                  selected.sheet.spreadsheetUrl ||
                  (ROLL_PRINTING_URL
                    ? ROLL_PRINTING_URL.replace(
                        /#gid=\d+$/,
                        `#gid=${selected.sheet.sheetId}`,
                      )
                    : undefined)
                }
                actions={
                  <>
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
                            department: selectedDepartment,
                            linked: selectedProductionPart,
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
                        {selectedProductionPart
                          ? "Удалить участок"
                          : "Удалить поставку"}
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
                  </>
                }
              >
                <div className="live-supply-summary">
                  <div>
                    <small>
                      {selectedBox ? "Позиций в Assembly" : "Артикулов"}
                    </small>
                    <strong>
                      {num(selectedAssemblyPositions)}
                    </strong>
                    {selectedBox && (
                      <small>
                        Рулон {num(selected.orders.length)} · бокс{" "}
                        {num(selectedBox.positions)}
                      </small>
                    )}
                  </div>
                  <div>
                    <small>
                      {selectedBox
                        ? "План Assembly, шт."
                        : selected.sheet.sourceId === "box-printing"
                          ? "План бокса, шт."
                          : "План рулонной печати, шт."}
                    </small>
                    <strong>
                      {selectedAssemblyPlan === null
                        ? "Нет данных"
                        : num(selectedAssemblyPlan)}
                    </strong>
                    {selectedBox && selectedBox.quantity !== null && (
                      <small>
                        Рулон {num(selected.planned)} · бокс{" "}
                        {num(selectedBox.quantity)}
                      </small>
                    )}
                  </div>
                  <div>
                    <small>
                      {selectedBox
                        ? "Площадь общая"
                        : selected.sheet.sourceId === "box-printing"
                          ? "Площадь бокса"
                          : "Площадь рулонной печати"}
                    </small>
                    <strong
                      className={
                        selectedAssemblyArea.observed === 0
                          ? "supply-value-unknown"
                          : undefined
                      }
                    >
                      {selectedAssemblyArea.observed > 0
                        ? `${num(selectedAssemblyArea.total ?? 0, 2)} м²`
                        : "Не определена"}
                    </strong>
                    {selectedAssemblyArea.missing > 0 && (
                      <small>
                        По {num(selectedAssemblyArea.observed)} из{" "}
                        {num(selectedAssemblyPositions)} позиций · без площади:{" "}
                        {num(selectedAssemblyArea.missing)}
                      </small>
                    )}
                  </div>
                  <div>
                    <small>
                      {selectedBox
                        ? "Напечатано · рулон"
                        : selected.sheet.sourceId === "box-printing"
                          ? "Напечатано · готовность R"
                          : "Напечатано · T/X"}
                    </small>
                    <strong>
                      {selected.printed === null
                        ? "Нет данных"
                        : `${num(selected.printed)} шт.`}
                    </strong>
                    {selectedBox && selectedBoxPrintedProgress && (
                      <small className="live-supply-linked-summary">
                        Бокс · R: {observedStageText(
                          selectedBoxPrintedProgress,
                          selectedBox.quantity,
                          selectedBox.positions,
                        )}
                      </small>
                    )}
                  </div>
                  <div>
                    <small>
                      {selectedBox
                        ? "Порезано · рулон"
                        : selected.sheet.sourceId === "box-printing"
                          ? "Порезано · готовность S"
                          : "Порезано · столбец U"}
                    </small>
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
                    {selectedBox && selectedBoxCutProgress && (
                      <small className="live-supply-linked-summary">
                        Бокс · S: {observedStageText(
                          selectedBoxCutProgress,
                          selectedBox.quantity,
                          selectedBox.positions,
                        )}
                      </small>
                    )}
                  </div>
                </div>
              </ShipmentHero>

              <AssemblyOnlyItems shipmentId={selectedControlShipmentIds[0] || ""} />

              <ProductionControls
                shipmentIds={selectedControlShipmentIds}
                shipmentName={selected.sheet.name}
                articles={Array.from(new Set(selectedAssemblyOrders.map((order) => order.article).filter(Boolean)))}
              />

              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    {selectedBox
                      ? "Готовность участков · рулон и бокс"
                      : `Готовность участка · ${selected.sheet.sourceId === "box-printing" ? "бокс" : "рулонная печать"}`}
                  </h2>
                  <small>
                    {selectedBox
                      ? "Рулон: печать T/X, резка U · Бокс: печать R, резка S · упаковка: WorkLog RITM"
                      : selected.sheet.sourceId === "box-printing"
                        ? "Печать и резка — флажки готовности R/S; упаковка — WorkLog RITM"
                        : "Печать — T/X; резка — U; упаковка — WorkLog RITM"}
                  </small>
                </div>
                <div className="live-supply-stage-grid">
                  <div
                    className={`live-supply-stage-card tone-blue ${selected.printed !== null && selected.printed > selected.planned ? "is-over" : ""}`}
                  >
                    <div className="live-supply-stage-card-head">
                      <span className="live-supply-stage-icon">
                        <Printer size={23} />
                      </span>
                      <strong>{selectedBox ? "Печать · рулон" : "Печать"}</strong>
                    </div>
                    <strong className="live-supply-stage-percent">
                      {stagePercentLabel(printPercent)}
                    </strong>
                    {printPercent !== null ? (
                      <StageMeter
                        value={selected.printed!}
                        plan={selected.planned}
                        label="Готовность печати"
                        tone="blue"
                      />
                    ) : (
                      <p className="live-supply-stage-empty">
                        {selected.planned > 0
                          ? selected.remainingPrint === null
                            ? "Нет показаний в T и X"
                            : "T пуст; остаток по X известен"
                          : "Нет активных строк заказа"}
                      </p>
                    )}
                    <div className="live-supply-stage-details">
                      <span>
                        {selected.printed === null
                          ? `План: ${num(selected.planned)} шт.`
                          : `${num(selected.printed)} из ${num(selected.planned)} шт.`}
                      </span>
                      <span>
                        Осталось напечатать:{" "}
                        {selected.remainingPrint === null
                          ? "нет данных"
                          : `${num(selected.remainingPrint)} шт.`}
                      </span>
                      {selected.printed !== null &&
                        selected.printed > selected.planned && (
                          <span className="live-supply-stage-overrun">
                            +{num(selected.printed - selected.planned)} шт. сверх плана
                          </span>
                        )}
                    </div>
                    {selectedBox && selectedBoxPrintedProgress && (
                      <LinkedBoxStageProgress
                        column="R"
                        metric={selectedBoxPrintedProgress}
                        plan={selectedBox.quantity}
                        positions={selectedBox.positions}
                        tone="blue"
                      />
                    )}
                  </div>
                  <div
                    className={`live-supply-stage-card tone-orange ${selected.cut !== null && selected.cut > selected.planned ? "is-over" : ""}`}
                  >
                    <div className="live-supply-stage-card-head">
                      <span className="live-supply-stage-icon">
                        <Scissors size={23} />
                      </span>
                      <strong>{selectedBox ? "Резка · рулон" : "Резка"}</strong>
                    </div>
                    <strong className="live-supply-stage-percent">
                      {stagePercentLabel(cutPercent)}
                    </strong>
                    {cutPercent !== null ? (
                      <StageMeter
                        value={selected.cut!}
                        plan={selected.planned}
                        label="Готовность резки"
                        tone="orange"
                      />
                    ) : (
                      <p className="live-supply-stage-empty">
                        {selected.planned > 0
                          ? selected.sheet.sourceId === "box-printing"
                            ? "Готовность резки не указана"
                            : "Нет показаний в U"
                          : "Нет активных строк заказа"}
                      </p>
                    )}
                    <div className="live-supply-stage-details">
                      <span>
                        {selected.cut === null
                          ? `План: ${num(selected.planned)} шт.`
                          : `${num(selected.cut)} из ${num(selected.planned)} шт.`}
                      </span>
                      {selected.cut !== null && selected.cutMissingOrders > 0 && (
                        <span>
                          Данные по {num(selected.cutObservedOrders)} из{" "}
                          {num(selected.orders.length)} артикулов
                        </span>
                      )}
                      {selected.cut !== null &&
                        selected.cut > selected.planned && (
                          <span className="live-supply-stage-overrun">
                            +{num(selected.cut - selected.planned)} шт. сверх плана
                          </span>
                        )}
                    </div>
                    {selectedBox && selectedBoxCutProgress && (
                      <LinkedBoxStageProgress
                        column="S"
                        metric={selectedBoxCutProgress}
                        plan={selectedBox.quantity}
                        positions={selectedBox.positions}
                        tone="orange"
                      />
                    )}
                  </div>
                  <div
                    className={`live-supply-stage-card live-supply-stage-packing tone-violet${live?.packing?.status === "unavailable" ? " is-unavailable" : ""}${live?.packing?.status === "partial" || packingPartial ? " is-partial" : ""}${selectedAssemblyPacking.total !== null && selectedAssemblyPlan !== null && selectedAssemblyPacking.total > selectedAssemblyPlan ? " is-over" : ""}`}
                  >
                    <div className="live-supply-stage-card-head">
                      <span className="live-supply-stage-icon">
                        <Package size={23} />
                      </span>
                      <strong>Упаковка · Assembly</strong>
                      {live?.packing?.sourceUrl && (
                        <a
                          className="live-supply-source-pill"
                          href={live.packing.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WorkLog <ArrowSquareOut size={13} />
                        </a>
                      )}
                    </div>
                    <div className="live-supply-packing-main">
                      <strong className="live-supply-stage-percent">
                        {live?.packing?.status === "unavailable"
                          ? "—"
                          : stagePercentLabel(packingPercent, packingPartial)}
                      </strong>
                      <div className="live-supply-packing-quantity">
                        <strong>
                          {selectedAssemblyPacking.total === null
                            ? "Нет данных"
                            : num(selectedAssemblyPacking.total)}
                          {selectedAssemblyPlan !== null && (
                            <span> из {num(selectedAssemblyPlan)}</span>
                          )}
                        </strong>
                        <small>Упаковано, шт.</small>
                      </div>
                    </div>
                    {live?.packing?.status !== "unavailable" &&
                    packingPercent !== null ? (
                      <StageMeter
                        value={selectedAssemblyPacking.total!}
                        plan={selectedAssemblyPlan!}
                        label="Готовность упаковки по WorkLog Assembly"
                        tone="violet"
                      />
                    ) : (
                      <p className="live-supply-stage-empty">
                        {live?.packing?.status === "unavailable"
                          ? live.packing.reason || "WorkLog сейчас недоступен."
                          : selectedAssemblyPlan === null
                            ? "План Assembly не подтверждён"
                            : "Нет подтверждённых данных по артикулам."}
                      </p>
                    )}
                    <div className="live-supply-stage-details live-supply-packing-details">
                      <span>
                        {selectedAssemblyPacking.total === null
                          ? `Нет подтверждённых количеств по ${num(selectedAssemblyPacking.missing)} из ${num(selectedAssemblyPositions)} позиций.`
                          : selectedAssemblyPacking.missing > 0
                            ? `Подтверждено не менее ${num(selectedAssemblyPacking.total)} шт. по ${num(selectedAssemblyPacking.observed)} из ${num(selectedAssemblyPositions)} позиций; без данных ${num(selectedAssemblyPacking.missing)}.`
                            : `Подтверждено по ${num(selectedAssemblyPacking.observed)} из ${num(selectedAssemblyPositions)} позиций.`}
                      </span>
                      {packingCheckedAt && (
                        <span>WorkLog проверен: {packingCheckedAt}</span>
                      )}
                      {live?.packing?.status === "partial" &&
                        live.packing.reason && (
                          <span className="live-supply-stage-warning">
                            {live.packing.reason}
                          </span>
                        )}
                      {selectedAssemblyPacking.total !== null &&
                        selectedAssemblyPlan !== null &&
                        selectedAssemblyPacking.total > selectedAssemblyPlan && (
                          <span className="live-supply-stage-overrun">
                            +{num(selectedAssemblyPacking.total - selectedAssemblyPlan)} шт. сверх плана
                          </span>
                        )}
                    </div>
                  </div>
                  <div className="live-supply-stage-card tone-green is-unavailable">
                    <div className="live-supply-stage-card-head">
                      <span className="live-supply-stage-icon">
                        <Truck size={23} />
                      </span>
                      <strong>Отправка</strong>
                    </div>
                    <strong className="live-supply-stage-percent">—</strong>
                    <p className="live-supply-stage-empty">
                      В источнике нет подтверждённых данных об отправке.
                    </p>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {selected.sheet.sourceId === "box-printing"
                        ? "Состав бокса"
                        : "Состав рулонной печати"}
                    </h2>
                    <small>
                      План и производственный факт по каждому артикулу
                    </small>
                  </div>
                  <div className="live-supply-table-actions">
                    {selected.areaMissingOrders > 0 && (
                      <Button
                        kind={onlyMissingArea ? "primary" : "secondary"}
                        aria-pressed={onlyMissingArea}
                        onClick={() => setOnlyMissingArea((value) => !value)}
                      >
                        <Warning size={17} />
                        Без площади ({num(selected.areaMissingOrders)})
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        const text =
                          "Артикул;План, шт.;Напечатано, шт.;Порезано, шт.;Упаковано, шт. · WorkLog;Осталось напечатать, шт.;План, м²\n" +
                          selectedOrders
                            .map((order) =>
                              [
                                order.article,
                                order.quantity,
                                rollPrinted(order),
                                rollCut(order),
                                order.packed ?? "",
                                rollPrintRemaining(order),
                                order.areaKnown === false
                                  ? ""
                                  : order.plannedArea,
                              ].join(";"),
                            )
                            .join("\n");
                        const blob = new Blob(["\ufeff" + text], {
                          type: "text/csv;charset=utf-8",
                        });
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = `${selected.sheet.name}${onlyMissingArea ? "-без-площади" : ""}.csv`;
                        anchor.click();
                        window.setTimeout(() => URL.revokeObjectURL(url), 0);
                      }}
                    >
                      <DownloadSimple size={17} />
                      Скачать CSV
                    </Button>
                  </div>
                </div>
                <DataTable
                  rows={selectedOrders}
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
                      render: (order) =>
                        order.areaKnown === false ? (
                          <span
                            title={
                              order.areaIssue ||
                              `Нет подтверждённой площади в J${order.row}`
                            }
                          >
                            —
                          </span>
                        ) : (
                          num(order.plannedArea, 2)
                        ),
                    },
                    {
                      id: "printed",
                      label:
                        selected.sheet.sourceId === "box-printing"
                          ? "Напечатано · R"
                          : "Напечатано · T/X",
                      render: (order) =>
                        rollPrinted(order) === null
                          ? "—"
                          : num(rollPrinted(order)!),
                    },
                    {
                      id: "cut",
                      label:
                        selected.sheet.sourceId === "box-printing"
                          ? "Порезано · S"
                          : "Порезано · U",
                      render: (order) =>
                        rollCut(order) === null ? "—" : num(rollCut(order)!),
                    },
                    {
                      id: "packed",
                      label: "Упаковано · WorkLog",
                      render: (order) =>
                        order.packed === null || order.packed === undefined
                          ? "—"
                          : num(order.packed),
                    },
                    {
                      id: "rest",
                      label: "Осталось напечатать",
                      render: (order) =>
                        rollPrintRemaining(order) === null
                          ? "—"
                          : num(rollPrintRemaining(order)!),
                    },
                    {
                      id: "actions",
                      label: "Действия",
                      render: (order) => (
                        <div className="live-supply-row-actions">
                          <button
                            type="button"
                            aria-label={`Изменить количество ${order.article}`}
                            title={
                              selected.sheet.sourceId === "box-printing"
                                ? "Количество в боксе можно изменить в исходном листе"
                                : "Изменить количество"
                            }
                            disabled={
                              !canWrite ||
                              selected.sheet.sourceId === "box-printing"
                            }
                            onClick={() => {
                              setItemTarget({ action: "updateItem", order });
                              setItemQuantity(String(order.quantity));
                              setItemFormError("");
                              setOperation(null);
                            }}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Удалить ${order.article} из поставки`}
                            title={
                              canRemoveOrder(order)
                                ? "Удалить артикул из поставки"
                                : "Удаление доступно, когда свежие данные подтверждают отсутствие печати, резки и упаковки"
                            }
                            disabled={
                              !canWrite ||
                              !canRemoveOrder(order) ||
                              selected.sheet.sourceId === "box-printing"
                            }
                            onClick={() => {
                              setItemTarget({ action: "removeItem", order });
                              setItemQuantity("");
                              setItemFormError("");
                              setOperation(null);
                            }}
                          >
                            <Trash size={16} />
                          </button>
                        </div>
                      ),
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
            ? `Новые товары будут добавлены в поставку «${appendTarget?.name || ""}» по своим отделам. Существующие артикулы, их ID и выполненная работа сохранятся.`
            : "Сначала проверим станки и покажем распределение товаров по двум отделам. После подтверждения создадим производственные задания и общий состав для Assembly."
        }
      >
        <form noValidate onSubmit={submit}>
          {dialog === "create" && (
            <>
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
              <label className="supply-lock-option">
                <input
                  type="checkbox"
                  checked={lockAfterCreate}
                  disabled={busy || (!!operation && operation.status !== "failed")}
                  onChange={(event) => setLockAfterCreate(event.target.checked)}
                />
                <span>
                  <strong>Закрыть для сборки сразу после создания</strong>
                  <small>Сборщики увидят поставку, но не смогут записывать работу и работать с коробами, пока вы не снимете замок.</small>
                </span>
              </label>
            </>
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
          {routingPreview?.input === routingInputKey && (
            <div
              className="supply-write-confirmation"
              aria-label="Распределение товаров по отделам"
            >
              <strong>Распределение по станкам из базы</strong>
              <strong>
                Будет добавлено позиций: {num(routingPreview.acceptedRows)}.
                Пропущено: {num(routingPreview.skippedRows)}.
              </strong>
              {routingPreview.departments.map((dept) => (
                <span key={dept.id}>
                  {dept.name}: {num(dept.rows)} позиций · {num(dept.quantity)}{" "}
                  шт.
                </span>
              ))}
              <div style={{ maxHeight: 240, overflow: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Расширение</th>
                      <th>Станок</th>
                      <th>Отдел</th>
                      <th>Количество</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routingPreview.lines.map((line) => (
                      <tr key={line.article}>
                        <td>{line.article}</td>
                        <td>{line.department === "roll" ? line.extension || "Не найдено" : "—"}</td>
                        <td>{line.machine || "Не указан"}</td>
                        <td>
                          {line.department === "roll"
                            ? "Рулонная печать"
                            : line.department === "box"
                              ? "Бокс"
                              : `Будет пропущен: ${line.issue}`}
                        </td>
                        <td>{num(line.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {routingPreview.skippedRows > 0 && (
                <span role="status">
                  {routingPreview.acceptedRows > 0
                    ? "Неопределённые товары не будут отправлены в производство. После подтверждения их список сохранится для последующей дозагрузки."
                    : "Товары остаются в форме: можно выгрузить список и уточнить станки в базе."}
                </span>
              )}
              {routingPreview.blocked && (
                <span role="alert">
                  Нет распознанных товаров для добавления. Уточните станки в
                  базе.
                </span>
              )}
              <Button
                type="button"
                disabled={busy}
                onClick={() => setRoutingPreview(null)}
              >
                Проверить заново
              </Button>
            </div>
          )}
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
              {operation?.steps?.map((step) => (
                <span key={step.department}>
                  {step.name}: {num(step.rows)} новых позиций ·{" "}
                  {step.status === "verified"
                    ? "состав проверен"
                    : step.status === "pending"
                      ? "ожидает загрузки"
                      : "требует сверки"}
                  {step.message && <> · {step.message}</>}
                </span>
              ))}
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
                operation.status === "partial" && (
                  <Button type="button" disabled={busy} onClick={async () => {
                    setBusy(true);
                    setFormError("");
                    try {
                      const response = await fetch("/api/roll-supplies", {
                        method: "POST", credentials: "same-origin",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ action: "resume", operationId: operation.id, explicitWriteApproval: true }),
                        signal: AbortSignal.timeout(240000),
                      });
                      const data = await readRollSupplyResponse(response);
                      setOperation(data.operation);
                      setNotice(supplyOperationStatus(data.operation));
                      await reloadWriter();
                      if (data.operation.status === "verified") await onRefresh();
                    } catch (cause) {
                      setFormError(cause instanceof Error ? cause.message : "Не удалось продолжить загрузку.");
                    } finally { setBusy(false); }
                  }}>
                    Проверить и продолжить эту поставку
                  </Button>
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
                ? `Поставка «${appendTarget?.name || ""}»`
                : "Производственные задания только в отделах, к которым относятся товары"}
            </span>
            <span>
              {dialog === "append"
                ? "Новые строки получат уникальные ID и формулы; существующие позиции сдвинутся вниз вместе со своими ID и данными производства."
                : "Будут записаны артикулы, количество и уникальные ID новых строк; старые строки только в новой копии очистятся. Формулы и существующие листы не меняются."}
            </span>
            <span>
              Нажатие кнопки подтверждает добавление распознанных товаров в эту
              поставку. Пропущенные сохранятся отдельным списком.
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
                (routingPreview?.input === routingInputKey &&
                  routingPreview.blocked) ||
                !canWrite
              }
            >
              {busy
                ? "Проверяю и записываю…"
                : !routingPreview ||
                    routingPreview.input !== routingInputKey
                  ? "Проверить распределение"
                  : dialog === "append"
                    ? "Подтвердить и добавить товары"
                    : "Подтвердить и создать поставку"}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={itemTarget !== null}
        onClose={() => {
          if (!busy) {
            setItemTarget(null);
            setItemFormError("");
          }
        }}
        title={
          itemTarget?.action === "removeItem"
            ? "Удалить артикул из поставки?"
            : "Изменить количество артикула"
        }
        description={
          itemTarget
            ? `${itemTarget.order.article} · сейчас ${num(itemTarget.order.quantity)} шт.`
            : undefined
        }
      >
        <form noValidate onSubmit={submitItemChange}>
          {itemTarget?.action === "updateItem" ? (
            <>
              <Field
                label="Новое количество, шт."
                error={itemFormError || undefined}
              >
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  step={1}
                  value={itemQuantity}
                  readOnly={busy}
                  onChange={(event) => setItemQuantity(event.target.value)}
                  autoFocus
                />
              </Field>
              <div className="supply-write-confirmation">
                <strong>Уже выполненная работа сохранится</strong>
                <span>
                  Остаток печати пересчитается с учётом уже напечатанного.
                  Количество нельзя уменьшить ниже подтверждённых объёмов
                  печати, резки или упаковки.
                </span>
              </div>
            </>
          ) : itemTarget ? (
            <div className="supply-delete-warning" role="alert">
              Позиция будет убрана из списка. Удаление доступно только если
              свежие данные подтверждают, что по ней ещё не записаны печать,
              резка и упаковка.
            </div>
          ) : null}
          {itemFormError && itemTarget?.action === "removeItem" && (
            <div className="supply-operation-error" role="alert">
              {itemFormError}
            </div>
          )}
          {notice &&
            operation &&
            ["updateItem", "removeItem"].includes(operation.action) && (
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
                  setItemTarget(null);
                  setItemFormError("");
                }
              }}
              disabled={busy}
            >
              Отмена
            </Button>
            <Button
              kind={itemTarget?.action === "removeItem" ? "danger" : "primary"}
              type="submit"
              disabled={
                busy ||
                !canWrite ||
                (!!operation && operation.status !== "failed")
              }
            >
              {busy
                ? "Проверяю и сохраняю…"
                : itemTarget?.action === "removeItem"
                  ? "Удалить артикул"
                  : "Сохранить количество"}
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
        title={
          deleteTarget?.linked
            ? `Удалить участок «${deleteTarget.department === "box" ? "Бокс" : "Рулонная печать"}»?`
            : "Удалить поставку и лист?"
        }
        description={
          deleteTarget
            ? deleteTarget.linked
              ? `Будет удалён только лист участка «${deleteTarget.department === "box" ? "Бокс" : "Рулонная печать"}» для поставки «${deleteTarget.name}». Второй участок и его товары останутся в общей поставке сборщиков. Это действие нельзя отменить.`
              : `Будет удалён лист «${deleteTarget.name}» вместе с его данными в Google Sheets. Это действие нельзя отменить.`
            : undefined
        }
      >
        <form noValidate onSubmit={submitDelete}>
          <div className="supply-delete-warning" role="alert">
            {deleteTarget?.linked
              ? `Будет удалён только участок ${deleteTarget.department === "box" ? "Бокс" : "Рулонная печать"} (лист ID ${deleteTarget.sheetId}); оставшийся участок продолжит отображаться у сборщиков.`
              : `Удаление затронет только этот лист с ID ${deleteTarget?.sheetId}. Другие поставки и шаблон не изменятся.`}
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
          {notice &&
            (operation?.action === "delete" ||
              operation?.action === "deletePart") && (
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
              {busy
                ? "Удаляю и проверяю…"
                : deleteTarget?.linked
                  ? "Удалить этот участок"
                  : "Удалить лист и поставку"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
