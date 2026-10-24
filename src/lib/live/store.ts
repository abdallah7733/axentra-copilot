"use client";

import { create } from "zustand";
import { createEventBus } from "@/lib/copilot/events";
import {
  captureStream,
  fetchPhoneToken,
  loadTwilioSdk,
  readEngineHealth,
  recognize,
  selectPhoneMic,
  type CaptureHandle,
  type EngineHealth,
  type Phrase,
  type Side,
  type TwilioCall,
  type TwilioDevice,
} from "./engine";
import { isShortReply, sendShortReply } from "./short-reply";

/*
  Live presenter mode: a real call through the Milestone 1 Twilio number, with
  both sides transcribed by the local engine. Separate from the scripted demo
  store on purpose, so /demo and /presentation are untouched.

  Milestone 3: each final line carries the call it belongs to (the Twilio
  CallSid), a sequence number and absolute timestamps, and is emitted on
  `liveEvents`. The copilot subscribes there; it never reads this store's lines.
*/

/** The transcript event boundary for live mode. */
export const liveEvents = createEventBus();

export type LiveLine = {
  key: string;
  callId: string;
  /** Arrival order within the call, from 1. */
  seq: number;
  side: Side;
  text: string;
  /** performance.now() time, for the on-screen call clock. */
  startedAt: number;
  /** Epoch milliseconds when the speech began and ended. */
  startedAtEpoch: number;
  endedAtEpoch: number;
  /** Epoch milliseconds when this text was ready: when the line arrived, or when its check finished. */
  availableAtEpoch: number;
  /** Seconds between the speaker stopping and the text appearing. */
  delay: number;
  confidence: number | null;
  /** The second speech model is re-checking this key answer. */
  checking?: boolean;
  /** What the fast model heard first, when the check changed the text. */
  firstHeard?: string;
  /** Seconds the check took. */
  checkSeconds?: number;
  /** The check failed or timed out, or the call ended first; the fast model's text stands. */
  checkFailed?: boolean;
  /** A key answer the second model couldn't check: its audio was no longer held, or the engine has no check model. */
  checkSkipped?: "no-audio" | "no-model";
  /** An agent line heard again in case it was the name read-back: nothing waits for it and its text stays as first heard. */
  probe?: boolean;
  /** What the second model heard on that line (text null: the check failed), and when (epoch ms). */
  reheard?: { text: string | null; confidence: number | null; at: number };
};

export type EngineState = "checking" | "offline" | "online";
export type Phase = "setup" | "connecting" | "ready" | "incoming" | "active";
export type Mic = { id: string; label: string };
/** A scripted line for the offline replay (no call, no audio, no engine). */
export type ReplayLine = { side: Side; text: string; confidence?: number | null };

type LiveState = {
  engine: EngineState;
  health: EngineHealth | null;
  phase: Phase;
  status: string;
  error: string | null;
  callerFrom: string | null;
  callStartedAt: number | null;
  callEndedAt: number | null;
  lines: LiveLine[];
  /**
   * Phrases this call that never became a line: too little voice to send, or the fast model returned no words.
   * Counted per side so a lost phrase shows up in Call details (22 Oct call: the refund sentence's card ending
   * never appeared, with nothing on screen to say whether audio was lost).
   */
  dropped: Record<Side, { short: number; empty: number }>;
  delays: number[];
  levels: { agent: number; caller: number; agentInput: string } | null;
  mics: Mic[];
  micId: string;
  /** An offline replay is running instead of a call. */
  replaying: boolean;
  sopOpen: boolean;

  checkEngine: () => Promise<void>;
  refreshMics: () => Promise<void>;
  setMic: (id: string) => void;
  connect: (accessCode: string) => Promise<void>;
  answer: () => void;
  decline: () => void;
  hangUp: () => void;
  clearTranscript: () => void;
  replay: (lines: ReplayLine[], msPerLine?: number) => void;
  stopReplay: () => void;
  setSop: (open: boolean) => void;
  /**
   * Re-checks a caller line with the engine's second speech model. Returns "started", or why it
   * couldn't: no audio held for it (only the last few caller phrases are kept), or no check model.
   * A key answer that can't be checked is marked on screen (not in a replay, which has no audio).
   * `probe`: an agent line heard again in case it was the name read-back; its text stays as first heard
   * and the second model's hearing is kept beside it (LiveLine.reheard).
   */
  checkLine: (key: string, probe?: boolean) => "started" | "no-audio" | "no-model";
};

const MIC_KEY = "axentra-mic-label";
const noDrops = (): Record<Side, { short: number; empty: number }> => ({ agent: { short: 0, empty: 0 }, caller: { short: 0, empty: 0 } });

/** Shown on a projected screen, so keep only the country code and last four digits. */
const maskNumber = (from: string | undefined) => {
  const digits = (from ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? `+${digits.slice(0, digits[0] === "1" ? 1 : 2)} •••• ${digits.slice(-4)}` : "Hidden number";
};

// Not React state: SDK objects and the access code, which stays in memory only
// (for token refresh) and is never written anywhere.
let device: TwilioDevice | null = null;
let currentCall: TwilioCall | null = null;
let accessCode = "";
let captures: CaptureHandle[] = [];
let captureInput = "";
let epoch = 0;
let callId = "";
let seq = 0;
let replayTimers: ReturnType<typeof setTimeout>[] = [];
// The last few phrases from both sides, in memory only, so a key line can be re-checked. Cleared with each call.
const recentAudio = new Map<string, Float32Array>();
const RECENT_AUDIO = 12;

/**
 * performance.now() time to epoch milliseconds, from one anchor per call: the wall clock and
 * performance.now() read together when the call starts. Every line and every panel action in a call
 * is timed on the same monotonic clock, so a wall-clock change mid-call can't reorder them.
 * Not performance.timeOrigin + t: on macOS performance.now() stops while the Mac sleeps, so that
 * sum fell 6.5 hours behind on the 11 Oct call ("verified at 04:46 PM", approved at 11:15 PM).
 */
let anchor: { wall: number; mono: number } | null = null;
const reanchor = () => (anchor = { wall: Date.now(), mono: performance.now() });
export const toEpoch = (t: number) => {
  const a = anchor ?? reanchor();
  return Math.round(a.wall + (t - a.mono));
};
/** Now, on the call's clock. Panel actions use this too, so they sort correctly against the lines. */
export const epochNow = () => toEpoch(performance.now());

const readSavedMic = () => {
  try {
    return localStorage.getItem(MIC_KEY);
  } catch {
    return null;
  }
};

export const useLive = create<LiveState>((set, get) => {
  const status = (value: string) => set({ status: value });

  async function ensureMicAccess() {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    await get().refreshMics();
  }

  function emitLine(line: LiveLine) {
    liveEvents.emit({
      type: "line",
      line: {
        callId: line.callId,
        seq: line.seq,
        key: line.key,
        side: line.side,
        text: line.text,
        startedAt: line.startedAtEpoch,
        endedAt: line.endedAtEpoch,
        final: true,
        confidence: line.confidence,
        checking: line.probe ? undefined : line.checking,
        firstHeard: line.firstHeard,
        checkFailed: line.checkFailed,
        checked: line.checkSeconds !== undefined && !line.checkFailed && !line.checking && !line.probe ? true : undefined,
        availableAt: line.availableAtEpoch,
        ...(line.reheard ? { reheard: line.reheard } : {}),
      },
    });
  }

  function addLine(fields: Omit<LiveLine, "callId" | "seq" | "startedAtEpoch" | "endedAtEpoch" | "availableAtEpoch">, endedAt: number) {
    const line: LiveLine = { ...fields, callId, seq: ++seq, startedAtEpoch: toEpoch(fields.startedAt), endedAtEpoch: toEpoch(endedAt), availableAtEpoch: epochNow() };
    // Order by when the speech began, not when recognition finished.
    const lines = [...get().lines.filter((l) => l.key !== line.key), line].sort((a, b) => a.startedAt - b.startedAt);
    // A replay has no recognition delay, so it must not count towards the median.
    set({ lines: lines.slice(-200), delays: get().replaying ? get().delays : [...get().delays, line.delay] });
    emitLine(line);
  }

  /** Replaces a line in place (same key and sequence number) and, unless told not to, tells the copilot. */
  function updateLine(key: string, change: Partial<LiveLine>, emit = true) {
    const current = get().lines.find((l) => l.key === key);
    if (!current) return;
    const line = { ...current, ...change };
    set({ lines: get().lines.map((l) => (l.key === key ? line : l)) });
    if (emit) emitLine(line);
  }

  function startCall(id: string) {
    reanchor();
    callId = id;
    seq = 0;
    recentAudio.clear();
    liveEvents.emit({ type: "call-started", callId, at: epochNow() });
  }

  function cancelReplay() {
    replayTimers.forEach(clearTimeout);
    replayTimers = [];
    if (get().replaying) {
      set({ replaying: false, callEndedAt: performance.now() });
      liveEvents.emit({ type: "call-ended", callId, at: epochNow() });
    }
  }

  /** One queue per side so each speaker's phrases stay in order. */
  function sideSink(side: Side, callEpoch: number, turn: { agentEnd: number | null }) {
    let queue = Promise.resolve();
    const drop = (why: "short" | "empty") => {
      const dropped = get().dropped;
      set({ dropped: { ...dropped, [side]: { ...dropped[side], [why]: dropped[side][why] + 1 } } });
    };
    return (phrase: Phrase) => {
      const shortReply = sendShortReply(phrase, side, turn.agentEnd);
      if (!phrase.samples || (phrase.short && !shortReply)) {
        if (callEpoch === epoch) drop("short");
        return;
      }
      if (side === "agent") turn.agentEnd = phrase.endedAt;
      const samples = phrase.samples;
      queue = queue
        .then(async () => {
          const result = await recognize(side, samples);
          if (callEpoch !== epoch) return;
          if (shortReply && !isShortReply(result.text)) return drop("short");
          if (!result.text) return drop("empty");
          // Kept for the second model's check: caller answers, and agent lines the copilot may ask about.
          recentAudio.set(`${side}-${phrase.id}`, samples);
          for (const key of [...recentAudio.keys()].slice(0, -RECENT_AUDIO)) recentAudio.delete(key);
          addLine(
            {
              key: `${side}-${phrase.id}`,
              side,
              text: result.text,
              startedAt: phrase.startedAt,
              delay: (performance.now() - phrase.endedAt) / 1000,
              confidence: result.confidence,
            },
            phrase.endedAt
          );
        })
        .catch(() => {
          if (callEpoch === epoch) set({ error: "Local transcription had an error. The call audio is unaffected." });
        });
    };
  }

  async function startCaptures(call: TwilioCall, callEpoch: number) {
    let local: MediaStream | undefined, remote: MediaStream | undefined;
    for (let attempt = 0; attempt < 15; attempt++) {
      local = call.getLocalStream();
      remote = call.getRemoteStream();
      if (local?.getAudioTracks().length && remote?.getAudioTracks().length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (callEpoch !== epoch || currentCall !== call || !local || !remote) return;
    // When the agent last stopped speaking, for the caller's short replies.
    const turn = { agentEnd: null as number | null };
    const results = await Promise.allSettled([captureStream(local, sideSink("agent", callEpoch, turn)), captureStream(remote, sideSink("caller", callEpoch, turn))]);
    const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (callEpoch !== epoch || started.length < 2) {
      started.forEach((h) => h.close());
      if (callEpoch === epoch) set({ error: "Could not capture both call streams. The call audio is unaffected." });
      return;
    }
    captures = started;
    captureInput = local.getAudioTracks()[0]?.label || "unnamed input";
    status("Call connected. Transcribing both sides on this Mac.");
  }

  async function stopCaptures() {
    const stopped = captures;
    captures = [];
    const closed = await Promise.allSettled(stopped.map((h) => h.close()));
    const peak = (i: number) => (closed[i]?.status === "fulfilled" ? (closed[i] as PromiseFulfilledResult<{ peak: number }>).value.peak : 0);
    if (closed.length === 2) set({ levels: { agent: peak(0), caller: peak(1), agentInput: captureInput } });
  }

  function endCall(message: string) {
    currentCall = null;
    epoch++;
    recentAudio.clear();
    // A check still running is dropped with the call (its result can't reach the next call), so settle
    // it now: the fast model's text stands, as a doubtful line, instead of "checking" for ever.
    for (const l of get().lines)
      if (l.checking) updateLine(l.key, l.probe ? { checking: false, reheard: { text: null, confidence: null, at: epochNow() } } : { checking: false, checkFailed: true, availableAtEpoch: epochNow() });
    set({ phase: "ready", status: message, callEndedAt: performance.now() });
    liveEvents.emit({ type: "call-ended", callId, at: epochNow() });
    void stopCaptures();
  }

  return {
    engine: "checking",
    health: null,
    phase: "setup",
    status: "Enter the access code to receive calls.",
    error: null,
    callerFrom: null,
    callStartedAt: null,
    callEndedAt: null,
    lines: [],
    dropped: noDrops(),
    delays: [],
    levels: null,
    mics: [],
    micId: "",
    replaying: false,
    sopOpen: false,

    checkLine: (key, probe = false) => {
      const samples = recentAudio.get(key);
      const skipped = !get().health?.check ? "no-model" : !samples ? "no-audio" : null;
      if (skipped || !samples) {
        if (skipped && !get().replaying && !probe) updateLine(key, { checkSkipped: skipped }, false);
        return skipped ?? "no-audio";
      }
      recentAudio.delete(key);
      const callEpoch = epoch;
      const began = performance.now();
      const heard = get().lines.find((l) => l.key === key);
      const fast = heard?.text ?? "";
      // The copilot asked for this check and already holds the line back (or, for a probe, counts it as heard); only
      // the screen needs to know.
      updateLine(key, probe ? { checking: true, probe: true } : { checking: true }, false);
      const failed = (checkSeconds: number) =>
        updateLine(key, probe ? { checking: false, checkSeconds, reheard: { text: null, confidence: null, at: epochNow() } } : { checking: false, checkFailed: true, checkSeconds, availableAtEpoch: epochNow() });
      recognize(heard?.side ?? "caller", samples, true).then(
        (result) => {
          if (callEpoch !== epoch) return;
          const checkSeconds = (performance.now() - began) / 1000;
          if (!result.text) return failed(checkSeconds);
          if (probe) return updateLine(key, { checking: false, checkSeconds, reheard: { text: result.text, confidence: result.confidence, at: epochNow() } });
          updateLine(key, {
            checking: false,
            text: result.text,
            confidence: result.confidence,
            firstHeard: result.text === fast ? undefined : fast,
            checkSeconds,
            availableAtEpoch: epochNow(),
          });
        },
        () => {
          if (callEpoch === epoch) failed((performance.now() - began) / 1000);
        }
      );
      return "started";
    },

    checkEngine: async () => {
      const health = await readEngineHealth();
      set({ engine: health ? "online" : "offline", health });
      if (health) void get().refreshMics();
    },

    refreshMics: async () => {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications" && d.label
      );
      if (!inputs.length) return;
      const mics = inputs.map((d) => ({ id: d.deviceId, label: d.label }));
      const current = get().mics.find((m) => m.id === get().micId)?.label;
      const pick =
        [current, readSavedMic()].map((label) => mics.find((m) => m.label === label)).find(Boolean) ||
        mics.find((m) => /built-in|macbook/i.test(m.label));
      set({ mics, micId: pick ? pick.id : "" });
    },

    setMic: (id) => {
      set({ micId: id });
      const label = get().mics.find((m) => m.id === id)?.label ?? "";
      try {
        localStorage.setItem(MIC_KEY, label);
      } catch {}
      if (device && id) {
        selectPhoneMic(device, id).then(
          () => set({ error: null }),
          () => set({ error: "Could not select that microphone. Using the system default." })
        );
      }
    },

    connect: async (code) => {
      if (!code) return status("Enter the private access code.");
      accessCode = code;
      set({ phase: "connecting", status: "Connecting…", error: null });
      try {
        const health = await readEngineHealth();
        if (!health?.ready) throw new Error("The local speech model is not ready yet. Wait a few seconds and try again.");
        await ensureMicAccess();
        const [token] = await Promise.all([fetchPhoneToken(accessCode), loadTwilioSdk()]);
        const Device = window.Twilio?.Device;
        if (!Device) throw new Error("The phone component did not load.");
        device = new Device(token, { closeProtection: true });
        const micId = get().micId;
        if (micId) {
          await selectPhoneMic(device, micId).catch(() => set({ error: "Could not select that microphone. Using the system default." }));
        }
        device.on("registered", () => set({ phase: "ready", status: "Ready. Calls to +1 775 258 8868 will ring here." }));
        device.on("registering", () => status("Connecting…"));
        device.on("unregistered", () => set({ phase: "setup", status: "Disconnected. Enter the access code to reconnect." }));
        device.on("error", (error: { message?: string }) => set({ error: `Phone error: ${error?.message ?? "unknown"}` }));
        device.on("tokenWillExpire", async () => {
          try {
            device?.updateToken(await fetchPhoneToken(accessCode));
          } catch {
            set({ error: "Session expired. Reload and enter the access code again." });
          }
        });
        device.on("incoming", (call: TwilioCall) => {
          cancelReplay();
          currentCall = call;
          epoch++;
          startCall(call.parameters.CallSid || `call-${Date.now()}`);
          const callEpoch = epoch;
          set({
            phase: "incoming",
            status: "Incoming call",
            callerFrom: maskNumber(call.parameters.From),
            lines: [],
            dropped: noDrops(),
            delays: [],
            levels: null,
            error: null,
            callStartedAt: null,
            callEndedAt: null,
          });
          call.on("accept", () => {
            set({ phase: "active", status: "Call connected", callStartedAt: performance.now() });
            void startCaptures(call, callEpoch);
            // The check model loads after the fast one, so read the engine's state again for this call.
            void readEngineHealth().then((health) => health && set({ health }));
          });
          call.on("disconnect", () => endCall("Call ended. Ready for another call."));
          call.on("cancel", () => endCall("Caller hung up. Ready for another call."));
          call.on("reject", () => endCall("Call declined. Ready for another call."));
          call.on("error", (error) => set({ error: `Call error: ${(error as { message?: string })?.message ?? "unknown"}` }));
        });
        await device.register();
      } catch (error) {
        accessCode = "";
        device?.destroy();
        device = null;
        set({ phase: "setup", status: "Enter the access code to receive calls.", error: (error as Error).message || "Could not connect" });
      }
    },

    answer: () => currentCall?.accept(),
    decline: () => currentCall?.reject(),
    hangUp: () => currentCall?.disconnect(),
    clearTranscript: () => {
      cancelReplay();
      set({ lines: [], dropped: noDrops(), delays: [], levels: null, callStartedAt: null, callEndedAt: null });
      liveEvents.emit({ type: "cleared" });
    },

    /** Feeds scripted lines through the same path as a call, for rehearsal. No call, no audio. */
    replay: (script, msPerLine = 2200) => {
      if (currentCall) return;
      cancelReplay();
      epoch++;
      startCall(`replay-${Date.now()}`);
      const began = performance.now();
      set({ replaying: true, lines: [], dropped: noDrops(), delays: [], levels: null, error: null, callerFrom: "Replay, no call", callStartedAt: began, callEndedAt: null });
      script.forEach((l, i) => {
        replayTimers.push(
          setTimeout(() => {
            const endedAt = performance.now();
            const startedAt = endedAt - Math.min(msPerLine - 200, 400 + l.text.length * 45);
            addLine({ key: `replay-${i}`, side: l.side, text: l.text, startedAt, delay: 0, confidence: l.confidence === undefined ? 0.9 : l.confidence }, endedAt);
          }, (i + 1) * msPerLine)
        );
      });
      replayTimers.push(setTimeout(cancelReplay, (script.length + 1) * msPerLine));
    },
    stopReplay: () => cancelReplay(),
    setSop: (open) => set({ sopOpen: open }),
  };
});

export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
