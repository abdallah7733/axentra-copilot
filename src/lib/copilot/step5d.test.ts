import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, approvalReadiness, type CopilotView } from "./copilot";
import { agentCommits } from "./signals";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Step 5 follow-up (Phase 5D of AXENTRA_CALL11_RECONCILIATION_AND_ROADMAP_2026-10-17.md): the defects
  the Call 11 reviews found in the approval rules and the suggested reply. Each test names its issue;
  each failed on ed0c53f (Step 5 as merged) before the fix.
*/

const NOW = Date.UTC(2026, 8, 27, 12);
type Line = { side: "caller" | "agent"; text: string; confidence?: number | null; checking?: boolean };

/** Script lines as transcript events, 5 s apart. */
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-step5d",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: l.confidence === undefined ? 0.9 : l.confidence,
    ...(l.checking ? { checking: true } : {}),
  }));
/** Script v2 up to line `upTo`, then `extra`. */
const script = (upTo: number, extra: Line[] = []): Line[] => [...scriptV2.filter((l) => l.n <= upTo).map((l) => ({ side: l.side, text: l.text })), ...extra];
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(sunlake, events(lines), actions, NOW);
/** Time of line n (1-based), plus a little. */
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;

const TO_REFUND: Line = { side: "caller", text: "Actually, I'd rather have my money back. A refund, please." };
const BACK_TO_TABLET: Line = { side: "caller", text: "Sorry, I've changed my mind again. The new tablet after all." };
const TABLET_DONE: Line = { side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one." };
const REFUND_DONE: Line = {
  side: "agent",
  text: "I've set up a full refund of $329.00 to your Visa ending 2208. It's issued when the carrier scans the return and takes 3 to 5 business days to appear.",
};
/** What the suggested reply must never say while the choice is being checked: an outcome as done. */
const COMMITS = /\b(done|ships? today|set up a full refund|refund of \$)/i;

/* ---------- I-23: an approval is only heard for the outcome it names ---------- */

test("I-23: with a refund chosen, a sentence promising the replacement is not the refund's approval", () => {
  const v = view(script(11, [TO_REFUND, TABLET_DONE]));
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.prepared?.kind, "refund");
  assert.notEqual(v.recommendation?.approval.state, "approved", '"Done. The new tablet ships today." must not approve the $329 refund');
  const h = v.recommendation?.history ?? [];
  assert.equal(h.length, 1);
  assert.equal(h[0].counted, false);
  assert.match(h[0].reason!, /named a replacement/);
  assert.match(v.recommendation?.staleApproval?.reason ?? "", /named a replacement/, "the reason shows next to Approve");
  assert.ok(v.keyAnswers.includes("k13"), "the line goes to the second check");
  assert.match(v.agentChecks.find((c) => c.key === "k13")!.reason, /named the replacement/);
});

test("I-23: the refund is still approved by a bare 'Done.' or by the refund sentence", () => {
  for (const said of [{ side: "agent" as const, text: "Done." }, REFUND_DONE]) {
    const v = view(script(11, [TO_REFUND, said]));
    assert.equal(v.recommendation?.approval.state, "approved", said.text);
    assert.equal(v.recommendation?.approval.via, "call");
  }
});

test("I-23 mirror: with a replacement chosen, a 'Done' line naming a refund is recorded as not counted, not dropped", () => {
  // Call 11 at 01:43: "…free refund…" after the replacement was approved left no entry at all (I-24).
  const v = view(script(12, [{ side: "agent", text: "Done. You'll also get a free refund label by email." }]));
  assert.equal(v.recommendation?.approval.state, "approved", "the earlier approval stands");
  const h = v.recommendation?.history ?? [];
  assert.equal(h.length, 2);
  assert.equal(h[1].counted, false);
  assert.match(h[1].reason!, /named a refund/);
  assert.ok(v.keyAnswers.includes("k13"));
  assert.match(v.agentChecks.find((c) => c.key === "k13")!.reason, /named the refund/);
  assert.match(doc(v, "Approval history") ?? "", /not counted \(it named a refund, not the replacement\)/);
});

/* ---------- I-22: while a change of choice is being checked ---------- */

test("I-22: during the hold of a spoken approval, the suggestion doesn't commit to an outcome", () => {
  const before = view(script(12));
  assert.doesNotMatch(before.suggestedReply!.text, COMMITS);
  const v = view(script(12, [{ ...TO_REFUND, checking: true }]));
  assert.ok(v.recommendation?.suspended, "the approval is on hold");
  assert.doesNotMatch(v.suggestedReply!.text, COMMITS, "Call 11: the hold switched it to 'Done. The new tablet ships today…'");
  assert.equal(agentCommits(v.suggestedReply!.text), null, "reading it aloud can't approve anything");
});

test("I-22: during the hold of a panel approval, the suggestion doesn't commit to an outcome", () => {
  const lines = script(11, [TO_REFUND, { side: "agent", text: "Of course." }, { ...BACK_TO_TABLET, checking: true }]);
  const v = view(lines, [{ type: "approve", at: at(13, 4000) }]);
  assert.ok(v.recommendation?.suspended, "the panel approval is on hold");
  assert.doesNotMatch(v.suggestedReply!.text, COMMITS);
  assert.equal(agentCommits(v.suggestedReply!.text), null);
});

test("I-22: a pending check holds an approval that hasn't been given yet: no Approve, neutral suggestion", () => {
  const v = view(script(11, [{ ...TO_REFUND, checking: true }]));
  assert.equal(v.recommendation?.prepared?.kind, "replacement");
  assert.equal(v.recommendation?.approval.state, "not-ready", "nothing to approve until the check settles");
  assert.ok(v.recommendation?.checkingChoice, "the panel says why");
  assert.doesNotMatch(v.suggestedReply!.text, COMMITS);
});

test("I-22: once the check settles on the same choice, the approval and the usual suggestion come back", () => {
  // First heard as a refund, checked as the tablet: the hold ends and the replacement approval stands.
  const held = view(script(12, [{ side: "caller", text: "Actually, a refund?", checking: true }]));
  assert.ok(held.recommendation?.suspended);
  const v = view(script(12, [{ side: "caller", text: "Actually, the new tablet is fine." }]));
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.checkingChoice, undefined);
  assert.equal(v.recommendation?.suspended, undefined);
  assert.doesNotMatch(v.suggestedReply!.text, /One moment/);
});

/* ---------- I-05 / I-24: a refused spoken approval says why, at once ---------- */

test("I-24: 'Done' before the item read-back shows its reason at once, and the transcript doesn't call it heard", () => {
  // Script v2 without the read-back on line 8.
  const lines = script(12);
  lines[7] = { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?" };
  const v = view(lines);
  assert.equal(v.recommendation?.prepared, undefined);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.match(v.recommendation?.staleApproval?.reason ?? "", /item wasn't confirmed/);
  const note = v.agentChecks.find((c) => c.key === "k12")!.reason;
  assert.doesNotMatch(note, /^approval heard/);
  assert.match(note, /item wasn't confirmed/);
});

/* ---------- I-25 / I-02: the item confirmation keeps both the press and the read-back ---------- */

const READ_BACK: Line = { side: "agent", text: "Just to confirm, that's order 427, the Sunlake Tab 11?" };
/** Script v2 without the read-back on line 8. */
const noReadBack = (upTo: number, extra: Line[] = []) => {
  const lines = script(upTo, extra);
  lines[7] = { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?" };
  return lines;
};

test("I-25: a press, then a read-back: the record keeps both, with seconds", () => {
  const press: AgentAction = { type: "confirm", target: "order", at: at(11, 4000) };
  const pressed = view(noReadBack(11), [press]);
  assert.equal(pressed.order.match?.confirmedBy, "panel");
  assert.ok(pressed.undoable.includes("order"), "Undo shows while the confirmation rests on the press");
  assert.match(doc(pressed, "Item confirmation") ?? "", /^confirmed in the panel at \d{2}:\d{2}:\d{2}/);

  const v = view(noReadBack(11, [READ_BACK]), [press]);
  assert.notEqual(v.order.match?.confirmedBy, "panel", "the read-back now carries it");
  const record = doc(v, "Item confirmation") ?? "";
  assert.match(record, /confirmed in the panel at \d{2}:\d{2}:\d{2}/, "the press isn't lost once a read-back follows");
  assert.match(record, /read back at \d{2}:\d{2}:\d{2}/);
});

test("I-02: an undone item press stays in the record as undone", () => {
  const press: AgentAction = { type: "confirm", target: "order", at: at(11, 4000) };
  const undo: AgentAction = { type: "undo", target: "order", at: at(11, 4800) };
  const v = view(noReadBack(11), [press, undo]);
  assert.equal(v.order.match?.confirmed, false);
  assert.match(doc(v, "Item confirmation") ?? "", /^confirmed in the panel at \d{2}:\d{2}:\d{2} [AP]M, undone at \d{2}:\d{2}:\d{2} [AP]M$/);
});

/* ---------- I-28: one moment per line, with seconds ---------- */

test("I-28: a spoken approval shows the same time, with seconds, in every part of the record", () => {
  const v = view(script(12));
  const start = new Date(at(12, 0)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  assert.equal(v.recommendation?.approval.via, "call");
  assert.match(doc(v, "Approval record")!, new RegExp(`, ${start}$`), "the line's start, not its end");
  assert.match(doc(v, "Approval history")!, new RegExp(`^${start} on the call: counted`));
  assert.match(doc(v, "Terms heard")!, new RegExp(`\\(${start}\\)`));
});

/* ---------- I-27: the card says what the agent can do now ---------- */

test("I-27: the recommendation says 'Within your authority' and whether it is ready, with what is missing", () => {
  const label = (v: CopilotView) => approvalReadiness(v);
  assert.equal(label(view(noReadBack(11))), "Within your authority. Not ready: read back the order first.");
  assert.equal(label(view(script(10))), "Within your authority. Not ready: the customer hasn't chosen yet.");
  assert.equal(label(view(script(11))), "Within your authority. Ready to approve.");
  assert.equal(label(view(script(11, [{ ...TO_REFUND, checking: true }]))), "Within your authority. Not ready: checking a possible change of choice.");
  assert.equal(label(view(script(12))), "Within your authority. Approved.");
});

test("I-27: a confirmed or typed identity factor reads 'Confirmed by the agent', not 'By confirmed by the agent'", () => {
  const lines = script(8);
  lines[4] = { side: "caller", text: "Sam Miller.", confidence: 0.3 };
  const v = view(lines, [{ type: "confirm", target: "name", at: at(5, 4000) }]);
  assert.equal(v.steps.find((s) => s.id === "name")!.detail, "Confirmed by the agent");
});
