import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, TranscriptEvent } from "./types";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  Call 13 Card A (18 Oct 2026, console f629e71) replayed with its real timings: the closing line was spoken
  before the panel press, and its checked text arrived 0.5 s after the press. The panel showed "Approved"
  (in the panel) for 0.5 s, then the checked line took the credit back: "05:09:54 PM on the call: counted;
  05:10:04 PM in the panel: not counted (already approved)" (outside review 6.2). Approvals now compete by
  when the panel could accept them; whether each one holds is judged as before.

  Call clock C = seconds since call start, 05:08:28.2 PM Cairo, from the card-a timeline (wall = V + 17:08:25.3,
  call start V2.95). Line starts and ends from voice onsets, the C stamps and the "s after speech ended" on
  screen; check times and first-heard texts from the end screenshots. Panel: typed name C 29.3, Approve C 96.47.
*/

const T0 = Date.parse("2026-10-18T14:08:28.200Z");
const c = (s: number) => T0 + Math.round(s * 1000);

type L = { side: "caller" | "agent"; text: string; s: number; e: number; delay: number; check?: number; conf?: number; first?: string; firstConf?: number };
const L13A: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0.78, e: 4.5, delay: 2.8 },
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked.", s: 5.64, e: 12.35, delay: 1.0, check: 6.3, first: "Hello, I need help with order 427" },
  { side: "agent", text: "I'm sorry to hear that. Can I have your full name please?", s: 14.0, e: 17.64, delay: 1.2 },
  { side: "caller", text: "Sun Millers", s: 19.0, e: 20.5, delay: 0.8, check: 2.2, conf: 0.45, first: "Sam Milos." }, // k4, typed "Sam Miller"
  { side: "agent", text: "Thank you.", s: 28.32, e: 29.2, delay: 0.9 },
  { side: "agent", text: "and the street and city for the delivery.", s: 30.0, e: 33.74, delay: 0.9 },
  { side: "caller", text: "Hill Road in Dallas.", s: 35.32, e: 37.0, delay: 0.8, check: 2.1, first: "Kill road in Dhanis." },
  { side: "agent", text: "Thank you Sam. Just to confirm.", s: 41.54, e: 48.5, delay: 1.0, conf: 0.4 },
  { side: "agent", text: "You can have either a new tablet ships today, at no cost or a full refund once the carrier scans your return. Which do you prefer?", s: 51.24, e: 61.9, delay: 1.4 },
  { side: "caller", text: "A new one, please.", s: 63.4, e: 65.75, delay: 0.8, check: 2.1 }, // k10
  { side: "agent", text: "Just to confirm, that's Order 427, the Sunlake Tab 11.", s: 75.48, e: 81.0, delay: 1.1 }, // k11, read-back
  { side: "agent", text: "and", s: 84.0, e: 84.75, delay: 0.8, check: 2.2, conf: 0.4, first: "An." },
  { side: "caller", text: "Yes.", s: 84.74, e: 85.15, delay: 0.9 },
  // k14, C01:26: first pass cut short and (inferred) low confidence, so it went to the check.
  { side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free return label for the damaged one.", s: 86.48, e: 93.55, delay: 1.0, check: 2.4, first: "Done. The new tablet ships today.", firstConf: 0.45 },
  { side: "caller", text: "Great. Thank you.", s: 96.1, e: 97.94, delay: 0.8 },
  { side: "agent", text: "Is there anything else that can help you with?", s: 98.26, e: 100.78, delay: 0.9 },
  { side: "caller", text: "No, that's all. Bye.", s: 102.04, e: 104.36, delay: 0.8 },
];
const SPEECH_END = 93.55;
const CHECKED = SPEECH_END + 1.0 + 2.4; // 96.95
const PRESS = 96.47;

/** The transcript as the panel had it at call time t: first-heard text while the check runs (left out by the rules), then the checked text. */
const linesAt = (t: number, ls: L[] = L13A): TranscriptEvent[] =>
  ls.flatMap((l, i) => {
    const shown = c(l.e + l.delay);
    if (shown > c(t)) return [];
    const base = { callId: "CA-call13a", seq: i + 1, key: `k${i + 1}`, side: l.side, startedAt: c(l.s), endedAt: c(l.e), final: true as const };
    if (l.check === undefined) return [{ ...base, text: l.text, confidence: l.conf ?? 0.9, availableAt: shown }];
    const checked = c(l.e + l.delay + l.check);
    return checked <= c(t)
      ? [{ ...base, text: l.text, confidence: l.conf ?? 0.9, availableAt: checked, ...(l.first && l.first !== l.text ? { firstHeard: l.first } : {}) }]
      : [{ ...base, text: l.first ?? l.text, confidence: l.firstConf ?? l.conf ?? 0.9, availableAt: shown, checking: true }];
  });

const TYPE_NAME: AgentAction = { type: "correct", key: "k4", text: "Sam Miller", at: c(29.3) };
const approveAt = (s: number): AgentAction => ({ type: "approve", at: c(s) });
const at = (t: number, actions: AgentAction[] = [TYPE_NAME, approveAt(PRESS)], ls: L[] = L13A): CopilotView =>
  analyze(sunlake, linesAt(t, ls), actions.filter((a) => a.at <= c(t)), c(t));
const END = 110;
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;
const step = (v: CopilotView, id: string) => v.steps.find((s) => s.id === id)!;
const hms = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const LATE = "already approved in the panel before this line's text arrived";

test("Call 13 A: speech ends, check pending, panel accepted, check returns: the press keeps the credit and both stay in the record", () => {
  assert.ok(SPEECH_END < PRESS && PRESS < CHECKED);
  assert.equal(linesAt(PRESS).find((l) => l.key === "k14")?.checking, true, "pressed while the closing line was being checked");
  assert.equal(linesAt(CHECKED + 0.01).find((l) => l.key === "k14")?.checking, undefined);
  for (let t = PRESS; t <= END; t += 0.1) {
    const a = at(t).recommendation!.approval;
    assert.equal(a.state, "approved", `t=${t.toFixed(2)}`);
    assert.equal(a.via, "panel", `t=${t.toFixed(2)}: no re-credit when the checked line arrives`);
    assert.equal(a.at, c(PRESS), `t=${t.toFixed(2)}`);
  }
  const v = at(END);
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.evidence?.key ?? null, h.counted, h.reason ?? null]),
    [
      ["panel", null, true, null],
      ["call", "k14", false, LATE],
    ]
  );
  assert.equal(doc(v, "Approval record"), `Abdallah (AG-2001), Agent (Tier 1), ${hms(c(PRESS))}`);
  assert.equal(doc(v, "Approval history"), `${hms(c(PRESS))} in the panel: counted; ${hms(c(86.48))} on the call: not counted (${LATE})`);
  assert.equal(step(v, "approval").detail, "Approved in the panel");
  assert.equal(v.agentChecks.find((x) => x.key === "k14")?.reason, `approval words heard, not counted: ${LATE}`);
  // The checked line still carries the terms: documentation completes as on the call.
  assert.equal(step(v, "docs").detail, "Terms heard on the call");
  assert.equal(v.suggestedReply?.text, "Is there anything else I can help with?");
});

test("Call 13 A: only the attribution depends on when the press came; the approval and its outcome never do", () => {
  const credit = (p: number) => at(END, [TYPE_NAME, approveAt(p)]).recommendation!;
  for (const p of [86, 90, 93.5]) assert.equal(credit(p).approval.via, "panel", `press at C ${p}, before the speech ended`);
  for (const p of [93.6, 94.55, 95.5, 96.47, 96.9]) assert.equal(credit(p).approval.via, "panel", `press at C ${p}, while the line was being checked`);
  for (const p of [97.0, 99]) {
    // The checked line approved first: the press comes after it, as the panel showed ("Approved", no button).
    assert.equal(credit(p).approval.via, "call", `press at C ${p}, after the checked line`);
    assert.equal(credit(p).history?.find((h) => h.via === "panel")?.reason, "already approved");
  }
  for (let p = 82.2; p <= 100; p += 0.25) {
    const r = credit(p);
    assert.equal(r.approval.state, "approved", `press at C ${p.toFixed(2)}`);
    assert.equal(r.prepared?.kind, "replacement");
    assert.equal(r.history?.filter((h) => h.counted).length, 1);
  }
  // Without any press, the checked line approves on its own, as before.
  assert.equal(at(END, [TYPE_NAME]).recommendation?.approval.via, "call");
});

test("Call 13 A variant: an early 'Done' before the read-back, checked after the press, keeps its own reason", () => {
  // Said C 68-72 (after the choice, before the read-back), its check slow enough to return after a press at C 83.
  const early: L = { side: "agent", text: "Done. The new tablet ships today.", s: 68, e: 72, delay: 1.0, check: 10.5, first: "Done the new tablet", firstConf: 0.45 };
  const ls = [...L13A.slice(0, 10), early, ...L13A.slice(10)];
  const v = at(END, [TYPE_NAME, approveAt(83)], ls);
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.counted, h.reason ?? null]),
    [
      ["panel", true, null],
      ["call", false, "the item wasn't confirmed with the caller yet"],
      ["call", false, "already approved"],
    ]
  );
  assert.equal(v.recommendation?.staleApproval, undefined, "nothing stale shows once approved");
});

test("Call 13 A variant: Undo while the approving line is still being checked still withdraws it; the order of acceptance can't revive it", () => {
  // The item confirmed by a press (no spoken read-back), the closing line, then Undo while it is checked.
  const ls = L13A.filter((_, i) => i !== 10);
  const press: AgentAction = { type: "confirm", target: "order", at: c(80) };
  const undo: AgentAction = { type: "undo", target: "order", at: c(95) };
  let v = at(END, [TYPE_NAME, press, undo], ls);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.staleApproval?.reason, "a confirmation it relied on was undone");
  // Confirmed again and approved in the panel: the press counts, the withdrawn line keeps its reason.
  v = at(END, [TYPE_NAME, press, undo, { type: "confirm", target: "order", at: c(98) }, approveAt(99)], ls);
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.via, h.counted, h.reason ?? null]),
    [
      ["call", false, "a confirmation it relied on was undone"],
      ["panel", true, null],
    ]
  );
});

test("Call 13 A variant: a change of choice after the approvals voids both, whatever their order of acceptance", () => {
  const change: L = { side: "caller", text: "Actually, I'd rather have a refund.", s: 98.0, e: 100.0, delay: 0.9, check: 2.0 };
  const ls = [...L13A.slice(0, 14), change];
  const v = at(END, [TYPE_NAME, approveAt(PRESS)], ls);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.prepared?.kind, "refund");
  assert.equal(v.recommendation?.approval.state, "awaiting");
  assert.ok(v.recommendation?.history?.every((h) => !h.counted));
});
