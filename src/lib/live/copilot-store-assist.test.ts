import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";
import { ASSIST_TIMEOUT_MS, useCopilot } from "./copilot-store";
import { liveEvents, useLive } from "./store";
import { scriptV2 } from "./sunlake-data";

/*
  The local model's rewording in the store (Call 11 review, I-21 and I-26). The engine's /assist is
  mocked: it answers after `delay` ms with `answer(draft)`, or never (a timeout).
*/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  for (let i = 0; i < 10; i++) await sleep(10);
};
const T0 = Date.now() - 600_000;
let n = 0;
const line = (callId: string, side: "caller" | "agent", text: string, confidence = 0.9): TranscriptEvent => {
  n++;
  return { callId, seq: n, key: `k${n}`, side, text, startedAt: T0 + n * 5000, endedAt: T0 + n * 5000 + 3000, final: true, confidence };
};

let delay = 30;
let answer = (draft: string) => draft;
const asked: string[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const draft = String(body.messages?.[1]?.content ?? "").split("Draft reply:\n")[1] ?? "";
  asked.push(draft);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, delay);
    init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(init.signal!.reason)));
  });
  return new Response(JSON.stringify({ text: answer(draft), model: "mock", gpu: true, elapsedMs: delay, tokens: 1 }), { status: 200 });
}) as typeof fetch;

const start = (callId: string) => {
  useLive.setState({ health: { ready: true, assist: "local", assistReady: true }, checkLine: () => "no-audio" });
  liveEvents.emit({ type: "call-started", callId, at: Date.now() });
  asked.length = 0;
};
/** Script v2 to the name answer, heard unclearly: the panel asks the agent to confirm the name. */
const toUnclearName = (callId: string) => {
  for (const l of scriptV2.slice(0, 4)) liveEvents.emit({ type: "line", line: line(callId, l.side, l.text) });
  liveEvents.emit({ type: "line", line: line(callId, "caller", "Sam Miller.", 0.3) });
};

test("I-26: the suggestion time runs from when the suggestion appeared, not from the last transcript line", async () => {
  delay = 30;
  answer = (d) => d;
  start("CA-assist-1");
  toUnclearName("CA-assist-1");
  await settle();
  const n0 = useCopilot.getState().assistTimes.length;
  // The agent waits 700 ms, then presses Confirm: a new, neutral suggestion, with no new transcript line.
  await sleep(700);
  useCopilot.getState().confirm("name");
  await settle();
  const s = useCopilot.getState();
  assert.match(s.view.suggestedReply!.text, /email address on the order/);
  assert.equal(s.assistTimes.length, n0 + 1);
  const ms = s.assistTimes[n0];
  assert.ok(ms < 700, `the idle wait before the press must not count, got ${Math.round(ms)} ms`);
  assert.equal(s.worded?.seq, s.draftSeq, "the wording belongs to this appearance of the suggestion");
  assert.match(s.worded!.text, /email address/);
  liveEvents.emit({ type: "cleared" });
});

test("I-21: a suggestion with order facts or an outcome is never sent to the local model", async () => {
  delay = 1;
  answer = (d) => d;
  start("CA-assist-2");
  for (const l of scriptV2.slice(0, 11)) liveEvents.emit({ type: "line", line: line("CA-assist-2", l.side, l.text) });
  await settle();
  const s = useCopilot.getState();
  assert.equal(s.view.recommendation?.approval.state, "awaiting");
  assert.equal(s.view.suggestedReply?.rewordable, false);
  for (const draft of asked) assert.doesNotMatch(draft, /verified|order 427|refund|ships today|Done/, draft);
  assert.equal(s.worded, null);
  liveEvents.emit({ type: "cleared" });
});

test("I-26: a rejected rewording is recorded with its reason, and the rules wording stays", async () => {
  delay = 1;
  answer = (d) => `${d} Your replacement has been placed, Afzata.`;
  start("CA-assist-3");
  toUnclearName("CA-assist-3");
  await settle();
  const s = useCopilot.getState();
  assert.equal(s.worded, null);
  const last = s.assistLog[s.assistLog.length - 1];
  assert.equal(last.outcome, "rejected");
  assert.ok(last.reason, "a reason is kept");
  liveEvents.emit({ type: "cleared" });
});

test("I-26: a rewording for a suggestion that has since changed is never shown, even if the text comes back", async () => {
  delay = 150;
  answer = (d) => d.replace("Sorry,", "Apologies,");
  start("CA-assist-4");
  toUnclearName("CA-assist-4");
  await sleep(20);
  useCopilot.getState().confirm("name"); // the suggestion changes while the model works on the old one
  for (let i = 0; i < 40; i++) await sleep(10);
  const s = useCopilot.getState();
  assert.ok(s.assistLog.some((r) => r.outcome === "replaced"));
  assert.ok(!s.worded || s.worded.draft === s.view.suggestedReply?.text);
  liveEvents.emit({ type: "cleared" });
});

test("I-26: no answer within 4 s of the suggestion is recorded as a timeout, and the panel falls back", async () => {
  delay = ASSIST_TIMEOUT_MS + 2000;
  answer = (d) => d;
  start("CA-assist-5");
  toUnclearName("CA-assist-5");
  await sleep(ASSIST_TIMEOUT_MS + 300);
  const s = useCopilot.getState();
  assert.equal(s.assist, "fallback");
  assert.ok(s.assistLog.some((r) => r.outcome === "timeout"), JSON.stringify(s.assistLog));
  assert.equal(s.worded, null);
  liveEvents.emit({ type: "cleared" });
});
