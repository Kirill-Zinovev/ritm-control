import { ANCHOR, type Dataset, type Source } from "./model";
const names = [
  "Анна Иванова",
  "Мария Петрова",
  "Елена Смирнова",
  "Ольга Соколова",
  "Наталья Орлова",
  "Ирина Волкова",
  "Светлана Белова",
  "Татьяна Козлова",
];
const scores = [1.24, 1.08, 0.82, 1.16, 0.91, 1.03, 1.1, 1.02];
const previous = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"];
export const sources: Source[] = [
  {
    id: "assembly",
    name: "Сборщики · FBO итого",
    url: "https://docs.google.com/spreadsheets/d/1AuPraufSNHwEQHsVEwKR3dtiuEAqUgRrtZJDIQ9I5uo/edit",
    state: "prepared",
  },
  {
    id: "printing",
    name: "Сезонная печать",
    url: "https://docs.google.com/spreadsheets/d/1eNdUuk-2l83Pgv95LyqYKuOOfhAsEMm5tKLbhWBJiC4/edit",
    state: "prepared",
  },
  { id: "stock", name: "Готовый товар на складе", url: "", state: "prepared" },
];
export function demoDataset(): Dataset {
  const employees = names.map((name, i) => ({ id: "e" + i, name }));
  const work = employees.flatMap((e, i) => [
    ...previous.map((date, j) => ({
      id: `w-${i}-${j}`,
      employee: e.id,
      date,
      time: "17:00",
      article: "ST0043.A2180",
      operation: "Упаковка" as const,
      quantity: Math.round(
        (i === 0
          ? [1.12, 0.94, 1.05, 1.18][j]
          : scores[i] + (j % 2 ? 0.08 : -0.05)) * 1000,
      ),
      norm: 1000,
      source: "Сборка Ozon",
    })),
    ...(i === 0
      ? [
          {
            id: "w-anna-1",
            employee: e.id,
            date: ANCHOR,
            time: "10:25",
            article: "ST0043.A2180",
            operation: "Резка" as const,
            quantity: 238,
            norm: 850,
            source: "Сборка Ozon",
          },
          {
            id: "w-anna-2",
            employee: e.id,
            date: ANCHOR,
            time: "13:40",
            article: "ST0082.A1924",
            operation: "Ручная работа" as const,
            quantity: 207,
            norm: 575,
            source: "Сборка Ozon",
          },
          {
            id: "w-anna-3",
            employee: e.id,
            date: ANCHOR,
            time: "16:15",
            article: "ST0021.A7447",
            operation: "Упаковка" as const,
            quantity: 150,
            norm: 250,
            source: "Сборка Ozon",
          },
        ]
      : [
          {
            id: "w-today-" + i,
            employee: e.id,
            date: ANCHOR,
            time: "16:30",
            article: "ST0021.A7447",
            operation: "Упаковка" as const,
            quantity: Math.round(scores[i] * 1000),
            norm: 1000,
            source: "Сборка Ozon",
          },
        ]),
  ]);
  const shifts = employees.flatMap((e) =>
    [...previous, ANCHOR]
      .map((date) => ({
        employee: e.id,
        date,
        working: true,
        closed: date !== ANCHOR,
      }))
      .concat(
        ["2026-10-03", "2026-10-04"].map((date) => ({
          employee: e.id,
          date,
          working: false,
          closed: true,
        })),
      ),
  );
  const d = [18.6, 15.2, 23.1, 17.4, 11.9, 14.8, 13.6, 16.5, 12.7, 12.4];
  const a = [21.4, 17.8, 14.6, 16.2, 15.1, 12.4, 18.9, 12];
  const today = [
    ...d.map((area, i) => ({
      id: `NY-000${i + 1}-Д${i + 1}`,
      employee: "p-d",
      date: ANCHOR,
      time: `${16 - Math.floor(i / 3)}:${String(42 - i * 3).padStart(2, "0")}`,
      article: ["ST0021.A7447", "ST0082.A1924", "ST0043.A2180"][i % 3],
      quantity: 180 + i * 10,
      area,
      site: i < 6 ? "Красное здание" : "Ангар",
      source: "Сезонная печать",
    })),
    ...a.map((area, i) => ({
      id: `NY-001${i + 1}-А${i + 1}`,
      employee: "p-a",
      date: ANCHOR,
      time: `${16 - Math.floor(i / 3)}:${String(38 - i * 3).padStart(2, "0")}`,
      article: ["ST0043.A2180", "ST0021.A7447", "ST0082.A1924"][i % 3],
      quantity: 160 + i * 10,
      area,
      site: i < 4 ? "Красное здание" : "Ангар",
      source: "Сезонная печать",
    })),
  ];
  const rolls = [
    ...today,
    ...previous.flatMap((date, j) =>
      today.slice(0, 6).map((r, i) => ({
        ...r,
        id: `H-${j}-${i}`,
        date,
        area: Math.round(r.area * (1 + j * 0.1) * 10) / 10,
      })),
    ),
  ];
  const mk = (
    article: string,
    plan: number,
    printed: number,
    cut: number,
    packed: number,
  ) => ({ article, plan, printed, cut, packed, shipped: 0, reserved: 0 });
  const stock = [
    {
      article: "ST0021.A7447",
      cell: "Б-01-03",
      quantity: 200,
      date: "2026-10-06",
    },
    {
      article: "ST0021.A7447",
      cell: "М-02-01",
      quantity: 100,
      date: "2026-10-06",
    },
    {
      article: "ST0043.A2180",
      cell: "Б-02-05",
      quantity: 200,
      date: "2026-10-06",
    },
    {
      article: "ST0082.A1924",
      cell: "М-01-04",
      quantity: 100,
      date: "2026-10-06",
    },
    {
      article: "ST0054.A2011",
      cell: "Б-03-02",
      quantity: 430,
      date: "2026-10-06",
    },
    {
      article: "ST0019.A7020",
      cell: "Б-04-01",
      quantity: 720,
      date: "2026-10-06",
    },
  ];
  return {
    employees: [
      ...employees,
      { id: "p-d", name: "Дмитрий" },
      { id: "p-a", name: "Андрей" },
    ],
    work,
    rolls,
    shifts,
    stock,
    supplies: [
      {
        id: "П-0124",
        name: "Новый год",
        market: "Ozon",
        store: "RITM",
        destination: "Москва",
        arrival: "2026-10-14",
        ready: "2026-10-11",
        owner: "Кирилл",
        lines: [
          mk("ST0021.A7447", 4000, 3500, 2500, 1500),
          mk("ST0043.A2180", 3500, 3000, 2500, 2000),
          mk("ST0082.A1924", 2500, 1500, 1000, 500),
        ],
      },
      {
        id: "П-0125",
        name: "Москва",
        market: "WB",
        store: "RITM",
        destination: "Москва",
        arrival: "2026-10-16",
        ready: "2026-10-13",
        owner: "Кирилл",
        lines: [mk("ST0021.A7447", 5000, 5000, 3500, 2500)],
      },
      {
        id: "П-0126",
        name: "Хэллоуин",
        market: "Ozon",
        store: "RITM",
        destination: "Москва",
        arrival: "2026-10-18",
        ready: "2026-10-15",
        owner: "Кирилл",
        lines: [mk("ST0082.A1924", 3000, 1200, 900, 300)],
      },
      {
        id: "П-0127",
        name: "Осень",
        market: "WB",
        store: "RITM",
        destination: "Тула",
        arrival: "2026-10-20",
        ready: "2026-10-17",
        owner: "Кирилл",
        lines: [mk("ST0054.A2011", 1000, 0, 0, 0)],
      },
    ],
  };
}
