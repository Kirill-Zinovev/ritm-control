import { useEffect, useRef, useState } from 'react';
import { useCloudAuth } from './CloudAuth';
import { Button, Notice } from './ui';
import './arkadySettings.css';

type HumorLevel = 'off' | 'sometimes' | 'always';
type CutReminderRecipients = { roll: string | null; box: string | null };
type BitrixRecipient = { id: string; name: string };
type Settings = { configured: boolean; enabled: boolean; humorLevel: HumorLevel; chatId: string; pending: number; uncertain: number; lastSentAt: string | null; cutReminderRecipients?: CutReminderRecipients };

const noCutReminderRecipients: CutReminderRecipients = { roll: null, box: null };
const cutReminderDepartments = [
  { id: 'roll', name: 'Рулонная печать' },
  { id: 'box', name: 'Бокс' },
] as const;

export default function ArkadySettings() {
  const auth = useCloudAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editingChat, setEditingChat] = useState(false);
  const [chatId, setChatId] = useState('');
  const [cutReminderDraft, setCutReminderDraft] = useState<CutReminderRecipients | null>(null);
  const [cutRecipientDirectory, setCutRecipientDirectory] = useState<BitrixRecipient[] | null>(null);
  const [cutDirectoryError, setCutDirectoryError] = useState('');
  const cutDirectoryRequest = useRef<AbortController | null>(null);
  const refreshSequence = useRef(0);
  const canManage = auth.role === 'owner';
  async function request(path: string, body?: object, signal?: AbortSignal) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal, ...(body ? { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.message || 'Не удалось получить настройки.');
    return result;
  }
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try { const current = await request('/api/bitrix-settings'); if (sequence === refreshSequence.current) { setSettings(current); setError(''); } }
    catch (cause) { if (sequence === refreshSequence.current) setError(cause instanceof Error ? cause.message : 'Не удалось получить настройки.'); }
  }
  useEffect(() => { if (canManage) void refresh(); }, [canManage]);
  useEffect(() => () => cutDirectoryRequest.current?.abort(), [canManage]);

  async function loadCutRecipientDirectory() {
    cutDirectoryRequest.current?.abort();
    const controller = new AbortController();
    cutDirectoryRequest.current = controller;
    setCutRecipientDirectory(null);
    setCutDirectoryError('');
    try {
      const data: { recipients?: BitrixRecipient[] } = await request(
        '/api/production-controls?view=bitrix-recipients', undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (!Array.isArray(data.recipients)) throw new Error('Список сотрудников Битрикс24 недоступен.');
      if (!controller.signal.aborted) setCutRecipientDirectory(data.recipients);
    } catch (cause) {
      if (!controller.signal.aborted) setCutDirectoryError(cause instanceof Error ? cause.message : 'Не удалось загрузить сотрудников.');
    }
  }
  function openCutReminderSettings() {
    setCutReminderDraft({ ...(settings?.cutReminderRecipients ?? noCutReminderRecipients) });
    setMessage('');
    setError('');
    void loadCutRecipientDirectory();
  }
  function closeCutReminderSettings() {
    cutDirectoryRequest.current?.abort();
    setCutReminderDraft(null);
  }
  async function saveCutReminderSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!cutReminderDraft || !cutRecipientDirectory || !settings?.enabled) return;
    refreshSequence.current++;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      setSettings(await request('/api/bitrix-settings', { cutReminderRecipients: cutReminderDraft }));
      closeCutReminderSettings();
      setMessage('Получатели напоминаний о порезке сохранены.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить получателей напоминаний.');
    } finally {
      setBusy(false);
    }
  }
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
      if (result.results?.private === 'sent') setMessage('Тестовое сообщение отправлено Кириллу Зиновьеву.');
      else setError('Доставка не подтверждена. Проверьте личный чат перед повторной отправкой.');
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
  async function saveChat(event: React.FormEvent) {
    refreshSequence.current++;
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try { setSettings(await request('/api/bitrix-settings', {chatId:chatId.trim()})); setEditingChat(false); setMessage('Чат обновлён.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить чат.'); }
    finally { setBusy(false); }
  }
  if (!canManage) return <section className="panel arkady-panel"><h2>Доступ ограничен</h2><p>Раздел «Аркадий» доступен только владельцу RITM.</p></section>;
  const cutRecipients = settings?.cutReminderRecipients ?? noCutReminderRecipients;
  const cutRemindersAvailable = settings?.configured && settings.enabled;
  const validCutReminderDraft = cutReminderDraft && cutRecipientDirectory && cutReminderDepartments.every(({ id }) =>
    !cutReminderDraft[id] || cutRecipientDirectory.some(person => person.id === cutReminderDraft[id]),
  );
  return <section className="panel arkady-panel">
    <div className="arkady-heading"><img src="/ritm-chameleon.png" alt="Аркадий" /><div><h2>Аркадий на связи</h2><p>Уведомления о поставках и запасах для печатных участков.</p></div></div>
    {error && <Notice tone="warning">{error}</Notice>}{message && <Notice>{message}</Notice>}
    {!settings ? <p>Загружаем настройки…</p> : <>
      <div className="arkady-row"><div><h3>Подключение к Битрикс24</h3><p>{settings.configured ? 'Настройки подключения сохранены.' : 'Подключение не настроено или недоступно.'}</p><small>Последняя подтверждённая отправка: {settings.lastSentAt ? new Date(settings.lastSentAt).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'}) : 'пока нет данных'}.</small></div><span className={`arkady-badge ${settings.configured ? 'ok' : ''}`}>{settings.configured ? 'Настроено' : 'Не настроено'}</span></div>
      <div className="arkady-row"><div><h3>Общий чат</h3><p>{settings.chatId === 'chat37628' ? 'RITM · Рулонная печать' : 'Чат Битрикс24'} · {settings.chatId || 'не выбран'}</p><small>Сюда приходят задания для рулонной печати и бокса. Добавьте Аркадия в новый чат до изменения ID.</small>{editingChat && <form className="arkady-chat-form" onSubmit={saveChat}><label htmlFor="arkady-chat-id">ID чата</label><input id="arkady-chat-id" value={chatId} onChange={event=>setChatId(event.target.value)} placeholder="Например, chat12345" required pattern="chat[0-9]+" /><Button kind="primary" disabled={busy}>Сохранить чат</Button><Button type="button" onClick={()=>setEditingChat(false)} disabled={busy}>Отмена</Button></form>}</div><div className="arkady-chat-actions"><Button onClick={()=>{setChatId(settings.chatId);setEditingChat(true);}} disabled={busy || !settings.configured}>Изменить чат</Button><a href="https://kaleidoskop.bitrix24.ru/online/" target="_blank" rel="noreferrer">Открыть Битрикс24 ↗</a></div></div>
      <div className="arkady-row"><div><h3>Автоматические уведомления</h3><p>{settings.enabled ? 'Включены' : 'Отключены'}</p><small>{settings.enabled ? 'Аркадий сообщает о новых заданиях и подтверждённой готовности печати и порезки.' : 'Новые сообщения не создаются. Ранее ожидавшие отправки остаются в очереди.'}</small></div><Button onClick={toggle} disabled={busy || !settings.configured}>{settings.enabled ? 'Отключить' : 'Включить'}</Button></div>
      <div className="arkady-row"><div><h3>Степень юмора</h3><p>Как часто Аркадий добавляет шутки к заданиям.</p><small>Важные данные всегда остаются в сообщении. Уже использованные шутки не повторяются.</small></div><label className="arkady-humor"><span>Частота шуток</span><select value={settings.humorLevel || 'always'} onChange={event => void changeHumor(event.target.value as HumorLevel)} disabled={busy}><option value="off">Без шуток</option><option value="sometimes">Иногда — каждое третье сообщение</option><option value="always">Максимум — в каждом сообщении</option></select></label></div>
      <div className="arkady-row"><div><h3>Готовность печати и порезки</h3><p>Личные сообщения Кириллу Зиновьеву и Алексею Соломонову.</p><small>Напоминания о старте срочных заданий приостановлены.</small></div></div>
      <div className="arkady-row arkady-cut-reminders">
        <div className="arkady-cut-reminders-info">
          <h3>Контроль отметок порезки</h3>
          <p>Когда печать готова и в РИТМ Сборке начали упаковку, Аркадий проверит отметки порезки в таблицах печати.</p>
          <small>Если отметок нет, выбранный резчик получит личное сообщение в Битрикс24. По тому же расхождению Аркадий напишет один раз.</small>
          {!cutRemindersAvailable && <small>Подключите Битрикс24 и включите автоматические уведомления, чтобы выбрать резчиков.</small>}
        </div>
        {!cutReminderDraft ? <div className="arkady-cut-reminders-summary">
          {cutReminderDepartments.map(({ id, name }) => <div key={id}>
            <span>{name}</span>
            <span className={`arkady-badge ${cutRecipients[id] && cutRemindersAvailable ? 'ok' : ''}`}>
              {!cutRecipients[id] ? 'Выключено' : cutRemindersAvailable ? 'Резчик выбран' : 'На паузе'}
            </span>
          </div>)}
          <Button onClick={openCutReminderSettings} disabled={busy || !cutRemindersAvailable}>Выбрать резчиков</Button>
        </div> : <form className="arkady-cut-reminders-form" onSubmit={saveCutReminderSettings}>
          {cutDirectoryError && <Notice tone="warning">{cutDirectoryError}</Notice>}
          {!cutRecipientDirectory && !cutDirectoryError && <p role="status">Загружаем сотрудников Битрикс24…</p>}
          {cutRecipientDirectory && cutReminderDepartments.map(({ id, name }) => <label key={id} className="arkady-humor">
            <span>{name}</span>
            <select value={cutReminderDraft[id] || ''} disabled={busy} onChange={event => {
              const selected = event.target.value || null;
              setCutReminderDraft(draft => draft && { ...draft, [id]: selected });
            }}>
              <option value="">Выключено</option>
              {cutReminderDraft[id] && !cutRecipientDirectory.some(person => person.id === cutReminderDraft[id]) &&
                <option value={cutReminderDraft[id]} disabled>Сотрудник недоступен</option>}
              {cutRecipientDirectory.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>)}
          <div className="arkady-chat-actions">
            {cutDirectoryError ? <Button type="button" onClick={() => void loadCutRecipientDirectory()} disabled={busy}>Повторить</Button> :
              <Button kind="primary" disabled={busy || !validCutReminderDraft || !cutRemindersAvailable}>Сохранить получателей</Button>}
            <Button type="button" onClick={closeCutReminderSettings} disabled={busy}>Отмена</Button>
          </div>
        </form>}
      </div>
      <div className="arkady-row"><div><h3>Состояние отправки</h3><p>Ожидают: {settings.pending} · Не подтверждены: {settings.uncertain}</p><small>Неподтверждённые сообщения автоматически не повторяются, чтобы избежать дублей.</small></div><Button onClick={() => void refresh()} disabled={busy}>Обновить</Button></div>
      <div className="arkady-actions"><Button kind="primary" onClick={sendTest} disabled={busy || !settings.configured}>Отправить тест в личку Кириллу</Button><a href="/bitrix-setup" target="_blank" rel="noreferrer">Подключение и аватар ↗</a></div>
    </>}
  </section>;
}
