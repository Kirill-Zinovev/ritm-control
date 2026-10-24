# RITM Control

## Private local configuration

Google spreadsheet IDs and the Assembly Web App URL are deliberately excluded from Git. The Node agent reads them from the ignored `intelligence.local.json` file under `googleSources`; the Vite app reads `VITE_FBO_SOURCE_URL`, `VITE_PRINTING_SOURCE_URL`, `VITE_ROLL_PRINTING_SOURCE_URL` and `VITE_ASSEMBLY_WEB_APP_URL` from the ignored `.env.local`. Without local settings, integrations remain unconfigured. The test Sheets writer also fails closed unless its isolated test target and the production-document deny list are configured locally.

Formula Intelligence: [снимки формул, массовое утверждение, покрытие и безопасное обновление Windows](docs/FORMULA-INTELLIGENCE.md).

Существующий производственный кабинет на React 19, TypeScript, Vite и JavaScript Worker. Разделы: обзор, сборщики, печать, производство, склад, поставки, источники данных и AI Center. Навигация постоянно видна слева на рабочих мониторах.

## Реальные источники

- Сборка: FBO «Итого», «История производства». Исходные коэффициенты сохранены. «По дням · Дашборд» — дополнительная сверка, его значения не добавляются к истории.
- Печать: сезонная таблица красного здания, уникальные валидные операции «Печать» из «Журнал выпуска». Производственная дата B, сотрудник C, количество J, площадь L. Резка не входит в KPI печати.
- worker/assembly.js и worker/printing.js предоставляют существующие API. Некорректные записи сборки имеют диагностику и не превращаются в нулевые значения.
- Импорт CSV, локальные черновики и демонстрационный режим остаются отдельными. Резерв прототипа не изменяет внешнюю складскую систему.

## Синхронизация с RITM Assembly

Состав Assembly обновляется подписанными событиями из надёжной очереди агента после подтверждённых операций с поставкой. Минутный Apps Script триггер отключён после проверки квитанции. Прямые правки таблиц обновляются кнопкой «Обновить данные» в Assembly.

## RITM Intelligence — этапы 1–2

Отдельный локальный Node-процесс читает источники и RITM API независимо от браузера. SQLite сохраняет инциденты, снимки, историю и очередь уведомлений. Есть реестр источников, диагностика, повторные попытки, контроль API, измеренные рекомендации и optional Telegram.

AI Center встроен в текущий интерфейс: обзор, инциденты с фильтрами и подробностями, рекомендации, история и настройки. Полноценный защищённый кабинет первого этапа доступен локально на http://127.0.0.1:4318/?page=intelligence. Публичный сайт не открывает приватный локальный API.

Доступ — только владельцу и только чтение. Производственные таблицы не изменяются. Table Doctor читает исходные формулы через Google Sheets API после настройки сервисного аккаунта. AI-чат пока не настроен. Устаревшие снимки отмечаются явно; отсутствие ответа не является нулевым KPI.

- [Table Doctor, подключение Google и демонстрация](docs/TABLE-DOCTOR.md)
- [Архитектура и ограничения](docs/RITM-INTELLIGENCE-ARCHITECTURE.md)
- [Запуск и автозагрузка Windows](docs/RITM-INTELLIGENCE-WINDOWS.md)
- [Настроенный повседневный режим и проверки](docs/WINDOWS-DAILY-USE-RESULT.md)
- [Результаты проверки](verification.md)
- [Дизайн](DESIGN.md) и [UX-контракт](UX-CONTRACT.md)

## Подготовка этапа 3

Реальный разовый аудит Google Drive: 6601 формула; доступ reader для сервисного аккаунта выдан двум документам. Автономное чтение сервисным аккаунтом подтверждено: 6363 формулы на 13 зарегистрированных листах; ручной аудит сохраняется отдельно. Новые повторы OAuth/Sheets, измерения, безопасный импорт ключа и контейнерная подготовка не меняют KPI.

- [Реальные диапазоны, кандидаты правил и подключение Google](docs/GOOGLE-SHEETS-STAGE3.md)
- [Приватное размещение 24/7 и ограничения проверки](docs/PRODUCTION-READINESS.md)

## Разработка

### Передача существующих товаров в Assembly

В «Поставках» подготовлено отдельное действие «Передать в сборку»: участок → существующий лист → выбор позиций → проверка → подтверждение. Поддерживаются рулонная печать и бокс. Производственные таблицы не изменяются. Связанная общая поставка RITM передаётся целиком; для отдельного старого листа можно выбрать часть товаров. Повторные передачи дополняют состав без дублей, история работы сборщиков сохраняется.

Изолированный предпросмотр формы запускается через `node scripts/assembly-transfer-preview.mjs` и доступен на `http://127.0.0.1:5187/__transfer-preview`. Он явно помечен как тестовый, использует искусственные товары, память вместо рабочей базы и не обращается к Google Sheets. Подготовленные изменения пока не опубликованы.

Node.js 24.12+ для агента; frontend использует существующий стек.

    npm ci
    npm run dev

## Проверки

    npm run typecheck
    npm run test:domain
    npm run test:sites
    npm run test:intelligence
    npm run build
    npm run format:check

Production-деплой не выполняется автоматически. Секреты не хранить в frontend, GitHub или публичных параметрах.

Утверждение четырёх базовых проверок, расследования и точечные исключения доступны в AI Center → Table Doctor. Все правила первоначально ждут решения владельца; это не разрешение на изменение Google Sheets. Контракты, защита решений и ограничения описаны в [docs/DIAGNOSTIC-APPROVAL.md](docs/DIAGNOSTIC-APPROVAL.md).
# Private local configuration

Google spreadsheet IDs and the Assembly Web App URL are deliberately excluded from Git. The Node agent reads them from the ignored `intelligence.local.json` file under `googleSources`; the Vite app reads `VITE_FBO_SOURCE_URL`, `VITE_PRINTING_SOURCE_URL`, `VITE_ROLL_PRINTING_SOURCE_URL` and `VITE_ASSEMBLY_WEB_APP_URL` from the ignored `.env.local`. Without local settings, integrations remain unconfigured. The test Sheets writer also fails closed unless its isolated test target and the production-document deny list are configured locally.
