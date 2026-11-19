import { CloudError } from './access.js';

const preferences = {
  enabled: {key: 'bitrixNotificationsEnabled', valid: value => typeof value === 'boolean'},
  humorLevel: {key: 'bitrixHumorLevel', valid: value => ['off', 'sometimes', 'always'].includes(value)},
  reminderHumorLevel: {key: 'bitrixReminderHumorLevel', valid: value => ['off', 'sometimes', 'always'].includes(value)},
};

// These independent settings are never written by production callbacks. Update
// only their own row atomically, without taking or clearing the production lease.
// Notification IDs, delivery state and phrase cursors still use the shared lease.
export async function saveBitrixPreference(store, field, value) {
  const preference = Object.hasOwn(preferences, field) ? preferences[field] : null;
  if (!preference || !preference.valid(value)) throw new CloudError('bitrix_setting_invalid', 'Проверьте настройку уведомлений.', 400);
  await store.db.prepare('INSERT INTO cloud_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(preference.key, JSON.stringify(value), store.now()).run();
}

// A chat membership check runs outside the database lock. Compare the encrypted
// configuration it checked before saving, so another owner tab cannot be lost.
export async function saveBitrixConfiguration(store, value, expected) {
  const result = expected == null
    ? await store.db.prepare('INSERT INTO cloud_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
      .bind('bitrixNotificationConfig', JSON.stringify(value), store.now()).run()
    : await store.db.prepare('UPDATE cloud_state SET value=?,updated_at=? WHERE key=? AND value=?')
      .bind(JSON.stringify(value), store.now(), 'bitrixNotificationConfig', JSON.stringify(expected)).run();
  if (result.meta?.changes !== 1) throw new CloudError('bitrix_settings_changed', 'Подключение Аркадия уже изменилось в другом окне. Обновите настройки и повторите сохранение.', 409);
}
