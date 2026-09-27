import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrderMentions, matchOrder } from "./orders";
import { sunlake } from "@/lib/live/sunlake-data";

const sam = sunlake.orders.filter((o) => o.customerId === sunlake.callerCustomerId);
const mentions = (text: string, expecting = false) => findOrderMentions(text, [3], expecting);
const first = (text: string) => mentions(text)[0];

// Real recognised lines from the Milestone 2 calls (plan §7).
test('"order for 27" reads as 427, sound-alike', () => {
  const m = first("I need help with order for 27. It arrived with a cracked screen.");
  assert.equal(m.candidates[0], "427");
  assert.equal(m.method, "sound-alike");
  assert.equal(m.heard, "for 27");
});

test('"order 4 to 7" on the agent side reads as 427, sound-alike', () => {
  const m = first("I can send a replacement for order 4 to 7 today.");
  assert.equal(m.candidates[0], "427");
  assert.equal(m.method, "sound-alike");
});

test('"order 527" is heard as 527, exact', () => {
  const m = first("I need help with order 527. Arised with a crack.");
  assert.deepEqual(m.candidates, ["527"]);
  assert.equal(m.method, "exact");
});

test('"to the order 427" is exact', () => {
  const m = first("I need help to the order 427, it arrive to the track screen.");
  assert.deepEqual(m.candidates, ["427"]);
  assert.equal(m.method, "exact");
});

test('"Order 4-7" (accuracy read, 27 Sep) reads as 427, sound-alike; "3-5 business days" is still a duration', () => {
  const m = first("Order 4-7");
  assert.equal(m.candidates[0], "427");
  assert.equal(m.method, "sound-alike");
  assert.deepEqual(mentions("A full refund in 3-5 business days."), []);
});

test("spoken digits: four two seven, four twenty-seven", () => {
  assert.equal(first("It's order four two seven.").candidates[0], "427");
  assert.equal(first("It's order four two seven.").method, "spoken");
  assert.equal(first("Order four twenty-seven.").candidates[0], "427");
  assert.equal(mentions("It's four two seven.")[0].candidates[0], "427");
});

// Durations are never order numbers (content §8).
for (const text of [
  "I can ship it in 4 to 7 days.",
  "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Which do you prefer?",
  "It takes 2 weeks.",
  "It was $329.",
  "The 128 GB model.",
  "Refund reference RF-2026-092701-01.",
  "A new one, please.",
]) {
  test(`not an order number: "${text}"`, () => assert.deepEqual(mentions(text), []));
}

test('un-anchored "4 to 7" counts only when the agent just asked for the order number', () => {
  assert.deepEqual(mentions("It's 4 to 7."), []);
  assert.equal(mentions("It's 4 to 7.", true)[0].candidates[0], "427");
  assert.equal(mentions("It's for 27.", true)[0].candidates[0], "427");
  assert.deepEqual(mentions("It's 4 to 7 days.", true), []);
});

test("a stranger's order is never matched: 527 resolves to Sam's 427 for confirmation", () => {
  const match = matchOrder(mentions("I need help with order 527."), sam, 30)!;
  assert.equal(match.order.id, "427");
  assert.equal(match.method, "closest");
  assert.equal(match.needsConfirmation, true);
  assert.equal(match.order.customerName, "Sam Miller");
  assert.ok(!match.note.includes("Laura"));
});

test("digit swaps 247 and 472 (other customers' orders) are never returned", () => {
  for (const heard of ["order 247", "order 472"]) {
    const match = matchOrder(mentions(heard), sam, 30);
    assert.ok(!match || match.order.customerId === sunlake.callerCustomerId);
  }
});

test("sound-alike match needs confirmation; exact does not", () => {
  assert.equal(matchOrder(mentions("order 4 to 7"), sam, 30)!.needsConfirmation, true);
  assert.equal(matchOrder(mentions("order 427"), sam, 30)!.needsConfirmation, false);
});

test("no number heard: suggest the only order delivered inside the window, to confirm", () => {
  const match = matchOrder([], sam, 30)!;
  assert.equal(match.order.id, "427");
  assert.equal(match.method, "only-recent");
  assert.equal(match.needsConfirmation, true);
});

test("the earbuds order (398) is found when asked for directly", () => {
  assert.equal(matchOrder(mentions("order 398"), sam, 30)!.order.id, "398");
});
