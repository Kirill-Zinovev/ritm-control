import { CloudError } from './access.js';
import { cloudConfig } from './config.js';
export async function recordCutover(input, bindings, store) {
  if (bindings.RITM_CLOUD_IMPORT_ENABLED !== 'true' || cloudConfig(bindings).writesEnabled || input.explicitCutoverApproval !== true || input.localWriterDisabled !== true || !bindings.RITM_CLOUD_CUTOVER_ID || !/^[a-f0-9]{64}$/.test(input.migrationDigest || ''))
    throw new CloudError('cutover_not_ready','Переключение записи не подтверждено.',409);
  return store.withScope(async scope => {
    const receipt = await store.db.prepare('SELECT manifest FROM cloud_imports WHERE source_digest=?').bind(input.migrationDigest).first();
    if (!receipt || !scope.meta('migrationReady') || scope.supplyWriteConflict(cloudConfig(bindings).writableSources) || (scope.meta('productionSupplyOperations') || []).some(row=>row.status!=='verified'))
      throw new CloudError('cutover_not_ready','Импорт или незавершённые операции ещё не сверены.',409);
    const prior=scope.meta('cloudCutover');
    if(prior && (prior.id!==bindings.RITM_CLOUD_CUTOVER_ID || prior.migrationDigest!==input.migrationDigest))throw new CloudError('cutover_conflict','Сохранено другое переключение. Автоматическая замена запрещена.',409);
    const value=prior||{id:bindings.RITM_CLOUD_CUTOVER_ID,migrationDigest:input.migrationDigest,localWriterDisabled:true,at:new Date(store.now()).toISOString()};
    scope.meta('cloudCutover',value);scope.log('cloud_cutover_confirmed','История сверена; отключение локального обработчика поставок подтверждено владельцем.');
    return {ok:true,cutover:value,writesEnabled:false};
  });
}
