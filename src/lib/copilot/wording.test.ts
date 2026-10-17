import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWording } from "./assist";
import { analyze } from "./copilot";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Call 11 (17 Oct 2026, console 792ebd6): the local model's rewording claimed actions nobody had done,
  and the wording check let it through (I-21, I-03; package 5D-2 of the Call 11 roadmap). Drafts here
  come from the rules engine in the same states.
*/

const NAMES = [...sunlake.customers.map((c) => c.name.split(" ")[0]), ...sunlake.orders.map((o) => o.shortName)];
const PEOPLE = [...sunlake.customers.map((c) => c.name), ...sunlake.orders.map((o) => o.customerName), sunlake.agent.name];
const NOW = Date.UTC(2026, 9, 17, 0, 18);
type Line = { side: "caller" | "agent"; text: string; checking?: boolean };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-c11",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: 0.9,
    ...(l.checking ? { checking: true } : {}),
  }));
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
const upTo = (n: number): Line[] => scriptV2.filter((l) => l.n <= n).map((l) => ({ side: l.side, text: l.text }));
const approve: AgentAction = { type: "approve", at: at(11, 4000) };
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(sunlake, events(lines), actions, NOW);
const refund: Line[] = [...upTo(10), { side: "caller", text: "A refund, please." }];
const DONE = "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one.";

const replacementApproved = view(upTo(11), [approve]).suggestedReply!.text;
const labelOnly = view([...upTo(11), { side: "agent", text: "Done. The new tablet ships today." }]).suggestedReply!.text;
const refundPrepared = view(refund).suggestedReply!.text;
const refundTerms = view([...refund, { side: "agent", text: "I've set up a full refund of $329 to your visa ending 2208." }]).suggestedReply!.text;
const accepted = (draft: string, worded: string, neutral = false) => checkWording(draft, worded, NAMES, PEOPLE, neutral);

/* ---------- (b) and (e): status, condition, unit, card, negation and approval words ---------- */

test("call 11: the rewording that invented a processed return and a placed order is rejected", () => {
  assert.equal(replacementApproved, "The new tablet ships today. You'll get an email with a free return label for the damaged one.");
  const shown =
    "We've processed the return for the damaged tablet and a replacement order for the new tablet has been placed. You'll receive an email with a free return label for the damaged one, and the new tablet will ship today.";
  assert.equal(accepted(replacementApproved, shown), null);
});

test("call 11: the rewording that added a second, prepaid shipping label is rejected", () => {
  assert.equal(labelOnly, "You'll get an email with a free return label for the damaged one.");
  assert.equal(accepted(labelOnly, "You'll receive an email with a free return label for the damaged one, and we'll also include a prepaid return shipping label for your convenience."), null);
});

test("call 11 at video 110 s: a rewording that drops or adds the approval words is rejected", () => {
  assert.equal(view(upTo(11)).suggestedReply!.text, DONE);
  assert.equal(accepted(DONE, "We've processed your request for a replacement tablet, which will be shipped today. You'll get an email with a free return label for the damaged one."), null);
  assert.equal(accepted(DONE, "The new tablet ships today. You'll get an email with a free return label for the damaged one."), null, "'Done' dropped");
  assert.equal(
    accepted(replacementApproved, "We've processed the return for the damaged tablet and a replacement order has been placed. It ships today, and you'll get an email with a free return label."),
    null
  );
  assert.equal(accepted(replacementApproved, "All set. The new tablet ships today. You'll get an email with a free return label for the damaged one."), null, "approval words added");
});

test("claims that an action already happened are rejected in other words too, for both outcomes", () => {
  for (const [draft, worded] of [
    [replacementApproved, "Your replacement order has been placed and the new tablet ships today. You'll get an email with a free return label for the damaged one."],
    [replacementApproved, "The new tablet has already shipped today, and the email with your free return label for the damaged one has been sent."],
    [replacementApproved, "Your new tablet has been dispatched today and the free return label for the damaged one has been emailed to you."],
    [replacementApproved, "The new tablet arrives today. You'll get an email with a free return label for the damaged one."],
    [replacementApproved, "The new tablet won't ship today. You'll get an email with a free return label for the damaged one."],
    [labelOnly, "We've sent you an email with a free return label for the damaged one."],
    [labelOnly, "The free return label for the damaged one has been sent and the return is processed."],
    [refundPrepared, "Your full refund of $329.00 to your Visa ending 2208 has been issued and takes 3 to 5 business days to appear. You'll get an email with a free return label."],
    [refundPrepared, "Your full refund of $329.00 is on its way to your Visa ending 2208 and takes 3 to 5 business days to appear. You'll get an email with a free return label."],
    [refundPrepared, "Your full refund of $329.00 has been refunded to your Visa ending 2208 and takes 3 to 5 business days to appear. You'll get an email with a free return label."],
    [refundTerms, "It was issued when the carrier scanned the return and takes 3 to 5 business days to appear. The free return label has already been emailed."],
  ]) {
    assert.equal(accepted(draft, worded), null, worded);
  }
});

test("a rewording may not drop a condition or change a unit or the card", () => {
  assert.equal(accepted(refundPrepared, refundPrepared.replace("It's issued when the carrier scans the return and takes", "It's issued right away and takes")), null);
  assert.equal(accepted(refundTerms, "It takes 3 to 5 hours to appear. You'll get an email with a free return label."), null);
  assert.equal(accepted(refundPrepared, refundPrepared.replace("Visa", "mastercard")), null);
  assert.equal(accepted(labelOnly, "You'll get an email with a free return label; you can keep the damaged one."), null);
});

test("a faithful rewording of the same outcome still passes the check", () => {
  const worded = "You'll receive an email with a free return label for the damaged one, and the new tablet will ship today.";
  assert.equal(accepted(replacementApproved, worded), worded);
});

/* ---------- (c): a neutral line may add only politeness words ---------- */

const ASK_NAME = "I'm sorry to hear that. Before I look at the order, can I have your full name, please?";

test("a neutral line may not gain a name or a claim, in any of the 7 forms that passed before", () => {
  for (const worded of [
    "Afzata I'm sorry to hear that. Before I look at the order, can I have your full name, please?",
    "I'm sorry to hear that afzata. Before I look at the order, can I have your full name, please?",
    "I'm sorry to hear that mr afzata, before I look at the order can I have your full name, please?",
    "Thank you afzata. Before I look at the order, can I have your full name, please?",
    "I'm sorry to hear that. Before I look at the order, afzata, can I have your full name, please?",
    "I'm sorry to hear that. Before I look at the order, can I have your full name, please, ms afzata?",
    "I'm sorry to hear that, you're verified. Before I look at the order, can I have your full name, please?",
    "I'm sorry to hear that. Your replacement is on its way. Can I have your full name, please?",
  ]) {
    assert.equal(accepted(ASK_NAME, worded, true), null, worded);
  }
});

test("plain rewordings of a neutral line are kept", () => {
  for (const [draft, worded] of [
    [ASK_NAME, "I'm really sorry to hear that. Before I look into the order, could I have your full name, please?"],
    [ASK_NAME, "Of course, sorry to hear that. Can I have your full name before I look at the order, please?"],
    ["Is there anything else I can help with?", "Is there anything else I can help you with?"],
    ["Is there anything else I can help with?", "Can I help with anything else?"],
    ["Thank you. And the email address on the order, or the street and city for the delivery?", "Thanks. Could you give me the email address on the order, or the street and city for the delivery?"],
  ]) {
    assert.equal(accepted(draft, worded, true), worded, worded);
  }
});

/* ---------- (a): only neutral lines go to the local model ---------- */

test("only lines without order facts, amounts, outcomes or status may be reworded", () => {
  const rewordable = (lines: Line[], actions: AgentAction[] = []) => view(lines, actions).suggestedReply?.rewordable;
  assert.equal(rewordable(upTo(2)), true, "the name request");
  assert.equal(rewordable(upTo(5)), true, "the address request");
  assert.equal(rewordable([...upTo(11), { side: "agent", text: DONE }]), true, "the closing question");
  assert.equal(rewordable([...upTo(11), { side: "caller", text: "Actually, a refund?", checking: true }]), true, "the hold line");
  assert.equal(rewordable(upTo(7)), false, "'you're verified' and the order");
  assert.equal(rewordable(upTo(10)), false, "the options line");
  assert.equal(rewordable(upTo(11)), false, "the prepared replacement");
  assert.equal(rewordable(upTo(11), [approve]), false, "the replacement terms");
  assert.equal(rewordable(refund), false, "the prepared refund");
  const noReadBack = upTo(11);
  noReadBack[7] = { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?" };
  assert.equal(rewordable(noReadBack), false, "the item read-back");
});
