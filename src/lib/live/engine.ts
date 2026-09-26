/*
  Client for the Axentra local engine (axentra-local-transcript/server.js).
  The engine runs on the presenter's Mac and serves this console at /console/,
  so every call below is same-origin. On the public site these endpoints do not
  exist, the health check fails, and live mode stays off.

  Speech recognition happens on the Mac. Audio goes only to the engine on
  127.0.0.1, is processed in memory, and is never stored.
*/

export type EngineHealth = {
  engine?: string;
  ready: boolean;
  primary?: string;
  gpu?: boolean;
  vad?: boolean;
};

export type Side = "caller" | "agent";

export type Recognition = { side: Side; model: string; text: string; confidence: number | null; elapsedMs: number };

/** Engine endpoints live at the site root, outside the /console base path. */
export async function readEngineHealth(): Promise<EngineHealth | null> {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as EngineHealth;
    return body.engine === "axentra-local" ? body : null;
  } catch {
    return null;
  }
}

export async function fetchPhoneToken(accessCode: string): Promise<string> {
  const response = await fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ accessCode }),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error || "Could not connect the phone");
  return body.token;
}

export async function recognize(side: Side, samples: Float32Array): Promise<Recognition> {
  const response = await fetch(`/transcribe?${new URLSearchParams({ side, lang: "en" })}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav(samples, 16000),
  });
  if (!response.ok) throw new Error("Local recognizer could not process audio");
  return response.json();
}

/** Loads the Twilio Voice SDK the engine serves. Never loaded on the public site. */
let sdkPromise: Promise<void> | null = null;
export function loadTwilioSdk(): Promise<void> {
  if (typeof window !== "undefined" && window.Twilio?.Device) return Promise.resolve();
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/twilio.min.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Could not load the phone component from the local engine"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const data = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(data);
  const str = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, data.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return data;
}

/* ---------- Speech-aware phrase splitting (same tuning as the tested engine page) ---------- */

export type Phrase = { id: number; startedAt: number; endedAt: number; samples: Float32Array | null };

const FRAME_MS = 20;

/**
 * Splits a stream into phrases at pauses instead of fixed chunks. Levels are 20 ms
 * frame RMS against an adaptive noise floor. A phrase starts after 60 ms of speech
 * (keeping 300 ms before it), ends after 600 ms of silence, and is cut at 12 s.
 */
function createSegmenter(rate: number, onFinal: (p: Phrase) => void) {
  const size = Math.round((rate * FRAME_MS) / 1000);
  const PREROLL = 15, START = 3, HANGOVER = 30, TAIL = 10, MIN_VOICED = 12, MAX = 600, SPLIT_WINDOW = 100;
  type Seg = { id: number; frames: Float32Array[]; levels: number[]; voiced: number; silence: number; startedAt: number };
  let carry = new Float32Array(0);
  let ring: [Float32Array, number][] = [];
  let loud = 0, noise = 0.003, nextId = 0, peak = 0;
  let seg: Seg | null = null;

  const join = (frames: Float32Array[]) => {
    const out = new Float32Array(frames.length * size);
    frames.forEach((frame, i) => out.set(frame, i * size));
    return out;
  };
  const rms = (frame: Float32Array) => {
    let e = 0;
    for (const v of frame) e += v * v;
    return Math.sqrt(e / frame.length);
  };
  const begin = (frames: Float32Array[], levels: number[], voiced: number): Seg => ({
    id: ++nextId, frames, levels, voiced, silence: 0, startedAt: performance.now() - frames.length * FRAME_MS,
  });
  const emit = (s: Seg, frames: Float32Array[], endedAt: number) =>
    onFinal({ id: s.id, startedAt: s.startedAt, endedAt, samples: s.voiced >= MIN_VOICED ? join(frames) : null });

  function handle(frame: Float32Array) {
    const level = rms(frame);
    peak = Math.max(peak, level);
    const on = Math.max(0.01, noise * 3), off = Math.max(0.006, noise * 2);
    if (!seg) {
      ring.push([frame, level]);
      if (ring.length > PREROLL) ring.shift();
      if (level < on) {
        loud = 0;
        noise = Math.max(0.001, noise + (level - noise) * 0.05);
        return;
      }
      if (++loud < START) return;
      seg = begin(ring.map((r) => r[0]), ring.map((r) => r[1]), loud);
      ring = [];
      loud = 0;
      return;
    }
    seg.frames.push(frame);
    seg.levels.push(level);
    if (level >= off) {
      seg.voiced++;
      seg.silence = 0;
    } else seg.silence++;
    if (seg.silence >= HANGOVER) {
      const s = seg;
      seg = null;
      emit(s, s.frames.slice(0, s.frames.length - s.silence + TAIL), performance.now() - s.silence * FRAME_MS);
      return;
    }
    if (seg.frames.length >= MAX) {
      let cut = seg.frames.length - 1;
      for (let i = seg.frames.length - SPLIT_WINDOW; i < seg.frames.length; i++) if (seg.levels[i] < seg.levels[cut]) cut = i;
      const s = seg;
      const restLevels = s.levels.slice(cut);
      seg = begin(s.frames.slice(cut), restLevels, restLevels.filter((l) => l >= off).length);
      emit(s, s.frames.slice(0, cut), seg.startedAt);
    }
  }

  return {
    push(data: Float32Array) {
      const all = new Float32Array(carry.length + data.length);
      all.set(carry);
      all.set(data, carry.length);
      let at = 0;
      for (; at + size <= all.length; at += size) handle(all.slice(at, at + size));
      carry = all.slice(at);
    },
    flush() {
      if (!seg) return;
      const s = seg;
      seg = null;
      emit(s, s.frames.slice(0, s.frames.length - Math.max(0, s.silence - TAIL)), performance.now() - s.silence * FRAME_MS);
    },
    peak: () => peak,
  };
}

export type CaptureHandle = { close: () => Promise<{ peak: number }> };

/** Captures one audio stream at 16 kHz and hands finished phrases to `onPhrase`. */
export async function captureStream(stream: MediaStream, onPhrase: (p: Phrase) => void): Promise<CaptureHandle> {
  if (!stream.getAudioTracks().length) throw new Error("Audio stream is unavailable");
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("/capture-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "axentra-capture");
  const silence = context.createGain();
  silence.gain.value = 0;
  source.connect(node).connect(silence).connect(context.destination);
  const segmenter = createSegmenter(context.sampleRate, onPhrase);
  let stopped = false;
  let flushComplete: () => void = () => {};
  const flushed = new Promise<void>((resolve) => (flushComplete = resolve));
  node.port.onmessage = ({ data }) => {
    if (data === "flushed") return flushComplete();
    segmenter.push(data as Float32Array);
  };
  await context.resume();
  return {
    async close() {
      if (!stopped) {
        stopped = true;
        node.port.postMessage("flush");
        await Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 1000))]);
        node.port.onmessage = null;
        segmenter.flush();
        await context.close();
      }
      return { peak: segmenter.peak() };
    },
  };
}

/* ---------- Minimal types for the Twilio Voice SDK 2.x global ---------- */

export type TwilioCall = {
  parameters: Record<string, string | undefined>;
  accept: () => void;
  reject: () => void;
  disconnect: () => void;
  getLocalStream: () => MediaStream | undefined;
  getRemoteStream: () => MediaStream | undefined;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type TwilioDevice = {
  register: () => Promise<void>;
  destroy: () => void;
  updateToken: (token: string) => void;
  on: (event: string, handler: (...args: never[]) => void) => void;
  audio?: { setInputDevice: (id: string) => Promise<void>; availableInputDevices: Map<string, MediaDeviceInfo> };
};

/**
 * Selects the Agent microphone on the phone. A new Device lists inputs in the
 * background, and setInputDevice rejects ("Device not found") until that list
 * includes the mic, so wait for it first (up to about 3 s).
 */
export async function selectPhoneMic(device: TwilioDevice, micId: string): Promise<void> {
  const audio = device.audio;
  if (!audio) throw new Error("Microphone selection is not supported");
  for (let attempt = 0; attempt < 15 && !audio.availableInputDevices.has(micId); attempt++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await audio.setInputDevice(micId);
}

declare global {
  interface Window {
    Twilio?: { Device: new (token: string, options?: Record<string, unknown>) => TwilioDevice };
  }
}
