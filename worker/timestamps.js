export function sourceTimestamp(value) {
  const raw = String(value ?? "").trim();
  const m = raw.match(
    /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (m) {
    const day = m[3] + "-" + m[2] + "-" + m[1];
    const parsed = new Date(day + "T12:00:00Z");
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day ||
      Number(m[4] || 0) > 23 ||
      Number(m[5] || 0) > 59 ||
      Number(m[6] || 0) > 59
    )
      return null;
    return new Date(
      day +
        "T" +
        (m[4] || "00") +
        ":" +
        (m[5] || "00") +
        ":" +
        (m[6] || "00") +
        "+03:00",
    ).toISOString();
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(Date.parse(raw))
    ? new Date(raw).toISOString()
    : null;
}
