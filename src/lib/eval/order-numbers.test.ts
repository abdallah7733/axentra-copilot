import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "@/lib/copilot/copilot";
import { findOrderMentions, findSplitOrder } from "@/lib/copilot/orders";
import type { ClientPack, TranscriptEvent } from "@/lib/copilot/types";
import { evalPack } from "./records";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  Order numbers split by a pause (register I-43) and rewritten by the second speech model's check
  (I-44). Built on the Step 7 evaluation records (fictional; decoys one digit or a transposition
  away) and on the Sunlake demo's 3-digit orders. The tests on whole numbers, leading zeros, the
  split answer, the correction and the check's rewrite failed on B0 (5bb7bf2); the others pin
  safety rules that already held and must keep holding. Text only: no audio, no recognizer, no timing.
*/

const NOW = Date.UTC(2026, 9, 20, 12);
type Line = { side: "caller" | "agent"; text: string; first?: string; checkFailed?: boolean; gapS?: number; durS?: number };

/** Lines in order: each starts `gapS` (default 1 s) after the previous one ends. */
function events(lines: Line[]): TranscriptEvent[] {
  let t = NOW - 300_000;
  return lines.map((l, i) => {
    const startedAt = t + (i ? (l.gapS ?? 1) * 1000 : 0);
    const endedAt = startedAt + (l.durS ?? 1.5) * 1000;
    t = endedAt;
    return {
      callId: "CA-orders",
      seq: i + 1,
      key: `k${i + 1}`,
      side: l.side,
      text: l.text,
      startedAt,
      endedAt,
      final: true as const,
      confidence: 0.9,
      ...(l.first !== undefined ? { firstHeard: l.first } : {}),
      ...(l.checkFailed ? { checkFailed: true } : {}),
    };
  });
}

/** Identity answered in full for the record's customer, then the agent asks for the order. */
const verified = (pack: ClientPack): Line[] => {
  const c = pack.customers.find((x) => x.id === pack.callerCustomerId)!;
  return [
    { side: "agent", text: "Can I have your full name, please?" },
    { side: "caller", text: `${c.name}.` },
    { side: "agent", text: "And the street and city on the account?" },
    { side: "caller", text: `${c.address.street}, ${c.address.city}.` },
    { side: "agent", text: "Which order is this about?" },
  ];
};
const order = (pack: ClientPack, lines: Line[]) => analyze(pack, events([...verified(pack), ...lines]), [], NOW).order;

const D04 = evalPack("R-D04"); // 58316, decoy 58361
const D05 = evalPack("R-D05"); // 71426, decoy 71462
const D06 = evalPack("R-D06"); // 06294, decoy 06291

test("the identity prefix verifies the record's customer, so the order tests below test the order alone", () => {
  for (const pack of [D04, D05, D06]) assert.equal(analyze(pack, events(verified(pack)), [], NOW).verification.verified, true);
});

/* ---------- I-43: one answer, one number ---------- */

test("42791 said digit by digit stays complete (B0 read only four spoken digits)", () => {
  assert.deepEqual(findOrderMentions("It's four two seven nine one.", [5], true)[0].candidates, ["42791"]);
  const o = order(D04, [{ side: "caller", text: "Sure, it's order five eight three one six." }]);
  assert.deepEqual([o.match?.order.id, o.match?.method, o.match?.needsConfirmation], ["58316", "spoken", false]);
});

test("leading zeros survive: spoken, as digits, and as hyphenated digits", () => {
  assert.deepEqual(findOrderMentions("zero six two nine four", [5], true)[0].candidates, ["06294"]);
  assert.equal(findOrderMentions("order oh six two nine four", [5])[0].candidates.includes("06294"), true);
  assert.deepEqual(findOrderMentions("It's 0-6-2-9-4.", [5], true)[0].candidates, ["06294"]);
  // Two digits with a hyphen are still a range or a duration, never joined.
  assert.deepEqual(findOrderMentions("A refund in 3-5 business days.", [3]), []);
  assert.equal(order(D06, [{ side: "caller", text: "It's 0-6-2-9-4." }]).match?.order.id, "06294");
});

test('D05: "Order 714." then "Two six." inside one answer is read as 71426 (B0: only the "only recent order" guess)', () => {
  const o = order(D05, [
    { side: "caller", text: "Order 714." },
    { side: "caller", text: "Two six.", gapS: 1 },
  ]);
  assert.deepEqual([o.match?.order.id, o.match?.method, o.match?.needsConfirmation], ["71426", "spoken", false]);
  assert.equal(o.heard?.text, "714 two six");
  assert.equal(o.match?.evidence?.text, "Order 714. Two six.");
});

test("a split number is never completed from a near length, a later turn, or the record", () => {
  assert.equal(findSplitOrder("Order 714.", "Two.", [5]), null); // 7142: one digit short, not an order number
  assert.equal(findSplitOrder("Order 714.", "Thanks.", [5]), null);
  assert.equal(findSplitOrder("Order 71426.", "Two six.", [5]), null); // the first line was already complete
  // An agent line between the two halves: separate turns, never one number.
  const agentBetween = order(D05, [
    { side: "caller", text: "Order 714." },
    { side: "agent", text: "Sorry, could you repeat that?" },
    { side: "caller", text: "Two six." },
  ]);
  assert.notEqual(agentBetween.match?.method, "spoken");
  // A pause of 2 s or more ends the answer (ANSWER_GAP_MS), as for names and addresses.
  const longPause = order(D05, [
    { side: "caller", text: "Order 714." },
    { side: "caller", text: "Two six.", gapS: 2.5 },
  ]);
  assert.notEqual(longPause.match?.method, "spoken");
  // Without a joined number, the record only ever offers its one recent order to confirm.
  for (const o of [agentBetween, longPause]) assert.deepEqual([o.match?.method, o.match?.needsConfirmation], ["only-recent", true]);
});

test("halves that spell the decoy never match it; the customer's own order is offered to confirm", () => {
  const o = order(D05, [
    { side: "caller", text: "Order 714." },
    { side: "caller", text: "Six two." },
  ]);
  assert.notEqual(o.match?.order.id, "71462");
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation], ["71426", true]);
});

test('a correction inside one answer ("06291. Sorry, no, 06294") reads the later number and asks for a read-back', () => {
  const o = order(D06, [{ side: "caller", text: "It's zero six two nine one. Sorry, no, zero six two nine four." }]);
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation, o.match?.confirmed], ["06294", true, false]);
  assert.match(o.match!.note, /The caller named 06291, then 06294/);
  // The Sunlake demo's own 3-digit case: "427, sorry, 429" is a clarification, not an exact match.
  const sam = analyze(sunlake, events([...verified(sunlake), { side: "caller", text: "It's order 427, sorry, 429." }]), [], NOW).order;
  assert.deepEqual([sam.match?.order.id, sam.match?.needsConfirmation], ["427", true]);
  assert.match(sam.match!.note, /The caller named 427, then 429/);
});

test("an amount next to the order number is not read as an order", () => {
  const o = order(D04, [{ side: "caller", text: "Sure, it's order 58316. It was $129." }]);
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation, o.match?.note], ["58316", false, 'Heard "58316".']);
  assert.deepEqual(findOrderMentions("It was a hundred and twenty-nine dollars.", [3], true), []);
});

/* ---------- I-44: the check rewrites a number ---------- */

test('the check spells "427" as "four to seven": both readings kept, and the order needs a read-back', () => {
  const o = analyze(sunlake, events([...verified(sunlake), { side: "caller", text: "It's four to seven.", first: "It's 427." }]), [], NOW).order;
  assert.equal(o.match?.order.id, "427");
  assert.equal(o.match?.needsConfirmation, true);
  assert.match(o.match!.note, /two speech models heard different order numbers/);
});

test("the check loses a complete 5-digit number the fast model had: the fast model's number stays a candidate, never exact", () => {
  const o = order(D04, [{ side: "caller", text: "Sure, it's order five eight three.", first: "Sure, it's order 58316." }]);
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation], ["58316", true]);
  assert.equal(o.heard?.reading, "58316");
});

test("the two models read different complete numbers: the decoy is never matched, the customer's order needs a read-back", () => {
  const o = order(D04, [{ side: "caller", text: "It's order 58361.", first: "It's order 58316." }]);
  assert.equal(o.heard?.reading, "58361 or 58316");
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation], ["58316", true]);
  // The agent's read-back of the customer's own order confirms it.
  const readBack = analyze(
    D04,
    events([...verified(D04), { side: "caller", text: "It's order 58361.", first: "It's order 58316." }, { side: "agent", text: "Just to confirm, that's order 58316?" }]),
    [],
    NOW
  ).order;
  assert.deepEqual([readBack.match?.order.id, readBack.match?.confirmed], ["58316", true]);
});

test("a leading zero lost on the check (6294 for 06294) is a disagreement, not a match", () => {
  const o = order(D06, [{ side: "caller", text: "It's 6294.", first: "It's 06294." }]);
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation], ["06294", true]);
});

test("the models agree in different spellings ('Two six' and '2-6'): no disagreement", () => {
  const o = order(D05, [
    { side: "caller", text: "Order 714.", first: "Order 714." },
    { side: "caller", text: "Two six.", first: "2-6." },
  ]);
  assert.deepEqual([o.match?.order.id, o.match?.needsConfirmation], ["71426", false]);
  const agree = order(D04, [{ side: "caller", text: "It's order five eight three one six.", first: "It's order 58316." }]);
  assert.deepEqual([agree.match?.order.id, agree.match?.needsConfirmation], ["58316", false]);
});

test("a number that is none of the customer's orders is never an exact match", () => {
  const o = order(D04, [{ side: "caller", text: "It's order 99999.", first: "It's order 99999." }]);
  assert.notEqual(o.state, "matched");
  const near = order(D04, [{ side: "caller", text: "It's order 58317." }]);
  assert.deepEqual([near.match?.order.id, near.match?.method, near.match?.needsConfirmation], ["58316", "closest", true]);
});

test("a typed correction replaces both readings: the agent's text is the answer", () => {
  const pack = D04;
  const lines = events([...verified(pack), { side: "caller", text: "It's order 58361.", first: "It's order 58316." }]);
  const o = analyze(pack, lines, [{ type: "correct", key: lines[lines.length - 1].key, text: "Order 58316", at: NOW - 1000 }], NOW).order;
  assert.deepEqual([o.match?.order.id, o.match?.method, o.match?.needsConfirmation], ["58316", "exact", false]);
});
