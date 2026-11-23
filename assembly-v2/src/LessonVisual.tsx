import { useId, useRef, useState, type CSSProperties } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import screens from "./lessonScreens.json";
import "./lessonVisual.css";

const imageUrls = import.meta.glob<string>("./assets/lesson-screens/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});

export type LessonScreenId = keyof typeof screens;

export type LessonClip = {
  title: string;
  src: string;
  poster: string;
  captions: string;
};

export function LessonVideo({ clip }: { clip: LessonClip }) {
  return (
    <video
      className="lesson-video"
      aria-label={clip.title}
      controls
      playsInline
      preload="metadata"
      poster={clip.poster}
      src={clip.src}
    >
      <track kind="captions" srcLang="ru" label="Русский" src={clip.captions} />
      <a href={clip.src}>Открыть видео</a>
    </video>
  );
}

export function LessonVisual({
  id,
  description,
}: {
  id: LessonScreenId;
  description: string;
}) {
  const [zoom, setZoom] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const viewportId = useId();
  const screenshot = screens[id];

  function toggleZoom() {
    if (zoom && viewport.current) viewport.current.scrollLeft = 0;
    setZoom(!zoom);
  }

  return (
    <figure className="lesson-visual">
      <figcaption className="lesson-visual-heading">
        <span>Рабочий экран · учебные данные</span>
        <button
          className="lesson-visual-zoom"
          type="button"
          aria-expanded={zoom}
          aria-controls={viewportId}
          onClick={toggleZoom}
        >
          {zoom ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
          {zoom ? "Вернуть масштаб" : "Увеличить"}
        </button>
      </figcaption>
      <div
        className="lesson-visual-viewport"
        data-zoom={zoom}
        id={viewportId}
        ref={viewport}
        role={zoom ? "region" : undefined}
        tabIndex={zoom ? 0 : undefined}
        aria-label={
          zoom ? "Снимок в полном размере. Можно прокрутить." : undefined
        }
      >
        <div
          className="lesson-visual-image"
          style={
            {
              "--shot-width": screenshot.width + "px",
              "--shot-ratio": screenshot.width / screenshot.height,
            } as CSSProperties
          }
        >
          <img
            src={imageUrls["./assets/lesson-screens/" + id + ".webp"]}
            width={screenshot.width}
            height={screenshot.height}
            alt={description}
            decoding="async"
          />
          {screenshot.markers.map((point, index) => (
            <span
              className="lesson-visual-marker"
              key={point.label}
              aria-hidden="true"
              style={{
                left: point.x + "%",
                top: point.y + "%",
                width: point.w + "%",
                height: point.h + "%",
              }}
            >
              <span>{index + 1}</span>
            </span>
          ))}
        </div>
      </div>
      <ol className="lesson-visual-legend" aria-label="Отметки на снимке">
        {screenshot.markers.map((point, index) => (
          <li key={point.label}>
            <span aria-hidden="true">{index + 1}</span>
            {point.label}
          </li>
        ))}
      </ol>
    </figure>
  );
}
