import type { ArkadyCatalogCard, ArkadyCatalogChange } from "./ArkadyAssistant";
import { ASSEMBLY_URL } from "./liveAssembly";

const fields = [
  { id: "machine", label: "Станок", input: "select" },
  { id: "size", label: "Размер", input: "text" },
  {
    id: "rollMultiplicity",
    label: "Кратность рулонной печати",
    input: "number",
  },
  { id: "xeroxMultiplicity", label: "Кратность XEROX", input: "number" },
  { id: "cutNorm", label: "Норма ручной резки", input: "number" },
  { id: "assemblyNorm", label: "Норма резки на станке", input: "number" },
  { id: "packingNorm", label: "Норма упаковки", input: "number" },
] as const;

type CatalogEntry = {
  id: string;
  importId: string;
  revision: string;
  market: "OZON" | "WB";
  store: string;
  article: string;
  fields: Record<string, string | number | null>;
};
type CatalogResponse = {
  ok: boolean;
  message?: string;
  canEdit?: boolean;
  entries?: CatalogEntry[];
  fieldOptions?: { machine?: string[] };
  line?: {
    department: "roll" | "box" | null;
    machine: string;
    issue?: string | null;
    rollIssue?: string;
    rounding?: { choices: { direction: "up" | "down"; quantity: number }[] };
  };
};

async function catalogRequest(
  data: object,
  signal?: AbortSignal,
): Promise<CatalogResponse> {
  const timeout = AbortSignal.timeout(18000);
  const response = await fetch("/api/arkady/catalog", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const value = (await response.json()) as CatalogResponse;
  if (!response.ok || value.ok !== true)
    throw new Error(value.message || "Не удалось получить ответ справочника.");
  return value;
}

export async function lookupArkadyCatalog(
  market: string,
  article: string,
  signal: AbortSignal,
): Promise<ArkadyCatalogCard[]> {
  const data = await catalogRequest(
    { action: "read", market, article },
    signal,
  );
  if (!Array.isArray(data.entries))
    throw new Error("Не удалось прочитать карточку товара.");
  return data.entries.map((entry) => {
    const store = String(entry.store);
    const params = new URLSearchParams({
      view: "catalog",
      catalog_q: entry.article,
      catalog_market: entry.market,
      catalog_store: store,
      catalog_open: "1",
    });
    return {
      id: String(entry.id),
      importId: String(entry.importId),
      revision: String(entry.revision),
      article: entry.article,
      market: entry.market,
      store,
      canEdit: data.canEdit === true,
      fields: fields
        .filter((field) => Object.hasOwn(entry.fields, field.id))
        .map((field) => ({
          ...field,
          value:
            entry.fields[field.id] == null
              ? null
              : String(entry.fields[field.id]),
          ...(field.input === "select"
            ? { options: data.fieldOptions?.machine || [] }
            : {}),
        })),
      url: `${ASSEMBLY_URL}/?${params}`,
    };
  });
}

export async function saveArkadyCatalog({
  card,
  fieldId,
  value,
}: ArkadyCatalogChange) {
  await catalogRequest({
    action: "apply",
    market: card.market,
    store: card.store,
    article: card.article,
    id: card.id,
    importId: card.importId,
    revision: Number(card.revision),
    field: fieldId,
    value,
    explicitWriteApproval: true,
  });
}

export async function checkArkadyDistribution(
  card: Pick<ArkadyCatalogCard, "market" | "article" | "store">,
  supplyName: string,
  quantity: number,
  signal?: AbortSignal,
) {
  const { line } = await catalogRequest(
    {
      action: "check",
      market: card.market,
      article: card.article,
      store: card.store,
      supplyName,
      quantity,
    },
    signal,
  );
  if (!line) throw new Error("РИТМ пока не подтвердил распределение.");
  const issue = line.issue || line.rollIssue;
  if (issue) return issue.replace(/\bAssembly\b/g, "«РИТМ Сборка»");
  if (!line.department) return "Участок для этого артикула пока не определён.";
  const department = line.department === "roll" ? "Рулонная печать" : "Бокс";
  const rounding = line.rounding?.choices
    .map(
      (choice) =>
        `${choice.direction === "down" ? "вниз" : "вверх"} до ${choice.quantity} шт.`,
    )
    .join(", ");
  return `${department} · ${line.machine}${rounding ? `. Варианты округления — ${rounding}` : "."}`;
}
