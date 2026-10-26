import { useEffect, useState } from "react";
import { Notice } from "./ui";

type CloudAccess = { mode: string; authenticated: boolean; authorized: boolean; signInPath: string };
export function CloudAccessNotice() {
  const [access, setAccess] = useState<CloudAccess | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/runtime", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => response.ok && response.headers.get("content-type")?.includes("application/json") ? response.json() : null)
      .then((value) => { if (value?.mode === "cloud" && !controller.signal.aborted) setAccess(value); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!access || access.authorized) return null;
  return (
    <Notice tone="warning">
      {access.authenticated ? "Вы вошли в ChatGPT. Доступ к рабочему кабинету RITM для этого аккаунта ещё не выдан." : <>
        Чтобы открыть рабочие данные, <a href={access.signInPath.startsWith("/signin-with-chatgpt?") ? access.signInPath : "/signin-with-chatgpt"} target="_top">войдите через ChatGPT</a>.
      </>}
    </Notice>
  );
}
