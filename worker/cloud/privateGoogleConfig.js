// Build-time alias for the local file-backed configuration. These values are
// supplied by Sites runtime bindings; no private file is packaged or read.
import { env } from "cloudflare:workers";
import { sourceId, assemblyUrl, sourceIds } from "./config.js";
export const privateGoogleSource = (key) => sourceId(env, key);
export const privateGoogleUrl = () => assemblyUrl(env);
export const privateTestWriterEmail = () => "";
export const protectedProductionDocumentIds = () => sourceIds(env);
