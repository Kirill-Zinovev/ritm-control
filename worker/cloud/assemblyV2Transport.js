import { createHash, createHmac, randomUUID } from "node:crypto";
import { CloudError } from "./access.js";
export const assemblyV2Origin =
  "https://assembly-v2.zinovevkirill234.chatgpt.site";
export function assemblyV2Configured(bindings) {
  return (
    bindings.RITM_ASSEMBLY_V2_TARGET_URL === assemblyV2Origin &&
    /^[a-f0-9]{64}$/.test(bindings.RITM_ASSEMBLY_V2_FEED_SECRET || "")
  );
}
export async function callAssemblyV2(
  bindings,
  path,
  {
    method = "GET",
    body = "",
    fetcher = fetch,
    now = Date.now(),
    timeout = 20000,
  } = {},
) {
  if (
    !assemblyV2Configured(bindings) ||
    !/^\/api\/ritm\/(?:sync|deliver|warehouse(?:\/dispatch)?)(?:\?|$)/.test(
      path,
    )
  )
    throw new CloudError(
      "assembly_v2_unconfigured",
      "Связь с новым Assembly не настроена.",
      503,
    );
  const at = String(now),
    nonce = randomUUID();
  const signature = createHmac("sha256", bindings.RITM_ASSEMBLY_V2_FEED_SECRET)
    .update(
      JSON.stringify([
        1,
        method,
        path,
        at,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ]),
    )
    .digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-assembly-v2-at": at,
    "x-assembly-v2-nonce": nonce,
    "x-assembly-v2-signature": signature,
  };
  if (bindings.RITM_ASSEMBLY_V2_TARGET_TOKEN)
    headers["OAI-Sites-Authorization"] =
      "Bearer " + bindings.RITM_ASSEMBLY_V2_TARGET_TOKEN;
  return fetcher(assemblyV2Origin + path, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
}
