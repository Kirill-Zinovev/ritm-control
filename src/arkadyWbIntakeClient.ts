export const arkadyPhotoLimit = 1_000_000;
export const arkadyLabelLimit = 200_000;
export const arkadyPhotoTypes = ["image/jpeg", "image/png", "image/webp"];

export type WbIntakeInput = {
  store: "1" | "2";
  barcode: string;
  article?: string;
  name?: string;
  packaging?: string;
};

export type WbIntakeReview = {
  canEdit: boolean;
  mode: "create" | "update";
  draft: Required<WbIntakeInput>;
  fingerprint: string;
  missing: string[];
  hasPhoto: boolean;
  hasLabel: boolean;
  source: "exact-card" | "same-article" | "input";
};

type Asset = {
  filename: string;
  mimeType: string;
  content: string;
};

export class ArkadyWbIntakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function intakeRequest<T>(
  input: object,
  signal: AbortSignal,
  timeout: number,
) {
  const response = await fetch("/api/arkady/catalog/wb-intake", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) {
    throw new ArkadyWbIntakeError(
      data?.message || "Не удалось получить ответ справочника.",
      response.status,
    );
  }
  return data as T;
}

export function prepareWbIntake(input: WbIntakeInput, signal: AbortSignal) {
  return intakeRequest<WbIntakeReview>(
    { action: "prepare", draft: input },
    signal,
    22_000,
  );
}

async function encodeAsset(blob: Blob, filename: string): Promise<Asset> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Не удалось прочитать изображение."));
    reader.onerror = () =>
      reject(new Error("Не удалось прочитать изображение."));
    reader.readAsDataURL(blob);
  });
  const prefix = `data:${blob.type};base64,`;
  if (!dataUrl.startsWith(prefix))
    throw new Error("Не удалось разобрать формат изображения.");
  return {
    filename,
    mimeType: blob.type,
    content: dataUrl.slice(prefix.length),
  };
}

export async function confirmWbIntake(
  input: WbIntakeInput,
  fingerprint: string,
  approvalId: string,
  media: { photo: File | null; label: Blob | null },
  signal: AbortSignal,
) {
  const { photo, label } = media;
  if (
    photo &&
    (!arkadyPhotoTypes.includes(photo.type) ||
      !photo.size ||
      photo.size > arkadyPhotoLimit)
  ) {
    throw new Error(
      "Фото должно быть в формате JPEG, PNG или WebP и весить до 1 МБ.",
    );
  }
  if (
    label &&
    (label.type !== "image/png" || !label.size || label.size > arkadyLabelLimit)
  ) {
    throw new Error("Этикетка должна быть в формате PNG и весить до 200 КБ.");
  }
  const [photoAsset, labelAsset] = await Promise.all([
    photo &&
      encodeAsset(
        photo,
        `product-photo.${photo.type === "image/jpeg" ? "jpg" : photo.type.split("/")[1]}`,
      ),
    label && encodeAsset(label, "label.png"),
  ]);
  return intakeRequest<{ entryId: string; revision: string | number }>(
    {
      action: "confirm",
      draft: {
        ...input,
        ...(photoAsset ? { photo: photoAsset } : {}),
        ...(labelAsset ? { label: labelAsset } : {}),
      },
      fingerprint,
      approvalId,
      explicitWriteApproval: true,
    },
    signal,
    45_000,
  );
}
