import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import { matchAddress } from "./verification";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Step 5 of the revised plan: confirmation and identity behaviour. Each test names the issue in
  AXENTRA_ISSUE_REGISTER.md it closes; each failed on main (f14964e) before the fix.
*/

const NOW = Date.UTC(2026, 8, 27, 12);
type Line = { side: "caller" | "agent"; text: string; confidence?: number | null; checking?: boolean };

/** Script lines as transcript events, 5 s apart. */
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-step5",
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
const script = (replace: Record<number, Line | null> = {}, extra: Line[] = []): Line[] => [
  ...scriptV2.flatMap((l) => (l.n in replace ? (replace[l.n] ? [replace[l.n]!] : []) : [{ side: l.side, text: l.text }])),
  ...extra,
];
const view = (lines: Line[], actions: AgentAction[] = [], n = lines.length) => analyze(sunlake, events(lines).slice(0, n), actions, NOW);
/** Time of line n (1-based), plus a little. */
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
const step = (v: CopilotView, id: string) => v.steps.find((s) => s.id === id)!;
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;

// Script v2 without the item read-back on line 8 (call 9, outside review 14 Oct, 5.3).
const noReadBack = { 8: { side: "agent" as const, text: "Thank you, Sam. Is the damage only on the screen?" }, 13: null, 14: null, 15: null };

/* ---------- 5A: item confirmation before approval (I-01) ---------- */

test("I-01: neither a spoken nor a panel approval counts before the item is confirmed", () => {
  const s = script(noReadBack);
  const panel: AgentAction = { type: "approve", at: at(12, 4000) };
  const v = view(s, [panel]);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.confirmed, false);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.prepared, undefined, "nothing is prepared until the item is confirmed");
  assert.notEqual(v.recommendation?.approval.state, "approved", '"Done." on line 12 and the panel press both refused');
  assert.equal(step(v, "order").status, "done", "the order is located");
  assert.notEqual(step(v, "confirm").status, "done");
  assert.notEqual(step(v, "approval").status, "done");
  assert.notEqual(step(v, "docs").status, "done");
  assert.ok(v.documentation.every((d) => d.value === null || d.label === "Case summary"), "no resolution or approval recorded");
  assert.match(v.prompts.find((p) => p.target === "order")!.text, /hasn't been confirmed with the caller\. Read back order 427/);
  assert.equal(v.suggestedReply?.text, "Just to confirm, that's order 427, the Sunlake Tab 11?");
});

test("I-01: after the read-back, the earlier approvals stay refused and a fresh one counts", () => {
  const s = script(noReadBack, [
    { side: "agent", text: "Just to confirm, that's order 427, the Sunlake Tab 11?" },
    { side: "caller", text: "Yes." },
  ]);
  const panel: AgentAction = { type: "approve", at: at(12, 4000) };
  let v = view(s, [panel]);
  assert.equal(v.order.match?.confirmed, true);
  assert.equal(step(v, "confirm").status, "done");
  assert.equal(v.recommendation?.approval.state, "awaiting", "not revived by the later confirmation");
  assert.equal(v.recommendation?.staleApproval?.reason, "the item wasn't confirmed with the caller yet");

  v = view([...s, { side: "agent", text: "Done. The new tablet ships today." }], [panel]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "call");
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.counted, h.reason]),
    [
      ["call", false, "the item wasn't confirmed with the caller yet"],
      ["panel", false, "the item wasn't confirmed with the caller yet"],
      ["call", true, undefined],
    ]
  );
  assert.equal(step(v, "docs").status, "done");
});

test("I-01: when the read-back is lost from the transcript, the agent confirms the item in the panel, attributed", () => {
  const s = script(noReadBack);
  const v = view(s, [{ type: "confirm", target: "order", at: at(12, 4000) }, { type: "approve", at: at(12, 4500) }]);
  assert.equal(v.order.match?.confirmedBy, "panel");
  assert.match(step(v, "confirm").detail!, /^Item confirmed by the agent/);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.deepEqual(v.undoable, ["order"]);
});

test("a confirmation is bound to the order number it confirmed (plan Step 5, action 5)", () => {
  // The caller changes the number after the read-back, then goes back to it.
  const changed = script({ 9: { side: "caller", text: "Sorry, it's order 398." }, 10: null, 11: null, 12: null, 13: null, 14: null, 15: null });
  let v = view(changed);
  assert.equal(v.order.match?.order.id, "398");
  assert.equal(v.order.match?.confirmed, false, "the read-back of 427 doesn't confirm 398");

  const back = [...changed, { side: "caller" as const, text: "No, sorry, it is order 427 after all." }];
  v = view(back);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.confirmed, false, "the old read-back no longer stands");
  v = view([...back, { side: "agent", text: "Thanks. So that's order 427, the tablet." }]);
  assert.equal(v.order.match?.confirmed, true, "a fresh read-back does");

  // A Confirm press counts only for the order the panel showed when it was pressed.
  v = view(back, [{ type: "confirm", target: "order", at: at(9, 4000) }]);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.confirmed, false, "pressed while 398 was shown");
});

/* ---------- 5A: an accidental Confirm can be undone (I-02) ---------- */

test("I-02: undoing a name Confirm relocks the order, and the approval given while it stood doesn't come back", () => {
  const s = script({ 5: { side: "caller", text: "Sam Miller.", confidence: 0.4 } });
  const press: AgentAction = { type: "confirm", target: "name", at: at(5, 3500) };
  let v = view(s, [press]);
  assert.equal(v.verification.factors[0].method, "confirmed by the agent");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.deepEqual(v.undoable, ["name"]);

  const undo: AgentAction = { type: "undo", target: "name", at: at(15, 4000) };
  v = view(s, [press, undo]);
  assert.equal(v.verification.verified, false);
  assert.equal(v.verification.factors[0].state, "confirm");
  assert.equal(v.order.match, undefined, "order details relock");
  assert.equal(v.recommendation, null);
  assert.notEqual(step(v, "docs").status, "done");
  assert.deepEqual(v.undoable, []);

  // Confirmed again: identity is back, but the item read-back on line 8 came before this verification, so
  // it doesn't count and the item needs confirming again. The call-time approval stays refused; a fresh one counts.
  const again: AgentAction = { type: "confirm", target: "name", at: at(15, 4500) };
  v = view(s, [press, undo, again]);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.confirmed, false);
  const item: AgentAction = { type: "confirm", target: "order", at: at(15, 4600) };
  v = view(s, [press, undo, again, item]);
  // "Done." on line 12 was said while the name stood on the press now undone: it stays in the history,
  // not counted, with the reason, and doesn't come back.
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.counted, h.reason]),
    [["call", false, "a confirmation it relied on was undone"]],
  );
  assert.equal(v.recommendation?.staleApproval?.via, "call");
  assert.equal(v.recommendation?.staleApproval?.reason, "a confirmation it relied on was undone");
  assert.notEqual(v.recommendation?.staleApproval?.refused, true, "a withdrawn approval was an approval (Call 12 review)");
  v = view(s, [press, undo, again, item, { type: "approve", at: at(15, 5000) }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.match(doc(v, "Approval history")!, /on the call: not counted \(a confirmation it relied on was undone\); .* in the panel: counted/);
});

test("I-02: a spoken approval that relied on an undone item confirmation is kept in the history as invalidated", () => {
  const s = script(noReadBack, [{ side: "agent", text: "Done. The new tablet ships today." }]);
  const done = s.length; // the spoken approval, after the panel item confirmation
  const actions: AgentAction[] = [
    { type: "confirm", target: "order", at: at(done - 1, 4000) },
    { type: "undo", target: "order", at: at(done, 4000) },
  ];
  let v = view(s, actions.slice(0, 1));
  assert.equal(v.recommendation?.approval.state, "approved", "heard while the item confirmation stood");
  assert.equal(v.recommendation?.approval.via, "call");
  v = view(s, [...actions, { type: "confirm", target: "order", at: at(done, 4500) }]);
  assert.equal(v.recommendation?.approval.state, "awaiting", "confirming again doesn't revive it");
  const h = v.recommendation?.history ?? [];
  // Line 12's "Done." came before any item confirmation; the added one relied on the press now undone.
  assert.deepEqual(h.map((x) => [x.via, x.counted, x.reason]), [
    ["call", false, "the item wasn't confirmed with the caller yet"],
    ["call", false, "a confirmation it relied on was undone"],
  ]);
  assert.equal(h[1].evidence?.text, "Done. The new tablet ships today.");
  v = view(s, [...actions, { type: "confirm", target: "order", at: at(done, 4500) }, { type: "approve", at: at(done, 5000) }]);
  assert.match(doc(v, "Approval history")!, /on the call: not counted \(a confirmation it relied on was undone\); .* in the panel: counted/);
});

test("I-02: undoing the item confirmation withdraws the approval that relied on it", () => {
  const s = script(noReadBack);
  const actions: AgentAction[] = [
    { type: "confirm", target: "order", at: at(12, 4000) },
    { type: "approve", at: at(12, 4500) },
    { type: "undo", target: "order", at: at(12, 5000) },
  ];
  let v = view(s, actions);
  assert.equal(v.order.match?.confirmed, false);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  v = view(s, [...actions, { type: "confirm", target: "order", at: at(12, 6000) }]);
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.staleApproval?.reason, "a confirmation it relied on was undone");
});

/* ---------- 5A: identity completeness (plan Step 5, actions 6 and 8) ---------- */

test("a partial email is part of an answer, never a match and never a failed attempt", () => {
  const sam = sunlake.customers.find((c) => c.id === sunlake.callerCustomerId)!;
  assert.equal(matchAddress("s dot miller at example mail dot com", sam), "match");
  assert.equal(matchAddress("es miller at example mail dot com", sam), "match", "the letter said as its name");
  assert.equal(matchAddress("miller at example mail dot com", sam), "partial", "the initial is missing");
  assert.equal(matchAddress("at example mail dot com", sam), "partial");
  assert.equal(matchAddress("j dot miller at example mail dot com", sam), "mismatch", "a different initial");
  assert.equal(matchAddress("s dot miller at gmail dot com", sam), "mismatch", "a different domain");

  const s = script({
    6: { side: "agent", text: "Thank you. And the email address on the order?" },
    7: { side: "caller", text: "Miller at example mail dot com." },
  });
  const v = view(s, [], 8);
  assert.equal(v.verification.factors[1].state, "partial");
  assert.equal(v.verification.factors[1].attempts, 0);
  assert.equal(v.verification.verified, false);
  assert.equal(v.order.match, undefined);
});

/* ---------- 5B: a pending change of choice suspends the old approval (I-04) ---------- */

test("I-04: while a possible change of choice is being checked, the old approval is on hold", () => {
  const approved = script({ 13: null, 14: null, 15: null });
  assert.equal(view(approved).recommendation?.approval.state, "approved");

  const change: Line = { side: "caller", text: "Actually, I'd rather have a refund.", checking: true };
  let v = view([...approved, change]);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.suspended?.reason, "a possible change of choice is being checked");
  assert.equal(v.recommendation?.suspended?.via, "call");
  assert.equal(step(v, "approval").status, "attention");
  assert.equal(step(v, "approval").detail, "On hold: checking a possible change of choice");
  assert.notEqual(step(v, "docs").status, "done");

  // The check says the same choice: the approval stands again.
  v = view([...approved, { side: "caller", text: "Actually, the new one is fine." }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.suspended, undefined);
  // The check confirms the change: the old approval doesn't cover it.
  v = view([...approved, { side: "caller", text: "Actually, I'd rather have a refund." }]);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.staleApproval?.reason, "it was for a replacement");

  // A line being checked that doesn't read as a different choice changes nothing.
  v = view([...approved, { side: "caller", text: "Great, thank you.", checking: true }]);
  assert.equal(v.recommendation?.approval.state, "approved");
});

/* ---------- 5B: the record lists every approval and each term's line (I-16) ---------- */

test("I-16: the record lists every approval with its time, method and status, and each term with the line that said it", () => {
  const s = script();
  const v = view(s, [{ type: "approve", at: at(11, 4000) }]);
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.match(doc(v, "Approval history")!, /in the panel: counted; .* on the call: not counted \(already approved\)/);
  assert.equal(
    doc(v, "Terms heard"),
    `Ships today: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one." (${new Date(at(12, 0)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}); Return label: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one." (${new Date(at(12, 0)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })})`
  );
  assert.ok(v.documentation.every((d) => d.value), "every documentation row is filled");
});

/* ---------- 5C: why an agent line was or wasn't sent for the second check (I-05) ---------- */

test("I-05: the call 10 refund line isn't re-checked after a panel approval, and the reason is recorded", () => {
  const lines = script({ 13: null, 14: null, 15: null }, [
    { side: "caller", text: "Actually, I'd rather have my money back. A refund, please." },
    { side: "agent", text: "Afzata full refund of 329 dollars." },
  ]);
  const refundLine = `k${lines.length}`;
  // No press: the line is about the refund and no approval was heard in it, so it goes to the check.
  let v = view(lines);
  assert.ok(v.keyAnswers.includes(refundLine));
  assert.deepEqual(v.agentChecks.find((c) => c.key === refundLine), { key: refundLine, check: true, reason: "about the outcome, but no approval heard" });
  // Approved in the panel before the line: no approval to hear in it, but the card number isn't heard yet, so it is
  // checked for the terms (21 Oct stage call), and the record says why.
  v = view(lines, [{ type: "approve", at: at(lines.length - 1, 4000) }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.ok(v.keyAnswers.includes(refundLine));
  assert.deepEqual(v.agentChecks.find((c) => c.key === refundLine), { key: refundLine, check: true, reason: "a term isn't heard yet since the customer chose" });
  // Every agent line after the choice has a recorded decision.
  const choiceAt = 11; // the first choice, "A new one, please."
  const agentAfter = events(lines).filter((l) => l.side === "agent" && l.seq > choiceAt).map((l) => l.key);
  assert.deepEqual(v.agentChecks.map((c) => c.key), agentAfter);
});

/* ---------- The roadmap's Call 12 sequence, offline (Call 12 review: rows 2 to 7 weren't exercised live) ---------- */

test("§9.4 rows 1-12: early 'Done', press, spoken approval, Undo, read-back, fresh approval, refund, wrong line, panel approval", () => {
  const DONE: Line = { side: "agent", text: "Done. The new tablet ships today." };
  const s = script(noReadBack, [
    DONE, // 13: row 4, after the press
    { side: "agent", text: "Just to confirm, that's order 427, the Sunlake Tab 11?" }, // 14: row 6
    { side: "caller", text: "Yes." }, // 15
    DONE, // 16: row 7
    { side: "caller", text: "Actually, I'd rather have my money back. A refund, please." }, // 17: row 8
    DONE, // 18: row 10, the deliberate wrong line
    {
      side: "agent",
      text: "I've set up a full refund of $329.00 to your Visa ending 2208. It's issued when the carrier scans the return and takes 3 to 5 business days to appear. You'll get an email with a free return label.",
    }, // 19: row 12
  ]);
  const press: AgentAction = { type: "confirm", target: "order", at: at(12, 4000) };
  const undo: AgentAction = { type: "undo", target: "order", at: at(13, 4000) };
  const approve: AgentAction = { type: "approve", at: at(18, 4000) };

  // Rows 1-2: no read-back; line 12's "Done." is refused at once, with its reason.
  let v = view(s, [], 12);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.staleApproval?.reason, "the item wasn't confirmed with the caller yet");
  // Row 3: the press makes it ready, with Undo.
  v = view(s, [press], 12);
  assert.equal(v.order.match?.confirmedBy, "panel");
  assert.ok(v.undoable.includes("order"));
  assert.equal(v.recommendation?.approval.state, "awaiting", "the early 'Done' doesn't come back with the press");
  // Row 4: a fresh spoken approval counts.
  v = view(s, [press], 13);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "call");
  // Row 5: Undo withdraws it and relocks the item, and says why at once.
  v = view(s, [press, undo], 13);
  assert.equal(v.order.match?.confirmed, false);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.staleApproval?.reason, "a confirmation it relied on was undone");
  // Row 6: the read-back confirms the item, and the withdrawn approval stays withdrawn.
  v = view(s, [press, undo], 15);
  assert.equal(v.order.match?.confirmed, true);
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.staleApproval?.reason, "a confirmation it relied on was undone");
  // Row 7: a fresh spoken approval counts.
  v = view(s, [press, undo], 16);
  assert.equal(v.recommendation?.approval.state, "approved");
  // Rows 8-9: the refund needs its own approval; the replacement's doesn't cover it.
  v = view(s, [press, undo], 17);
  assert.equal(v.recommendation?.prepared?.kind, "refund");
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.match(v.recommendation?.staleApproval?.reason ?? "", /replacement/);
  assert.notEqual(v.recommendation?.staleApproval?.refused, true, "it was an approval, for the other outcome");
  // Row 10: the wrong line isn't the refund's approval.
  v = view(s, [press, undo], 18);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  // Rows 11-12: the panel approves the refund; the close-out line completes the record.
  v = view(s, [press, undo, approve]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.counted, h.reason]),
    [
      ["call", false, "the item wasn't confirmed with the caller yet"],
      ["call", false, "a confirmation it relied on was undone"],
      ["call", false, "it was for a replacement"], // row 7's approval, seen from the refund
      ["call", false, "it named a replacement, not the refund"],
      ["panel", true, undefined],
      ["call", false, "already approved"], // the close-out line
    ]
  );
  assert.match(doc(v, "Resolution") ?? "", /^Refund/);
  assert.doesNotMatch(doc(v, "Terms heard") ?? "", /not heard yet/);
  assert.equal(step(v, "docs").status, "done");
});
