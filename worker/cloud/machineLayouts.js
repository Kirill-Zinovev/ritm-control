import { CloudError } from './access.js';

// Read only the canonical list; technical sheets are deliberately excluded.
export async function readMachineLayoutArticles(reader, documentId) {
  try {
    const metadata = await reader.metadata(documentId);
    const sheet = metadata.sheets?.find(s => s.properties?.title === 'Все макеты' && s.properties?.sheetId === 0 && !s.properties?.hidden);
    const count = sheet?.properties?.gridProperties?.rowCount;
    if (!Number.isSafeInteger(count) || count < 2 || count > 100000) throw new Error('sheet');
    const grid = await reader.grid(documentId, [`'Все макеты'!B1:B${count}`]);
    const block = grid.sheets?.find(s => s.properties?.sheetId === 0)?.data?.[0];
    if (!block || (block.startRow || 0) !== 0 || block.startColumn !== 1 || !Array.isArray(block.rowData)) throw new Error('range');
    const cell = row => row?.values?.[0]?.effectiveValue;
    if (String(cell(block.rowData[0])?.stringValue || '').trim().toLocaleLowerCase('ru-RU') !== 'артикул') throw new Error('header');
    const articles = new Set();
    for (const row of block.rowData.slice(1)) {
      const v = cell(row);
      if (v?.errorValue || (v && v.stringValue === undefined)) throw new Error('cell');
      const article = String(v?.stringValue || '').trim().toLocaleUpperCase('ru-RU');
      if (article) articles.add(article);
    }
    if (!articles.size) throw new Error('empty');
    return articles;
  } catch (_) {
    throw new CloudError('machine_layouts_unavailable', 'Не удалось проверить таблицу макетов. Поставка не создана; проверьте доступ к листу «Все макеты» и повторите.', 503);
  }
}
