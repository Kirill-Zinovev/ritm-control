import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CircleHelp } from "lucide-react";
import { ArrowLeft, ArrowRight, CheckCircle, X } from "./icons";
import type { Lesson } from "./learningContent";
import { LessonVideo, LessonVisual } from "./LessonVisual";

function Arkady({ children }: { children: string }) {
  return (
    <div className="learning-mentor">
      <img src="/help/arkady.webp" alt="" width={58} height={58} />
      <div>
        <strong>Аркадий</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

function LessonPractice({
  practice,
  formId,
  onCorrect,
}: {
  practice: Lesson["practice"];
  formId: string;
  onCorrect: () => void;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [retry, setRetry] = useState(false);
  function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (choice === practice.answer) onCorrect();
    else setRetry(true);
  }

  return (
    <form id={formId} className="learning-practice" onSubmit={check}>
      <fieldset>
        <legend>{practice.question}</legend>
        <div className="learning-choices">
          {practice.choices.map((label, index) => (
            <label
              className="learning-choice"
              data-chosen={index === choice}
              key={label}
            >
              <input
                type="radio"
                name={formId}
                required
                checked={index === choice}
                onChange={() => {
                  setChoice(index);
                  setRetry(false);
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {retry && (
        <div className="learning-retry" role="alert">
          <CircleHelp size={18} aria-hidden="true" />
          <span>{practice.hint} Попробуйте ещё раз.</span>
        </div>
      )}
    </form>
  );
}

export default function GuidedLesson({
  lesson,
  step,
  onStepChange,
  onClose,
  onReturnFocus,
  onOpenSection,
  onNextLesson,
}: {
  lesson: Lesson;
  step: number;
  onStepChange: (step: number) => void;
  onClose: () => void;
  onReturnFocus: () => void;
  onOpenSection: () => void;
  onNextLesson?: () => void;
}) {
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const count = lesson.steps.length;
  const showPractice = step === count;
  const finished = step > count;
  const current = lesson.steps[step];
  const currentKey = lesson.id + "-" + step;

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [currentKey]);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="learning-overlay" />
        <Dialog.Content
          className="learning-guide"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <header className="learning-guide-heading">
            <div>
              <div className="learning-guide-route">
                {lesson.section} <span aria-hidden="true">/</span> Урок
              </div>
              <Dialog.Title>{lesson.title}</Dialog.Title>
            </div>
            <Dialog.Close
              className="learning-icon-button"
              aria-label="Закрыть урок"
            >
              <X size={21} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="learning-guide-body" ref={scroll}>
            <nav className="learning-outline" aria-label="Шаги урока">
              <ol>
                {lesson.steps.map((entry, index) => (
                  <li key={entry.title}>
                    <button
                      type="button"
                      aria-current={step === index ? "step" : undefined}
                      aria-label={entry.title}
                      onClick={() => onStepChange(index)}
                    >
                      <span className="learning-outline-number">
                        {index + 1}
                      </span>
                      <span className="learning-outline-label">
                        {entry.title}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    aria-current={showPractice ? "step" : undefined}
                    aria-label="Практика"
                    onClick={() => onStepChange(count)}
                  >
                    <span className="learning-outline-number">
                      {finished ? (
                        <CheckCircle size={16} />
                      ) : (
                        <CircleHelp size={16} />
                      )}
                    </span>
                    <span className="learning-outline-label">Практика</span>
                  </button>
                </li>
              </ol>
            </nav>
            <div className="learning-stage">
              <div className="learning-stage-label">
                {finished
                  ? "Урок пройден"
                  : showPractice
                    ? "Практика"
                    : "Шаг " + (step + 1) + " из " + count}
              </div>
              <h3 tabIndex={-1} ref={heading}>
                {finished
                  ? "Отлично, получилось!"
                  : showPractice
                    ? "Проверьте себя"
                    : current.title}
              </h3>
              {finished ? (
                <div className="learning-stage-content" key={currentKey}>
                  <Arkady>{lesson.practice.hint}</Arkady>
                  <div className="learning-summary">
                    <CheckCircle size={23} aria-hidden="true" />
                    <span>Урок отмечен как пройденный.</span>
                  </div>
                </div>
              ) : showPractice ? (
                <div className="learning-stage-content" key={currentKey}>
                  <Arkady>
                    Теперь ваша очередь. Выберите, что бы вы сделали в этой
                    ситуации.
                  </Arkady>
                  <LessonPractice
                    practice={lesson.practice}
                    formId={formId}
                    onCorrect={() => onStepChange(count + 1)}
                  />
                </div>
              ) : (
                <div className="learning-stage-content" key={currentKey}>
                  {current.video ? (
                    <LessonVideo clip={current.video} />
                  ) : (
                    <LessonVisual
                      id={current.visual}
                      description={current.screen + " · " + current.target}
                    />
                  )}
                  <Arkady>{current.cue}</Arkady>
                  {current.detail && (
                    <ol className="lesson-detail" aria-label="Порядок действий">
                      {current.detail.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          </div>
          <footer className="learning-guide-footer">
            {finished ? (
              <>
                {onNextLesson && (
                  <button
                    type="button"
                    className="learning-secondary"
                    onClick={onNextLesson}
                  >
                    Следующий урок
                  </button>
                )}
                <button
                  type="button"
                  className="learning-primary"
                  onClick={onOpenSection}
                >
                  Открыть «{lesson.section}»{" "}
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="learning-secondary"
                  disabled={step === 0}
                  onClick={() => onStepChange(step - 1)}
                >
                  <ArrowLeft size={17} aria-hidden="true" /> Назад
                </button>
                {showPractice ? (
                  <button
                    type="submit"
                    className="learning-primary"
                    form={formId}
                  >
                    Проверить ответ <CheckCircle size={17} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="learning-primary"
                    onClick={() => onStepChange(step + 1)}
                  >
                    {step === count - 1
                      ? "Перейти к практике"
                      : lesson.steps[step + 1]?.video
                        ? "Смотреть видео"
                        : "Дальше"}{" "}
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
