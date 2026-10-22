import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import { agentCommits, safetyWords } from "./signals";
import { findAffirmed } from "./text";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Call 13 review (18 Oct 2026): on f629e71 a negated line could approve on the call and could tick a term.
  "won't", "can't", "haven't" and a "not" more than three words back weren't read as negations, so
  "It won't ship today." approved the replacement and "We haven't done the refund yet." approved the refund
  (only before any panel press, once ready to approve). Terms read only the first match in the joined text, so
  "There's no return label." blocked a correct label line said after it, and "ships tomorrow" ticked "Ships today".
*/

const NOW = Date.UTC(2026, 8, 27, 12);
type Line = { side: "caller" | "agent"; text: string };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-c13-negation",
    seq: i + 1,
    key: `t${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: 0.9,
  }));
// Script v2 to the offer (the order is read back on line 8), then the caller's choice as line 11.
const upToChoice = (choice: "replacement" | "refund"): Line[] => [
  ...scriptV2.filter((l) => l.n <= 10).map((l) => ({ side: l.side, text: l.text })),
  { side: "caller", text: choice === "replacement" ? "A new one, please." : "A refund, please." },
];
// Approve in the panel 4 s after the choice line starts, before the agent's lines.
const PRESS: AgentAction = { type: "approve", at: NOW - 600_000 + 10 * 5000 + 4000 };
const run = (choice: "replacement" | "refund", said: string[], press: boolean): CopilotView =>
  analyze(sunlake, events([...upToChoice(choice), ...said.map((text) => ({ side: "agent" as const, text }))]), press ? [PRESS] : [], NOW);
const terms = (v: CopilotView) => v.documentation.find((d) => d.label === "Terms heard")?.value ?? "";

test("a negated approval word is not an approval, with or without a contraction, however far back the negation is", () => {
  for (const line of [
    "It won't ship today.",
    "It won’t ship today.",
    "It can't ship today.",
    "We will not be able to ship today.",
    "The tablet doesn't ship today.",
    "We haven't done the refund yet.",
    "That won't be done until Monday.",
    "I'm unable to say it ships today.",
  ]) {
    assert.equal(agentCommits(line), null, line);
  }
  // Unchanged: the scripted close-outs and the existing approval phrases still approve.
  assert.equal(agentCommits("Done. The new tablet ships today. You'll get an email with a free return label for the damaged one."), "done");
  assert.equal(agentCommits("The new tablet ships today."), "ships today");
  assert.equal(agentCommits("I've set up a full refund of $329.00 to your Visa ending 2208."), "i've set up");
  assert.equal(agentCommits("All set."), "all set");
  // Known limit, unchanged: a negation in an earlier sentence still blocks the approval (fail-closed; the panel press is needed).
  assert.equal(agentCommits("No problem. Done."), null);
});

test("findAffirmed reads sentence by sentence and returns the first affirmed match", () => {
  assert.deepEqual(findAffirmed("There's no return label. You'll get a free return label.", /\blabel\b/), { phrase: "label", negated: false });
  assert.deepEqual(findAffirmed("I won't send a return label.", /\blabel\b/), { phrase: "label", negated: true });
  assert.deepEqual(findAffirmed("It costs $329.00 and ships today.", /\bships? (out )?today\b/), { phrase: "ships today", negated: false });
  assert.equal(findAffirmed("It ships tomorrow.", /\bships? (out )?today\b/), null);
});

test("on the call, before any press: a negated line leaves the approval waiting", () => {
  for (const line of ["It won't ship today.", "It can't ship today.", "We will not be able to ship today.", "That won't be done until Monday."]) {
    const a = run("replacement", [line], false).recommendation!.approval;
    assert.equal(a.state, "awaiting", line);
  }
  for (const line of ["We haven't done the refund yet.", "That won't be done until Monday."]) {
    assert.equal(run("refund", [line], false).recommendation!.approval.state, "awaiting", line);
  }
  // Unchanged: the scripted close-out still approves on the call.
  const ok = run("replacement", ["Done. The new tablet ships today. You'll get an email with a free return label for the damaged one."], false);
  assert.equal(ok.recommendation!.approval.state, "approved");
  assert.equal(ok.recommendation!.approval.via, "call");
});

test("terms heard: a refusal or another timing doesn't tick a term, and a correct line after a negated one does", () => {
  assert.match(terms(run("replacement", ["The tablet ships tomorrow."], true)), /Ships today: not heard yet/);
  assert.match(terms(run("replacement", ["It ships within one business day."], true)), /Ships today: not heard yet/);
  assert.match(terms(run("replacement", ["I won't send a return label."], true)), /Return label: not heard yet/);
  assert.match(terms(run("replacement", ["I will not send you a free return label."], true)), /Return label: not heard yet/);
  assert.match(terms(run("refund", ["I haven't set up a refund of 329 to your Visa ending 2208."], true)), /^Refund amount: not heard yet; Card it goes to: not heard yet/);

  const recovered = run("replacement", ["There's no return label.", "You'll get an email with a free return label for the damaged one."], true);
  assert.match(terms(recovered), /Return label: "You'll get an email with a free return label for the damaged one\."/, "card A11's 'say it once more' now works");
  const corrected = run("replacement", ["It ships tomorrow.", "Sorry, it ships today."], true);
  assert.match(terms(corrected), /^Ships today: "Sorry, it ships today\."/, "the quote is the line that said today");

  const split = run("replacement", ["The new tablet ships", "today. You'll get an email with a free return label for the damaged one."], true);
  assert.match(terms(split), /^Ships today: "today\. You'll get an email/, "a term split across lines is quoted by the line that completed it");

  const full = run("replacement", ["Done. The new tablet ships today. You'll get an email with a free return label for the damaged one."], true);
  assert.equal(full.steps.find((s) => s.id === "docs")?.detail, "Terms heard on the call");
});

test("caller-side rules keep the shared negation list: a caller's 'can't' doesn't hide a safety word", () => {
  assert.deepEqual(safetyWords("I can't stand the burning smell."), ["burning smell"]);
});
