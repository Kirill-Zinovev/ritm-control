import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyTelegramInitData(
  initData,
  botToken,
  { now = Date.now(), maxAgeMs = 5 * 60_000, futureSkewMs = 30_000 } = {},
) {
  if (
    typeof initData !== "string" ||
    !initData ||
    initData.length > 8192 ||
    typeof botToken !== "string" ||
    !botToken
  )
    return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const entries = [...params.entries()];
  if (
    entries.length < 3 ||
    new Set(entries.map(([key]) => key)).size !== entries.length
  )
    return null;
  const values = new Map(entries),
    suppliedHex = values.get("hash");
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex || "")) return null;
  const authDate = Number(values.get("auth_date"));
  if (!Number.isSafeInteger(authDate)) return null;
  const ageMs = now - authDate * 1000;
  if (ageMs < -futureSkewMs || ageMs > maxAgeMs) return null;
  let user;
  try {
    user = JSON.parse(values.get("user") || "null");
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.is_bot === true)
    return null;
  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  return {
    userId: String(user.id),
    user,
    chatType: values.get("chat_type") || null,
    authDate: authDate * 1000,
    initDataHash: createHash("sha256").update(initData).digest("hex"),
  };
}
