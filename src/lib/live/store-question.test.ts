import { test } from "node:test";
import assert from "node:assert/strict";

/*
  C12 (his "Build C12", 23 Nov 2026), the live store: what checkLine sends to the engine when the copilot names the
  agent's question, against a stand-in engine (independent check of C12, finding 6: no test drove this path before).
  The answer's and the question's audio are put where the store holds them, as if both lines had just been heard.
*/
type EngineCall = { params: URLSearchParams; samples: number; ok: (body: unknown) => void; fail: (status: number) => void };
const calls: EngineCall[] = [];
globalThis.fetch = ((url: string, init: { body: ArrayBuffer; signal?: AbortSignal }) =>
  new Promise((resolve, reject) => {
    calls.push({
      params: new URL(url, "http://127.0.0.1:8765").searchParams,
      samples: (init.body.byteLength - 44) / 2,
      ok: (body) => resolve({ ok: true, json: async () => body }),
      fail: (status) => resolve({ ok: false, status, json: async () => ({}) }),
    });
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;

const { heldForTests, useLive } = await import("./store");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const T = 1_700_000_000_000;
const QUESTION = "Can I have your full name, please?";
const WHOLE = `${QUESTION} Sam Miller.`;
const SAM: [string, number][] = [
  [" Can", 0.9],
  [" I", 0.95],
  [" have", 0.9],
  [" your", 0.9],
  [" full", 0.9],
  [" name", 0.9],
  [",", 0.8],
  [" please", 0.9],
  ["?", 0.7],
  [" Sam", 0.6],
  [" Miller", 0.7],
  [".", 0.9],
];

/** His question from 8 s to 10 s, the caller's answer from 11 s, both held; the engine has a check model with word scores. */
function heard(health: Record<string, unknown> = { wordScores: true }) {
  calls.length = 0;
  const line = (key: string, side: "agent" | "caller", text: string, start: number, end: number, seq: number) => ({
    key,
    callId: "CA-store",
    seq,
    side,
    text,
    startedAt: start,
    startedAtEpoch: T + start,
    endedAtEpoch: T + end,
    availableAtEpoch: T + end + 500,
    delay: 0.5,
    confidence: 0.9,
  });
  useLive.setState({
    health: { engine: "axentra-local", ready: true, check: true, ...health },
    replaying: false,
    lines: [line("agent-1", "agent", QUESTION, 8_000, 10_000, 1), line("caller-1", "caller", "Sam Miller.", 11_000, 12_500, 2)],
  });
  heldForTests.recentAudio.clear();
  heldForTests.pending.clear();
  heldForTests.recentAudio.set("agent-1", new Float32Array(32_000).fill(0.1));
  heldForTests.recentAudio.set("caller-1", new Float32Array(24_000).fill(0.2));
}
const answer = () => useLive.getState().lines.find((l) => l.key === "caller-1")!;

test("with his question named: one request for his question, the real pause and the answer; the answer is cut out", async () => {
  heard();
  assert.equal(useLive.getState().checkLine("caller-1", false, "agent-1"), "started");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.get("check"), "1");
  assert.equal(calls[0].params.get("words"), "1");
  // 1 s between his question's last voiced frame and the answer's audio, less the 0.2 s tail his phrase keeps.
  assert.equal(calls[0].samples, 32_000 + Math.round(0.8 * 16_000) + 24_000);
  assert.equal(answer().checking, true);
  calls[0].ok({ side: "caller", model: "check", text: WHOLE, confidence: 0.86, elapsedMs: 900, words: SAM, looped: false });
  await settle();
  const l = answer();
  assert.equal(l.text, "Sam Miller.");
  assert.equal(l.confidence, 0.73);
  assert.equal(l.checking, false);
  assert.deepEqual(l.withQuestion, { outcome: "used", question: "agent-1", pause: 0.8, whole: WHOLE, wholeConfidence: 0.86, ratio: 1.001 });
  // His question's audio stays held for a later answer; the answer's goes.
  assert.ok(heldForTests.recentAudio.has("agent-1") && !heldForTests.recentAudio.has("caller-1"));
});

test("only his question came back: the answer alone, sent as today's check sends it", async () => {
  heard();
  useLive.getState().checkLine("caller-1", false, "agent-1");
  calls[0].ok({ side: "caller", model: "check", text: QUESTION, confidence: 0.9, elapsedMs: 900, words: SAM.slice(0, 9), looped: false });
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.get("check"), "1");
  assert.equal(calls[1].params.get("words"), null);
  assert.equal(calls[1].samples, 24_000);
  calls[1].ok({ side: "caller", model: "check", text: "Sam Miller.", confidence: 0.81, elapsedMs: 700 });
  await settle();
  assert.equal(answer().text, "Sam Miller.");
  assert.equal(answer().confidence, 0.81);
  assert.deepEqual(answer().withQuestion, { outcome: "alone", question: "agent-1", pause: 0.8, why: "only-question", whole: QUESTION });
});

test("the call ends between the two requests: the answer isn't sent again on its own", async () => {
  heard();
  useLive.getState().checkLine("caller-1", false, "agent-1");
  // Any new call or replay ends this one's checks: a replay starts and stops.
  useLive.getState().replay([], 60_000);
  useLive.getState().stopReplay();
  calls[0].ok({ side: "caller", model: "check", text: QUESTION, confidence: 0.9, elapsedMs: 900, words: SAM.slice(0, 9), looped: false });
  await settle();
  assert.equal(calls.length, 1, "independent check of C12, finding 3: no request after the call ended");
});

test("a phrase said between his question and the answer still with the fast model: today's check, the question not sent", async () => {
  heard();
  // His "Take your time." at 10.2 s, still being written down when the answer is checked.
  heldForTests.pending.set("agent-2", { startedAtEpoch: T + 10_200 });
  useLive.getState().checkLine("caller-1", false, "agent-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.get("words"), null);
  assert.equal(calls[0].samples, 24_000);
  calls[0].ok({ side: "caller", model: "check", text: "Sam Miller.", confidence: 0.81, elapsedMs: 700 });
  await settle();
  assert.deepEqual(answer().withQuestion, { outcome: "not-sent", question: "agent-1", why: "unsettled" });
  assert.equal(answer().text, "Sam Miller.");
});

test("phrases still with the fast model that began after the answer, or the two lines themselves, don't stop the question", async () => {
  heard();
  heldForTests.pending.set("caller-2", { startedAtEpoch: T + 13_000 });
  heldForTests.pending.set("agent-1", { startedAtEpoch: T + 8_000 });
  heldForTests.pending.set("caller-1", { startedAtEpoch: T + 11_000 });
  useLive.getState().checkLine("caller-1", false, "agent-1");
  assert.equal(calls[0].params.get("words"), "1");
});

test("an engine without word scores, or no question named: today's check exactly", async () => {
  for (const [health, question] of [
    [{}, "agent-1"],
    [{ wordScores: true }, undefined],
  ] as const) {
    heard(health);
    useLive.getState().checkLine("caller-1", false, question);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.get("words"), null);
    assert.equal(calls[0].samples, 24_000);
    calls[0].ok({ side: "caller", model: "check", text: "Sam Miller.", confidence: 0.81, elapsedMs: 700 });
    await settle();
    assert.deepEqual(answer().withQuestion, question ? { outcome: "not-sent", question, why: "no-scores" } : undefined);
  }
});

test("a failed request fails the check, as today, and says it was asked with his question", async () => {
  heard();
  useLive.getState().checkLine("caller-1", false, "agent-1");
  calls[0].fail(503);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(answer().checkFailed, true);
  assert.deepEqual(answer().withQuestion, { outcome: "failed", question: "agent-1", pause: 0.8 });
});
