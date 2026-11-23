import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOpen, land, line, settle, startLiveCall, useLive } from "./live-call-fakes";

/*
  C12, the store end to end (check of the C12 fixes, 23 Nov): what goes to the check model when something was said
  between his question and the answer and isn't on the console yet (still being said, or still with the fast model).
  Timeline, ms since capture began:
    agent  a1  500-2500    greeting                -> agent-1
    caller c1  3500-9000   the problem             -> caller-1 (checked alone, released)
    agent  a2  11500-13500 name question           -> agent-2
    agent  a3  14200-15000 "Take your time."       -> agent-3 (in between), when present
    caller c2  15600-16600 "Sam Miller."           -> caller-2 (the answer; its audio starts at 15360 with pre-roll)
*/
const Q = "First, can I have your full name, please?";
const PROBLEM = "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.";
const WORDS: [string, number][] = [
  [" First", 0.9], [",", 0.9], [" can", 0.9], [" I", 0.9], [" have", 0.9], [" your", 0.9], [" full", 0.9], [" name", 0.9], [",", 0.9], [" please", 0.9], ["?", 0.9],
  [" Sam", 0.6], [" Miller", 0.7], [".", 0.9],
];

async function toProblem(sid: string) {
  const c = await startLiveCall(sid);
  c.say("agent", 500, 2500);
  c.say("caller", 3500, 9000);
  await c.until(3200);
  await land("agent", "Thank you for calling Sunlake. How can I help you today?");
  await c.until(9700);
  await land("caller", PROBLEM);
  checksOpen().find((r) => r.side === "caller")!.ok({ side: "caller", model: "check", text: PROBLEM, confidence: 0.9, elapsedMs: 900 });
  await settle();
  return c;
}
const answerCheck = () => checksOpen().filter((r) => r.side === "caller").at(-1);
async function within(c: { handlers: Record<string, (...a: unknown[]) => void> }, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    c.handlers.disconnect();
    await settle();
  }
}

test("control: nothing said between; the answer lands while awaited -> one words=1 request with the question in front", async () => {
  const c = await toProblem("CA-ctl");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("caller", 15600, 16600);
    await c.until(14200);
    await land("agent", Q);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    const r = answerCheck()!;
    assert.equal(r.words, true, "sent with the question in front");
    r.ok({ side: "caller", model: "check", text: `${Q} Sam Miller.`, confidence: 0.85, elapsedMs: 900, words: WORDS, looped: false });
    await settle();
    assert.equal(line("caller-2")!.withQuestion?.outcome, "used");
  });
});

test("R1 (c) arrival path: 'Take your time.' still with the fast model when the answer lands -> unsettled, answer alone", async () => {
  const c = await toProblem("CA-c");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 15000);
    c.say("caller", 15600, 16600);
    await c.until(14200);
    await land("agent", Q);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    const r = answerCheck()!;
    assert.equal(r.words, false, "not sent with the question in front");
    r.ok({ side: "caller", model: "check", text: "Sam Miller.", confidence: 0.81, elapsedMs: 700 });
    await settle();
    assert.deepEqual(line("caller-2")!.withQuestion, { outcome: "not-sent", question: "agent-2", why: "unsettled" });
  });
});

test("R1 (a) late path: the answer lands before the question; the question lands with a3 queued behind it -> unsettled", async () => {
  const c = await toProblem("CA-a");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 15000);
    c.say("caller", 15600, 16600);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck(), undefined, "nothing awaited yet: no check");
    await land("agent", Q);
    const r = answerCheck()!;
    assert.ok(r, "the question landed: the answer is checked");
    assert.equal(r.words, false, "not sent with the question in front");
  });
});

test("R1 late path control: the answer lands before the question, nothing in between -> the question is used", async () => {
  const c = await toProblem("CA-a0");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("caller", 15600, 16600);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    await land("agent", Q);
    assert.equal(answerCheck()!.words, true, "sent with the question in front (its own pending entry is excluded)");
  });
});

test("R1 still being said: a3 talks on past the answer's landing -> unsettled through speakingSince", async () => {
  const c = await toProblem("CA-s");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 19000);
    c.say("caller", 15600, 16600);
    await c.until(14200);
    await land("agent", Q);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck()!.words, false, "not sent with the question in front");
  });
});

test("R1 (b) back-to-back name and address questions, one answer lands first -> unsettled (address question still queued)", async () => {
  const c = await toProblem("CA-b");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 16200);
    c.say("caller", 16800, 19000);
    await c.until(19700);
    await land("caller", "Sam Miller, Hill Road, in Dallas.");
    await land("agent", Q);
    assert.equal(answerCheck()!.words, false, "the name question is not put in front while the address question is still queued");
  });
});

test("boundary through the real segmenter: his phrase starting with the answer doesn't count; one frame earlier does", async () => {
  for (const [start, words] of [[15600, true], [15580, false]] as const) {
    const c = await toProblem(`CA-edge-${start}`);
    await within(c, async () => {
      c.say("agent", 11500, 13500);
      c.say("agent", start, 16400);
      c.say("caller", 15600, 16600);
      await c.until(14200);
      await land("agent", Q);
      await c.until(17300);
      await land("caller", "Sam Miller.");
      assert.equal(answerCheck()!.words, words, `his phrase from ${start} ms, the caller's from 15600 ms`);
    });
  }
});

test("deliberate choice: a3 dropped as too short (0.2 s) -> doesn't count, the question is used", async () => {
  const c = await toProblem("CA-short");
  await within(c, async () => {
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 14400);
    c.say("caller", 15600, 16600);
    await c.until(14200);
    await land("agent", Q);
    await c.until(17300);
    assert.equal(useLive.getState().dropped.agent.short, 1);
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck()!.words, true);
  });
});

test("deliberate choice, timing: a3 heard as nothing counts while still pending, not once dropped", async () => {
  for (const before of [false, true]) {
    const c = await toProblem(`CA-empty-${before}`);
    await within(c, async () => {
      c.say("agent", 11500, 13500);
      c.say("agent", 14200, 15000);
      c.say("caller", 15600, 16600);
      await c.until(14200);
      await land("agent", Q);
      await c.until(17300);
      if (before) await land("agent", "");
      await land("caller", "Sam Miller.");
      assert.equal(answerCheck()!.words, before, before ? "dropped first: used" : "still pending: unsettled");
    });
  }
});
