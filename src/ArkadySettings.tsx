import { useEffect, useRef, useState } from 'react';
import { useCloudAuth } from './CloudAuth';
import { Button, Notice } from './ui';
import './arkadySettings.css';

type HumorLevel = 'off' | 'sometimes' | 'always';
type Settings = { configured: boolean; enabled: boolean; humorLevel: HumorLevel; reminderHumorLevel: HumorLevel; chatId: string; pending: number; uncertain: number; lastSentAt: string | null };

export default function ArkadySettings() {
  const auth = useCloudAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editingChat, setEditingChat] = useState(false);
  const [chatId, setChatId] = useState('');
  const refreshSequence = useRef(0);
  const canManage = auth.role === 'owner';
  async function request(path: string, body?: object) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'Не удалось получить настройки.');
    return result;
  }
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try { const current = await request('/api/bitrix-settings'); if (sequence === refreshSequence.current) { setSettings(current); setError(''); } }
    catch (cause) { if (sequence === refreshSequence.current) setError(cause instanceof Error ? cause.message : 'Не удалось получить настройки.'); }
  }
  useEffect(() => { if (canManage) void refresh(); }, [canManage]);
  async function toggle() {
    if (!settings) return;
    refreshSequence.current++;
    setBusy(true); setMessage(''); setError('');
    try { setSettings(await request('/api/bitrix-settings', {enabled: !settings.enabled})); setMessage('Настройка сохранена.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку.'); }
    finally { setBusy(false); }
  }
  async function sendTest() {
    setBusy(true); setMessage(''); setError('');
    try {
      const result = await request('/api/bitrix-setup/test', {});
      if (result.results?.shared === 'sent') setMessage('Тестовое сообщение отправлено в общий чат.');
      else setError('Доставка не подтверждена. Проверьте чат перед повторной отправкой.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отправить тест.'); }
    finally { setBusy(false); }
  }
  async function changeHumor(humorLevel: HumorLevel) {
    refreshSequence.current++;
    setBusy(true); setMessage(''); setError('');
    try { setSettings(await request('/api/bitrix-settings', {humorLevel})); setMessage('Степень юмора сохранена.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку.'); }
    finally { setBusy(false); }
  }
  async function changeReminderHumor(reminderHumorLevel: HumorLevel) {
    refreshSequence.current++;
    setBusy(true); setMessage(''); setError('');
    try { setSettings(await request('/api/bitrix-settings', {reminderHumorLevel})); setMessage('Частота шуток в напоминаниях сохранена.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку.'); }
    finally { setBusy(false); }
  }
  async function saveChat(event: React.FormEvent) {
    refreshSequence.current++;
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try { setSettings(await request('/api/bitrix-settings', {chatId:chatId.trim()})); setEditingChat(false); setMessage('Чат обновлён.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить чат.'); }
    finally { setBusy(false); }
  }
  if (!canManage) return <section className="panel arkady-panel"><h2>Доступ ограничен</h2><p>Раздел «Аркадий» доступен только владельцу RITM.</p></section>;
  return <section className="panel arkady-panel">
    <div className="arkady-heading"><img src="/ritm-chameleon.png" alt="Аркадий" /><div><h2>Аркадий на связи</h2><p>Уведомления о поставках и запасах для печатных участков.</p></div></div>
    {error && <Notice tone="warning">{error}</Notice>}{message && <Notice>{message}</Notice>}
    {!settings ? <p>Загружаем настройки…</p> : <>
      <div className="arkady-row"><div><h3>Подключение к Битрикс24</h3><p>{settings.configured ? 'Настройки подключения сохранены.' : 'Подключение не настроено или недоступно.'}</p><small>Последняя подтверждённая отправка: {settings.lastSentAt ? new Date(settings.lastSentAt).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'}) : 'пока нет данных'}.</small></div><span className={`arkady-badge ${settings.configured ? 'ok' : ''}`}>{settings.configured ? 'Настроено' : 'Не настроено'}</span></div>
      <div className="arkady-row"><div><h3>Общий чат</h3><p>{settings.chatId === 'chat37628' ? 'RITM · Рулонная печать' : 'Чат Битрикс24'} · {settings.chatId || 'не выбран'}</p><small>Сюда приходят задания для рулонной печати и бокса. Добавьте Аркадия в новый чат до изменения ID.</small>{editingChat && <form className="arkady-chat-form" onSubmit={saveChat}><label htmlFor="arkady-chat-id">ID чата</label><input id="arkady-chat-id" value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="Например, chat12345" required pattern="chat[0-9]+" /><Button kind="primary" disabled={busy}>Сохранить чат</Button><Button type="button" onClick={()=>setEditingChat(false)} disabled={busy}>Отмена</Button></form>}</div><div className="arkady-chat-actions"><Button onClick={()=>{setChatId(settings.chatId);setEditingChat(true);}} disabled={busy || !settings.configured}>Изменить чат</Button><a href="https://kaleidoskop.bitrix24.ru/online/" target="_blank" rel="noreferrer">Открыть Битрикс24 ↗</a></div></div>
      <div className="arkady-row"><div><h3>Автоматические уведомления</h3><p>{settings.enabled ? 'Включены' : 'Отключены'}</p><small>{settings.enabled ? 'Аркадий сообщает о новых заданиях и подтверждённой готовности печати и порезки.' : 'Новые сообщения не создаются. Ранее ожидавшие отправки остаются в очереди.'}</small></div><Button onClick={toggle} disabled={busy || !settings.configured}>{settings.enabled ? 'Отключить' : 'Включить'}</Button></div>
      <div className="arkady-row"><div><h3>Степень юмора</h3><p>Как часто Аркадий добавляет шутки к заданиям.</p><small>Важные данные всегда остаются в сообщении. Уже использованные шутки не повторяются.</small></div><label className="arkady-humor"><span>Частота шуток</span><select value={settings.humorLevel || 'always'} onChange={event => void changeHumor(event.target.value as HumorLevel)} disabled={busy}><option value="off">Без шуток</option><option value="sometimes">Иногда — каждое третье сообщение</option><option value="always">Максимум — в каждом сообщении</option></select></label></div>
      <div className="arkady-row"><div><h3>Юмор в напоминаниях</h3><p>Отдельная настройка для срочных заданий, ещё не взятых в работу.</p><small>Шутки не повторяются; когда они закончатся, напоминания продолжат приходить без них.</small></div><label className="arkady-humor"><span>Частота шуток в напоминаниях</span><select value={settings.reminderHumorLevel || 'off'} onChange={event => void changeReminderHumor(event.target.value as HumorLevel)} disabled={busy}><option value="off">Без шуток</option><option value="sometimes">Иногда — каждое третье напоминание</option><option value="always">В каждом напоминании</option></select></label></div>
      <div className="arkady-row"><div><h3>Состояние отправки</h3><p>Ожидают: {settings.pending} · Не подтверждены: {settings.uncertain}</p><small>Неподтверждённые сообщения автоматически не повторяются, чтобы избежать дублей.</small></div><Button onClick={() => void refresh()} disabled={busy}>Обновить</Button></div>
      <div className="arkady-actions"><Button kind="primary" onClick={sendTest} disabled={busy || !settings.configured}>Отправить тест в чат</Button><a href="/bitrix-setup" target="_blank" rel="noreferrer">Подключение и аватар ↗</a></div>
    </>}
  </section>;
}
