import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWording, parseIntentLabel } from "./assist";

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
  const w = "You can have either. A new tablet ships today at no cost, or a full refund in 3 to 5 business days. Would you like the replacement or the refund, Sam?";
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
