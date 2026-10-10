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
