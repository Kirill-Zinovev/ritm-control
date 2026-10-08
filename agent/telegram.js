export async function flushTelegram(
  store,
  config,
  { fetcher = fetch, now = new Date(), signal } = {},
) {
  if (!config.enabled || !config.token || !config.chatId)
    return { status: "not_configured" };
  // No incoming commands or repair approvals in stage 1.
  const pending = store.db
    .prepare(
      "SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 10",
    )
    .all(now.toISOString());
  for (const entry of pending) {
    const incident = store.getIncident(entry.incident_id);
    if (
      !incident ||
      incident.status !== "open" ||
      !["critical", "high"].includes(incident.severity)
    ) {
      store.db
        .prepare("UPDATE outbox SET status='cancelled' WHERE id=?")
        .run(entry.id);
      continue;
    }
    const text = [
      "⚠️ RITM AI — обнаружена проблема",
      "Отдел: " + incident.department,
      "Источник: " + incident.sourceName,
      incident.sheet ? "Лист: " + incident.sheet : "",
      incident.cell ? "Ячейка: " + incident.cell : "",
      "Проблема: " + incident.title,
      "Обоснование: " + incident.cause,
      "Действие: " + incident.action,
      "ID инцидента: " + incident.id,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 3500);
    store.db
      .prepare(
        "UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=?",
      )
      .run(entry.id);
    try {
      const response = await fetcher(
        "https://api.telegram.org/bot" + config.token + "/sendMessage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: config.chatId,
            text,
            disable_web_page_preview: true,
            ...(incident.sourceUrl?.startsWith("https://")
              ? {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "Открыть источник", url: incident.sourceUrl }],
                    ],
                  },
                }
              : {}),
          }),
          signal: AbortSignal.any(
            [AbortSignal.timeout(15000), signal].filter(Boolean),
          ),
        },
      );
      const result = await response.json();
      if (response.ok && result.ok) {
        store.db
          .prepare("UPDATE outbox SET status='sent' WHERE id=?")
          .run(entry.id);
        store.log(
          "notification_sent",
          "Уведомление владельцу отправлено",
          incident.id,
        );
      } else {
        const retry = response.status === 429 || response.status >= 500;
        const attempts = entry.attempts + 1;
        const seconds = Math.min(
          Math.max(
            Number(result.parameters?.retry_after) || 60 * 2 ** attempts,
            30,
          ),
          86400,
        );
        store.db
          .prepare("UPDATE outbox SET status=?,next_at=? WHERE id=?")
          .run(
            retry && attempts < 5 ? "pending" : "failed",
            new Date(now.getTime() + seconds * 1000).toISOString(),
            entry.id,
          );
        store.log(
          "notification_failed",
          "Telegram отклонил уведомление: HTTP " +
            response.status +
            ". Проверки продолжаются.",
          incident.id,
        );
      }
    } catch {
      // Network loss after sending may mean delivery succeeded. Do not duplicate it automatically.
      store.db
        .prepare("UPDATE outbox SET status='uncertain' WHERE id=?")
        .run(entry.id);
      store.log(
        "notification_uncertain",
        "Результат отправки Telegram неизвестен; повтор заблокирован, мониторинг продолжается.",
        incident.id,
      );
    }
  }
  return {
    status: "configured",
    pending: store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE status='pending'")
      .get().n,
    uncertain: store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE status='uncertain'")
      .get().n,
    failed: store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE status='failed'")
      .get().n,
  };
}
