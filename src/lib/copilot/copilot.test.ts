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
