import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";
import { useCopilot } from "./copilot-store";
import { liveEvents, useLive } from "./store";

/* The 21 Oct stage-call fixes as the console runs them: lines arrive one at a time and checks come back later. */

const T0 = Date.UTC(2026, 9, 21, 15);
const line = (callId: string, seq: number, key: string, side: "caller" | "agent", text: string, startedAt: number): TranscriptEvent => ({
  callId,
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
const name = () => useCopilot.getState().view.verification.factors[0];

test("the agent types the name while the check runs; the late result and the next call don't change it", () => {
  const asked: string[] = [];
  useLive.setState({ checkLine: (key) => (asked.push(key), key === "c2" ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-1", at: T0 });
  emit(line("CA-1", 1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0));
  emit(line("CA-1", 2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000));
  emit(line("CA-1", 3, "a2", "agent", "First, can I have your full name, please?", 11_000));
  const answer = line("CA-1", 4, "c2", "caller", "Sen nilir.", 14_000);
  emit(answer);
  assert.ok(asked.includes("c2"));
  assert.deepEqual(useCopilot.getState().view.nameEntry, { key: "c2", checking: true, readBack: "off" }, "the field is ready while the check runs");

  useCopilot.getState().correct("c2", "Sam Miller");
  assert.equal(name().state, "ok");
  assert.equal(name().method, "typed by the agent");

  emit({ ...answer, text: "Sammílis.", firstHeard: "Sen nilir." });
  assert.equal(name().state, "ok", "the check result can't overwrite what the agent typed");
  assert.equal(name().evidence?.typedFrom, "Sammílis.");

  // A new call starts clean, even with a line under the same key.
  liveEvents.emit({ type: "call-started", callId: "CA-2", at: T0 + 300_000 });
  assert.equal(useCopilot.getState().actions.length, 0);
  emit(line("CA-2", 1, "a2", "agent", "First, can I have your full name, please?", 311_000));
  emit({ ...line("CA-2", 2, "c2", "caller", "Sammílis.", 314_000), firstHeard: "Sen nilir." });
  assert.notEqual(name().state, "ok", "the previous call's typing doesn't carry over");
  liveEvents.emit({ type: "cleared" });
});

test("after approval, a terms line goes to the check while a term is missing, and not once all are heard", () => {
  const asked: string[] = [];
  useLive.setState({ checkLine: (key) => (asked.push(key), key.startsWith("a") ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-3", at: T0 });
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
  said.forEach(([key, side, text], i) => emit(line("CA-3", i + 1, key, side, text, i * 5000)));
  useCopilot.getState().approve();
  assert.equal(useCopilot.getState().view.recommendation?.approval.state, "approved");

  // Approved in the panel; the epoch clock is now, so the terms lines start after it.
  const now = Date.now() - T0;
  const setUp = line("CA-3", 11, "a6", "agent", "I've set up a full refund of $329.00 to your Visa ending 2208.", now + 1000);
  emit(setUp);
  assert.ok(asked.includes("a6"), "other terms are still missing: checked too");
  // The engine can time out when checks queue up: the line then stands as first heard, its term still counted.
  emit({ ...setUp, checkFailed: true });
  assert.doesNotMatch(useCopilot.getState().view.steps.find((s) => s.id === "docs")?.detail ?? "", /refund amount and card/);
  const misheard = line("CA-3", 12, "a7", "agent", "It's issued when the carriers can't return.", now + 5000);
  emit(misheard);
  assert.ok(asked.includes("a7"), "a term is missing: the line is checked");
  emit({ ...misheard, text: "It's issued when the carrier scans the return.", firstHeard: misheard.text });
  emit(line("CA-3", 13, "a8", "agent", "It takes 3 to 5 business days to appear, and you'll get an email with a free return label.", now + 9000));
  assert.ok(!asked.includes("a8"), "this line completes the terms: not held back");
  const docs = useCopilot.getState().view.steps.find((s) => s.id === "docs");
  assert.equal(docs?.detail, "Terms heard on the call");
  assert.equal(asked.filter((k) => k === "a7").length, 1, "checked once");
  liveEvents.emit({ type: "cleared" });
});

test("the stage card's short row 15 lines count as first heard while their checks run; a checked text replaces them", () => {
  const run = (sentences: string[]) => {
    const asked: string[] = [];
    useLive.setState({ checkLine: (key) => (asked.push(key), key.startsWith("a") ? "started" : "no-audio") });
    liveEvents.emit({ type: "call-started", callId: "CA-4", at: T0 });
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
    said.forEach(([key, side, text], i) => emit(line("CA-4", i + 1, key, side, text, i * 5000)));
    useCopilot.getState().approve();
    const now = Date.now() - T0;
    const lines = ["I've set up a full refund of $329.00 to your Visa ending 2208.", ...sentences].map((text, i) =>
      line("CA-4", 11 + i, `a${6 + i}`, "agent", text, now + 1000 + i * 2500)
    );
    lines.forEach(emit);
    return { asked, lines };
  };
  const docs = () => useCopilot.getState().view.steps.find((s) => s.id === "docs")?.detail;
  const row15 = ["The carrier will scan your return.", "The refund is issued at that scan.", "It takes 3 to 5 business days to appear.", "You'll get an email with a free return label."];

  const clean = run(row15);
  assert.equal(docs(), "Terms heard on the call", "heard as soon as the last line arrives, before any check comes back");
  assert.deepEqual(clean.asked.filter((k) => k.startsWith("a") && Number(k.slice(1)) >= 6), ["a6", "a7", "a8", "a9"], "the line that completes the terms isn't checked");
  liveEvents.emit({ type: "cleared" });

  // The first "scan" heard as "can't": the second one still counts.
  const cant = run(["The carrier can't return.", ...row15.slice(1)]);
  assert.equal(docs(), "Terms heard on the call");

  // The check of the second "scan" line comes back without it: the term is no longer heard.
  const [, , , second] = cant.lines;
  emit({ ...second, text: "The refund is issued at that.", firstHeard: second.text });
  assert.match(docs() ?? "", /^Not heard yet: when it's issued and how long it takes$/);
  liveEvents.emit({ type: "cleared" });
});

test("read-back as the console runs it: the caller's yes gets its check, and only the checked yes verifies", () => {
  const asked: string[] = [];
  useLive.setState({ checkLine: (key) => (asked.push(key), key.startsWith("c") ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-RB", at: T0 });
  emit(line("CA-RB", 1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0));
  emit(line("CA-RB", 2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000));
  emit(line("CA-RB", 3, "a2", "agent", "First, can I have your full name, please?", 11_000));
  const answer = line("CA-RB", 4, "c2", "caller", "Sen nilir.", 14_000);
  emit(answer);
  emit({ ...answer, text: "Sammílis.", firstHeard: "Sen nilir.", checked: true });
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "available");

  // Transcribed separately: here the caller's yes arrives before the agent's read-back line.
  const yes = line("CA-RB", 6, "c3", "caller", "Yes, that's right.", 21_000);
  emit(yes);
  emit(line("CA-RB", 5, "a3", "agent", "That's Sam Miller, is that right?", 17_500));
  assert.ok(asked.includes("c3"), "once the read-back is heard, the yes goes to the second check");
  assert.notEqual(name().state, "ok", "nothing verifies while the yes is being checked");

  emit({ ...yes, checked: true });
  assert.equal(name().state, "ok");
  assert.equal(name().method, "name read back by agent, confirmed by caller");
  assert.equal(name().answeredAt, T0 + 16_000, "timed from the end of the caller's answer");
  liveEvents.emit({ type: "cleared" });
});
