import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { matchAddress, matchName, readBackFits, strictFlags } from "./verification";
import { sunlake } from "@/lib/live/sunlake-data";

/*
  His "Stricter matching" (12 Nov), after the false match test on real voices: the check model wrote the caller's
  "Laura Anderton" as "Laura Anderson", the record's exact words, so a spoken match alone would have verified the wrong
  person (I-53); and an exact match ignored the rest of the answer, so "Church Hill Road, in Dallas" verified Hill Road
  (I-54). Two switches, on in the dev console only:
  - Policy.agentConfirmsMatch: no name or address verifies from speech alone. A match waits for the agent's Confirmed
    press and is labelled as the agent's confirmation. Typing, and a read-back the caller confirms, verify as before.
  - Policy.strictMatch: a match that also says more (another street, place, state or name, someone else's, a correction,
    a different spelling) is asked again: never verified, never a failed attempt.
*/
const customer = sunlake.customers.find((c) => c.id === sunlake.callerCustomerId)!;
const T = Date.UTC(2026, 10, 12, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; checked?: boolean; checking?: boolean; availableAt?: number; heldAt?: number };
const timed = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-sm",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T + l.s,
    endedAt: T + l.e,
    final: true,
    confidence: 0.9,
    ...(l.checked ? { checked: true } : {}),
    ...(l.checking ? { checking: true } : {}),
    ...(l.availableAt !== undefined ? { availableAt: T + l.availableAt } : {}),
    ...(l.heldAt !== undefined ? { heldAt: T + l.heldAt } : {}),
  }));
type Switches = { press?: boolean; strict?: boolean; readBack?: boolean };
const pack = (o: Switches): ClientPack => ({
  ...sunlake,
  policy: { ...sunlake.policy, agentConfirmsMatch: !!o.press, strictMatch: !!o.strict, nameReadBack: !!o.readBack, addressReadBack: !!o.readBack },
});
const run = (o: Switches, lines: L[], now: number, actions: AgentAction[] = []) => analyze(pack(o), timed(lines), actions, T + now);
const press = (target: "name" | "address", at: number): AgentAction => ({ type: "confirm", target, at: T + at });
const factor = (v: CopilotView, id: "name" | "address") => v.verification.factors.find((f) => f.id === id)!;
const promptFor = (v: CopilotView, id: "name" | "address") => v.prompts.find((p) => p.target === id);
const step = (v: CopilotView, id: "name" | "address" | "order") => v.steps.find((s) => s.id === id)!;

const OPEN: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today.", s: 10_000, e: 12_000 },
  { side: "agent", text: "First, can I have your full name, please?", s: 12_500, e: 14_500 },
];
const NAME: L = { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true };
const ADDR_Q: L = { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 18_000, e: 20_000 };
const ADDR: L = { side: "caller", text: "Hill Road, in Dallas.", s: 21_000, e: 23_000, checked: true };
const DAMAGE_Q: L = { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?", s: 25_000, e: 27_500 };
const CALL: L[] = [...OPEN, NAME, ADDR_Q, ADDR];

test("both switches are off unless the dev console build sets them", () => {
  if (!process.env.NEXT_PUBLIC_AGENT_CONFIRMS_MATCH) assert.equal(sunlake.policy.agentConfirmsMatch, false);
  if (!process.env.NEXT_PUBLIC_STRICT_MATCH) assert.equal(sunlake.policy.strictMatch, false);
  // Off, a spoken match verifies as it always has.
  const v = run({}, [...CALL, DAMAGE_Q], 30_000);
  assert.equal(v.verification.verified, true);
  assert.equal(factor(v, "address").method, "street and city");
});

test("with the press on, a spoken name and address match wait for the agent and verify nothing by themselves", () => {
  const v = run({ press: true }, [...CALL, DAMAGE_Q], 30_000);
  assert.equal(v.verification.verified, false);
  for (const id of ["name", "address"] as const) {
    assert.equal(factor(v, id).state, "confirm", id);
    assert.equal(factor(v, id).confirmReason, "match", id);
    assert.equal(factor(v, id).method, undefined, id);
    assert.equal(step(v, id).status, "attention", id);
    assert.equal(step(v, id).detail, "Please confirm", id);
    const p = promptFor(v, id)!;
    assert.ok(p, id);
    assert.equal(p.askAgain, undefined, `${id}: the card has a Confirmed button`);
    assert.match(p.text, /doesn't verify .* by itself: press Confirmed only if you clearly heard the caller say it/, id);
  }
  assert.match(promptFor(v, "name")!.text, /ask them to spell the last name/);
  assert.match(promptFor(v, "address")!.text, /matches the street and city on the order/);
  // No order details before identity is verified.
  assert.equal(v.order.match, undefined);
  assert.equal(v.suggestedReply?.text, "Thank you. One moment while I confirm your details.");
  assert.deepEqual(v.undoable, []);
});

test("the agent's press verifies, labelled as the agent's confirmation, and the order read back before it still counts", () => {
  const lines = [...CALL, DAMAGE_Q];
  const v = run({ press: true }, lines, 30_000, [press("name", 17_000), press("address", 24_000)]);
  assert.equal(v.verification.verified, true);
  assert.equal(factor(v, "name").method, "confirmed by the agent");
  assert.equal(factor(v, "address").method, "confirmed by the agent, street and city");
  assert.equal(step(v, "name").detail, "Confirmed by the agent");
  assert.equal(step(v, "address").detail, "Confirmed by the agent, street and city");
  assert.deepEqual(v.undoable, ["name", "address"]);
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value!, /verified by full name \(confirmed by the agent\) and street and city \(confirmed by the agent\)$/);
  // The read-back "I can see the tablet on order 427" came between the caller's answers and the address press: it
  // counts once the press confirms those same answers, as it counted when the match verified them by itself.
  const late = run({ press: true }, lines, 30_000, [press("name", 17_000), press("address", 28_000)]);
  assert.equal(late.verification.verified, true);
  assert.equal(late.order.match?.confirmed, true);
  assert.equal(run({}, lines, 30_000).order.match?.confirmed, true);
});

test("Undo takes the press back and the match waits again; typing verifies without a press", () => {
  const actions = [press("name", 17_000), { type: "undo", target: "name", at: T + 19_000 } as AgentAction];
  const v = run({ press: true }, CALL, 30_000, actions);
  assert.equal(factor(v, "name").state, "confirm");
  assert.equal(factor(v, "name").confirmReason, "match");
  assert.deepEqual(v.undoable, []);
  // Typed by the agent: checked word for word against the order, as before.
  const typed = run({ press: true }, CALL, 30_000, [{ type: "correct", key: "k5", text: "Sam Miller", at: T + 17_000 }]);
  assert.equal(factor(typed, "name").state, "ok");
  assert.match(factor(typed, "name").method ?? "", /typed by the agent/);
});

test("a near-miss heard as the record's exact words (I-53) never verifies without the agent", () => {
  // On 11 Nov the check model wrote "Laura Anderton" as "Laura Anderson" in every run. Here: "Sam Mellor" heard as "Sam Miller".
  const v = run({ press: true, strict: true }, [...CALL, DAMAGE_Q], 60_000);
  assert.equal(v.verification.verified, false);
  assert.equal(factor(v, "name").confirmReason, "match");
});

test("a sound-alike still takes the existing confirm path, not the match card", () => {
  const v = run({ press: true }, [...OPEN, { ...NAME, text: "Sam Millar." }, ADDR_Q], 25_000);
  assert.equal(factor(v, "name").state, "confirm");
  assert.notEqual(factor(v, "name").confirmReason, "match");
});

test("a correction after a held match withdraws it: asked again, never a failed attempt", () => {
  const lines: L[] = [...OPEN, NAME, { side: "caller", text: "No wait, it's Tom Baker.", s: 16_500, e: 18_000, checked: true }, { ...ADDR_Q, s: 19_000, e: 21_000 }];
  const v = run({ press: true }, lines, 25_000);
  assert.equal(factor(v, "name").state, "confirm");
  assert.equal(factor(v, "name").confirmReason, "ambiguous");
  assert.equal(factor(v, "name").attempts, 0);
  // A press can't verify it now.
  const pressed = run({ press: true }, lines, 25_000, [press("name", 22_000)]);
  assert.equal(factor(pressed, "name").state, "confirm");
});

test("after a refused street-and-city read-back, the caller's email still verifies with the agent's press (replay finding)", () => {
  const lines: L[] = [
    ...OPEN,
    NAME,
    ADDR_Q,
    { side: "caller", text: "Hill Rode in Dallas.", s: 21_000, e: 22_500, checked: true },
    { side: "agent", text: "So that's Hill Road, Dallas, is that right?", s: 23_000, e: 25_000 },
    { side: "caller", text: "No.", s: 25_500, e: 25_900, checked: true },
    { side: "agent", text: "Okay. Could you give me the email address on the order instead?", s: 27_000, e: 29_500 },
    { side: "caller", text: "s dot miller at example mail dot com.", s: 30_000, e: 32_500, checked: true },
  ];
  const held = run({ press: true, readBack: true }, lines, 36_000, [press("name", 17_000)]);
  assert.equal(factor(held, "address").confirmReason, "match");
  assert.match(promptFor(held, "address")!.text, /matches the email on the order/);
  const v = run({ press: true, readBack: true }, lines, 36_000, [press("name", 17_000), press("address", 34_000)]);
  assert.equal(v.verification.verified, true);
  assert.equal(factor(v, "address").method, "confirmed by the agent, email");
});

test("a refused read-back of the held answer itself withdraws it, and the agent can't press it back", () => {
  const lines: L[] = [
    ...CALL,
    { side: "agent", text: "So that's Hill Road, Dallas, is that right?", s: 24_000, e: 26_000 },
    { side: "caller", text: "No, that's my old address.", s: 26_500, e: 28_000, checked: true },
  ];
  const v = run({ press: true, readBack: true }, lines, 35_000, [press("name", 17_000), press("address", 30_000)]);
  assert.equal(v.verification.verified, false);
  assert.notEqual(factor(v, "address").state, "ok");
});

test("stricter rules: an answer with the record's words and more is asked again, never verified, never a failed attempt (I-54)", () => {
  const cases: [L, RegExp][] = [
    [{ ...ADDR, text: "Church Hill Road, in Dallas." }, /a word before the street: Church/],
    [{ ...ADDR, text: "Hill Road in Dallas, Oklahoma." }, /another state: Oklahoma/],
    [{ ...ADDR, text: "Hill Road near Dallas." }, /a place word: near/],
  ];
  for (const [line, why] of cases) {
    const v = run({ strict: true }, [...OPEN, NAME, ADDR_Q, line], 30_000);
    assert.equal(factor(v, "address").state, "confirm", line.text);
    assert.equal(factor(v, "address").confirmReason, "ambiguous", line.text);
    assert.equal(factor(v, "address").attempts, 0, line.text);
    assert.equal(promptFor(v, "address")!.askAgain, true, line.text);
    assert.match(promptFor(v, "address")!.text, why, line.text);
    // Off, the same answer verifies Hill Road: today's I-54.
    assert.equal(factor(run({}, [...OPEN, NAME, ADDR_Q, line], 30_000), "address").state, "ok", line.text);
  }
  const forSomeone = run({ strict: true }, [...OPEN, { ...NAME, text: "It's for my husband, Sam Miller." }, ADDR_Q], 25_000);
  assert.equal(factor(forSomeone, "name").confirmReason, "ambiguous");
  assert.match(promptFor(forSomeone, "name")!.text, /Ask for the full name once more.*said for someone else: husband/);
});

test("stricter rules: plain answers, everyday words and the record spelled out still match", () => {
  for (const t of ["Sam Miller.", "My name is Sam Miller.", "Mr. Sam Miller.", "Sam Miller, sorry, I'm driving.", "Sam Miller. Sorry, bad line. Sam Miller.", "Sam Miller, M I double L E R.", "Yes, Sam Miller. Thanks."])
    assert.equal(matchName(t, customer, { strict: true }), "match", t);
  for (const t of ["Hill Road in Dallas.", "It's 12 Hill Road, Dallas, Texas.", "Hill Rd, Dallas", "Hill Road, Dallas, OK.", "Hill Road in Dallas, TX.", "Hill Road, apartment 4, Dallas.", "City: Dallas. Street: Hill Road.", "Hill, um, Road in Dallas.", "Hill Road in Dallas, Texas, USA.", "s dot miller at example mail dot com", "Forty-eight [pause 1.0 s] Hill Road in Dallas."])
    assert.equal(matchAddress(t, customer, { strict: true }), "match", t);
});

test("stricter rules: another name, someone else's, a different spelling or a correction is asked again", () => {
  const name: [string, RegExp][] = [
    ["Sam Miller Junior.", /someone else: Junior/],
    ["Mary Sam Miller.", /another name beside it: Mary/],
    ["Sam and Jane Miller.", /another name beside it: Jane/],
    ["I'm calling for Sam Miller.", /someone else: for/],
    ["Sam Miller, M E L L O R.", /spelled out: MELLOR/],
    ["Sam Miller, Mellor.", /another spelling: Mellor/],
    ["Sam Miller. Sorry, Sam muller.", /a correction, then: muller/],
  ];
  for (const [t, why] of name) {
    assert.equal(matchName(t, customer), "match", `${t}: today`);
    assert.equal(matchName(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("name", t, customer).join("; "), why, t);
  }
  const address: [string, RegExp][] = [
    ["Hill Road Extension in Dallas.", /a word after the street: Extension/],
    ["Hill Road in North Dallas.", /a word beside the city: North/],
    ["Hill Road in Lake Dallas.", /a word beside the city: Lake/],
    ["Old Hill Road in Dallas", /a word before the street: Old/],
    ["Hill Road, Dallas Fort Worth", /a word beside the city: Fort/],
    ["Hill Road in Dallas, Main Street.", /another street type: Street/],
    ["My mother's place, Hill Road in Dallas.", /someone else: mother/],
    ["s dot miller at example mail dot com dot uk", /other words with the email: uk/],
  ];
  for (const [t, why] of address) {
    assert.equal(matchAddress(t, customer), "match", `${t}: today`);
    assert.equal(matchAddress(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("address", t, customer).join("; "), why, t);
  }
});

test("stricter rules: someone else's, another of the same name, the past, an email for the name, an email's marks (traps left after the first re-score)", () => {
  const name: [string, RegExp][] = [
    ["Hello? Yes. Sam Miller's house.", /someone else's: Miller's/],
    ["Mrs Miller, the account is Sam's.", /someone else's: Sam's/],
    ["Tom Baker. This number used to be Sam Miller's.", /the past: used to.*someone else's: Miller's/],
    ["Sam Miller the Third.", /someone else: the Third/],
    ["Sam Miller, the second one.", /someone else: the second/],
    ["Sam Miller the younger.", /someone else: the younger/],
    ["sam miller at example mail dot com", /an email, not a name/],
  ];
  for (const [t, why] of name) {
    assert.equal(matchName(t, customer), "match", `${t}: today`);
    assert.equal(matchName(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("name", t, customer).join("; "), why, t);
  }
  const address: [string, RegExp][] = [
    ["It used to be Hill Road in Dallas.", /the past: used to/],
    ["My previous address was Hill Road in Dallas.", /the past: previous/],
    ["We moved from Hill Road in Dallas.", /the past: moved from/],
    ["s dot miller at example dot mail dot com", /another mark in the email: dot/],
    ["s underscore miller at example mail dot com", /another mark in the email: underscore/],
    ["s dash miller at example mail dot com", /another mark in the email: dash/],
    ["s dot miller at example mail dot com dot", /a mark after the email: dot/],
    ["s dot miller at example mail dot com, no, s dot miller one at example mail dot com.", /a number in the email: one/],
  ];
  for (const [t, why] of address) {
    assert.equal(matchAddress(t, customer), "match", `${t}: today`);
    assert.equal(matchAddress(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("address", t, customer).join("; "), why, t);
  }
  // Still the caller's own: "'s" heard for "is" or after the name alone (10 Oct), a sentence that starts with "The second",
  // the record's own marks however they are said or written, a mark left out, and a number before the email.
  for (const t of ["Sam Miller's.", "My name is Sam Miller's.", "This is Sam Miller's.", "Sam Miller's my name.", "Sam Miller's speaking.", "Sam Miller's. Thank you.", "Yes, it's Sam Miller. The second time I'm calling, actually.", "Sam Miller. I used the tablet once."])
    assert.equal(matchName(t, customer, { strict: true }), "match", t);
  for (const t of ["s dot miller at example dash mail dot com", "It's s dot miller at example hyphen mail dot com, thanks.", "es dot miller at example dash mail dot com", "S dot Miller at example-mail dot com.", "s dot miller at example mail dot com", "One moment. s dot miller at example dash mail dot com.", "s dot miller at example dash mail dot com. Sorry, example dash mail dot com.", "We just moved to Hill Road in Dallas."])
    assert.equal(matchAddress(t, customer, { strict: true }), "match", t);
});

test("stricter rules: a read-back never says back the record for an answer that said more", () => {
  assert.equal(readBackFits("address", "Church Hill Rode in Dallas.", customer), true, "today");
  assert.equal(readBackFits("address", "Church Hill Rode in Dallas.", customer, { strict: true }), false);
  // A sound-alike alone, or said twice around everyday words, still fits.
  assert.equal(readBackFits("name", "Sam Millar.", customer, { strict: true }), true);
  assert.equal(readBackFits("name", "Sam Millar. Sorry, bad line. Sam Millar.", customer, { strict: true }), true);
  const v = run({ strict: true, readBack: true }, [...OPEN, NAME, ADDR_Q, { ...ADDR, text: "Church Hill Rode, in Dallas." }, { side: "agent", text: "Thank you.", s: 24_000, e: 24_800 }], 26_000);
  assert.notEqual(v.addressEntry?.readBack, "available");
});

test("both switches: a spelled other surname after a held match withdraws it", () => {
  const lines: L[] = [...OPEN, NAME, { side: "caller", text: "M E L L O R.", s: 16_500, e: 18_500, checked: true }, { ...ADDR_Q, s: 19_000, e: 21_000 }];
  const v = run({ press: true, strict: true }, lines, 25_000);
  assert.equal(factor(v, "name").state, "confirm");
  assert.equal(factor(v, "name").confirmReason, "ambiguous");
  // Spelling the record's own name keeps the match waiting for the press.
  const own = run({ press: true, strict: true }, [...OPEN, NAME, { ...lines[5], text: "M I double L E R." }, lines[6]], 25_000);
  assert.equal(factor(own, "name").confirmReason, "match");
});

/* The one independent review of C10 (12 Nov): what it confirmed, fixed. */

test("review of C10: a capital at a sentence's start names nothing; written beside the name it still does", () => {
  for (const t of ["Sam Miller. Quick question about my order.", "Sam Miller. Listen, the screen is cracked.", "Sam Miller. Problem is the screen.", "Howdy, Sam Miller.", "Salam, Sam Miller.", "Inshallah, Sam Miller."])
    assert.equal(matchName(t, customer, { strict: true }), "match", t);
  assert.match(strictFlags("name", "Mary Sam Miller.", customer).join("; "), /another name beside it: Mary/);
  assert.match(strictFlags("name", "Pam and Sam Miller.", customer).join("; "), /another name beside it: Pam/);
  // A misheard surname is the sound-alike itself, not another name: the agent confirms it or reads it back.
  assert.deepEqual(strictFlags("name", "Sam Millerius.", customer, { readBack: true }), []);
});

test("review of C10: the record spelled with double, two or as in is the caller's own; another spelling is asked again", () => {
  for (const t of ["Sam Miller, M as in Mary, I, double L, E, R.", "Sam Miller, M I two L E R.", "Sam Miller, M-I-double L-E-R.", "Sam Miller, Miller with two Ls.", "Sam with one M, Miller with two L.", "Sam Miller, M as in Mother, I, L, L, E, R."])
    assert.equal(matchName(t, customer, { strict: true }), "match", t);
  assert.match(strictFlags("name", "Sam Miller, M I double L A R.", customer).join("; "), /spelled out: MILLAR/);
  // Asked to spell it after a held match: the record's spelling keeps it waiting for the press, and the press verifies.
  const spell = (text: string): L[] => [...OPEN, NAME, { side: "agent", text: "Could you spell the last name for me?", s: 16_500, e: 18_000 }, { side: "caller", text, s: 18_500, e: 19_500, checked: true }];
  for (const t of ["M I double L E R.", "M, I, two L, E, R.", "M as in Mary, I, double L, E, R.", "Miller with two Ls."]) {
    assert.equal(factor(run({ press: true, strict: true }, spell(t), 22_000), "name").confirmReason, "match", t);
    assert.equal(factor(run({ press: true, strict: true }, spell(t), 22_000, [press("name", 20_500)]), "name").state, "ok", t);
  }
  for (const t of ["M I L L A R.", "M I double L A R."]) {
    const v = run({ press: true, strict: true }, spell(t), 22_000, [press("name", 20_500)]);
    assert.equal(factor(v, "name").state, "confirm", t);
    assert.equal(factor(v, "name").confirmReason, "ambiguous", t);
  }
});

test("review of C10: the press waits while the caller's next line is still being checked, then counts or doesn't", () => {
  const acts = [press("name", 17_000), press("address", 25_000)];
  const next = (text: string, checking: boolean): L =>
    checking ? { side: "caller", text, s: 23_500, e: 24_800, checking: true } : { side: "caller", text, s: 23_500, e: 24_800, checked: true, availableAt: 27_000, heldAt: 24_800 };
  // A correction: still waiting while it is checked, then asked again.
  const waiting = run({ press: true, strict: true }, [...CALL, next("Sorry, that's Church Hill Road.", true)], 25_500, acts);
  assert.equal(factor(waiting, "address").state, "confirm");
  assert.equal(factor(waiting, "address").confirmReason, "match");
  const landed = run({ press: true, strict: true }, [...CALL, next("Sorry, that's Church Hill Road.", false)], 28_000, acts);
  assert.equal(factor(landed, "address").confirmReason, "ambiguous");
  assert.equal(landed.verification.verified, false);
  // Nothing new in it: the press counts once the check lands.
  const fine = run({ press: true, strict: true }, [...CALL, next("That's right.", false)], 28_000, acts);
  assert.equal(factor(fine, "address").state, "ok");
  assert.equal(factor(fine, "address").method, "confirmed by the agent, street and city");
});

test("review of C10: a correction on the caller's next line withdraws a held name; a sound-alike that says more is asked again", () => {
  const corrected = [...OPEN, NAME, { side: "caller" as const, text: "Sorry, Millar.", s: 16_200, e: 17_000, checked: true }, ADDR_Q];
  for (const acts of [[], [press("name", 18_000)]]) {
    const v = run({ press: true, strict: true }, corrected, 24_000, acts);
    assert.equal(factor(v, "name").state, "confirm");
    assert.equal(factor(v, "name").confirmReason, "ambiguous");
  }
  const more = [...OPEN, NAME, ADDR_Q, { ...ADDR, text: "Church Hill Rode, in Dallas." }];
  const v = run({ press: true, strict: true }, more, 30_000, [press("name", 17_000), press("address", 25_000)]);
  assert.equal(factor(v, "address").confirmReason, "ambiguous");
  assert.equal(promptFor(v, "address")!.askAgain, true);
  assert.equal(factor(v, "address").attempts, 0);
  // Without stricter matching, today's sound-alike card.
  assert.equal(factor(run({ press: true }, more, 30_000, [press("name", 17_000)]), "address").confirmReason, "sounds-like");
  // A sound-alike alone keeps the Confirmed button.
  assert.equal(factor(run({ press: true, strict: true }, [...OPEN, { ...NAME, text: "Sam Millerius." }, ADDR_Q], 24_000), "name").confirmReason, "sounds-like");
});

test("review of C10: ordinary extras stay matches; more ways of saying someone else's, another street or the past are asked again", () => {
  for (const t of ["Hill Road, house number 12, Dallas.", "12 B Hill Road, Dallas.", "Hill Road, third floor, Dallas.", "Third floor, Hill Road in Dallas.", "Hill Road, Dallas, near the school.", "Hill Road, H I L L, Dallas.", "Hill Road, Dallas, D A two L A S.", "Red, Hill Road in Dallas.", "s dot miller at example mail dot com, all small letters.", "s dot miller at example mail dot com, my personal email.", "s dot miller at example mail dot com. M I L L E R.", "S for Sam, dot, Miller, at example mail dot com."])
    assert.equal(matchAddress(t, customer, { strict: true }), "match", t);
  for (const t of ["Sam Miller’s.", "Hello my friend, Sam Miller.", "Ya baba, Sam Miller.", "I'm a client of yours, Sam Miller.", "My family name is Miller, Sam Miller."])
    assert.equal(matchName(t, customer, { strict: true }), "match", t);
  const name: [string, RegExp][] = [
    ["Sam Miller’s house.", /someone else's: Miller's/],
    ["My friend Sam Miller.", /someone else: My friend/],
    ["My boss, Sam Miller.", /someone else: My boss/],
    ["I'm a friend of Sam Miller.", /someone else: friend of/],
    ["His name is Sam Miller.", /^said for someone else: His name$/],
    ["He is Sam Miller.", /someone else: He/],
    ["I'm calling for Mr. Sam Miller.", /someone else: for/],
    ["Sam Miller. It's for him.", /someone else: for him/],
    ["My fiancé, Sam Miller.", /someone else: fiancé/],
    ["My co-worker, Sam Miller.", /someone else: My coworker/],
    ["My baba, Sam Miller.", /someone else: My baba/],
    ["I'm calling instead of Sam Miller.", /someone else: instead of/],
    ["The late Sam Miller.", /someone else: late/],
  ];
  for (const [t, why] of name) {
    assert.equal(matchName(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("name", t, customer).join("; "), why, t);
  }
  const address: [string, RegExp][] = [
    ["Red Hill Road, in Dallas.", /a word before the street: Red/],
    ["Second Hill Road in Dallas.", /a word before the street: Second/],
    ["Tower Hill Road, Dallas.", /a word before the street: Tower/],
    ["My old address is Hill Road in Dallas.", /the past: old address/],
    ["Hill Road in Dallas, but we've moved.", /the past: moved/],
    ["Hill Road, outside Dallas.", /a place word: outside/],
  ];
  for (const [t, why] of address) {
    assert.equal(matchAddress(t, customer), "match", `${t}: today`);
    assert.equal(matchAddress(t, customer, { strict: true }), "ambiguous", t);
    assert.match(strictFlags("address", t, customer).join("; "), why, t);
  }
});
