import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWording, parseIntentLabel, sameWording } from "./assist";
import { sunlake } from "@/lib/live/sunlake-data";

const names = ["Sam", "Sunlake Tab 11"];
const draft =
  "Thanks, Sam, you're verified. I can see the Sunlake Tab 11 on order 427, delivered yesterday. I can ship a replacement today at no cost, with a free return label for the damaged one, or give you a full refund if you'd prefer.";

test("a faithful rewording is kept", () => {
  const worded =
    "Thanks, Sam, you're all verified. Your Sunlake Tab 11 from order 427 arrived yesterday, so I can ship a replacement today at no cost with a free return label, or give you a full refund if you'd prefer.";
  assert.equal(checkWording(draft, worded, names), worded);
});

test("a changed number is rejected", () => {
  assert.equal(checkWording(draft, draft.replace("427", "527"), names), null);
});

test("an added or dropped offer is rejected", () => {
  assert.equal(checkWording(draft, draft.replace(", or give you a full refund if you'd prefer", ""), names), null);
  const scenarioA = "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one.";
  assert.equal(checkWording(scenarioA, scenarioA + " I can also refund you.", names), null);
});

test("the same offer in other words is kept; a new kind of offer is not", () => {
  const d = "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Which do you prefer?";
  const w = "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Would you like the replacement or the refund?";
  assert.equal(checkWording(d, w, names), w);
  assert.equal(checkWording(d, w.replace("Would you like", "I can also transfer you. Would you like"), names), null);
});

test("an added amount is rejected", () => {
  const d = "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Which do you prefer?";
  assert.equal(checkWording(d, d.replace("a full refund", "a full refund of $329"), names), null);
});

test("dropping the customer's name or the product is rejected", () => {
  assert.equal(checkWording(draft, draft.replace("Sam, ", ""), names), null);
  assert.equal(checkWording(draft, draft.replace("Sunlake Tab 11", "tablet"), names), null);
});

test("quotes are trimmed; empty or list answers are rejected", () => {
  assert.equal(checkWording("Can I have your full name, please?", '"Could I have your full name, please?"', names), "Could I have your full name, please?");
  assert.equal(checkWording("Can I have your full name, please?", "", names), null);
  assert.equal(checkWording("Can I have your full name, please?", "Sure:\n- name\n- email", names), null);
});

test("intent labels", () => {
  assert.equal(parseIntentLabel("damaged"), "damaged");
  assert.equal(parseIntentLabel("Order_status"), "order-status");
  assert.equal(parseIntentLabel("other"), null);
});

/* ---------- I-03: names in a suggested reply come from the verified record, never from the model ---------- */

const people = [...sunlake.customers.map((c) => c.name), ...sunlake.orders.map((o) => o.customerName), sunlake.agent.name];
const sorry = "I'm sorry to hear that. Before I look at the order, can I have your full name, please?";

test("I-03: a name the model adds is rejected, in any capitalisation (call 10, 'Afzata')", () => {
  for (const worded of [
    "I'm sorry to hear that, Afzata. Before I look at the order, can I have your full name, please?",
    "I'm sorry to hear that, afzata. Before I look at the order, can I have your full name, please?",
    "Afzata, I'm sorry to hear that. Before I look at the order, can I have your full name, please?",
    "Hi afzata, I'm sorry to hear that. Before I look at the order, can I have your full name, please?",
    "I'm so sorry to hear that, and I'll help you, Mr Afzata. Can I have your full name, please, before I look at the order?",
  ]) {
    assert.equal(checkWording(sorry, worded, names, people), null, worded);
  }
});

test("I-03: another customer's name, or even the verified customer's, is rejected when the draft has none", () => {
  assert.equal(checkWording(sorry, "I'm sorry to hear that, Laura. Before I look at the order, can I have your full name, please?", names, people), null);
  assert.equal(checkWording(sorry, "I'm sorry to hear that, laura king. Before I look at the order, can I have your full name, please?", names, people), null);
  assert.equal(checkWording(sorry, "I'm sorry to hear that, Sam. Before I look at the order, can I have your full name, please?", names, people), null);
  // Where the draft has the verified name, the rewording keeps it and adds no other.
  assert.equal(checkWording(draft, draft.replace("Thanks, Sam,", "Thanks, Sam Miller,"), names, people), null);
  assert.equal(checkWording(draft, draft.replace("Thanks, Sam,", "Thank you, Sam,"), names, people), draft.replace("Thanks, Sam,", "Thank you, Sam,"));
});

test("I-03: a neutral rewording with no name is kept", () => {
  for (const worded of [
    "I'm really sorry to hear that. Before I look into the order, could I have your full name, please?",
    "Sorry to hear that. I'll need your full name first, please, before I look at the order.",
    "Of course, sorry to hear that. Can I have your full name before I look at the order, please?",
  ]) {
    assert.equal(checkWording(sorry, worded, names, people), worded, worded);
  }
});

test("Call 12: the draft given back unchanged is not called reworded", () => {
  const d = "Sorry, could you say your full name once more?";
  assert.equal(sameWording(d, d), true);
  assert.equal(sameWording(d, `"${d}"`), true, "quotes around it");
  assert.equal(sameWording(d, " sorry,  could you say your full name once more? "), true, "case and spaces");
  assert.equal(sameWording("I can’t hear you.", "I can't hear you."), true, "curly apostrophe");
  assert.equal(sameWording(d, "Sorry, could you say your full name again, please?"), false);
});
