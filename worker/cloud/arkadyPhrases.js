// The arrays and cursor keys are versioned together: keep their ordering stable
// after deployment, so saved cursors never reuse an earlier complete phrase.
export function nextArkadyPhrase(scope, {key, parts, cycleLabel}) {
  const saved = String(scope.meta(key) ?? '0');
  const sequence = /^\d+$/.test(saved) ? BigInt(saved) : 0n;
  const combinations = BigInt(parts.reduce((total, choices) => total * choices.length, 1));
  // All pools have power-of-two sizes. This odd stride visits every combination
  // once while varying the sentence fragments in adjacent notifications.
  const cycle = sequence / combinations;
  let index = (sequence * 1325n) % combinations;
  const phrase = parts.map(choices => {
    const text = choices[Number(index % BigInt(choices.length))];
    index /= BigInt(choices.length);
    return text;
  });
  // After a complete cycle, a playful rating keeps the full phrase distinct.
  // It is Arkady's mood, never a statement about quantities or production KPIs.
  if (cycle > 0n) phrase.push(`${cycleLabel}: ${cycle + 10n} из 10. 🦎`);
  scope.meta(key, String(sequence + 1n));
  return phrase.join(' ');
}

const assignmentOpenings = {
  normal: [
    'Свежая порция производственных приключений!',
    'Команда, ловите новое задание!',
    'В меню дня — ещё немного производственной магии!',
    'Аркадий доставил вам повод показать мастерство!',
    'Работа подъехала, встречаем по-мастерски!',
    'Новая глава в истории наших станков!',
    'Команда, на сцену выходит новое задание!',
    'Добавим этому дню немного печатной красоты!',
  ],
  urgent: [
    'Срочка на горизонте, команда!',
    'Ловите срочное задание с характером!',
    'Для этой срочки включаю свой самый заметный цвет!',
    'Команда, тут дело с огоньком!',
    'Срочное задание просится в первые ряды!',
    'Срочка приехала, встречаем собранно!',
    'Внимание, у этого задания срочный выход на сцену!',
    'Мой хвост поймал сигнал срочности!',
  ],
};
const assignmentAsides = [
  'Я бы подключился к станку, но мой хвост ещё не прошёл обучение.',
  'Мои лапки созданы для комплиментов, а ваши руки — для производственной магии.',
  'Я уже надел воображаемую каску и готов болеть за команду.',
  'Хотел помочь телепатией, но у станка эта опция пока не установлена.',
  'Кофе пусть бодрит, а мой юмор пусть хотя бы не мешает.',
  'Я могу смотреть в две стороны, а работать всё равно удобнее по заданию.',
  'Пытался договориться с бумагой — она попросила настоящих мастеров.',
  'Мой хвост сегодня отвечает за моральную поддержку.',
  'Виртуальные мухи подождут, тут есть дела поинтереснее.',
  'Я бы принёс кофе, но доставка через чат пока проливается.',
  'Представьте, что я торжественно передаю вам задание маленькими лапками.',
  'Если бы энтузиазм был краской, я бы уже залил весь чат зелёным.',
  'Мой внутренний хамелеон приготовил помпоны для поддержки команды.',
  'В графе «поддержка» можете смело рисовать мою довольную морду.',
  'Я тренировал серьёзное лицо, но с такими мастерами опять улыбаюсь.',
  'Пока вы творите красоту, я постою рядом виртуально и очень убедительно.',
];
const assignmentEndings = {
  normal: [
    'Погнали творить красоту! 😎', 'Ровной печати и послушных материалов! 🖨️',
    'Пусть всё получится чётко! ✨', 'Команда, ваш выход! 🦎',
    'За дело, мастера! 💪', 'Пусть мастерство делает своё дело! 🔧',
    'Буду болеть за вас обоими глазами! 👀', 'Кофе по желанию, настроение рабочее! ☕',
  ],
  urgent: [
    'Берёмся бодро, работаем аккуратно! ⚡', 'Собранно, спокойно и с мастерством! 💪',
    'Скорость держим, качество бережём! 🔥', 'Срочке — внимание, команде — поддержка! 🦎',
    'Пусть всё получится чётко и вовремя! ⏰', 'Действуем уверенно, без суеты! 🚀',
    'Мастера, аккуратный турборежим — ваш! 😎', 'Погнали, команда, с вами сила хвоста! 🦎',
  ],
};

export function nextAssignmentJoke(scope, category) {
  return nextArkadyPhrase(scope, {
    key: `bitrixAssignmentJokeSequenceV2:${category}`,
    parts: [assignmentOpenings[category], assignmentAsides, assignmentEndings[category]],
    cycleLabel: category === 'urgent' ? 'Уровень моей боевой готовности' : 'Уровень моего энтузиазма',
  });
}
