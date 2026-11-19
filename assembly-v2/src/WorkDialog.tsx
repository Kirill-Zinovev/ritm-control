import { useRef, useState, type FormEvent } from "react";
import type { Operation, Position, Supply } from "../shared/model";
import { number, operationLabels } from "../shared/model";
import { availableOperations } from "../shared/assembly";
import type { Workspace } from "./useWorkspace";
import { Button, Dialog, NativeSelect } from "./ui";
import { useDirty, useDraftNavigation } from "./DraftGuard";

export function WorkDialog({
  product: p,
  supply,
  workspace: w,
  onClose,
  onSavedPacking,
}: {
  product: Position;
  supply: Supply;
  workspace: Workspace;
  onClose(): void;
  onSavedPacking?(positionId: string): void;
}) {
  const [employeeId, setEmployeeId] = useState(() => {
    try {
      return sessionStorage.getItem("assembly.v2.employee") ?? "";
    } catch {
      return "";
    }
  });
  const [operation, setOperation] = useState<Operation>("packing");
  const [qty, setQty] = useState("");
  const [toCarton, setToCarton] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const safely = useDraftNavigation();
  useDirty(!!qty);
  const remaining = Math.max(0, p.plan - p[operation]);
  const value = Number(qty);
  const validQty =
    /^\d+$/.test(qty) &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2147483647;
  function close() {
    if (!w.busy) safely(onClose);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!w.state?.employees.some((x) => x.id === employeeId && x.active)) {
      setError("Выберите сотрудника.");
      document.getElementById("employeeSelect")?.focus();
      return;
    }
    if (!validQty) {
      setError("Введите положительное целое количество.");
      input.current?.focus();
      return;
    }
    try {
      await w.command(
        "work.save",
        { positionId: p.id, employeeId, operation, qty: value },
        `Записано: ${operationLabels[operation]} · ${number(value)} шт.`,
      );
      try {
        sessionStorage.setItem("assembly.v2.employee", employeeId);
      } catch {
        /* Optional preference. */
      }
      setQty("");
      if (toCarton && operation === "packing" && onSavedPacking)
        onSavedPacking(p.id);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog
      title="Записать работу"
      kicker={supply.title}
      className="work-modal legacy-work-modal"
      initialFocusId={
        w.state?.employees.some((e) => e.id === employeeId && e.active)
          ? "quantityInput"
          : "employeeSelect"
      }
      busy={w.busy}
      onClose={close}
    >
      <form className="modal-form" noValidate onSubmit={save}>
        <div className="work-product">
          <strong className="sku">{p.sku}</strong>
          <p className="product-name">{p.name}</p>
          <p className="readonly-note">{p.department}</p>
        </div>
        <section
          className="work-remaining"
          aria-label="Остаток по выбранной операции"
          aria-live="polite"
        >
          <div className="work-remaining-heading">
            <span className="work-remaining-title">Осталось выполнить</span>
            <strong className="work-remaining-value">
              {number(remaining)} шт.
            </strong>
          </div>
          <p className="work-remaining-note">
            {operationLabels[operation]} · выполнено {number(p[operation])} из{" "}
            {number(p.plan)} шт.
          </p>
          {validQty ? (
            <p className="work-remaining-preview">
              {value > remaining
                ? `Сверх плана после записи: ${number(value - remaining)} шт. Перевыполнение допустимо.`
                : `После записи останется: ${number(remaining - value)} шт.`}
            </p>
          ) : null}
        </section>
        <NativeSelect
          label="Сотрудник"
          id="employeeSelect"
          value={employeeId}
          disabled={w.busy}
          onChange={(e) => {
            setEmployeeId(e.target.value);
            try {
              sessionStorage.setItem("assembly.v2.employee", e.target.value);
            } catch {
              /* Optional preference. */
            }
          }}
        >
          <option value="">Выберите сотрудника</option>
          {w
            .state!.employees.filter((e) => e.active)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
        </NativeSelect>
        <fieldset className="operation-fieldset" disabled={w.busy}>
          <legend>Операция</legend>
          <div className="operation-choices">
            {availableOperations(p).map((op) => (
              <button
                type="button"
                key={op}
                className={`operation-choice operation-${op}`}
                aria-pressed={operation === op}
                onClick={() => setOperation(op)}
              >
                {operationLabels[op]}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="form-field">
          <label htmlFor="quantityInput">Выполнено, шт.</label>
          <input
            ref={input}
            id="quantityInput"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Например, 120"
            value={qty}
            readOnly={w.busy}
            onChange={(e) => setQty(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "work-error" : undefined}
          />
        </div>
        {operation === "packing" && onSavedPacking ? (
          <label className="work-box-shortcut">
            <input
              type="checkbox"
              checked={toCarton}
              disabled={w.busy}
              onChange={(e) => setToCarton(e.target.checked)}
            />
            После записи перейти к коробам
          </label>
        ) : null}
        <details className="work-norm-details">
          <summary>Норма и расчёт выработки</summary>
          <p className="form-hint">
            {p.workNorms?.[operation] ? (
              <>
                Норма за смену:{" "}
                {new Intl.NumberFormat("ru-RU", {
                  maximumFractionDigits: 2,
                }).format(p.workNorms[operation]!)}{" "}
                шт.{" "}
                {operation === "cut" && p.workNorms.multiplier
                  ? `Листов на изделие: ${p.workNorms.multiplier}. `
                  : ""}
                {validQty
                  ? `Коэффициент этой записи: ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value / p.workNorms[operation]!)}.`
                  : ""}
              </>
            ) : (
              "Для этого товара и операции норма не подтверждена. Количество сохранится, коэффициент останется неизвестным."
            )}
          </p>
        </details>
        <p className="form-error" role="alert" id="work-error">
          {error}
        </p>
        <div className="modal-actions">
          <Button disabled={w.busy} onClick={close}>
            Отмена
          </Button>
          <Button
            primary
            type="submit"
            disabled={w.busy || !qty}
            aria-busy={w.busy}
          >
            {w.busy ? "Сохраняем…" : "Сохранить работу"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
