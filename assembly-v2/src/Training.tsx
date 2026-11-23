import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CircleCheck,
  CircleHelp,
  CirclePlay,
  GraduationCap,
  MonitorPlay,
  Play,
} from "lucide-react";
import type { AccessRole } from "./Access";
import { Button, Dialog, Search } from "./ui";
import { TrainingExport } from "./TrainingExport";
import { LessonVideo, LessonVisual } from "./LessonVisual";
import {
  trainingLessons,
  trainingTopics,
  type TrainingLesson,
  type TrainingPractice,
  type TrainingTopic,
} from "./trainingContent";
import arkadyPicture from "./assets/training-arkady.webp";
import "./training.css";

type LessonProgress = { step: number; done: boolean };
type TrainingProgress = Partial<Record<string, LessonProgress>>;
type ActiveTraining = {
  lesson: TrainingLesson;
  step: number;
  finished?: boolean;
};

function getProgress(key: string): TrainingProgress {
  try {
    const saved = JSON.parse(
      localStorage.getItem(key) || "{}",
    ) as TrainingProgress;
    const progress: TrainingProgress = {};
    for (const { id, steps } of trainingLessons) {
      const entry = saved?.[id];
      if (
        entry &&
        Number.isInteger(entry.step) &&
        typeof entry.done === "boolean"
      ) {
        progress[id] = {
          step: Math.max(0, Math.min(steps.length, entry.step)),
          done: entry.done,
        };
      }
    }
    return progress;
  } catch {
    return {};
  }
}

function searchKey(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
}

function TrainingExample({
  practice,
  onAnswer,
}: {
  practice: TrainingPractice;
  onAnswer: (correct: boolean) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const correct = selected === practice.answer;

  return (
    <div className="av2-training-example">
      <div className="av2-training-example-header">
        <MonitorPlay size={17} aria-hidden="true" /> Проверочный вопрос
      </div>
      <div className="av2-training-example-body">
        <h4>{practice.question}</h4>
        <div className="av2-training-example-choices">
          {practice.choices.map((choice, index) => (
            <Button
              key={choice}
              aria-pressed={selected === index}
              data-correct={correct && selected === index}
              onClick={() => {
                setSelected(index);
                onAnswer(index === practice.answer);
              }}
            >
              {choice}
              {correct && selected === index && (
                <Check size={17} aria-hidden="true" />
              )}
            </Button>
          ))}
        </div>
        {selected !== null && (
          <div
            className={
              "av2-training-feedback " + (correct ? "is-correct" : "is-retry")
            }
            role="status"
          >
            {correct ? practice.success : practice.hint}
          </div>
        )}
      </div>
    </div>
  );
}

function TrainingGuide({
  active,
  onClose,
  onStep,
  onFinish,
  onOpen,
}: {
  active: ActiveTraining;
  onClose: () => void;
  onStep: (index: number) => void;
  onFinish: () => void;
  onOpen?: () => void;
}) {
  const { lesson, step, finished } = active;
  const count = lesson.steps.length;
  const practice = step === count;
  const current = lesson.steps[step];
  const title = useRef<HTMLHeadingElement>(null);
  const [passed, setPassed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const last = step === count - 1;
  const key = lesson.id + ":" + step;
  function goTo(index: number) {
    if (index === step && !finished) return;
    setPassed(false);
    setDownloaded(false);
    onStep(index);
  }
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    title.current?.closest("dialog")?.scrollTo({ top: 0 });
  }, [key, finished]);

  return (
    <Dialog
      title={lesson.title}
      kicker={lesson.topic}
      className="av2-training-dialog"
      initialFocusId="av2-step-title"
      onClose={onClose}
    >
      <div className="av2-guide-layout">
        <nav className="av2-guide-steps" aria-label="Шаги урока">
          {lesson.steps.map((entry, index) => (
            <button
              type="button"
              key={entry.title}
              aria-current={!finished && index === step ? "step" : undefined}
              onClick={() => goTo(index)}
            >
              <span>{index + 1}</span>
              {entry.title}
            </button>
          ))}
          <button
            type="button"
            aria-current={!finished && practice ? "step" : undefined}
            onClick={() => goTo(count)}
          >
            <span>
              <CircleHelp size={15} aria-hidden="true" />
            </span>{" "}
            Практика
          </button>
        </nav>
        <div className="av2-guide-stage">
          <div className="av2-guide-counter">
            {finished
              ? "Урок пройден"
              : practice
                ? "Практика"
                : "Шаг " + (step + 1) + " из " + count}
          </div>
          <h3 id="av2-step-title" ref={title} tabIndex={-1}>
            {finished
              ? "Отлично, получилось!"
              : practice
                ? "Проверьте себя"
                : current.title}
          </h3>
          {!finished &&
            !practice &&
            (current.video ? (
              <LessonVideo key={key} clip={current.video} />
            ) : (
              <LessonVisual
                key={key}
                id={current.visual}
                description={lesson.title + " · " + current.title}
              />
            ))}
          <div className="av2-mentor">
            <img src={arkadyPicture} alt="" width={54} height={54} />
            <div>
              <strong>Аркадий</strong>
              <p>
                {finished
                  ? "Готово! Можете перейти в рабочий раздел или выбрать другой урок."
                  : practice
                    ? "Теперь попробуйте выбрать действие в этой ситуации."
                    : current.say}
              </p>
            </div>
          </div>
          {finished ? (
            <p className="av2-training-feedback is-correct">
              <CircleCheck size={20} aria-hidden="true" /> Урок отмечен как
              пройденный.
            </p>
          ) : practice ? (
            <>
              <TrainingExample
                key={key}
                practice={lesson.practice}
                onAnswer={setPassed}
              />
              {lesson.practice.workbook && (
                <div className="av2-training-example">
                  <div className="av2-training-example-header">
                    Попробуйте скачать учебный Excel
                  </div>
                  <div className="av2-training-example-body">
                    <TrainingExport onDownloaded={() => setDownloaded(true)} />
                    {downloaded && (
                      <p
                        className="av2-training-feedback is-correct"
                        role="status"
                      >
                        Учебный файл готов. В нём есть листы «Короба», «Состав»
                        и «Сводка».
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : current.detail ? (
            <ol className="lesson-detail" aria-label="Порядок действий">
              {current.detail.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
      <footer className="av2-guide-footer">
        {finished ? (
          <>
            <Button onClick={onClose}>К урокам</Button>
            {onOpen && (
              <Button primary onClick={onOpen}>
                Открыть рабочий раздел{" "}
                <ArrowRight size={17} aria-hidden="true" />
              </Button>
            )}
          </>
        ) : (
          <>
            <Button disabled={step === 0} onClick={() => goTo(step - 1)}>
              <ArrowLeft size={17} aria-hidden="true" /> Назад
            </Button>
            <Button
              primary
              disabled={practice && !passed}
              onClick={practice ? onFinish : () => goTo(step + 1)}
            >
              {practice
                ? "Завершить урок"
                : last
                  ? "Перейти к практике"
                  : lesson.steps[step + 1]?.video
                    ? "Смотреть видео"
                    : "Дальше"}{" "}
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </>
        )}
      </footer>
    </Dialog>
  );
}

export default function Training({
  role,
  navigate,
  canOpen,
}: {
  role: AccessRole;
  navigate: (view: string) => void;
  canOpen: (view: string) => boolean;
}) {
  const storageKey = "assembly.v2.training:" + role;
  const [progress, setProgress] = useState(() => getProgress(storageKey));
  const [topic, setTopic] = useState<TrainingTopic | "Все">("Все");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ActiveTraining | null>(null);
  const available = trainingLessons.filter(
    (lesson) => !lesson.roles || lesson.roles.includes(role),
  );
  const topics = trainingTopics.filter((topic) =>
    available.some((lesson) => lesson.topic === topic),
  );
  const unfinished = available.filter(({ id }) => !progress[id]?.done);
  const resume = unfinished.find(({ id }) => progress[id]);
  const suggested = resume || unfinished[0] || available[0];
  const featuredVideo = available.find((lesson) =>
    lesson.steps.some((step) => step.video),
  );
  const workView =
    active?.lesson.view === "cartons" && role === "collector"
      ? "assembly"
      : active?.lesson.view;
  const done = available.length - unfinished.length;
  const needle = searchKey(query);
  const visible = available.filter(
    (lesson) =>
      (topic === "Все" || lesson.topic === topic) &&
      searchKey(
        [
          lesson.title,
          lesson.description,
          lesson.topic,
          ...lesson.steps.flatMap((step) => [
            step.title,
            step.say,
            ...(step.detail || []),
          ]),
        ].join(" "),
      ).includes(needle),
  );

  function save(lesson: TrainingLesson, step: number, done = false) {
    const latest = getProgress(storageKey);
    const next = {
      ...progress,
      ...latest,
      [lesson.id]: {
        step,
        done:
          done || Boolean(latest[lesson.id]?.done || progress[lesson.id]?.done),
      },
    };
    setProgress(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  }
  function open(lesson: TrainingLesson, initialStep?: number) {
    const current = progress[lesson.id];
    const step = initialStep ?? (current?.done ? 0 : (current?.step ?? 0));
    setActive({ lesson, step });
    if (!current || initialStep !== undefined) save(lesson, step);
  }
  return (
    <main className="content av2-training">
      <section
        className="av2-training-hero"
        aria-labelledby="av2-training-title"
      >
        <div className="av2-training-copy">
          <span>
            <GraduationCap size={20} aria-hidden="true" /> Обучение в RITM Сборка
          </span>
          <h1 id="av2-training-title">
            Сборка
            <br />
            <span>с Аркадием</span>
          </h1>
          <p>
            Покажу, как найти товар, собрать короб и скачать его состав. Можно
            посмотреть рабочие экраны, затем ответить на вопросы на учебном
            примере.
          </p>
          <div>
            <Button primary onClick={() => open(suggested)}>
              <Play size={17} aria-hidden="true" />{" "}
              {resume
                ? "Продолжить урок"
                : unfinished.length
                  ? "Начать обучение"
                  : "Повторить урок"}
            </Button>
            {featuredVideo && (
              <Button
                className="av2-featured-video"
                onClick={() =>
                  open(
                    featuredVideo,
                    featuredVideo.steps.findIndex((step) => step.video),
                  )
                }
              >
                <CirclePlay size={18} aria-hidden="true" /> Видео про этикетки
              </Button>
            )}
            <a href="#av2-training-lessons">
              Все уроки <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <small>{suggested.title}</small>
        </div>
        <div className="av2-training-art" aria-hidden="true">
          <div className="av2-training-orbit" />
          <img src={arkadyPicture} alt="" width={720} height={720} />
          <div className="av2-training-greeting">
            <i /> Покажу на примере
          </div>
        </div>
      </section>
      <section
        className="av2-training-library"
        id="av2-training-lessons"
        aria-labelledby="av2-training-library-title"
      >
        <div className="av2-training-library-header">
          <h2 id="av2-training-library-title">Все уроки</h2>
          <div className="av2-training-progress">
            <strong>
              {done} из {available.length} пройдено
            </strong>
            <progress
              aria-label="Уроков пройдено"
              max={available.length}
              value={done}
            />
          </div>
        </div>
        <div className="av2-training-toolbar">
          <div
            className="av2-training-topics"
            role="group"
            aria-label="Темы уроков"
          >
            {(["Все", ...topics] as const).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={topic === item}
                onClick={() => setTopic(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <Search
            label="Найти урок"
            placeholder="Найти урок"
            value={query}
            onChange={setQuery}
          />
        </div>
        {visible.length ? (
          <ul className="av2-training-cards">
            {visible.map((lesson) => {
              const Icon = lesson.icon;
              const videoStep = lesson.steps.findIndex((step) => step.video);
              return (
                <li
                  key={lesson.id}
                  className={
                    videoStep >= 0 ? "av2-lesson-with-video" : undefined
                  }
                >
                  <button
                    type="button"
                    className="av2-lesson-card"
                    data-topic={lesson.topic}
                    onClick={() => open(lesson)}
                  >
                    <span className="av2-lesson-card-top">
                      <span>
                        <Icon size={21} aria-hidden="true" />
                      </span>
                      <ArrowRight size={17} aria-hidden="true" />
                    </span>
                    <strong>{lesson.title}</strong>
                    <span>{lesson.description}</span>
                    <span className="av2-lesson-meta">
                      {lesson.topic}
                      {progress[lesson.id]?.done ? (
                        <em>
                          <Check size={15} aria-hidden="true" /> Пройдено
                        </em>
                      ) : (
                        progress[lesson.id] && <em>В процессе</em>
                      )}
                    </span>
                  </button>
                  {videoStep >= 0 && (
                    <Button
                      className="av2-lesson-video"
                      onClick={() => open(lesson, videoStep)}
                    >
                      <CirclePlay size={17} aria-hidden="true" /> Смотреть видео
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="av2-training-empty" role="status">
            <BookOpen size={23} aria-hidden="true" />
            <strong>Уроков не найдено</strong>
            <Button
              onClick={() => {
                setTopic("Все");
                setQuery("");
              }}
            >
              Показать все уроки
            </Button>
          </div>
        )}
      </section>
      {active && (
        <TrainingGuide
          active={active}
          onClose={() => setActive(null)}
          onStep={(step) => {
            setActive({ lesson: active.lesson, step });
            save(active.lesson, step);
          }}
          onFinish={() => {
            setActive({ ...active, finished: true });
            save(active.lesson, active.step, true);
          }}
          onOpen={
            workView && canOpen(workView)
              ? () => {
                  setActive(null);
                  navigate(workView);
                }
              : undefined
          }
        />
      )}
    </main>
  );
}
