import { useEffect, useRef, useState, type MouseEvent } from "react";
import { BookOpen, CirclePlay, GraduationCap, Play } from "lucide-react";
import GuidedLesson from "./GuidedLesson";
import { ArrowRight, CheckCircle, MagnifyingGlass, X } from "./icons";
import {
  lessons,
  lessonTopics,
  type Lesson,
  type LessonTopic,
} from "./learningContent";
import type { Page } from "./model";
import "./HelpWorkspace.css";

type Progress = Partial<Record<string, { step: number; completed: boolean }>>;
type ActiveLesson = { lesson: Lesson; step: number };

function readProgress(key: string): Progress {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}") as Progress;
    const progress: Progress = {};
    for (const { id, steps } of lessons) {
      const entry = saved?.[id];
      if (
        entry &&
        Number.isInteger(entry.step) &&
        typeof entry.completed === "boolean"
      ) {
        progress[id] = {
          step: Math.min(steps.length, Math.max(0, entry.step)),
          completed: entry.completed,
        };
      }
    }
    return progress;
  } catch {
    return {};
  }
}

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");
}

export default function HelpWorkspace({
  identity,
  isOwner,
  go,
  onWhatsNew,
}: {
  identity: string;
  isOwner: boolean;
  go: (page: Page) => void;
  onWhatsNew?: () => void;
}) {
  const storageKey = "ritm-learning-v1:" + identity;
  const [progress, setProgress] = useState(() => readProgress(storageKey));
  const [active, setActive] = useState<ActiveLesson | null>(null);
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<LessonTopic | "Все">("Все");
  const opener = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey) setProgress(readProgress(storageKey));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);

  const available = lessons.filter((lesson) => !lesson.ownerOnly || isOwner);
  const topics = lessonTopics.filter((item) =>
    available.some((lesson) => lesson.topic === item),
  );
  const completed = available.filter(
    ({ id }) => progress[id]?.completed,
  ).length;
  const remaining = available.filter(({ id }) => !progress[id]?.completed);
  const resume = remaining.find(({ id }) => progress[id]);
  const suggested = resume || remaining[0] || available[0];
  const featuredVideo = available.find((lesson) =>
    lesson.steps.some((step) => step.video),
  );
  const startLabel = resume
    ? "Продолжить урок"
    : completed === 0
      ? "Начать обучение"
      : remaining.length
        ? "Следующий урок"
        : "Повторить урок";
  const needle = normalizeSearch(query);
  const filtered = available.filter((lesson) => {
    const matchesTopic = topic === "Все" || lesson.topic === topic;
    const searchable = [
      lesson.title,
      lesson.description,
      lesson.section,
      lesson.practice.question,
      ...lesson.steps.flatMap((step) => [
        step.title,
        step.cue,
        step.screen,
        step.target,
        step.nearby,
      ]),
    ].join(" ");
    return matchesTopic && normalizeSearch(searchable).includes(needle);
  });

  const remember = (lesson: Lesson, step: number) => {
    const stored = readProgress(storageKey);
    const next: Progress = {
      ...progress,
      ...stored,
      [lesson.id]: {
        step: Math.min(step, lesson.steps.length),
        completed: Boolean(
          stored[lesson.id]?.completed ||
          progress[lesson.id]?.completed ||
          step > lesson.steps.length,
        ),
      },
    };
    setProgress(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  };
  const openLesson = (
    lesson: Lesson,
    event?: MouseEvent<HTMLButtonElement>,
    initialStep?: number,
  ) => {
    if (event) opener.current = event.currentTarget;
    const saved = progress[lesson.id];
    const step = initialStep ?? (saved?.completed ? 0 : (saved?.step ?? 0));
    setActive({ lesson, step });
    if (!saved || initialStep !== undefined) remember(lesson, step);
  };
  const recordStep = (lesson: Lesson, step: number) => {
    setActive({ lesson, step });
    remember(lesson, step);
  };
  const nextLesson = active
    ? remaining.find((lesson) => lesson.id !== active.lesson.id)
    : undefined;

  return (
    <div className="learning">
      <section className="learning-hero" aria-labelledby="learning-heading">
        <div className="learning-hero-copy">
          <span className="learning-eyebrow">
            <GraduationCap size={18} aria-hidden="true" /> Интерактивное
            обучение
          </span>
          <h2 id="learning-heading">
            Освойте RITM
            <br />
            <span>вместе с Аркадием</span>
          </h2>
          <p>
            Покажу, как оформить поставку, сверить сроки и проверить выработку.
            Попробуем на учебных примерах.
          </p>
          <div className="learning-hero-actions">
            {onWhatsNew && (
              <button type="button" className="learning-secondary" onClick={onWhatsNew}>
                Что нового
              </button>
            )}
            <button
              type="button"
              className="learning-primary"
              onClick={(event) => openLesson(suggested, event)}
            >
              <Play size={17} aria-hidden="true" /> {startLabel}
            </button>
            {featuredVideo && (
              <button
                type="button"
                className="learning-secondary"
                onClick={(event) =>
                  openLesson(
                    featuredVideo,
                    event,
                    featuredVideo.steps.findIndex((step) => step.video),
                  )
                }
              >
                <CirclePlay size={18} aria-hidden="true" /> Видео про поставку
              </button>
            )}
            <a className="learning-text-link" href="#learning-lessons">
              Все уроки <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="learning-suggested">{suggested.title}</div>
        </div>
        <div className="learning-hero-art" aria-hidden="true">
          <div className="learning-grid-lines" />
          <div className="learning-orbit learning-orbit--outer" />
          <div className="learning-orbit learning-orbit--inner" />
          <div className="learning-portrait">
            <img src="/help/arkady.webp" alt="" width={720} height={720} />
          </div>
          <div className="learning-greeting">
            <span />
            Привет! Я Аркадий
          </div>
        </div>
      </section>

      <div className="learning-directory">
        <section
          className="learning-library"
          id="learning-lessons"
          aria-labelledby="learning-library-title"
        >
          <div className="learning-library-heading">
            <h2 id="learning-library-title">Уроки по задачам</h2>
            <div className="learning-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                ref={search}
                type="search"
                aria-label="Найти урок"
                placeholder="Найти урок"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Очистить поиск"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <X size={17} />
                </button>
              )}
            </div>
          </div>
          <div
            className="learning-topics"
            aria-label="Темы уроков"
            role="group"
          >
            {(["Все", ...topics] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={item === topic}
                onClick={() => setTopic(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {filtered.length ? (
            <ul className="learning-lessons">
              {filtered.map((lesson) => {
                const Icon = lesson.icon;
                const saved = progress[lesson.id];
                const videoStep = lesson.steps.findIndex((step) => step.video);
                return (
                  <li
                    key={lesson.id}
                    className={
                      videoStep >= 0 ? "learning-lesson-with-video" : undefined
                    }
                  >
                    <button
                      type="button"
                      data-topic={lesson.topic}
                      className="learning-lesson"
                      onClick={(event) => openLesson(lesson, event)}
                    >
                      <span className="learning-lesson-top">
                        <span className="learning-lesson-icon">
                          <Icon size={21} aria-hidden="true" />
                        </span>
                        <ArrowRight
                          className="learning-lesson-arrow"
                          size={18}
                          aria-hidden="true"
                        />
                      </span>
                      <strong>{lesson.title}</strong>
                      <span className="learning-lesson-description">
                        {lesson.description}
                      </span>
                      <span className="learning-lesson-meta">
                        {lesson.steps.length}{" "}
                        {lesson.steps.length < 5 ? "шага" : "шагов"} · практика
                        {saved?.completed ? (
                          <span className="learning-pill is-done">
                            <CheckCircle size={14} aria-hidden="true" />{" "}
                            Пройдено
                          </span>
                        ) : (
                          saved && (
                            <span className="learning-pill">В процессе</span>
                          )
                        )}
                      </span>
                    </button>
                    {videoStep >= 0 && (
                      <button
                        type="button"
                        className="learning-secondary learning-lesson-video"
                        onClick={(event) =>
                          openLesson(lesson, event, videoStep)
                        }
                      >
                        <CirclePlay size={17} aria-hidden="true" /> Смотреть
                        видео
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="learning-empty" role="status">
              <MagnifyingGlass size={23} aria-hidden="true" />
              <strong>Уроков не найдено</strong>
              <p>Попробуйте другой запрос или покажите все уроки.</p>
              <button
                className="learning-secondary"
                type="button"
                onClick={() => {
                  setQuery("");
                  setTopic("Все");
                }}
              >
                Показать все уроки
              </button>
            </div>
          )}
        </section>

        <aside
          className="learning-progress"
          aria-labelledby="learning-progress-title"
        >
          <div className="learning-progress-heading">
            <span className="learning-progress-icon">
              <BookOpen size={20} aria-hidden="true" />
            </span>
            <h2 id="learning-progress-title">Мой прогресс</h2>
          </div>
          <div className="learning-progress-total">
            <strong>
              {completed}
              <span> / {available.length}</span>
            </strong>{" "}
            уроков пройдено
          </div>
          <div
            className="learning-progress-track"
            role="progressbar"
            aria-label="Пройдено уроков"
            aria-valuenow={completed}
            aria-valuemax={available.length}
          >
            {available.map((lesson, index) => (
              <span
                key={lesson.id}
                className={index < completed ? "is-done" : undefined}
              />
            ))}
          </div>
          <ul className="learning-progress-topics">
            {topics.map((item) => {
              const matching = available.filter(
                (lesson) => lesson.topic === item,
              );
              const done = matching.filter(
                ({ id }) => progress[id]?.completed,
              ).length;
              return (
                <li key={item}>
                  <span>{item}</span>
                  <strong>
                    {done} из {matching.length}
                  </strong>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      {active && (
        <GuidedLesson
          lesson={active.lesson}
          step={active.step}
          onStepChange={(step) => recordStep(active.lesson, step)}
          onClose={() => setActive(null)}
          onReturnFocus={() => opener.current?.focus()}
          onOpenSection={() => {
            setActive(null);
            go(active.lesson.page);
          }}
          onNextLesson={nextLesson ? () => openLesson(nextLesson) : undefined}
        />
      )}
    </div>
  );
}
