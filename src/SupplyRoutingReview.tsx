import { useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw, Scroll } from "lucide-react";
import { ArrowSquareOut, Package, Warning } from "./icons";
import { ASSEMBLY_URL } from "./liveAssembly";
import { supplyMarketplace } from "./liveSupplyMarketplace";
import { num } from "./model";
import { Button } from "./ui";

export type RoundingDirection = "down" | "up";
type Department = "roll" | "box";
type RoundingChoice = {
  direction: RoundingDirection;
  quantity: number;
  sheets?: number;
};

export type RoutingLine = {
  article: string;
  extension?: string | null;
  quantity: number;
  machine: string;
  department: Department | null;
  store?: string;
  issue: string | null;
  rounding?: { choices: RoundingChoice[] };
  xeroxSheets?: number;
  xeroxIssue?: string;
  rollMultiplicity?: number;
  rollIssue?: string;
  roundingDirection?: RoundingDirection;
};

export type RoutingPreview = {
  id: string;
  input: string;
  blocked: boolean;
  lines: RoutingLine[];
};

type ReviewLine = RoutingLine & { plannedQuantity: number };
type Filter = "all" | Department | "skipped";

const DEPARTMENTS = [
  { id: "roll", label: "Рулонная печать", icon: Scroll },
  { id: "box", label: "Бокс", icon: Package },
] as const;
const positionForms = new Intl.PluralRules("ru-RU");

function positions(count: number) {
  const form = positionForms.select(count);
  return `${num(count)} ${form === "one" ? "позиция" : form === "few" ? "позиции" : "позиций"}`;
}

function isSkipped(line: ReviewLine) {
  return !line.department || line.plannedQuantity === 0;
}

function catalogUrl(name: string, line: RoutingLine, openCard: boolean) {
  const params = new URLSearchParams({
    view: "catalog",
    catalog_q: line.article,
  });
  const market = supplyMarketplace(name);
  if (market) params.set("catalog_market", market.toUpperCase());
  if (line.store) params.set("catalog_store", line.store);
  if (openCard) params.set("catalog_open", "1");
  return `${ASSEMBLY_URL}/?${params}`;
}

function recovery(line: ReviewLine) {
  const reason =
    line.issue ||
    line.xeroxIssue ||
    line.rollIssue ||
    "Участок печати не определён.";
  const lookup = reason.toLocaleLowerCase("ru-RU");
  if (line.department && line.plannedQuantity === 0) {
    return {
      reason: "Выбрано округление вниз до 0 шт.",
      fix: "Выберите положительное количество или измените количество в составе.",
      catalog: false,
    };
  }
  if (lookup.includes("повторяется после нормализации")) {
    return {
      reason,
      fix: "Объедините строки артикула и укажите общее количество.",
      catalog: false,
    };
  }
  if (lookup.includes("артикул не найден")) {
    return {
      reason,
      fix: "Сверьте артикул, маркетплейс и магазин. Если карточки нет, добавьте её в справочник Сборки.",
      catalog: true,
    };
  }
  if (lookup.includes("кратность xerox") || line.xeroxIssue) {
    return {
      reason: line.xeroxIssue
        ? reason
        : "Не подтверждены листы на изделие и кратность Xerox.",
      fix: "В карточке товара в Сборке укажите «Кол-во листов» и «Кратность Xerox».",
      catalog: true,
      openCard: true,
    };
  }
  if (line.rollIssue) {
    return {
      reason,
      fix: "Укажите кратность в поле «Кратность рулонная» в карточке товара.",
      catalog: true,
      openCard: true,
    };
  }
  if (
    lookup.includes("расходятся") ||
    lookup.includes("разные станки") ||
    lookup.includes("расширение x относится")
  ) {
    return {
      reason,
      fix: "Сверьте магазин, станок и расширение печати для этого артикула в справочнике Сборки.",
      catalog: true,
    };
  }
  if (lookup.includes("расширени")) {
    return {
      reason,
      fix: "Проверьте расширение печати в карточке товара.",
      catalog: true,
    };
  }
  if (lookup.includes("станок")) {
    return {
      reason,
      fix: "Укажите фактическое оборудование в поле «Станок» в карточке товара.",
      catalog: true,
    };
  }
  return {
    reason,
    fix: "Сверьте данные артикула в справочнике Сборки и повторите проверку.",
    catalog: true,
  };
}

function RoundingOptions({
  line,
  disabled,
  onChoose,
}: {
  line: ReviewLine;
  disabled: boolean;
  onChoose: (article: string, direction: RoundingDirection) => void;
}) {
  if (!line.rounding) return null;
  const selected = line.rounding.choices.find(
    (choice) => choice.direction === line.roundingDirection,
  );
  return (
    <div className="supply-review-rounding">
      <div
        className="supply-review-choices"
        role="group"
        aria-label={`Округление для ${line.article}`}
      >
        {line.rounding.choices.map((choice) => {
          const Icon = choice.direction === "down" ? ArrowDown : ArrowUp;
          const label = choice.direction === "down" ? "Вниз" : "Вверх";
          return (
            <Button
              key={choice.direction}
              type="button"
              kind={
                choice.direction === line.roundingDirection
                  ? "primary"
                  : "secondary"
              }
              disabled={disabled}
              aria-pressed={choice.direction === line.roundingDirection}
              aria-label={`${label} до ${num(choice.quantity)} шт. для ${line.article}`}
              onClick={() => onChoose(line.article, choice.direction)}
            >
              <Icon size={14} aria-hidden="true" />
              {num(choice.quantity)} шт.
            </Button>
          );
        })}
      </div>
      {selected?.sheets !== undefined && (
        <small>{num(selected.sheets)} лист.</small>
      )}
    </div>
  );
}

export function SupplyRoutingReview({
  name,
  lines,
  checking,
  disabled,
  onChoose,
  onRecheck,
}: {
  name: string;
  lines: ReviewLine[];
  checking: boolean;
  disabled: boolean;
  onChoose: (article: string, direction: RoundingDirection) => void;
  onRecheck: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const skipped = lines.filter(isSkipped);
  const pending = lines.some(
    (line) => line.rounding && !line.roundingDirection,
  );
  const totals = DEPARTMENTS.map((department) => {
    const planned = lines.filter(
      (line) => line.department === department.id && !isSkipped(line),
    );
    return {
      ...department,
      rows: planned.length,
      quantity: planned.reduce(
        (total, line) => total + line.plannedQuantity,
        0,
      ),
    };
  });
  const totalQuantity = totals.reduce(
    (sum, department) => sum + department.quantity,
    0,
  );
  const filters = [
    { id: "all", label: "Все", count: lines.length },
    ...totals.map((department) => ({
      id: department.id,
      label: department.label,
      count: department.rows,
    })),
    { id: "skipped", label: "Пропуск", count: skipped.length },
  ] as const;
  const visibleLines = lines.filter(
    (line) =>
      filter === "all" ||
      (filter === "skipped"
        ? isSkipped(line)
        : line.department === filter && !isSkipped(line)),
  );
  const canExpand = filter === "all" && visibleLines.length > 5;
  const displayedLines =
    canExpand && !expanded
      ? [
          ...visibleLines.filter((line) => !isSkipped(line)).slice(0, 4),
          ...skipped.slice(0, 1),
        ]
      : visibleLines;

  return (
    <section
      className="supply-review"
      aria-label="Распределение товаров по участкам"
      aria-busy={checking}
    >
      <div className="supply-review-detail">
        <div className="supply-review-heading">
          <h3>Распределение по участкам</h3>
          <Button type="button" disabled={disabled} onClick={onRecheck}>
            <RefreshCw size={15} aria-hidden="true" />
            {checking ? "Проверяем…" : "Проверить заново"}
          </Button>
        </div>
        <div
          className="supply-review-filters"
          role="group"
          aria-label="Фильтр по участкам"
        >
          {filters.map(({ id, label, count }) => (
            <Button
              key={id}
              type="button"
              kind={id === filter ? "primary" : "secondary"}
              aria-pressed={id === filter}
              onClick={() => setFilter(id)}
            >
              {label} <span>{num(count)}</span>
            </Button>
          ))}
        </div>
        {pending && (
          <p className="supply-review-guide">
            Выберите округление для отмеченных позиций.
          </p>
        )}
        {visibleLines.length > 0 ? (
          <table
            className="supply-review-table"
            aria-label="Состав после проверки"
          >
            <colgroup>
              <col className="supply-review-col-sku" />
              <col className="supply-review-col-machine" />
              <col className="supply-review-col-department" />
              <col className="supply-review-col-requested" />
              <col className="supply-review-col-planned" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Артикул</th>
                <th scope="col">Станок</th>
                <th scope="col">Участок</th>
                <th scope="col">Запрошено</th>
                <th scope="col">К запуску</th>
              </tr>
            </thead>
            <tbody>
              {displayedLines.map((line, index) => {
                const skip = isSkipped(line);
                const guidance =
                  skip || line.rollIssue || line.xeroxIssue
                    ? recovery(line)
                    : null;
                return skip && guidance ? (
                  <tr
                    key={`${line.article}:${index}`}
                    className="supply-review-skip"
                  >
                    <td colSpan={5}>
                      <article className="supply-review-issue">
                        <div className="supply-review-issue-head">
                          <span>
                            <strong>{line.article}</strong>
                            <small>{num(line.quantity)} шт.</small>
                          </span>
                          <span className="supply-review-skip-status">
                            Будет пропущен
                          </span>
                        </div>
                        <strong className="supply-review-reason">
                          {guidance.reason}
                        </strong>
                        <p>{guidance.fix}</p>
                        {guidance.catalog && (
                          <a
                            href={catalogUrl(
                              name,
                              line,
                              guidance.openCard === true,
                            )}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {guidance.openCard
                              ? "Открыть карточку"
                              : "Открыть справочник"}{" "}
                            <ArrowSquareOut size={13} aria-hidden="true" />
                          </a>
                        )}
                        {line.rounding && (
                          <RoundingOptions
                            line={line}
                            disabled={disabled}
                            onChoose={onChoose}
                          />
                        )}
                      </article>
                    </td>
                  </tr>
                ) : (
                  <tr key={`${line.article}:${index}`}>
                    <th scope="row">{line.article}</th>
                    <td>
                      {line.machine}
                      {line.extension && <small>{line.extension}</small>}
                    </td>
                    <td>
                      {line.department === "roll" ? "Рулонная печать" : "Бокс"}
                    </td>
                    <td>
                      {num(line.quantity)} шт.
                      {line.rollMultiplicity && (
                        <small>Кратно {num(line.rollMultiplicity)}</small>
                      )}
                    </td>
                    <td>
                      {line.rounding ? (
                        <RoundingOptions
                          line={line}
                          disabled={disabled}
                          onChoose={onChoose}
                        />
                      ) : (
                        <>
                          <strong>{num(line.plannedQuantity)} шт.</strong>
                          {line.xeroxSheets !== undefined && (
                            <small>{num(line.xeroxSheets)} лист.</small>
                          )}
                        </>
                      )}
                      {guidance && (
                        <small className="supply-review-advice">
                          {guidance.reason} {guidance.fix}{" "}
                          <a
                            href={catalogUrl(
                              name,
                              line,
                              guidance.openCard === true,
                            )}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Открыть карточку
                          </a>
                        </small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="supply-review-guide">По этому фильтру позиций нет.</p>
        )}
        {canExpand && (
          <Button
            type="button"
            kind="ghost"
            className="supply-review-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Свернуть список" : "Показать все позиции"}
          </Button>
        )}
      </div>
      <aside
        className="supply-launch-summary"
        aria-label="К запуску"
        aria-live="polite"
      >
        <h3>К запуску</h3>
        <span>{positions(lines.length - skipped.length)}</span>
        <strong className="supply-launch-total">
          {num(totalQuantity)} <small>шт.</small>
        </strong>
        {pending && (
          <small className="supply-launch-estimate">
            Итог уточнится после округления
          </small>
        )}
        <dl>
          {totals.map(({ id, label, icon: Icon, rows, quantity }) => (
            <div key={id} className={`supply-launch-department is-${id}`}>
              <dt>
                <Icon size={20} strokeWidth={1.8} aria-hidden="true" /> {label}
              </dt>
              <dd>
                {num(rows)} поз. · <strong>{num(quantity)} шт.</strong>
              </dd>
            </div>
          ))}
        </dl>
        {skipped.length > 0 && (
          <div className="supply-launch-skipped">
            <Warning size={18} aria-hidden="true" />
            <span>
              {skipped.length === 1 ? "Будет пропущена" : "Будут пропущены"}{" "}
              {positions(skipped.length)}
            </span>
          </div>
        )}
      </aside>
    </section>
  );
}
