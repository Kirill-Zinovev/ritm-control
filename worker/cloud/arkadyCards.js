// Presentation only. Readiness, routing, delivery IDs and phrase cursors remain
// owned by the existing notification producers and durable outbox.
import { stockCompletionSections } from './arkadyStockWatch.js';
const text = (value, limit = 500) => String(value || '').replace(/[\r\n\[\]]/g, ' ').trim().slice(0, limit);
const number = value => new Intl.NumberFormat('ru-RU').format(value);
const articles = value => `${number(value)} ${value % 100 >= 11 && value % 100 <= 14 ? 'артикулов' : value % 10 === 1 ? 'артикул' : value % 10 >= 2 && value % 10 <= 4 ? 'артикула' : 'артикулов'}`;
const sheetUrl = value => /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit#gid=\d+$/.test(value || '') ? value : '';
const validQuantity = value => Number.isSafeInteger(value) && value > 0;
const labels = {roll: 'Рулонная печать', box: 'Бокс'};
const banner = 'https://ritm-erp.zinovevkirill234.chatgpt.site/images/arkady-notification-v2.png';
const delimiter = () => ({DELIMITER: {COLOR: '#e3eaf2', SIZE: 1}});
const grid = (name, value, display = 'ROW', extra = {}) => ({NAME: name, VALUE: value, DISPLAY: display, ...extra});

export function assignmentPresentation({kind, action, title, urgent, sections, manager, joke = ''}) {
  return {
    version: 1, type: 'assignment', kind, action: action === 'append' ? 'append' : 'create', urgent: Boolean(urgent), title: text(title, 180),
    sections: sections.filter(row => labels[row.department] && validQuantity(row.quantity)).map(row => ({
      department: row.department, articles: row.articles, quantity: row.quantity, url: sheetUrl(row.url),
      entries: kind === 'stock' ? (row.entries || []).filter(entry => text(entry.article, 120) && validQuantity(entry.quantity)).map(entry => ({article: text(entry.article, 120), quantity: entry.quantity})) : [],
    })),
    manager: text(manager, 180) || 'RITM', joke: text(joke),
  };
}

export function stockCompletionPresentation(event, {documentId, documentIds = {}, joke = ''} = {}) {
  const sections = stockCompletionSections(event).map(section => {
    const doc = documentIds[section.department] || documentId;
    const url = /^[A-Za-z0-9_-]+$/.test(doc || '') && Number.isSafeInteger(section.sheetId) && section.sheetId >= 0
      ? `https://docs.google.com/spreadsheets/d/${doc}/edit#gid=${section.sheetId}` : '';
    const entries = section.entries.map(entry => ({article:text(entry.article,120),quantity:entry.quantity}));
    return {department:section.department,url,entries,quantity:entries.reduce((sum,entry) => sum + entry.quantity,0)};
  });
  return {
    version: 1, type: 'completion', kind: 'stock',
    title: event.destination === 'urgent' ? 'Срочные 2 этаж' : 'Запасы склад',
    department: sections.length === 1 ? sections[0].department : null, quantity: event.quantity,
    entries: sections.flatMap(section => section.entries), sections,
    url: sections.length === 1 ? sections[0].url : '', manager:text(event.manager,180), joke: text(joke),
  };
}

export function supplyWatchPresentation(event, joke = '') {
  return {
    version: 1, type: event.kind === 'reminder' ? 'reminder' : 'completion', kind: 'production',
    title: text(event.name, 180), department: event.department, articles:event.articles, quantity: event.quantity,
    entries: [], url: sheetUrl(event.url), joke: text(joke),
  };
}

// Shared readable content for the PNG and its clickable source links.
// The durable event owns readiness and membership; rendering never re-queries
// production data or consumes another joke/praise sequence.
export function arkadyCardContent(event) {
  const card=event.presentation;
  if(card?.version!==1||!['assignment','completion','reminder'].includes(card.type))return null;
  const stock=card.kind==='stock',done=card.type==='completion',reminder=card.type==='reminder';
  const source=Array.isArray(card.sections)?card.sections:[{department:card.department,articles:card.articles,quantity:card.quantity,entries:card.entries,url:card.url}];
  const sections=source.filter(row=>labels[row.department]&&validQuantity(row.quantity)).map(row=>({
    department:row.department,label:labels[row.department],quantity:row.quantity,
    articles:validQuantity(row.articles)?row.articles:stock?(row.entries||[]).length:null,
    entries:stock?(row.entries||[]).filter(row=>validQuantity(row.quantity)).map(row=>({article:text(row.article,120),quantity:row.quantity})):[],
    url:sheetUrl(row.url),
  }));
  if(!sections.length)return null;
  const heading=done?'Печать и порезка готовы':reminder?'Задание ждёт старта':card.action==='append'?'Товары добавлены в поставку':card.urgent?'Срочное задание':stock?'Задание на запасы':'Новая поставка';
  const count=sections.every(row=>validQuantity(row.articles))?sections.reduce((sum,row)=>sum+row.articles,0):null;
  return {
    type:card.type,stock,done,urgent:!!card.urgent||reminder,heading,
    subtitle:done?(stock?'Весь список выполнен':'Готовность участка подтверждена'):reminder?'Срочная поставка ещё не взята в работу':'Задание распределено по участкам',
    // A prominent subject panel replaces the former tiny destination pill.
    subject:`${stock?'Запасы · ':''}${text(card.title,180)}`,
    sections,count,quantity:sections.reduce((sum,row)=>sum+row.quantity,0),manager:text(card.manager,180),joke:text(card.joke,500),
    totalLabel:card.type==='assignment'&&card.action==='append'?'Добавлено':'Всего',
  };
}

export function arkadyCardCaption(model) {
  // Every raster scenario has the same boundary: content in the card, only
  // verified source links below it. Large lists never become a text appendix.
  return model.sections
    .filter(section => section.url)
    .map(section => `[URL=${section.url}]${section.label} ↗[/URL]`)
    .join('   ·   ');
}

// Use native Bitrix ATTACH blocks: text remains selectable and sheet links
// remain clickable on desktop and mobile. No HTML or embedded script is sent.
export function arkadyMessageFields(event) {
  const card = event.presentation;
  if (card?.version !== 1 || !['assignment', 'completion', 'reminder'].includes(card.type)) return {MESSAGE: event.message};
  // Keep the fallback as one bounded card too, even for long article names.
  // The complete membership remains in the presentation and linked source.
  for (const articleLimit of [40, 20, 10, 0]) {
    const fields = nativeCardFields(card, articleLimit);
    if (new TextEncoder().encode(JSON.stringify(fields.ATTACH)).length <= 28000) return fields;
  }
  return {MESSAGE: event.message};
}

function nativeCardFields(card, articleLimit) {
  const color = card.type === 'completion' ? '#16a34a' : card.urgent || card.type === 'reminder' ? '#c66b10' : '#2563eb';
  const blocks = [{IMAGE: [{NAME: 'Аркадий · RITM', LINK: banner, PREVIEW: banner, WIDTH: 642, HEIGHT: 214}]}];
  let heading;
  if (card.type === 'assignment') {
    heading = card.urgent ? 'СРОЧНОЕ ЗАДАНИЕ' : card.kind === 'stock' ? 'НОВОЕ ЗАДАНИЕ · ЗАПАСЫ' : card.action === 'append' ? 'ТОВАРЫ ДОБАВЛЕНЫ В ПОСТАВКУ' : 'НОВАЯ ПОСТАВКА';
    blocks.push({GRID: [grid(heading, card.title, 'BLOCK', {WIDTH: 560})]});
    blocks.push({MESSAGE: 'Задания распределены по участкам'});
    for (const section of card.sections) {
      blocks.push(delimiter());
      blocks.push({GRID: [grid(labels[section.department], `${articles(section.articles)} · ${number(section.quantity)} шт.`, 'BLOCK', {WIDTH: 560})]});
      if (card.kind === 'stock') appendArticles(blocks, section.entries, articleLimit);
    }
    blocks.push(delimiter());
    const count = card.sections.reduce((sum, row) => sum + row.articles, 0), quantity = card.sections.reduce((sum, row) => sum + row.quantity, 0);
    blocks.push({GRID: [grid(card.kind === 'production' && card.action === 'append' ? 'Добавлено' : 'Всего', `${articles(count)} · ${number(quantity)} шт.`), grid('Добавил(а)', card.manager)]});
  } else {
    heading = card.type === 'reminder' ? 'Срочное задание ещё не взято в работу' : '✅ Печать и порезка готовы';
    blocks.push({GRID: [grid(card.kind === 'stock' ? `ЗАПАСЫ · ${card.title}` : card.title, heading, 'BLOCK', {WIDTH: 560})]});
    if (card.kind === 'stock' && card.sections?.length) {
      blocks.push({GRID:[grid('Весь список готов',`${articles(card.entries.length)} · ${number(card.quantity)} шт.`)]});
      for (const section of card.sections) {
        blocks.push(delimiter());
        blocks.push({GRID:[grid(labels[section.department],`${number(section.quantity)} шт.`)]});
        appendArticles(blocks, section.entries, articleLimit);
      }
      if (card.manager) blocks.push({GRID:[grid('Добавил(а)',card.manager)]});
    } else {
      const quantity = validQuantity(card.articles) ? `${articles(card.articles)} · ${number(card.quantity)} шт.` : `${number(card.quantity)} шт.`;
      blocks.push({GRID: [grid('Участок', labels[card.department] || ''), grid('Количество', quantity)]});
      if (card.kind === 'stock') {blocks.push(delimiter()); appendArticles(blocks, card.entries, articleLimit);}
    }
  }
  if (card.joke) {blocks.push(delimiter()); blocks.push({MESSAGE: card.joke});}
  const sections = Array.isArray(card.sections) ? card.sections : [{department: card.department, url: card.url}];
  for (const section of sections) appendLink(blocks, section.department, section.url);
  const attach = {ID: 1, COLOR: color, BLOCKS: blocks};
  return {MESSAGE: '🦎 Аркадий', ATTACH: attach};
}

function appendArticles(blocks, entries, limit) {
  const shown = entries.slice(0, limit);
  if (shown.length) blocks.push({GRID: shown.map(row => grid(row.article, `${number(row.quantity)} шт.`))});
  if (entries.length > shown.length) blocks.push({MESSAGE: `Ещё ${number(entries.length - shown.length)} артикулов — полный список в таблице участка.`});
}

function appendLink(blocks, department, url) {
  if (!url) return;
  blocks.push({GRID: [grid('', department === 'roll' ? 'Открыть рулонную печать в таблице' : 'Открыть бокс в таблице', 'BLOCK', {LINK: url, COLOR: '#2563eb'})]});
}
