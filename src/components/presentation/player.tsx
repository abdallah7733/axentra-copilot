"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowCounterClockwiseIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Wordmark, WordmarkLockup } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/workspace/bits";
import { Workspace } from "@/components/workspace/workspace";
import { PresentationAudio } from "./audio";
import { company, stepTitles } from "@/lib/demo-data";
import { scenes, useDemo } from "@/lib/store";
import { cn } from "@/lib/utils";

/*
  Presentation Mode is a clicker-driven state machine, not a scroll page.
  Scenes auto-advance on timers that pause cleanly; the approval scene has
  durationMs Infinity and waits for the presenter to click Approve.
*/

const sceneFade = {
  initial: { opacity: 0, scale: 0.995 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 1.005 },
  transition: { duration: 0.75, ease: [0.2, 0.8, 0.2, 1] as const },
};

function TitleScene() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-navy text-white">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.2 }}>
        <WordmarkLockup lockup="reversed" height={72} />
      </motion.div>
    </div>
  );
}

function ContextScene() {
  const lines = [
    "A customer calls about a double charge.",
    "The agent stays on the call.",
    "The copilot does everything else, then waits.",
  ];
  return (
    <div className="flex h-full flex-col justify-center bg-navy px-[9%] text-white">
      {lines.map((l, i) => (
        <motion.p
          key={l}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 + i * 0.9, ease: [0.2, 0.8, 0.2, 1] }}
          className={cn("text-4xl font-medium tracking-tighter leading-tight xl:text-5xl", i === 2 && "text-white/70")}
        >
          {l}
        </motion.p>
      ))}
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3.2 }} className="mt-10 text-base text-white/50">
        {company.name}, a fictional telecom provider. Simulated CRM and billing.
      </motion.p>
    </div>
  );
}

function OutroScene() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-10 bg-navy text-white">
      <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.2 }} className="max-w-[26ch] text-center text-4xl font-medium tracking-tighter leading-tight xl:text-5xl">
        The human approved. The copilot did the rest.
      </motion.p>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 1.4 }} className="flex flex-col items-center">
        <WordmarkLockup lockup="reversed" height={44} />
        <span className="mt-6 text-sm text-white/45">Graduation Project MVP, AI Copilot Diploma</span>
      </motion.div>
    </div>
  );
}

export function PresentationPlayer() {
  const sceneIndex = useDemo((s) => s.sceneIndex);
  const isPlaying = useDemo((s) => s.isPlaying);
  const hasStarted = useDemo((s) => s.hasStarted);
  const step = useDemo((s) => s.step);
  const play = useDemo((s) => s.play);
  const pause = useDemo((s) => s.pause);
  const restart = useDemo((s) => s.restart);
  const nextScene = useDemo((s) => s.nextScene);
  const prevScene = useDemo((s) => s.prevScene);
  const openApproval = useDemo((s) => s.openApproval);
  const reset = useDemo((s) => s.reset);
  const setScene = useDemo((s) => s.setScene);

  const frameRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const scene = scenes[sceneIndex];
  const atEnd = sceneIndex === scenes.length - 1;

  // Fresh store state when entering the page.
  useEffect(() => {
    reset();
    return () => reset();
  }, [reset]);

  // Deep link for recording: /presentation?from=incoming starts playback at that scene.
  const capture = useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).has("capture"),
    () => false
  );
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    if (!from) return;
    const i = scenes.findIndex((s) => s.id === from);
    if (i < 0) return;
    setScene(i);
    play();
  }, [setScene, play]);

  // Scene timer. Infinite scenes simply never schedule.
  useEffect(() => {
    if (!isPlaying || !hasStarted) return;
    if (!Number.isFinite(scene.durationMs)) return;
    const t = setTimeout(nextScene, scene.durationMs);
    return () => clearTimeout(t);
  }, [isPlaying, hasStarted, sceneIndex, scene.durationMs, nextScene]);

  // Approval scene: surface the dialog, then wait for the presenter.
  useEffect(() => {
    if (scene.step !== "awaiting_human_approval" || !hasStarted) return;
    const t = setTimeout(() => openApproval(true), 1400);
    return () => clearTimeout(t);
  }, [scene.step, hasStarted, openApproval]);

  useEffect(() => {
    if (scene.step === "awaiting_human_approval" && step === "refund_approved") {
      const t = setTimeout(nextScene, 1200);
      return () => clearTimeout(t);
    }
  }, [scene.step, step, nextScene]);

  // Fullscreen state + idle-hide for the control bar (mouse only, never scroll).
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 2200);
    };
    const onMove = () => {
      setIdle(false);
      arm();
    };
    arm();
    document.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousemove", onMove);
      setIdle(false);
    };
  }, [fullscreen]);

  const toggleFullscreen = useCallback(() => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  }, []);

  // Clicker keys: space, arrows, R, F.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, [role=dialog]")) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        if (isPlaying) pause();
        else play();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") nextScene();
      else if (e.key === "ArrowLeft" || e.key === "PageUp") prevScene();
      else if (e.key === "r") restart();
      else if (e.key === "f") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPlaying, play, pause, nextScene, prevScene, restart, toggleFullscreen]);

  return (
    <div ref={frameRef} className="capture-surface flex h-dvh flex-col bg-navy-deep text-white">
      {/* 16:9 locked stage */}
      <div className={cn("flex flex-1 items-center justify-center overflow-hidden", !capture && "p-4")}>
        <div
          data-scene={hasStarted ? scene.id : "cover"}
          className={cn(
            "relative aspect-video max-h-full w-full overflow-hidden bg-navy text-foreground",
            capture ? "h-full" : "max-w-[calc((100dvh-7rem)*16/9)] rounded-lg shadow-[0_0_0_1px_rgb(255_255_255/0.08)]"
          )}
        >
          <AnimatePresence mode="wait">
            {!hasStarted ? (
              <motion.div key="cover" {...sceneFade} className="absolute inset-0">
                <div className="flex h-full flex-col items-center justify-center gap-6 bg-navy text-white">
                  <WordmarkLockup lockup="reversed" height={52} className="mb-2" />
                  <p className="text-white/60">Product experience. Press Start, or space.</p>
                  <Button size="lg" className="rounded-full bg-cyan px-6 text-navy hover:bg-cyan/85" onClick={play}>
                    <PlayIcon data-icon="inline-start" weight="fill" /> Start
                  </Button>
                </div>
              </motion.div>
            ) : scene.kind === "title" ? (
              <motion.div key="title" {...sceneFade} className="absolute inset-0"><TitleScene /></motion.div>
            ) : scene.kind === "context" ? (
              <motion.div key="context" {...sceneFade} className="absolute inset-0"><ContextScene /></motion.div>
            ) : scene.kind === "outro" ? (
              <motion.div key="outro" {...sceneFade} className="absolute inset-0"><OutroScene /></motion.div>
            ) : (
              <motion.div key="workspace" {...sceneFade} className="absolute inset-0 flex flex-col bg-background">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-card px-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <Wordmark height={14} />
                    <span className="h-3.5 w-px bg-border" />
                    <span>{company.name}</span>
                    <span className="opacity-40">/</span>
                    <Mono>{company.caseId}</Mono>
                  </div>
                  <span>Prototype. Simulated CRM and billing integration.</span>
                </div>
                <Workspace className="flex-1" />
                <AnimatePresence mode="wait">
                  <motion.div
                    key={scene.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.35 }}
                    className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-card px-4 text-xs"
                  >
                    <span className="font-medium">{stepTitles[step]}</span>
                    <span className="text-muted-foreground">{scene.caption}</span>
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Clicker bar */}
      <div className={cn("flex h-12 shrink-0 items-center justify-between gap-4 border-t border-white/10 px-4 text-sm transition-opacity duration-500", fullscreen && idle && "opacity-0", capture && "hidden")}>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="rounded-full text-white/80 hover:bg-white/10 hover:text-white" onClick={prevScene} disabled={!hasStarted || sceneIndex === 0}>
            <CaretLeftIcon data-icon="inline-start" /> Previous
          </Button>
          {!hasStarted ? (
            <Button size="sm" className="rounded-full bg-cyan text-navy hover:bg-cyan/85" onClick={play}>
              <PlayIcon data-icon="inline-start" weight="fill" /> Start
            </Button>
          ) : isPlaying ? (
            <Button size="sm" className="rounded-full bg-white text-navy hover:bg-white/85" onClick={pause}>
              <PauseIcon data-icon="inline-start" weight="fill" /> Pause
            </Button>
          ) : (
            <Button size="sm" className="rounded-full bg-cyan text-navy hover:bg-cyan/85" onClick={play} disabled={atEnd}>
              <PlayIcon data-icon="inline-start" weight="fill" /> Continue
            </Button>
          )}
          <Button variant="ghost" size="sm" className="rounded-full text-white/80 hover:bg-white/10 hover:text-white" onClick={nextScene} disabled={!hasStarted || atEnd}>
            Next <CaretRightIcon data-icon="inline-end" />
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-white/80 hover:bg-white/10 hover:text-white" onClick={restart}>
            <ArrowCounterClockwiseIcon data-icon="inline-start" /> Restart
          </Button>
        </div>

        <div className="flex items-center gap-1.5" aria-label="Scene progress">
          {scenes.map((s, i) => (
            <span
              key={s.id}
              className={cn(
                "h-1 rounded-full transition-all",
                i < sceneIndex && hasStarted ? "w-3 bg-white/60" : i === sceneIndex && hasStarted ? "w-6 bg-cyan" : "w-3 bg-white/20"
              )}
            />
          ))}
          <Mono className="ml-3 text-xs text-white/50">
            {String(hasStarted ? sceneIndex + 1 : 0).padStart(2, "0")}/{String(scenes.length).padStart(2, "0")}
          </Mono>
        </div>

        <div className="flex items-center gap-1">
          <span className="mr-2 hidden text-xs text-white/40 lg:inline">Space play, arrows step, F fullscreen</span>
          <PresentationAudio />
          <Button variant="ghost" size="sm" className="rounded-full text-white/80 hover:bg-white/10 hover:text-white" onClick={toggleFullscreen}>
            {fullscreen ? <ArrowsInIcon data-icon="inline-start" /> : <ArrowsOutIcon data-icon="inline-start" />} {fullscreen ? "Exit" : "Fullscreen"}
          </Button>
          <Button asChild variant="ghost" size="icon-sm" className="rounded-full text-white/80 hover:bg-white/10 hover:text-white">
            <Link href="/" aria-label="Close presentation">
              <XIcon />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
