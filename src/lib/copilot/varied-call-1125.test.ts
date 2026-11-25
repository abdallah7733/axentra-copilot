import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { helenFoster, samMiller, sunlake, variedCallOrders, withVariedCall } from "@/lib/live/sunlake-data";

/*
  The varied live call (his "Varied live call", 25 Nov 2026): Helen Foster, Lincoln Avenue in Denver, order 615, with a
  caller whose voice has never been on a call. The data is a build setting (NEXT_PUBLIC_VARIED_CALL=1, off unless set).
  These tests fix, before the call, what the console's rules do with the script's words heard exactly as written, on C12
  with all six switches on: the expected results the call is judged against. They say nothing about recognition: live,
  each answer is only as good as what the speech models write.
*/
const T = Date.UTC(2026, 10, 26, 12);
const pack: ClientPack = (() => {
  const p = withVariedCall(sunlake);
  return { ...p, policy: { ...p.policy, agentConfirmsMatch: true, strictMatch: true, nameReadBack: true, addressReadBack: true, questionInCheck: true, noNameNotCounted: true } };
})();
type L = { side: "caller" | "agent"; text: string; s: number; e: number };
const events = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-varied",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T + l.s,
    endedAt: T + l.e,
    final: true,
    confidence: 0.9,
    ...(l.side === "caller" ? { checked: true } : {}),
  }));
const factor = (v: CopilotView, id: "name" | "address") => v.verification.factors.find((f) => f.id === id)!;
const prompt = (v: CopilotView, id: string) => v.prompts.find((p) => p.target === id);
const step = (v: CopilotView, id: string) => v.steps.find((s) => s.id === id)!;

const OPENING = "Hi. I'm calling about order 615. My tablet arrived two days ago, and the screen is smashed.";
/** The script's call, rows 1 to 16, with the times the agent presses Confirmed (name, street and city) and Approve. */
const call = (opening = OPENING, name = "Helen Foster.", address = "Lincoln Avenue, in Denver."): { lines: L[]; presses: AgentAction[] } => ({
  lines: [
    { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2500 },
    { side: "caller", text: opening, s: 3500, e: 9500 },
    { side: "agent", text: "I'm sorry to hear that. First, can I have your full name, please?", s: 13_000, e: 16_500 },
    { side: "caller", text: name, s: 17_500, e: 19_000 },
    { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 25_000, e: 28_000 },
    { side: "caller", text: address, s: 29_000, e: 31_000 },
    { side: "agent", text: "Thank you, Helen.", s: 37_000, e: 38_200 },
    { side: "agent", text: "I can see the tablet on order 615.", s: 39_700, e: 41_900 },
    { side: "agent", text: "Is the damage only on the screen?", s: 43_400, e: 45_200 },
    { side: "caller", text: "Yes, just the screen. Can I get a replacement, or a refund?", s: 46_200, e: 49_700 },
    { side: "agent", text: "Just to confirm, that's order 615, the Sunlake Tab 11?", s: 53_200, e: 56_200 },
    { side: "caller", text: "Yes, that's right.", s: 57_200, e: 58_200 },
    { side: "agent", text: "You can have either. A new tablet ships today at no cost, or a full refund once the carrier scans your return; it takes 3 to 5 business days to appear.", s: 61_700, e: 70_700 },
    { side: "agent", text: "A new tablet or a refund: which do you prefer?", s: 72_200, e: 74_700 },
    { side: "caller", text: "A replacement, please.", s: 75_700, e: 77_000 },
    { side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one.", s: 87_500, e: 93_500 },
  ],
  presses: [
    { type: "confirm", target: "name", at: T + 23_500 },
    { type: "confirm", target: "address", at: T + 35_500 },
    { type: "approve", at: T + 82_000 },
  ],
});
const upTo = (lines: L[], n: number) => events(lines.slice(0, n));

test("the switch: every call is Sam Miller's unless the build sets NEXT_PUBLIC_VARIED_CALL=1", () => {
  const on = process.env.NEXT_PUBLIC_VARIED_CALL === "1";
  assert.equal(sunlake.callerCustomerId, on ? helenFoster.id : samMiller.id);
  assert.equal(sunlake.customers.some((c) => c.id === helenFoster.id), on);
});

test("the varied data: Helen Foster is the caller; Sam Miller and his orders stay as another customer's", () => {
  assert.equal(pack.callerCustomerId, helenFoster.id);
  assert.deepEqual(pack.customers.map((c) => c.name), ["Helen Foster", "Sam Miller"]);
  assert.deepEqual(
    pack.orders.filter((o) => o.customerId === helenFoster.id).map((o) => o.id),
    ["615", "283"]
  );
  // The decoys are other customers' orders, and every order number keeps Sunlake's three digits.
  assert.deepEqual(
    variedCallOrders.filter((o) => o.customerId !== helenFoster.id).map((o) => o.id),
    ["715", "156", "561"]
  );
  assert.deepEqual([...new Set(pack.orders.map((o) => o.id.length))], [3]);
  // Same SOP, policy and product as Sam Miller's order 427.
  assert.equal(pack.sop, sunlake.sop);
  assert.equal(pack.orders.find((o) => o.id === "615")!.shortName, pack.orders.find((o) => o.id === "427")!.shortName);
  assert.ok(pack.orders.find((o) => o.id === "615")!.price < pack.policy.photoRequiredFrom);
});

test("expected results, heard word for word: each key moment of the script", () => {
  const { lines, presses } = call();
  // Row 2: the problem and the order number, locked until the identity check.
  let v = analyze(pack, upTo(lines, 2), [], T + 13_000);
  assert.equal(v.intent?.id, "damaged");
  assert.equal(step(v, "issue").status, "done");
  assert.equal(v.order.state, "heard");
  assert.equal(v.order.heard?.reading, "615");
  assert.equal(step(v, "order").detail, "Heard 615; locked until identity check");
  // Row 4: the name, checked with his question in front, waits for his press.
  v = analyze(pack, upTo(lines, 4), [], T + 22_500);
  assert.deepEqual(v.checkContext, { k4: "k3" });
  assert.equal(factor(v, "name").state, "confirm");
  assert.equal(factor(v, "name").confirmReason, "match");
  assert.equal(factor(v, "name").attempts, 0);
  assert.match(prompt(v, "name")!.text, /^Heard "Helen Foster\.", which matches the name on the order\./);
  assert.equal(prompt(v, "name")!.askAgain, undefined);
  // Row 6: the street and city, the same way.
  v = analyze(pack, upTo(lines, 6), presses.slice(0, 1), T + 34_500);
  assert.deepEqual(v.checkContext, { k4: "k3", k6: "k5" });
  assert.equal(step(v, "name").detail, "Confirmed by the agent");
  assert.equal(factor(v, "address").confirmReason, "match");
  assert.match(prompt(v, "address")!.text, /^Heard "Lincoln Avenue, in Denver\.", which matches the street and city on the order\./);
  // After both presses: verified, and order 615 unlocks as an exact match.
  v = analyze(pack, upTo(lines, 6), presses.slice(0, 2), T + 36_500);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "615");
  assert.equal(v.order.match?.method, "exact");
  assert.equal(step(v, "order").detail, "#615");
  // Row 11 (his second sentence) reads the order back; row 12 asks about both, so A or B.
  v = analyze(pack, upTo(lines, 10), presses.slice(0, 2), T + 53_000);
  assert.equal(v.order.match?.confirmed, true);
  assert.equal(step(v, "confirm").detail, "Order read back; damage described by the caller");
  assert.equal(v.recommendation?.scenario, "A");
  assert.equal(v.recommendation?.alsoAllowed, "B");
  // Row 14: "A replacement, please." is the choice; Approve is his.
  v = analyze(pack, upTo(lines, 15), presses.slice(0, 2), T + 81_000);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.prepared?.reference, "RP-2026-112501-01");
  // His Approve, then the terms line: documentation complete.
  v = analyze(pack, upTo(lines, 16), presses, T + 97_000);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(step(v, "docs").status, "done");
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value!, /^Helen Foster \(CU-418736\), order 615 Sunlake Tab 11/);
});

test("speech alone verifies nothing: without his presses the call never unlocks the order", () => {
  const { lines } = call();
  const v = analyze(pack, events(lines), [], T + 97_000);
  assert.equal(v.verification.verified, false);
  assert.equal(factor(v, "name").state, "confirm");
  assert.equal(v.order.match, undefined);
  assert.notEqual(v.recommendation?.approval.state, "approved");
});

test("what-ifs for the off-script rules: a near name, a misheard order number", () => {
  // A first name heard as another name: a Please confirm card that only sounds like the record. He presses only if he
  // clearly heard "Helen Foster".
  const near = call(OPENING, "Allen Foster.");
  let v = analyze(pack, upTo(near.lines, 4), [], T + 22_500);
  assert.equal(factor(v, "name").confirmReason, "sounds-like");
  assert.match(prompt(v, "name")!.text, /^Name unclear\./);
  // Order 715 (another customer's) heard for 615: never matched to that customer; the closest of hers, to confirm.
  const decoy = call(OPENING.replace("615", "715"));
  v = analyze(pack, upTo(decoy.lines, 6), decoy.presses.slice(0, 2), T + 36_500);
  assert.equal(v.order.match?.order.id, "615");
  assert.equal(v.order.match?.method, "closest");
  assert.equal(v.order.match?.needsConfirmation, true);
  // Order 650: no match in her orders; asked again, "Six one five." finds it.
  const miss = call(OPENING.replace("615", "650"));
  v = analyze(pack, upTo(miss.lines, 6), miss.presses.slice(0, 2), T + 36_500);
  assert.equal(v.order.state, "unmatched");
  assert.equal(step(v, "order").detail, "No match in this customer's orders");
  const again: L[] = [
    ...miss.lines.slice(0, 6),
    { side: "agent", text: "Sorry, could you give me the order number again, please?", s: 37_000, e: 40_000 },
    { side: "caller", text: "Six one five.", s: 41_000, e: 42_500 },
  ];
  v = analyze(pack, events(again), miss.presses.slice(0, 2), T + 45_000);
  assert.equal(v.order.match?.order.id, "615");
  assert.equal(v.order.match?.method, "spoken");
});
