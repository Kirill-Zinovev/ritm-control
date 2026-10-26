import {CloudError} from './access.js';
import {sourceId} from './config.js';
import {digest} from './store.js';
// Operational backup only: never exports identities, credentials or AI Center.
export async function exportCloud(bindings,store) {
  const lease=await store.acquire();
  try {
    const scope=await store.scope(lease);
    if(scope.meta('migrationReady')!==true)throw new CloudError('migration_not_imported','Облачный журнал ещё не готов к выгрузке.',409);
    const metadata={productionSupplies:scope.meta('productionSupplies')||[],productionSupplyOperations:scope.meta('productionSupplyOperations')||[],rollPrintingAdditionalSheets:scope.meta('rollPrintingAdditionalSheets')||[]};
    const pendingWrites=[...(scope.meta('migrationPendingWrites')||[]),...(scope.meta('externalRepairs')||[]).filter(row=>['writing','uncertain'].includes(row.status)).map(row=>({id:row.operationId,table:row.table,status:row.status,documentId:row.documentId}))];
    const snapshots=[];for(const kind of ['printing','assembly']){const snapshot=await store.snapshot(kind);if(snapshot)snapshots.push({kind,at:new Date(snapshot.at).toISOString(),value:snapshot.value});}
    const sources=Object.fromEntries(['seasonalPrintingId','rollPrintingId','boxPrintingId','catalogId','fboSourceId','assemblyDatabaseId'].map(key=>[key,sourceId(bindings,key)]));
    const payload={sources,metadata,rollOperations:[...scope.operations.values()].filter(row=>row.kind==='roll').map(row=>row.value),syncEvents:scope.syncEvents(),transferPreviews:[...scope.previews.values()],pendingWrites,snapshots};
    await store.renew(lease);
    return {format:'ritm-sites-migration',version:1,id:crypto.randomUUID(),createdAt:new Date(store.now()).toISOString(),digest:await digest(JSON.stringify(payload)),payload};
  }finally{await store.release(lease);}
}
