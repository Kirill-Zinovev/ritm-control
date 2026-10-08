# Design QA — RITM AI Center, 2026-10-08

Изменение сохраняет существующие RITM shell, левую навигацию, токены и общие примитивы. Desktop-only решение из AGENTS.md соблюдено.

Chrome/Playwright: реальная страница локального агента проверена на 1440×1000 и 1100×900. AI Center использует существующие Button, Field, Notice, Badge, DataTable и Radix Modal. Вход, filters, empty state, source links, history, logout и disabled chat проверены. Incident details и server pagination проверены с явно изолированной QA-записью; она не попала в реальный журнал.

После браузерной проверки Field получил отдельное aria-labelledby для подписи: доступное имя select больше не включает тексты всех вариантов. Исправление действует и для существующих форм.

Скриншот реального overview сохранён в временном каталоге QA; на нём 2 источника и 0 активных проблем, соответствующие текущему хранилищу. Нет демонстрационных инцидентов. Отсутствующая формульная диагностика, AI и Telegram явно обозначены.

Нет неожиданных console/pageerror. Левое меню остаётся видимым при 1100px. Keyboard Enter/Escape для incident modal проверены; полный keyboard regression всех прежних ERP-форм в этом этапе не выполнялся.

DESIGN.md lint: 0 ошибок, 9 предупреждений orphaned-tokens. Premium strict audit оставляет одно ложное срабатывание общего Button: статический анализатор не видит действие через spread props. Реальные действия подтверждены браузером; strict audit не заявляется прошедшим.
