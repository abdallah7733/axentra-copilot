import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";
import { useCopilot } from "./copilot-store";
import { liveEvents, useLive } from "./store";

const T0 = Date.UTC(2026, 9, 11, 21);
const line = (seq: number, key: string, side: "caller" | "agent", text: string, startedAt: number): TranscriptEvent => ({
  callId: "CA-store",
  seq,
  key,
  side,
  text,
  startedAt: T0 + startedAt,
  endedAt: T0 + startedAt + 2000,
  final: true,
  confidence: 0.9,
});
const emit = (l: TranscriptEvent) => liveEvents.emit({ type: "line", line: l });

test("a caller answer that arrives before the agent's question still gets its check, once (review 12 Oct §9)", () => {
  const asked: string[] = [];
  let audio = true;
  useLive.setState({ checkLine: (key) => (asked.push(key), audio ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-store", at: T0 });

  emit(line(1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0));
  const opening = line(2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000);
  emit(opening);
  assert.deepEqual(asked, ["c1"], "no problem heard yet: the opening line is checked");
  assert.equal(useCopilot.getState().lines.find((l) => l.key === "c1")?.checking, true);
  emit({ ...opening, firstHeard: "Hello. I need help with order 427. The table came yesterday, and the screen is cracked." });
  assert.equal(useCopilot.getState().view.intent?.id, "damaged");

  // The name answer is transcribed before the agent's question.
  const name = line(4, "c2", "caller", "Sam Miller.", 14_000);
  emit(name);
  assert.deepEqual(asked, ["c1"], "nothing asked for the name yet, as far as the console knows");
  emit(line(3, "a2", "agent", "First, can I have your full name, please?", 11_000));
  assert.deepEqual(asked, ["c1", "c2"], "the question arrived: the answer before it gets its check");
  assert.equal(useCopilot.getState().view.verification.factors[0].state, "asking", "held back while it is checked");

  // The checked result, then the same event again: never a second check.
  emit({ ...name, firstHeard: "Sam Miller. Sam Miller." });
  emit({ ...name, firstHeard: "Sam Miller. Sam Miller." });
  assert.deepEqual(asked, ["c1", "c2"]);
  assert.equal(useCopilot.getState().view.verification.factors[0].state, "ok");

  // No audio held for the address answer: it is used as heard, and not asked for again.
  audio = false;
  emit(line(5, "a3", "agent", "Thank you. And the street and city for the delivery?", 18_000));
  emit(line(6, "c3", "caller", "Hill Road, in Dallas.", 21_000));
  emit(line(7, "a4", "agent", "Thank you, Sam.", 25_000));
  assert.deepEqual(asked, ["c1", "c2", "c3"]);
  assert.equal(useCopilot.getState().view.verification.verified, true);
  liveEvents.emit({ type: "cleared" });
});

test("an agent line about the chosen outcome with no approval heard in it gets the second check, then approves (call 7 review)", () => {
  const asked: string[] = [];
  // Caller lines are used as heard here; agent lines go to the check.
  useLive.setState({ checkLine: (key) => (asked.push(key), key.startsWith("a") ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-store", at: T0 });
  const said: [string, "caller" | "agent", string][] = [
    ["a1", "agent", "Thank you for calling Sunlake. How can I help you today?"],
    ["c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked."],
    ["a2", "agent", "First, can I have your full name, please?"],
    ["c2", "caller", "Sam Miller."],
    ["a3", "agent", "Thank you. And the street and city for the delivery?"],
    ["c3", "caller", "Hill Road, in Dallas."],
    ["a4", "agent", "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?"],
    ["c4", "caller", "Yes, only the screen."],
    ["a5", "agent", "You can have either. A new tablet ships today at no cost, or a full refund. Which do you prefer?"],
    ["c5", "caller", "The refund, please."],
  ];
  said.forEach(([key, side, text], i) => emit(line(i + 1, key, side, text, i * 5000)));
  assert.equal(useCopilot.getState().view.recommendation?.approval.state, "awaiting");
  assert.ok(!asked.some((k) => k.startsWith("a")), "no agent line checked before the outcome waits for approval");

  const misheard = line(11, "a6", "agent", "offset a full refund of $329 to your visa ending to 208", 55_000);
  emit(misheard);
  assert.ok(asked.includes("a6"));
  assert.equal(useCopilot.getState().lines.find((l) => l.key === "a6")?.checking, true, "held back while it is checked");
  assert.equal(useCopilot.getState().view.recommendation?.approval.state, "awaiting");

  emit({ ...misheard, text: "I've set up a full refund of $329 to your Visa ending 2208.", firstHeard: misheard.text });
  const approval = useCopilot.getState().view.recommendation?.approval;
  assert.equal(approval?.state, "approved");
  assert.equal(approval?.via, "call");
  assert.equal(asked.filter((k) => k === "a6").length, 1, "checked once");
  liveEvents.emit({ type: "cleared" });
});
