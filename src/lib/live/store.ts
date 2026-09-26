"use client";

import { create } from "zustand";
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

/*
  Live presenter mode: a real call through the Milestone 1 Twilio number, with
  both sides transcribed by the local engine. Separate from the scripted demo
  store on purpose, so /demo and /presentation are untouched.
*/

export type LiveLine = {
  key: string;
  side: Side;
  text: string;
  startedAt: number;
  /** Seconds between the speaker stopping and the text appearing. */
  delay: number;
  confidence: number | null;
};

export type EngineState = "checking" | "offline" | "online";
export type Phase = "setup" | "connecting" | "ready" | "incoming" | "active";
export type Mic = { id: string; label: string };

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
  delays: number[];
  levels: { agent: number; caller: number; agentInput: string } | null;
  mics: Mic[];
  micId: string;

  checkEngine: () => Promise<void>;
  refreshMics: () => Promise<void>;
  setMic: (id: string) => void;
  connect: (accessCode: string) => Promise<void>;
  answer: () => void;
  decline: () => void;
  hangUp: () => void;
  clearTranscript: () => void;
};

const MIC_KEY = "axentra-mic-label";

// Not React state: SDK objects and the access code, which stays in memory only
// (for token refresh) and is never written anywhere.
let device: TwilioDevice | null = null;
let currentCall: TwilioCall | null = null;
let accessCode = "";
let captures: CaptureHandle[] = [];
let captureInput = "";
let epoch = 0;

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

  function addLine(line: LiveLine) {
    // Order by when the speech began, not when recognition finished.
    const lines = [...get().lines.filter((l) => l.key !== line.key), line].sort((a, b) => a.startedAt - b.startedAt);
    set({ lines: lines.slice(-200), delays: [...get().delays, line.delay] });
  }

  /** One queue per side so each speaker's phrases stay in order. */
  function sideSink(side: Side, callEpoch: number) {
    let queue = Promise.resolve();
    return (phrase: Phrase) => {
      if (!phrase.samples) return;
      const samples = phrase.samples;
      queue = queue
        .then(async () => {
          const result = await recognize(side, samples);
          if (callEpoch !== epoch || !result.text) return;
          addLine({
            key: `${side}-${phrase.id}`,
            side,
            text: result.text,
            startedAt: phrase.startedAt,
            delay: (performance.now() - phrase.endedAt) / 1000,
            confidence: result.confidence,
          });
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
    const results = await Promise.allSettled([captureStream(local, sideSink("agent", callEpoch)), captureStream(remote, sideSink("caller", callEpoch))]);
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
    set({ phase: "ready", status: message, callEndedAt: performance.now() });
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
    delays: [],
    levels: null,
    mics: [],
    micId: "",

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
          currentCall = call;
          epoch++;
          const callEpoch = epoch;
          set({
            phase: "incoming",
            status: "Incoming call",
            callerFrom: call.parameters.From ?? null,
            lines: [],
            delays: [],
            levels: null,
            error: null,
            callStartedAt: null,
            callEndedAt: null,
          });
          call.on("accept", () => {
            set({ phase: "active", status: "Call connected", callStartedAt: performance.now() });
            void startCaptures(call, callEpoch);
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
    clearTranscript: () => set({ lines: [], delays: [], levels: null, callStartedAt: null, callEndedAt: null }),
  };
});

export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
