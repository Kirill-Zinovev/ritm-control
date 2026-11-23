import {BOX_GATEWAY_BATCH} from './workspace-write.mjs';

// Keep the IDs of all requested records and resume from the first batch
// whose result was not confirmed. Google may already have applied that batch.
export async function submitBoxBatch(request,send,checkpoint) {
  const {confirmedResults = [],...payload} = request;
  const {items} = payload;
  const results = [...confirmedResults];
  for (let offset=results.length;offset<items.length;offset+=BOX_GATEWAY_BATCH) {
    const part = items.slice(offset,offset+BOX_GATEWAY_BATCH);
    const reply = await send({...payload,items:part});
    if (reply.rejected) {
      if (!results.length) return reply;
      return {results:[...results,...items.slice(offset).map(item=>({
        rowId:item.rowId,ok:false,notSaved:true,error:reply.message,
      }))]};
    }
    if (!Array.isArray(reply.results) || reply.results.length !== part.length ||
        reply.results.some((result,index) => result.rowId !== part[index].rowId)) {
      throw new Error('Журнал не подтвердил результаты пакета.');
    }
    results.push(...reply.results);
    if (results.length < items.length) checkpoint({...payload,confirmedResults:results});
  }
  return {results};
}
