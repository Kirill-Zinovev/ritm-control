import { useId, useState } from "react";
import { ArrowSquareOut, Warning } from "./icons";
import { ASSEMBLY_URL } from "./liveAssembly";
import type { BoxPrintingEvent, LiveOrder } from "./livePrinting";
import { supplyMarketplace } from "./liveSupplyMarketplace";
import { num } from "./model";
import "./boxAreaDiagnostics.css";

type MissingBoxArea = {
  event: BoxPrintingEvent;
  operation: "Печать" | "Порезка";
};

const previewCount = 3;
const sheetIdPattern = /^[\w-]{20,100}$/;
const dateLabel = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function matchingOrder(event: BoxPrintingEvent, orders: LiveOrder[]) {
  const matches = orders.filter(
    (order) =>
      order.sourceId === "box-printing" &&
      order.sheetId === event.sheetId &&
      order.article === event.article &&
      Boolean(event.spreadsheetId) &&
      order.spreadsheetId === event.spreadsheetId,
  );
  const exact = event.positionId
    ? matches.filter((order) => order.boxPositionId === event.positionId)
    : [];
  if (exact.length === 1) return exact[0];
  const active = matches.filter((order) => !order.archived);
  return active.length === 1 && !matches.some((order) => order.archived)
    ? active[0]
    : undefined;
}

function orderLink(event: BoxPrintingEvent, order: LiveOrder | undefined) {
  const spreadsheetId = event.spreadsheetId;
  if (
    !spreadsheetId ||
    !sheetIdPattern.test(spreadsheetId) ||
    !Number.isSafeInteger(event.sheetId) ||
    event.sheetId < 0
  )
    return undefined;
  const cell = order?.areaIssue?.match(/^([A-Z]{1,3}\d+):/)?.[1];
  const row =
    order && !order.archived && Number.isSafeInteger(order.row) && order.row > 0
      ? `E${order.row}`
      : "";
  const range = !order?.archived ? cell || row : "";
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${event.sheetId}${range ? "&range=" + range : ""}`;
}

function catalogLink(event: BoxPrintingEvent, order: LiveOrder | undefined) {
  const market = supplyMarketplace(event.shipment);
  const store = order?.shop?.match(/^(?:магазин\s*)?([1-9]\d*)$/iu)?.[1];
  if (!market || !store || order?.shopCatalogStatus !== "matched")
    return undefined;
  const params = new URLSearchParams({
    view: "catalog",
    catalog_q: event.article,
    catalog_market: market.toUpperCase(),
    catalog_store: store,
    catalog_open: "1",
  });
  return `${ASSEMBLY_URL}/?${params}`;
}

function areaExplanation(
  event: BoxPrintingEvent,
  order: LiveOrder | undefined,
) {
  if (event.areaOrigin === "historical") {
    return {
      reason:
        "В историческом отчёте для этой операции нет сохранённой площади.",
      action:
        "Найдите площадь операции по исходным данным на дату работы и передайте её владельцу РИТМа вместе с ID записи.",
    };
  }
  if (event.nativeReceiptId) {
    return {
      reason: "В записи «РИТМ Печать» не сохранена площадь операции.",
      action:
        order?.areaKnown === false
          ? "Проверьте площадь плана в строке поставки. Для учёта этой операции передайте владельцу РИТМа подтверждённую площадь за дату работы и ID записи."
          : "Откройте журнал «РИТМ Печать» и найдите операцию по дате и артикулу. Для учёта площади передайте владельцу РИТМа подтверждённые м² и ID записи.",
    };
  }
  return {
    reason:
      event.areaOrigin === "journal"
        ? "В журнале Бокса у этой операции пустое поле «Площадь, м²»."
        : "Источник не подтвердил площадь этой операции.",
    action:
      order?.areaKnown === false
        ? "Проверьте площадь плана в строке поставки. Если расчёт зависит от справочника, проверьте «Размер» и «Листов на изделие». Для учёта старой операции передайте владельцу подтверждённые м² и ID записи."
        : "Проверьте в листе поставки площадь плана и количество на дату работы. Передайте владельцу РИТМа подтверждённые м² по операции и ID записи.",
  };
}

function BoxAreaRecord({
  record,
  orders,
}: {
  record: MissingBoxArea;
  orders: LiveOrder[];
}) {
  const { event, operation } = record;
  const order = matchingOrder(event, orders);
  const { reason, action } = areaExplanation(event, order);
  const supplyUrl = orderLink(event, order);
  const productUrl =
    order?.areaKnown === false ? catalogLink(event, order) : undefined;
  const journalUrl =
    event.journalUrl ||
    (event.nativeReceiptId
      ? "https://ritm-print-d1.zinovevkirill234.chatgpt.site/box"
      : undefined);
  const date = new Date(`${event.date}T12:00:00Z`);
  return (
    <article className="box-area-diagnostics-row">
      <div className="box-area-diagnostics-record">
        <strong>{event.article}</strong>
        <span>
          {operation} ·{" "}
          {Number.isFinite(date.getTime())
            ? dateLabel.format(date)
            : event.date}{" "}
          · {event.employee} · {num(event.quantity, 2)} шт.
        </span>
        <span>{event.shipment}</span>
      </div>
      <div className="box-area-diagnostics-explain">
        <p>
          <strong>{reason}</strong>
        </p>
        {order?.areaKnown === false && order.areaIssue && (
          <p>{order.areaIssue}</p>
        )}
        <p>{action}</p>
      </div>
      <div className="box-area-diagnostics-links">
        {journalUrl && (
          <a href={journalUrl} target="_blank" rel="noreferrer">
            {event.journalUrl
              ? "Открыть запись в журнале"
              : "Открыть РИТМ Печать"}
            <ArrowSquareOut size={14} aria-hidden />
          </a>
        )}
        {supplyUrl && (
          <a href={supplyUrl} target="_blank" rel="noreferrer">
            Открыть лист поставки <ArrowSquareOut size={14} aria-hidden />
          </a>
        )}
        {productUrl && (
          <a href={productUrl} target="_blank" rel="noreferrer">
            Открыть карточку товара <ArrowSquareOut size={14} aria-hidden />
          </a>
        )}
        <details>
          <summary>ID записи</summary>
          <code>{event.id}</code>
        </details>
      </div>
    </article>
  );
}

export function BoxAreaDiagnostics({
  print,
  cut,
  orders,
}: {
  print: BoxPrintingEvent[];
  cut: BoxPrintingEvent[];
  orders: LiveOrder[];
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const titleId = useId();
  const missingPrint = print.filter((event) => event.area === null);
  const missingCut = cut.filter((event) => event.area === null);
  const records: MissingBoxArea[] = [
    ...missingPrint.map((event) => ({ event, operation: "Печать" as const })),
    ...missingCut.map((event) => ({ event, operation: "Порезка" as const })),
  ];
  if (!records.length) return null;

  return (
    <section className="box-area-diagnostics" aria-labelledby={titleId}>
      <div className="box-area-diagnostics-header">
        <Warning size={21} aria-hidden />
        <div>
          <h3 id={titleId}>Записи без площади</h3>
          <p>
            {[
              missingPrint.length ? `Печать · ${num(missingPrint.length)}` : "",
              missingCut.length ? `Порезка · ${num(missingCut.length)}` : "",
            ]
              .filter(Boolean)
              .join("  /  ")}
            . В итогах учтены подтверждённые м².
          </p>
        </div>
        {records.length > previewCount && (
          <button
            type="button"
            className="box-area-diagnostics-toggle"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll((open) => !open)}
          >
            {showAll ? "Свернуть" : `Показать все · ${num(records.length)}`}
          </button>
        )}
      </div>
      <div id={listId} className="box-area-diagnostics-list">
        {(showAll ? records : records.slice(0, previewCount)).map((record) => (
          <BoxAreaRecord
            key={`${record.operation}:${record.event.id}`}
            record={record}
            orders={orders}
          />
        ))}
      </div>
    </section>
  );
}
