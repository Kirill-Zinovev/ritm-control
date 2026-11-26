import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LiveOrder } from "./livePrinting";
import { Button, Busy, Field, Notice } from "./ui";

type Props = {
  orders: readonly LiveOrder[];
  article?: string;
  preview: (
    order: LiveOrder,
    quantity: number,
    signal: AbortSignal,
  ) => Promise<string>;
};

const orderKey = ({ sourceId, sheetId, row, uid }: LiveOrder) =>
  JSON.stringify([sourceId, sheetId, row, uid]);

export function ArkadyRoutingCheck({ orders, article, preview }: Props) {
  const matching = article
    ? orders.filter(
        (order) => order.article.toUpperCase() === article.toUpperCase(),
      )
    : [];
  const initial =
    matching.length === 1
      ? matching[0]
      : orders.length === 1 && !article
        ? orders[0]
        : null;
  const [selected, setSelected] = useState(initial ? orderKey(initial) : "");
  const order = orders.find((item) => orderKey(item) === selected);
  const [quantity, setQuantity] = useState(
    initial ? String(initial.quantity) : "",
  );
  const [result, setResult] = useState("");
  const [error, setError] = useState(
    article && matching.length === 0
      ? "Артикул не найден в составе поставки."
      : "",
  );
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const parsed = /^\d+$/.test(quantity.trim()) ? Number(quantity) : NaN;
  const validQuantity =
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000000;

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order || !validQuantity || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setResult("");
    try {
      const answer = await preview(order, parsed, controller.signal);
      if (!controller.signal.aborted) setResult(answer);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось проверить распределение.",
        );
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section
      className="arkady-assistant__card"
      aria-labelledby="arkady-routing-heading"
    >
      <h3 id="arkady-routing-heading">Распределение и кратность</h3>
      <form className="arkady-assistant__edit" onSubmit={check}>
        <Field label="Артикул для проверки">
          <select
            disabled={busy}
            value={selected}
            onChange={(event) => {
              const value = event.target.value;
              setSelected(value);
              setQuantity(
                String(
                  orders.find((item) => orderKey(item) === value)?.quantity ??
                    "",
                ),
              );
              setResult("");
              setError("");
            }}
          >
            <option value="">Выберите позицию</option>
            {orders.map((item) => (
              <option key={orderKey(item)} value={orderKey(item)}>
                {item.article} ·{" "}
                {item.sourceId === "box-printing" ? "бокс" : "рулонная печать"}{" "}
                · строка {item.row}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Количество для проверки">
          <input
            disabled={busy || !order}
            value={quantity}
            inputMode="numeric"
            maxLength={7}
            onChange={(event) => {
              setQuantity(event.target.value);
              setResult("");
            }}
          />
        </Field>
        <Button
          kind="primary"
          type="submit"
          disabled={!order || !validQuantity || busy}
        >
          Проверить распределение
        </Button>
      </form>
      {busy && <Busy label="Сверяю со справочником…" />}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      {result && (
        <div role="status">
          <Notice>{result}</Notice>
        </div>
      )}
    </section>
  );
}
