import { useEffect, useState } from "react";
import { BookPlus } from "lucide-react";
import { ArkadyWbIntake } from "./ArkadyWbIntake";
import { ASSEMBLY_URL } from "./liveAssembly";
import type { ArkadyCatalogDraftRequest } from "./arkadyAssistantData";
import { ArrowSquareOut } from "./icons";
import { Field } from "./ui";

const isBarcode = (value: string, market: string) =>
  /^[0-9]{6,32}$/.test(value) ||
  (market === "OZON" && /^OZN[0-9]{9,10}$/.test(value));

export function ArkadyCatalogDraft({
  initial,
  fromMissing,
  barcodeReply,
  onSaved,
  onSavingChange,
}: {
  initial: ArkadyCatalogDraftRequest;
  fromMissing?: boolean;
  barcodeReply?: { value: string };
  onSaved?: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const [market, setMarket] = useState(initial.market ?? "");
  const [barcode, setBarcode] = useState(
    barcodeReply?.value ?? initial.barcode ?? "",
  );
  const [article, setArticle] = useState(initial.article ?? "");
  const [store, setStore] = useState(initial.store ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (barcodeReply) setBarcode(barcodeReply.value);
  }, [barcodeReply]);
  const code = barcode.trim().toUpperCase();
  const sku = article.trim().normalize("NFC").toUpperCase();
  const validSku = !sku || /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,119}$/u.test(sku);
  const openUrl =
    market === "OZON" && isBarcode(code, market) && validSku
      ? new URL("/", ASSEMBLY_URL)
      : null;
  if (openUrl) {
    openUrl.searchParams.set("view", "catalog");
    openUrl.searchParams.set("catalog_market", market);
    openUrl.searchParams.set("catalog_barcode", code);
    if (store) openUrl.searchParams.set("catalog_store", store);
    if (sku) openUrl.searchParams.set("catalog_article", sku);
  }

  return (
    <section className="arkady-assistant__card">
      <h3>
        <BookPlus size={17} aria-hidden="true" /> Карточка товара
      </h3>
      <p>
        {fromMissing
          ? "Для этого артикула карточка отсутствует."
          : "Подготовлю черновик по указанному штрихкоду."}{" "}
      </p>
      <div className="arkady-assistant__lookup">
        <Field label="Маркетплейс">
          <select
            value={market}
            disabled={saving}
            onChange={(event) =>
              setMarket(
                event.target.value === "WB"
                  ? "WB"
                  : event.target.value === "OZON"
                    ? "OZON"
                    : "",
              )
            }
          >
            <option value="">Выберите</option>
            <option value="WB">Wildberries</option>
            <option value="OZON">Ozon</option>
          </select>
        </Field>
        {market === "OZON" && (
          <Field label="Магазин">
            <select
              value={store}
              onChange={(event) =>
                setStore(
                  event.target.value === "1"
                    ? "1"
                    : event.target.value === "2"
                      ? "2"
                      : "",
                )
              }
            >
              <option value="">Выбрать в справочнике</option>
              <option value="1">Магазин 1</option>
              <option value="2">Магазин 2</option>
            </select>
          </Field>
        )}
      </div>
      {market === "WB" && (
        <ArkadyWbIntake
          initial={initial}
          barcodeReply={barcodeReply}
          onSaved={onSaved}
          onSavingChange={(active) => {
            setSaving(active);
            onSavingChange?.(active);
          }}
        />
      )}
      {market === "OZON" && (
        <>
          <Field label="Штрихкод">
            <input
              value={barcode}
              inputMode={market === "OZON" ? "text" : "numeric"}
              maxLength={32}
              autoComplete="off"
              onChange={(event) => setBarcode(event.target.value)}
            />
          </Field>
          <Field label="Артикул">
            <input
              value={article}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => setArticle(event.target.value)}
            />
          </Field>
          {code && !isBarcode(code, market) && (
            <p role="status">
              {market === "OZON"
                ? "Введите цифровой штрихкод или код OZN."
                : "Введите штрихкод цифрами, сохранив начальные нули."}
            </p>
          )}
          {!validSku && <p role="status">Проверьте символы в артикуле.</p>}
          {openUrl && (
            <div className="arkady-assistant__actions">
              <a
                className="button primary"
                href={openUrl.href}
                target="_blank"
                rel="noreferrer"
              >
                Открыть в РИТМ Сборке <ArrowSquareOut size={15} />
              </a>
            </div>
          )}
        </>
      )}
    </section>
  );
}
