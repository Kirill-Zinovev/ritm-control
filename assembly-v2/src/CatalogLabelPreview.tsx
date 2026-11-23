import { useState, type ReactNode } from 'react';
import { CircleAlert, FileImage, Printer } from 'lucide-react';
import { labelStatusText, type PrintableLabel } from '../shared/labels';
import { Button } from './ui';

export type LabelLookup =
  | { state: 'loading' | 'error' | 'new' }
  | { state: 'ready'; label: PrintableLabel };

type Props = {
  lookup: LabelLookup;
  draftUrl: string | null;
  draftOutdated: boolean;
  compact: boolean;
  busy: boolean;
  generating: boolean;
  market: string;
  missingFields: string[];
  barcodeField: ReactNode;
  onGenerate(): void;
  onUpload(): void;
  onPrint(): void;
  onRetry(): void;
  onFill?(): void;
};

export function CatalogLabelPreview({
  lookup, draftUrl, draftOutdated, compact, busy, generating, market,
  missingFields, barcodeField, onGenerate, onUpload, onPrint, onRetry, onFill,
}: Props) {
  const [imageResult, setImageResult] = useState<{ url: string; loaded: boolean }>();
  const saved = lookup.state === 'ready' ? lookup.label : undefined;
  const src = draftUrl ?? saved?.imageUrl;
  const loaded = !!src && imageResult?.url === src && imageResult.loaded;
  const imageFailed = !!src && imageResult?.url === src && !imageResult.loaded;
  const loading = !src && lookup.state === 'loading';
  const failed = lookup.state === 'error' || imageFailed;
  let status = 'Этикетки нет';
  let hint = '';
  if (loading || (src && !loaded && !imageFailed)) {
    status = 'Загружаем этикетку…';
    hint = '';
  } else if (imageFailed) {
    status = 'Изображение не открылось';
    hint = draftUrl ? 'Выберите другой файл или сгенерируйте этикетку.' : 'Повторите загрузку или загрузите готовый файл.';
  } else if (draftUrl) {
    status = draftOutdated ? 'Данные для этикетки изменились' : 'Этикетка готова к сохранению';
    hint = draftOutdated ? 'Сгенерируйте этикетку ещё раз.' : 'Проверьте изображение и сохраните карточку.';
  } else if (loaded) {
    status = 'Этикетка есть';
    hint = '';
  } else if (failed) {
    status = 'Не удалось проверить этикетку';
    hint = '';
  } else if (saved && !['missing', 'barcode_only', 'not_configured'].includes(saved.status)) {
    status = 'Этикетка недоступна';
    hint = `${labelStatusText[saved.status]} Загрузите готовую этикетку или сгенерируйте её.`;
  }
  return <>
    <h3><FileImage size={18}/>Этикетка товара</h3>
    <div className={`catalog-label-content ${compact ? 'compact' : ''}`}>
      {src && !imageFailed && <div className="catalog-media-preview catalog-label-image">
        <img key={src} src={src} alt="Этикетка товара" onLoad={() => setImageResult({ url: src, loaded: true })}
          onError={() => setImageResult({ url: src, loaded: false })}/>
      </div>}
      <div className="catalog-label-details">
        <div role="status" className={`catalog-label-status ${loaded && !draftUrl ? 'is-present' : ''}`}>
          {status}
        </div>
        {hint && <p className="muted help">{hint}</p>}
      </div>
    </div>
    {missingFields.length > 0 && <p className="catalog-label-warning">
      <CircleAlert size={16} aria-hidden="true"/>
      <span>{missingFields.length === 1 && missingFields[0] === 'штрихкод'
        ? 'Не хватает штрихкода'
        : `Для генерации заполните: ${missingFields.join(', ')}`}</span>
    </p>}
    {barcodeField}
    <div className="actions catalog-label-actions">
      {onFill && missingFields.length>0 && <Button disabled={busy} onClick={onFill}>Перейти к заполнению</Button>}
      {loaded && !draftUrl && <Button disabled={busy} onClick={onPrint}><Printer size={16}/>Печать и скачивание</Button>}
      <Button disabled={busy || missingFields.length > 0} onClick={onGenerate}>{generating ? 'Генерируем…' : `Сгенерировать для ${market}`}</Button>
      <Button disabled={busy} onClick={onUpload}>Загрузить файл</Button>
      {failed && !draftUrl && <Button disabled={busy} onClick={() => { setImageResult(undefined); onRetry(); }}>Проверить ещё раз</Button>}
    </div>
  </>;
}
