import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  C11 (his approval, 20 Nov 15:55 UTC: "you have my approval to build C11 if this is important"), after the second C10
  test call on 20 Nov:
  - The agent's re-ask "Sorry, could you repeat the street and city." lost its question mark, so it was taken as no
    question and the caller's answer got no check from the second speech model. A re-ask is a question with or without
    its mark (signals.test.ts).
  - The Please confirm card quoted an earlier answer: an unasked match never updated what the card quotes, and the card's
    own advice ("If in doubt, ask again") led to an answer the console ignored, because a match held for the press was
    never reopened. With the re-ask now taken as a question, that second gap would have hidden a conflicting answer.
*/
const T = Date.UTC(2026, 10, 20, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; checked?: boolean; checking?: boolean; confidence?: number };
const timed = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-c11",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T + l.s,
    endedAt: T + l.e,
    final: true,
    confidence: l.confidence ?? 0.9,
    ...(l.checked ? { checked: true } : {}),
    ...(l.checking ? { checking: true } : {}),
  }));
type Switches = { press?: boolean; strict?: boolean; readBack?: boolean };
const C11: Switches = { press: true, strict: true, readBack: true };
const pack = (o: Switches): ClientPack => ({
  ...sunlake,
  policy: { ...sunlake.policy, agentConfirmsMatch: !!o.press, strictMatch: !!o.strict, nameReadBack: !!o.readBack, addressReadBack: !!o.readBack },
});
const run = (o: Switches, lines: L[], now: number, actions: AgentAction[] = []) => analyze(pack(o), timed(lines), actions, T + now);
const press = (target: "name" | "address", at: number): AgentAction => ({ type: "confirm", target, at: T + at });
const factor = (v: CopilotView, id: "name" | "address") => v.verification.factors.find((f) => f.id === id)!;
const card = (v: CopilotView, id: "name" | "address") => v.prompts.find((p) => p.target === id);

const OPEN: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today.", s: 10_000, e: 12_000 },
  { side: "agent", text: "First, can I have your full name, please?", s: 12_500, e: 14_500 },
  { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true },
  { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 18_000, e: 20_000 },
];
const ADDR: L = { side: "caller", text: "Hill Road, in Dallas.", s: 21_000, e: 23_000, checked: true };
const REASK: L = { side: "agent", text: "Sorry, could you repeat the street and city.", s: 25_000, e: 27_000 };
const reply = (text: string, extra: Partial<L> = {}): L => ({ side: "caller", text, s: 28_000, e: 30_000, checked: true, ...extra });

test("20 Nov call: the re-ask without its question mark keeps the console waiting, so the caller's answer is checked", () => {
  // As on the call: the earlier answer was asked again by the stricter rules (a word before the street).
  const asked: L[] = [...OPEN, { side: "caller", text: "Church Hill Road, in Dallas.", s: 21_000, e: 23_000, checked: true }, REASK];
  const v = run(C11, asked, 27_500);
  assert.equal(v.awaiting, "address", "the caller's next line waits for its check");
  const answered = run(C11, [...asked, reply("Lake Road, in Boston.", { checked: false })], 31_000);
  assert.ok(answered.keyAnswers.includes(`k${asked.length + 1}`), "the answer is a key answer");
  // Heard right, it is heard as the answer to the address question: held for the press, quoting this line.
  const right = run(C11, [...asked, reply("Hill Road in Dallas.")], 33_000);
  assert.equal(factor(right, "address").state, "confirm");
  assert.equal(factor(right, "address").confirmReason, "match");
  assert.match(card(right, "address")!.text, /^Heard "Hill Road in Dallas\.", which matches the street and city on the order\./);
});

test("an unasked match is held under its own words, never an earlier answer's (what-if B, 20 Nov)", () => {
  // "Sorry, could you repeat that?" names no detail, so the next answer is unasked.
  const lines: L[] = [
    ...OPEN,
    { side: "caller", text: "Church Hill Road, in Dallas.", s: 21_000, e: 23_000, checked: true },
    { side: "agent", text: "Sorry, could you repeat that?", s: 25_000, e: 27_000 },
    reply("Hill Road in Dallas."),
  ];
  const v = run(C11, lines, 33_000);
  const a = factor(v, "address");
  assert.equal(a.state, "confirm");
  assert.equal(a.confirmReason, "match");
  assert.equal(a.heard, "Hill Road in Dallas.");
  assert.match(card(v, "address")!.text, /^Heard "Hill Road in Dallas\.", which matches the street and city on the order\./);
  assert.doesNotMatch(card(v, "address")!.text, /Church/);
  // The press verifies that line.
  const pressed = run(C11, lines, 35_000, [press("name", 31_000), press("address", 34_000)]);
  assert.equal(factor(pressed, "address").state, "ok");
  assert.equal(factor(pressed, "address").evidence?.text, "Hill Road in Dallas.");
  assert.equal(pressed.verification.verified, true);
});

test("asked again about a held match, the caller's new answer decides", () => {
  const held = [...OPEN, ADDR];
  const first = run(C11, held, 24_000);
  assert.equal(factor(first, "address").confirmReason, "match", "held for the press");
  for (const reask of [REASK, { ...REASK, text: "Sorry, could you repeat the street and city?" }]) {
    // The console waits for the new answer, which waits for its check.
    assert.equal(run(C11, [...held, reask], 27_500).awaiting, "address", reask.text);

    // The same address again: still held, now quoting the new line, and the press verifies it.
    const again = run(C11, [...held, reask, reply("It's Hill Road in Dallas.")], 31_000);
    assert.equal(factor(again, "address").confirmReason, "match", reask.text);
    assert.match(card(again, "address")!.text, /^Heard "It's Hill Road in Dallas\."/, reask.text);
    assert.equal(again.awaiting, null, reask.text);
    const pressed = run(C11, [...held, reask, reply("It's Hill Road in Dallas.")], 33_000, [press("name", 31_500), press("address", 32_000)]);
    assert.equal(pressed.verification.verified, true, reask.text);
    assert.equal(factor(pressed, "address").evidence?.text, "It's Hill Road in Dallas.", reask.text);

    // A different address: the answers conflict, so it is asked again, never confirmed, never a failed attempt.
    const other = run(C11, [...held, reask, reply("Lake Road, in Boston.")], 33_000, [press("name", 31_500), press("address", 32_000)]);
    const a = factor(other, "address");
    assert.equal(a.state, "confirm", reask.text);
    assert.equal(a.confirmReason, "ambiguous", reask.text);
    assert.equal(a.attempts, 0, reask.text);
    assert.equal(card(other, "address")!.askAgain, true, reask.text);
    assert.match(card(other, "address")!.text, /^Heard "Lake Road, in Boston\."/, reask.text);
    assert.equal(other.verification.verified, false, `${reask.text}: a press on the earlier answer no longer counts`);

    // No answer yet ("Sorry?"), or a sound-alike: the hold stays on the first answer.
    for (const text of ["Sorry?", "Hel Road in Dallas."]) {
      const v = run(C11, [...held, reask, reply(text)], 31_000);
      assert.equal(factor(v, "address").confirmReason, "match", `${reask.text} / ${text}`);
      assert.match(card(v, "address")!.text, /^Heard "Hill Road, in Dallas\."/, `${reask.text} / ${text}`);
    }
  }
});

test("asked again about a held name, a different name is asked again too; spelling it out still works as on C10", () => {
  const held: L[] = [...OPEN.slice(0, 4), { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true }];
  const reask: L = { side: "agent", text: "Sorry, could you repeat your full name.", s: 18_000, e: 20_000 };
  const other = run(C11, [...held, reask, { side: "caller", text: "Tom Baker.", s: 21_000, e: 22_000, checked: true }], 25_000);
  assert.equal(factor(other, "name").confirmReason, "ambiguous");
  assert.equal(factor(other, "name").attempts, 0);
  // "Could you spell your last name?" is no re-ask: the spelled name leaves the hold as it was (C10's rule).
  const spell: L = { side: "agent", text: "Could you spell your last name?", s: 18_000, e: 20_000 };
  const spelled = run(C11, [...held, spell, { side: "caller", text: "M I L L E R.", s: 21_000, e: 23_000, checked: true }], 25_000);
  assert.equal(factor(spelled, "name").confirmReason, "match");
  assert.match(card(spelled, "name")!.text, /^Heard "Sam Miller\."/);
});

test("with the press switch off, a verified match stays verified when the agent asks again (unchanged)", () => {
  const v = run({ strict: true, readBack: true }, [...OPEN, ADDR, REASK, reply("Lake Road, in Boston.")], 33_000);
  assert.equal(factor(v, "address").state, "ok");
  assert.equal(factor(v, "address").evidence?.text, "Hill Road, in Dallas.");
});

/*
  The independent check of C11 (20 Nov) found that the answer to a re-ask was judged one line at a time: "Lake Road."
  released the hold, then "In Boston." counted as a failed attempt, and two such re-asks locked the call. "In Boston."
  alone, or after "Hill Road.", left the hold, so a press verified over a different city.
*/
const said = (text: string, s: number, e: number, extra: Partial<L> = {}): L => ({ side: "caller", text, s, e, checked: true, ...extra });
const THANKS: L = { side: "agent", text: "Thank you.", s: 34_000, e: 35_000 };

test("the answer to a re-ask is read whole: any other address is asked again, never a failed attempt (C11 check)", () => {
  const held = [...OPEN, ADDR];
  for (const answer of [
    [said("Lake Road.", 28_000, 29_000), said("In Boston.", 29_500, 30_500)],
    [said("Lake Road, in Boston.", 28_000, 30_000), said("Yes, Boston.", 30_500, 31_500)],
    [said("In Boston.", 28_000, 29_000)],
    [said("Hill Road.", 28_000, 29_000), said("In Boston.", 29_500, 30_500)],
  ]) {
    const label = answer.map((l) => l.text).join(" ");
    const v = run(C11, [...held, REASK, ...answer, THANKS], 37_000, [press("name", 32_000), press("address", 36_000)]);
    const a = factor(v, "address");
    assert.equal(a.state, "confirm", label);
    assert.equal(a.confirmReason, "ambiguous", label);
    assert.equal(a.attempts, 0, label);
    assert.equal(card(v, "address")!.askAgain, true, label);
    assert.equal(v.verification.verified, false, `${label}: no press verifies the address`);
  }
  // The same for the name.
  const name = run(
    C11,
    [...OPEN.slice(0, 5), { side: "agent", text: "Sorry, could you repeat your full name.", s: 18_000, e: 20_000 }, said("Tom Baker.", 21_000, 22_000), said("Tom Baker, yes.", 22_500, 23_500), { ...THANKS, s: 27_000, e: 28_000 }],
    30_000,
  );
  assert.equal(factor(name, "name").confirmReason, "ambiguous");
  assert.equal(factor(name, "name").attempts, 0);
  // Once asked again, the next answer is judged like any answer: a clear wrong one counts, once, and the call isn't locked.
  const twice = run(
    C11,
    [...held, REASK, said("Lake Road.", 28_000, 29_000), said("In Boston.", 29_500, 30_500), { ...REASK, s: 34_000, e: 36_000 }, said("Lake Road.", 37_000, 38_000), said("In Boston.", 38_500, 39_500), { ...THANKS, s: 43_000, e: 44_000 }],
    46_000,
  );
  assert.equal(factor(twice, "address").attempts, 1);
  assert.equal(twice.verification.locked, false);
});

test("a doubtful new answer to a re-ask, once pressed, is recorded as the agent's confirmation (C11 check)", () => {
  const v = run(C11, [...OPEN, ADDR, REASK, reply("Hill Road in Dallas.", { confidence: 0.3 })], 35_000, [press("name", 31_000), press("address", 32_000)]);
  const a = factor(v, "address");
  assert.equal(a.state, "ok");
  assert.equal(a.evidence?.text, "Hill Road in Dallas.");
  assert.equal(a.method, "confirmed by the agent", "not the earlier answer's \"street and city\"");
});

test("a doubtful email never opens a read-back of the street and city (C11 check)", () => {
  const email = said("s dot miller at example mail dot com", 21_000, 23_000, { confidence: 0.3 });
  const back: L[] = [{ side: "agent", text: "So that's Hill Road in Dallas, right?", s: 25_000, e: 27_000 }, said("Yes.", 27_500, 28_000)];
  // Given as the answer to the street and city question (the same on C10), and given unasked.
  const unasked: L[] = [...OPEN.slice(0, 5), { side: "agent", text: "Thank you, one moment.", s: 17_000, e: 18_000 }, { side: "agent", text: "Let me pull that up.", s: 19_000, e: 20_000 }, email];
  for (const [label, lines, switches] of [
    ["asked", [...OPEN, email], { strict: true, readBack: true }],
    ["unasked", unasked, { strict: true, readBack: true }],
    ["unasked, all switches", unasked, C11],
  ] as [string, L[], Switches][]) {
    const v = run(switches, [...lines, ...back], 30_000);
    assert.notEqual(factor(v, "address").state, "ok", label);
    assert.equal(v.verification.verified, false, label);
  }
});
