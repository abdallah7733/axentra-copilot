import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import { agentCommits } from "./signals";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Call 12 (18 Oct 2026, console 834b17b) replayed with its real timings, and the fixes its review
  adopted (AXENTRA_CALL12_REVIEW_AND_RECONCILIATION_2026-10-18.md). Call clock C is seconds since call
  start, placed at 02:25:05.2 PM Cairo; the call connected about 3.5 s into the recording. Line starts and
  ends come from a silence map of the recording (C = V - 3.75, within about 0.3 s of the engine's own
  times), first-text delays and check times from the end-of-call transcript, the two panel actions from
  video frames: the name typed at about C 37, Approve pressed at about C 133.85, while the 02:04 refund
  line was still being checked. There was no item press and no Undo.
*/

const T0 = Date.parse("2026-10-18T11:25:05.200Z"); // C 00:00 = 02:25:05.2 PM Cairo (UTC+3)
const c = (s: number) => T0 + Math.round(s * 1000);

type L = { side: "caller" | "agent"; text: string; s: number; e: number; delay: number; check?: number; conf?: number; first?: string };
const L12: L[] = [
  { side: "agent", text: "thank you for calling Sunlake how can I help you today", s: 1.0, e: 5.1, delay: 3.2, conf: 0.4 }, // k1
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked.", s: 6.0, e: 13.05, delay: 1.1, check: 6.0, first: "Hello I Need Help" }, // k2
  { side: "agent", text: "I'm sorry to hear that first can I have your full name please.", s: 15.0, e: 19.06, delay: 1.8 }, // k3
  { side: "caller", text: "Tanninus.", s: 21.0, e: 21.76, delay: 0.9, check: 2.2, first: "Timeless. Timeless." }, // k4
  { side: "agent", text: "Thank you and the street and city for the delivery.", s: 38.0, e: 43.4, delay: 1.0 }, // k5
  { side: "caller", text: "Hill Road in Dallas.", s: 44.48, e: 46.5, delay: 1.0, check: 2.3, first: "Fill rot in dandles." }, // k6
  { side: "agent", text: "Thank you Sam. Is the damage only on the screen?", s: 52.46, e: 55.8, delay: 1.0 }, // k7
  { side: "caller", text: "Yes, only the screen.", s: 57.7, e: 59.44, delay: 0.9 }, // k8
  { side: "agent", text: "You can have either a new tablet ships today at no coast or a full refund once the carrier scans your return. It takes three to five business days to appear which do you prefer.", s: 63.0, e: 74.34, delay: 1.1 }, // k9
  { side: "caller", text: "A new one, please.", s: 76.0, e: 77.4, delay: 0.9, check: 2.3, first: "And you want please." }, // k10
  { side: "agent", text: "Just to confirm that's order 427 the Sunleak tab 11?", s: 95.12, e: 99.59, delay: 1.1 }, // k11, C 01:35
  { side: "caller", text: "Actually, I'd rather have my money back. A refund, please.", s: 104.38, e: 108.47, delay: 1.1, check: 4.0, first: "Actually, I'd rather have my money back. Are you found, please?" }, // k12
  { side: "agent", text: "Done. The new tablet ships today.", s: 119.82, e: 121.96, delay: 0.9, check: 2.4 }, // k13, C 01:59, deliberate wrong line
  { side: "agent", text: "of set a full refund of 329 to your visa ending 2208.", s: 124.13, e: 131.57, delay: 1.1, check: 2.4, first: "I have set a full refund of 329 to your visa ending 2208" }, // k14, C 02:04
  { side: "agent", text: "It's issued when the carrier scanned the return and takes 3-5 business days to appear. You'll get an email with a free refund level.", s: 134.75, e: 144.35, delay: 1.5 }, // k15, C 02:14
  { side: "caller", text: "Great. Thank you.", s: 146.85, e: 148.59, delay: 0.8 },
  { side: "agent", text: "Is there anything else I can help with?", s: 149.59, e: 151.59, delay: 1.0 },
  { side: "caller", text: "No that's on. Why?", s: 153.19, e: 155.81, delay: 0.8, conf: 0.4 },
];

/**
 * The transcript as the panel had it at call time t: a line appears its first-text delay after it ends,
 * with its first-heard text while the second check runs (left out by the rules), then the checked text.
 */
const linesAt = (t: number, ls: L[] = L12): TranscriptEvent[] =>
  ls.flatMap((l, i) => {
    const shown = c(l.e + l.delay);
    if (shown > c(t)) return [];
    const base = { callId: "CA-call12", seq: i + 1, key: `k${i + 1}`, side: l.side, startedAt: c(l.s), endedAt: c(l.e), final: true as const, confidence: l.conf ?? 0.9 };
    if (l.check === undefined) return [{ ...base, text: l.text, availableAt: shown }];
    const checked = c(l.e + l.delay + l.check);
    return [checked <= c(t) ? { ...base, text: l.text, availableAt: checked, ...(l.first ? { firstHeard: l.first } : {}) } : { ...base, text: l.first ?? l.text, availableAt: shown, checking: true }];
  });

const TYPE_NAME: AgentAction = { type: "correct", key: "k4", text: "Sam Miller", at: c(37) };
const APPROVE: AgentAction = { type: "approve", at: c(133.85) };
const ACTIONS = [TYPE_NAME, APPROVE];
const at = (t: number, ls: L[] = L12, actions: AgentAction[] = ACTIONS): CopilotView =>
  analyze(sunlake, linesAt(t, ls), actions.filter((a) => a.at <= c(t)), c(t));
const END = 158;
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;
const step = (v: CopilotView, id: string) => v.steps.find((s) => s.id === id)!;
const hms = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* ---------- What Call 12 showed, kept as it was ---------- */

test("Call 12 replay ends as the call ended: refund, approved in the panel, the wrong line not counted", () => {
  const v = at(END);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.equal(doc(v, "Resolution"), "Refund RF-2026-092701-01");
  assert.equal(doc(v, "Approval history"), `${hms(c(119.82))} on the call: not counted (it named a replacement, not the refund); ${hms(c(133.85))} in the panel: counted`);
  assert.equal(doc(v, "Item confirmation"), `read back at ${hms(c(95.12))} ("Just to confirm that's order 427 the Sunleak tab 11?")`);
  assert.equal(step(v, "name").detail, "Typed by the agent");
});

test("Call 12 replay: no Approve while the read-back was missing, and the hold while the refund request was checked", () => {
  assert.equal(at(85).recommendation?.approval.state, "not-ready", "after 'A new one, please.', before the read-back");
  assert.equal(at(102).recommendation?.approval.state, "awaiting", "after the read-back");
  const hold = at(111); // C 01:44 line shown at 109.6, checked at 113.6
  assert.ok(hold.recommendation?.checkingChoice);
  assert.notEqual(hold.recommendation?.approval.state, "awaiting");
  assert.equal(hold.suggestedReply?.text, "One moment, please, while I make sure I have your choice right.");
  assert.equal(at(115).recommendation?.prepared?.kind, "refund");
});

/* ---------- K1: the spoken refund approval would not have counted ---------- */

test("Call 12: the 02:04 refund line goes to the second check because no approval was heard in it", () => {
  // Shown at 132.67 with its first-heard text and checked at 135.07; the rules leave it out until then.
  assert.equal(at(133).agentChecks.some((x) => x.key === "k14"), false);
  const asIfSeen = analyze(sunlake, linesAt(133).map((l) => (l.key === "k14" ? { ...l, checking: false } : l)), [TYPE_NAME], c(133));
  assert.ok(asIfSeen.keyAnswers.includes("k14"));
  assert.equal(asIfSeen.agentChecks.find((x) => x.key === "k14")?.reason, "about the outcome, but no approval heard");
});

test("Call 12 without the panel press: neither hypothesis of the refund line approves, and the panel asks the agent", () => {
  for (const t of [133, 136, END]) {
    const v = at(t, L12, [TYPE_NAME]);
    assert.notEqual(v.recommendation?.approval.state, "approved", `t=${t}`);
  }
  const v = at(136, L12, [TYPE_NAME]);
  assert.equal(v.recommendation?.unheardApproval?.text, "of set a full refund of 329 to your visa ending 2208.");
  assert.equal(agentCommits("I have set a full refund of 329 to your visa ending 2208"), null, "'set a' is not read as 'set up'");
});

/* ---------- K2: a never-counted line is not "the approval" ---------- */

test("Call 12: while the refund line was checked, the wrong-outcome line is shown as not counted, not as an approval to give again", () => {
  const v = at(133.5); // the moment of the press: only the refused line is in view
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.staleApproval?.refused, true);
  assert.equal(v.recommendation?.staleApproval?.reason, "it named a replacement, not the refund");
});

/* ---------- RC12-01: the amount recognition dropped the "$" from ---------- */

test("Call 12: the refund amount and card are heard from 'refund of 329 … ending 2208'; the misheard label stays unheard", () => {
  const terms = doc(at(END), "Terms heard")!;
  assert.match(terms, /^Refund amount and card: "of set a full refund of 329 to your visa ending 2208\." \(/);
  assert.match(terms, /When it's issued and how long it takes: "It's issued when/);
  assert.match(terms, /Return label: not heard yet$/, "'free refund level' is never turned into 'free return label'");
  assert.equal(at(END).suggestedReply?.text, "You'll get an email with a free return label.");
});

const NOW = Date.UTC(2026, 8, 27, 12);
/** Script v2 to the read-back, a refund choice, Approve in the panel, then the agent's terms lines. */
const refundWith = (...said: string[]) => {
  const lines = [...scriptV2.filter((l) => l.n <= 10), { side: "caller" as const, text: "A refund, please." }, ...said.map((text) => ({ side: "agent" as const, text }))];
  const events: TranscriptEvent[] = lines.map((l, i) => ({
    callId: "CA-terms",
    seq: i + 1,
    key: `t${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: 0.9,
  }));
  return analyze(sunlake, events, [{ type: "approve", at: NOW - 600_000 + 10 * 5000 + 4000 }], NOW);
};
const amountHeard = (v: CopilotView) => !/Refund amount and card: not heard yet/.test(doc(v, "Terms heard") ?? "");

test("RC12-01: the refund amount counts with '$', 'dollars' or straight after 'refund of', and only when it is the order's", () => {
  assert.equal(refundWith("I've set up a full refund of $329.00 to your Visa ending 2208.").recommendation?.approval.state, "approved");
  assert.ok(amountHeard(refundWith("I've set up a full refund of $329.00 to your Visa ending 2208.")));
  assert.ok(amountHeard(refundWith("A full refund of 329 dollars to your Visa ending 2208.")));
  assert.ok(amountHeard(refundWith("A full refund of 329 to your Visa ending 2208.")));
  assert.ok(amountHeard(refundWith("A full refund of 329.00 to your Visa ending 2208.")));
  assert.ok(!amountHeard(refundWith("A full refund of 299 to your Visa ending 2208.")), "a different amount");
  assert.ok(!amountHeard(refundWith("A full refund to your Visa ending 2208.")), "card digits without an amount");
  assert.ok(!amountHeard(refundWith("That's order 427, refunded to your Visa ending 2208.")), "the order number is not money");
  // Negation is the shared three-word check ("no", "not", "don't"…); "haven't" isn't in it yet (Step 7-8 fixtures).
  assert.ok(!amountHeard(refundWith("There's no refund of 329 to your Visa ending 2208.")), "negated");
  assert.ok(!amountHeard(refundWith("A full refund of 299, sorry, 329 dollars to your Visa ending 2208.")), "a corrected wrong amount: both were said");
  assert.ok(!amountHeard(refundWith("A full refund of 329 to your Visa ending 1234.")), "the wrong card");
});

/* ---------- RC12-03: approved isn't documented while a term is unheard ---------- */

test("RC12-03: the Documentation step stays open, naming what isn't heard, until every term is heard", () => {
  const partial = refundWith("A full refund of 329 to your Visa ending 2208.");
  assert.equal(partial.recommendation?.approval.state, "approved");
  assert.equal(step(partial, "approval").status, "done");
  assert.equal(step(partial, "docs").status, "active");
  assert.equal(step(partial, "docs").detail, "Not heard yet: when it's issued and how long it takes, return label");
  const full = refundWith(
    "A full refund of 329 to your Visa ending 2208.",
    "It's issued when the carrier scans the return and takes 3 to 5 business days to appear. You'll get an email with a free return label."
  );
  assert.equal(step(full, "docs").status, "done");
  assert.equal(step(full, "docs").detail, "Terms heard on the call");
  assert.equal(full.suggestedReply?.text, "Is there anything else I can help with?");
  assert.equal(step(at(END), "docs").detail, "Not heard yet: return label", "Call 12 itself");
});

/* ---------- RC12-04: "I have" is "I've"; nothing looser ---------- */

test("RC12-04: 'I have' counts as 'I've' in an approval; negations, questions and 'set a' don't", () => {
  assert.equal(agentCommits("I have set up a full refund of $329.00 to your Visa ending 2208."), "i have set up");
  assert.equal(agentCommits("I've set up a full refund of $329.00 to your Visa ending 2208."), "i've set up");
  assert.equal(agentCommits("I have not set up the refund yet."), null);
  assert.equal(agentCommits("I haven't sent it yet."), null);
  assert.equal(agentCommits("Have I sent you the label?"), null);
  assert.equal(agentCommits("of set a full refund of 329 to your visa ending 2208."), null);
  const v = refundWith();
  assert.equal(v.recommendation?.approval.state, "approved", "panel approval in the helper");
});
