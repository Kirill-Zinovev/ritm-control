import type {SqlStore} from "./database";
import type {RitmSupply} from "../shared/ritm";
import {photoAllowed} from "../shared/catalog";
export async function syncSourcePhotos(store: SqlStore, source: RitmSupply, revision: number) {
  const images = source.positions.filter(p => typeof p.photoUrl === "string" && photoAllowed(p.photoUrl)).map(p => ({
    positionId: p.positionId, sku: p.sku, url: p.photoUrl!,
  }));
  if (!images.length) return;
  await store.batch([
    {sql: `insert into av2_source_photos(position_id,shipment_id,sku,url,source_revision)
      select json_extract(value,'$.positionId'),?,json_extract(value,'$.sku'),json_extract(value,'$.url'),? from json_each(?) where 1
      on conflict(position_id) do update set sku=excluded.sku,url=excluded.url,source_revision=excluded.source_revision
      where av2_source_photos.shipment_id=excluded.shipment_id and av2_source_photos.source_revision<=excluded.source_revision
        and (av2_source_photos.url<>excluded.url or av2_source_photos.sku<>excluded.sku)`,args:[source.shipmentId,revision,JSON.stringify(images)]},
    {sql:"update av2_meta set revision=revision+1 where id=1 and changes()>0",args:[]},
  ]);
}
