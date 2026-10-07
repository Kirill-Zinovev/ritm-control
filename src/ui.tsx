import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  CircleNotch,
  MagnifyingGlass,
  WarningCircle,
  X,
} from "./icons";
import { num } from "./model";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Button({
  children,
  kind = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: string }) {
  return (
    <button className={`button ${kind} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Empty({
  title = "Нет данных",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <MagnifyingGlass size={28} />
      </span>
      <h3>{title}</h3>
      <p>{children || "Измени поиск или выбранный период."}</p>
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`}>
      {tone === "warning" ? (
        <WarningCircle size={20} />
      ) : (
        <CheckCircle size={20} />
      )}
      <span>{children}</span>
    </div>
  );
}
export function Progress({
  value,
  plan,
  showValue = true,
}: {
  value: number;
  plan: number;
  showValue?: boolean;
}) {
  const percent = plan > 0 ? (value / plan) * 100 : 0;
  return (
    <div className="progress-block">
      {showValue && <strong>{num(percent)}%</strong>}
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Выполнение плана"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(percent))}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      {showValue && (
        <small>
          {num(value)} из {num(plan)}
        </small>
      )}
    </div>
  );
}
export function Search({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (s: string) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="search">
      <MagnifyingGlass size={18} />
      <input
        ref={ref}
        aria-label={label}
        placeholder={label}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="Очистить поиск"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const control = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{ id?: string; "aria-describedby"?: string }>,
        { id, "aria-describedby": error ? errorId : undefined },
      )
    : children;
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      {control}
      {error && (
        <small id={errorId} className="error-text" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content"
          aria-describedby={description ? "modal-description" : undefined}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id="modal-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Закрыть окно"
            >
              <X size={22} />
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export interface Column<T> {
  id: string;
  label: string;
  render: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
}
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  label,
  pageSize = 10,
  onSelect,
  selected,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  label: string;
  pageSize?: number;
  onSelect?: (r: T) => void;
  selected?: string;
}) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(pageSize);
  const [sort, setSort] = useState<{ id: string; asc: boolean } | null>(null);
  const col = columns.find((c) => c.id === sort?.id);
  const sorted = col?.sort
    ? [...rows].sort((a, b) => {
        const av = col.sort!(a),
          bv = col.sort!(b);
        return (
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv), "ru")) * (sort?.asc ? 1 : -1)
        );
      })
    : rows;
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / size) - 1),
  );
  useEffect(() => setPage(0), [rows.length, size]);
  return (
    <div className="table-panel">
      <div className="table-scroll">
        <table aria-label={label}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  aria-sort={
                    c.sort
                      ? sort?.id === c.id
                        ? sort.asc
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {c.sort ? (
                    <button
                      className="sort-button"
                      onClick={() =>
                        setSort({
                          id: c.id,
                          asc: sort?.id === c.id ? !sort.asc : true,
                        })
                      }
                    >
                      {c.label}
                      {sort?.id === c.id &&
                        (sort.asc ? (
                          <ArrowLeft className="sort-arrow" size={14} />
                        ) : (
                          <ArrowRight className="sort-arrow" size={14} />
                        ))}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(safePage * size, (safePage + 1) * size).map((r) => (
              <tr
                key={rowKey(r)}
                className={selected === rowKey(r) ? "selected-row" : ""}
              >
                {columns.map((c, i) => (
                  <td key={c.id}>
                    {i === 0 && onSelect ? (
                      <button
                        className="row-action"
                        onClick={() => onSelect(r)}
                      >
                        {c.render(r)}
                      </button>
                    ) : (
                      c.render(r)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <Empty />}
      <div className="pagination">
        <span>
          {rows.length
            ? `${safePage * size + 1}–${Math.min((safePage + 1) * size, rows.length)} из ${num(rows.length)}`
            : "0 записей"}
        </span>
        <div>
          <label>
            Строк{" "}
            <select
              aria-label="Строк на странице"
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="Предыдущая страница"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            <ArrowLeft size={18} />
          </button>
          <span>
            {safePage + 1} / {Math.max(1, Math.ceil(rows.length / size))}
          </span>
          <button
            className="icon-button"
            aria-label="Следующая страница"
            disabled={(safePage + 1) * size >= rows.length}
            onClick={() => setPage(safePage + 1)}
          >
            <ArrowRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
export function Busy({ label = "Пересчёт показателей" }: { label?: string }) {
  return (
    <span className="busy" role="status">
      <CircleNotch className="spin" size={18} />
      {label}
    </span>
  );
}
