---
version: alpha
name: "РИТМ / Печать"
description: "Рабочие экраны печати и порезки с общей визуальной системой."
colors:
  light-canvas: "#fbfdfc"
  light-surface: "#f4f9f6"
  light-paper: "#ffffff"
  light-ink: "#132921"
  light-accent: "#087554"
  light-selected: "#e0f7eb"
  dark-canvas: "#10161c"
  dark-surface: "#171f26"
  dark-paper: "#1b242c"
  dark-ink: "#f2f7f6"
  dark-accent: "#9af1c9"
  dark-selected: "#203932"
typography:
  sans:
    fontFamily: '"Segoe UI", Arial, sans-serif'
rounded:
  workspace: "10px"
spacing:
  desktop-header: "64px"
  search-min-height: "46px"
  shipment-list-gap: "8px"
components:
  printing-header: {}
  search-field: {}
  shipment-card: {}
  job-table: {}
  detail-panel: {}
---

# Рабочие экраны РИТМ

Эталон участка — экран резчика. Шапка с тонким рисунком рулонов, крупные заголовки, спокойные рамки и изумрудная полоса у выбранной поставки связывают три рабочих экрана. Рисунок уступает место элементам управления на узких экранах.

### Цвет и состояния

В светлой теме основные действия изумрудные, выбранные строки и вкладки мятные. В тёмной теме фон графитовый, основные действия и выбранные вкладки мятные. Вторичные действия используют контур или текст. Индикаторы печати и порезки в «Боксе» сохраняют отдельные подписи и цвета.

### Компоненты

Единые `PrintingHeader` и `SearchField` находятся в `src/PrintingChrome.jsx`. Рисунок, значок поиска и высота шапки определены в `src/printing-chrome.css`. Поля поиска оставляют место слева для значка, таблицы и карточки используют фон и рамку из рабочей палитры. Рамка карточки выбранного артикула повторяет изумрудный акцент раскрытого рулона. Клавиатурный фокус обозначается контуром.

### Источник токенов

Действующие CSS-переменные в `src/styles.css` и `src/cutter.css` определяют цвета `--canvas`, `--surface`, `--paper`, `--ink`, `--accent`, `--selected` и `--workspace-radius`. Этот файл описывает принятые значения. Заголовки и цвет выбранной вкладки используют общие правила из `src/styles.css`.
