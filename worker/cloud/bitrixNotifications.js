// Notification records live in the existing operation journal. An ambiguous
// delivery is never replayed automatically: the message may already exist.
import { nextArkadyPhrase, nextAssignmentJoke } from './arkadyPhrases.js';
import { assignmentPresentation, arkadyMessageFields } from './arkadyCards.js';
import { renderArkadyCard, pngBase64 } from './arkadyCardImage.js';
const departments = new Set(['box', 'roll']);
const clean = value => String(value || '').replace(/[\r\n\[\]]/g, ' ').trim().slice(0, 180);
const jokes = {
  normal: [
    'Я, конечно, умею менять цвет, но печатать за вас пока ни хрена не научился. Погнали! 😎',
    'Задание приехало. Станки уже нервно улыбаются!',
    'Хамелеон всё заметил. Пора творить красоту! 🦎',
    'Работа сама себя не напечатает, блин. Но вместе мы справимся!',
    'Команда, покажем этим артикулам, кто здесь главный?',
    'Я проверил: артикулы на месте и никуда не сбежали. Можно работать!',
    'Задание в деле. Кофе — по желанию, мастерство — обязательно! ☕',
    'План готов. Осталось уговорить станок творить чудеса!',
    'Я тут проследил за заданием обоими глазами. Теперь ваша очередь! 👀',
    'Новая порция работы подъехала. Без паники, мы и не такое печатали!',
    'Аркадий передал задание. Аркадий молодец. Вы тоже будете молодцы! 😎',
    'Артикулы ждут своего звёздного часа. Включаем производственную магию! ✨',
    'Я бы помог руками, но лапки заняты контролем качества. Выручайте! 🦎',
    'План пришёл, шутка тоже. Осталось самое простое — всё напечатать!',
    'Новый заказ на горизонте. Ловите, пока не сменил цвет!',
    'Печатный фронт пополнился. Уверен, команда разберётся красиво!',
    'Аркадий всё записал и ничего не перепутал. Кажется, я заслужил муху! 🪰',
    'Ещё одно задание для наших мастеров. Пусть краска ложится ровно!',
    'Список готов. И да, я снова проверил его двумя глазами!',
    'Команда, это ваш выход. Я буду болеть за вас из чата! 📣',
    'Заказ пойман и передан. Ни один артикул не пострадал!',
    'Если станок спросит, что делать, покажите ему задание. Шучу, станок не спросит.',
    'Работа нашлась. Хорошая новость: она уже аккуратно разложена по участкам!',
    'Задание на месте. Пусть день будет продуктивным, а материалы — послушными!',
  ],
  urgent: [
    'Тут у меня даже глаза в разные стороны перестали смотреть. Ребят, нужно побыстрее! 🦎',
    'Срочка подъехала! Без паники, но тапок в пол. 🚀',
    'Я сменил цвет на тревожный. Команда, это задание ждёт вас в первую очередь!',
    'Станок, собирайся: тут работа с характером и коротким сроком!',
    'Хвостом чую: задание срочное. Не теряем время, но работаем аккуратно!',
    'Аркадий включает режим турбо. Вы тоже? Только без лишней суеты! ⚡',
    'Это та самая срочка, которая нужна была ещё вчера. Погнали!',
    'Мои глаза увидели срочность одновременно. Такого ещё не было! 👀',
    'Срочное задание! Я даже перестал маскироваться, чтобы вы его заметили.',
    'Горит не станок, а срок. Спокойно и бодро берёмся за дело!',
    'План срочный, команда надёжная. Всё будет чётко! ⚡',
    'Мой внутренний хамелеон подсказывает: это нужно взять первым.',
    'Срочка в чате! Не откладываем, но качество никуда не отпускаем.',
    'Аркадий поднял тревогу. Нет, не из-за мухи — тут настоящее срочное дело!',
    'Задание с пометкой «быстрее». Действуем уверенно, без геройства!',
    'Чёрт возьми, задача срочная! Давайте сделаем её красиво и вовремя.',
  ],
};
const reminderJokes = [
  'Работа ещё не началась, а поставка уже нервничает. 😄',
  'Я за заданием слежу обоими глазами — оно всё ещё ждёт своего героя. 👀',
  'Срочка терпеливо ждёт, но часы-то тикают! ⏰',
  'Кажется, это задание слишком хорошо замаскировалось. Я его нашёл! 🦎',
  'Поставка готова к приключениям, осталось познакомить её со станком. 😎',
  'Мой хвост подсказывает: эту срочку пора брать в работу!'
];
const completionPraises = [
  'Команда, вы так бодро справились, что я не успел сменить цвет! Красавчики! 🦎👏',
  'Готово! Станок выдохнул, а я вами горжусь. Команда — огонь! 🔥',
  'Поставка стала на шаг ближе к отправке. Вот это я понимаю — сработано! 💪',
  'Мои глаза одновременно посмотрели на результат и на вас с восхищением. 👀',
  'Красиво закрыли задачу! Даже придраться не к чему — а я старался. 😄',
  'Вот это темп! Я бы похлопал громче, но лапки маленькие. 👏',
  'Задача выполнена! Команда заслужила моё самое яркое одобрение. 🦎',
  'Отличная работа! Поставка довольна, станок доволен, Аркадий тоже. 😎',
  'Сделано чётко! Кажется, мастерство снова победило план. 💪',
  'Команда, вы молодцы! Я зафиксировал: сегодня снова работала магия. ✨',
  'Есть результат! Передаю виртуальное рукопожатие и хвостом машу. 🦎',
  'Задание готово! Я уже мысленно вручил вам медаль за отличную работу. 🏅',
  'Вот это сработано! Даже мои глаза смотрят в одну сторону от удивления. 👀',
  'Команда справилась на отлично — можно добавить ещё одну галочку в копилку! ✅',
  'Хорошая работа! Я бы угостил вас кофе, но у меня только виртуальные мухи. ☕',
  'Готово! Вы снова доказали, что производственная магия существует. ✨'
];
// Keep the original phrases/history intact. Once they are used, compose praise
// from a versioned sequence rather than silently omitting it. The caller saves
// this cursor and the notification ID together in the existing leased scope.
const completionPraiseParts = [
  [
    'Команда, красиво сработали!', 'Вот это результат!',
    'Отличная работа, ребята!', 'Есть повод вами гордиться!',
    'Снимаю виртуальную шляпу!', 'Вы сегодня в ударе!',
    'Сработано с размахом!', 'Принимайте заслуженные аплодисменты!',
    'Команда, вы огонь!', 'Аркадий доволен результатом!',
    'Задача закрыта красиво!', 'Классно справились!',
    'Вот это я понимаю — мастерство!', 'Молодцы, команда!',
    'Передаю вам большой производственный респект!', 'Результат заслуживает оваций!',
  ],
  [
    'Я бы обнял всех, но лапки короткие.',
    'Даже мой хвост выстроился по стойке смирно.',
    'Мои глаза смотрят на результат с двух сторон — с обеих хорошо.',
    'Если бы за чёткость давали медали, пришлось бы искать ещё один шкаф.',
    'Хотел найти, к чему придраться, но нашёл только повод похвалить.',
    'Мой внутренний контролёр качества одобрительно кивает.',
    'Я бы принёс торт, но пока умею доставлять только комплименты.',
    'На секунду забыл маскироваться — так вами горжусь.',
    'Мой виртуальный кофе стал вкуснее от таких новостей.',
    'Тут даже суровый станок, кажется, улыбнулся.',
    'Попробовал похлопать хвостом — получилось вполне торжественно.',
    'С таким результатом можно и чешую расправить.',
    'Моя премия за лучший результат пока виртуальная, зато уважение настоящее.',
    'Я бы пожал каждому руку, но могу только помахать лапой.',
    'У моего восторга сегодня зелёный свет.',
    'Записал в блокнот: с такой командой приятно работать.',
  ],
  [
    'Спасибо за вашу работу! 🦎👏', 'Командой можно гордиться! 💪',
    'Так держать, мастера! 🔥', 'От меня — большой палец вверх! 👍',
    'Пусть следующий заход будет таким же чётким! ✨', 'Машу хвостом в знак уважения! 🦎',
    'Вы заслужили этот комплимент! 😎', 'За такое хочется сказать спасибо ещё раз! 👏',
    'Мастерство видно сразу! 🏅', 'Приятно видеть такой результат! ✅',
    'Уважение каждому, кто приложил руки! 💪', 'Передаю виртуальную пятюню! 🖐️',
    'В копилку хорошей работы! ✨', 'С вами производству повезло! 🔥',
    'Я за вас рад обоими глазами! 👀', 'Продолжайте в том же духе! 🦎',
  ],
];
function nextCompletionPraise(scope) {
  return nextArkadyPhrase(scope, {
    key: 'bitrixCompletionPraiseSequenceV2',
    parts: completionPraiseParts,
    cycleLabel: 'Уровень моей гордости',
  });
}

export function completionPraise(scope, eventId) {
  const used = scope.meta('bitrixCompletionPraisesUsed') || [];
  const available = completionPraises.filter(text => !used.includes(text));
  if (!available.length) return nextCompletionPraise(scope);
  const praise = available[Array.from(eventId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % available.length];
  scope.meta('bitrixCompletionPraisesUsed', [...used, praise]);
  return praise;
}
export function reminderJoke(scope, eventId) {
  const level = scope.meta('bitrixReminderHumorLevel') || 'off';
  if (level === 'off') return '';
  const sequence = Number(scope.meta('bitrixReminderHumorSequence') || 0) + 1;
  scope.meta('bitrixReminderHumorSequence', sequence);
  if (level === 'sometimes' && sequence % 3 !== 0) return '';
  const used = scope.meta('bitrixReminderJokesUsed') || [];
  const candidates = reminderJokes.filter(joke => !used.includes(joke));
  if (!candidates.length) return '';
  const joke = candidates[Array.from(eventId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % candidates.length];
  scope.meta('bitrixReminderJokesUsed', [...used, joke]);
  return joke;
}
const encode = new TextEncoder(), decode = new TextDecoder();
const to64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const from64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function configKey(bindings) {
  if (typeof bindings.RITM_ASSEMBLY_SYNC_SECRET !== 'string' || bindings.RITM_ASSEMBLY_SYNC_SECRET.length < 32) throw new Error('missing encryption key');
  const material = await crypto.subtle.digest('SHA-256', encode.encode('ritm:bitrix-config:v1:' + bindings.RITM_ASSEMBLY_SYNC_SECRET));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptBitrixConfig(bindings, value) {
  if (!bitrixConfigured(value)) throw new Error('invalid configuration');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv}, await configKey(bindings), encode.encode(JSON.stringify(value)));
  return { version: 1, iv: to64(iv), ciphertext: to64(new Uint8Array(data)) };
}
export async function decryptBitrixConfig(bindings, saved) {
  if (saved?.version !== 1) throw new Error('invalid configuration');
  const data = await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(saved.iv)}, await configKey(bindings), from64(saved.ciphertext));
  const value = JSON.parse(decode.decode(data));
  if (!bitrixConfigured(value)) throw new Error('invalid configuration');
  return value;
}

export function queueBitrixNotifications(scope, operation, { kind, manager = 'RITM', enabled = false, documentIds = {}, nextJoke = null } = {}) {
  if (!enabled || operation?.status !== 'verified' || !['stock', 'production'].includes(kind)) return 0;
  if (kind === 'production' && !['create', 'append'].includes(operation.action)) return 0;
  const id = `${kind}:${operation.id}:shared`;
  if (scope.operations.has(`bitrix-notification:${id}`) || [...departments].some(area => scope.operations.has(`bitrix-notification:${kind}:${operation.id}:${area}`))) return 0;
  const totals = {roll:{articles:0,quantity:0},box:{articles:0,quantity:0}};
  const stockArticles = {roll:[],box:[]};
  const stockEntries = {roll:[],box:[]};
  const sheetLinks = {roll:'',box:''};
  for (const step of operation.steps || []) {
    if (!departments.has(step.department) || step.status !== 'verified') continue;
    const entries = kind === 'stock' ? step.plan?.entries : step.lines;
    if (!Array.isArray(entries) || !entries.length) continue;
    const documentId = documentIds[step.department];
    const sheetId = step.plan?.sheetId;
    if (typeof documentId === 'string' && /^[A-Za-z0-9_-]+$/.test(documentId) && Number.isSafeInteger(sheetId) && sheetId >= 0 && (kind !== 'stock' || step.plan?.spreadsheetId === documentId))
      sheetLinks[step.department] = `https://docs.google.com/spreadsheets/d/${documentId}/edit#gid=${sheetId}`;
    totals[step.department].articles += entries.length;
    totals[step.department].quantity += entries.reduce((sum, row) => sum + (Number.isSafeInteger(row.quantity) && row.quantity > 0 ? row.quantity : 0), 0);
    if (kind === 'stock') for (const row of entries) {
      const article = clean(row.article);
      if (article && Number.isSafeInteger(row.quantity) && row.quantity > 0) {stockArticles[step.department].push(`${article} — ${row.quantity} шт.`);stockEntries[step.department].push({article,quantity:row.quantity});}
    }
  }
  if (!totals.roll.articles && !totals.box.articles) return 0;
    const title = kind === 'stock' ? (operation.destination === 'urgent' ? 'Срочные 2 этаж' : 'Запасы склад') : clean(operation.name);
    const urgent = kind === 'stock' ? operation.destination === 'urgent' : operation.priority ? operation.priority === 'urgent' : /🔥\s*$/u.test(operation.name || '');
    const category = urgent ? 'urgent' : 'normal';
    const history = scope.meta('bitrixJokeHistory') || {};
    // Both production areas currently share the roll-printing chat. Merge the
    // previous histories so changing the destination does not repeat a joke.
    const chatHistory = history.shared || { last: '', used: {
      normal: [...new Set([...(history.box?.used?.normal || []), ...(history.roll?.used?.normal || [])])],
      urgent: [...new Set([...(history.box?.used?.urgent || []), ...(history.roll?.used?.urgent || [])])],
    } };
    const humor = scope.meta('bitrixHumorLevel') || 'always';
    // An explicit owner request applies to one newly created assignment only.
    // Claim it with the notification in the same leased scope, never on delivery.
    const onceKey = nextJoke && /^[A-Za-z0-9_-]{1,80}$/.test(nextJoke.id || '') ? `bitrixAssignmentJokeOnce:${nextJoke.id}` : '';
    const onceText = onceKey && typeof nextJoke.text === 'string' && nextJoke.text === clean(nextJoke.text) ? nextJoke.text : '';
    const forced = onceText && Number.isFinite(Date.parse(nextJoke.after)) && Date.parse(operation.createdAt) >= Date.parse(nextJoke.after) && !scope.meta(onceKey);
    const sequence = Number(scope.meta('bitrixHumorSequence') || 0) + 1;
    scope.meta('bitrixHumorSequence', sequence);
    const includeJoke = humor === 'always' || (humor === 'sometimes' && sequence % 3 === 0);
    const candidates = includeJoke ? jokes[category].filter(text => !chatHistory.used[category].includes(text)) : [];
    const joke = forced ? onceText : !includeJoke ? '' : candidates.length
      ? candidates[Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % candidates.length]
      : nextAssignmentJoke(scope, category);
    const heading = urgent ? '🚨 [B]СРОЧНОЕ ЗАДАНИЕ[/B]' : '📦 [B]Новое задание в производство[/B]';
    const subject = kind === 'stock' ? `📍 Куда: [B]${title}[/B]` : `📍 Поставка: [B]${title}[/B]`;
    const sections = ['roll','box'].filter(area => totals[area].articles > 0).map(area => `${area === 'roll' ? '🖨️ Рулонная печать' : '📦 Бокс'}${kind === 'stock' ? `:\n${stockArticles[area].join('\n')}` : `: [B]${totals[area].articles} арт. · ${totals[area].quantity} шт.[/B]`}${sheetLinks[area] ? `\n   [URL=${sheetLinks[area]}]Открыть ${area === 'roll' ? 'рулонную печать' : 'бокс'} в таблице[/URL]` : ''}`).join('\n\n');
    const message = `🦎 [B]Аркадий на связи![/B]\n\n${heading}\n${subject}\n\n${sections}\n\n👤 Добавил(а): ${clean(manager) || 'RITM'}${joke ? `\n\n[I]${joke}[/I]` : ''}`;
    const presentation = assignmentPresentation({kind,action:operation.action,title,urgent,manager,joke,sections:['roll','box'].filter(area=>totals[area].articles>0).map(area=>({department:area,...totals[area],entries:stockEntries[area],url:sheetLinks[area]}))});
    scope.putOperation('bitrix-notification', { id, status: 'pending', department: 'roll', message, presentation, createdAt: new Date().toISOString() });
    if(forced) {
      scope.meta(onceKey,{notificationId:id,phrase:joke});
      for(const area of ['normal','urgent'])
        for(const phrase of [joke,...jokes[area].filter(phrase=>phrase.startsWith(joke))])
          if(!chatHistory.used[area].includes(phrase))chatHistory.used[area].push(phrase);
    }
    // The legacy list stays bounded; generated phrases use their durable cursor.
    if (joke) { chatHistory.last = joke; if (candidates.length) chatHistory.used[category].push(joke); }
    history.shared = chatHistory;
    scope.meta('bitrixJokeHistory', history);
  return 1;
}

export function bitrixConfigured(bindings) {
  try {
    const url = new URL(bindings.RITM_BITRIX_WEBHOOK_URL);
    return url.protocol === 'https:' && url.hostname === 'kaleidoskop.bitrix24.ru' && !url.username && !url.password && /^\/rest\/\d+\/[A-Za-z0-9]+\/$/.test(url.pathname) && !url.search && !url.hash && /^\d+$/.test(String(bindings.RITM_BITRIX_BOT_ID || '')) && /^[A-Za-z0-9_-]{8,80}$/.test(String(bindings.RITM_BITRIX_BOT_TOKEN || '')) && ['BOX', 'ROLL'].every(key => /^chat\d+$/.test(String(bindings[`RITM_BITRIX_${key}_CHAT`] || '')));
  } catch { return false; }
}

export const ARKADY_COMPLETION_RECIPIENTS = Object.freeze(['1698', '2374']);

export async function sendBitrixNotification(bindings, event, fetcher = fetch, dialogId = bindings.RITM_BITRIX_ROLL_CHAT) {
  if (!bitrixConfigured(bindings) || !departments.has(event.department) ||
      (dialogId !== bindings.RITM_BITRIX_ROLL_CHAT && !ARKADY_COMPLETION_RECIPIENTS.includes(dialogId))) return { status: 'not_configured' };
  let card=null;
  if(bindings.ASSETS&&event.presentation){
    // A preparation failure is safe to fall back from: no Bitrix request exists
    // yet. After any delivery attempt, never send a second/native replacement.
    try {card=await renderArkadyCard(event,bindings.ASSETS);} catch { /* readable native fallback */ }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const payload=card?{
      botId:Number(bindings.RITM_BITRIX_BOT_ID),botToken:bindings.RITM_BITRIX_BOT_TOKEN,dialogId,
      fields:{name:`arkady-${event.presentation.type}.png`,content:pngBase64(card.png),message:card.caption},
    }:{BOT_ID:Number(bindings.RITM_BITRIX_BOT_ID),CLIENT_ID:bindings.RITM_BITRIX_BOT_TOKEN,DIALOG_ID:dialogId,...arkadyMessageFields(event),URL_PREVIEW:'N'};
    const response = await fetcher(`${bindings.RITM_BITRIX_WEBHOOK_URL}${card?'imbot.v2.File.upload':'imbot.message.add'}`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (response.ok && body?.result) {
      if(card){
        const result=body.result;
        if(!Number.isSafeInteger(Number(result.messageId))||Number(result.messageId)<1||String(result.dialogId)!==dialogId||!Number.isSafeInteger(Number(result.file?.id))||Number(result.file.id)<1)return {status:'uncertain'};
        // File.upload has no urlPreview option. Update only the acknowledged
        // message to remove the large Sheets unfurl, preserving image + caption.
        // A cosmetic update failure must never turn an accepted send into a retry.
        if(card.model.sections.some(section=>section.url))try {
          const update=await fetcher(`${bindings.RITM_BITRIX_WEBHOOK_URL}imbot.v2.Chat.Message.update`,{
            method:'POST',redirect:'manual',signal:AbortSignal.timeout(3000),
            headers:{'content-type':'application/json'},
            body:JSON.stringify({botId:Number(bindings.RITM_BITRIX_BOT_ID),botToken:bindings.RITM_BITRIX_BOT_TOKEN,messageId:Number(result.messageId),fields:{message:card.caption,urlPreview:'N'}}),
          });
          await update.json();
        } catch { /* already delivered; never upload or send again */ }
        return {status:'sent',messageId:Number(result.messageId),fileId:Number(result.file.id),format:'card-image-v1'};
      }
      return { status: 'sent' };
    }
    return { status: 'uncertain' };
  } catch { return { status: 'uncertain' }; }
  finally { clearTimeout(timer); }
}

function notificationAudience(event) {
  const id = event.id || '';
  if (/^(?:stock:.*:(?:print|cut|complete):\d+|watch:.*:(?:print|cut|reminder))$/.test(id)) return null;
  if (event.presentation?.type === 'completion' || /^(?:stock-batch|watch):.+:complete$/.test(id)) return 'private';
  if (event.presentation?.type === 'assignment' || (!event.presentation && /^(?:stock|production):[^:]+:(?:shared|roll|box)$/.test(id))) return 'group';
  return null;
}

export async function retireObsoleteBitrixNotifications(scope) {
  let changed=0;
  for (const item of scope.operations.values()) {
    if (item.kind === 'bitrix-notification' && item.value.status === 'pending' && !notificationAudience(item.value)) {
      scope.putOperation('bitrix-notification', {...item.value,status:'superseded'});
      if (++changed % 40 === 0) await scope.checkpoint();
    }
  }
}

export async function drainBitrixNotifications(bindings, store, fetcher = fetch) {
  const state = await store.scope();
  if (state.meta('bitrixNotificationsEnabled') === false) return;
  const saved = state.meta('bitrixNotificationConfig');
  if (!saved) return;
  try { bindings = { ...bindings, ...await decryptBitrixConfig(bindings, saved) }; }
  catch { return; }
  if (!bitrixConfigured(bindings)) return;
  const scoped = async callback => {
    for (let attempt=0; ; attempt++) {
      try { return await store.withScope(callback); }
      catch (error) {
        if (error?.code !== 'cloud_operation_busy' || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  };
  for (let i = 0; i < 8; i++) {
    const delivery = await scoped(async scope => {
      if (scope.meta('bitrixNotificationsEnabled') === false) return null;
      await retireObsoleteBitrixNotifications(scope);
      const row = [...scope.operations.values()].find(item => item.kind === 'bitrix-notification' && item.value.status === 'pending');
      if (!row) return null;
      const event = row.value;
      const personal = notificationAudience(event) === 'private';
      const dialogId = personal
        ? ARKADY_COMPLETION_RECIPIENTS.find(id => !event.deliveries?.[id]) : bindings.RITM_BITRIX_ROLL_CHAT;
      if (!dialogId) return null;
      if (personal) {
        // Reserve each recipient before the network call. A lost acknowledgement
        // for one recipient cannot replay it or prevent the other delivery.
        const deliveries = { ...event.deliveries, [dialogId]: { status: 'sending' } };
        const status = ARKADY_COMPLETION_RECIPIENTS.every(id => deliveries[id]) ? 'sending' : 'pending';
        scope.putOperation('bitrix-notification', { ...event, deliveries, status });
      } else {
        scope.putOperation('bitrix-notification', { ...event, status: 'sending' });
      }
      await scope.checkpoint();
      return { event, dialogId, personal };
    });
    if (!delivery) return;
    const { event, dialogId, personal } = delivery;
    const result = await sendBitrixNotification(bindings, event, fetcher, dialogId);
    await scoped(scope => {
      const current = scope.operations.get(`bitrix-notification:${event.id}`)?.value;
      const updatedAt = new Date().toISOString();
      if (!personal) {
        if (current?.status === 'sending') scope.putOperation('bitrix-notification', { ...current, ...result, updatedAt });
        return;
      }
      if (current?.deliveries?.[dialogId]?.status !== 'sending') return;
      const deliveries = { ...current.deliveries, [dialogId]: { ...result, updatedAt } };
      const statuses = ARKADY_COMPLETION_RECIPIENTS.map(id => deliveries[id]?.status);
      const status = statuses.includes(undefined) ? 'pending' : statuses.includes('sending') ? 'sending'
        : statuses.every(state => state === 'sent') ? 'sent' : 'uncertain';
      scope.putOperation('bitrix-notification', { ...current, deliveries, status, updatedAt });
    });
  }
}
