import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Search as SearchIcon, X } from "lucide-react";
export function Button({
  primary = false,
  danger = false,
  className = "",
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  error,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className="field-wrap">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        {...props}
        id={id}
        className={`field ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-help` : undefined}
      />
      {error || hint ? (
        <p id={`${id}-help`} className={error ? "field-error" : "muted help"}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
export function NativeSelect({
  label,
  children,
  className = "",
  hint,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className="field-wrap">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        {...props}
        id={id}
        className={`field ${className}`}
        aria-describedby={hint ? `${id}-help` : undefined}
      >
        {children}
      </select>
      {hint ? (
        <p className="muted help" id={`${id}-help`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
export function Search({
  value,
  onChange,
  label = "Артикул или название товара",
  placeholder = label,
}: {
  value: string;
  onChange(value: string): void;
  label?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="search">
      <SearchIcon size={17} aria-hidden="true" />
      <input
        ref={ref}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Очистить поиск"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  className = "",
  kicker,
  initialFocusId,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
  kicker?: string;
  initialFocusId?: string;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const current = ref.current;
    const focus = document.activeElement as HTMLElement | null;
    current?.showModal();
    if (initialFocusId)
      current?.querySelector<HTMLElement>(`#${initialFocusId}`)?.focus();
    return () => {
      current?.close();
      focus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-header modal-top">
        <div>
          {kicker ? <p className="modal-kicker">{kicker}</p> : null}
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
        </div>
        <button
          type="button"
          autoFocus
          className="icon-button modal-close"
          disabled={busy}
          onClick={onClose}
          aria-label="Закрыть окно"
        >
          <X size={21} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}
export function Pagination({
  page,
  total,
  size,
  onChange,
}: {
  page: number;
  total: number;
  size: number;
  onChange(page: number): void;
}) {
  if (total <= size) return <p className="muted list-total">Всего: {total}</p>;
  return (
    <nav className="pagination" aria-label="Страницы списка">
      <span className="muted">
        {page * size + 1}–{Math.min((page + 1) * size, total)} из {total}
      </span>
      <Button disabled={page === 0} onClick={() => onChange(page - 1)}>
        Назад
      </Button>
      <Button
        disabled={(page + 1) * size >= total}
        onClick={() => onChange(page + 1)}
      >
        Далее
      </Button>
    </nav>
  );
}
export function Status({
  error,
  notice,
  retry,
}: {
  error: string;
  notice: string;
  retry(): void;
}) {
  return (
    <div className="status-region" aria-live="polite" aria-atomic="true">
      {error ? (
        <div className="status-error">
          <span>{notice ? `${notice} ${error}` : error}</span>
          <Button onClick={retry}>Обновить данные</Button>
        </div>
      ) : notice ? (
        <div className="status-success">{notice}</div>
      ) : null}
    </div>
  );
}
export function useSmallScreen() {
  const query = "(max-width: 760px)";
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const update = () => setMatches(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return matches;
}
