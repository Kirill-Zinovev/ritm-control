import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Bell,
  BookOpen,
  BookPlus,
  CalendarDays,
  ChartNoAxesColumn,
  ListChecks,
  FileSpreadsheet,
  Monitor,
  Route,
  SendHorizontal,
} from "lucide-react";
import { ArrowRight, ArrowSquareOut } from "./icons";
import { Button, Busy, Field, Modal, Notice } from "./ui";
import { ASSEMBLY_URL } from "./liveAssembly";
import type { LiveOrder } from "./livePrinting";
import {
  ArkadyAttentionView,
  type ArkadyAttentionViewProps,
} from "./ArkadyAttentionView";
import { ArkadyOperationAttention } from "./ArkadyAttention";
import { ArkadyDeadlines } from "./ArkadyDeadlines";
import { ArkadyRoutingCheck } from "./ArkadyRoutingCheck";
import { ArkadySupplySummary } from "./ArkadySupplySummary";
import { ArkadyCatalogDraft } from "./ArkadyCatalogDraft";
import {
  ArkadySupplyDraft,
  type ArkadySupplyDraftInput,
} from "./ArkadySupplyDraft";
import {
  diagnoseArkadySupply,
  parseArkadyIntent,
  type ArkadyCatalogDraftRequest,
  type ArkadyIntent,
} from "./arkadyAssistantData";
import "./arkadyAssistant.css";

export type ArkadyCatalogField = {
  id: string;
  label: string;
  value: string | null;
  input: "text" | "number" | "select";
  options?: readonly string[];
};

export type ArkadyCatalogCard = {
  id: string;
  importId?: string;
  article: string;
  market: string;
  store: string;
  revision: string;
  fields: readonly ArkadyCatalogField[];
  canEdit?: boolean;
  url?: string;
};

export type ArkadyCatalogChange = {
  card: ArkadyCatalogCard;
  fieldId: string;
  value: string;
};

export type ArkadyOperationReport = {
  id: string;
  title: string;
  status: string;
  detail?: string;
  canResume?: boolean;
};

export type ArkadyStart = {
  panel: "summary" | "attention" | "diagnosis" | "catalog";
  article?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  supplyName: string;
  orders: readonly LiveOrder[];
  summaryPlan?: number | null;
  start?: ArkadyStart;
  attention?: ArkadyAttentionViewProps;
  assemblySync?: {
    title: string;
    detail: string;
    check: (signal: AbortSignal) => Promise<string>;
  };
  planningKey?: string;
  onDeadlinesSaved?: () => void;
  previewRouting?: (
    order: LiveOrder,
    quantity: number,
    signal: AbortSignal,
  ) => Promise<string>;
  snapshotStale?: boolean;
  diagnostics?: {
    lock?: "open" | "closed" | "partial" | "pending" | "unknown";
    missingPositions?: number;
    packingAvailable?: boolean;
  };
  onRevealOrder?: (order: LiveOrder) => void;
  createCatalogDraft?: boolean;
  onPrepareCatalogTask?: (article: string) => void;
  onPrepareSupply?: (draft: ArkadySupplyDraftInput) => void;
  catalog?: {
    market: "WB" | "OZON";
    getStore: (article: string) => "1" | "2" | undefined;
    lookup: (
      article: string,
      signal: AbortSignal,
    ) => Promise<ArkadyCatalogCard[]>;
    save?: (change: ArkadyCatalogChange) => Promise<void>;
    checkDistribution?: (card: ArkadyCatalogCard) => Promise<string>;
  };
  operation?: {
    read: (id?: string) => Promise<ArkadyOperationReport | null>;
    resume?: (id: string) => Promise<ArkadyOperationReport>;
    attention?: readonly { id: string; title: string; detail: string }[];
  };
};

const catalogLabel = (value: string | null) => value?.trim() || "Не заполнено";
const articleKey = (article: string) =>
  article.trim().normalize("NFC").toUpperCase();
const cardKey = (card: ArkadyCatalogCard) =>
  JSON.stringify([card.id, card.importId, card.market, card.store]);

function numberValue(value: string | null) {
  const normalized = value?.trim().replace(",", ".");
  return normalized && /^\d+(?:\.\d+)?$/.test(normalized)
    ? Number(normalized)
    : NaN;
}

function sameFieldValue(field: ArkadyCatalogField, value: string) {
  return field.input === "number"
    ? numberValue(field.value) === numberValue(value)
    : field.value?.trim() === value;
}

function intentMatchesField(
  intent: ArkadyIntent | null,
  field: ArkadyCatalogField,
) {
  if (intent?.type !== "catalog") return false;
  if (field.id === intent.field) return true;
  return (
    intent.field === "multiplicity" &&
    ["rollMultiplicity", "xeroxMultiplicity"].includes(field.id)
  );
}

function proposedFieldValue(
  intent: ArkadyIntent | null,
  field: ArkadyCatalogField | undefined,
) {
  if (
    intent?.type !== "catalog" ||
    !field ||
    !intentMatchesField(intent, field)
  )
    return "";
  const value = intent.value?.trim();
  if (!value) return "";
  return field.input === "select"
    ? field.options?.find(
        (option) => articleKey(option) === articleKey(value),
      ) || ""
    : value;
}

function catalogLink(card: ArkadyCatalogCard) {
  if (card.url?.startsWith(`${ASSEMBLY_URL}/?`)) return card.url;
  const params = new URLSearchParams({
    view: "catalog",
    catalog_q: card.article,
    catalog_market: card.market.toUpperCase(),
    catalog_store: card.store,
    catalog_open: "1",
  });
  return `${ASSEMBLY_URL}/?${params}`;
}

export function ArkadyAssistant(props: Props) {
  if (!props.open) return null;
  return <AssistantDrawer {...props} />;
}

function AssistantDrawer({
  open,
  onClose,
  supplyName,
  orders,
  summaryPlan,
  start,
  attention,
  assemblySync,
  planningKey,
  onDeadlinesSaved,
  previewRouting,
  snapshotStale,
  diagnostics,
  onRevealOrder,
  createCatalogDraft,
  onPrepareCatalogTask,
  onPrepareSupply,
  catalog,
  operation,
}: Props) {
  const [panel, setPanel] = useState<
    | "summary"
    | "diagnosis"
    | "catalog"
    | "operation"
    | "deadlines"
    | "routing"
    | "attention"
    | "catalog-draft"
    | "supply-draft"
  >(start?.panel ?? "summary");
  const [routingArticle, setRoutingArticle] = useState<string>();
  const [question, setQuestion] = useState("");
  const [prompt, setPrompt] = useState("");
  const [diagnosisArticle, setDiagnosisArticle] = useState(
    start?.panel === "diagnosis" ? (start.article ?? "") : "",
  );
  const [reasonLimit, setReasonLimit] = useState(8);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [report, setReport] = useState<ArkadyOperationReport | null>(null);
  const [operationChecked, setOperationChecked] = useState(false);
  const [requestedOperation, setRequestedOperation] = useState<string>();
  const [article, setArticle] = useState(
    start?.panel === "catalog" ? (start.article ?? "") : "",
  );
  const [cards, setCards] = useState<ArkadyCatalogCard[]>([]);
  const [selectedCard, setSelectedCard] = useState("");
  const [fieldId, setFieldId] = useState("");
  const [nextValue, setNextValue] = useState("");
  const [preview, setPreview] = useState<ArkadyCatalogChange | null>(null);
  const [catalogIntent, setCatalogIntent] = useState<ArkadyIntent | null>(null);
  const [catalogDraft, setCatalogDraft] = useState<ArkadyCatalogDraftRequest>(
    {},
  );
  const [missingArticle, setMissingArticle] = useState("");
  const request = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement | null>(null);
  const writeInProgress = useRef(false);
  const articleOptionsId = useId();

  const options = useMemo(
    () =>
      [...new Set(orders.map((order) => order.article))].sort((a, b) =>
        a.localeCompare(b, "ru"),
      ),
    [orders],
  );
  const reasons = useMemo(
    () =>
      diagnoseArkadySupply(
        diagnosisArticle
          ? orders.filter(
              (order) =>
                articleKey(order.article) === articleKey(diagnosisArticle),
            )
          : orders,
        {
          ...diagnostics,
          missingPositions: diagnosisArticle
            ? undefined
            : diagnostics?.missingPositions,
          stale: snapshotStale,
        },
      ),
    [orders, diagnostics, snapshotStale, diagnosisArticle],
  );
  const card = cards.find((entry) => cardKey(entry) === selectedCard);
  const field = card?.fields.find((entry) => entry.id === fieldId);
  const candidate = nextValue.trim();
  const candidateNumber =
    field?.input === "number" ? numberValue(candidate) : NaN;
  const canSaveCatalog = Boolean(
    catalog?.save && card && card.canEdit !== false,
  );
  const candidateValid = Boolean(
    field &&
    candidate &&
    !sameFieldValue(field, candidate) &&
    (field.input !== "select" || field.options?.includes(candidate)) &&
    (field.input !== "number" ||
      (Number.isFinite(candidateNumber) && candidateNumber > 0)),
  );

  useEffect(() => () => request.current?.abort(), []);

  function openPanel(next: typeof panel, text = "") {
    setPanel(next);
    setQuestion(text);
    setMessage("");
    setError("");
    setPreview(null);
    scroll.current?.scrollTo({ top: 0 });
  }

  function explain(text: string, requestedArticle = "") {
    openPanel("diagnosis", text);
    setReasonLimit(8);
    const matchingArticle = options.find(
      (item) => articleKey(item) === articleKey(requestedArticle),
    );
    setDiagnosisArticle(matchingArticle || "");
    if (requestedArticle && !matchingArticle) {
      setMessage("Артикул не найден в этой поставке.");
    }
  }

  async function run(
    label: string,
    task: (signal: AbortSignal) => Promise<void>,
    writing = false,
  ) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    writeInProgress.current = writing;
    setBusy(label);
    setMessage("");
    setError("");
    try {
      await task(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось выполнить действие.",
        );
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        writeInProgress.current = false;
        setBusy("");
      }
    }
  }

  function chooseCard(
    entry: ArkadyCatalogCard | undefined,
    intent: ArkadyIntent | null = null,
  ) {
    setSelectedCard(entry ? cardKey(entry) : "");
    const fields =
      entry?.fields.filter((item) => intentMatchesField(intent, item)) || [];
    const currentField = fields.length === 1 ? fields[0] : undefined;
    setFieldId(currentField?.id || "");
    setNextValue(proposedFieldValue(intent, currentField));
    setPreview(null);
  }

  function lookup(rawArticle: string, intent: ArkadyIntent | null = null) {
    if (!catalog || request.current) return;
    const actualArticle = options.find(
      (entry) => articleKey(entry) === articleKey(rawArticle),
    );
    setCards([]);
    setMissingArticle("");
    setCatalogIntent(intent);
    chooseCard(undefined);
    if (!actualArticle) {
      setError("Выберите артикул из этой поставки.");
      return;
    }
    setArticle(actualArticle);
    void run("Читаю справочник…", async (signal) => {
      const items = await catalog.lookup(actualArticle, signal);
      if (signal.aborted) return;
      const matches = items.filter(
        (item) => articleKey(item.article) === articleKey(actualArticle),
      );
      setCards(matches);
      if (matches.length === 1) chooseCard(matches[0], intent);
      if (matches.length === 0) {
        setMissingArticle(actualArticle);
        setMessage(
          createCatalogDraft
            ? "Карточка артикула не найдена. Пришлите штрихкод или откройте черновик."
            : "Карточка артикула не найдена в справочнике РИТМ Сборки.",
        );
      }
    });
  }

  useEffect(() => {
    const initialArticle =
      start?.panel === "catalog" ? start.article : undefined;
    if (!initialArticle) return;
    const timer = window.setTimeout(() => lookup(initialArticle), 0);
    return () => window.clearTimeout(timer);
  }, [start]);

  function saveCatalog() {
    if (
      !preview ||
      !catalog?.save ||
      preview.card.canEdit === false ||
      request.current
    )
      return;
    const change = preview;
    const save = catalog.save;
    setPreview(null);
    setCards([]);
    chooseCard(undefined);
    void run(
      "Сохраняю и сверяю карточку…",
      async (signal) => {
        await save(change);
        if (signal.aborted) return;
        let updated: ArkadyCatalogCard | undefined;
        try {
          const items = await catalog.lookup(change.card.article, signal);
          if (signal.aborted) return;
          updated = items.find(
            (item) => cardKey(item) === cardKey(change.card),
          );
          setCards(
            items.filter(
              (item) =>
                articleKey(item.article) === articleKey(change.card.article),
            ),
          );
          chooseCard(updated);
        } catch (cause) {
          if (signal.aborted) return;
          throw new Error(
            "Сборка приняла запрос. Проверьте текущее значение в карточке справочника.",
            { cause },
          );
        }
        const currentField = updated?.fields.find(
          (item) => item.id === change.fieldId,
        );
        if (
          !updated ||
          !currentField ||
          !sameFieldValue(currentField, change.value)
        ) {
          setError(
            "Сборка приняла запрос. Текущее значение нужно сверить в карточке.",
          );
          return;
        }
        setMessage("Изменение подтверждено в справочнике.");
        if (catalog.checkDistribution) {
          try {
            const result = await catalog.checkDistribution(updated);
            if (!signal.aborted && result)
              setMessage(`Изменение подтверждено в справочнике. ${result}`);
          } catch (cause) {
            if (!signal.aborted) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Не удалось перепроверить распределение.",
              );
            }
          }
        }
      },
      true,
    );
  }

  function readOperation(text?: string, operationId?: string) {
    if (request.current) return;
    openPanel("operation", text);
    setOperationChecked(false);
    setRequestedOperation(operationId);
    setReport(null);
    if (!operation) {
      setMessage("Проверка операций для этой поставки недоступна.");
      return;
    }
    void run("Проверяю состояние операции…", async (signal) => {
      const outcome = await operation.read(operationId);
      if (signal.aborted) return;
      setReport(outcome);
      setOperationChecked(true);
    });
  }

  function resumeOperation() {
    if (!report?.canResume || !operation?.resume || request.current) return;
    const { id } = report;
    const resume = operation.resume;
    setReport(null);
    setOperationChecked(false);
    void run(
      "Продолжаю сохранённую операцию…",
      async (signal) => {
        const outcome = await resume(id);
        if (signal.aborted) return;
        setReport(outcome);
        setOperationChecked(true);
      },
      true,
    );
  }

  function prepareCatalogDraft(draft: ArkadyCatalogDraftRequest, text = "") {
    const sourceArticle =
      draft.article ??
      (panel === "catalog" ? missingArticle || undefined : undefined);
    const market = draft.market ?? catalog?.market;
    const store =
      draft.store ??
      (sourceArticle && market === catalog?.market
        ? catalog?.getStore(sourceArticle)
        : undefined);
    setCatalogDraft({
      market,
      store,
      article: sourceArticle,
      barcode: draft.barcode,
    });
    openPanel("catalog-draft", text);
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt("");
    const intent = parseArkadyIntent(text);
    if (intent.type === "attention" && attention) {
      openPanel("attention", text);
      return;
    }
    if (intent.type === "supply-draft" && onPrepareSupply) {
      openPanel("supply-draft", text);
      return;
    }
    if (createCatalogDraft) {
      if (intent.type === "catalog-draft") {
        prepareCatalogDraft(intent, text);
        return;
      }
      const code = text.match(
        /^(?:(?:вот\s+)?(?:штрихкод|баркод)\s*[: ]\s*)?(OZN[0-9]{9,10}|[0-9]{6,32})$/iu,
      )?.[1];
      if (
        code &&
        (panel === "catalog-draft" || (panel === "catalog" && missingArticle))
      ) {
        prepareCatalogDraft(
          {
            ...(panel === "catalog-draft" ? catalogDraft : {}),
            barcode: code.toUpperCase(),
          },
          text,
        );
        return;
      }
    }
    if (!supplyName) {
      openPanel("attention", text);
      setMessage(
        "Выберите поставку из списка, чтобы задать вопрос по её составу.",
      );
      return;
    }
    if (intent.type === "summary") {
      openPanel("summary", text);
      return;
    }
    if (intent.type === "deadlines") {
      openPanel("deadlines", text);
      return;
    }
    if (intent.type === "routing") {
      openPanel("routing", text);
      setRoutingArticle(intent.article);
      if (!previewRouting)
        setMessage("Распределение для этой поставки пока недоступно.");
      return;
    }
    if (intent.type === "operations") {
      readOperation(text);
      return;
    }
    if (intent.type === "catalog") {
      openPanel("catalog", text);
      if (!catalog) {
        setMessage("Справочник для этой поставки недоступен.");
        return;
      }
      const selectedArticle =
        intent.article ||
        card?.article ||
        (options.length === 1 ? options[0] : "");
      if (selectedArticle) lookup(selectedArticle, intent);
      else {
        setArticle("");
        setCards([]);
        chooseCard(undefined);
        setCatalogIntent(null);
        setMessage("Укажите артикул из поставки, чтобы открыть его карточку.");
      }
      return;
    }
    if (intent.type === "diagnosis") {
      explain(text, intent.article);
    } else {
      openPanel("diagnosis", text);
      setMessage(
        "Могу показать, что требует внимания, разобрать задержку, открыть справочник или проверить сроки поставки.",
      );
    }
  }

  function close() {
    if (!writeInProgress.current) onClose();
  }

  function showOrder(order: LiveOrder) {
    close();
    window.requestAnimationFrame(() => onRevealOrder?.(order));
  }

  function prepareEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (card && field && candidateValid && canSaveCatalog) {
      setPreview({ card, fieldId: field.id, value: candidate });
      setMessage("");
      setError("");
    }
  }

  return (
    <Modal
      open={open}
      title="Аркадий"
      description={
        panel === "attention" || !supplyName ? "Контроль поставок" : supplyName
      }
      className="arkady-assistant"
      onClose={close}
    >
      <div className="arkady-assistant__scroll" ref={scroll}>
        <div
          className="arkady-assistant__prompts"
          role="group"
          aria-label="Быстрые действия Аркадия"
        >
          {attention && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "attention"}
              onClick={() => openPanel("attention")}
            >
              <Bell size={16} /> Требует внимания
            </Button>
          )}
          {supplyName && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "summary"}
              onClick={() => openPanel("summary")}
            >
              <ChartNoAxesColumn size={16} /> Сводка
            </Button>
          )}
          {supplyName && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "diagnosis"}
              onClick={() => explain("Что мешает завершить?")}
            >
              <ListChecks size={16} /> Что мешает?
            </Button>
          )}
          {catalog && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "catalog"}
              onClick={() => {
                openPanel("catalog");
                if (!card && options.length === 1) lookup(options[0]);
              }}
            >
              <BookOpen size={16} /> Справочник
            </Button>
          )}
          {previewRouting && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "routing"}
              onClick={() => {
                setRoutingArticle(undefined);
                openPanel("routing");
              }}
            >
              <Route size={16} /> Распределение
            </Button>
          )}
          {createCatalogDraft && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "catalog-draft"}
              onClick={() => prepareCatalogDraft({})}
            >
              <BookPlus size={16} /> Новый товар
            </Button>
          )}
          {onPrepareSupply && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "supply-draft"}
              onClick={() => openPanel("supply-draft")}
            >
              <FileSpreadsheet size={16} /> Черновик поставки
            </Button>
          )}
          {supplyName && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "deadlines"}
              onClick={() => openPanel("deadlines")}
            >
              <CalendarDays size={16} /> Сроки
            </Button>
          )}
          {operation && supplyName && (
            <Button
              type="button"
              disabled={Boolean(busy)}
              aria-pressed={panel === "operation"}
              onClick={() => readOperation("Проверь состояние операции")}
            >
              Операции поставки
            </Button>
          )}
        </div>

        {question && <p className="arkady-assistant__question">{question}</p>}
        {busy && <Busy label={busy} />}
        {error && (
          <div role="alert">
            <Notice tone="warning">{error}</Notice>
          </div>
        )}
        {message && (
          <div role="status">
            <Notice>{message}</Notice>
          </div>
        )}

        {panel === "attention" && attention && (
          <>
            <ArkadyAttentionView {...attention} />
            {assemblySync && (
              <ArkadyOperationAttention
                issue={assemblySync}
                actionLabel="Проверить синхронизацию"
                onOpen={() =>
                  void run(
                    "Проверяю доставку в РИТМ Сборку…",
                    async (signal) => {
                      const status = await assemblySync.check(signal);
                      if (!signal.aborted) setMessage(status);
                    },
                  )
                }
              />
            )}
            {operation?.attention?.map(({ id, title, detail }) => (
              <ArkadyOperationAttention
                key={id}
                issue={{ title, detail }}
                onOpen={() => readOperation(undefined, id)}
              />
            ))}
          </>
        )}
        {panel === "catalog-draft" && createCatalogDraft && (
          <ArkadyCatalogDraft
            key={JSON.stringify(catalogDraft)}
            initial={catalogDraft}
            fromMissing={
              !!missingArticle &&
              catalogDraft.article === missingArticle &&
              catalogDraft.market === catalog?.market
            }
          />
        )}
        {panel === "supply-draft" && onPrepareSupply && (
          <ArkadySupplyDraft onPrepare={onPrepareSupply} />
        )}

        {panel === "summary" && (
          <ArkadySupplySummary
            orders={orders}
            plan={summaryPlan}
            lock={diagnostics?.lock}
            missingPositions={diagnostics?.missingPositions}
            packingAvailable={diagnostics?.packingAvailable}
            snapshotStale={snapshotStale}
            onRevealOrder={onRevealOrder ? showOrder : undefined}
          />
        )}
        {panel === "routing" && previewRouting && (
          <ArkadyRoutingCheck
            key={routingArticle || ""}
            orders={orders}
            article={routingArticle}
            preview={previewRouting}
          />
        )}
        {panel === "deadlines" && (
          <ArkadyDeadlines
            planningKey={planningKey}
            onSaved={onDeadlinesSaved}
          />
        )}
        {panel === "diagnosis" && !message && (
          <>
            <ul
              className="arkady-assistant__reasons"
              aria-label="Что мешает завершить поставку"
            >
              {reasons.slice(0, reasonLimit).map((reason, index) => {
                const position = reason.position;
                const order =
                  position &&
                  orders.find(
                    (item) =>
                      item.uid === position.uid &&
                      item.sheetId === position.sheetId &&
                      item.row === position.row &&
                      item.sourceId === position.sourceId,
                  );
                return (
                  <li
                    className="arkady-assistant__card"
                    key={`${reason.kind}-${position?.sourceId}-${position?.sheetId}-${position?.row}-${position?.uid || index}`}
                  >
                    <h3>{reason.title}</h3>
                    {position && (
                      <strong className="arkady-assistant__article">
                        {position.article}
                      </strong>
                    )}
                    <p>{reason.detail}</p>
                    {order && onRevealOrder && (
                      <Button
                        type="button"
                        kind={index === 0 ? "primary" : "secondary"}
                        onClick={() => showOrder(order)}
                      >
                        <Monitor size={17} /> Показать на экране
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {reasons.length > reasonLimit && (
              <Button
                type="button"
                onClick={() => setReasonLimit((limit) => limit + 8)}
              >
                Показать ещё {Math.min(reasons.length - reasonLimit, 8)}
              </Button>
            )}
          </>
        )}

        {panel === "operation" && operation && (
          <section className="arkady-assistant__card">
            <h3>{report?.title || "Состояние операции"}</h3>
            {report && (
              <>
                <p className="arkady-assistant__operation-status">
                  {report.status}
                </p>
                {report.detail && <p>{report.detail}</p>}
                <small className="arkady-assistant__operation-id">
                  Номер запроса {report.id}
                </small>
              </>
            )}
            {!report && operationChecked && (
              <p>
                {requestedOperation
                  ? "Сохранённый запрос отсутствует в текущем списке операций."
                  : "Незавершённых операций по этой поставке нет."}
              </p>
            )}
            <div className="arkady-assistant__actions">
              {report?.canResume && operation.resume && (
                <Button
                  type="button"
                  kind="primary"
                  disabled={Boolean(busy)}
                  onClick={resumeOperation}
                >
                  Подтвердить продолжение
                </Button>
              )}
              <Button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => readOperation(question, requestedOperation)}
              >
                Проверить состояние
              </Button>
            </div>
          </section>
        )}

        {panel === "catalog" && catalog && (
          <section className="arkady-assistant__card">
            <h3>Справочник РИТМ Сборки</h3>
            <form
              className="arkady-assistant__lookup"
              onSubmit={(event) => {
                event.preventDefault();
                lookup(article);
              }}
            >
              <Field label="Артикул из поставки">
                <input
                  list={articleOptionsId}
                  value={article}
                  maxLength={120}
                  disabled={Boolean(busy)}
                  onChange={(event) => {
                    setArticle(event.target.value);
                    setMissingArticle("");
                    setCards([]);
                    chooseCard(undefined);
                    setCatalogIntent(null);
                    setMessage("");
                    setError("");
                  }}
                />
              </Field>
              <datalist id={articleOptionsId}>
                {options.map((option) => (
                  <option value={option} key={option} />
                ))}
              </datalist>
              <Button type="submit" disabled={!article.trim() || Boolean(busy)}>
                Найти
              </Button>
            </form>
            {missingArticle && createCatalogDraft && (
              <div className="arkady-assistant__actions">
                <Button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    prepareCatalogDraft({ article: missingArticle })
                  }
                >
                  <BookPlus size={16} /> Подготовить карточку
                </Button>
                {onPrepareCatalogTask && (
                  <Button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => onPrepareCatalogTask(missingArticle)}
                  >
                    Подготовить задачу
                  </Button>
                )}
              </div>
            )}
            {cards.length > 1 && (
              <Field label="Карточка товара">
                <select
                  value={selectedCard}
                  disabled={Boolean(busy)}
                  onChange={(event) =>
                    chooseCard(
                      cards.find(
                        (entry) => cardKey(entry) === event.target.value,
                      ),
                      catalogIntent,
                    )
                  }
                >
                  <option value="">Выберите маркетплейс и магазин</option>
                  {cards.map((entry, index) => (
                    <option key={cardKey(entry)} value={cardKey(entry)}>
                      {entry.market} · {entry.store || "Магазин не указан"}
                      {cards.some(
                        (item, i) =>
                          i !== index &&
                          item.market === entry.market &&
                          item.store === entry.store,
                      )
                        ? ` · карточка ${index + 1}`
                        : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {card && (
              <>
                <div className="arkady-assistant__catalog-title">
                  <strong>{card.article}</strong>
                  <span>
                    {card.market} · {card.store || "Магазин не указан"}
                  </span>
                </div>
                <dl className="arkady-assistant__catalog-values">
                  {card.fields.map((item) => (
                    <div key={item.id}>
                      <dt>{item.label}</dt>
                      <dd>{catalogLabel(item.value)}</dd>
                    </div>
                  ))}
                </dl>
                <a
                  href={catalogLink(card)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="arkady-assistant__catalog-link"
                >
                  Открыть карточку <ArrowSquareOut size={15} />
                </a>
                {canSaveCatalog && card.fields.length > 0 && !preview && (
                  <form
                    className="arkady-assistant__edit"
                    onSubmit={prepareEdit}
                  >
                    <Field label="Поле для изменения">
                      <select
                        value={fieldId}
                        onChange={(event) => {
                          const id = event.target.value;
                          setFieldId(id);
                          setNextValue(
                            proposedFieldValue(
                              catalogIntent,
                              card.fields.find((item) => item.id === id),
                            ),
                          );
                        }}
                      >
                        <option value="">Выберите поле</option>
                        {card.fields.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {field && (
                      <Field label="Новое значение">
                        {field.input === "select" ? (
                          <select
                            value={nextValue}
                            onChange={(event) =>
                              setNextValue(event.target.value)
                            }
                          >
                            <option value="">Выберите значение</option>
                            {field.options?.map((option) => (
                              <option value={option} key={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={nextValue}
                            inputMode={
                              field.input === "number" ? "decimal" : "text"
                            }
                            maxLength={120}
                            onChange={(event) =>
                              setNextValue(event.target.value)
                            }
                          />
                        )}
                      </Field>
                    )}
                    <Button
                      type="submit"
                      disabled={!candidateValid || Boolean(busy)}
                    >
                      Проверить изменение
                    </Button>
                  </form>
                )}
                {preview && field && canSaveCatalog && (
                  <div className="arkady-assistant__confirm">
                    <h4>{field.label}</h4>
                    <div className="arkady-assistant__comparison">
                      <div>
                        <small>Было</small>
                        <strong>{catalogLabel(field.value)}</strong>
                      </div>
                      <ArrowRight size={17} aria-hidden="true" />
                      <div>
                        <small>Станет</small>
                        <strong>{preview.value}</strong>
                      </div>
                    </div>
                    <div className="arkady-assistant__actions">
                      <Button
                        type="button"
                        kind="primary"
                        disabled={Boolean(busy)}
                        onClick={saveCatalog}
                      >
                        Подтвердить изменение
                      </Button>
                      <Button type="button" onClick={() => setPreview(null)}>
                        Назад
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>

      <form className="arkady-assistant__composer" onSubmit={send}>
        <input
          aria-label="Вопрос Аркадию"
          placeholder={
            panel === "attention"
              ? "Например, что срочно?"
              : "Спросить про поставку…"
          }
          value={prompt}
          maxLength={280}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={Boolean(busy)}
        />
        <Button
          type="submit"
          kind="primary"
          disabled={!prompt.trim() || Boolean(busy)}
          aria-label="Отправить вопрос"
        >
          <SendHorizontal size={20} aria-hidden="true" />
        </Button>
      </form>
    </Modal>
  );
}
