import type { LiveOrder } from "./livePrinting";
import {
  formatPrintQuantity,
  rollCut,
  supplyPrinted,
} from "./liveSupplyProgress";
import { workloadCutWaitsForPrint } from "./machineWorkloadData";
import type { supplyLockState } from "./supplyLockState";

export type ArkadyPositionRef = {
  uid: string;
  article: string;
  sheetId: number;
  row: number;
  sourceId?: string;
  store?: string;
};

const priority = {
  stale: 0,
  "missing-positions": 1,
  "unknown-print": 2,
  "wait-for-print": 3,
  printing: 4,
  "catalog-machine": 5,
  "unknown-cut": 6,
  cutting: 7,
  "assembly-closed": 8,
  "assembly-partial": 9,
  "assembly-pending": 10,
  "assembly-unknown": 11,
  "unknown-packing": 12,
  packing: 13,
  empty: 14,
  complete: 15,
};

export type ArkadyReason = {
  kind: keyof typeof priority;
  title: string;
  detail: string;
  position?: ArkadyPositionRef;
  remaining?: number;
};

export type ArkadySupplyOptions = {
  lock?: ReturnType<typeof supplyLockState>;
  stale?: boolean;
  missingPositions?: number;
  packingAvailable?: boolean;
};

const quantity = formatPrintQuantity;

function known(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function positionRef(order: LiveOrder): ArkadyPositionRef | undefined {
  const { uid, article, sheetId, sourceId, row } = order;
  if (
    !uid ||
    !article ||
    !Number.isSafeInteger(sheetId) ||
    sheetId < 0 ||
    !Number.isSafeInteger(row) ||
    row < 1
  )
    return undefined;
  const store =
    !order.shopCatalogStatus || order.shopCatalogStatus === "matched"
      ? order.shop?.trim() || undefined
      : undefined;
  return { uid, article, sheetId, sourceId, row, store };
}

function positionReason(
  order: LiveOrder,
  packingAvailable: boolean,
): ArkadyReason | null {
  const position = positionRef(order);
  const plan = known(order.quantity);
  const printed = known(supplyPrinted(order));
  const cut = known(rollCut(order));
  if (!plan || printed === null) {
    return {
      kind: "unknown-print",
      title: "Печать требует проверки",
      detail: !plan
        ? "Источник не подтвердил положительный план по артикулу."
        : "Источник не подтвердил, сколько штук напечатано.",
      position,
    };
  }
  if (printed < plan) {
    const waiting =
      printed === 0 &&
      workloadCutWaitsForPrint({ ...order, printProgress: printed });
    if (
      printed === 0 &&
      ((cut ?? 0) > 0 ||
        (order.planningPrinted ?? 0) > 0 ||
        (order.planningCut ?? 0) > 0)
    ) {
      return {
        kind: "unknown-print",
        title: "Нужна сверка печати и порезки",
        detail:
          "При нулевом количестве печати в источниках есть другие отметки работы.",
        position,
      };
    }
    return {
      kind: waiting ? "wait-for-print" : "printing",
      title: waiting ? "Порезка ждёт печати" : "Печать не завершена",
      detail:
        "Напечатано " + quantity(printed) + " из " + quantity(plan) + " шт.",
      remaining: plan - printed,
      position,
    };
  }
  if (cut === null) {
    return {
      kind: "unknown-cut",
      title: "Порезка требует проверки",
      detail:
        "Печать выполнена. Источник не подтвердил, сколько штук порезано.",
      position,
    };
  }
  if (cut < plan) {
    return {
      kind: "cutting",
      title: "Порезка не завершена",
      detail: "Порезано " + quantity(cut) + " из " + quantity(plan) + " шт.",
      remaining: plan - cut,
      position,
    };
  }
  const packed = packingAvailable ? known(order.packed) : null;
  const packedConfirmed = packingAvailable
    ? known(order.packedConfirmed)
    : null;
  if ((packed ?? packedConfirmed ?? 0) >= plan) return null;
  if (packed === null) {
    return {
      kind: "unknown-packing",
      title: "Упаковка требует проверки",
      detail:
        packedConfirmed !== null
          ? "Подтверждено не менее " +
            quantity(packedConfirmed) +
            " из " +
            quantity(plan) +
            " шт."
          : "Источник не подтвердил, сколько штук упаковано.",
      position,
    };
  }
  return {
    kind: "packing",
    title: "Упаковка не завершена",
    detail: "Упаковано " + quantity(packed) + " из " + quantity(plan) + " шт.",
    remaining: plan - packed,
    position,
  };
}

const assemblyReasons = {
  closed: {
    kind: "assembly-closed",
    title: "Сборка закрыта",
    detail: "Открытие поставки нужно подтвердить в управлении сборкой.",
  },
  partial: {
    kind: "assembly-partial",
    title: "Часть поставки закрыта для сборки",
    detail: "Проверьте, какие задания открыты для упаковки.",
  },
  pending: {
    kind: "assembly-pending",
    title: "Изменение статуса сборки проверяется",
    detail: "Сборка ещё не подтвердила открытие или закрытие поставки.",
  },
  unknown: {
    kind: "assembly-unknown",
    title: "Статус сборки не подтверждён",
    detail: "Проверьте статус открытия поставки в РИТМ Сборке.",
  },
} satisfies Record<
  Exclude<NonNullable<ArkadySupplyOptions["lock"]>, "open">,
  ArkadyReason
>;

export function diagnoseArkadySupply(
  orders: readonly LiveOrder[],
  {
    lock,
    stale,
    missingPositions = 0,
    packingAvailable = true,
  }: ArkadySupplyOptions = {},
): ArkadyReason[] {
  if (stale) {
    return [
      {
        kind: "stale",
        title: "Требуется обновить данные",
        detail: "Актуальный статус поставки ещё не подтверждён.",
      },
    ];
  }
  const reasons: ArkadyReason[] = [];
  for (const order of orders) {
    const reason = positionReason(order, packingAvailable);
    if (!reason) continue;
    reasons.push(reason);
    const machineIssue = order.machineIssue?.trim();
    if (
      machineIssue &&
      ["unknown-print", "wait-for-print", "printing"].includes(reason.kind)
    ) {
      reasons.push({
        kind: "catalog-machine",
        title: "Станок требует сверки",
        detail: machineIssue,
        position: reason.position,
      });
    }
  }
  if (missingPositions > 0) {
    reasons.push({
      kind: "missing-positions",
      title: "Состав поставки подтверждён частично",
      detail:
        "Не удалось подтвердить позиции — " + quantity(missingPositions) + ".",
    });
  }
  if (
    lock &&
    lock !== "open" &&
    reasons.some(({ kind }) => kind === "packing" || kind === "unknown-packing")
  )
    reasons.push(assemblyReasons[lock]);
  if (!reasons.length) {
    return orders.length
      ? [
          {
            kind: "complete",
            title: "Печать, порезка и упаковка выполнены",
            detail:
              "В источниках подтверждён план по всем проверенным позициям.",
          },
        ]
      : [
          {
            kind: "empty",
            title: "В поставке нет подтверждённых позиций",
            detail: "Загрузите текущий состав поставки для проверки.",
          },
        ];
  }
  return reasons.sort(
    (left, right) => priority[left.kind] - priority[right.kind],
  );
}

export type ArkadyCatalogField = "machine" | "multiplicity" | "size";
export type ArkadyIntent =
  | { type: "attention" }
  | { type: "summary" }
  | { type: "deadlines" }
  | { type: "routing"; article?: string }
  | { type: "diagnosis"; article?: string }
  | { type: "operations" }
  | {
      type: "catalog";
      article?: string;
      field?: ArkadyCatalogField;
      value?: string;
    }
  | { type: "unsupported" };

const fields: { id: ArkadyCatalogField; mention: RegExp; value: RegExp }[] = [
  {
    id: "machine",
    mention: /(?:^|[^\p{L}])стан(?:ок|ка|ку|ке)(?=$|[^\p{L}])/iu,
    value: /стан(?:ок|ка|ку)\s+(?:на\s+)?(.+?)[.?!]*$/iu,
  },
  {
    id: "multiplicity",
    mention: /кратност[ьиью]/iu,
    value: /кратност[ьиью]\s+(?:на\s+)?(\d+)[.?!]*$/iu,
  },
  {
    id: "size",
    mention: /размер/iu,
    value: /размер(?:ы|а)?\s+(?:на\s+)?(.+?)[.?!]*$/iu,
  },
];

// A recognised request may fill a draft. It never grants the write approval.
const articlePattern =
  /[\p{L}]{1,6}\d{2,8}\.[\p{L}]?\d{2,10}(?![\p{L}\p{N}])/giu;

export function parseArkadyIntent(text: string): ArkadyIntent {
  const query = text.trim().replace(/\s+/gu, " ");
  if (
    !query ||
    query.length > 500 ||
    /^(?:не\s|отмени|удали|убери|спиши|отгрузи|сбрось|добавь|закрой|сними)/iu.test(
      query,
    )
  )
    return { type: "unsupported" };
  const articles = [
    ...new Set(query.toUpperCase().match(articlePattern) || []),
  ];
  if (articles.length > 1) return { type: "unsupported" };
  const article = articles[0];
  if (
    !article &&
    /^(?:аркадий[, ]+)?(?:покажи[, ]+)?(?:что\s+(?:срочно|требует\s+внимания)|требует\s+внимания|срочные\s+поставки|какие\s+поставки\s+(?:сегодня\s+)?(?:горят|просрочены|требуют\s+внимания))[?!.]*$/iu.test(
      query,
    )
  )
    return { type: "attention" };
  if (
    /операци|возобнов|сохранени|завис\p{L}* (?:создани|сохранени|загрузк)\p{L}* поставк/iu.test(
      query,
    )
  )
    return { type: "operations" };
  const mentionedFields = fields.filter(({ mention }) => mention.test(query));
  const explicitlyEditing =
    /^(?:поставь|укажи|измени|исправь|задай|обнови|заполни)\s/iu.test(query);
  if (
    !article &&
    /срок(?:и|ов|а|у|ом)?(?=$|[^\p{L}])|когда отгрузка/iu.test(query)
  )
    return { type: "deadlines" };
  if (!explicitlyEditing && /распредел|округл|куда отправит/iu.test(query))
    return { type: "routing", article };
  if (
    !article &&
    !explicitlyEditing &&
    /сводк|что осталось|сколько осталось|обзор поставки/iu.test(query)
  )
    return { type: "summary" };
  if (mentionedFields.length > 1) return { type: "unsupported" };
  const field = mentionedFields[0];
  if (
    field ||
    /справочник|данные товара|карточк[ау] товара|норм[ауые]|кэф/iu.test(query)
  ) {
    const valueQuery = article
      ? query
          .replace(
            new RegExp(
              `(?:\\s+(?:(?:для|у)(?:\\s+артикула)?|артикула)\\s+)?${articlePattern.source}`,
              "iu",
            ),
            "",
          )
          .trim()
      : query;
    return {
      type: "catalog",
      article,
      ...(field && { field: field.id }),
      ...(explicitlyEditing &&
        field && { value: valueQuery.match(field.value)?.[1]?.trim() }),
    };
  }
  if (
    !explicitlyEditing &&
    /почем|мешает|задерж|стоит|заверш|готовност|печат|порез|упаков|поставк|статус/iu.test(
      query,
    )
  )
    return { type: "diagnosis", article };
  return { type: "unsupported" };
}
