// Small Node-shaped adapter over the reviewed portable primitives. Shared
// domain modules keep their existing hash/signature formats in Workers.
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
const bytes = (value) => typeof value === "string" ? utf8ToBytes(value) : new Uint8Array(value);
function wrapper(state) {
  return {
    update(value) { state.update(bytes(value)); return this; },
    digest(encoding) {
      const result = state.digest();
      if (encoding === "hex") return bytesToHex(result);
      if (!encoding) return result;
      throw new TypeError("Unsupported digest encoding");
    },
  };
}
export function createHash(algorithm) {
  if (algorithm.toLowerCase() !== "sha256") throw new TypeError("Unsupported digest");
  return wrapper(sha256.create());
}
export function createHmac(algorithm, key) {
  if (algorithm.toLowerCase() !== "sha256") throw new TypeError("Unsupported HMAC");
  return wrapper(hmac.create(sha256, bytes(key)));
}
export const randomUUID = () => crypto.randomUUID();
export function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  const range = max - min;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || range <= 0 || range > 0x100000000) throw new RangeError("Unsupported random range");
  const limit = Math.floor(0x100000000 / range) * range;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return min + buffer[0] % range;
}
