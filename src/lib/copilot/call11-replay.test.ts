import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, TranscriptEvent } from "./types";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  Call 11 (17 Oct 2026, console 792ebd6) replayed with its real timings, as a permanent regression test
  (package 5D-7 of the Call 11 roadmap). Call clock C is seconds since call start, placed at 02:14:59.9
  Cairo. Line starts and ends come from a silence map of the recording, first-text delays and check
  times from the end-of-call transcript, panel presses from video frames: item Confirm C 86.5, refund
  Approve C 133.5, replacement Approve C 173.45; the name Confirm (C 30) is approximate.
*/

const T0 = Date.parse("2026-10-16T23:14:59.900Z"); // C 00:00 = 02:14:59.9 AM Cairo (UTC+3)
const c = (s: number) => T0 + Math.round(s * 1000);

type L = { side: "caller" | "agent"; text: string; s: number; e: number; delay: number; check?: number; conf?: number; first?: string };
const L11: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 1.6, e: 4.2, delay: 1.2 },
  { side: "caller", text: "Hello, I need help with order 427. The tablet came yesterday and the screen is cracked.", s: 5.2, e: 10.0, delay: 1.0, check: 3.0, first: "Hello, I need help with order 427" },
  { side: "agent", text: "All right.", s: 5.6, e: 6.3, delay: 0.8, conf: 0.4 },
  { side: "agent", text: "I'm sorry to hear that.", s: 14.2, e: 15.4, delay: 1.2 },
  { side: "agent", text: "Let me check that for you.", s: 16.2, e: 17.4, delay: 0.9 },
  { side: "agent", text: "first, can I have you full name please.", s: 19.3, e: 21.4, delay: 0.9, conf: 0.4 },
  { side: "caller", text: "Sam Miller", s: 23.2, e: 24.3, delay: 0.8, check: 2.0, conf: 0.45, first: "San milir." },
  { side: "agent", text: "Thank you and the street and city for delivery.", s: 32.2, e: 34.5, delay: 0.9 },
  { side: "caller", text: "Hill Road in Dallas.", s: 36.3, e: 37.8, delay: 0.8, check: 2.0, first: "He'll road in Dallas." },
  { side: "agent", text: "Thank you Sam. Is the damage only on the screen.", s: 47.2, e: 50.0, delay: 0.9 },
  { side: "caller", text: "Yes, only the screen. Can I get a new one or my money back.", s: 52.2, e: 56.4, delay: 1.0 },
  { side: "agent", text: "You can have either a new tablet ships today at no coast or a full refund. Once the carrier scans you return. It takes three to five business days to appear.", s: 60.2, e: 70.0, delay: 1.9 },
  { side: "agent", text: "Which do you prefer?", s: 71.0, e: 72.1, delay: 1.0 },
  { side: "caller", text: "A new one, please.", s: 73.4, e: 74.5, delay: 0.8, check: 2.0, first: "And you won, please." }, // k14
  { side: "agent", text: "done the new tablet ships today", s: 87.85, e: 90.81, delay: 0.9 }, // k15, C 01:28
  { side: "agent", text: "Just to confirm. That's order 427 the Sunlake tab 11.", s: 95.33, e: 99.53, delay: 1.0 }, // k16, C 01:35
  { side: "caller", text: "Yes.", s: 101.0, e: 101.45, delay: 3.6 }, // k17
  { side: "agent", text: "Done. The new tablet ships today. You'll get an email with a free refund.", s: 103.09, e: 107.97, delay: 1.1 }, // k18, C 01:43
  { side: "agent", text: "with a free return label for the damaged one.", s: 108.5, e: 111.99, delay: 0.9 }, // k19
  { side: "caller", text: "Actually, I'd rather have my money back. A refund, please.", s: 114.0, e: 117.56, delay: 1.0, check: 3.4, first: "Actually I'd rather have my money back. A refund please." }, // k20
  { side: "agent", text: "I've set a full refund of $329 to your visa ending 2208.", s: 130.11, e: 133.98, delay: 1.1, check: 2.2, first: "I've set up full refund of $329 to your visa ending 2208" }, // k21
  { side: "agent", text: "It's issued when the carrier scan the return and take 3-5 business days to appear. You'll get an email with a free return label.", s: 137.61, e: 146.05, delay: 1.4 }, // k22
  { side: "caller", text: "Sorry, I've changed my mind again. The new tablet after all.", s: 148.0, e: 151.94, delay: 1.0, check: 4.0 }, // k23
  { side: "agent", text: "The new tablet ships today you'll get an email with a free return label for the damaged one.", s: 174.7, e: 180.3, delay: 1.1 }, // k24, C 02:54
  { side: "caller", text: "Great. Thank you.", s: 182.13, e: 183.47, delay: 0.9 },
  { side: "agent", text: "You're welcome. Is there anything else I can help you with?", s: 184.01, e: 186.85, delay: 0.9, check: 2.1, first: "you're welcome. if there anything else i can help you with." },
  { side: "caller", text: "No, that's all. Bye.", s: 188.06, e: 189.54, delay: 0.8 },
];

const toEvents = (ls: L[]): TranscriptEvent[] =>
  ls.map((l, i) => ({
    callId: "CA-call11",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: c(l.s),
    endedAt: c(l.e),
    availableAt: c(l.e + l.delay + (l.check ?? 0)),
    final: true,
    confidence: l.conf ?? 0.9,
    ...(l.first ? { firstHeard: l.first } : {}),
  }));

const PRESS_NAME: AgentAction = { type: "confirm", target: "name", at: c(30) };
const PRESS_ITEM: AgentAction = { type: "confirm", target: "order", at: c(86.5) };
const APPROVE_REFUND: AgentAction = { type: "approve", at: c(133.5) };
const APPROVE_REPLACEMENT: AgentAction = { type: "approve", at: c(173.45) };
const ACTIONS = [PRESS_NAME, PRESS_ITEM, APPROVE_REFUND, APPROVE_REPLACEMENT];

/** What the panel showed at call time t (seconds): lines available by then, actions pressed by then. */
const at = (t: number, ls: L[] = L11, actions: AgentAction[] = ACTIONS): CopilotView => {
  const now = c(t);
  return analyze(sunlake, toEvents(ls).filter((l) => (l.availableAt ?? l.endedAt) <= now), actions.filter((a) => a.at <= now), now);
};
const END = 192;
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;
/** The record's clock format, in whatever time zone the tests run in. */
const hms = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

test("the replay ends where Call 11 ended: the replacement approved in the panel", () => {
  const v = at(END);
  assert.equal(v.choice?.value, "replacement");
  assert.equal(v.recommendation?.prepared?.kind, "replacement");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.via, "panel");
  assert.equal(doc(v, "Approval record"), `Abdallah (AG-2001), Agent (Tier 1), ${hms(c(173.45))}`);
});

test("I-24: every approval attempt is in the history, the 01:43 'free refund' line included, each with its reason", () => {
  const v = at(END);
  assert.deepEqual(
    v.recommendation?.history?.map((h) => [h.evidence?.key ?? "panel", h.counted, h.reason ?? null]),
    [
      ["k15", false, "the customer changed their choice after it"],
      ["k18", false, "it named a refund, not the replacement"],
      ["panel", false, "it was for a refund"],
      ["panel", true, null],
      ["k24", false, "already approved"],
    ]
  );
  assert.ok(v.keyAnswers.includes("k18"), "the 01:43 line goes to the second check");
});

test("I-23 on the Call 11 timeline: after the switch to refund, a habitual 'Done. The new tablet ships today.' doesn't approve the refund", () => {
  const habit: L = { side: "agent", text: "Done. The new tablet ships today.", s: 124, e: 126, delay: 0.9 };
  const v = at(128, [...L11.slice(0, 20), habit], [PRESS_NAME, PRESS_ITEM]);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.prepared?.kind, "refund");
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.match(v.recommendation?.staleApproval?.reason ?? "", /named a replacement/);
});

test("I-24: 'Done' before the item is confirmed shows its reason at once, not only after the press", () => {
  const early: L = { side: "agent", text: "Done. The new tablet ships today.", s: 78.0, e: 80.0, delay: 0.9 };
  const v = at(82, [...L11.slice(0, 14), early, ...L11.slice(14)]);
  assert.equal(v.recommendation?.prepared, undefined);
  assert.equal(v.recommendation?.staleApproval?.reason, "the item wasn't confirmed with the caller yet");
  assert.doesNotMatch(v.agentChecks.find((x) => x.key === "k15")!.reason, /^approval heard/);
});

test("I-28: one line has one time in the record, and two panel presses 40 s apart are told apart", () => {
  const v = at(END);
  const history = doc(v, "Approval history")!.split("; ");
  assert.ok(history[history.length - 1].startsWith(hms(c(174.7))), "the 02:54 line at its start, as in Terms heard");
  assert.match(doc(v, "Terms heard")!, new RegExp(`\\(${hms(c(174.7))}\\)$`));
  const panels = history.filter((h) => h.includes("in the panel")).map((h) => h.split(" in the panel")[0]);
  assert.deepEqual(panels, [hms(c(133.5)), hms(c(173.45))]);
  assert.notEqual(panels[0], panels[1]);
});

test("I-25: the record keeps the item press after the read-back takes over", () => {
  assert.deepEqual(at(87).undoable, ["name", "order"], "Undo while the confirmation rests on the press");
  const v = at(END);
  assert.deepEqual(v.undoable, ["name"], "the read-back carries it now");
  assert.equal(doc(v, "Item confirmation"), `confirmed in the panel at ${hms(c(86.5))}; read back at ${hms(c(95.33))} ("Just to confirm. That's order 427 the Sunlake tab 11.")`);
});

test("I-27: the name step reads 'Confirmed by the agent'", () => {
  assert.equal(at(END).steps.find((s) => s.id === "name")!.detail, "Confirmed by the agent");
});

test("C7: replacement, refund, replacement: the 01:28 spoken approval never revives", () => {
  for (const t of [125, 134, 140, 150, 157, 160, 173, 174, 181, END]) {
    const v = at(t);
    const first = v.recommendation?.history?.find((h) => h.evidence?.key === "k15");
    if (first) assert.equal(first.counted, false, `t=${t}`);
    assert.notEqual(v.recommendation?.approval.evidence?.key, "k15", `t=${t}`);
  }
  // Without the second panel press, the 02:54 line approves on its own.
  const v = at(END, L11, [PRESS_NAME, PRESS_ITEM, APPROVE_REFUND]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.approval.evidence?.key, "k24");
});
