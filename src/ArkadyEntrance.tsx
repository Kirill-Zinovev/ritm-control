import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { mountArkadyRig } from "./arkadyJumpRig";
import "./arkadyEntrance.css";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const atlasLoadTimeout = 850;
const portalOpenTime = 750;
const diveTime = 1120;
const arrivalTime = 1320;
const portalOpeningDelay = 120;
const portalFadeAfterOpening = 690;
let atlasRequest: Promise<HTMLImageElement> | undefined;

type EntranceProps = {
  onOpen: (fromPortal: boolean) => void;
  onFinish: () => void;
};

function loadAtlas() {
  if (!atlasRequest) {
    const image = new Image();
    image.src = "/images/arkady-jump-rig.png";
    atlasRequest = image.decode().then(() => image, (error) => {
      atlasRequest = undefined;
      throw error;
    });
  }
  return atlasRequest;
}

export function preloadArkadyEntrance() {
  if (!window.matchMedia(reducedMotionQuery).matches) {
    void loadAtlas().catch(() => {});
  }
}

function easeBetween(start: number, end: number, value: number) {
  const progress = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return progress * progress * (3 - 2 * progress);
}

export function ArkadyEntrance({ onOpen, onFinish }: EntranceProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const impactRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onOpen, onFinish });

  useEffect(() => {
    callbacks.current = { onOpen, onFinish };
  }, [onOpen, onFinish]);

  useEffect(() => {
    const stage = stageRef.current;
    const actor = actorRef.current;
    const canvas = canvasRef.current;
    const shadow = shadowRef.current;
    const impact = impactRef.current;
    const motion = window.matchMedia(reducedMotionQuery);
    if (!stage || !actor || !canvas || !shadow || !impact || motion.matches) {
      callbacks.current.onOpen(false);
      callbacks.current.onFinish();
      return;
    }

    let stopped = false;
    let opened = false;
    let frame = 0;
    let startedAt: number | undefined;
    let rig: ReturnType<typeof mountArkadyRig> | undefined;
    let width = 0;
    let height = 0;
    let size = 0;
    let portalX = 0;
    let portalY = 0;
    let timeout = window.setTimeout(finish, atlasLoadTimeout);

    function stop() {
      stopped = true;
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      motion.removeEventListener("change", handlePreference);
    }

    function openPanel(fromPortal = false) {
      if (opened) return;
      opened = true;
      callbacks.current.onOpen(fromPortal);
    }

    function finish() {
      if (stopped) return;
      stop();
      openPanel();
      callbacks.current.onFinish();
    }

    function handlePreference(event: MediaQueryListEvent) {
      if (event.matches) finish();
    }

    function measure() {
      if (!stage || !actor || !impact || opened) return;
      width = stage.clientWidth;
      height = stage.clientHeight;
      size = actor.offsetWidth;
      const portalBounds = impact.getBoundingClientRect();
      portalX = portalBounds.left + portalBounds.width / 2;
      portalY = portalBounds.top + portalBounds.height / 2;
      rig?.resize();
    }

    function draw(now: number) {
      if (!stage || !actor || !shadow || !rig) return;
      startedAt ??= now;
      const elapsed = now - startedAt;
      if (elapsed >= portalOpenTime && !stage.dataset.portalOpen) stage.dataset.portalOpen = "true";
      if (elapsed >= diveTime && !stage.dataset.entering) stage.dataset.entering = "true";
      if (elapsed >= arrivalTime) {
        actor.style.opacity = "0";
        shadow.style.opacity = "0";
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          stage.dataset.revealing = "true";
          openPanel(true);
          timeout = window.setTimeout(finish, portalFadeAfterOpening);
        }, portalOpeningDelay);
        return;
      }
      const pose = Math.max(0, Math.min(1, (elapsed - 85) / 1350));
      const travel = easeBetween(0.57, 0.91, pose);
      const lift = 4 * travel * (1 - travel);
      const appear = easeBetween(0, 175, elapsed);
      const vanish = 1 - easeBetween(0.67, 1, travel);
      const shrink = easeBetween(0.42, 1, travel);
      const startX = width * (width > 640 ? 0.6 : 0.5);
      const startY = Math.min(height - 24, Math.max(size * 0.91 + 12, height * 0.73));
      const diveX = portalX + Math.min(38, width * 0.1);
      const x = startX + (diveX - startX) * travel;
      const scale = (0.91 + 0.09 * appear) * (1 - 0.74 * shrink);
      const ground = startY + (portalY + size * scale * 0.45 - startY) * travel;
      const feetY = Math.max(size * scale * 0.92 + 4, ground - Math.min(height * 0.13, 84) * lift);
      const bottom = feetY + (1 - rig.bottom()) * size * scale;
      actor.style.transform = `translate3d(${x}px, ${bottom}px, 0) rotate(${13 * lift}deg) scale(${scale})`;
      actor.style.opacity = String(appear * vanish);
      shadow.style.transform = `translate3d(${x}px, ${ground}px, 0) scale(${scale})`;
      shadow.style.opacity = String(appear * vanish * 0.64 * (1 - lift * 0.8));
      rig.draw(pose);

      frame = window.requestAnimationFrame(draw);
    }

    motion.addEventListener("change", handlePreference);
    void loadAtlas().then((image) => {
      if (stopped) return;
      rig = mountArkadyRig(canvas, image);
      measure();
      window.addEventListener("resize", measure);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(finish, arrivalTime + portalOpeningDelay + portalFadeAfterOpening + 300);
      stage.dataset.ready = "true";
      frame = window.requestAnimationFrame(draw);
    }).catch(() => finish());

    return stop;
  }, []);

  return createPortal(
    <div className="arkady-entrance" ref={stageRef} aria-hidden="true">
      <div className="arkady-entrance__shadow" ref={shadowRef} />
      <div className="arkady-entrance__actor" ref={actorRef}>
        <canvas ref={canvasRef} />
      </div>
      <div className="arkady-entrance__impact" ref={impactRef}>
        <div className="arkady-portal__core" />
        <div className="arkady-portal__rim" />
        <i /><i /><i /><i /><i />
      </div>
    </div>,
    document.body,
  );
}
