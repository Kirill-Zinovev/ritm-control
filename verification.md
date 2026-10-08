# Проверка RITM Intelligence — 2026-10-08

## Итог

Первый этап реализован локально в C:\workspace\ritm-fbo-redesign. Production не опубликован. Производственные таблицы не изменялись. Формулы, нормы, валидные коэффициенты FBO и правила печатного журнала сохранены.

## Автоматические проверки

| Проверка                      | Результат                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| npm run typecheck             | Успешно                                                                                  |
| npm run test:domain           | 8 тестов, успешно                                                                        |
| npm run test:sites            | 23 теста, успешно                                                                        |
| npm run test:intelligence     | 22 новых теста, успешно                                                                  |
| npm run build                 | Успешно; frontend и Sites Worker упакованы                                               |
| npm run format:check          | Успешно                                                                                  |
| node scripts/check-render.mjs | Все 8 страниц проходят SSR                                                               |
| DESIGN.md lint                | 0 ошибок, 9 предупреждений orphaned-tokens                                               |
| Строгий premium audit         | 1 замечание: анализатор не распознаёт передачу onClick/submit через props в общем Button |

Замечание premium audit проверено вручную и в браузере: src/ui.tsx Button передаёт все свойства вызывающего компонента в native button. Реальные обработчики входа, выхода, обновления, открытия карточки и пагинации работают. Строгий статический аудит не объявляется прошедшим.

Прежние 8 замечаний format:check были вызваны окончаниями строк CRLF при ожидаемом LF. Нормализация выполнена; содержательная Git-разница в этих 8 файлах отсутствует.

## Сценарии из задания

| Сценарий                                 | Покрытие                                                            |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Google Sheets временно недоступен        | Повторы, incident, сохранение проверенного снимка                   |
| API возвращает ошибку                    | Отдельный технический incident с гипотезой слоя                     |
| Повреждённое числовое значение           | #REF!, #N/A, #VALUE!, #DIV/0!, пустые и нечисловые поля исключаются |
| Изменился формат таблицы                 | Проверка заголовков сборки/печати и generic CSV                     |
| Дубли журнала                            | Исключение повторных ID, incident и координаты                      |
| Нет обязательного UID                    | Диагностика без придуманного идентификатора                         |
| Данные давно не обновлялись              | Возраст API и согласованный календарь freshness                     |
| Ложное снижение KPI из-за повреждений    | Старый проверенный снимок, неполные данные явно отмечены            |
| Нет данных за выходной                   | Не превращаются в нулевую производительность                        |
| Повторная проверка                       | Один incident, одна очередь уведомления на генерацию                |
| Перезапуск после аварии                  | SQLite сохраняет историю/снимок; восстановление аренды              |
| Telegram недоступен                      | Мониторинг продолжается, доставка uncertain без дубля               |
| AI API недоступен                        | Монитор не зависит от AI API; LLM не вызывается                     |
| Нет авторизации для защищённого действия | 401/403, запрет записи и чужого Origin                              |

Дополнительно: неожиданно пустая полная история API при непустом источнике; отсутствие первоначального снимка возвращает 503; совпадение валидной математики; отсутствие одновременных проверок.

## Реальные источники

В однократном headless-запуске прочитаны два документа: 486 записей истории FBO, 46 валидных записей печати. Проверки /api/assembly, /api/printing и HTML RITM прошли. На момент этого запуска активных инцидентов — 0. Это результат проверки значений и доступности, а не доказательство исправности формул.

На одном и том же реальном CSV новые записи и итоги сборки за день, неделю и месяц точно совпали с исходным HEAD. Исходные числа не менялись.

## Браузер

Chrome через Playwright, локальный сервер агента, 1440×1000 и 1100×900:

- Страница идентифицирована, не пустая, без framework overlay.
- Постоянное левое меню и интегрированный дизайн RITM проверены.
- Вход владельца, скрытый ключ, inline-ошибка пустого ввода и выход.
- Реальные overview, registry, source links и persisted history.
- Фильтры инцидентов и честное пустое состояние.
- Карточка инцидента, ссылка, Enter и Escape на изолированной явно тестовой записи через перехват ответа браузера.
- Серверная пагинация через изолированный тестовый ответ; запись не сохранялась в реальной SQLite.
- AI-чат недоступен и не выдумывает ответы.
- На AI Center нет дополнительных запросов production KPI.
- Нет неожиданных ошибок console или pageerror. Ожидаемый 401 до входа не является runtime-ошибкой.

## Windows

- Синтаксис PowerShell проверен.
- Initialize-Agent.ps1 выполнен в временном QA-каталоге: DPAPI шифрование и обратное чтение проверены.
- Скрытый Start-Agent.ps1 реально запускает защищённый агент через Windows PowerShell 5.1.
- Штатный VBS launcher реально запускает PowerShell 5.1 и защищённый API; проверка прошла.
- Install-AgentTask.ps1 выполняется только с WhatIf: постоянная задача не устанавливалась.
- Обнаружена и исправлена совместимость UTF-8: PS1 сохраняются с BOM для Windows PowerShell 5.1.
- Временные тестовые секреты и процессы удалены. Ключ владельца для постоянного использования не создавался.

## Что требует внешней настройки

Ключ владельца; установка автозапуска после инициализации; optional Telegram bot token/chat_id; утверждённый календарь актуальности; позже Google OAuth/service account с доступом к формулам и AI API.

SQLite выдаёт ExperimentalWarning в Node 24.12. Формульный Doctor, полноценный AI Analyst, ежедневные Telegram-сводки и подтверждение исправлений относятся к следующим этапам. AI Center первого этапа работает в локальном кабинете, публичный Worker приватный API не предоставляет.

Подробности: docs/RITM-INTELLIGENCE-ARCHITECTURE.md и docs/RITM-INTELLIGENCE-WINDOWS.md.

## Новые файлы

- agent/adapters.js, agent/config.js, agent/export-registry.js, agent/index.js, agent/monitor.js, agent/registry.js, agent/server.js, agent/store.js, agent/telegram.js.
- worker/assemblyDiagnostics.js, worker/timestamps.js.
- src/AICenter.tsx, src/intelligence.ts, src/useAgent.ts.
- tests/intelligence.test.mjs.
- scripts/windows/Initialize-Agent.ps1, Install-AgentTask.ps1, Start-Agent.ps1, Launch-Agent.vbs.
- docs/RITM-INTELLIGENCE-ARCHITECTURE.md, docs/RITM-INTELLIGENCE-WINDOWS.md.
- .env.example, premium-ui.json.

## Изменённые файлы

- src/App.tsx, src/model.ts, src/icons.ts, src/liveAssembly.ts, src/livePrinting.ts, src/ui.tsx, src/styles.css.
- worker/assembly.js, worker/printing.js.
- package.json, vite.config.mjs, .gitignore, scripts/check-render.mjs.
- README.md, AGENTS.md, DESIGN.md, UX-CONTRACT.md, verification.md, design-qa.md.

Дополнительно нормализованы окончания строк в 8 прежних файлах без содержательной Git-разницы: src/App.jsx, src/csv.ts, src/demo.ts, src/importer.ts, src/main.jsx, tests/domain.test.ts, scripts/test-domain.mjs, tsconfig.json.

Существующие worker/index.js, scripts/prepare-sites-build.mjs, tests/sites-worker.test.mjs и .openai/hosting.json оставлены без изменений.
