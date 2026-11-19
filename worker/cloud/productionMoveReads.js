// Request-local preflight reads only. The very first mutation permanently
// disables reuse, so every receipt and post-write verification stays fresh.
export function createMoveReadSession(writers) {
  let active = true;
  const caches = [];
  const stop = () => {active = false; for (const cache of caches) cache.clear();};
  const wrapped = Object.fromEntries(Object.entries(writers).map(([department, writer]) => {
    const cache = new Map(); caches.push(cache);
    const proxy = new Proxy(writer, {get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (['metadata','grid','manifest','verifyEditAccess'].includes(property)) return async (...args) => {
        if (!active) return value.apply(receiver, args);
        const key = JSON.stringify([property,args]);
        if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => value.apply(receiver, args)).catch(error => {cache.delete(key); throw error;}));
        return structuredClone(await cache.get(key));
      };
      return (...args) => {
        if (property === 'execute' || (property === 'request' && (args[1]?.write === true || (args[1]?.method && args[1].method !== 'GET')))) stop();
        return value.apply(receiver, args);
      };
    }});
    return [department,proxy];
  }));
  return {writers:wrapped,stop};
}
