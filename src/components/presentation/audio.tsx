"use client";

import { useEffect, useRef, useState } from "react";
import { SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { scenes, sceneAudioOffsetMs, useDemo } from "@/lib/store";

/*
  Presentation audio, two layers:
  1. Ambient bed: /audio/ambient.mp3 looped at low volume. If the file is not
     there, a soft synthesized pad (Web Audio) takes its place so the recording
     is never silent.
  2. Call dialogue: /audio/call.mp3, generated externally from
     docs/call-audio-prompt.md. It is seeked to each scene's offset, so Next,
     Previous and Pause keep picture and sound aligned. During the open-ended
     approval scene it pauses after the customer's line and resumes on Approve.
*/

const AMBIENT_VOLUME = 0.08;
const PAD_GAIN = 0.03;
const APPROVAL_CUSTOMER_LINE_MS = 3200;

function useSynthPad(active: boolean) {
  const ctxRef = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null);

  useEffect(() => {
    if (!active) {
      ctxRef.current?.gain.gain.setTargetAtTime(0, ctxRef.current.ctx.currentTime, 0.4);
      return;
    }
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;
      filter.Q.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 140;
      lfo.connect(lfoGain).connect(filter.frequency);
      lfo.start();
      // A quiet, slightly detuned major-ninth voicing. Reads as a room tone, not a song.
      [65.41, 98.0, 130.81, 146.83, 196.0].forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = i % 2 ? "triangle" : "sine";
        osc.frequency.value = f;
        osc.detune.value = (i - 2) * 4;
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 0.5 : 0.28;
        osc.connect(g).connect(filter);
        osc.start();
      });
      filter.connect(gain).connect(ctx.destination);
      ctxRef.current = { ctx, gain };
    }
    const { ctx, gain } = ctxRef.current;
    void ctx.resume();
    gain.gain.setTargetAtTime(PAD_GAIN, ctx.currentTime, 1.2);
  }, [active]);

  useEffect(() => () => void ctxRef.current?.ctx.close(), []);
}

export function PresentationAudio() {
  const hasStarted = useDemo((s) => s.hasStarted);
  const isPlaying = useDemo((s) => s.isPlaying);
  const sceneIndex = useDemo((s) => s.sceneIndex);
  const step = useDemo((s) => s.step);

  const [muted, setMuted] = useState(false);
  const [ambientMissing, setAmbientMissing] = useState(false);
  const ambientRef = useRef<HTMLAudioElement>(null);
  const callRef = useRef<HTMLAudioElement>(null);

  const scene = scenes[sceneIndex];
  const atEnd = sceneIndex === scenes.length - 1 && !isPlaying;
  const ambientOn = hasStarted && isPlaying && !muted && !atEnd;

  useSynthPad(ambientOn && ambientMissing);

  // Ambient bed
  useEffect(() => {
    const el = ambientRef.current;
    if (!el || ambientMissing) return;
    el.volume = AMBIENT_VOLUME;
    if (ambientOn) void el.play().catch(() => {});
    else el.pause();
  }, [ambientOn, ambientMissing]);

  // Call dialogue: seek to the scene offset on every scene change.
  useEffect(() => {
    const el = callRef.current;
    if (!el || !hasStarted) return;
    const offset = sceneAudioOffsetMs(sceneIndex);
    if (offset === null) {
      el.pause();
      el.currentTime = 0;
      return;
    }
    el.currentTime = offset / 1000;
    if (isPlaying && !muted) void el.play().catch(() => {});
    else el.pause();
  }, [sceneIndex, hasStarted, isPlaying, muted]);

  // Approval scene: let the customer finish, then hold until the presenter approves.
  useEffect(() => {
    const el = callRef.current;
    if (!el || scene.step !== "awaiting_human_approval" || step === "refund_approved") return;
    const t = setTimeout(() => el.pause(), APPROVAL_CUSTOMER_LINE_MS);
    return () => clearTimeout(t);
  }, [scene.step, step, sceneIndex, isPlaying]);

  useEffect(() => {
    if (!hasStarted) {
      ambientRef.current?.pause();
      callRef.current?.pause();
    }
  }, [hasStarted]);

  return (
    <>
      <audio ref={ambientRef} src="/audio/ambient.mp3" loop preload="auto" onError={() => setAmbientMissing(true)} />
      <audio ref={callRef} src="/audio/call.mp3" preload="auto" />
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        onClick={() => setMuted((m) => !m)}
        aria-label={muted ? "Unmute audio" : "Mute audio"}
      >
        {muted ? <SpeakerSlashIcon data-icon="inline-start" /> : <SpeakerHighIcon data-icon="inline-start" />}
        {muted ? "Muted" : "Audio"}
      </Button>
    </>
  );
}
