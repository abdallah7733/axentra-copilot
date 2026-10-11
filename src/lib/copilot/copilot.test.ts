import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

const NOW = Date.UTC(2026, 8, 27, 12);
type Line = { side: "caller" | "agent"; text: string; confidence?: number | null };

/** Turns script lines into transcript events, 5 s apart. */
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-test",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: l.confidence === undefined ? 0.9 : l.confidence,
  }));

/** Script v2 with some line numbers replaced (content §5 numbering). */
const script = (replace: Record<number, Line | null> = {}): Line[] =>
  scriptV2.flatMap((l) => (l.n in replace ? (replace[l.n] ? [replace[l.n]!] : []) : [{ side: l.side, text: l.text }]));

const after = (lines: Line[], n: number, actions: AgentAction[] = []) => analyze(sunlake, events(lines).slice(0, n), actions, NOW);
const step = (v: CopilotView, id: string) => v.steps.find((s) => s.id === id)!.status;
const alert = (v: CopilotView, id: string) => v.alerts.find((a) => a.id === id);
const stranger = /Laura|King|laptop|899/;

test("script v2, line by line (content §5)", () => {
  const s = script();
  let v = after(s, 1);
  assert.equal(v.intent, null);
  assert.equal(v.recommendation, null);

  v = after(s, 2);
  assert.equal(v.intent?.id, "damaged");
  assert.equal(v.intent?.certainty, "high");
  assert.ok(v.intent!.phrases.some((p) => p.includes("screen is cracked")));
  assert.equal(v.intent?.sopId, "CS-SOP-3.1");
  assert.equal(v.order.state, "heard");
  assert.equal(v.order.heard?.reading, "427");
  assert.equal(v.order.match, undefined, "order details stay locked until the identity check");
  assert.equal(step(v, "name"), "active");

  v = after(s, 3);
  const early = alert(v, "offer-before-verification")!;
  assert.equal(early.title, "Resolution offered before identity check");
  assert.equal(early.sopRef, "CS-SOP-3.1 · Verification");
  assert.equal(early.evidence[0].seq, 3);
  assert.equal(early.resolved, undefined);

  v = after(s, 4);
  assert.equal(v.verification.factors[0].state, "asking");

  v = after(s, 5);
  assert.equal(v.verification.factors[0].state, "ok");
  assert.equal(v.verification.factors[0].evidence?.seq, 5);
  assert.equal(v.verification.verified, false);

  v = after(s, 7);
  assert.equal(v.verification.verified, true);
  assert.equal(v.verification.verifiedAt?.seq, 7);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.order.deliveredLabel, "yesterday");
  assert.deepEqual(
    v.checks.map((c) => [c.id, c.pass]),
    [["window", true], ["stock", true], ["value", true], ["claims", true], ["photo", true]]
  );
  assert.equal(v.recommendation?.scenario, "A");
  assert.equal(v.recommendation?.agentCanApprove, true);
  assert.equal(v.recommendation?.authorityRow, 0);
  assert.ok(alert(v, "offer-before-verification")!.resolved);
  assert.equal(
    v.suggestedReply?.text,
    "Thanks, Sam, you're verified. I can see the Sunlake Tab 11 on order 427, delivered yesterday. I can ship a replacement today at no cost, with a free return label for the damaged one, or give you a full refund if you'd prefer."
  );

  v = after(s, 8);
  assert.equal(v.order.match?.confirmed, true);
  assert.equal(step(v, "confirm"), "done");

  v = after(s, 9);
  assert.equal(v.recommendation?.alsoAllowed, "B");
  assert.equal(v.choice, null);

  v = after(s, 10);
  assert.equal(v.order.match?.order.id, "427", '"3 to 5 business days" is not an order number');
  assert.equal(v.recommendation?.approval.state, "not-ready");

  v = after(s, 11);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.prepared?.reference, "RP-2026-092701-01");
  assert.equal(v.recommendation?.approval.state, "awaiting");

  v = after(s, 12);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "call");
  assert.ok(v.documentation.every((d) => d.value), "documentation checklist filled");

  v = after(s, 15);
  assert.ok(v.steps.every((x) => x.status === "done"));
  assert.equal(v.alerts.filter((a) => !a.resolved).length, 0);
});

test("demo moment 2: line 2 heard as '4 to 7' or 'for 27' matches 427 and asks to confirm", () => {
  for (const heard of ["Hello. I need help with order 4 to 7. The tablet came yesterday, and the screen is cracked.", "Hello. I need help with order for 27. The tablet came yesterday, and the screen is cracked."]) {
    const s = script({ 2: { side: "caller", text: heard } });
    let v = after(s, 2);
    assert.equal(v.order.heard?.reading, "probably 427");
    v = after(s, 7);
    assert.equal(v.order.match?.order.id, "427");
    assert.equal(v.order.match?.needsConfirmation, true);
    assert.equal(v.order.match?.confirmed, false);
    assert.ok(v.prompts.some((p) => p.target === "order"));
    assert.match(v.suggestedReply!.text, /confirm, is it order 427/);
    v = after(s, 8);
    assert.equal(v.order.match?.confirmed, true, "the agent's read-back on line 8 confirms it");
    assert.ok(!v.prompts.some((p) => p.target === "order"));
  }
});

test("demo moment 2: '527' never shows Laura King's order; Sam's 427 is suggested to confirm", () => {
  const s = script({ 2: { side: "caller", text: "Hello. I need help with order 527. The tablet came yesterday, and the screen is cracked." } });
  let v = after(s, 2);
  assert.equal(v.order.heard?.reading, "527");
  assert.equal(v.order.match, undefined);
  v = after(s, 7);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.method, "closest");
  assert.equal(v.order.match?.needsConfirmation, true);
  for (const n of [2, 5, 7, 8, 15]) assert.doesNotMatch(JSON.stringify(after(s, n)), stranger);
});

test("demo moment 2: no number at all suggests Sam's one recent order", () => {
  const s = script({ 2: { side: "caller", text: "Hello. The tablet came yesterday, and the screen is cracked." } });
  const v = after(s, 7);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.method, "only-recent");
  assert.equal(v.order.match?.needsConfirmation, true);
});

test("branch: chargeback → Scenario C, no promise", () => {
  const s = script({ 9: { side: "caller", text: "This is the second time. If it happens again, I will call my bank for a chargeback." } });
  const v = after(s, 9);
  assert.equal(v.recommendation?.scenario, "C");
  assert.equal(v.recommendation?.agentCanApprove, false);
  assert.match(v.recommendation!.action, /Don't promise a replacement or refund/);
  assert.ok(alert(v, "escalation-words"));
  assert.equal(step(v, "choice"), "skipped");
  // The scripted agent line 10 offers both anyway: that is flagged.
  assert.ok(alert(after(s, 10), "offer-during-escalation"));
});

test("branch: safety → Scenario C with unplug first", () => {
  const s = script({ 9: { side: "caller", text: "Also, the tablet is getting very hot." } });
  const v = after(s, 9);
  assert.equal(v.recommendation?.scenario, "C");
  assert.match(v.recommendation!.action, /stop using and unplug the device/);
  assert.equal(alert(v, "safety")?.level, "danger");
  assert.match(v.suggestedReply!.text, /stop using the tablet and unplug it/);
});

test("branch: refund → Scenario B with RF reference", () => {
  const s = script({ 9: { side: "caller", text: "I just want my money back." }, 10: null, 11: null });
  const v = after(s, 9);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.scenario, "B");
  assert.equal(v.recommendation?.prepared?.reference, "RF-2026-092701-01");
  assert.ok(v.recommendation?.prepared?.lines.some((l) => l.includes("3 to 5 business days")));
});

test("branch: failed check → one attempt left, order stays locked, then locked after two", () => {
  const s = script({ 7: { side: "caller", text: "Lake Road, in Houston." } });
  let v = after(s, 7);
  const failed = alert(v, "verification-failed-address")!;
  assert.match(failed.detail, /One attempt left\. Don't say which detail didn't match\./);
  assert.equal(v.verification.verified, false);
  assert.equal(v.order.match, undefined);
  assert.doesNotMatch(v.suggestedReply!.text, /street|city|name|email/i);

  const twice = [...s.slice(0, 7), { side: "agent" as const, text: "Could you give me the street and city once more?" }, { side: "caller" as const, text: "Lake Road, in Houston." }];
  v = after(twice, twice.length);
  assert.equal(v.verification.locked, true);
  assert.ok(alert(v, "verification-locked"));
  assert.equal(v.order.match, undefined);
  assert.equal(v.recommendation, null);
});

test("naming the failed detail is flagged", () => {
  const s = [...script({ 7: { side: "caller", text: "Lake Road, in Houston." } }).slice(0, 7), { side: "agent" as const, text: "Sorry, the city doesn't match." }];
  assert.ok(alert(after(s, s.length), "disclosed-factor"));
});

test("low-confidence lines never tick a step on their own", () => {
  const s = script({ 5: { side: "caller", text: "Sam Miller.", confidence: 0.4 }, 7: { side: "caller", text: "Hill Road, in Dallas.", confidence: 0.45 } });
  let v = after(s, 7);
  assert.equal(v.verification.factors[0].state, "confirm");
  assert.equal(v.verification.factors[1].state, "confirm");
  assert.equal(v.verification.verified, false);
  assert.notEqual(step(v, "name"), "done");
  assert.ok(v.prompts.some((p) => p.target === "name"));
  // The agent confirms in the panel: that is the agent's decision, so it counts.
  const at = NOW - 500_000;
  v = after(s, 7, [{ type: "confirm", target: "name", at }, { type: "confirm", target: "address", at }]);
  assert.equal(v.verification.verified, true);
});

test("low-confidence problem statement: intent flagged, order heard but needs confirming (plan §7)", () => {
  const s = script({ 2: { side: "caller", text: "Hello, Axentra, I need help to the order 427, it arrive to the track screen.", confidence: 0.5 } });
  let v = after(s, 2);
  assert.equal(v.intent?.id, "damaged");
  assert.equal(v.intent?.certainty, "low");
  assert.equal(step(v, "issue"), "attention");
  v = after(s, 7);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.needsConfirmation, true);
});

test("'It arards with a track screen' still reads as damaged, with low certainty", () => {
  const v = after([{ side: "caller", text: "It arards with a track screen." }], 1);
  assert.equal(v.intent?.id, "damaged");
  assert.equal(v.intent?.certainty, "low");
});

test("every recommendation, alert and reply cites the SOP and a transcript line", () => {
  const variants = [
    script(),
    script({ 9: { side: "caller", text: "This is the second time. I will call my bank for a chargeback." } }),
    script({ 9: { side: "caller", text: "Also, the tablet is getting very hot." } }),
    script({ 9: { side: "caller", text: "I just want my money back." }, 10: null, 11: null }),
    script({ 7: { side: "caller", text: "Lake Road, in Houston." } }),
  ];
  for (const s of variants) {
    for (let n = 1; n <= s.length; n++) {
      const v = after(s, n);
      if (v.recommendation) {
        assert.match(v.recommendation.sopRef, /^CS-SOP-3\.1 · /);
        assert.ok(v.recommendation.evidence.length > 0, `recommendation at line ${n} has evidence`);
      }
      for (const a of v.alerts) {
        assert.match(a.sopRef, /^CS-SOP-3\.1 · /);
        if (!a.id.startsWith("check-")) assert.ok(a.evidence.length > 0, `${a.id} has evidence`);
      }
      if (v.suggestedReply) assert.match(v.suggestedReply.sopRef, /^CS-SOP-3\.1 · /);
    }
  }
});

test("approval in the panel works when the agent doesn't say 'done'", () => {
  const s = script({ 12: null });
  const v = after(s, s.length, [{ type: "approve", at: NOW - 1000 }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
});

test("eligibility is computed from the data: out of stock → B, over $500 → C", () => {
  const withOrder = (patch: Partial<(typeof sunlake.orders)[number]>) => ({
    ...sunlake,
    orders: sunlake.orders.map((o) => (o.id === "427" ? { ...o, ...patch } : o)),
  });
  const lines = events(script()).slice(0, 8);
  assert.equal(analyze(withOrder({ inStock: false }), lines, [], NOW).recommendation?.scenario, "B");
  const big = analyze(withOrder({ price: 899 }), lines, [], NOW);
  assert.equal(big.recommendation?.scenario, "C");
  assert.ok(big.checks.find((c) => c.id === "value" && !c.pass));
  const late = analyze(withOrder({ deliveredDaysAgo: 45 }), lines, [], NOW);
  assert.equal(late.recommendation?.scenario, "C");
});

test("lines are read in speech order, not arrival order", () => {
  const e = events(script()).slice(0, 7);
  const shuffled = [e[6], e[2], e[0], e[4], e[1], e[5], e[3]];
  assert.deepEqual(analyze(sunlake, shuffled, [], NOW), analyze(sunlake, e, [], NOW));
});

/* ---------- Identity answers split by a pause (accuracy read, 27 Sep) ---------- */

/** Script v2 up to line 6, then caller lines `gapMs` apart, all ending before `NOW - 60 s`. */
function splitAnswer(parts: Line[], gapMs: number) {
  const base = events(script().slice(0, 6));
  const t0 = base[base.length - 1].endedAt + 1000;
  const tail: TranscriptEvent[] = parts.map((p, i) => ({
    callId: "CA-test",
    seq: 7 + i,
    key: `split${i}`,
    side: p.side,
    text: p.text,
    startedAt: t0 + i * (1000 + gapMs),
    endedAt: t0 + i * (1000 + gapMs) + 1000,
    final: true,
    confidence: p.confidence === undefined ? 0.9 : p.confidence,
  }));
  return [...base, ...tail];
}
const caller = (text: string, confidence?: number): Line => ({ side: "caller", text, confidence });

test('"Hill Road," + "in Dallas." in two lines is one answer and verifies', () => {
  const v = analyze(sunlake, splitAnswer([caller("Hill Road,"), caller("in Dallas.")], 700), [], NOW);
  assert.equal(v.verification.verified, true);
  assert.equal(v.verification.factors[1].attempts, 0);
});

test('"Helrout." + "Indalis." asks the agent to confirm and is never a failed attempt', () => {
  const lines = splitAnswer([caller("Helrout."), caller("Indalis.")], 700);
  let v = analyze(sunlake, lines, [], NOW);
  const address = v.verification.factors[1];
  assert.equal(address.state, "confirm");
  assert.equal(address.confirmReason, "sounds-like");
  assert.equal(address.attempts, 0);
  assert.equal(v.verification.verified, false);
  assert.ok(v.prompts.some((p) => p.target === "address" && p.text.includes("Helrout. Indalis.")));
  assert.ok(!v.alerts.some((a) => a.id.startsWith("verification-")));
  v = analyze(sunlake, lines, [{ type: "confirm", target: "address", at: NOW - 1000 }], NOW);
  assert.equal(v.verification.verified, true);
});

test('phone-line version "elroad indale" also asks to confirm', () => {
  const v = analyze(sunlake, splitAnswer([caller("Elroad."), caller("Indale.")], 700), [], NOW);
  assert.equal(v.verification.factors[1].state, "confirm");
});

test("a wrong answer counts only when the caller has finished", () => {
  const lines = splitAnswer([caller("Lake Road,")], 0);
  const endedAt = lines[lines.length - 1].endedAt;
  let v = analyze(sunlake, lines, [], endedAt + 500);
  assert.equal(v.verification.factors[1].state, "asking", "still listening half a second later");
  assert.equal(v.verification.factors[1].attempts, 0);
  v = analyze(sunlake, lines, [], endedAt + 2500);
  assert.equal(v.verification.factors[1].state, "failed");
  assert.equal(v.verification.factors[1].attempts, 1);
  // The agent speaking also ends the answer.
  const withAgent = [...lines, { ...lines[lines.length - 1], key: "agent-next", seq: 99, side: "agent" as const, text: "Okay.", startedAt: endedAt + 300, endedAt: endedAt + 900 }];
  v = analyze(sunlake, withAgent, [], endedAt + 1000);
  assert.equal(v.verification.factors[1].attempts, 1);
});

/* ---------- Live call, 10 Oct 2026 (Script v2, read as written; lines as the console heard them) ---------- */

const call1010: Line[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?" },
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked." },
  { side: "agent", text: "I'm sorry to hear that I can send you a new one today." },
  { side: "agent", text: "First, can I have your full name please?" },
  { side: "caller", text: "San milis.", confidence: 0.4 },
  { side: "agent", text: "Thank you and the street and city for the delivery." },
  { side: "caller", text: "HELLROOT INDONES" },
  { side: "agent", text: "Thank you Sam. I can see the tablet on order 427" },
  { side: "agent", text: "Is the damage only on the screen?" },
  { side: "caller", text: "Yes, only the screen. Can I get a new one or my money back?" },
  { side: "agent", text: "You can have either a new tablet ships today at no cost or a full refund in 3 to 5 business days." },
  { side: "agent", text: "Which do you prefer?" },
  { side: "caller", text: "Anyone please?", confidence: 0.4 },
  { side: "agent", text: "Done." },
  { side: "agent", text: "The new tablet strips today." },
  { side: "agent", text: "You'll get an email with a free return label for the damaged one." },
  { side: "caller", text: "Great. Thank you." },
];
const lineAt = (i: number) => events(call1010)[i].startedAt;

test("10 Oct call: the address question without '?' still waits for the address", () => {
  // The agent confirmed the name in the panel while asking for the address (both orders tested).
  for (const nameConfirmedAt of [lineAt(5) + 1000, lineAt(6) + 1000]) {
    const actions: AgentAction[] = [{ type: "confirm", target: "name", at: nameConfirmedAt }];
    let v = after(call1010, 6, actions);
    assert.equal(v.verification.factors[1].state, "asking");
    assert.equal(step(v, "address"), "active");

    v = after(call1010, 7, actions);
    const address = v.verification.factors[1];
    assert.equal(address.state, "confirm", "sounds like Hill Road in Dallas: the agent decides");
    assert.equal(address.confirmReason, "sounds-like");
    assert.equal(address.attempts, 0);
    assert.ok(v.prompts.some((p) => p.target === "address" && p.text.includes("HELLROOT INDONES")));
    assert.equal(v.verification.verified, false, "never a match on its own");
    assert.equal(v.order.match, undefined, "order stays locked");

    // Not confirmed: the order stays locked to the end and nothing is approved.
    v = after(call1010, call1010.length, actions);
    assert.equal(v.verification.verified, false);
    assert.equal(v.order.match, undefined);
    assert.equal(v.recommendation, null);
    assert.equal(v.verification.factors[0].state, "ok");
  }
});

test("10 Oct call: once the agent confirms the address, the flow continues; 'Anyone please?' asks again", () => {
  const actions: AgentAction[] = [
    { type: "confirm", target: "name", at: lineAt(5) + 1000 },
    { type: "confirm", target: "address", at: lineAt(6) + 3500 },
  ];
  let v = after(call1010, 8, actions);
  assert.equal(v.verification.verified, true);
  assert.equal(v.verification.factors[1].method, "confirmed by the agent");
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.confirmed, true, "the agent read the order back");
  assert.ok(alert(v, "offer-before-verification")!.resolved);

  v = after(call1010, 12, actions);
  assert.equal(alert(v, "offer-before-verification")!.evidence.length, 1, "the 00:50 offer came after verification");

  v = after(call1010, 13, actions);
  assert.equal(v.choice, null);
  const ask = v.prompts.find((p) => p.target === "choice")!;
  assert.ok(ask.askAgain);
  assert.match(ask.text, /Anyone please\?/);
  assert.equal(step(v, "choice"), "attention");
  assert.equal(v.suggestedReply?.text, "Sorry, I didn't catch that. Would you like the new tablet, or the refund?");

  // "Done." with no choice recorded approves nothing.
  v = after(call1010, call1010.length, actions);
  assert.equal(v.recommendation?.approval.state, "not-ready");
  assert.ok(v.prompts.some((p) => p.target === "choice" && p.askAgain), "a later 'Great. Thank you.' doesn't clear it");

  // Asked again, the caller answers clearly: the choice is recorded and the replacement is prepared.
  const retry: Line[] = [
    ...call1010.slice(0, 13),
    { side: "agent", text: "Sorry, I didn't catch that. Would you like the new tablet, or the refund?" },
    { side: "caller", text: "A new one, please." },
    { side: "agent", text: "Done. The new tablet ships today." },
  ];
  v = after(retry, 15, actions);
  assert.equal(v.choice?.value, "replacement");
  assert.ok(!v.prompts.some((p) => p.target === "choice"));
  assert.equal(v.recommendation?.prepared?.kind, "replacement");
  v = after(retry, 16, actions);
  assert.equal(v.recommendation?.approval.state, "approved");
});

test("an unreadable choice can still be answered with low confidence, then confirmed", () => {
  const actions: AgentAction[] = [
    { type: "confirm", target: "name", at: lineAt(5) + 1000 },
    { type: "confirm", target: "address", at: lineAt(6) + 3500 },
  ];
  const lines: Line[] = [...call1010.slice(0, 13), { side: "agent", text: "Which would you like?" }, { side: "caller", text: "A new one please.", confidence: 0.4 }];
  let v = after(lines, lines.length, actions);
  assert.equal(v.choice, null);
  const prompt = v.prompts.find((p) => p.target === "choice")!;
  assert.ok(!prompt.askAgain, "now there is something to confirm");
  v = after(lines, lines.length, [...actions, { type: "confirm", target: "choice", at: NOW - 1000 }]);
  assert.equal(v.choice?.value, "replacement");
});

/* ---------- Retest on the fixed build, 10 Oct 2026 (lines as the console heard them) ---------- */

const retest1010: Line[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today.", confidence: 0.4 },
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen cracked." },
  { side: "agent", text: "I'm sorry to hear that I can send you a new one today. First can I have your full name please." },
  { side: "caller", text: "Ten milis. Ten milis. Ten milis." },
  { side: "agent", text: "Thank you." },
  { side: "agent", text: "And the street and city for the delivery." },
  { side: "caller", text: "Hail Rode in Dallas.", confidence: 0.4 },
  { side: "agent", text: "Thank you Sam! I can see the tablet on 427", confidence: 0.4 },
  { side: "caller", text: "Yes, only the screen. Can I get a new one or my money back?" },
  { side: "agent", text: "You can have either and new tablet ships today at no cost or full refund in 3 to 5 business days", confidence: 0.4 },
  { side: "agent", text: "Which do you prefer?" },
  { side: "caller", text: "And you want these." },
  { side: "agent", text: "Done. New tablet ships today.", confidence: 0.4 },
];

test("10 Oct retest: a garbled name is the agent's call, never a failed attempt", () => {
  let v = after(retest1010, 5);
  const name = v.verification.factors[0];
  assert.equal(name.state, "confirm");
  assert.equal(name.confirmReason, "garbled");
  assert.equal(name.attempts, 0);
  assert.ok(!v.alerts.some((a) => a.id.startsWith("verification-failed")));
  assert.match(v.prompts.find((p) => p.target === "name")!.text, /looks garbled/);

  v = after(retest1010, 7);
  assert.equal(v.verification.factors[1].state, "confirm", '"Hail Rode in Dallas" matches but was heard with low confidence');
  assert.equal(v.verification.verified, false);
  assert.equal(v.order.match, undefined);

  // The agent heard both clearly and confirms them: the call carries on.
  const at = events(retest1010)[6].endedAt + 500;
  const actions: AgentAction[] = [{ type: "confirm", target: "name", at }, { type: "confirm", target: "address", at }];
  v = after(retest1010, 8, actions);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "427");
  v = after(retest1010, retest1010.length, actions);
  assert.ok(v.prompts.some((p) => p.target === "choice" && p.askAgain), '"And you want these." asks again');
  assert.equal(v.recommendation?.approval.state, "not-ready");
});

test("a clear wrong name still counts as a failed attempt", () => {
  const s = script({ 5: { side: "caller", text: "John Smith." } });
  const v = after(s, 6);
  assert.equal(v.verification.factors[0].state, "failed");
  assert.equal(v.verification.factors[0].attempts, 1);
});

/** The second retest on 10 Oct (4.20 PM recording), as the console heard it. */
const call3: Line[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today.", confidence: 0.4 },
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen cracked." },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today." },
  { side: "agent", text: "First, can I have your full name please?" },
  { side: "caller", text: "Sanmilis.", confidence: 0.4 },
  { side: "agent", text: "Thank you and the street and city for the delivery." },
  { side: "caller", text: "One road in Dallas." },
  { side: "agent", text: "Thank you Sam. I can see the tablet on order 427." },
  { side: "agent", text: "Is the damage only on the screen?" },
  { side: "caller", text: "Yes, only the screen. Can I get a new one or my money back." },
  { side: "agent", text: "You can have either a new tablet ships today at no cost." },
  { side: "agent", text: "or a full refund in 3 to 5 business days." },
  { side: "agent", text: "Which do you prefer?" },
  { side: "caller", text: "And you want please." },
  { side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one." },
];

test("10 Oct second retest: a part-matched address asks again, and the choice waits for identity", () => {
  const ev = events(call3);
  const actions: AgentAction[] = [{ type: "confirm", target: "name", at: ev[4].endedAt + 2500 }];

  // "One road in Dallas.": the city matches, the street doesn't. No card while the caller may still be talking.
  let v = analyze(sunlake, ev.slice(0, 7), actions, ev[6].endedAt + 500);
  assert.equal(v.verification.factors[1].state, "partial");
  assert.ok(!v.prompts.some((p) => p.target === "address"));

  v = analyze(sunlake, ev.slice(0, 7), actions, NOW);
  const address = v.verification.factors[1];
  assert.equal(address.state, "partial");
  assert.equal(address.attempts, 0, "a part-matched answer is never a failed attempt");
  const card = v.prompts.find((p) => p.target === "address")!;
  assert.ok(card.askAgain, "nothing to confirm: ask again");
  assert.match(card.text, /^Heard "One road in Dallas\.", which matches only part of the address on the order\. Ask for the street and city again/);
  assert.doesNotMatch(card.text, /\bHill\b/, "the card never shows the record");

  v = after(call3, 8, actions);
  assert.equal(v.order.match, undefined, "order 427 stays locked");

  // The unreadable choice waits until identity is verified; the identity card stays first.
  v = after(call3, 14, actions);
  assert.ok(!v.prompts.some((p) => p.target === "choice"));
  assert.notEqual(step(v, "choice"), "attention");
  assert.ok(v.prompts.some((p) => p.target === "address" && p.askAgain));

  // "Done." before identity is counted with the earlier offers and approves nothing.
  v = after(call3, 15, actions);
  assert.deepEqual(alert(v, "offer-before-verification")!.evidence.map((e) => e.seq), [3, 11, 15]);
  assert.equal(v.recommendation?.approval.state ?? "not-ready", "not-ready");

  // The agent asks again and hears the street: verified, and the card goes away.
  const retry: Line[] = [...call3.slice(0, 7), { side: "agent", text: "Sorry, could you give me the street and the city once more?" }, { side: "caller", text: "Hill Road, in Dallas." }];
  v = after(retry, 8, actions);
  assert.equal(v.verification.factors[1].state, "asking");
  assert.ok(!v.prompts.some((p) => p.target === "address"));
  v = after(retry, 9, actions);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "427");
});

test("a near-miss street never verifies on its own, and never counts as a failed attempt", () => {
  // Offline Whisper heard the caller's correct "Hill Road" as "Will Road" and "Wind Road" (4.20 PM call).
  const lines: Line[] = [
    { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked." },
    { side: "agent", text: "First, can I have your full name, please?" },
    { side: "caller", text: "Sam Miller." },
    { side: "agent", text: "Thank you. And the street and city for the delivery?" },
    { side: "caller", text: "Will Road in Dallas." },
    { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427." },
  ];
  let v = after(lines, 6);
  const address = v.verification.factors[1];
  assert.equal(address.state, "confirm");
  assert.equal(address.confirmReason, "sounds-like");
  assert.equal(address.attempts, 0);
  assert.equal(v.verification.verified, false);
  assert.equal(v.order.match, undefined, "order 427 stays locked");
  assert.ok(v.prompts.some((p) => p.target === "address" && !p.askAgain));

  // Said word for word, the same answer verifies.
  v = after([...lines.slice(0, 4), { side: "caller", text: "Hill Road in Dallas." }, lines[5]], 6);
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "427");
});

test("the copilot says which key answer it is waiting for, so that answer gets the second model's check", () => {
  const s = script();
  assert.equal(after(s, 1).awaiting, "issue", "the opening problem gets the second model's check");
  assert.equal(after(s, 2).awaiting, null);
  assert.equal(after(script(lostDamage), 2).awaiting, "issue", "a cut-off opening line keeps the next caller line checked");
  const askName = s.findIndex((l) => l.side === "agent" && /full name/i.test(l.text)) + 1;
  assert.equal(after(s, askName).awaiting, "name");
  const askAddress = s.findIndex((l) => l.side === "agent" && /street|email/i.test(l.text)) + 1;
  assert.equal(after(s, askAddress).awaiting, "address");
  const v = after(s, s.length);
  assert.ok(v.choice, "script v2 ends with a choice made");
  assert.equal(v.awaiting, null);

  // Call 3: whatever key question the agent asked last is the one awaited, the choice included,
  // and an unreadable reply keeps it open.
  const ev = events(call3);
  const actions: AgentAction[] = [{ type: "confirm", target: "name", at: ev[4].endedAt + 2500 }];
  assert.equal(analyze(sunlake, ev.slice(0, 6), actions, NOW).awaiting, "address");
  assert.equal(analyze(sunlake, ev.slice(0, 13), actions, NOW).awaiting, "choice");
  assert.equal(analyze(sunlake, ev.slice(0, 14), actions, NOW).awaiting, "choice", '"And you want please." is no answer');
});

test("a key answer waits for its check, and the checked text is what counts", () => {
  const lines: Line[] = [
    { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked." },
    { side: "agent", text: "First, can I have your full name, please?" },
    { side: "caller", text: "Sanmilis.", confidence: 0.4 },
  ];
  const ev = events(lines);

  // While the second model checks it, the answer doesn't count either way.
  let v = analyze(sunlake, [...ev.slice(0, 2), { ...ev[2], checking: true }], [], NOW);
  assert.equal(v.verification.factors[0].state, "asking");
  assert.ok(!v.prompts.some((p) => p.target === "name"));

  // The check heard "Sam Miller.": the name is verified, and the fast text is kept for the screen.
  v = analyze(sunlake, [...ev.slice(0, 2), { ...ev[2], text: "Sam Miller.", confidence: 0.9, firstHeard: "Sanmilis." }], [], NOW);
  assert.equal(v.verification.factors[0].state, "ok");

  // The check failed: the fast text stands, as a doubtful line that never verifies on its own.
  v = analyze(sunlake, [...ev.slice(0, 2), { ...ev[2], text: "Sam Miller.", confidence: 0.9, checkFailed: true }], [], NOW);
  assert.equal(v.verification.factors[0].state, "confirm");
});

test("the agent can type what the caller said; it is checked word for word against the order", () => {
  // The turbo check heard the caller's "Hill Road, in Dallas" as "Wind Road in Dallas.": a wrong answer.
  const lines: Line[] = [
    { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked." },
    { side: "agent", text: "First, can I have your full name, please?" },
    { side: "caller", text: "Sam Miller." },
    { side: "agent", text: "Thank you. And the street and city for the delivery?" },
    { side: "caller", text: "Wind Road in Dallas." },
    { side: "agent", text: "Sorry, could you give me the street and the city once more?" },
    { side: "caller", text: "Wind Road in Dallas." },
    { side: "agent", text: "Thank you." },
  ];
  const ev = events(lines);
  const at = ev[7].endedAt + 500;

  let v = after(lines, 8);
  assert.equal(v.verification.locked, true, "two misheard answers lock the call");

  // The agent heard "Hill Road, in Dallas" and types it on the first answer: verified, nothing locked.
  const typed: AgentAction[] = [{ type: "correct", key: ev[4].key, text: "Hill Road, in Dallas", at }];
  v = after(lines, 8, typed);
  assert.equal(v.verification.locked, false);
  assert.equal(v.verification.verified, true);
  const address = v.verification.factors[1];
  assert.equal(address.attempts, 0);
  assert.equal(address.method, "street and city, typed by the agent");
  assert.equal(address.evidence?.typedFrom, "Wind Road in Dallas.");
  assert.equal(v.order.match?.order.id, "427");

  // Typed text gets no sound-alike leniency: "Will Road" is a wrong answer, not "Please confirm".
  v = after(lines.slice(0, 5), 5, [{ type: "correct", key: ev[4].key, text: "Will Road in Dallas", at }]);
  assert.equal(v.verification.factors[1].state, "failed");
  assert.equal(v.verification.factors[1].attempts, 1);

  // The latest typed text for a line is the one that counts.
  v = after(lines.slice(0, 6), 6, [
    { type: "correct", key: ev[4].key, text: "Will Road in Dallas", at },
    { type: "correct", key: ev[4].key, text: "Hill Road in Dallas", at: at + 1000 },
  ]);
  assert.equal(v.verification.verified, true);
});

test("the agent can type the customer's choice when recognition couldn't read it", () => {
  const ev = events(call3);
  const verifiedFirst: AgentAction[] = [
    { type: "confirm", target: "name", at: ev[4].endedAt + 2500 },
    { type: "correct", key: ev[6].key, text: "Hill Road, in Dallas.", at: ev[6].endedAt + 2500 },
  ];
  let v = after(call3, 14, verifiedFirst);
  assert.equal(v.verification.verified, true);
  assert.ok(v.prompts.some((p) => p.target === "choice" && p.askAgain), '"And you want please." asks again');

  v = after(call3, 14, [...verifiedFirst, { type: "correct", key: ev[13].key, text: "A new one, please.", at: ev[13].endedAt + 2500 }]);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.choice?.evidence.typedFrom, "And you want please.");
  assert.ok(!v.prompts.some((p) => p.target === "choice"));
});

/* ---------- 11 Oct call: the caller's damage sentence was lost ---------- */

/** Time of script line n (1-based), plus a little. */
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
// "The tablet came yesterday, and the screen is cracked" never reached the transcript.
const lostDamage = { 2: { side: "caller" as const, text: "Hello, I need help with order 427" } };

test("an unsupported issue never leads to a replacement, even when the agent confirms the model's reading (11 Oct)", () => {
  const s = script({ ...lostDamage, 8: { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427." }, 9: { side: "caller", text: "Can I get a new one, or my money back?" } });
  const hints = { intent: { id: "order-status" as const, key: "k2" } };
  const actions: AgentAction[] = [{ type: "confirm", target: "issue", at: at(3) }, { type: "approve", at: NOW - 1000 }];
  const v = analyze(sunlake, events(s), actions, NOW, hints);
  assert.equal(v.verification.verified, true);
  assert.equal(v.intent?.id, "order-status");
  assert.equal(v.recommendation, null, "no Scenario A or B without damage on arrival");
  assert.equal(step(v, "issue"), "attention");
  assert.equal(step(v, "approval"), "pending");
  assert.ok(v.prompts.some((p) => p.target === "issue" && p.askAgain && /isn't covered/.test(p.text)));
  assert.match(v.suggestedReply?.text ?? "", /what's wrong with the tablet/);
  assert.ok(!v.documentation.some((d) => d.value?.includes("local model")));
});

test("the caller's yes to where the damage is needs the agent to confirm it arrived damaged (11 Oct, review 12 Oct §7)", () => {
  const s = script(lostDamage);
  const hints = { intent: { id: "order-status" as const, key: "k2" } };
  let v = analyze(sunlake, events(s), [], NOW, hints);
  assert.equal(v.intent?.id, "damaged");
  assert.equal(v.intent?.certainty, "low", '"Is the damage only on the screen?" doesn\'t ask whether it arrived damaged');
  assert.equal(v.recommendation, null);
  const card = v.prompts.find((p) => p.target === "issue")!;
  assert.match(card.text, /said "Yes, only the screen\..*" to ".*Is the damage only on the screen\?", but hasn't said it arrived damaged/);

  // The agent heard it arrived damaged and chooses that before saying "Done.".
  v = analyze(sunlake, events(s), [{ type: "confirm", target: "issue", issue: "damaged", at: at(9, 2000) }], NOW, hints);
  assert.equal(step(v, "issue"), "done");
  assert.equal(step(v, "confirm"), "done");
  assert.match(v.steps.find((x) => x.id === "confirm")!.detail!, /damage confirmed by the agent/);
  assert.equal(v.recommendation?.scenario, "A");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "call");
  const summary = v.documentation.find((d) => d.label === "Case summary")!.value!;
  assert.match(summary, /the caller said "Yes, only the screen\..*" to ".*"; arrival damage confirmed by the agent/);
  assert.ok(!/local model/.test(summary));

  // Asked whether it arrived damaged, the caller's yes is enough on its own.
  const arrival = script({ ...lostDamage, 8: { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Did it arrive damaged?" }, 9: { side: "caller", text: "Yes, the screen is broken." } });
  v = analyze(sunlake, events(arrival), [], NOW, hints);
  assert.equal(v.intent?.certainty, "high");
  assert.equal(v.recommendation?.approval.state, "approved");
});

test("damage the caller caused after delivery isn't damage on arrival unless the agent chooses it (review 12 Oct §7)", () => {
  const s = script({ 9: { side: "caller", text: "Yes, only the screen. I dropped it this morning, can I get a new one, or my money back?" } });
  let v = after(s, s.length);
  assert.equal(v.intent?.certainty, "low");
  assert.equal(v.recommendation, null);
  assert.ok(v.prompts.some((p) => p.target === "issue" && /"I dropped it"/.test(p.text) && /isn't covered/.test(p.text)));
  v = after(s, s.length, [{ type: "confirm", target: "issue", issue: "damaged", at: at(10) }]);
  assert.equal(v.recommendation?.scenario, "A");
});

test("the summary keeps the caller's own damage words and adds their answer to the agent's question", () => {
  const v = after(script(), 15);
  const summary = v.documentation.find((d) => d.label === "Case summary")!.value!;
  assert.match(summary, /damage: "screen is cracked"; the caller said "Yes, only the screen\./);
  assert.match(v.steps.find((x) => x.id === "confirm")!.detail!, /damage described by the caller/);
});

test("reading the order back confirms the item, not the damage", () => {
  const s = script({ ...lostDamage, 8: { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427." }, 9: { side: "caller", text: "Okay." } });
  let v = after(s, 9);
  assert.equal(v.order.match?.confirmed, true);
  assert.equal(step(v, "confirm"), "attention");
  assert.match(v.steps.find((x) => x.id === "confirm")!.detail!, /damage not confirmed/);
  assert.equal(v.recommendation, null);

  // The agent heard the damage the transcript lost, and says so.
  v = after(s, 9, [{ type: "confirm", target: "issue", issue: "damaged", at: at(9, 2000) }]);
  assert.equal(v.intent?.source, "agent");
  assert.equal(step(v, "confirm"), "done");
  assert.equal(v.recommendation?.scenario, "A");
  v = after(s, s.length, [{ type: "confirm", target: "issue", issue: "damaged", at: at(9, 2000) }]);
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value!, /description not captured in the transcript, clarification required/);
});

test("the agent choosing 'Something else' stops the offer; the caller's own damage words bring it back", () => {
  const s = script();
  let v = after(s, s.length, [{ type: "confirm", target: "issue", issue: "other", at: at(9, 2000) }]);
  assert.equal(v.intent?.id, "other");
  assert.equal(v.recommendation, null);
  v = after(s, s.length, [{ type: "confirm", target: "issue", issue: "other", at: at(1) }]);
  assert.equal(v.intent?.id, "damaged", "the caller described the damage after the agent's choice");
  assert.equal(v.recommendation?.scenario, "A");
});

test("an approval given before its prerequisites doesn't count; a fresh one does", () => {
  const s = script({ 12: null });
  let v = after(s, s.length, [{ type: "approve", at: at(9) }]);
  assert.equal(v.recommendation?.approval.state, "awaiting", "approved before the customer chose");
  v = after(s, s.length, [{ type: "approve", at: at(9) }, { type: "approve", at: NOW - 1000 }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.at, NOW - 1000);
});

test("'Checked' typed into the name field is not the caller's answer (11 Oct)", () => {
  const s = script({ 5: { side: "caller", text: "Send me." } });
  let v = after(s, 6, [{ type: "correct", key: "k5", text: "Checked", at: at(6) }]);
  assert.notEqual(v.verification.factors[0].state, "ok");
  assert.equal(v.verification.factors[0].evidence?.typedFrom, undefined);
  v = after(s, 6, [
    { type: "correct", key: "k5", text: "Checked", at: at(6) },
    { type: "correct", key: "k5", text: "Sam Miller", at: at(6, 3000) },
    { type: "correct", key: "k5", text: "OK.", at: at(6, 4000) },
  ]);
  assert.equal(v.verification.factors[0].state, "ok");
  assert.equal(v.verification.factors[0].method, "typed by the agent");
  v = after(s, s.length, [{ type: "correct", key: "k5", text: "Sam Miller", at: at(6, 3000) }]);
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value!, /verified by full name \(typed by the agent\)/);
});

test("a denied identity answer never verifies or asks the agent to confirm it", () => {
  const s = script({ 5: { side: "caller", text: "I am not Sam Miller." } });
  const v = after(s, 6);
  assert.notEqual(v.verification.factors[0].state, "ok");
  assert.notEqual(v.verification.factors[0].state, "confirm");
  assert.ok(!v.prompts.some((p) => p.target === "name" && !p.askAgain));
});

test("a wrong answer the two speech models heard differently is not a failed attempt (11 Oct)", () => {
  const ev = events(script());
  // The fast model heard "Sen bilir.", the second model "Send me.", for "Sam Miller".
  const heard = { ...ev[4], text: "Send me.", confidence: 0.8, firstHeard: "Sen bilir." };
  let v = analyze(sunlake, [...ev.slice(0, 4), heard, ev[5]], [], NOW);
  const name = v.verification.factors[0];
  assert.equal(name.attempts, 0);
  assert.equal(name.confirmReason, "disagree");
  assert.ok(!v.alerts.some((a) => a.id.startsWith("verification-failed")));
  const card = v.prompts.find((p) => p.target === "name")!;
  assert.equal(card.askAgain, true, "nothing to confirm: ask again or type the caller's words");
  // Confirming it anyway (an old panel) verifies nothing.
  v = analyze(sunlake, [...ev.slice(0, 4), heard, ev[5]], [{ type: "confirm", target: "name", at: NOW - 1000 }], NOW);
  assert.notEqual(v.verification.factors[0].state, "ok");
  // Both models hearing the same wrong name is still a failed attempt.
  v = analyze(sunlake, [...ev.slice(0, 4), { ...heard, text: "John Smith.", firstHeard: "John Smith." }, ev[5]], [], NOW);
  assert.equal(v.verification.factors[0].attempts, 1);
});

/* ---------- 12 Oct outside review: decisions bound to what was known at the time ---------- */

test("a late correction doesn't turn an earlier 'Done.' into an approval (review 12 Oct §5)", () => {
  const s = script({ 7: { side: "caller", text: "Wind Road in Dallas." } });
  const fix: AgentAction = { type: "correct", key: "k7", text: "Hill Road in Dallas.", at: NOW - 2000 };
  let v = after(s, s.length);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  v = after(s, s.length, [fix]);
  assert.equal(v.verification.verified, true);
  assert.equal(v.verification.verifiedKnownAt, NOW - 2000, "verified when the correction was typed, not when the caller spoke");
  assert.equal(v.recommendation?.approval.state, "awaiting", "the old commitment isn't authorised retroactively");
  assert.ok(v.recommendation?.staleApproval, "the earlier approval is kept in history");
  v = after(s, s.length, [fix, { type: "approve", at: NOW - 1000 }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.at, NOW - 1000);
});

test("a second-model result that arrives after the agent's 'Done.' needs a fresh approval", () => {
  const ev = events(script());
  // The checked choice reached the copilot only after the agent had finished "Done. …".
  const lines = ev.map((l) => (l.key === "k11" ? { ...l, availableAt: ev[11].endedAt + 500, firstHeard: "And you want tea." } : l));
  const v = analyze(sunlake, lines, [], NOW);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.approval.state, "awaiting");
});

test("an approval doesn't carry over when the customer changes their mind (review 12 Oct §6)", () => {
  const s = [...script(), { side: "caller" as const, text: "Actually, I want a refund instead." }];
  let v = after(s, s.length);
  assert.equal(v.recommendation?.scenario, "B");
  assert.equal(v.recommendation?.approval.state, "awaiting", "the replacement approval doesn't cover a refund");
  v = after(s, s.length, [{ type: "approve", at: NOW - 1000 }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
});

test("an approval doesn't carry over to an order found after it (review 12 Oct §6)", () => {
  const s: Line[] = [
    ...script({
      2: { side: "caller", text: "Hello. The tablet came yesterday, and the screen is cracked." },
      8: { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?" },
    }).slice(0, 12),
    { side: "caller", text: "It's order 427." },
  ];
  const v = after(s, s.length);
  assert.equal(v.order.match?.order.id, "427");
  assert.notEqual(v.recommendation?.approval.state, "approved");
});

test("only a clear yes to a real damage question counts, and only an arrival question proves arrival (review 12 Oct §7)", () => {
  const base = (q: string, a: string) =>
    [...script({ 2: { side: "caller", text: "Hello, I need help with order 427" } }).slice(0, 7), { side: "agent" as const, text: q }, { side: "caller" as const, text: a }];
  const intentAfter = (q: string, a: string) => {
    const s = base(q, a);
    return after(s, s.length).intent;
  };
  assert.equal(intentAfter("Is the screen not damaged?", "Yes, it is not damaged.")?.id, undefined);
  assert.equal(intentAfter("Do you have a photo of the damage?", "Yes.")?.id, undefined);
  assert.equal(intentAfter("Is the damage only on the screen?", "Yes, but it is not damaged.")?.id, undefined);
  assert.notEqual(intentAfter("Is anything damaged?", "No, only the packaging is damaged.")?.certainty, "high");
  // Where the damage is, with no damage reported before: the agent confirms it arrived that way.
  const extent = intentAfter("Is the damage only on the screen?", "Yes, only the screen.");
  assert.equal(extent?.id, "damaged");
  assert.equal(extent?.certainty, "low");
  // Asked whether it arrived damaged: the caller's yes establishes it.
  const arrival = intentAfter("Did the tablet arrive damaged?", "Yes, it did.");
  assert.equal(arrival?.id, "damaged");
  assert.equal(arrival?.certainty, "high");
  // After the caller's own damage words, the same extent question confirms them.
  const s = script();
  assert.equal(after(s, 9).intent?.certainty, "high");
});

test("an identity answer naming two candidates, or denying something else, is asked again (review 12 Oct §8)", () => {
  for (const [n, text] of [
    [5, "Sam Miller or John Smith."],
    [5, "My name is Sam Miller, not John Smith."],
    [7, "Hill Road in Dallas or Lake Road in Boston."],
    [7, "Not Boston, Hill Road in Dallas."],
  ] as const) {
    const s = script({ [n]: { side: "caller", text } });
    const v = after(s, n + 1);
    const f = v.verification.factors[n === 5 ? 0 : 1];
    assert.notEqual(f.state, "ok", text);
    assert.equal(f.attempts, 0, `${text}: never a failed attempt`);
    const card = v.prompts.find((p) => p.target === (n === 5 ? "name" : "address"));
    assert.equal(card?.askAgain, true, `${text}: ask again, nothing to confirm`);
  }
  // A plain denial is still a wrong answer.
  const s = script({ 5: { side: "caller", text: "I am not Sam Miller." } });
  assert.equal(after(s, 6).verification.factors[0].attempts, 1);
});

test("models that agree only on the wrapper words still disagree on the name (review 12 Oct §10)", () => {
  const ev = events(script());
  const heard = { ...ev[4], text: "My name is John Smith.", firstHeard: "My name is Sam Miller." };
  let v = analyze(sunlake, [...ev.slice(0, 4), heard, ev[5]], [], NOW);
  assert.equal(v.verification.factors[0].attempts, 0);
  assert.equal(v.verification.factors[0].confirmReason, "disagree");
  // Same street, different city: still a disagreement about the answer.
  const addr = { ...ev[6], text: "Hill Road in Boston.", firstHeard: "Hill Road in Dallas." };
  v = analyze(sunlake, [...ev.slice(0, 6), addr, ev[7]], [], NOW);
  assert.equal(v.verification.factors[1].attempts, 0);
});

test("the copilot lists the caller lines that are key answers, whatever order they arrived in (review 12 Oct §9)", () => {
  const s = script();
  const v = after(s, 7);
  assert.ok(v.keyAnswers.includes("k5"), "the name answer");
  assert.ok(v.keyAnswers.includes("k7"), "the address answer");
  assert.ok(v.keyAnswers.includes("k2"), "the opening problem");
  assert.ok(!v.keyAnswers.includes("k1"));
});

test("each changed decision needs a fresh approval: refund to replacement, a broken correction, a late escalation (review 12 Oct §5–6)", () => {
  // Refund first, then a replacement.
  const refund = [
    ...script({ 11: { side: "caller", text: "The refund, please." }, 12: { side: "agent", text: "Done. Your refund is set up." } }).slice(0, 12),
    { side: "caller" as const, text: "Actually, a new one would be better." },
  ];
  let v = after(refund, refund.length);
  assert.equal(v.recommendation?.prepared?.kind, "replacement");
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.match(v.recommendation?.staleApproval?.reason ?? "", /it was for a refund/);

  // A later correction that breaks the address: no recommendation, so nothing approved.
  const s = script();
  v = after(s, s.length, [{ type: "correct", key: "k7", text: "Lake Road in Boston.", at: NOW - 2000 }]);
  assert.equal(v.verification.verified, false);
  assert.equal(v.recommendation?.approval.state === "approved", false);

  // Escalation words after the approval: Scenario C, never approved.
  const late = [...s.slice(0, 12), { side: "caller" as const, text: "If this isn't sorted I'll do a chargeback." }];
  v = after(late, late.length);
  assert.equal(v.recommendation?.scenario, "C");
  assert.equal(v.recommendation?.approval.state, "not-ready");
});

test("typed identity text naming two candidates is asked again too, and wrappers don't hide agreement (review 12 Oct §8, §10)", () => {
  const s = script({ 5: { side: "caller", text: "Send me." } });
  let v = after(s, 6, [{ type: "correct", key: "k5", text: "Sam Miller or John Smith", at: at(6) }]);
  assert.equal(v.verification.factors[0].confirmReason, "ambiguous");
  assert.equal(v.verification.factors[0].attempts, 0);
  // Both models heard "John Smith", one with "It's" in front: they agree, so it is a wrong answer.
  const ev = events(script());
  v = analyze(sunlake, [...ev.slice(0, 4), { ...ev[4], text: "John Smith.", firstHeard: "It's John Smith." }, ev[5]], [], NOW);
  assert.equal(v.verification.factors[0].attempts, 1);
});

/* ---------- 12 Oct call (fifth call), as the console heard it ---------- */

/**
 * Call-clock seconds from the recording. Speech ends are estimated from the line lengths; first-pass
 * delays and check times are the ones the transcript showed ("0.9 s after speech ended · checked in 2.0 s").
 */
const call5: { s: number; end: number; side: "caller" | "agent"; text: string; first?: string; delay: number; check?: number; low?: boolean }[] = [
  { s: 2, end: 5, side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", delay: 1.2 },
  { s: 6, end: 12, side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked.", first: "Hello, I need help with order 427, the table came yesterday and the screen is cracked.", delay: 1.1, check: 3.0 },
  { s: 14, end: 17, side: "agent", text: "I'm sorry to hear that I can send you a new one today.", delay: 1.2 },
  { s: 19, end: 19.5, side: "agent", text: "First.", delay: 0.9 },
  { s: 20, end: 22, side: "agent", text: "Can I have your full name please?", delay: 1.0 },
  { s: 23, end: 24, side: "caller", text: "Sam Miller", first: "Sam Miller. Sam Miller.", delay: 0.8, check: 2.1 },
  { s: 27, end: 27.6, side: "agent", text: "Thank you.", delay: 0.8 },
  { s: 28, end: 30, side: "agent", text: "And the street and city for the delivery.", delay: 0.9 },
  { s: 32, end: 33.5, side: "caller", text: "Hill Road in Dallas.", first: "Hill wrote in Dallas.", delay: 3.8, check: 2.2 },
  { s: 36, end: 37, side: "agent", text: "Thank you Sam.", delay: 0.9 },
  { s: 38, end: 41, side: "agent", text: "I can see the tablet on order 4 to 7.", delay: 1.1 },
  { s: 43, end: 45, side: "agent", text: "Is the damage only on the screen?", delay: 1.0 },
  { s: 47, end: 48.5, side: "caller", text: "Yes, only the screen.", delay: 0.9 },
  { s: 49, end: 51.5, side: "caller", text: "Can I get a new one or my money back?", delay: 0.9 },
  { s: 53, end: 54.5, side: "agent", text: "You can have either.", delay: 0.9 },
  { s: 55, end: 58, side: "agent", text: "new tablet ships today at no coast.", delay: 0.9, low: true },
  { s: 59, end: 62, side: "agent", text: "Or a full refund in 3 to 5 business days.", delay: 0.9 },
  { s: 63, end: 64.5, side: "agent", text: "Which do you prefer?", delay: 0.9 },
  { s: 66, end: 67.5, side: "caller", text: "A new one, please.", first: "And you want tea.", delay: 0.9, check: 2.0 },
  { s: 69, end: 69.6, side: "agent", text: "Done.", delay: 0.8, low: true },
  { s: 70, end: 72, side: "agent", text: "The new tablet ships today.", delay: 0.8 },
  { s: 73, end: 77, side: "agent", text: "You'll get an email with a free return label for the damaged one.", delay: 1.0 },
  { s: 79, end: 80.5, side: "caller", text: "Great, thank you.", delay: 0.8 },
  { s: 82, end: 83, side: "agent", text: "You are welcome.", delay: 0.8 },
];
const call5Start = NOW - 120_000;
const call5Events = (shift: (i: number) => number = () => 0): TranscriptEvent[] =>
  call5.map((l, i) => {
    const startedAt = call5Start + (l.s + shift(i)) * 1000;
    const endedAt = call5Start + (l.end + shift(i)) * 1000;
    return {
      callId: "CA-call5",
      seq: i + 1,
      key: `c5-${i + 1}`,
      side: l.side,
      text: l.text,
      startedAt,
      endedAt,
      final: true,
      confidence: l.low ? 0.45 : 0.85,
      firstHeard: l.first,
      availableAt: endedAt + (l.delay + (l.check ?? 0)) * 1000,
    };
  });

test("the 12 Oct call as heard still passes on the new rules, approved on the call", () => {
  const v = analyze(sunlake, call5Events(), [], NOW);
  assert.equal(v.intent?.certainty, "high");
  assert.equal(v.verification.verified, true);
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "call");
  assert.equal(v.recommendation?.approval.evidence?.text, "The new tablet ships today.");
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value!, /damage: "screen is cracked"; the caller said "Yes, only the screen\." to "Is the damage only on the screen\?"/);
});

test("on the 12 Oct call, a 'Done.' said before the checked choice arrived would need the panel's approval", () => {
  // The same call, with the agent's two commitment lines 2 s earlier: before "A new one, please." came back from the check.
  const v = analyze(sunlake, call5Events((i) => (i === 19 || i === 20 ? -2 : 0)), [], NOW);
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.equal(v.recommendation?.staleApproval?.reason, "the customer's choice wasn't known yet");
  const approved = analyze(sunlake, call5Events((i) => (i === 19 || i === 20 ? -2 : 0)), [{ type: "approve", at: call5Start + 75_000 }], NOW);
  assert.equal(approved.recommendation?.approval.state, "approved");
  assert.equal(approved.recommendation?.approval.via, "panel");
});
