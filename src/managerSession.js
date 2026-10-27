const SESSION_KEY = "ritm.manager.session";

export function saveManagerSession(token) {
  try {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false;
    window.sessionStorage.setItem(SESSION_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearManagerSession() {
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export function installManagerSessionFetch() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    let url;
    try {
      const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      url = new URL(rawUrl, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }

    const path = url.pathname;
    const needsManagerSession = path === "/api/runtime"
      || path === "/api/auth/change-pin"
      || path === "/api/auth/logout"
      || path === "/api/assembly"
      || path === "/api/printing"
      || path === "/api/warehouse"
      || path === "/api/warehouse/dispatch"
      || path === "/api/cloud/registry"
      || path === "/api/roll-supplies"
      || path === "/api/assembly-transfers"
      || path.startsWith("/api/roll-supplies/")
      || path.startsWith("/api/assembly-transfers/");
    if (url.origin !== window.location.origin || !needsManagerSession)
      return nativeFetch(input, init);

    let token = null;
    try { token = window.sessionStorage.getItem(SESSION_KEY); } catch {}
    if (!token) return nativeFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    if (headers.has("authorization")) return nativeFetch(input, init);
    headers.set("authorization", `Bearer ${token}`);
    return nativeFetch(input, { ...init, headers });
  };
}
