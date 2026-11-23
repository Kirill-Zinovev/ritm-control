import {ProductionDeadlineFields} from './ProductionDeadlineFields';
import {inputInstant} from './productionForecastModel';
import {validateDeadlines} from '../shared/productionPlanning';
import { SupplyDirections } from './SupplyDirections';
import type { DirectionJob } from './supplyDirectionData';
import {DepartmentMove} from "./DepartmentMove";
import {DepartmentMoveBatch} from './DepartmentMoveBatch';
import {type DepartmentMoveOperation,type DepartmentMoveRequest} from './departmentMoveRequest';
import { AssemblyOnlyItems } from "./AssemblyOnlyItems";
import { boxPositionKey, useBoxPositionRemoval } from "./BoxPositionRemoval";
import { startWriterStatusPolling } from "./writerStatusPolling";
import { recoverableSupply } from "./supplyAutoRecovery";
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
import { LockKeyhole, Clock3, Layers3, ChevronDown, Eye, EyeOff } from "lucide-react";
import { supplyLockState, type SupplyLockRecord } from "./supplyLockState";
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
import { Button, DataTable, Empty, Field, Modal, Search } from "./ui";

type RecoverableMove = DepartmentMoveOperation & {shipmentName?: string};
function PendingMoveRecovery({onDone}:{onDone:(moves:DepartmentMoveRequest[])=>Promise<void>}) {
  const [moves,setMoves]=useState<RecoverableMove[]>([]);
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const response=await fetch('/api/roll-supplies/operations?departmentMoves=1',{cache:'no-store',signal});
    const data=await response.json();
    if(!response.ok||!Array.isArray(data.moves))throw Error(data.message||'Не удалось загрузить незавершённые переносы.');
    setMoves(data.moves);
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    const load=()=>{void refresh(controller.signal).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});};
    load();
    window.addEventListener('focus',load);
    window.addEventListener('ritm:move-changed',load);
    return ()=>{controller.abort();window.removeEventListener('focus',load);window.removeEventListener('ritm:move-changed',load);};
  },[refresh]);
  async function recover(move:RecoverableMove,action:'resume'|'cancel'){
    setBusy(move.id);setMessage('');
    try {
      const response=await fetch('/api/production-moves',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,operationId:move.id})});
      const data=await response.json();
      if(!response.ok||!data.ok)throw Error(data.message||'Проверьте состояние переноса.');
      const op=data.operation;
      if(['verified','cancelled'].includes(op.status)){
        if(sessionStorage.getItem('ritm:pending-department-move')===move.id)sessionStorage.removeItem('ritm:pending-department-move');
        setMoves(current=>current.filter(item=>item.id!==move.id));
        setMessage(op.status==='cancelled'?'Перенос отменён. Артикул остался на исходном участке.':'Перенос подтверждён.');
        await onDone(op.status === 'verified' && Array.isArray(op.input?.items) ? op.input.items :
          op.status === 'verified' && op.input ? [op.input] : []);
      }else setMessage(op.message||'Сверка ещё не завершена.');
    }catch(e){setMessage(e instanceof Error?e.message:'Проверьте состояние переноса.');}
    finally{try{await refresh();}catch{/* Keep the last confirmed result. */}setBusy('');}
  }
  if(!moves.length&&!message)return null;
  return <div className="supply-write-confirmation" role="status">{moves.map(move=><div key={move.id}>
    <strong>{move.shipmentName} · {move.input?.article} · {move.input?.quantity} шт.</strong>
    <p>{move.message||'Перенос ожидает сверки.'}</p>
    <Button disabled={!!busy} onClick={()=>void recover(move,'resume')}>Продолжить перенос</Button>{' '}
    {move.steps?.destination==='pending'&&<Button disabled={!!busy} onClick={()=>void recover(move,'cancel')}>Отменить перенос</Button>}
  </div>)}{message&&<p>{message}</p>}</div>;
}
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
  mode?: "cloud" | "local";
  assemblyV2Sync?:{pending:number;failed:number;lastDeliveredAt:number|null};
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
  updatedAt?: string;
  id: string;
  action:
    | "create"
    | "append"
    | "updateItem"
    | "removeItem"
    | "delete"
    | "deleteSupply"
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
const supplyPositionKey = (order: LiveOrder) => `${order.sourceId}:${boxPositionKey(order)}`;
type RoundingDirection = "down" | "up";
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
    rounding?: { choices: { direction: RoundingDirection; quantity: number; sheets?: number }[] };
    xeroxSheets?: number;
    xeroxIssue?: string;
    rollMultiplicity?: number;
    rollIssue?: string;
    roundingDirection?: RoundingDirection;
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

function controlIdsForSummary(summary: SheetSummary, summaries: SheetSummary[], links: AssemblyBoxLink[], sheets: SupplySheet[]) {
  const box = linkedAssemblyBoxSummary(summary, summaries, links);
  const linkedIds = links.filter((link) => link.name === summary.sheet.name && (link.targetRollSheetId == null || link.targetRollSheetId === summary.sheet.sheetId)).map((link) => link.boxSheetId);
  const linkedSheets = sheets.filter((sheet) => sheet.sourceId === "box-printing" && linkedIds.includes(sheet.sheetId));
  return [...new Set([
    summary.sheet.assemblyShipmentId || (summary.sheet.sourceId === "roll-printing" ? `RITM-ROLL-${summary.sheet.sheetId}` : summary.sheet.sourceId === "box-printing" ? `RITM-BOX-${summary.sheet.sheetId}` : ""),
    ...summary.orders.map((order) => order.assemblyShipmentId || ""),
    ...(box?.orders || []).map((order) => order.assemblyShipmentId || ""),
    ...linkedSheets.map((sheet) => sheet.assemblyShipmentId || `RITM-BOX-${sheet.sheetId}`),
  ].filter(Boolean))];
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

function SupplyOverviewStage({ label, value, plan, partial = false, tone }: {
  label: string;
  value: number | null;
  plan: number | null;
  partial?: boolean;
  tone: "blue" | "orange" | "violet";
}) {
  const percent = stagePercent(value, plan);
  return (
    <div className={`supply-overview-stage tone-${tone}`}>
      <div className="supply-overview-stage-label">
        {tone === "blue" ? <Printer size={17} /> : tone === "orange" ? <Scissors size={17} /> : <Package size={17} />}
        <span>{label}</span>
      </div>
      <strong>{value === null ? "Нет данных" : `${partial ? "≥ " : ""}${num(value)}${plan === null ? "" : ` / ${num(plan)}`} шт.`}</strong>
      {value !== null && plan !== null && percent !== null ? (
        <>
          <StageMeter value={value} plan={plan} label={label} tone={tone} />
          <small>{stagePercentLabel(percent, partial)}{partial ? " · данные неполные" : ""}</small>
        </>
      ) : <small>Нет подтверждённых данных</small>}
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
  if (["delete", "deletePart", "deleteSupply"].includes(operation.action)) {
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
    throw Object.assign(new Error(
      response.status === 401
        ? "Войдите в AI Center как владелец, чтобы управлять поставками."
        : value.reason ||
            value.message ||
            "Основной агент отклонил операцию с поставкой.",
    ), {code: value.error});
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
  const [supplyView, setSupplyView] = useState<'directions' | 'jobs'>('directions');
  const [writer, setWriter] = useState<WriterState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get("supplySheet"));
  const [search, setSearch] = useState("");
  const [onlyMissingArea, setOnlyMissingArea] = useState(false);
  const [articleSearch, setArticleSearch] = useState("");
  const [boxSearch, setBoxSearch] = useState("");
  const [verifiedSourceChanges, setVerifiedSourceChanges] = useState<Set<string>>(() => new Set());
  const [boxRemovalNotice, setBoxRemovalNotice] = useState("");
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
    wholeShipmentId?: string;
    departments?: string[];
  } | null>(null);
  const [tabVisibility, setTabVisibility] = useState<{ key: string; hidden: boolean; available: boolean } | null>(null);
  const [visibilityDialog, setVisibilityDialog] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [itemTarget, setItemTarget] = useState<{
    action: "updateItem" | "removeItem";
    order: LiveOrder;
  } | null>(null);
  const [itemQuantity, setItemQuantity] = useState("");
  const [itemFormError, setItemFormError] = useState("");
  const [name, setName] = useState("");
  const [productionReadyAt,setProductionReadyAt] = useState("");
  const [packingAt,setPackingAt] = useState("");
  const [shippingAt,setShippingAt] = useState("");
  const [lockAfterCreate, setLockAfterCreate] = useState(false);
  const [supplyPriority, setSupplyPriority] = useState<"normal" | "urgent">("normal");
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
  const [listLocks, setListLocks] = useState<SupplyLockRecord[] | null>(null);
  const listLocksRef = useRef<SupplyLockRecord[] | null>(null);
  const lockReadSequence = useRef(0);
  const refreshListLocks = useCallback(async () => {
    const sequence = ++lockReadSequence.current;
    try {
      const response = await fetch("/api/shipment-locks", {cache: "no-store", credentials: "same-origin"});
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.locks) || result.locks.some((item: SupplyLockRecord) => !item || typeof item.shipmentId !== "string" || typeof item.locked !== "boolean" || typeof item.pending !== "boolean" || !["locking", "locked", "unlocking", "unlocked"].includes(item.status))) throw new Error("Статус сборки недоступен");
      if (sequence === lockReadSequence.current) { listLocksRef.current = result.locks; setListLocks(result.locks); }
    } catch {
      if (sequence === lockReadSequence.current) { listLocksRef.current = null; setListLocks(null); }
    }
  }, []);
  const updateListLocks = useCallback((locks: SupplyLockRecord[]) => {
    if (!listLocksRef.current) return;
    ++lockReadSequence.current;
    const merged = [...listLocksRef.current.filter((item) => !locks.some((lock) => lock.shipmentId === item.shipmentId)), ...locks];
    listLocksRef.current = merged;
    setListLocks(merged);
  }, []);
  useEffect(() => {
    void refreshListLocks();
    const onFocus = () => { if (document.visibilityState === "visible") void refreshListLocks(); };
    const timer = window.setInterval(onFocus, 60000);
    window.addEventListener("focus", onFocus);
    return () => { ++lockReadSequence.current; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refreshListLocks]);
  const [routingPreview, setRoutingPreview] = useState<RoutingPreview | null>(
    null,
  );
  const [recoveryError, setRecoveryError] = useState("");
  const operationId = useRef("");
  const autoRecovery = useRef(new Map<string, number>());
  const autoRecovering = useRef(false);
  const routingInputKey = JSON.stringify([dialog, name, itemsText, appendTarget, dialog === "create" && productionReadyAt, dialog === "create" && packingAt, dialog === "create" && shippingAt, dialog === "create" && lockAfterCreate, dialog === "create" && supplyPriority]);
  const summaries = useMemo(() => buildSummaries(live && verifiedSourceChanges.size ? {
    ...live, supplies: live.supplies.filter(order => !verifiedSourceChanges.has(supplyPositionKey(order))),
  } : live), [live, verifiedSourceChanges]);
  useEffect(() => {
    if (!live || live.stale || live.refreshFailed || live.refreshInProgress) return;
    setVerifiedSourceChanges(previous => {
      if (!previous.size) return previous;
      const existing = new Set(live.supplies.map(supplyPositionKey));
      const retained = new Set([...previous].filter(key => existing.has(key)));
      return retained.size === previous.size ? previous : retained;
    });
  }, [live]);
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
        if (supply.id.startsWith('RITM-ROLL-')) {
          links[existing] = {...links[existing],targetRollSheetId:roll.sheet.sheetId,boxRows:box.orders.length,boxQuantity:box.orders.reduce((sum,order)=>sum+order.quantity,0),positionKeys:undefined};
        }
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
    await Promise.all([onRefresh(), refreshAssemblyBoxLinks(), refreshListLocks()]);
  }, [onRefresh, refreshAssemblyBoxLinks, refreshListLocks]);
  const confirmMoves = async (moves: DepartmentMoveRequest[]) => {
    if (moves.length) {
      const keys = (live?.supplies || []).filter(order => moves.some(move =>
        order.uid === move.uid && order.article === move.article && order.quantity === move.quantity &&
        order.sourceId === `${move.sourceDepartment || "box"}-printing`)).map(supplyPositionKey);
      setVerifiedSourceChanges(previous => new Set([...previous, ...keys]));
      setBoxRemovalNotice("Перенос подтверждён. Состав «RITM Сборка» обновляется.");
    }
    void refreshSupplyData().catch(() => {});
  };
  const boxRemoval = useBoxPositionRemoval(key => {
    setVerifiedSourceChanges(previous => new Set([...previous, `box-printing:${key}`]));
    setBoxRemovalNotice("Артикул удалён из таблицы бокса. Состав «RITM Сборка» обновляется.");
    void Promise.all([onRefresh(), refreshAssemblyBoxLinks()]).catch(() => {});
  });
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
  const directionJobs = useMemo<DirectionJob[]>(() => {
    const linked = new Set(
      effectiveBoxLinks
        .filter((link) => link.targetRollSheetId !== null)
        .map((link) => link.boxSheetId),
    );
    return summaries
      .filter(
        (summary) =>
          summary.sheet.sourceId !== "box-printing" ||
          !linked.has(summary.sheet.sheetId),
      )
      .map((summary) => {
        const box = linkedAssemblyBoxSummary(
          summary,
          summaries,
          effectiveBoxLinks,
        );
        return {
          id: `${summary.sheet.sourceId}:${summary.sheet.sheetId}`,
          name: summary.sheet.name,
          orders: [...summary.orders, ...(box?.orders || [])],
          missingPositions: box?.missingPositions || 0,
          lock: supplyLockState(
            controlIdsForSummary(
              summary,
              summaries,
              effectiveBoxLinks,
              live?.sheets || [],
            ),
            listLocks,
          ),
        };
      });
  }, [summaries, effectiveBoxLinks, listLocks, live?.sheets]);
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
  const selectedControlShipmentIds = selected ? controlIdsForSummary(selected, summaries, effectiveBoxLinks, live?.sheets || []) : [];
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
    setArticleSearch("");
    setBoxSearch("");
  }, [selected?.sheet.sourceId, selected?.sheet.sheetId]);
  const activeBoxOrders = useMemo(() => selectedBox?.orders || [], [selectedBox]);
  const boxOrders = useMemo(() => activeBoxOrders.filter(
    order => order.article.toUpperCase().includes(boxSearch.trim().toUpperCase()),
  ), [activeBoxOrders, boxSearch]);
  const selectedOrders = useMemo(
    () => (selected?.orders || []).filter(order =>
      !onlyMissingArea || order.areaKnown === false),
    [selected, onlyMissingArea],
  );
  const visibleOrders = useMemo(() => selectedOrders.filter(
    order => order.article.toUpperCase().includes(articleSearch.trim().toUpperCase()),
  ), [selectedOrders, articleSearch]);
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
    !pendingProduction &&
    !boxRemoval.pending;
  const writeBlockedReason = !writer?.available
    ? writer?.reason || "Проверьте доступ к управлению поставками"
    : boxRemoval.pending
      ? "Сначала завершите проверку удаления артикула"
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
  // Transfer validates both sheets, quantities and work against live sources
  // under the server lease; a refreshing dashboard must not block it.
  const canMove = !!writer?.available && !!live && !busy && !pendingProduction;
  const moveBlockedReason = !writer?.available ? writer?.reason || 'Нет доступа к управлению поставками' : !live ? 'Дождитесь загрузки поставки' : busy ? 'Сохраняем операцию' : pendingProduction ? 'Предыдущая операция поставки требует проверки' : undefined;
  const selectedDepartment =
    selected?.sheet.sourceId === "box-printing" ? "box" : "roll";
  const selectedManagedSupply =
    selected &&
    writer?.production?.supplies?.find((s) =>
      s.parts.some(
        (p) =>
          p.department === selectedDepartment &&
          p.sheetId === selected.sheet.sheetId,
      ),
    );
  const selectedProductionPart = !!selectedManagedSupply;
  const tabName = selected?.sheet.name;
  const tabId = selected?.sheet.sheetId;
  const tabSource = selected?.sheet.sourceId;
  const visibilityKey = JSON.stringify([tabSource, tabId, tabName]);
  useEffect(() => {
    setVisibilityDialog(false);
    setVisibilityError("");
    if (!tabName || tabId === undefined || !["roll-printing", "box-printing"].includes(tabSource || "") ||
        tabId === writer?.template?.sheetId) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ department: selectedDepartment, sheetId: String(tabId), name: tabName });
    void fetch("/api/production-tabs?" + query, {cache:"no-store",signal:abort.signal})
      .then(response => readRollSupplyResponse(response))
      .then(data => setTabVisibility({ key: visibilityKey, hidden: data.hidden === true, available: data.available === true }))
      .catch(() => {});
    return () => abort.abort();
  }, [visibilityKey, tabName, tabId, tabSource, selectedDepartment, writer?.template?.sheetId]);
  const visibility = tabVisibility?.key === visibilityKey ? tabVisibility : null;
  const changeTabVisibility = async () => {
    if (!visibility || tabId === undefined || !tabName || visibilityBusy) return;
    setVisibilityBusy(true);
    setVisibilityError("");
    try {
      const result = await readRollSupplyResponse(await fetch("/api/production-tabs", {
        method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"},
        body:JSON.stringify({department:selectedDepartment,sheetId:tabId,name:tabName,hidden:!visibility.hidden}),
        signal:AbortSignal.timeout(45000),
      }));
      setTabVisibility({ key: visibilityKey, hidden: result.hidden === true, available: true });
      setVisibilityDialog(false);
      setNotice(result.hidden ? `Вкладка «${tabName}» скрыта в Google Таблицах.` : `Вкладка «${tabName}» снова видна в Google Таблицах.`);
    } catch (error) {
      setVisibilityError(error instanceof Error ? error.message : "Видимость листа пока не подтверждена.");
    } finally {
      setVisibilityBusy(false);
    }
  };
  const moveShipmentIdForBox = (sheetId:number) => writer?.production?.supplies?.find(s=>s.parts.some(p=>p.department==='box'&&p.sheetId===sheetId))?.id || (()=>{const links=assemblyBoxLinks.filter(l=>l.boxSheetId===sheetId&&Number.isSafeInteger(l.targetRollSheetId));return links.length===1?`RITM-ROLL-${links[0].targetRollSheetId}`:'';})();
  const selectedMoveShipmentId = selected ? writer?.production?.supplies?.find(s=>s.parts.some(p=>p.department===selectedDepartment&&p.sheetId===selected.sheet.sheetId))?.id || (selectedDepartment==='box'?moveShipmentIdForBox(selected.sheet.sheetId):assemblyBoxLinks.filter(l=>l.targetRollSheetId===selected.sheet.sheetId).length===1?`RITM-ROLL-${selected.sheet.sheetId}`:'') : '';
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
  const removalSource = boxRemoval.pending && writer?.production?.supplies?.filter(s =>
    s.parts.some(p => p.department === 'box' && p.sheetId === boxRemoval.pending?.sheetId));
  const removalTarget = selected && writer?.production?.supplies?.filter(s =>
    s.parts.some(p => p.department === 'roll' && p.sheetId === selected.sheet.sheetId));
  const independentRemoval = selectedDepartment === 'roll' && removalSource?.length === 1 &&
    removalTarget?.length === 1 && removalSource[0].id !== removalTarget[0].id;
  // Single-position writes verify the selected sheet and work journals on
  // the server, so an older reporting snapshot can still supply a request.
  const canWriteItem = !!writer?.available && !!selected && !busy && !writer.busy &&
    !pendingProduction && (!boxRemoval.pending || !!independentRemoval);
  const canRemoveOrder = (order: LiveOrder) =>
    (order.packed ?? 0) === 0 &&
    (order.packingRecords ?? 0) === 0 &&
    (rollPrinted(order) ?? 0) === 0 &&
    (rollCut(order) ?? 0) === 0;
  const boxRemovalReason = (order: LiveOrder) => {
    if (!(writer?.production?.available ?? writer?.available)) return writer?.reason || "Нет доступа к изменению поставки";
    if (boxRemoval.pending) return "Завершите проверку предыдущего удаления";
    if (busy || boxRemoval.busy) return "Дождитесь завершения текущей операции";
    if ((rollPrinted(order) ?? 0) > 0 || (rollCut(order) ?? 0) > 0 || (order.packed ?? 0) > 0 || (order.packingRecords ?? 0) > 0)
      return "По артикулу уже есть работа";
    return undefined;
  };
  const removalAction = (order: LiveOrder, reason: string | undefined, onClick: () => void) => (
    <span title={reason}>
      <Button className="supply-item-remove" disabled={!!reason} onClick={onClick}
        aria-label={`Удалить ${order.article} из поставки`}>
        <Trash size={15} /> Удалить
      </Button>
    </span>
  );
  const removeBoxAction = (order: LiveOrder) => removalAction(order, boxRemovalReason(order), () => boxRemoval.open(order));

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

  const confirmRollRemoval = useCallback((order: LiveOrder) => {
    setVerifiedSourceChanges(previous => new Set([...previous, supplyPositionKey(order)]));
    setItemTarget(null);
    setItemFormError("");
    setNotice(`Артикул «${order.article}» удалён. Состав «RITM Сборка» обновляется.`);
    void Promise.all([reloadWriter(), onRefresh()]).catch(() => {});
  }, [reloadWriter, onRefresh]);

  useEffect(() => {
    if (busy || itemTarget?.action !== "removeItem" || operation?.action !== "removeItem" ||
        !["writing", "checking", "uncertain", "written_unverified"].includes(operation.status)) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      try {
        const response = await fetch(`/api/roll-supplies/operations?removalId=${operation.id}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        const { operation: receipt } = await readRollSupplyResponse(response);
        if (controller.signal.aborted) return;
        if (receipt?.status === "verified" || receipt?.status === "verified_with_calculation_errors") {
          setOperation({ ...operation, ...receipt });
          confirmRollRemoval(itemTarget.order);
          return;
        }
        if (receipt?.status === "failed" || !receipt) {
          const result = { ...operation, ...receipt, status: receipt?.status || "retry_same_request" };
          setOperation(result);
          setNotice(receipt ? supplyOperationStatus(result) : "Запрос пока не найден. Можно проверить запись повторно.");
          return;
        }
        const result = { ...operation, ...receipt };
        setOperation(result);
        setNotice(supplyOperationStatus(result));
      } catch { /* The operation keeps its original ID across retries. */ }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 4000);
    };
    timer = window.setTimeout(poll, 1200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [busy, itemTarget, operation?.id, operation?.action, operation?.status, confirmRollRemoval]);

  useEffect(() => {
    void reloadWriter();
    const timer = window.setInterval(() => { if(document.visibilityState === "visible") void reloadWriter(); }, 10000);
    return () => window.clearInterval(timer);
  }, [reloadWriter]);

  useEffect(() => {
    if (busy || !(writer?.busy || ["writing", "checking"].includes(pendingProduction?.status || ""))) return;
    return startWriterStatusPolling(reloadWriter);
  }, [writer?.busy, pendingProduction?.status, busy, reloadWriter]);

  useEffect(() => {
    if (!operation || operation.status === "verified") return;
    const confirmed = writer?.production?.operations?.find(item => item.id === operation.id && item.status === "verified");
    if (!confirmed) return;
    setOperation(confirmed);
    setFormError("");
    setBusy(false);
    if (operationId.current === confirmed.id) setDialog(null);
    setNotice(supplyOperationStatus(confirmed));
    void onRefresh();
  },[writer?.production?.operations,operation?.id,operation?.status,onRefresh]);

  useEffect(() => {
    const item = pendingProduction;
    const attempts = item ? autoRecovery.current.get(item.id) || 0 : 0;
    if (busy || autoRecovering.current || !recoverableSupply(item,writer?.busy,attempts)) return;
    const timer = window.setTimeout(async () => {
      if (!item || autoRecovering.current || document.visibilityState !== "visible") return;
      autoRecovering.current = true;
      autoRecovery.current.set(item.id,attempts+1);
      setNotice("Автоматически сверяем сохранённую поставку и завершаем загрузку…");
      try {
        const response = await fetch("/api/roll-supplies", {method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({action:"resume",operationId:item.id,explicitWriteApproval:true}),signal:AbortSignal.timeout(240000)});
        const data = await readRollSupplyResponse(response), result = data.operation as Operation;
        setOperation(current => current?.id === result.id ? result : current);
        setNotice(supplyOperationStatus(result));
        if (result.status === "verified") {
          autoRecovery.current.delete(item.id);
          if (operationId.current === item.id) {
            setFormError("");
            setDialog(null);
          }
          void onRefresh();
        }
      } catch (cause) {
        setRecoveryError(cause instanceof Error?cause.message:"Автоматическая сверка пока не подтверждена. Сохранённый запрос остаётся в истории.");
      } finally {
        autoRecovering.current = false;
        void reloadWriter();
      }
    },Math.min(60000,2500*2**attempts));
    return () => window.clearTimeout(timer);
  },[pendingProduction?.id,pendingProduction?.status,pendingProduction?.updatedAt,writer?.busy,busy,onRefresh,reloadWriter]);

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
    setProductionReadyAt("");
    setPackingAt("");
    setShippingAt("");
    setLockAfterCreate(false);
    setSupplyPriority("normal");
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

  const routingAvailable = writer?.production?.available ?? writer?.available;
  const needsPreview = !routingPreview || routingPreview.input !== routingInputKey;
  const previewLines = needsPreview ? [] : routingPreview.lines;
  const roundedLines = previewLines.map(line => {
    const choice = line.rounding?.choices.find(option => option.direction === line.roundingDirection);
    return { ...line, plannedQuantity: choice?.quantity ?? line.quantity };
  });
  const pendingRounding = previewLines.some(line => line.rounding && !line.roundingDirection);
  const plannedRows = roundedLines.filter(line => line.department && line.plannedQuantity > 0);
  const skippedRows = roundedLines.length - plannedRows.length;
  // Routing reads the catalog. Creating a shipment allocates fresh sheets and
  // validates them on the server independently of the reporting snapshot.
  const formAvailable = dialog === "create" || needsPreview ? routingAvailable : canWrite;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dialog || (!appendTarget && dialog === "append")) return;
    if (!formAvailable) {
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
      if (dialog === "create") validateDeadlines({readyAt:inputInstant(productionReadyAt),packingAt:inputInstant(packingAt),shipAt:inputInstant(shippingAt)});
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
            ...(dialog === "create" ? { lockAfterCreate, planning:{readyAt:inputInstant(productionReadyAt),packingAt:inputInstant(packingAt),shipAt:inputInstant(shippingAt)}, priority: supplyPriority } : {}),
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
    if (routingPreview.blocked || pendingRounding || plannedRows.length === 0) {
      setFormError(
        pendingRounding
          ? "Выберите округление для каждой отмеченной позиции."
          : "Добавьте хотя бы одну распознанную позицию с количеством больше нуля.",
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
      rows: plannedRows.length,
      message: null,
      spreadsheetUrl: "",
    };
    setOperation(pendingOperation);
    setNotice(supplyOperationStatus(pendingOperation));
    const requestOperationId = operationId.current;
    try {
      const choicesFor = (department: "roll" | "box") => previewLines.flatMap(line =>
        line.department === department && line.roundingDirection
        ? [{article: line.article, direction: line.roundingDirection}]
        : []);
      const xeroxRounding = choicesFor("box");
      const rollRounding = choicesFor("roll");
      const payload = {
        action: dialog,
        explicitWriteApproval: true,
        operationId: requestOperationId,
        name: dialog === "append" ? appendTarget!.name : name.trim(),
        lines,
        previewId: routingPreview.id,
        ...(xeroxRounding.length ? { xeroxRounding } : {}),
        ...(rollRounding.length ? { rollRounding } : {}),
        ...(dialog === "create" ? { lockAfterCreate, planning:{readyAt:inputInstant(productionReadyAt),packingAt:inputInstant(packingAt),shipAt:inputInstant(shippingAt)}, priority: supplyPriority } : {}),
        ...(dialog === "append"
          ? {
              sheetId: appendTarget!.sheetId,
              department: appendTarget!.department,
            }
          : {}),
      };
      const send = () => fetch("/api/roll-supplies", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(240000),
      });
      let response = await send();
      for (let retry = 0; response.status === 409; retry++) {
        const reason = await response.clone().json().catch(() => null);
        if (reason?.error !== "supply_writer_occupied") break;
        if (retry >= 3) {
          setOperation(null);
          setNotice("");
          setFormError("Сервер всё ещё занят. Список и распределение сохранены в форме. Повторите подтверждение.");
          return;
        }
        setNotice("Ожидаем свободную запись. Продолжим автоматически…");
        await new Promise(resolve => window.setTimeout(resolve, 1000 * (retry + 1)));
        response = await send();
      }
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
      const code = (cause as {code?: string})?.code;
      if (code === "production_routing_changed" || code === "production_preview_required" || code?.startsWith("production_xerox_")) {
        setOperation(null);
        setNotice("");
        if (code === "production_routing_changed" || code === "production_preview_required") setRoutingPreview(null);
        return;
      }
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
    const action = deleteTarget.wholeShipmentId ? "deleteSupply" : deleteTarget.linked ? "deletePart" : "delete";
    const pendingOperation: Operation = {
      id,
      action,
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
          action,
          explicitWriteApproval: true,
          operationId: id,
          name: deleteTarget.name,
          ...(deleteTarget.wholeShipmentId ? { shipmentId: deleteTarget.wholeShipmentId } : {
            sheetId: deleteTarget.sheetId,
            ...(deleteTarget.linked ? { department: deleteTarget.department } : {}),
          }),
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
    if (!canWriteItem) {
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
    const id = action === "removeItem" && operation?.status === "retry_same_request"
      ? operation.id : crypto.randomUUID();
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
        if (action === "removeItem") confirmRollRemoval(order);
        else {
          void Promise.all([reloadWriter(), onRefresh()]).catch(() => {});
        }
        if (action === "updateItem" && result.status === "verified") {
          setItemTarget(null);
          setItemQuantity("");
          setNotice(`Количество «${order.article}» обновлено.`);
        }
      }
    } catch (cause) {
      setItemFormError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подтвердить изменение артикула.",
      );
      if (action === "removeItem") setOperation({ ...pendingOperation, status: "checking" });
      else await checkOperation(id);
    } finally {
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
          <a className="button secondary" href="https://assembly-v2.zinovevkirill234.chatgpt.site" target="_blank" rel="noreferrer">RITM Сборка <ArrowSquareOut size={17}/></a>
          {writer && writer.mode !== "cloud" && <AssemblyTransfer onDelivered={() => void refreshSupplyData()} />}
          <Button onClick={() => void refreshSupplyData()} disabled={loading}>
            <Package size={17} />
            {loading ? "Обновляю…" : "Обновить данные"}
          </Button>
          <Button
            kind="primary"
            onClick={() => openDialog("create")}
            disabled={busy}
          >
            <Plus size={18} />
            Новая поставка
          </Button>
        </div>
      </div>
      {!canWrite && writeBlockedReason && <p className="supply-write-wait" role="status">{writeBlockedReason}</p>}
      {writer?.assemblyV2Sync ? <p className="supply-write-wait" role="status">RITM Сборка · {writer.assemblyV2Sync.pending ? `ожидают подтверждения ${num(writer.assemblyV2Sync.pending)} передач` : 'доставка поставок подтверждена'}{writer.assemblyV2Sync.failed ? ' · связь повторяется автоматически' : ''}.</p> : null}
      <PendingMoveRecovery onDone={confirmMoves}/>
      {boxRemovalNotice && <div className="supply-operation-result success" role="status">{boxRemovalNotice}</div>}
      {boxRemoval.pending && <div className="supply-operation-result warning" role="status">
        <strong>{boxRemoval.busy ? `Проверяем удаление ${boxRemoval.pending.article}…` : `Удаление ${boxRemoval.pending.article} требует подтверждения`}</strong>
        <Button onClick={boxRemoval.resume} disabled={boxRemoval.busy}>Проверить удаление</Button>
      </div>}
      {boxRemoval.backgroundMessage && <p className="supply-operation-error" role="alert">{boxRemoval.backgroundMessage}</p>}
      {boxRemoval.dialog}

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
                  : ["deletePart", "deleteSupply"].includes(item.action)
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
                  {["deletePart", "deleteSupply"].includes(item.action)
                    ? "Проверить и продолжить удаление"
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

      <div className="supplies-view-switch" aria-label="Вид поставок">
        <Button
          className={supplyView === "directions" ? "is-active" : ""}
          aria-pressed={supplyView === "directions"}
          onClick={() => setSupplyView("directions")}
        >
          Сборка по направлениям
        </Button>
        <Button
          className={supplyView === "jobs" ? "is-active" : ""}
          aria-pressed={supplyView === "jobs"}
          onClick={() => setSupplyView("jobs")}
        >
          Производственные задания
        </Button>
      </div>
      {supplyView === "directions" && live && (
        <SupplyDirections
          jobs={directionJobs}
          selectedJobId={selectedId || ""}
          onShowJobs={() => setSupplyView("jobs")}
          onOpenJob={(id) => {
            setSearch("");
            setSelectedId(id);
            setSupplyView("jobs");
          }}
        />
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
      ) : supplyView === 'jobs' ? (
        <div className="live-supplies-layout">
          <section className="panel live-supply-list">
            <div className="live-supply-list-heading">
              <strong>Поставки</strong>
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
            {listLocks === null && <small className="supply-lock-load-note">Статусы сборки проверяются или недоступны</small>}
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
                const lock = supplyLockState(controlIdsForSummary(summary, summaries, effectiveBoxLinks, live?.sheets || []), listLocks);
                return (
                  <button
                    className={`live-supply-list-item ${selected?.sheet.sheetId === summary.sheet.sheetId && selected?.sheet.sourceId === summary.sheet.sourceId ? "selected" : ""}${lock === "closed" ? " is-closed" : ""}`}
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
                    <span className="supply-list-content">
                      <strong>{summary.sheet.name}</strong>
                      {(lock === "closed" || lock === "partial" || lock === "pending") && <span className={`supply-list-lock is-${lock}`}>
                        {lock === "pending" ? <Clock3 size={12} /> : <LockKeyhole size={12} />}
                        {lock === "closed" ? "Закрыта для сборки" : lock === "partial" ? "Частично закрыта" : "Статус меняется"}
                      </span>}
                      <span className="supply-list-total">
                        {num(summary.orders.length + (box?.positions || 0))} поз. · {box && box.quantity === null ? "план не подтверждён" : `${num(summary.planned + (box?.quantity || 0))} шт.`}
                      </span>
                      <span className="supply-list-departments">
                        {summary.sheet.sourceId !== "box-printing" && <span><b className="supply-list-dept-tag roll">Рулон</b>{num(summary.orders.length)} поз. · {num(summary.planned)} шт.</span>}
                        {box && <span><b className="supply-list-dept-tag box">Бокс</b>{num(box.positions)} поз. · {box.quantity === null ? "нет данных" : `${num(box.quantity)} шт.`}</span>}
                        {summary.sheet.sourceId === "box-printing" && <span><b className="supply-list-dept-tag box">Бокс</b>{num(summary.orders.length)} поз. · {num(summary.planned)} шт.</span>}
                      </span>
                      <span className="supply-list-area"><Layers3 size={14} />{area.observed > 0 ? `${num(area.total ?? 0, 2)} м²${area.missing ? ` · без площади: ${num(area.missing)}` : ""}` : "Площадь не определена"}</span>
                    </span>
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
                    {visibility?.available && <Button disabled={visibilityBusy || busy} onClick={() => {
                      setVisibilityError("");
                      setVisibilityDialog(true);
                    }}>
                      {visibility.hidden ? <Eye size={16}/> : <EyeOff size={16}/>}
                      {visibility.hidden ? "Вернуть вкладку" : "Скрыть вкладку"}
                    </Button>}
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
                    {selectedManagedSupply && <Button kind="danger" disabled={!canDeleteSelected}
                      onClick={() => {
                        setDeleteTarget({
                          name: selectedManagedSupply.name,
                          sheetId: selected.sheet.sheetId,
                          department: selectedDepartment,
                          linked: true,
                          wholeShipmentId: selectedManagedSupply.id,
                          departments: selectedManagedSupply.parts.map(part => part.department),
                        });
                        setDeleteConfirmation("");
                        setFormError("");
                      }}>
                      <Trash size={16}/> Удалить поставку целиком
                    </Button>}
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
                      {selectedBox ? "Позиций в «RITM Сборка»" : "Артикулов"}
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
                        ? "План «RITM Сборка», шт."
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

              <section className="supply-overview-stages" aria-label="Готовность поставки">
                {selected.sheet.sourceId !== "box-printing" && <>
                  <SupplyOverviewStage label="Печать · рулон" value={selected.printed} plan={selected.planned} tone="blue" />
                  <SupplyOverviewStage label="Порезка · рулон" value={selected.cut} plan={selected.planned} partial={selected.cutMissingOrders > 0} tone="orange" />
                </>}
                {selectedBox && selectedBoxPrintedProgress && selectedBoxCutProgress && <>
                  <SupplyOverviewStage label="Печать · бокс" value={selectedBoxPrintedProgress.total} plan={selectedBox.quantity} partial={selectedBoxPrintedProgress.missing > 0} tone="blue" />
                  <SupplyOverviewStage label="Порезка · бокс" value={selectedBoxCutProgress.total} plan={selectedBox.quantity} partial={selectedBoxCutProgress.missing > 0} tone="orange" />
                </>}
                {selected.sheet.sourceId === "box-printing" && <>
                  <SupplyOverviewStage label="Печать · бокс" value={selected.printed} plan={selected.planned} tone="blue" />
                  <SupplyOverviewStage label="Порезка · бокс" value={selected.cut} plan={selected.planned} partial={selected.cutMissingOrders > 0} tone="orange" />
                </>}
                <SupplyOverviewStage label="Сборка · упаковка" value={live?.packing?.status === "unavailable" ? null : selectedAssemblyPacking.total} plan={selectedAssemblyPlan} partial={packingPartial} tone="violet" />
              </section>

              <AssemblyOnlyItems shipmentId={selectedControlShipmentIds[0] || ""} />

              <ProductionControls
                shipmentIds={selectedControlShipmentIds}
                shipmentName={selected.sheet.name}
                articles={Array.from(new Set(selectedAssemblyOrders.map((order) => order.article).filter(Boolean)))}
                onLocksChanged={updateListLocks}
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
                      <strong>Упаковка · «RITM Сборка»</strong>
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
                        label="Готовность упаковки по журналу «RITM Сборка»"
                        tone="violet"
                      />
                    ) : (
                      <p className="live-supply-stage-empty">
                        {live?.packing?.status === "unavailable"
                          ? live.packing.reason || "WorkLog сейчас недоступен."
                          : selectedAssemblyPlan === null
                            ? "План «RITM Сборка» не подтверждён"
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

              <section className="panel supply-composition">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {selected.sheet.sourceId === "box-printing"
                        ? "Состав бокса"
                        : "Состав рулонной печати"}
                    </h2>
                    <small>
                      {num(selectedOrders.length)} поз. · План и выполнение по артикулам
                    </small>
                  </div>
                  <div className="live-supply-table-actions">
                    <DepartmentMoveBatch sourceDepartment={selectedDepartment} positions={selectedOrders.map(order => ({shipmentId:selectedMoveShipmentId,uid:order.uid,article:order.article,quantity:order.quantity,printed:rollPrinted(order),cut:rollCut(order)}))} disabled={!canMove || !selectedMoveShipmentId} disabledReason={moveBlockedReason} onDone={confirmMoves}/>
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
                <div className="supply-composition-toolbar">
                  <Search value={articleSearch} onChange={setArticleSearch} label="Найти артикул в составе" />
                  {articleSearch.trim() && <span role="status">Найдено {num(visibleOrders.length)} из {num(selectedOrders.length)}</span>}
                </div>
                {visibleOrders.length === 0 ? <p className="supply-composition-empty">Артикулы не найдены</p> : <DataTable
                  rows={visibleOrders}
                  rowKey={(order) => order.uid}
                  label={`Состав поставки ${selected.sheet.name}`}
                  pageSize={20}
                  columns={[
                    {
                      id: "article",
                      label: "Артикул",
                      sort: (order) => order.article,
                      render: (order) => <strong>{order.article}</strong>,
                    },
                    {
                      id: "plan",
                      label: "План, шт.",
                      sort: (order) => order.quantity,
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
                      label: "Напечатано",
                      render: (order) =>
                        rollPrinted(order) === null
                          ? "—"
                          : num(rollPrinted(order)!),
                    },
                    {
                      id: "cut",
                      label: "Порезано",
                      render: (order) =>
                        rollCut(order) === null ? "—" : num(rollCut(order)!),
                    },
                    {
                      id: "packed",
                      label: "Упаковано",
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
                          {<DepartmentMove sourceDepartment={selectedDepartment} shipmentId={selectedMoveShipmentId} uid={order.uid} article={order.article} quantity={order.quantity} printed={rollPrinted(order)} cut={rollCut(order)} disabledReason={moveBlockedReason} disabled={!canMove || !selectedMoveShipmentId} onDone={confirmMoves} />}
                          {selectedDepartment === "roll" && <button
                            type="button"
                            aria-label={`Изменить количество ${order.article}`}
                            title={
                              selected.sheet.sourceId === "box-printing"
                                ? "Количество в боксе можно изменить в исходном листе"
                                : !canWriteItem ? writeBlockedReason || "Дождитесь обновления состава" : "Изменить количество"
                            }
                            disabled={
                              !canWriteItem ||
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
                          </button>}
                          {selectedDepartment === "box" ? removeBoxAction(order) : removalAction(
                            order,
                            !canWriteItem ? writeBlockedReason || "Дождитесь обновления состава" :
                              canRemoveOrder(order) ? undefined : (order.packed ?? 0) > 0 ? `Учтена упаковка ${num(order.packed!)} шт. Удаление требует сверки с «RITM Сборка».` : "По артикулу уже есть работа",
                            () => {
                              setItemTarget({ action: "removeItem", order });
                              setItemQuantity("");
                              setItemFormError("");
                              setOperation(null);
                            },
                          )}
                        </div>
                      ),
                    },
                  ]}
                />}
              </section>
              {selectedBox && <section className="panel supply-composition">
                <details className="supply-box-transfer">
                  <summary><span><strong>Товары бокса</strong><small>{num(activeBoxOrders.length)} поз.</small></span><span className="supply-box-transfer-toggle"><span className="when-closed">Раскрыть список</span><span className="when-open">Свернуть список</span><ChevronDown size={18}/></span></summary>
                  <div className="supply-composition-toolbar">
                    <Search value={boxSearch} onChange={setBoxSearch} label="Найти артикул в боксе" />
                    {boxSearch.trim() && <span role="status">Найдено {num(boxOrders.length)} из {num(activeBoxOrders.length)}</span>}
                    <div className="supply-composition-toolbar-end">
                      <DepartmentMoveBatch sourceDepartment="box" positions={activeBoxOrders.map(order => ({shipmentId:moveShipmentIdForBox(order.sheetId),uid:order.uid,article:order.article,quantity:order.quantity,printed:rollPrinted(order),cut:rollCut(order)}))} disabled={!canMove} disabledReason={moveBlockedReason} onDone={confirmMoves}/>
                    </div>
                  </div>
                  {boxOrders.length === 0 ? <p className="supply-composition-empty">{boxSearch ? "Артикулы не найдены" : "В боксе нет позиций"}</p> :
                    <DataTable rows={boxOrders} rowKey={boxPositionKey} label="Состав бокса" pageSize={10} columns={[
                      {id:'article',label:'Артикул',sort:order=>order.article,render:order=><strong>{order.article}</strong>},
                      {id:'quantity',label:'План, шт.',sort:order=>order.quantity,render:order=>num(order.quantity)},
                      {id:'printed',label:'Напечатано',render:order=>rollPrinted(order) === null ? "—" : num(rollPrinted(order)!)},
                      {id:'cut',label:'Порезано',render:order=>rollCut(order) === null ? "—" : num(rollCut(order)!)},
                      {id:'move',label:'Действия',render:order=><div className="live-supply-row-actions">
                        <DepartmentMove shipmentId={moveShipmentIdForBox(order.sheetId)} uid={order.uid} article={order.article} quantity={order.quantity} printed={rollPrinted(order)} cut={rollCut(order)} disabledReason={moveBlockedReason} disabled={!canMove || !moveShipmentIdForBox(order.sheetId)} onDone={confirmMoves}/>
                        {removeBoxAction(order)}
                      </div>},
                    ]}/>
                  }
                </details>
              </section>}
            </div>
          ) : null}
        </div>
      ) : null}

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
            : "Сначала проверим станки и покажем распределение товаров по двум отделам. После подтверждения создадим производственные задания и общий состав для «RITM Сборка»."
        }
      >
        <form noValidate onSubmit={submit}>
          {!formAvailable && <p className="supply-write-wait" role="status">{routingAvailable === undefined ? "Проверяем доступ к поставкам…" : writeBlockedReason || "Проверьте доступ к управлению поставками"}</p>}
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
              <ProductionDeadlineFields ready={productionReadyAt} packing={packingAt} ship={shippingAt} onReady={setProductionReadyAt} onPacking={setPackingAt} onShip={setShippingAt} disabled={busy || (!!operation && operation.status !== "failed")}/>
              <Field label="Приоритет поставки">
                <select value={supplyPriority} onChange={(event) => setSupplyPriority(event.target.value as "normal" | "urgent")} disabled={busy || (!!operation && operation.status !== "failed")}>
                  <option value="normal">Обычная</option>
                  <option value="urgent">🔥 Срочная</option>
                </select>
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
                {pendingRounding ? "Предварительно к добавлению" : "Будет добавлено позиций"}: {num(plannedRows.length)}.
                Пропущено: {num(skippedRows)}.
              </strong>
              {routingPreview.departments.map(dept => {
                const lines = plannedRows.filter(line => line.department === dept.id);
                return <span key={dept.id}>
                  {dept.name}: {num(lines.length)} позиций · {num(lines.reduce((sum, line) => sum + line.plannedQuantity, 0))} шт.
                </span>;
              })}
              {pendingRounding && (
                <span role="status">Выберите количество для отмеченных позиций.</span>
              )}
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
                    {roundedLines.map((line) => (
                      <tr key={line.article}>
                        <td>{line.article}</td>
                        <td>{line.extension || "—"}</td>
                        <td>{line.machine || "Не указан"}</td>
                        <td>
                          {line.department === "roll"
                            ? "Рулонная печать"
                            : line.department === "box"
                              ? "Бокс"
                              : `Будет пропущен: ${line.issue}`}
                        </td>
                        <td>
                          {line.rounding ? (
                            <label className="supply-quantity-rounding">
                              <span>
                                Запрошено {num(line.quantity)} шт.
                                {line.rollMultiplicity && ` · кратность ${num(line.rollMultiplicity)} шт.`}
                              </span>
                              <select
                                aria-label={`Округление для ${line.article}`}
                                value={line.roundingDirection ?? ""}
                                disabled={busy || (!!operation && operation.status !== "failed")}
                                onChange={event => {
                                  const direction = event.target.value as RoundingDirection | "";
                                  setRoutingPreview(current => current && current.id === routingPreview.id ? {
                                    ...current,
                                    lines: current.lines.map(item => item.article === line.article
                                      ? { ...item, roundingDirection: direction || undefined }
                                      : item),
                                  } : current);
                                }}
                              >
                                <option value="">Выбрать округление</option>
                                {line.rounding.choices.map(choice => {
                                  const direction = choice.direction === "down" ? "Вниз" : "Вверх";
                                  const sheets = choice.sheets === undefined ? "" : ` · ${num(choice.sheets)} лист.`;
                                  const label = choice.quantity === 0
                                    ? "Вниз до 0 шт. · пропустить"
                                    : `${direction} до ${num(choice.quantity)} шт.${sheets}`;
                                  return <option key={choice.direction} value={choice.direction}>{label}</option>;
                                })}
                              </select>
                            </label>
                          ) : (
                            <>
                              {num(line.quantity)} шт.
                              {line.xeroxSheets !== undefined && <span className="supply-quantity-detail">{num(line.xeroxSheets)} лист.</span>}
                              {(line.xeroxIssue || line.rollIssue) && <span className="supply-quantity-detail">{line.xeroxIssue || line.rollIssue}</span>}
                            </>
                          )}
                        </td>
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
                  (routingPreview.blocked || pendingRounding || plannedRows.length === 0)) ||
                !formAvailable
              }
            >
              {busy
                ? (needsPreview ? "Проверяем распределение…" : "Сохраняем поставку…")
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
                !canWriteItem ||
                (!!operation && !["failed", "retry_same_request"].includes(operation.status))
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
      <Modal open={visibilityDialog && !!visibility} onClose={() => { if (!visibilityBusy) setVisibilityDialog(false); }}
        title={visibility?.hidden ? "Вернуть вкладку?" : "Скрыть вкладку?"}
        description={tabName}
      >
        <p>{visibility?.hidden
          ? "Лист снова появится среди вкладок Google Таблиц."
          : "Вкладка исчезнет из нижней панели Google Таблиц у всех сотрудников. Поставка останется в RITM и «RITM Сборка»."}</p>
        {visibilityError && <p role="alert" className="supply-operation-error">{visibilityError}</p>}
        <div className="modal-actions">
          <Button disabled={visibilityBusy} onClick={() => setVisibilityDialog(false)}>Отмена</Button>
          <Button kind="primary" disabled={visibilityBusy} onClick={() => void changeTabVisibility()}>
            {visibilityBusy ? "Проверяю…" : visibility?.hidden ? "Вернуть вкладку" : "Скрыть вкладку"}
          </Button>
        </div>
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
          deleteTarget?.wholeShipmentId
            ? "Удалить поставку целиком?"
            : deleteTarget?.linked
            ? `Удалить участок «${deleteTarget.department === "box" ? "Бокс" : "Рулонная печать"}»?`
            : "Удалить поставку и лист?"
        }
        description={
          deleteTarget
            ? deleteTarget.wholeShipmentId
              ? `В рабочих таблицах будут удалены листы «${deleteTarget.name}» (${deleteTarget.departments?.map(department => department === "box" ? "Бокс" : "Рулонная печать").join(", ")}), включая скрытые. Поставка уйдёт из активной сборки. Удаление листов нельзя отменить.`
              : deleteTarget.linked
              ? `Будет удалён только лист участка «${deleteTarget.department === "box" ? "Бокс" : "Рулонная печать"}» для поставки «${deleteTarget.name}». Второй участок и его товары останутся в общей поставке сборщиков. Это действие нельзя отменить.`
              : `Будет удалён лист «${deleteTarget.name}» вместе с его данными в Google Sheets. Это действие нельзя отменить.`
            : undefined
        }
      >
        <form noValidate onSubmit={submitDelete}>
          <div className="supply-delete-warning" role="alert">
            {deleteTarget?.wholeShipmentId
              ? "RITM проверит название, ID и связь каждого листа перед удалением."
              : deleteTarget?.linked
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
              operation?.action === "deletePart" || operation?.action === "deleteSupply") && (
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

