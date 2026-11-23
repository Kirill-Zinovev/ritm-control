const maxAgeMs = {box:90_000,roll:45_000};
const workspaceKey = ({department,id}) => 'printing-' + department + '-workspace:' + id;
const revisionKey = group => workspaceKey(group) + ':revision';

export function printingReadModel(store) {
  return {
    async invalidate(group) {
      await store.db.prepare(`INSERT INTO cloud_state(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(revisionKey(group),JSON.stringify(crypto.randomUUID()),store.now()).run();
    },

    async read(group, source, fresh, load) {
      const key = workspaceKey(group);
      const sourceAt = source.snapshotAt;
      if (!sourceAt) return load();
      const revision = await store.readMeta(revisionKey(group));
      const getSaved = async () => {
        if (fresh) return null;
        const saved = await store.snapshot(key).catch(() => null);
        if (!saved || saved.value.sourceAt !== sourceAt || saved.value.revision !== revision ||
            store.now()-saved.at >= maxAgeMs[group.department]) return null;
        return saved.value.details;
      };
      const saved = await getSaved();
      if (saved) return saved;

      let lease;
      try { lease = await store.acquire(key,65_000); }
      catch (error) {
        if (error?.code === 'cloud_operation_busy') return null;
        return load();
      }
      try {
        const current = await getSaved();
        if (current) return current;
        const details = await load();
        if (await store.readMeta(revisionKey(group)) !== revision) return null;
        if (details.writeReady && details.detailsAvailable) {
          await store.saveSnapshot(key,{sourceAt,revision,details},lease).catch(() => {});
        }
        return details;
      } finally {
        await store.release(lease).catch(() => {});
      }
    },
  };
}
