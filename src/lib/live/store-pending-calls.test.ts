import { test } from "node:test";
import assert from "node:assert/strict";
import { audio, checksOpen, fastOpen, heldForTests, land, line, reqs, settle, startLiveCall, useLive } from "./live-call-fakes";

/*
  C12, the store's list of phrases still with the fast model across calls (check of the C12 fixes, 23 Nov): keys shared
  by two calls, a phrase of an earlier call cut by its capture's flush after a new call started, and the replay path.
*/
const Q = "First, can I have your full name, please?";
const PROBLEM = "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.";

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

test("same key across calls: call A's agent-3 finishing during call B must not clear B's agent-3, so B's answer stays unsettled", async () => {
  // Call A: his question, then "Take your time." (agent-3) still with the fast model when the call ends.
  const a = await toProblem("CA-A");
  a.say("agent", 11500, 13500);
  a.say("agent", 14200, 15000);
  await a.until(14200);
  await land("agent", Q);
  await a.until(15700);
  const aReq = fastOpen("agent")[0];
  assert.ok(aReq);
  a.handlers.disconnect();
  await settle();
  // Call B, same shape: its own agent-3 is with the fast model when the answer lands.
  const b = await toProblem("CA-B");
  try {
    b.say("agent", 11500, 13500);
    b.say("agent", 14200, 15000);
    b.say("caller", 15600, 16600);
    await b.until(14200);
    await land("agent", Q);
    await b.until(17300);
    const bEntry = heldForTests.pending.get("agent-3");
    // A's agent-3 recognition finishes now, during B.
    aReq.ok({ side: "agent", model: "fast", text: "Take your time.", confidence: 0.9, elapsedMs: 300 });
    await settle();
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck()!.words, false, "B's answer is not sent with the question in front");
    assert.equal(heldForTests.pending.get("agent-3"), bEntry, "the guard kept B's own entry");
    assert.equal(line("agent-3"), undefined, "A's late line doesn't land in B");
  } finally {
    b.handlers.disconnect();
    await settle();
  }
});

test("a phrase of call A cut by the capture's flush after call B started: a stale entry from A's past, which doesn't block B", async () => {
  const a = await startLiveCall("CA-A2");
  a.say("agent", 500, 2500);
  // He is still talking when the call ends: the capture's flush (after its 1 s wait) cuts this phrase.
  a.say("agent", 3500, 60_000);
  await a.until(3200);
  await land("agent", "Thank you for calling Sunlake. How can I help you today?");
  await a.until(5000);
  audio.holdFlush = true;
  a.handlers.disconnect();
  await settle();
  // B starts at once, within A's capture's 1 s flush wait.
  const b = await toProblem("CA-B2");
  audio.holdFlush = false;
  try {
    b.say("agent", 11500, 13500);
    b.say("caller", 15600, 16600);
    await b.until(14200);
    await land("agent", Q);
    await b.until(17300);
    // Wait (real time) for A's close(): its segmenter flush emits A's cut phrase into A's old sink.
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    const stale = [...heldForTests.pending.entries()].filter(([k]) => k === "agent-2");
    // B's question line is agent-2 too: the stale entry carries B's question key. B's answer lands now.
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck()!.words, true, "the stale entry (before B's question, and B's question key) doesn't block B");
    assert.equal(stale.length, 1, "A's cut phrase (agent-2) was in pending during B, as a stale entry");
    assert.ok(stale[0][1].startedAtEpoch < b.epochAt(0), "its start is before B even began");
  } finally {
    b.handlers.disconnect();
    await settle();
  }
});

test("the replay path: no pending entries, no checks; a live call after it uses the question normally", async () => {
  useLive.getState().replay(
    [
      { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?" },
      { side: "caller", text: PROBLEM },
      { side: "agent", text: Q },
      { side: "agent", text: "Take your time." },
      { side: "caller", text: "Sam Miller." },
    ],
    50
  );
  const before = reqs.length;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    assert.equal(heldForTests.pending.size, 0, "a replay never adds to pending");
  }
  assert.equal(reqs.length, before, "a replay sends nothing to the engine");
  assert.equal(useLive.getState().lines.length, 5);
  const c = await toProblem("CA-after-replay");
  try {
    c.say("agent", 11500, 13500);
    c.say("caller", 15600, 16600);
    await c.until(14200);
    await land("agent", Q);
    await c.until(17300);
    await land("caller", "Sam Miller.");
    assert.equal(answerCheck()!.words, true);
  } finally {
    c.handlers.disconnect();
    await settle();
  }
});
