import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_READ_BACK, analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  His two decisions of 23 Oct 12:35, development console only:
  "Cancel it": the caller clearly rejecting or correcting the agent's read-back of the name (or address) reopens that
  check, also after a Confirm press. What depends on it is blocked again and an approval given on it no longer counts. An
  unrelated "No" changes nothing.
  "Count it": a checked, complete "Yes, Sam Miller." to a read-back that already qualifies confirms it when the full name
  is exactly the one read back. Labelled as read back by the agent and confirmed by the caller, never as recognition of
  the caller's own answer. A different name, a "yes, but", a correction, anything else in the reply or a doubtful reply
  doesn't count. The address check and typing stay as they were.
*/

const NOW = Date.UTC(2026, 9, 23, 13);
const T0 = NOW - 600_000;
type Line = { side: "caller" | "agent"; text: string; confidence?: number; firstHeard?: string; checked?: boolean; checking?: boolean };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-decisions",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T0 + i * 5000,
    endedAt: T0 + i * 5000 + 3000,
    final: true,
    confidence: l.confidence ?? 0.9,
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
    ...(l.checked ? { checked: true } : {}),
    ...(l.checking ? { checking: true } : {}),
  }));
const both: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true, addressReadBack: true } };
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(both, events(lines), actions, NOW);
const name = (v: CopilotView) => v.verification.factors[0];
const address = (v: CopilotView) => v.verification.factors[1];
const card = (v: CopilotView, target: "name" | "address") => v.prompts.find((p) => p.target === target)?.text ?? "";
/** During the n-th line (counted from 1). */
const at = (n: number) => T0 + (n - 1) * 5000 + 100;

const opening: Line[] = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const ALIKE: Line = { side: "caller", text: "Sam Miler.", checked: true };
const NAME_BACK: Line = { side: "agent", text: "That's Sam Miller, is that right?" };
const ADDRESS_Q: Line = { side: "agent", text: "Thank you. And the street and city for the delivery?" };
const ADDRESS: Line = { side: "caller", text: "Hill Road, in Dallas.", checked: true };
const ADDR_BACK: Line = { side: "agent", text: "So that's Hill Road, Dallas, is that right?" };
const caller = (text: string, more: Partial<Line> = {}): Line => ({ side: "caller", text, checked: true, ...more });
const PRESS_NAME: AgentAction = { type: "confirm", target: "name", at: at(6) };

/* ---------- "Count it": the caller's yes with the full name ---------- */

test("a checked yes with exactly the name read back confirms it, labelled as read back, never as the caller's own answer", () => {
  for (const reply of [[caller("Yes, Sam Miller.")], [caller("Yes, that's Sam Miller.")], [caller("Yes."), caller("Sam Miller.")]]) {
    const said = reply.map((l) => l.text).join(" ");
    let v = view([...opening, ALIKE, NAME_BACK, ...reply, ADDRESS_Q]);
    assert.equal(name(v).state, "ok", said);
    assert.equal(name(v).method, NAME_READ_BACK, said);
    assert.equal(name(v).attempts, 0, said);
    assert.equal(v.verification.verified, false, `${said}: the street and city are still needed`);
    v = view([...opening, ALIKE, NAME_BACK, ...reply, ADDRESS_Q, ADDRESS]);
    assert.equal(v.verification.verified, true, said);
  }
});

test("a different name, part of it, a 'yes, but', a correction, more in the reply or a question doesn't confirm the read-back", () => {
  for (const said of [
    "Yes, Sam.",
    "Yes, Sam Millar.",
    "Yes, Tom Baker.",
    "Yes, but it's Tom Baker.",
    "Yes, Sam Miller. Actually, no.",
    "Yes, Sam Miller, I want a refund.",
    "Yes, Sam Miller?",
    "Sam Miller, yes.",
  ]) {
    const v = view([...opening, ALIKE, NAME_BACK, caller(said), ADDRESS_Q]);
    assert.notEqual(name(v).state, "ok", said);
    assert.notEqual(name(v).method, NAME_READ_BACK, said);
  }
  // The rest of the reply after a plain yes counts too: a correction in it ends the read-back.
  const v = view([...opening, ALIKE, NAME_BACK, caller("Yes, Sam Miller."), caller("Sorry, no, it's Tom Baker."), ADDRESS_Q]);
  assert.notEqual(name(v).state, "ok");
});

test("the yes with the name needs its check, a clear line and the fast model hearing a yes too", () => {
  const cases: [string, Line][] = [
    ["not checked", { side: "caller", text: "Yes, Sam Miller." }],
    ["still being checked", caller("Yes, Sam Miller.", { checked: false, checking: true })],
    ["unclear", caller("Yes, Sam Miller.", { confidence: 0.3 })],
    ["fast model heard a no", caller("Yes, Sam Miller.", { firstHeard: "No, Tom Baker." })],
    ["fast model heard another name", caller("Yes, Sam Miller.", { firstHeard: "Yes, Tom Baker." })],
  ];
  for (const [why, reply] of cases) {
    const v = view([...opening, ALIKE, NAME_BACK, reply, ADDRESS_Q]);
    assert.notEqual(name(v).state, "ok", why);
  }
  // The fast model hearing a sound-alike of the same name is fine when the check heard it exactly.
  const v = view([...opening, ALIKE, NAME_BACK, caller("Yes, Sam Miller.", { firstHeard: "Yes, Sam Muller." }), ADDRESS_Q]);
  assert.equal(name(v).method, NAME_READ_BACK);
});

test("the yes with the name counts only after a read-back that already qualifies", () => {
  // The agent said the name before the caller did: the caller's answer is an echo, and no read-back opens.
  let lines: Line[] = [...opening, caller("Sam."), { side: "agent", text: "Could you repeat your full name? Is it Sam Miller?" }, caller("Sam Millar."), { side: "agent", text: "Okay." }];
  let v = view([...lines, NAME_BACK, caller("Yes, Sam Miller."), ADDRESS_Q]);
  assert.notEqual(name(v).state, "ok", "after the agent supplied the name");
  // The caller gave another surname: reading the record's name back would fill in what wasn't heard.
  lines = [...opening, caller("Sam Jones.", { confidence: 0.3 }), { side: "agent", text: "Thank you." }];
  v = view([...lines, NAME_BACK, caller("Yes, Sam Miller."), ADDRESS_Q]);
  assert.notEqual(name(v).state, "ok", "after a different surname");
  // A wrong answer first: back to before, no read-back.
  lines = [...opening, caller("Tom Baker."), { side: "agent", text: "Okay." }];
  v = view([...lines, NAME_BACK, caller("Yes, Sam Miller."), ADDRESS_Q]);
  assert.notEqual(name(v).state, "ok", "after a wrong answer");
});

/* ---------- "Cancel it": a rejection reopens the check, also after Confirm ---------- */

const REJECTIONS = ["No.", "No, that's not my name.", "That's not my name.", "No, it's Tom Baker.", "That's wrong.", "Wrong name.", "Not quite, it's Sam Millar.", "Actually, it's Sam Millar."];

test("the caller rejecting the read-back after a Confirm press reopens the name; Confirm and another read-back don't count after it", () => {
  for (const said of REJECTIONS) {
    const lines = [...opening, ALIKE, NAME_BACK, caller(said), ADDRESS_Q, ADDRESS];
    let v = view(lines, [PRESS_NAME]);
    assert.notEqual(name(v).state, "ok", said);
    assert.equal(v.verification.verified, false, `${said}: identity isn't verified`);
    assert.equal(address(v).state, "ok", `${said}: the address answer is kept`);
    assert.match(card(v, "name"), /rejects the read-back/, said);
    // Pressing Confirm again doesn't override the caller.
    v = view(lines, [PRESS_NAME, { type: "confirm", target: "name", at: at(10) }]);
    assert.notEqual(name(v).state, "ok", `${said}: second press`);
    // Neither does reading it back again and hearing a yes.
    v = view([...lines, NAME_BACK, caller("Yes, that's right.")], [PRESS_NAME]);
    assert.notEqual(name(v).state, "ok", `${said}: second read-back`);
  }
  // Pressed after the read-back was said, before the reply: the same.
  const v = view([...opening, ALIKE, NAME_BACK, caller("No."), ADDRESS_Q, ADDRESS], [{ type: "confirm", target: "name", at: at(7) }]);
  assert.notEqual(name(v).state, "ok");
});

test("after the rejection, the name asked again and typed as the caller says it verifies, labelled as typed", () => {
  const lines = [...opening, ALIKE, NAME_BACK, caller("No, it's Tom Baker."), { side: "agent", text: "Sorry, could I have your full name again?" } as Line, caller("Sammílis.", { firstHeard: "Sam Ellis." }), ADDRESS_Q, ADDRESS];
  let v = view(lines, [PRESS_NAME]);
  assert.notEqual(name(v).state, "ok");
  v = view(lines, [PRESS_NAME, { type: "correct", key: "k9", text: "Sam Miller", at: at(10) }]);
  assert.equal(name(v).state, "ok");
  assert.match(name(v).method ?? "", /^typed by the agent/);
  assert.equal(v.verification.verified, true);
  // Typing the other name the caller gave records it: the check fails.
  v = view(lines, [PRESS_NAME, { type: "correct", key: "k9", text: "Tom Baker", at: at(10) }]);
  assert.notEqual(name(v).state, "ok");
});

test("an unrelated no, or a no after the agent has moved on, leaves the confirmed name as it is", () => {
  const cases: Line[][] = [
    // The read-back was confirmed; the no answers the next question.
    [NAME_BACK, caller("Yes."), { side: "agent", text: "Do you still have the box?" }, caller("No.")],
    // No read-back at all.
    [{ side: "agent", text: "Do you still have the box?" }, caller("No.")],
    [{ side: "agent", text: "Is there anything else?" }, caller("No, that's all.")],
    // Everyday words that start with no.
    [NAME_BACK, caller("No problem.")],
    [NAME_BACK, caller("Yes, no worries.")],
  ];
  for (const tail of cases) {
    const said = tail.map((l) => l.text).join(" / ");
    const v = view([...opening, ALIKE, ...tail, ADDRESS_Q, ADDRESS], [PRESS_NAME]);
    assert.equal(name(v).state, "ok", said);
    assert.equal(v.verification.verified, true, said);
  }
  // A no more than 8 s after the read-back isn't a reply to it.
  const late = view([...opening, ALIKE, NAME_BACK, { side: "agent", text: "Let me just pull that up." }, caller("No."), ADDRESS_Q, ADDRESS], [PRESS_NAME]);
  assert.equal(name(late).state, "ok");
});

test("an approval given on the name stops counting when the caller rejects the read-back after it", () => {
  const before: Line[] = [
    ...opening,
    ALIKE,
    ADDRESS_Q,
    ADDRESS,
    { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?" },
    caller("Yes, only the screen. Can I get a new one, or my money back?"),
    { side: "agent", text: "You can have either. Which do you prefer?" },
    caller("A new one, please."),
  ];
  const actions: AgentAction[] = [PRESS_NAME, { type: "confirm", target: "order", at: at(9) }, { type: "approve", at: at(12) }];
  let v = view([...before, { side: "agent", text: "Okay." }], actions);
  assert.equal(v.recommendation?.approval.state, "approved", "control: the approval counts");
  for (const said of ["No.", "No, it's Tom Baker."]) {
    const rejected = [...before, NAME_BACK, caller(said)];
    v = view([...rejected, { side: "agent", text: "Okay." }], actions);
    assert.notEqual(name(v).state, "ok", said);
    assert.equal(v.verification.verified, false, said);
    assert.notEqual(v.recommendation?.approval.state, "approved", said);
    // Verified again (asked again, typed as the caller says it): the earlier approval shows as not counted, and why.
    const again = [...rejected, { side: "agent", text: "Sorry, could I have your full name again?" } as Line, caller("Sammílis.", { firstHeard: "Sam Ellis." })];
    v = view(again, [...actions, { type: "correct", key: `k${again.length}`, text: "Sam Miller", at: at(again.length + 1) }]);
    assert.equal(v.verification.verified, true, said);
    assert.notEqual(v.recommendation?.approval.state, "approved", `${said}: a fresh approval is needed`);
    const h = v.recommendation?.history ?? [];
    assert.ok(h.length && h.every((x) => !x.counted), `${said}: ${JSON.stringify(h)}`);
    assert.ok(h.some((x) => /rejected the read-back/.test(x.reason ?? "")), `${said}: ${JSON.stringify(h)}`);
  }
  // A plain yes to the read-back leaves it standing.
  v = view([...before, NAME_BACK, caller("Yes, that's right."), { side: "agent", text: "Okay." }], actions);
  assert.equal(v.recommendation?.approval.state, "approved");
  // While the reply is still being checked, nothing can be approved.
  v = view([...before, NAME_BACK, caller("No.", { checked: false, checking: true })], actions);
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.equal(v.recommendation?.checkingIdentity?.text, "No.");
});

test("the address read-back works the same way: a rejection after Confirm reopens it, an unrelated no doesn't", () => {
  const base = [...opening, caller("Sam Miller."), ADDRESS_Q, caller("Hill Rode in Dallas.")];
  const press: AgentAction = { type: "confirm", target: "address", at: at(8) };
  let v = view([...base, ADDR_BACK, caller("No, it's Elm Road in Austin."), { side: "agent", text: "Okay." }], [press]);
  assert.notEqual(address(v).state, "ok");
  assert.equal(v.verification.verified, false);
  v = view([...base, ADDR_BACK, caller("No, that's wrong."), { side: "agent", text: "Okay." }], [press]);
  assert.notEqual(address(v).state, "ok");
  v = view([...base, ADDR_BACK, caller("Yes, that's right."), { side: "agent", text: "Do you still have the box?" }, caller("No.")], [press]);
  assert.equal(address(v).state, "ok");
  assert.equal(v.verification.verified, true);
});

/* ---------- Independent review of the change (23 Oct): each finding, with the cases that must still work ---------- */

const VERIFIED: Line[] = [
  ...opening,
  caller("Sam Miller."),
  ADDRESS_Q,
  ADDRESS,
  { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?" },
  caller("Yes, only the screen. Can I get a new one, or my money back?"),
  { side: "agent", text: "You can have either. Which do you prefer?" },
  caller("A new one, please."),
];
const APPROVED: AgentAction[] = [{ type: "confirm", target: "order", at: at(9) }, { type: "approve", at: at(12) }];
const afterBack = (back: Line, reply: Line[]) => view([...VERIFIED, back, ...reply, { side: "agent", text: "Okay." }], APPROVED);
const stands = (v: CopilotView) => v.verification.verified && v.recommendation?.approval.state === "approved";

test("review: everyday rejections and corrections of a read-back reopen it, the name's and the address's", () => {
  for (const said of [
    "No, that's my husband.",
    "No, I'm his wife.",
    "No, that's my dad's name.",
    "It's Millar, not Miller.",
    "Not Miller, Millar.",
    "No, M I L L A R.",
    "No, it's spelled differently.",
    "You've got the wrong name.",
    "Yes, but it's Millar with an A.",
    "Close, but it's Millar.",
    "Actually, it's Sam Millar.",
  ])
    assert.equal(stands(afterBack(NAME_BACK, [caller(said)])), false, said);
  for (const said of ["No, we moved.", "Not anymore.", "That's my old address.", "No, it's Austin now.", "Actually we moved to Austin."])
    assert.equal(stands(afterBack(ADDR_BACK, [caller(said)])), false, said);
  // "Yes." then a separate "No.": the later no takes it back.
  assert.equal(stands(afterBack(NAME_BACK, [caller("Yes."), caller("No.")])), false);
});

test("review: backchannels, a yes with delivery details, 'No, that's right.' and a no answering another question don't reopen it", () => {
  for (const said of ["Mm-hmm.", "Uh-huh.", "Mhm.", "No, that's right.", "No problem.", "Yes, no worries."]) {
    assert.equal(stands(afterBack(NAME_BACK, [caller(said)])), true, said);
    assert.equal(stands(afterBack(NAME_BACK, [caller("Yes.", { firstHeard: said })])), true, `fast model heard ${said}`);
  }
  for (const said of ["Yes, that's it. The blue house at the end of the road.", "Yep. It's just off Main Street.", "Yes, that's right, the corner of Hill Road and Oak Street."])
    assert.equal(stands(afterBack(ADDR_BACK, [caller(said)])), true, said);
  // Two questions back to back: the no answers the box, the yes the name.
  const v = view([...VERIFIED, { side: "agent", text: "Do you still have the original box?" }, { side: "agent", text: "And just to confirm, that's Sam Miller, is that right?" }, caller("No."), caller("And yes, that's me."), { side: "agent", text: "Okay, no problem." }], APPROVED);
  assert.equal(stands(v), true);
});

test("review: after a rejection, the caller saying the name the agent read out is an echo, and typing over the rejection doesn't erase it", () => {
  const rejected = [...VERIFIED, NAME_BACK, caller("No, that's not my name."), { side: "agent", text: "Sorry about that. Could I have your full name again?" } as Line];
  let v = view([...rejected, caller("Sam Miller."), { side: "agent", text: "Thank you." }], APPROVED);
  assert.notEqual(name(v).state, "ok", "the repeat follows the agent saying the name");
  assert.equal(name(v).confirmReason, "after-read-back");
  // Typed as the caller says it: verified, labelled as typed after the agent said it.
  v = view([...rejected, caller("Sam Miller."), { side: "agent", text: "Thank you." }], [...APPROVED, { type: "correct", key: `k${rejected.length + 1}`, text: "Sam Miller", at: at(rejected.length + 2) }]);
  assert.equal(name(v).method, "typed by the agent, after the agent said it on the call");
  assert.notEqual(v.recommendation?.approval.state, "approved", "the approval before the rejection still doesn't count");
  // Typing the name over the caller's rejection line itself verifies nothing.
  v = view([...VERIFIED, NAME_BACK, caller("No, that's not my name."), { side: "agent", text: "Okay." }], [...APPROVED, { type: "correct", key: `k${VERIFIED.length + 2}`, text: "Sam Miller", at: at(VERIFIED.length + 3) }]);
  assert.notEqual(name(v).state, "ok");
  assert.notEqual(v.recommendation?.approval.state, "approved");
});

test("review: a name said on a later line of the yes counts only when checked, clear and heard as the name by both models", () => {
  const pre: Line[] = [...opening, caller("Sammílis.", { firstHeard: "Sen nilir." }), NAME_BACK, caller("Yes.")];
  for (const [why, line] of [
    ["check failed", { side: "caller", text: "Sam Miller.", checked: false } as Line],
    ["unclear", caller("Sam Miller.", { confidence: 0.3 })],
    ["fast model heard another name", caller("Sam Miller.", { firstHeard: "Tom Baker." })],
  ] as [string, Line][])
    assert.notEqual(name(view([...pre, line, ADDRESS_Q])).state, "ok", why);
  assert.equal(name(view([...pre, caller("Sam Miller.", { firstHeard: "Sam Muller." }), ADDRESS_Q])).method, NAME_READ_BACK);
  // The fast model hearing only part of the name isn't enough for the one-line yes either.
  for (const fast of ["Yes, Sam.", "Yes, Millar."])
    assert.notEqual(name(view([...opening, ALIKE, NAME_BACK, caller("Yes, Sam Miller.", { firstHeard: fast }), ADDRESS_Q])).state, "ok", fast);
});

test("review: while the reply to the read-back is checked, the suggested reply doesn't say the outcome is done", () => {
  const v = view([...VERIFIED, NAME_BACK, caller("Yes.", { checked: false, checking: true })], [{ type: "confirm", target: "order", at: at(9) }]);
  assert.equal(v.recommendation?.approval.state, "not-ready");
  assert.doesNotMatch(v.suggestedReply?.text ?? "", /Done|ships today/);
});

/* ---------- Second independent review: how callers actually phrase it ---------- */

const pressed = (said: string, id: "name" | "address") => {
  const v =
    id === "name"
      ? view([...opening, ALIKE, NAME_BACK, caller(said), ADDRESS_Q, ADDRESS], [PRESS_NAME])
      : view([...opening, caller("Sam Miller."), ADDRESS_Q, caller("Hill Rode in Dallas."), ADDR_BACK, caller(said), { side: "agent", text: "Okay." }], [{ type: "confirm", target: "address", at: at(8) }]);
  return (id === "name" ? name(v) : address(v)).state === "ok";
};
/** Whether the detail still stands after this reply: after an approval, and after a Confirm press. */
const still = (said: string, id: "name" | "address") => [stands(afterBack(id === "name" ? NAME_BACK : ADDR_BACK, [caller(said)])), pressed(said, id)];

test("review 2: a rejection led by a sound or a softener, a yes taken back later, someone else's name or an old address reopens it", () => {
  for (const said of [
    "Um, no.", "Oh, no.", "Er, no, sorry.", "Sorry, no.", "Sorry, that's not right.", "Oh no, that's not right.", "Well, no.",
    "Hmm, not quite.", "I'm afraid not.", "Actually, no.", "No, sorry, that's not me.", "Erm, that's wrong.", "You've got it wrong.",
    "It's with an A, not an E.", "Sorry, it's M-I-L-L-A-R.", "I'm Sam's mum.", "I'm his mum actually.", "That was my maiden name.",
    "Yes. Oh, hang on, no, it's Millar.", "Yes. Well, no, it's Sam Millar.", "Yes. Hmm, no.", "Nope.", "Nah, it's Millar.",
    "No, that's my brother.", "That's my son, I'm calling for him.", "Uh, it's Millar, with an A.", "No no, it's Sam Millar.",
    "That's not it.", "Not Sam, Pam.", "Oh, sorry, that's my husband's name.",
  ])
    assert.deepEqual(still(said, "name"), [false, false], said);
  for (const said of [
    "Oh, that's my old one.", "That was my old one.", "We don't live there anymore.", "We don't live there any more.", "Um, no.", "Sorry, no.",
    "Oh no, we moved.", "Er, not anymore.", "Hmm, no, it's Elm Road now.", "Yes. Oh, hang on, no, it's Elm Road.", "That's my mum's place.",
    "That's my old house.", "That was where I used to be.", "We've moved since.", "I'm afraid not, it's Austin now.",
  ])
    assert.deepEqual(still(said, "address"), [false, false], said);
});

test("review 2: a no said for yes, a yes with a no about something else, or a relative mentioned in passing leaves it standing", () => {
  for (const said of [
    "Yes please.", "That's right, thanks.", "Yeah, go ahead.", "Okay.", "Sure.", "Right.", "Spot on.", "Correct, yes.", "Yes it is.",
    "That's me.", "Speaking.", "No, no, that's fine.", "Not a problem.", "No rush.", "Yes, Sam Miller here.", "Yes. Oh, and the box is gone.",
    "Yes. Actually, can you hurry?", "Yes, sorry, I'm driving.", "Yes, that's right.",
    "No, no, that's fine, go ahead.", "No, that's fine, thanks.", "Nope, that's right.", "No, that's correct, thank you.", "Nah, that's right.",
    "Yeah. No, all good.", "Yes. No, you're fine.", "Yes, but I never got the tablet.", "Yes, but the box isn't here.",
    "Yes, sorry, I wasn't sure you were talking to me.", "Yes, sorry, I'm not at home right now.", "Yes, sorry, it's not a great line.",
    "That's right, but it's not urgent.", "Yes, that's right. No, I haven't opened the box.", "Yep. Sorry, I'm not very good with phones.",
    "Yeah, that's me, though I don't use the account much.", "Uh, yes.", "Mm, yes, that's right.", "Yes, that's me. My wife placed the order.",
    "Speaking. My wife might call too.", "That's correct. Never had a problem before.", "Yes, it is. Not that it matters.", "Absolutely, no doubt.",
  ])
    assert.deepEqual(still(said, "name"), [true, true], said);
  for (const said of [
    "Yes please.", "That's right, thanks.", "Yeah, go ahead.", "Okay.", "Sure.", "Right.", "Spot on.", "Correct, yes.", "Yes it is.",
    "No, no, that's fine.", "Not a problem.", "No rush.", "Yes, it's in Dallas.", "Yep, Hill Road.", "Yes. Oh, and the box is gone.",
    "Okay. Just so you know, there's no parking on Hill Road.", "Mm-hmm, Dallas, not Fort Worth.", "Yes, but there's no buzzer.",
    "Yes, but nobody's home until six.", "Yes, though the house number isn't on the door.", "Uh-huh, it's the one with no gate on Hill Road.",
    "Yeah, but I'm not home till five.", "Sure, it's not far from the main road.",
  ])
    assert.deepEqual(still(said, "address"), [true, true], said);
});
