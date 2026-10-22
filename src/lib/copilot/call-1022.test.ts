import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  The 22 Oct 6:05 PM call (Reviews/2026-10-22-1805-call), run on the pitch console 5bb7bf2, and the outside review
  of it (AXENTRA_CALL_REVIEW_AND_FIX_PLAN_2026-10-22.md). Lines are the call's live transcript where it matters:
  the order as "5-2-7", the refund sentence with its card ending dropped ("I've set up a refund a full refund of
  $329"), spoken before Approve was pressed, and about 20 s on the address with no field until the card came up.
*/

const NOW = Date.UTC(2026, 9, 22, 16);
type Line = { side: "caller" | "agent"; text: string; checking?: boolean; firstHeard?: string; end?: number };

/** Lines 5 s apart; each lasts 3 s unless `end` says otherwise (ms after its start). */
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-1022",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + (l.end ?? 3000),
    final: true,
    confidence: 0.9,
    ...(l.checking ? { checking: true } : {}),
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
  }));
const script = (replace: Record<number, Line | null> = {}, extra: Line[] = []): Line[] => [
  ...scriptV2.flatMap((l) => (l.n in replace ? (replace[l.n] ? [replace[l.n]!] : []) : [{ side: l.side, text: l.text }])),
  ...extra,
];
/** Time of line n (1-based), plus a little. */
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(sunlake, events(lines), actions, NOW);
const doc = (v: CopilotView, label: string) => v.documentation.find((d) => d.label === label)?.value;
const docs = (v: CopilotView) => v.steps.find((s) => s.id === "docs")!;

/* ---------- The order: "5-2-7" is 527, never 5227 ---------- */

test("22 Oct: 'order 5-2-7' is heard as 527, and Sam's 427 is proposed for confirmation after identity", () => {
  const s = script({ 2: { side: "caller", text: "Hello, I need help with order 5-2-7. The tablet came yesterday and the screen is cracked." } });
  let v = view(s.slice(0, 2));
  assert.equal(v.order.heard?.reading, "527", "the pitch console read it as 'probably 5227'");
  v = view(s.slice(0, 7));
  assert.equal(v.order.match?.order.id, "427");
  assert.equal(v.order.match?.needsConfirmation, true);
});

/* ---------- The refund terms as heard on the call ---------- */

// The caller changed their mind after "A new one, please."; the agent said the refund sentence and pressed Approve
// as it ended (the panel showed "Approved" at 6:07:20; the sentence ran from 6:07:13).
const asHeard = script({ 12: { side: "caller", text: "Actually, sorry, I'd rather have my money back. Are you fine," }, 13: null, 14: null, 15: null }, [
  { side: "agent", text: "I've set up a refund a full refund of $329" },
  { side: "agent", text: "It's issued when the carrier scan the return and takes 3-5 business days to appear. You'll get an email with a free refund label." },
]);

test("22 Oct: the amount heard counts on its own; only the card is asked for, and the record says which", () => {
  const v = view(asHeard, [{ type: "approve", at: at(13, 3000) }]);
  assert.equal(v.choice?.value, "refund");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.equal(docs(v).detail, "Not heard yet: card it goes to", "the pitch console said 'refund amount and card'");
  assert.equal(v.suggestedReply?.text, "The refund goes to your Visa ending 2208.");
  const terms = doc(v, "Terms heard")!;
  assert.match(terms, /^Refund amount: "I've set up a refund a full refund of \$329" \(/);
  assert.match(terms, /Card it goes to: not heard yet;/);
  assert.match(terms, /When it's issued and how long it takes: "It's issued when the carrier scan the return/);
  // Saying the card now completes the terms.
  const said = view([...asHeard, { side: "agent", text: "The refund goes to your Visa ending 2208." }], [{ type: "approve", at: at(13, 3000) }]);
  assert.equal(docs(said).detail, "Terms heard on the call");
});

test("22 Oct: the refund sentence said before Approve isn't re-checked, as an approval may rest on such lines; the terms said after it are", () => {
  const v = view(asHeard, [{ type: "approve", at: at(13, 3000) }]);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.ok(!v.keyAnswers.includes("k13"), "ended as Approve was pressed: stays as heard");
  assert.deepEqual(v.agentChecks.find((c) => c.key === "k14"), { key: "k14", check: true, reason: "a term isn't heard yet since the approval" });
  // With every term heard, nothing is held back or re-checked.
  const full = view(
    script({ 11: { side: "caller", text: "A refund, please." }, 12: null, 13: null, 14: null, 15: null }, [
      { side: "agent", text: "I've set up a full refund of $329.00 to your Visa ending 2208." },
      { side: "agent", text: "It's issued when the carrier scans the return and takes 3 to 5 business days to appear. You'll get an email with a free return label." },
    ]),
    [{ type: "approve", at: at(11, 4000) }]
  );
  assert.equal(docs(full).detail, "Terms heard on the call");
  assert.ok(!full.keyAnswers.includes("k12") && !full.keyAnswers.includes("k13"));
});

test("the lines an approval rests on are never sent for a check while a term is missing: the order read back after the choice, or the approving line", () => {
  // Read back only after the choice, as the copilot suggests when the item isn't confirmed yet; then Approve.
  const late = script({
    8: { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?" },
    11: { side: "caller", text: "The refund, please." },
    12: { side: "agent", text: "Just to confirm, that's order 427, the tablet?" },
    13: { side: "caller", text: "Yes." },
    14: null,
    15: null,
  });
  assert.equal(view(late).recommendation?.approval.state, "awaiting");
  const pressed = view(late, [{ type: "approve", at: at(13, 4000) }]);
  assert.equal(pressed.recommendation?.approval.state, "approved");
  assert.ok(!pressed.keyAnswers.includes("k12"), "the read-back stays as heard");
  // Approved on the call with terms still missing: the approving line stays as heard, with its note.
  const spoken = view(script({ 11: { side: "caller", text: "The refund, please." }, 12: { side: "agent", text: "Done. I've set up a full refund of $329." }, 13: null, 14: null, 15: null }));
  assert.equal(spoken.recommendation?.approval.state, "approved");
  assert.equal(spoken.recommendation?.approval.via, "call");
  assert.ok(!spoken.keyAnswers.includes("k12"));
  assert.deepEqual(spoken.agentChecks.find((c) => c.key === "k12"), { key: "k12", check: false, reason: "approval heard in this line" });
});

/* ---------- A wrong number is put right only explicitly (outside review, item 7) ---------- */

const refundWith = (...said: string[]) =>
  view(
    script({ 11: { side: "caller", text: "A refund, please." }, 12: null, 13: null, 14: null, 15: null }, [
      ...said.map((text) => ({ side: "agent" as const, text })),
      { side: "agent", text: "It's issued when the carrier scans the return and takes 3 to 5 business days to appear. You'll get an email with a free return label." },
    ]),
    [{ type: "approve", at: at(11, 4000) }]
  );
const heard = (v: CopilotView, label: string) => !new RegExp(`${label}: not heard yet`).test(doc(v, "Terms heard") ?? "");

test("a wrong amount stays not heard after a plain repeat; the suggested restatement puts it right, and the record keeps both", () => {
  const wrong = refundWith("A full refund of $299 to your Visa ending 2208.");
  assert.ok(!heard(wrong, "Refund amount"));
  assert.equal(wrong.suggestedReply?.text, "To be clear: that's a full refund of $329.00.");
  assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", "A full refund of $329."), "Refund amount"), "no 'last number wins'");

  const fixed = refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear: that's a full refund of $329.00.");
  assert.ok(heard(fixed, "Refund amount"));
  assert.equal(docs(fixed).detail, "Terms heard on the call");
  assert.match(doc(fixed, "Terms heard")!, /^Refund amount: "To be clear: that's a full refund of \$329\.00\." \([^)]*, correcting 299 said before\)/);

  // A correction in its own sentence of the same line counts; "299, sorry, 329" in one sentence doesn't.
  assert.ok(heard(refundWith("A full refund of $299 to your Visa ending 2208. Sorry, I mean $329."), "Refund amount"));
  assert.ok(!heard(refundWith("A full refund of $299, sorry, $329 to your Visa ending 2208."), "Refund amount"));
  // A correction with the wrong number, or a wrong number again after it, doesn't.
  assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear: a full refund of $239."), "Refund amount"));
  assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear: a full refund of $329.", "So $299 back to your card."), "Refund amount"));
  // Spoken the usual ways: "I'm sorry, I misspoke", "Okay, to be clear", "$329, not $299", and a bare opening
  // with the number in the next sentence, even on the next line (independent review of these fixes, 22 Oct).
  assert.ok(heard(refundWith("A full refund of $299 to your Visa ending 2208.", "I'm sorry, I misspoke. That's a full refund of $329."), "Refund amount"));
  assert.ok(heard(refundWith("A full refund of $299 to your Visa ending 2208.", "Okay, to be clear, that's a full refund of $329."), "Refund amount"));
  const notThat = refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear, that's $329, not $299.");
  assert.ok(heard(notThat, "Refund amount"));
  assert.match(doc(notThat, "Terms heard")!, /correcting 299 said before\)/, "the wrong number named once");
  const split = refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear,", "it's a full refund of $329.");
  assert.ok(heard(split, "Refund amount"));
  assert.match(doc(split, "Terms heard")!, /^Refund amount: "it's a full refund of \$329\." \(/, "quoted by the line that says the number");
  // The correction must itself say the record's number: one about another term, a negated one, or a bare one
  // followed by something else doesn't count, even with a plain repeat after it.
  for (const later of [
    ["To be clear, it goes to your Visa ending 2208.", "And it's $329."],
    ["To confirm, you'll get an email with a free return label.", "So that's $329 back."],
    ["To be clear: it's not $329.", "It's $329."],
    ["I misspoke.", "You'll get an email with a free return label.", "It's $329."],
  ])
    assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", ...later), "Refund amount"), later.join(" / "));
  // An apology alone isn't a correction, nor is a negated one.
  assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", "Sorry about that, a full refund of $329."), "Refund amount"));
  assert.ok(!heard(refundWith("A full refund of $299 to your Visa ending 2208.", "To be clear: it's not $329."), "Refund amount"));
});

test("a wrong card ending is put right the same way, and the amount said with it still counts", () => {
  const wrong = refundWith("A full refund of $329 to your Visa ending 1111.");
  assert.ok(heard(wrong, "Refund amount"));
  assert.ok(!heard(wrong, "Card it goes to"));
  assert.match(doc(wrong, "Terms heard")!, /Card it goes to: not heard yet \(said as ending 1111, which isn't the order's\)/);
  assert.equal(wrong.suggestedReply?.text, "To be clear: the refund goes to your Visa ending 2208.");

  const fixed = refundWith("A full refund of $329 to your Visa ending 1111.", "To be clear: the refund goes to your Visa ending 2208.");
  assert.ok(heard(fixed, "Card it goes to"));
  assert.match(doc(fixed, "Terms heard")!, /Card it goes to: "To be clear: the refund goes to your Visa ending 2208\." \([^)]*, correcting ending 1111 said before\)/);
  assert.ok(heard(refundWith("A full refund of $329 to your Visa ending 1111.", "Sorry, I mean ending 2208."), "Card it goes to"));
  // A correction about the amount, then a plain repeat of the card, doesn't put the card right.
  assert.ok(!heard(refundWith("A full refund of $329 to your Visa ending 1111.", "To be clear: that's a full refund of $329.", "It goes to the Visa ending 2208."), "Card it goes to"));
  assert.ok(heard(refundWith("A full refund of $329 to your Visa ending 1111.", "To be clear, it goes to the Visa ending 2208, not ending 1111."), "Card it goes to"));
  // Negated, it still isn't said.
  assert.ok(!heard(refundWith("A full refund of $329 to your Visa ending 1111.", "To be clear: it doesn't go to the Visa ending 2208."), "Card it goes to"));
});

/* ---------- The address field, ready as soon as the caller answers (22 Oct: about 20 s on the address) ---------- */

const ADDRESS_ANSWER = 7;
const address = (answer: Line, nameLine: Line = { side: "caller", text: "Sam Miller." }) =>
  script({ 5: nameLine, [ADDRESS_ANSWER]: answer }).slice(0, ADDRESS_ANSWER);

test("the address field binds to the caller's answer while it is still being checked, and stays on it after", () => {
  let v = view(address({ side: "caller", text: "Helrout.", checking: true }));
  assert.deepEqual(v.addressEntry, { key: "k7", checking: true });
  v = view(address({ side: "caller", text: "Hill Rote in Dalis.", firstHeard: "Helrout." }));
  assert.notEqual(v.verification.factors[1].state, "ok");
  assert.deepEqual(v.addressEntry, { key: "k7", checking: false });
});

test("the typing fields stay on the caller's answer while the agent says something else, until a later question (independent review)", () => {
  // "Thank you, one moment." while the check runs used to remove the field, and whatever was typed in it.
  const checking = address({ side: "caller", text: "Helrout.", checking: true });
  let v = view([...checking, { side: "agent", text: "Thank you, one moment." }]);
  assert.deepEqual(v.addressEntry, { key: "k7", checking: true });
  // After the next question it stays on the address answer, never on the answer to that question.
  v = view([...checking, { side: "agent", text: "And what's the order number?" }, { side: "caller", text: "4-2-7.", checking: true }]);
  assert.deepEqual(v.addressEntry, { key: "k7", checking: true });
  // The name field the same way.
  const name = script({ 5: { side: "caller", text: "Sen nilir.", checking: true } }).slice(0, 5);
  v = view([...name, { side: "agent", text: "Thank you, one moment." }]);
  assert.equal(v.nameEntry?.key, "k5");
  assert.equal(v.nameEntry?.checking, true);
});

test("no address field before the name is verified, and none when the address was heard right", () => {
  assert.equal(view(address({ side: "caller", text: "Helrout.", checking: true }, { side: "caller", text: "Sen nilir." })).addressEntry, null);
  assert.equal(view(address({ side: "caller", text: "Hill Road, in Dallas.", checking: true })).addressEntry, null);
  assert.equal(view(address({ side: "caller", text: "Hill Road, in Dallas." })).addressEntry, null);
});

test("typed into the field, the address is accepted, and a check result that lands later doesn't change it", () => {
  // Typed after the answer ended (typing earlier counts from the end of the answer).
  const typed: AgentAction = { type: "correct", key: "k7", text: "Hill Road, Dallas", at: at(ADDRESS_ANSWER, 4000) };
  let v = view(address({ side: "caller", text: "Helrout.", checking: true }), [typed]);
  assert.equal(v.verification.factors[1].state, "ok");
  assert.equal(v.addressEntry, null, "the field goes once the address is accepted");
  v = view(address({ side: "caller", text: "Hill Rote in Dalis.", firstHeard: "Helrout." }), [typed]);
  assert.equal(v.verification.factors[1].state, "ok");
  assert.equal(v.verification.factors[1].knownAt, typed.at, "accepted when it was typed, not when the check came back");
});
