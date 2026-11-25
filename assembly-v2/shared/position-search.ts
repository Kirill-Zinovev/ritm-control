import type { Market, Position } from "./model";

export type PositionSearchItem = Pick<Position, "id" | "supplyId" | "sku" | "name" | "plan" | "packing"> & {
  supplyTitle: string;
  market: Market;
  store: string;
  storeNeedsReview?: boolean;
};

export type PositionSearchPage = {
  items: PositionSearchItem[];
  nextOffset: number | null;
};

export const positionSearchMinLength = 2;
export const positionSearchMaxLength = 150;

export function isSearchablePosition(position: Pick<Position, "sourceActive" | "storeNeedsReview">) {
  return position.sourceActive !== false || position.storeNeedsReview === true;
}

export function matchesPositionQuery(position: Pick<Position, "sku" | "name">, query: string) {
  return `${position.sku} ${position.name}`.toLocaleLowerCase("ru").includes(query);
}
