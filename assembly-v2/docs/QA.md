# Assembly v2 · проверка 13.11.2026

## Catalog transfer verification · 13 November 2026

New files and core changes are indexed in docs/CATALOG.md. All task writes remain in this isolated repository. The append-only `0005` migration adds catalog/version/photo tables and nullable position references; earlier applied migrations are unchanged.

`tsc --noEmit`: passed. `node --import tsx --test tests/*.test.ts`: **39 passed**. The nine new catalog tests cover cached Excel values, duplicate headers and source rows, barcode text, only the authorized 700 override, capacity conflicts, market/store and ambiguous alias separation, staged import hash/idempotency/completeness, restore, unchanged allocations/source replay, a catalog change during supply planning, CDN allowlist/auth/origin and bounded cache saturation. Existing 500-position snapshot test still uses ten SELECTs. The production build passes; spreadsheet-only worker/export chunks remain lazy and produce the existing large-chunk warning. No new package dependency was introduced. Strict Premium static audit: zero findings.

The real inputs were parsed and imported through the **local API**, including both original source archives. Verified counts: WB 2,541; OZON 1,388; source rows 3,972; photo article-store records 18,194; 41 remaining source capacity conflicts; one confirmed correction. Source archives round-trip SHA-256 checks pass, a real photo endpoint returned 200, and before/after operational snapshot supplies, positions, work, cartons, dispatches, exports and employees compare equal. Original input file hashes are unchanged. This local test is not a measurement of hosted D1 speed.

Browser verification used the actual local UI and supplied files: file chooser → two Excel files → Web Worker preview → 3,929 cards → complete 443-chunk transfer → success feedback, filtered list and detail. Corrected SS0031.A7484(OZ) displays 700, original row 27 and “550 М” remain inspectable. Photos load. No console errors observed. At 390×844 the modal is one column, has no horizontal content overflow (334px client and scroll widths), retains an accessible close button and scrolls vertically. Temporary viewport override was reset. Local mobile screenshot: ignored outputs/catalog-mobile.png. Hosted publication/import results and the final screenshot are reported separately after deployment; this paragraph does not claim they have already run.

Visual comparison against docs/legacy-reference-desktop.jpg and the previous accepted collector: (1) supply list remains on the right; (2) compact product rows and names retain original hierarchy; (3) separate green/blue/purple stage bars remain; (4) one “Записать работу” action and the expandable row remain; (5) original background/leaf illustration and typography remain. Intentional additions are only the owner management catalog link and real catalog fields/photos for matched positions. Unmatched synthetic DEMO rows still show placeholders; no production supply was fabricated for display. The catalog manager uses the existing manager shell/native controls rather than changing the collector design.

## Текущий запрос

Пользователь отверг новый визуальный концепт и явно потребовал старый дизайн Assembly, поставки справа, другую быструю реализацию под капотом. Предыдущая сверка с `assembly-workers-desktop.png` больше не является приёмкой текущего интерфейса.

Источник теперь — последние компактные стили и DOM в `apps-script/assembly-live/Index.html`. Только чтение. Хеш зафиксирован в `legacy-design-source.json` и повторно совпал после переноса. Оригинальный HTML локально отрисован на явно тестовых данных без запросов в Google: `legacy-reference-desktop.jpg`. В приложение перенесены стили и оригинальная декоративная картинка; Google-скрипт в новый клиент не копировался.

## Сверка интерфейса

Метод: IAB, реальный React-клиент и локальная отдельная SQLite; скриншоты плюс DOM/AX, затем сравнение сохранённых изображений через view_image. Исходный рендер 1280×720, изображение IAB 1270×714. Телефон проверен на 390×844 и 320×740. Снимки: `collector-desktop.jpg`, `collector-mobile.jpg`, `work-mobile.jpg`.

| Элемент        | Результат                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Компоновка     | Прежние компактные строки, поиск, общая панель фильтров, раскрываемые подробности. Постоянная правая форма убрана. Поставки справа по прямому указанию пользователя.                                           |
| Шрифты и цвета | Segoe UI / Arial как в старом источнике, светлый фон, прежние границы/тени, отдельные зелёный, голубой, фиолетовый этапы. Картинка из старого CSS сохранена.                                                   |
| Товар          | План, три раздельных операции, остаток, одна кнопка записи, раскрытие истории и добавления в короб. Нет слияния двух видов резки.                                                                              |
| Запись работы  | Модальное окно, остаток/предпросмотр, сотрудник, доступные операции, количество, отмена/сохранение. Фокус на сотруднике; после подтверждения окно закрывается и фокус возвращается к строке.                   |
| Короба         | Правый drawer, три факта, выбор открытого короба, состав/закрытие, закреплённое количество, «Все доступные», заполненность и добавление.                                                                       |
| Телефон        | Те же действия; вкладки занимают полную строку, длинное название поставки переносится. На 320px документ 320px, окно работы 296px, его scrollWidth=clientWidth=286px; drawer без горизонтального переполнения. |

Намеренные отличия: поставки справа; заметная тестовая среда; существующие экраны владельца под «Управление»; вид товара не передан — фильтр отключён. Фото, тип короба, этикетки, контрольные задания, нормы KPI и ручной приход старой версии пока не подключены. Отсутствующие данные не подменяются фиктивными. Полный список — README.md. Не заявляем полную производственную миграцию.

Замечания дизайн-проверки: Arial и Inter явно объявлены в DESIGN.md как наследуемый шрифт сборщика и существующий шрифт менеджерских экранов; игнорирование правил не добавлялось. Скрытие мобильной полосы прокрутки исправлено, стандартные scrollbar-color/width заданы. Статический Premium-аудит: 0 замечаний. Несовпадения данных и ещё не перенесённые функции выше оставлены открытыми, а не объявлены выполненными.

## Функциональные проверки

- TypeScript strict прошёл.
- 30 автоматических тестов прошли: конкурентные записи, остатки, вместимость микса, идемпотентность, источник позиции, закрытие/резервирование/отправка, неизменяемая выгрузка, импорт 500 позиций, ошибки сети, Excel и шаблоны. Новые тесты закрепляют прежние критерий готовности, формулу прогресса, допустимые операции и пропуск полного короба при дробной погрешности вместимости.
- В новом интерфейсе IAB: выбор сотрудника, запись двух единиц через Enter, рост факта и имени; размещение двух единиц в существующий короб без повторного начисления работы; история внутри строки.
- Дробное количество показывает ошибку и остаётся в форме. Escape с черновиком открывает собственный диалог, «Остаться в форме» возвращает неизменённое значение. Отмена без количества закрывает окно. После подтверждения размещения поле очищается и снова получает фокус.
- Старые менеджерские сценарии новой площадки ранее проверены в IAB: закрытый короб → подготовка отгрузки → скачивание настоящего .xlsx → отдельное подтверждение выезда. Их backend и Excel-механизм при переносе дизайна не менялись. Общий Dialog расширен для рабочего окна/drawer, прежние менеджерские варианты сохранены.
- Excel-тесты открывают сериализованный файл и проверяют три листа, суммы, строковые штрихкоды с ведущими нулями, агрегацию вложений и сохранение заголовков/других листов шаблона. Реальные шаблоны кабинетов WB/Ozon не предоставлены.
- `npm audit --omit=dev`: ранее 0 уязвимостей. В инструментах разработки остаются 4 умеренные транзитивные рекомендации. Dev-сервер слушает только loopback и не публикуется.

## Скорость и защита записей

Рабочий путь `src/`, `server/`, `shared/` не содержит вызовов google.script, Google Sheets или Apps Script. Единственная рабочая база опубликованной новой площадки — Cloudflare D1. Итоги позиции/сотрудника обновляются в одной транзакции с записью; история не перечитывается для каждого сохранения. Состояние читается одним согласованным batch из 10 ограниченных SELECT. Подтверждение коммита не превращается в ошибку из-за временного сбоя последующего чтения. DB-триггеры проверяют актуальный остаток, норму, вместимость, готовность и открытость короба при коммите.

Короткие пробы уже опубликованного нового backend на тестовых данных:

| Проба                            | Результат                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| 12 одновременных записей         | 12 подтверждений, прирост ровно 12 шт.; минимум 204мс, медиана 546мс, максимум 652мс.        |
| 12 упаковок сразу в общий короб  | 12 подтверждений, упаковка и состав +12; медиана 547мс, максимум 2186мс.                     |
| 12 запросов по 10 в короб на 100 | Приняты 10, отклонены 2; работа и состав выросли ровно на 100. Отказы не начислили упаковку. |

Это измерения через текущую сеть, не SLA и не восьмичасовая смена. Локальные быстрые тесты не выдаются за облачную скорость. Перед переключением сотрудников ещё нужны рабочий пилот, роли, справочники и автоматическая связь с RITM.

Повтор после публикации привычного интерфейса: 12/12 записей, прирост ровно 12, минимум 304мс, медиана 429мс, максимум 612мс, весь пакет 731мс. Реальная запись ещё одной единицы из облачного окна: факт 432 → 433, окно закрылось, подтверждение показано. В этой проверке найден и исправлен автоматический выбор полного короба: теперь нужен остаток вместимости хотя бы на одно изделие с нормой выбранного товара.

## Старый рабочий Assembly

Все записи и публикации этой задачи направлены в `assembly-web-v2` и Site `appgprj_6af6c13756ec8191992b26eb98acf27d`. Рабочие Google Sheets, Supabase-проекты и старый маршрут RITM не изменяются этой задачей. Старая версия этой задачей не публиковалась.

Первоначальная проверка `npm run verify:legacy` **не прошла**: SHA256 `Code.gs`, `Index.html`, `WarehouseManual.gs` изменились параллельно вне команд записи этой задачи, время изменения 11:20–11:33 МСК. Старый hosting.json совпал. Исходный baseline сохранён; внешние изменения не откатывались. Общую неизменность старой локальной копии за всю сессию утверждать нельзя. При текущем переносе дизайна контрольная сумма прочитанного Index.html повторно совпала с `legacy-design-source.json`.
