import { test } from "node:test";
import assert from "node:assert/strict";
import { checksOpen, clock, copilotLine, fireTimers, land, line, reqs, settle, startLiveCall } from "./live-call-fakes";
import { CHECK_TIMEOUT_MS } from "./engine";

/*
  C12, the store end to end (check of the C12 fixes, 23 Nov): the call ends between the two requests of a question check (a
  real endCall, through the Twilio call's "disconnect"), and the longest hold, timed on a simulated clock with a fake
  AbortSignal.timeout.
*/
const Q = "First, can I have your full name, please?";
const PROBLEM = "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.";
const ONLY_Q: [string, number][] = [
  [" First", 0.9], [",", 0.9], [" can", 0.9], [" I", 0.9], [" have", 0.9], [" your", 0.9], [" full", 0.9], [" name", 0.9], [",", 0.9], [" please", 0.9], ["?", 0.9],
];
let unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/** Up to the answer's check going out with his question in front (nothing said between). */
async function toAnswerCheck(sid: string) {
  const c = await startLiveCall(sid);
  c.say("agent", 500, 2500);
  c.say("caller", 3500, 9000);
  c.say("agent", 11500, 13500);
  c.say("caller", 15600, 16600);
  await c.until(3200);
  await land("agent", "Thank you for calling Sunlake. How can I help you today?");
  await c.until(9700);
  await land("caller", PROBLEM);
  checksOpen().find((r) => r.side === "caller")!.ok({ side: "caller", model: "check", text: PROBLEM, confidence: 0.9, elapsedMs: 900 });
  await settle();
  await c.until(14200);
  await land("agent", Q);
  await c.until(17300);
  await land("caller", "Sam Miller.");
  const first = checksOpen().filter((r) => r.side === "caller").at(-1)!;
  assert.equal(first.words, true, "the first request goes out normally, with his question in front, while the call is live");
  assert.equal(line("caller-2")!.checking, true);
  return { c, first };
}
const answerReqs = (after: number) => reqs.slice(after).filter((r) => r.check && r.side === "caller");

test("S3: the call ends between the two requests -> no second request; the line ends failed, not 'checking'", async () => {
  unhandled = [];
  const { c, first } = await toAnswerCheck("CA-s3");
  const n = reqs.length;
  c.handlers.disconnect();
  await settle();
  first.ok({ side: "caller", model: "check", text: Q, confidence: 0.9, elapsedMs: 900, words: ONLY_Q, looped: false });
  await settle();
  assert.equal(answerReqs(n).length, 0, "nothing sent after the call ended");
  const l = line("caller-2")!;
  assert.equal(l.checking, false);
  assert.equal(l.checkFailed, true);
  assert.equal(copilotLine("caller-2")?.checking, false, "the copilot isn't left holding it");
  assert.deepEqual(unhandled, [], "no unhandled rejection from the refused request");
});

test("S3: the same while live -> the second request (the answer alone) is sent and used", async () => {
  const { c, first } = await toAnswerCheck("CA-s3-live");
  const n = reqs.length;
  first.ok({ side: "caller", model: "check", text: Q, confidence: 0.9, elapsedMs: 900, words: ONLY_Q, looped: false });
  await settle();
  const second = answerReqs(n);
  assert.equal(second.length, 1);
  assert.equal(second[0].words, false);
  second[0].ok({ side: "caller", model: "check", text: "Sam Miller.", confidence: 0.81, elapsedMs: 700 });
  await settle();
  assert.equal(line("caller-2")!.withQuestion?.outcome, "alone");
  assert.equal(line("caller-2")!.checking, false);
  c.handlers.disconnect();
  await settle();
});

test("S3: the call ends and the first request then fails (503) -> nothing more, the line stays failed", async () => {
  unhandled = [];
  const { c, first } = await toAnswerCheck("CA-s3-503");
  const n = reqs.length;
  c.handlers.disconnect();
  await settle();
  first.fail(503);
  await settle();
  assert.equal(answerReqs(n).length, 0);
  assert.equal(line("caller-2")!.checkFailed, true);
  assert.equal(line("caller-2")!.checking, false);
  assert.deepEqual(unhandled, []);
});

test("S4: the longest hold is two requests, each with its own timeout: first answers unusable at 8.99 s, second times out", async () => {
  const { c, first } = await toAnswerCheck("CA-s4");
  const began = clock.mono;
  const n = reqs.length;
  clock.mono = began + 8990;
  first.ok({ side: "caller", model: "check", text: Q, confidence: 0.9, elapsedMs: 8900, words: ONLY_Q, looped: false });
  await settle();
  const second = answerReqs(n);
  assert.equal(second.length, 1, "asked again for the answer alone");
  clock.mono = began + 8990 + CHECK_TIMEOUT_MS - 1;
  fireTimers();
  await settle();
  assert.equal(line("caller-2")!.checking, true, "still held 1 ms before the second timeout");
  clock.mono = began + 8990 + CHECK_TIMEOUT_MS;
  fireTimers();
  await settle();
  const l = line("caller-2")!;
  assert.equal(l.checking, false);
  assert.equal(l.checkFailed, true);
  assert.equal(l.checkSeconds, 17.99);
  assert.ok(l.checkSeconds! <= (2 * CHECK_TIMEOUT_MS) / 1000);
  assert.deepEqual(l.withQuestion, { outcome: "failed", question: "agent-2", pause: 1.5 });
  c.handlers.disconnect();
  await settle();
});

test("S4: a first request that never answers fails at the one timeout, with no second request", async () => {
  const { c } = await toAnswerCheck("CA-s4b");
  const began = clock.mono;
  const n = reqs.length;
  clock.mono = began + CHECK_TIMEOUT_MS;
  fireTimers();
  await settle();
  assert.equal(answerReqs(n).length, 0);
  assert.equal(line("caller-2")!.checkSeconds, 9);
  assert.equal(line("caller-2")!.checkFailed, true);
  c.handlers.disconnect();
  await settle();
});
