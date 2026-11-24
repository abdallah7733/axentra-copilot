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
  With the independent check's corrections (24 Nov): once the agent asks again, the answer ends as a failed attempt does
  (no card, no typing over it); whatever the caller says next is heard as with the fix off.
*/
const T = Date.UTC(2026, 10, 24, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; checked?: boolean; firstHeard?: string; confidence?: number };
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
    confidence: l.confidence ?? 0.9,
    ...(l.checked ? { checked: true } : {}),
    ...(l.firstHeard ? { firstHeard: l.firstHeard } : {}),
  }));
// C12's five switches (as built for his Mac), with or without the no-name fix.
const pack = (noName: boolean, base: ClientPack = sunlake): ClientPack => ({
  ...base,
  policy: { ...base.policy, agentConfirmsMatch: true, strictMatch: true, nameReadBack: true, addressReadBack: true, questionInCheck: true, noNameNotCounted: noName },
});
const run = (noName: boolean, lines: L[], now: number, actions: AgentAction[] = [], base: ClientPack = sunlake) => analyze(pack(noName, base), timed(lines), actions, T + now);
const name = (v: CopilotView) => v.verification.factors.find((f) => f.id === "name")!;
const address = (v: CopilotView) => v.verification.factors.find((f) => f.id === "address")!;
const promptFor = (v: CopilotView, id: "name" | "address") => v.prompts.find((p) => p.target === id);
const failedAlert = (v: CopilotView) => v.alerts.find((a) => a.id === "verification-failed-name");
const nameStep = (v: CopilotView) => v.steps.find((s) => s.id === "name")!;
const press = (at: number): AgentAction => ({ type: "confirm", target: "name", at: T + at });

const OPEN: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. First, can I have your full name, please?", s: 10_000, e: 13_000 },
];
const answer = (text: string, s: number, extra: Partial<L> = {}): L => ({ side: "caller", text, s, e: s + 1500, checked: true, ...extra });
const agent = (text: string, s: number): L => ({ side: "agent", text, s, e: s + 2000 });
const ASK_AGAIN = (s: number): L => agent("Sorry, could I have the full name on the account?", s);
const HUSBAND = answer("It's for my husband.", 14_000);
const NO_NAME_CARD = `Ask for the full name once more. Heard "It's for my husband.": there's no name in it, so it isn't counted as a wrong answer, and it can't verify anyone.`;

test("the switch is on only when the build sets it to 1", () => {
  assert.equal(sunlake.policy.noNameNotCounted, process.env.NEXT_PUBLIC_NO_NAME_NOT_COUNTED === "1");
});

test("the written words: an answer counts as no name only if every word is on the list", () => {
  for (const t of [
    "It's for my husband.",
    "It's for my husband's account.",
    "Um, it's under my wife's name.",
    "It's my mum's order.",
    "Order 427.",
    "It's for him, he placed the order.",
    "My order number is 427.",
    "Order four twenty-seven.",
    "The order ID is 427.",
    "Could you repeat the question?",
    "I didn't catch that.",
    "It's for my cousin.",
    "It's my friend's.",
    "It's for my ex-wife.",
    "It's a business account.",
    "Just a sec.",
    "My husband would know.",
    "It isnt mine.",
  ])
    assert.equal(saysNoName(t), true, t);
  for (const t of [
    "It's for my husband, Tom.",
    "Sam Miller.",
    "Miller.",
    "Tom Baker.",
    "It's for my husband, Sam Miller.",
    "",
    // Left off on purpose (verification.ts): each is commonly a name on its own.
    "It's for my son.",
    "Hang on.",
    "It's for my mother-in-law.",
    "Why do you need it?",
    "Order four oh seven.",
  ])
    assert.equal(saysNoName(t), false, t);
  // A word of the record's own name is never a no-name word.
  assert.equal(saysNoName("Not Husband."), true);
  assert.equal(saysNoName("Not Husband.", ["sam", "husband"]), false);
});

test("today's C12 (switch off): \"It's for my husband.\" is a wrong name, attempt 1 of 2", () => {
  // Before the agent asks again, the panel shows the failed attempt.
  const v = run(false, [...OPEN, HUSBAND], 18_000);
  assert.equal(name(v).attempts, 1);
  assert.equal(name(v).state, "failed");
  assert.match(failedAlert(v)?.title ?? "", /not matched \(attempt 1 of 2\)/);
  assert.equal(name(run(false, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 19_000)).attempts, 1);
});

test("with the fix: an Ask again card, no attempt counted; once the agent asks again, nothing is left over", () => {
  const before = run(true, [...OPEN, HUSBAND], 18_000);
  assert.equal(name(before).state, "confirm");
  assert.equal(name(before).confirmReason, "no-name");
  assert.equal(name(before).attempts, 0);
  assert.equal(failedAlert(before), undefined);
  const p = promptFor(before, "name");
  assert.equal(p?.askAgain, true, "an Ask again card, with no Confirmed button");
  assert.equal(p?.text, NO_NAME_CARD);
  assert.equal(nameStep(before).detail, "Ask again");
  // The agent asks again: as a failed attempt does, the answer ends there. No card, and no typing over it.
  const v = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 19_000);
  assert.equal(name(v).attempts, 0);
  assert.equal(name(v).state, "asking");
  assert.equal(name(v).confirmReason, undefined);
  assert.equal(promptFor(v, "name"), undefined);
  assert.equal(v.nameEntry, null);
  assert.equal(nameStep(v).detail, "Listening…");
  assert.equal(v.verification.locked, false);
  assert.equal(v.verification.attemptsLeft, 2);
  assert.equal(failedAlert(v), undefined);
  // The switch-off build shows the same once the agent asks again, but with one attempt used.
  const off = run(false, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 19_000);
  assert.equal(name(off).state, "asking");
  assert.equal(promptFor(off, "name"), undefined);
});

test("with the fix: a Confirmed press on a no-name answer verifies nothing", () => {
  const held = run(true, [...OPEN, HUSBAND], 20_000, [press(18_000)]);
  assert.equal(name(held).state, "confirm");
  assert.equal(name(held).confirmReason, "no-name");
  assert.equal(name(held).attempts, 0);
  const after = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500)], 20_000, [press(19_000)]);
  assert.equal(name(after).state, "asking");
  assert.equal(name(after).attempts, 0);
});

test("with the fix: the agent saying the record's name and the caller's yes verify nothing either", () => {
  const lines = [...OPEN, HUSBAND, agent("Is it Sam Miller?", 16_500), answer("Yes.", 19_000)];
  const v = run(true, lines, 22_000);
  assert.notEqual(name(v).state, "ok");
  assert.equal(name(v).attempts, 0);
  assert.equal(v.verification.verified, false);
  const pressed = run(true, lines, 24_000, [press(23_000)]);
  assert.notEqual(name(pressed).state, "ok");
});

test("with the fix: a press during the no-name answer doesn't carry over to the name said next", () => {
  for (const at of [16_000, 18_000]) {
    const v = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("Sam Miller.", 19_000)], 22_000, [press(at)]);
    assert.equal(name(v).state, "confirm", `press at ${at}`);
    assert.equal(name(v).confirmReason, "match", `press at ${at}`);
  }
});

test("with the fix: the name said next is heard as usual, held for the agent's press", () => {
  const lines = [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("Sam Miller.", 19_000)];
  const held = run(true, lines, 22_000);
  assert.equal(name(held).state, "confirm");
  assert.equal(name(held).confirmReason, "match");
  assert.equal(name(held).attempts, 0);
  const pressed = run(true, lines, 24_000, [press(23_000)]);
  assert.equal(name(pressed).state, "ok");
  assert.equal(name(pressed).attempts, 0);
  assert.equal(name(pressed).confirmReason, undefined, "the no-name reason doesn't stay behind");
});

test("with the fix: two no-name answers count nothing; a wrong name after them still counts", () => {
  const twice = [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("It's my husband's account.", 19_000)];
  const second = run(true, twice, 23_000);
  assert.equal(name(second).confirmReason, "no-name");
  assert.equal(name(second).attempts, 0);
  const v = run(true, [...twice, ASK_AGAIN(21_500)], 24_000);
  assert.equal(name(v).attempts, 0);
  assert.equal(name(v).state, "asking");
  assert.equal(v.verification.locked, false);
  const wrong = run(true, [...twice, ASK_AGAIN(21_500), answer("Tom Baker.", 24_000)], 28_000);
  assert.equal(name(wrong).attempts, 1);
  assert.equal(name(wrong).state, "failed");
});

test("with the fix: an answer with any other word is a wrong name, as before", () => {
  for (const text of ["It's for my husband, Tom.", "Tom Baker.", "It's for my son."]) {
    const v = run(true, [...OPEN, answer(text, 14_000)], 18_000);
    assert.equal(name(v).attempts, 1, text);
    assert.equal(name(v).state, "failed", text);
  }
});

test("with the fix: an order number said instead of a name isn't counted", () => {
  for (const text of ["My order number is 427.", "It's order number four two seven."]) {
    const v = run(true, [...OPEN, answer(text, 14_000)], 18_000);
    assert.equal(name(v).attempts, 0, text);
    assert.equal(name(v).confirmReason, "no-name", text);
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

test("with the fix: a word of the record's own name is never a no-name word", () => {
  // A record whose surname is a word on the list: the answer is judged as with the fix off.
  const cust = { ...sunlake.customers[0], name: "Sam Husband" };
  const base: ClientPack = { ...sunlake, customers: [cust], orders: sunlake.orders.map((o) => (o.customerId === cust.id ? { ...o, customerName: cust.name } : o)) };
  for (const text of ["Not Husband.", "It's for my husband."]) {
    const on = run(true, [...OPEN, answer(text, 14_000)], 18_000, [], base);
    const off = run(false, [...OPEN, answer(text, 14_000)], 18_000, [], base);
    assert.notEqual(name(on).confirmReason, "no-name", text);
    assert.equal(name(on).state, name(off).state, text);
    assert.equal(name(on).attempts, name(off).attempts, text);
  }
});

test("with the fix: a doubtful line is shown as before, whatever it says", () => {
  // The two speech models disagree on a no-name answer: the card shows both readings, as with the fix off.
  const disputed = (noName: boolean, now: number, lines: L[] = []) =>
    run(noName, [...OPEN, answer("It's for my husband.", 14_000, { firstHeard: "Tom Baker." }), ...lines], now);
  for (const [now, lines] of [[18_000, []], [19_000, [ASK_AGAIN(16_500)]]] as const) {
    assert.equal(name(disputed(true, now, [...lines])).confirmReason, "disagree");
    assert.equal(promptFor(disputed(true, now, [...lines]), "name")?.text, promptFor(disputed(false, now, [...lines]), "name")?.text);
    assert.equal(name(disputed(true, now, [...lines])).attempts, 0);
  }
  // Heard with low confidence: the same.
  const low = (noName: boolean) => run(noName, [...OPEN, answer("It's for my husband.", 14_000, { confidence: 0.3 })], 18_000);
  assert.equal(name(low(true)).confirmReason, "low-confidence");
  assert.equal(promptFor(low(true), "name")?.text, promptFor(low(false), "name")?.text);
});

test("with the fix: typed words that aren't the name are a wrong answer, as before", () => {
  const typed: AgentAction = { type: "correct", key: "k4", text: "It's for my husband", at: T + 16_000 };
  const v = run(true, [...OPEN, HUSBAND], 19_000, [typed]);
  assert.equal(name(v).attempts, 1);
  assert.equal(name(v).state, "failed");
});

test("with the fix: a spelled name after a no-name answer is heard as with the fix off", () => {
  const spelled = answer("Sam Miller, M I L L E R.", 19_000);
  for (const between of [ASK_AGAIN(16_500), agent("One moment.", 16_500), agent("Okay, no problem.", 16_500)]) {
    const on = run(true, [...OPEN, HUSBAND, between, spelled], 23_000);
    const off = run(false, [...OPEN, HUSBAND, between, spelled], 23_000);
    assert.equal(name(on).state, "confirm", between.text);
    assert.equal(name(on).confirmReason, name(off).confirmReason, between.text);
    assert.equal(name(on).confirmReason, "match", between.text);
    assert.equal(name(on).attempts, 0, between.text);
    assert.equal(promptFor(on, "name")?.text, promptFor(off, "name")?.text, between.text);
  }
  // A wrong spelled name still counts.
  const wrong = run(true, [...OPEN, HUSBAND, ASK_AGAIN(16_500), answer("Tom Baker, B A K E R.", 19_000)], 23_000);
  assert.equal(name(wrong).attempts, 1);
});

test("with the fix: while the question lingers, part of the name or a sound-alike is heard as with the fix off", () => {
  const lingering = (noName: boolean, lines: L[]) => run(noName, [...OPEN, HUSBAND, agent("One moment.", 16_500), ...lines], 25_000);
  for (const lines of [[answer("Sam Millar.", 19_000)], [answer("Miller.", 19_000)], [answer("Sam.", 19_000), answer("Miller.", 21_000)]]) {
    const label = lines.map((l) => l.text).join(" ");
    const [on, off] = [lingering(true, lines), lingering(false, lines)];
    assert.equal(name(on).state, name(off).state, label);
    assert.equal(name(on).confirmReason, name(off).confirmReason, label);
    assert.notEqual(name(on).confirmReason, "no-name", label);
    assert.equal(name(on).attempts, 0, label);
  }
});

test("with the fix: a match said without being asked again replaces the no-name reason", () => {
  const lines = [...OPEN, HUSBAND, agent("Okay, no problem.", 16_500), answer("Sam Miller.", 19_000)];
  const pressed = run(true, lines, 24_000, [press(23_000)]);
  assert.equal(name(pressed).state, "ok");
  assert.equal(name(pressed).confirmReason, undefined);
  // Read back and refused: "ambiguous", as with the fix off.
  const refused = (noName: boolean) =>
    run(noName, [...lines, agent("So that's Sam Miller, right?", 22_000), answer("No, that's not right.", 25_000)], 29_000);
  assert.equal(name(refused(true)).confirmReason, name(refused(false)).confirmReason);
  assert.equal(name(refused(true)).confirmReason, "ambiguous");
});

test("with the fix: a no-name answer to the re-ask of a held match gets the no-name card", () => {
  const lines = (noName: boolean) => run(noName, [...OPEN, answer("Sam Miller.", 14_000), ASK_AGAIN(16_500), answer("It's for my husband.", 19_000)], 23_000);
  assert.equal(name(lines(true)).confirmReason, "no-name");
  assert.equal(promptFor(lines(true), "name")?.text, NO_NAME_CARD);
  assert.equal(name(lines(true)).attempts, 0);
  // With the fix off, the same answer is asked again too, with the "more than one name" card.
  assert.equal(name(lines(false)).confirmReason, "ambiguous");
  assert.equal(name(lines(false)).attempts, 0);
});

test("with the fix: after a read-back, the no-name card never says to type what the caller said", () => {
  const start = [...OPEN, answer("Sam Millar.", 14_000), agent("So that's Sam Miller, right?", 16_500)];
  // Refused: the card says the answer isn't counted, and that the read-back won't count again.
  const refused = run(true, [...start, answer("No.", 19_000), ASK_AGAIN(21_000), answer("It's for my husband.", 24_000)], 28_000);
  assert.equal(name(refused).attempts, 0);
  assert.equal(name(refused).confirmReason, "no-name");
  assert.equal(
    promptFor(refused, "name")?.text,
    `${NO_NAME_CARD} The read-back wasn't confirmed earlier, so reading it back or pressing Confirm won't count on this call.`,
  );
  // "Sorry?" to the read-back: the agent has said the name, so the caller repeating it can't verify it.
  const sorry = run(true, [...start, answer("Sorry?", 19_000), ASK_AGAIN(21_000), answer("It's for my husband.", 24_000)], 28_000);
  assert.equal(name(sorry).attempts, 0);
  assert.equal(name(sorry).confirmReason, "no-name");
  assert.equal(
    promptFor(sorry, "name")?.text,
    `${NO_NAME_CARD} You've said the name on the call, so the caller repeating it can't verify it: type the name they give (N).`,
  );
  for (const v of [refused, sorry]) assert.doesNotMatch(promptFor(v, "name")?.text ?? "", /Type what the caller said/);
});

test("with the fix: a name said later without being asked leaves the no-name answer as it was", () => {
  const v = run(true, [...OPEN, HUSBAND, agent("Thanks. I can see the tablet order here.", 16_500), answer("Actually it's Tom Baker.", 19_500)], 23_000);
  assert.equal(name(v).confirmReason, "no-name");
  assert.equal(name(v).attempts, 0);
  assert.equal(promptFor(v, "name")?.text, NO_NAME_CARD);
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
      [press(16_500)],
    );
  // The fix is for the name only: this answer to the street and city question is still attempt 1 of 2.
  assert.equal(address(lines(true)).attempts, 1);
  assert.equal(address(lines(true)).state, "failed");
  assert.equal(address(lines(false)).attempts, 1);
});
