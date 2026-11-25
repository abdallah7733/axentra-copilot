/*
  Test support, not imported by the app: a live call driven through the real store, with fake browser objects. A fake
  Twilio Device and Call, a fake AudioContext and AudioWorkletNode feeding 20 ms frames into the real phrase cutter, the
  real store (the phrases still with the fast model, the held audio), the real copilot store deciding when to call
  checkLine, and a stand-in engine (fetch) whose every /transcribe request the test answers by hand, so the test chooses
  the order in which lines land. performance.now() is a variable moved on 20 ms a frame, so every time is exact.
  Written by the check of the C12 fixes (23 Nov 2026), which found that no test reached the store's "nothing said in
  between" bookkeeping: with it, the planted faults that weaken that rule fail the suite.
*/
export const clock = { mono: 1_000_000 };
Object.defineProperty(performance, "now", { value: () => clock.mono, configurable: true, writable: true });

process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
process.env.NEXT_PUBLIC_AGENT_CONFIRMS_MATCH = "1";
process.env.NEXT_PUBLIC_STRICT_MATCH = "1";
process.env.NEXT_PUBLIC_QUESTION_IN_CHECK = "1";

// ---- fake AbortSignal.timeout on the simulated clock (S4 timing) ----
export const timers: { at: number; c: AbortController }[] = [];
(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
  const c = new AbortController();
  timers.push({ at: clock.mono + ms, c });
  return c.signal;
};
export function fireTimers() {
  for (const t of timers) if (!t.c.signal.aborted && t.at <= clock.mono) t.c.abort(new DOMException("The operation timed out.", "TimeoutError"));
}

// ---- stub engine ----
export type Req = {
  gen: number;
  side: string | null;
  check: boolean;
  words: boolean;
  samples: number;
  at: number;
  done: boolean;
  aborted: boolean;
  ok: (body: Record<string, unknown>) => void;
  fail: (status: number) => void;
};
export const reqs: Req[] = [];
/** Which call the requests belong to: bumped by startLiveCall. */
export const gen = { now: 0 };
export const engine = { health: { engine: "axentra-local", ready: true, check: true, wordScores: true, saveAudio: true } as Record<string, unknown> };
globalThis.fetch = (async (url: string, init: { body?: ArrayBuffer; signal?: AbortSignal } = {}) => {
  const u = new URL(url, "http://127.0.0.1:8765");
  if (u.pathname === "/health") return { ok: true, json: async () => engine.health };
  if (u.pathname === "/token") return { ok: true, json: async () => ({ token: "t" }) };
  if (u.pathname === "/transcribe")
    return new Promise((resolve, reject) => {
      const r: Req = {
        gen: gen.now,
        side: u.searchParams.get("side"),
        check: u.searchParams.get("check") === "1",
        words: u.searchParams.get("words") === "1",
        samples: ((init.body as ArrayBuffer).byteLength - 44) / 2,
        at: clock.mono,
        done: false,
        aborted: false,
        ok: (body) => {
          r.done = true;
          resolve({ ok: true, json: async () => body });
        },
        fail: (status) => {
          r.done = true;
          resolve({ ok: false, status, json: async () => ({}) });
        },
      };
      reqs.push(r);
      init.signal?.addEventListener("abort", () => {
        r.aborted = true;
        r.done = true;
        reject(init.signal!.reason);
      });
    });
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

// ---- fake browser: navigator, window.Twilio, audio ----
Object.defineProperty(globalThis, "navigator", {
  value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }), enumerateDevices: async () => [] } },
  configurable: true,
  writable: true,
});
export const device = { handlers: {} as Record<string, (...a: unknown[]) => void> };
class FakeDevice {
  on(ev: string, h: (...a: unknown[]) => void) {
    device.handlers[ev] = h;
  }
  async register() {
    device.handlers.registered?.();
  }
  destroy() {}
  updateToken() {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.Twilio = { Device: FakeDevice };

/** holdFlush: the worklet never answers "flushed", so close() waits its real 1 s before the segmenter's last phrase. */
export const audio = { holdFlush: false };
type Port = { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
export const nodes: { stream: unknown; port: Port }[] = [];
class FakeContext {
  sampleRate = 16000;
  destination = {};
  stream: unknown = null;
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource(s: unknown) {
    this.stream = s;
    return { connect: (n: unknown) => n };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (x: unknown) => x };
  }
  async resume() {}
  async close() {}
}
class FakeNode {
  stream: unknown;
  port: Port;
  constructor(ctx: FakeContext) {
    this.stream = ctx.stream;
    this.port = { onmessage: null, postMessage: (m) => m === "flush" && !audio.holdFlush && queueMicrotask(() => this.port.onmessage?.({ data: "flushed" })) };
    nodes.push(this);
  }
  connect(x: unknown) {
    return x;
  }
}
g.AudioContext = FakeContext;
g.AudioWorkletNode = FakeNode;

export const { heldForTests, useLive, toEpoch } = await import("./store");
export const { useCopilot } = await import("./copilot-store");

export const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

let connected = false;
let lastCall: { disconnect: () => void } | null = null;
/** A new call rings and is answered; resolves once both captures run. Returns the driver for its audio. */
export async function startLiveCall(sid: string) {
  if (!connected) {
    await useLive.getState().connect("code");
    connected = true;
  }
  const local = { getAudioTracks: () => [{ label: "Agent mic" }] };
  const remote = { getAudioTracks: () => [{ label: "Caller" }] };
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const call = {
    parameters: { CallSid: sid, From: "+15550001234" },
    accept: () => handlers.accept?.(),
    reject: () => handlers.reject?.(),
    disconnect: () => handlers.disconnect?.(),
    getLocalStream: () => local,
    getRemoteStream: () => remote,
    on: (ev: string, h: (...a: unknown[]) => void) => {
      handlers[ev] = h;
    },
  };
  // A test that failed half-way left its call up: end it first, so tests don't cascade.
  if (lastCall) {
    lastCall.disconnect();
    await settle();
  }
  lastCall = call;
  gen.now++;
  device.handlers.incoming(call);
  useLive.getState().answer();
  await settle();
  const agent = nodes.find((n) => n.stream === local)!;
  const caller = nodes.find((n) => n.stream === remote)!;
  if (!agent || !caller) throw new Error("captures did not start");
  const t0 = clock.mono;
  let t = 0;
  const speech = { agent: [] as [number, number][], caller: [] as [number, number][] };
  const level = (side: "agent" | "caller", ms: number) => (speech[side].some(([a, b]) => ms >= a && ms < b) ? 0.2 : 0);
  return {
    sid,
    t0,
    agentNode: agent,
    callerNode: caller,
    handlers,
    /** Epoch ms of a time on this call's audio clock (ms since capture began). */
    epochAt: (ms: number) => toEpoch(t0 + ms),
    say(side: "agent" | "caller", from: number, to: number) {
      speech[side].push([from, to]);
    },
    /** Feeds both sides' audio, 20 ms a frame, up to `ms` since capture began. */
    async until(ms: number) {
      while (t < ms) {
        const frameStart = t;
        t += 20;
        clock.mono = t0 + t;
        agent.port.onmessage?.({ data: new Float32Array(320).fill(level("agent", frameStart)) });
        caller.port.onmessage?.({ data: new Float32Array(320).fill(level("caller", frameStart)) });
        await Promise.resolve();
      }
      await settle();
    },
  };
}

/** The fast model's pending requests for one side, oldest first. */
export const fastOpen = (side: "agent" | "caller") => reqs.filter((r) => r.gen === gen.now && !r.check && !r.done && r.side === side);
/** Lands the oldest open fast-model request of that side with this text. */
export async function land(side: "agent" | "caller", text: string) {
  const r = fastOpen(side)[0];
  if (!r) throw new Error(`no open ${side} request`);
  r.ok({ side, model: "fast", text, confidence: 0.9, elapsedMs: 300 });
  await settle();
}
export const checksOpen = () => reqs.filter((r) => r.gen === gen.now && r.check && !r.done);
export const line = (key: string) => useLive.getState().lines.find((l) => l.key === key);
export const copilotLine = (key: string) => useCopilot.getState().lines.find((l) => l.key === key);
