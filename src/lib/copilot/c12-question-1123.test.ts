import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  C12 (his "Build C12", 23 Nov 2026): a name or address answer is checked with his question in front. The copilot names
  the question (CopilotView.checkContext, awaitingAsk) only when it is one of his usual questions, asked for that detail
  (never a read-back), with nothing said in between on either side, and the answer is the caller's first line after it.
  It changes nothing else the copilot decides: the store sends the audio.
*/
const T = Date.UTC(2026, 10, 23, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; checked?: boolean; checking?: boolean; reheard?: string; firstHeard?: string };
const timed = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-c12",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T + l.s,
    endedAt: T + l.e,
    final: true,
    confidence: 0.9,
    ...(l.checked ? { checked: true } : {}),
    ...(l.checking ? { checking: true } : {}),
    ...(l.reheard ? { reheard: { text: l.reheard, confidence: 0.9, at: T + l.e + 2000 } } : {}),
    ...(l.firstHeard ? { firstHeard: l.firstHeard } : {}),
  }));
type Switches = { press?: boolean; question?: boolean };
const C12: Switches = { press: true, question: true };
const C11: Switches = { press: true };
const pack = (o: Switches): ClientPack => ({
  ...sunlake,
  policy: { ...sunlake.policy, agentConfirmsMatch: !!o.press, strictMatch: true, nameReadBack: true, addressReadBack: true, questionInCheck: !!o.question },
});
const run = (o: Switches, lines: L[], now: number, actions: AgentAction[] = [], p: ClientPack = pack(o)) => analyze(p, timed(lines), actions, T + now);

const START: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today.", s: 10_000, e: 12_000 },
];
const NAME_Q: L = { side: "agent", text: "First, can I have your full name, please?", s: 12_500, e: 14_500 };
const NAME_A: L = { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true };
const ADDR_Q: L = { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 18_000, e: 20_000 };
const ADDR_A: L = { side: "caller", text: "Hill Road, in Dallas.", s: 21_000, e: 23_000, checked: true };

test("his usual name and address questions go in front of the caller's answers, awaited and in speech order", () => {
  const asked = run(C12, [...START, NAME_Q], 14_600);
  assert.equal(asked.awaiting, "name");
  assert.equal(asked.awaitingAsk, "k4", "the caller's next line hears the name question in front");
  const v = run(C12, [...START, NAME_Q, NAME_A, ADDR_Q, ADDR_A], 23_500);
  assert.deepEqual(v.checkContext, { k5: "k4", k7: "k6" });
  assert.ok(v.keyAnswers.includes("k5") && v.keyAnswers.includes("k7"));
});

test("off unless the build sets it, and only with the agent confirming every match", () => {
  for (const o of [C11, { question: true }]) {
    const asked = run(o, [...START, NAME_Q], 14_600);
    assert.equal(asked.awaitingAsk, undefined);
    assert.equal(run(o, [...START, NAME_Q, NAME_A, ADDR_Q, ADDR_A], 23_500).checkContext, undefined);
  }
});

test("C12 decides nothing differently: the view is C11's plus the question it names", () => {
  const lines = [...START, NAME_Q, NAME_A, ADDR_Q, ADDR_A];
  const actions: AgentAction[] = [
    { type: "confirm", target: "name", at: T + 17_000 },
    { type: "confirm", target: "address", at: T + 24_000 },
  ];
  for (const [upTo, now] of [
    [4, 14_600],
    [5, 16_500],
    [7, 23_500],
    [7, 25_000],
  ] as const) {
    const strip = (v: CopilotView) => {
      const rest: Partial<CopilotView> = { ...v };
      delete rest.checkContext;
      delete rest.awaitingAsk;
      return rest;
    };
    assert.deepEqual(strip(run(C12, lines.slice(0, upTo), now, actions)), strip(run(C11, lines.slice(0, upTo), now, actions)), `${upTo} lines at ${now}`);
  }
});

test("a read-back is never the line in front, nor the reply to it heard with the question", () => {
  const backed: L[] = [...START, NAME_Q, NAME_A, { side: "agent", text: "So it's Sam Miller, right?", s: 17_000, e: 18_500 }];
  assert.equal(run(C12, backed, 18_600).awaitingAsk, undefined);
  const v = run(C12, [...backed, { side: "caller", text: "Yes.", s: 19_000, e: 19_500, checked: true }], 20_000);
  assert.deepEqual(v.checkContext, { k5: "k4" }, "only the name answer itself");
});

test("a question with the record's name in it, or heard again as something else, keeps today's check", () => {
  const named: L = { side: "agent", text: "Could you repeat your full name, Sam?", s: 12_500, e: 14_500 };
  const asked = run(C12, [...START, named], 14_600);
  assert.equal(asked.awaiting, "name", "it is still a name question");
  assert.equal(asked.awaitingAsk, undefined);
  assert.equal(run(C12, [...START, named, NAME_A], 16_500).checkContext, undefined);
  // Every reading of his line counts: heard again by the second model as another question, it isn't used.
  assert.deepEqual(run(C12, [...START, { ...NAME_Q, reheard: "First, can I have your full name, please?" }, NAME_A], 16_500).checkContext, { k5: "k4" });
  assert.equal(run(C12, [...START, { ...NAME_Q, reheard: "First, can I have your phone number, please?" }, NAME_A], 16_500).checkContext, undefined);
});

test("only the caller's first line after the question, with nothing said in between", () => {
  // The agent said something after the question: the name is still awaited, but not with the question in front.
  const hold: L = { side: "agent", text: "One moment, please.", s: 15_000, e: 15_800 };
  const held = run(C12, [...START, NAME_Q, hold], 15_900);
  assert.equal(held.awaiting, "name");
  assert.equal(held.awaitingAsk, undefined);
  const late = run(C12, [...START, NAME_Q, hold, { ...NAME_A, s: 16_500, e: 17_500 }], 18_000);
  assert.ok(late.keyAnswers.includes("k6"));
  assert.equal(late.checkContext, undefined);
  // An answer over two lines: the second keeps today's check.
  const first: L = { side: "caller", text: "Sam.", s: 15_000, e: 15_500, checked: true };
  const second: L = { side: "caller", text: "Miller.", s: 16_500, e: 17_000, checked: true };
  assert.deepEqual(run(C12, [...START, NAME_Q, first, second], 17_500).checkContext, { k5: "k4" });
  // Its first line still with the second model: it counts as said, so nothing after it hears the question.
  const checking: L = { ...first, checked: false, checking: true };
  const waiting = run(C12, [...START, NAME_Q, checking], 15_600);
  assert.equal(waiting.awaiting, "name");
  assert.equal(waiting.awaitingAsk, undefined);
  const after = run(C12, [...START, NAME_Q, checking, { ...second, checked: false }], 17_500);
  assert.ok(after.keyAnswers.includes("k6"));
  assert.equal(after.checkContext, undefined);
});

test("a word of the records keeps his question out even when it is one of his questions' words", () => {
  // Independent check of C12, finding 5: Sunlake's record words are outside his questions' words, so test a record with
  // one inside them: a second customer named May.
  const may: L = { side: "agent", text: "May I have your full name, please?", s: 12_500, e: 14_500 };
  assert.deepEqual(run(C12, [...START, may, NAME_A], 16_500).checkContext, { k5: "k4" }, "not a record word at Sunlake");
  const withMay: ClientPack = { ...pack(C12), customers: [...sunlake.customers, { ...sunlake.customers[0], id: "cust-may", name: "May Brook" }] };
  assert.equal(run(C12, [...START, may, NAME_A], 16_500, [], withMay).checkContext, undefined);
  assert.equal(run(C12, [...START, may], 14_600, [], withMay).awaitingAsk, undefined);
  assert.deepEqual(run(C12, [...START, NAME_Q, NAME_A], 16_500, [], withMay).checkContext, { k5: "k4" }, "his other usual question still goes in front");
});

test("what the fast model first heard on his line counts too, when the check replaced it", () => {
  const replaced: L = { ...NAME_Q, checked: true, firstHeard: "First, can I have your phone number, please?" };
  assert.equal(run(C12, [...START, replaced, NAME_A], 16_500).checkContext, undefined);
  const same: L = { ...NAME_Q, checked: true, firstHeard: "First, can I have your full name?" };
  assert.deepEqual(run(C12, [...START, same, NAME_A], 16_500).checkContext, { k5: "k4" });
});

test("a caller line said over the end of his question counts as said in between", () => {
  // Independent check of C12, finding 2: the caller began before his question and was still talking when it ended.
  // Lines in speech order, as the store sends them.
  const over: L = { side: "caller", text: "Yes, it was yesterday.", s: 12_200, e: 15_000, checked: true };
  const answer: L = { ...NAME_A, s: 15_500, e: 16_500 };
  assert.equal(run(C12, [...START, over, NAME_Q], 15_100).awaiting, "name");
  assert.equal(run(C12, [...START, over, NAME_Q], 15_100).awaitingAsk, undefined);
  const v = run(C12, [...START, over, NAME_Q, answer], 17_000);
  assert.ok(v.keyAnswers.includes("k6"));
  assert.equal(v.checkContext, undefined);
  // Ended before his question did: the answer still hears it in front.
  const before: L = { ...over, e: 14_000 };
  assert.deepEqual(run(C12, [...START, before, NAME_Q, answer], 17_000).checkContext, { k6: "k5" });
});
