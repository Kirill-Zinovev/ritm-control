import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { ArrowSquareOut } from "./icons";
import { ASSEMBLY_URL } from "./liveAssembly";
import type { ArkadyCatalogDraftRequest } from "./arkadyAssistantData";
import {
  arkadyLabelLimit,
  arkadyPhotoLimit,
  arkadyPhotoTypes,
  ArkadyWbIntakeError,
  confirmWbIntake,
  prepareWbIntake,
  type WbIntakeInput,
  type WbIntakeReview,
} from "./arkadyWbIntakeClient";
import { Busy, Button, Field, Notice } from "./ui";
import "./arkadyWbIntake.css";

type Inputs = Omit<Required<WbIntakeInput>, "store"> & {
  store: "" | "1" | "2";
};
type Prepared = { input: WbIntakeInput; result: WbIntakeReview };

const missingLabels: Record<string, string> = {
  article: "артикул",
  name: "название товара",
  packaging: "упаковку (строка «Размер» на этикетке)",
};

function useBlobUrl(blob: Blob | null) {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (!blob) {
      setCurrent(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current?.url : undefined;
}

function cardLink(draft: WbIntakeReview["draft"]) {
  const params = new URLSearchParams({
    view: "catalog",
    catalog_market: "WB",
    catalog_store: draft.store,
    catalog_q: draft.article,
    catalog_open: "1",
  });
  return `${ASSEMBLY_URL}/?${params}`;
}

export function ArkadyWbIntake({
  initial,
  barcodeReply,
  onSaved,
  onSavingChange,
}: {
  initial: ArkadyCatalogDraftRequest;
  barcodeReply?: { value: string };
  onSaved?: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [inputs, setInputs] = useState<Inputs>({
    article: initial.article ?? "",
    barcode: barcodeReply?.value ?? initial.barcode ?? "",
    store: initial.store ?? "",
    name: "",
    packaging: "",
  });
  const [details, setDetails] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [label, setLabel] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [receipt, setReceipt] = useState(false);
  const [saved, setSaved] = useState<WbIntakeReview["draft"] | null>(null);
  const active = useRef<AbortController | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const approval = useRef<string | null>(null);
  const seenBarcodeReply = useRef(barcodeReply);
  const photoUrl = useBlobUrl(photo);
  const labelUrl = useBlobUrl(label);

  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!barcodeReply || barcodeReply === seenBarcodeReply.current) return;
    if (receipt || approval.current) {
      seenBarcodeReply.current = barcodeReply;
      return;
    }
    if (active.current) return;
    seenBarcodeReply.current = barcodeReply;
    if (barcodeReply.value === inputs.barcode) return;
    setSaved(null);
    setInputs((current) => ({
      ...current,
      barcode: barcodeReply.value,
      ...(prepared && {
        article: prepared.input.article ?? "",
        name: prepared.input.name ?? "",
        packaging: prepared.input.packaging ?? "",
      }),
    }));
    setPrepared(null);
    setLabel(null);
    setError("");
  }, [barcodeReply, busy, inputs.barcode, prepared, receipt]);

  async function run(
    message: string,
    work: (signal: AbortSignal) => Promise<void>,
    writing = false,
  ) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    if (writing) onSavingChange?.(true);
    setBusy(message);
    setError("");
    try {
      await work(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error &&
            (cause.name === "Error" || cause instanceof ArkadyWbIntakeError)
            ? cause.message
            : writing
              ? "Ответ о записи не получен. Повторите подтверждение с прежними данными."
              : "Справочник не ответил. Повторите проверку.",
        );
      }
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy("");
      if (writing) onSavingChange?.(false);
    }
  }

  function change<K extends keyof Inputs>(field: K, value: Inputs[K]) {
    if (inputs[field] === value) return;
    setInputs((current) => ({ ...current, [field]: value }));
    setPrepared(null);
    setLabel(null);
    setError("");
    approval.current = null;
  }

  function selectPhoto(file: File) {
    if (active.current || receipt || approval.current) return;
    if (
      !arkadyPhotoTypes.includes(file.type) ||
      !file.size ||
      file.size > arkadyPhotoLimit
    ) {
      setError("Выберите фото JPEG, PNG или WebP размером до 1 МБ.");
      return;
    }
    setPhoto(file);
    setError("");
  }

  function pastePhoto(event: ClipboardEvent<HTMLElement>) {
    const image = Array.from(event.clipboardData.files).find((file) =>
      file.type.startsWith("image/"),
    );
    if (image) {
      event.preventDefault();
      selectPhoto(image);
    }
  }

  const code = inputs.barcode.trim();
  const article = inputs.article
    .trim()
    .normalize("NFC")
    .toLocaleUpperCase("ru-RU");
  const validArticle =
    !article || /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(article);
  const readyForReview = Boolean(
    inputs.store && /^\d{6,32}$/.test(code) && validArticle,
  );
  const complete =
    prepared && prepared.result.missing.length === 0 ? prepared : null;

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!readyForReview || !inputs.store || prepared) return;
    const input: WbIntakeInput = {
      store: inputs.store,
      barcode: code,
      ...(article ? { article } : {}),
      ...(inputs.name.trim() ? { name: inputs.name.trim() } : {}),
      ...(inputs.packaging.trim()
        ? { packaging: inputs.packaging.trim() }
        : {}),
    };
    void run("Сверяю данные товара…", async (signal) => {
      const result = await prepareWbIntake(input, signal);
      if (signal.aborted) return;
      setInputs(result.draft);
      setDetails(true);
      setPrepared({ input, result });
      if (result.missing.length === 0) {
        setBusy("Готовлю этикетку…");
        await generateLabel(result.draft, signal);
      }
    });
  }

  async function generateLabel(
    draft: WbIntakeReview["draft"],
    signal: AbortSignal,
  ) {
    const { generateArkadyWbLabel } = await import("./generateArkadyWbLabel");
    if (signal.aborted) return;
    const image = await generateArkadyWbLabel(draft);
    if (image.size > arkadyLabelLimit)
      throw new Error("Этикетка превышает допустимый размер 200 КБ.");
    if (!signal.aborted) setLabel(image);
  }

  function generate() {
    if (!complete || receipt || approval.current) return;
    void run("Готовлю этикетку…", (signal) =>
      generateLabel(complete.result.draft, signal),
    );
  }

  async function verify(preview: Prepared, signal: AbortSignal) {
    const expected = preview.result.draft;
    try {
      const checked = await prepareWbIntake(
        {
          article: expected.article,
          store: expected.store,
          barcode: expected.barcode,
        },
        signal,
      );
      if (signal.aborted) return;
      const matches =
        checked.mode === "update" &&
        checked.draft.article === expected.article &&
        checked.draft.store === expected.store &&
        checked.draft.barcode === expected.barcode &&
        checked.draft.name === expected.name &&
        checked.draft.packaging === expected.packaging &&
        checked.hasPhoto &&
        checked.hasLabel;
      if (!matches) throw new Error("Не удалось сверить запись.");
      setSaved(checked.draft);
      setInputs({
        store: checked.draft.store,
        barcode: "",
        article: "",
        name: "",
        packaging: "",
      });
      setDetails(false);
      setPrepared(null);
      setPhoto(null);
      setLabel(null);
      setReceipt(false);
      approval.current = null;
    } catch {
      if (!signal.aborted) {
        throw new Error(
          "Сборка приняла запрос. Сохранённую карточку пока не удалось сверить.",
        );
      }
      return;
    }
    onSaved?.();
  }

  function save() {
    if (
      !complete ||
      !complete.result.canEdit ||
      !label ||
      !labelUrl ||
      (!photoUrl && !complete.result.hasPhoto)
    )
      return;
    const approvalId = (approval.current ??= crypto.randomUUID());
    void run(
      "Сохраняю карточку WB…",
      async (signal) => {
        try {
          await confirmWbIntake(
            complete.input,
            complete.result.fingerprint,
            approvalId,
            { photo, label },
            signal,
          );
        } catch (cause) {
          if (
            cause instanceof ArkadyWbIntakeError &&
            cause.status === 409 &&
            cause.message === "Эти данные уже сохранены в карточке."
          ) {
            setReceipt(true);
            await verify(complete, signal);
            return;
          }
          if (
            cause instanceof ArkadyWbIntakeError &&
            [400, 401, 403, 409, 413].includes(cause.status)
          )
            approval.current = null;
          throw cause;
        }
        if (signal.aborted) return;
        setReceipt(true);
        await verify(complete, signal);
      },
      true,
    );
  }

  function edit() {
    setPrepared(null);
    setLabel(null);
    setError("");
    approval.current = null;
  }

  if (saved) {
    return (
      <div className="arkady-wb-intake">
        <div role="status">
          <Notice>
            Карточка {saved.article} сохранена и сверена в РИТМ Сборке.
          </Notice>
        </div>
        <div className="arkady-assistant__actions">
          <a
            className="button primary"
            href={cardLink(saved)}
            target="_blank"
            rel="noreferrer"
          >
            Открыть карточку <ArrowSquareOut size={15} />
          </a>
          <Button type="button" onClick={() => setSaved(null)}>
            Добавить ещё товар
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="arkady-wb-intake"
      aria-label="Карточка Wildberries"
      onPaste={pastePhoto}
    >
      {!complete && (
        <form className="arkady-wb-intake__fields" onSubmit={prepare}>
          <div className="arkady-wb-intake__identity">
            <Field label="Магазин WB">
              <select
                value={inputs.store}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  const store = event.target.value;
                  if (store === "1" || store === "2" || store === "")
                    change("store", store);
                }}
              >
                <option value="">Выберите магазин</option>
                <option value="1">Магазин 1</option>
                <option value="2">Магазин 2</option>
              </select>
            </Field>
            <Field
              label="Штрихкод"
              error={
                code && !/^\d{6,32}$/.test(code)
                  ? "Введите от 6 до 32 цифр."
                  : undefined
              }
            >
              <input
                value={inputs.barcode}
                inputMode="numeric"
                maxLength={32}
                autoComplete="off"
                disabled={Boolean(busy)}
                onChange={(event) => change("barcode", event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Артикул"
            error={!validArticle ? "Проверьте символы в артикуле." : undefined}
          >
            <input
              value={inputs.article}
              maxLength={120}
              autoComplete="off"
              disabled={Boolean(busy)}
              onChange={(event) => change("article", event.target.value)}
            />
          </Field>
          {details && (
            <>
              <Field label="Название товара">
                <input
                  value={inputs.name}
                  maxLength={500}
                  disabled={Boolean(busy)}
                  onChange={(event) => change("name", event.target.value)}
                />
              </Field>
              <Field label="Упаковка (размер на этикетке)">
                <input
                  value={inputs.packaging}
                  maxLength={100}
                  disabled={Boolean(busy)}
                  onChange={(event) => change("packaging", event.target.value)}
                />
              </Field>
            </>
          )}
          {prepared?.result.missing.length ? (
            <div role="status">
              <Notice tone="warning">
                Уточните{" "}
                {prepared.result.missing
                  .map((field) => missingLabels[field] ?? field)
                  .join(", ")}
                .
              </Notice>
            </div>
          ) : null}
          <Button
            type="submit"
            kind="primary"
            disabled={!readyForReview || Boolean(busy) || Boolean(prepared)}
          >
            Подготовить карточку WB
          </Button>
        </form>
      )}
      {complete && (
        <div className="arkady-wb-intake__product">
          <small>
            {complete.result.mode === "update"
              ? "Существующая карточка WB"
              : "Новая карточка WB"}
          </small>
          <strong>{complete.result.draft.name}</strong>
          <p>
            {complete.result.draft.article} · Магазин{" "}
            {complete.result.draft.store}
          </p>
          <dl>
            <div>
              <dt>Штрихкод</dt>
              <dd>{complete.result.draft.barcode}</dd>
            </div>
            <div>
              <dt>Упаковка</dt>
              <dd>{complete.result.draft.packaging}</dd>
            </div>
          </dl>
        </div>
      )}
      {!receipt && !approval.current && (
        <div>
          <input
            ref={photoInput}
            type="file"
            hidden
            accept={arkadyPhotoTypes.join(",")}
            disabled={Boolean(busy)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) selectPhoto(file);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => photoInput.current?.click()}
          >
            {photo ? "Заменить фото" : "Прикрепить фото"}
          </Button>
        </div>
      )}
      {!photo && !receipt && !approval.current && (
        <small className="arkady-wb-intake__hint">
          До 1 МБ. Фото можно вставить из буфера обмена.
        </small>
      )}
      {(photoUrl || complete) && (
        <div className="arkady-wb-intake__medias">
          <figure>
            {photoUrl ? (
              <img
                src={photoUrl}
                alt="Фото товара для сохранения"
                onError={() => {
                  if (!active.current && !approval.current) {
                    setPhoto(null);
                    setError(
                      "Фото не открывается. Выберите другое изображение.",
                    );
                  }
                }}
              />
            ) : (
              <p>
                {complete?.result.hasPhoto
                  ? "Фото есть в карточке"
                  : "Добавьте фото товара"}
              </p>
            )}
            <figcaption>Фото</figcaption>
          </figure>
          {complete && (
            <figure>
              {labelUrl ? (
                <img
                  className="is-label"
                  src={labelUrl}
                  alt="Этикетка WB перед сохранением"
                />
              ) : (
                <p>Предпросмотр этикетки</p>
              )}
              <figcaption>WB · 58 × 40 мм</figcaption>
            </figure>
          )}
        </div>
      )}
      {busy && <Busy label={busy} />}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      {complete && (
        <div className="arkady-assistant__actions">
          {!label && !busy && (
            <Button type="button" onClick={generate}>
              Повторить генерацию этикетки
            </Button>
          )}
          {labelUrl && !receipt && complete.result.canEdit && (
            <Button
              type="button"
              kind="primary"
              onClick={save}
              disabled={
                Boolean(busy) || (!photoUrl && !complete.result.hasPhoto)
              }
            >
              {approval.current
                ? "Повторить подтверждение"
                : "Подтвердить и сохранить"}
            </Button>
          )}
          {receipt && (
            <Button
              type="button"
              onClick={() =>
                void run("Сверяю сохранённую карточку…", (signal) =>
                  verify(complete, signal),
                )
              }
              disabled={Boolean(busy)}
            >
              Проверить сохранение
            </Button>
          )}
          {!receipt && !approval.current && (
            <Button type="button" onClick={edit} disabled={Boolean(busy)}>
              Изменить данные
            </Button>
          )}
        </div>
      )}
      {complete && !complete.result.canEdit && (
        <small className="arkady-wb-intake__hint">
          Сохранить карточку сможет владелец РИТМа.
        </small>
      )}
    </section>
  );
}
