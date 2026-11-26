import type { Market } from "./model";

export type CatalogWbPhoto = {
  sku: string;
  store: "1" | "2";
  market: Market;
  wbId: string;
  title: string;
  photoUrl: string;
};

export type CatalogWbPhotoResult = {
  sku: string;
  status: "created" | "updated" | "already" | "review";
};

export const catalogWbPhotoBatchSize = 16;
