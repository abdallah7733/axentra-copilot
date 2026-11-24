import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { saysNoName } from "./verification";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  The no-name fix (his "No-name fix in C12", 24 Nov 2026), as defined in the 23 Nov Mac timing check report: when an
  answer to the name question has no word that could be part of a name (only words like "it's", "for", "my", "husband"),
  the copilot asks again without counting an attempt; such an answer still can't verify anyone. The words that count are
  written down in verification.ts (NO_NAME_WORDS). It doesn't cover an answer heard as a wrong name (20 Nov), and it
  changes nothing for the street and city. Policy.noNameNotCounted, off unless the build sets it.
*/
const T = Date.UTC(2026, 10, 24, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; checked?: boolean; firstHeard?: string };
const timed = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-nn",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T + l.s,
    endedAt: T + l.e,
    final: true,
    confidence: 0.9,
    ...(l.checked ? { checked: true } : {}),
    ...(l.firstHeard ? { firstHeard: l.firstHeard } : {}),
  }));
// C12's five switches (as built for his Mac), with or without the no-name fix.
const pack = (noName: boolean): ClientPack => ({
  ...sunlake,
  policy: { ...sunlake.policy, agentConfirmsMatch: true, strictMatch: true, nameReadBack: true, addressReadBack: true, questionInCheck: true, noNameNotCounted: noName },
});
const run = (noName: boolean, lines: L[], now: number, actions: AgentAction[] = []) => analyze(pack(noName), timed(lines), actions, T + now);
const name = (v: CopilotView) => v.verification.factors.find((f) => f.id === "name")!;
const address = (v: CopilotView) => v.verification.factors.find((f) => f.id === "address")!;
const promptFor = (v: CopilotView, id: "name" | "address") => v.prompts.find((p) => p.target === id);
const failedAlert = (v: CopilotView) => v.alerts.find((a) => a.id === "verification-failed-name");

const OPEN: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. First, can I have your full name, please?", s: 10_000, e: 13_000 },
];
const answer = (text: string, s: number, extra: Partial<L> = {}): L => ({ side: "caller", text, s, e: s + 1500, checked: true, ...extra });
const ASK_AGAIN = (s: number): L => ({ side: "agent", text: "Sorry, could I have the full name on the account?", s, e: s + 2000 });
const HUSBAND = answer("It's for my husband.", 14_000);

test("the switch is off unless the build sets it", () => {
  assert.equal(sunlake.policy.noNameNotCounted, false);
});

test("the written words: an answer counts as no name only if every word is on the list", () => {
  for (const t of ["It's for my husband.", "It's for my husband's account.", "Um, it's under my wife's name.", "It's my mum's order.", "Order 427.", "It's for him, he placed the order."])
    assert.equal(saysNoName(t), true, t);
  for (const t of ["It's for my husband, Tom.", "Sam Miller.", "Miller.", "Tom Baker.", "It's for my husband, Sam Miller.", ""]) assert.equal(saysNoName(t), false, t);
});

test("today's C12 (switch off): \"It's for my husband.\" is a wrong name, attempt 1 of 2", () => {
  // Before the agent asks again, the panel shows the failed attempt.
  const v = run(false, [...OPEN, HUSBAND], 18_000);
  assert.equal(name(v).attempts, 1);
  assert.equal(name(v).state, "failed");
  assert.match(failedAlert(v)?.title ?? "", /not matched \(attempt 1 of 2\)/);
  assert.equal(name(run(false, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 19_000)).attempts, 1);
});

test("with the fix: asked again, no attempt counted, nothing to confirm", () => {
  assert.equal(name(run(true, [...OPEN, HUSBAND], 18_000)).confirmReason, "no-name", "before the agent asks again too");
  assert.equal(failedAlert(run(true, [...OPEN, HUSBAND], 18_000)), undefined);
  const v = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 19_000);
  assert.equal(name(v).attempts, 0);
  assert.equal(name(v).state, "confirm");
  assert.equal(name(v).confirmReason, "no-name");
  assert.equal(v.verification.locked, false);
  assert.equal(v.verification.attemptsLeft, 2);
  assert.equal(failedAlert(v), undefined);
  const p = promptFor(v, "name");
  assert.equal(p?.askAgain, true, "an Ask again card, with no Confirmed button");
  assert.equal(p?.text, `Ask for the full name once more. Heard "It's for my husband.": there's no name in it, so it isn't counted as a wrong answer, and it can't verify anyone.`);
});

test("with the fix: a Confirmed press on a no-name answer verifies nothing", () => {
  const v = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 20_000, [{ type: "confirm", target: "name", at: T + 19_000 }]);
  assert.notEqual(name(v).state, "ok");
  assert.equal(v.verification.verified, false);
  assert.equal(name(v).attempts, 0);
});

test("with the fix: the name said next is heard as usual, held for the agent's press", () => {
  const lines = [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("Sam Miller.", 19_000)];
  const held = run(true, lines, 22_000);
  assert.equal(name(held).state, "confirm");
  assert.equal(name(held).confirmReason, "match");
  assert.equal(name(held).attempts, 0);
  const pressed = run(true, lines, 24_000, [{ type: "confirm", target: "name", at: T + 23_000 }]);
  assert.equal(name(pressed).state, "ok");
  assert.equal(name(pressed).attempts, 0);
  assert.equal(name(pressed).confirmReason, undefined, "the no-name reason doesn't stay behind");
});

test("with the fix: two no-name answers count nothing; a wrong name after them still counts", () => {
  const twice = [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("It's my husband's account.", 19_000), ASK_AGAIN(21_500)];
  const v = run(true, twice, 24_000);
  assert.equal(name(v).attempts, 0);
  assert.equal(name(v).confirmReason, "no-name");
  assert.equal(v.verification.locked, false);
  const wrong = run(true, [...twice, answer("Tom Baker.", 24_000)], 28_000);
  assert.equal(name(wrong).attempts, 1);
  assert.equal(name(wrong).state, "failed");
});

test("with the fix: an answer with any other word is a wrong name, as before", () => {
  for (const text of ["It's for my husband, Tom.", "Tom Baker."]) {
    const v = run(true, [...OPEN, answer(text, 14_000)], 18_000);
    assert.equal(name(v).attempts, 1, text);
    assert.equal(name(v).state, "failed", text);
  }
});

test("with the fix: the record's name for someone else is asked again, as before", () => {
  const text = "It's for my husband, Sam Miller.";
  const before = run(false, [...OPEN, answer(text, 14_000), ASK_AGAIN(16_500)], 19_000);
  const after = run(true, [...OPEN, answer(text, 14_000), ASK_AGAIN(16_500)], 19_000);
  assert.equal(after.prompts.find((p) => p.target === "name")?.text, before.prompts.find((p) => p.target === "name")?.text);
  assert.equal(name(after).confirmReason, "ambiguous");
  assert.equal(name(after).attempts, 0);
});

test("with the fix: the two speech models disagreeing is shown as before", () => {
  const text = "It's for my husband. Sen neler?";
  const disputed = (noName: boolean) => run(noName, [...OPEN, answer(text, 14_000, { firstHeard: "It's for my husband." }), ASK_AGAIN(16_500)], 19_000);
  assert.equal(name(disputed(true)).confirmReason, name(disputed(false)).confirmReason);
  assert.equal(promptFor(disputed(true), "name")?.text, promptFor(disputed(false), "name")?.text);
  assert.equal(name(disputed(true)).attempts, 0);
});

test("with the fix: typed words that aren't the name are a wrong answer, as before", () => {
  const typed: AgentAction = { type: "correct", key: "k4", text: "It's for my husband", at: T + 16_000 };
  const v = run(true, [...OPEN, HUSBAND], 19_000, [typed]);
  assert.equal(name(v).attempts, 1);
  assert.equal(name(v).state, "failed");
});

test("with the fix: the street and city are unchanged", () => {
  const lines = (noName: boolean) =>
    run(
      noName,
      [
        ...OPEN,
        answer("Sam Miller.", 14_000),
        { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 17_000, e: 19_000 },
        answer("It's for my husband.", 20_000),
      ],
      25_000,
      [{ type: "confirm", target: "name", at: T + 16_500 }],
    );
  // The fix is for the name only: this answer to the street and city question is still attempt 1 of 2.
  assert.equal(address(lines(true)).attempts, 1);
  assert.equal(address(lines(true)).state, "failed");
  assert.equal(address(lines(false)).attempts, 1);
});
