import { isCatalogMedia } from "../shared/catalog-editor";
import { useEffect, useState } from "react";
import { catalogPhotoUrl, sourcePhotoUrl } from "./catalog-client";
import { photoAllowed } from "../shared/catalog";
import "./product-photo.css";
export function ProductPhoto({
  importId,
  id,
  sku,
  sourceUrl,
  className = "",
}: {
  importId: string;
  id: string | null;
  sku: string;
  sourceUrl?: string | null;
  className?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [id, importId, sourceUrl]);
  const verified = sourceUrl && (photoAllowed(sourceUrl) || isCatalogMedia(sourceUrl)) ? sourceUrl : null;
  const candidates = [
    verified,
    id && importId ? catalogPhotoUrl(importId, id) : null,
    verified && !isCatalogMedia(verified) ? sourcePhotoUrl(verified) : null,
    id && importId ? catalogPhotoUrl(importId, id, 1) : null,
  ].filter((v): v is string => !!v);
  return candidates[attempt] ? (
    <img
      className={`catalog-photo ${className}`}
      src={candidates[attempt]}
      alt={`Фото ${sku}`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      width={64}
      height={64}
      onError={() => setAttempt(n => n + 1)}
    />
  ) : (
    <span className={`catalog-photo photo-placeholder ${className}`}>
      {candidates.length ? "Фото недоступно" : "Нет фото"}
    </span>
  );
}
