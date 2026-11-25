import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOpen, fastOpen, heldForTests, land, line, settle, startLiveCall } from "./live-call-fakes";

/*
  C12, the store's list of phrases still with the fast model (check of the C12 fixes, 23 Nov): which phrases are in it,
  with what start time (the time base), when they leave (landed, dropped, failed), and that a call's end clears it.
*/
const Q = "First, can I have your full name, please?";
const PROBLEM = "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.";
const rel = (c: { epochAt: (ms: number) => number }) =>
  [...heldForTests.pending.entries()].map(([k, v]) => [k, v.startedAtEpoch - c.epochAt(0)] as const).sort();

test("entries: one per phrase handed to the fast model, its start on the lines' own epoch clock; gone once landed", async () => {
  const c = await startLiveCall("CA-st1");
  try {
    c.say("agent", 500, 2500);
    c.say("caller", 3500, 9000);
    c.say("agent", 11500, 13500);
    c.say("agent", 14200, 15000);
    await c.until(3200);
    assert.deepEqual(rel(c), [["agent-1", 260]], "the greeting, from 500 ms less its 240 ms of pre-roll");
    await land("agent", "Thank you for calling Sunlake. How can I help you today?");
    assert.deepEqual(rel(c), [], "landed: gone");
    assert.equal(line("agent-1")!.startedAtEpoch, c.epochAt(260), "the line's start is the entry's start: one time base");
    await c.until(9700);
    await land("caller", PROBLEM);
    checksOpen().find((r) => r.side === "caller")!.ok({ side: "caller", model: "check", text: PROBLEM, confidence: 0.9, elapsedMs: 900 });
    await settle();
    await c.until(15700);
    assert.deepEqual(rel(c), [["agent-2", 11260], ["agent-3", 14100]], "two phrases with the fast model, in order");
    await land("agent", Q);
    assert.deepEqual(rel(c), [["agent-3", 14100]]);
    assert.equal(line("agent-2")!.startedAtEpoch, c.epochAt(11260));
  } finally {
    c.handlers.disconnect();
    await settle();
  }
});

test("entries leave when dropped as nothing heard, and when the fast model fails", async () => {
  const c = await startLiveCall("CA-st2");
  try {
    c.say("agent", 500, 2500);
    c.say("agent", 3500, 4500);
    await c.until(5200);
    assert.deepEqual(rel(c).map(([k]) => k), ["agent-1", "agent-2"]);
    await land("agent", "");
    assert.deepEqual(rel(c).map(([k]) => k), ["agent-2"], "dropped (empty): gone");
    fastOpen("agent")[0].fail(503);
    await settle();
    assert.deepEqual(rel(c), [], "failed: gone");
  } finally {
    c.handlers.disconnect();
    await settle();
  }
});

test("the call's end clears pending; the old call's recognition finishing later changes nothing", async () => {
  const c = await startLiveCall("CA-st3");
  c.say("agent", 500, 2500);
  await c.until(3200);
  const old = fastOpen("agent")[0];
  assert.equal(heldForTests.pending.size, 1);
  c.handlers.disconnect();
  await settle();
  assert.equal(heldForTests.pending.size, 0);
  old.ok({ side: "agent", model: "fast", text: "Hello.", confidence: 0.9, elapsedMs: 300 });
  await settle();
  assert.equal(heldForTests.pending.size, 0);
  assert.equal(line("agent-1"), undefined);
});

test("growth: a fast model that never answers adds one entry per phrase, until the call ends", async () => {
  const c = await startLiveCall("CA-grow");
  for (let i = 0; i < 30; i++) c.say("agent", 500 + i * 1500, 1200 + i * 1500);
  await c.until(500 + 30 * 1500 + 700);
  assert.equal(fastOpen("agent").length, 1, "the side's queue waits behind the first request");
  assert.equal(heldForTests.pending.size, 30, "one entry per phrase handed over");
  c.handlers.disconnect();
  await settle();
  assert.equal(heldForTests.pending.size, 0);
});
