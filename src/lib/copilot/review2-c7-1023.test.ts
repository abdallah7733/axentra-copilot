import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_READ_BACK, analyze } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { matchAddress, matchName } from "./verification";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Second independent review of C7 (23 Oct), on the fixes for the first one. Two of its findings were regressions those
  fixes caused: everyday "Sorry, ..." lines next to a correct name made it "asked again", and an answer to another
  question (the street, the email, the damage) was taken as a second name, so the name field moved onto it and typing
  there failed the address. The others: a missing part the agent supplied by sound, possessive, plural or spelled out;
  the email said by the agent and repeated; a one-word different surname to "And the last name?"; a typed line of a
  two-line answer labelled as recognition; typing after a read-back not saying the agent had said it; and a correction
  from the record's word to a sound-alike verifying automatically.
*/
const customer = sunlake.customers.find((c) => c.id === sunlake.callerCustomerId)!;
const T = Date.UTC(2026, 9, 23, 12);
type L = { side: "caller" | "agent"; text: string; s: number; e: number; conf?: number; checked?: boolean };
const timed = (lines: L[]): TranscriptEvent[] =>
  lines.map((l, i) => ({ callId: "CA-rv2", seq: i + 1, key: `k${i + 1}`, side: l.side, text: l.text, startedAt: T + l.s, endedAt: T + l.e, final: true, confidence: l.conf ?? 0.9, ...(l.checked ? { checked: true } : {}) }));
const pack = (readBack: boolean): ClientPack => ({ ...sunlake, policy: { ...sunlake.policy, nameReadBack: readBack, addressReadBack: readBack } });
const run = (readBack: boolean, lines: L[], now: number, actions: AgentAction[] = []) => analyze(pack(readBack), timed(lines), actions, T + now);
const OPEN: L[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today.", s: 10_000, e: 12_000 },
  { side: "agent", text: "First, can I have your full name, please?", s: 12_500, e: 14_500 },
];
const ADDR_Q: L = { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 18_000, e: 20_000 };
const NAME_OK: L[] = [...OPEN, { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true }, ADDR_Q];
const DAMAGE_Q: L = { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?", s: 25_000, e: 27_500 };

// Evenly spaced lines, as in the first review's tests.
type Line = { side: "caller" | "agent"; text: string; confidence?: number };
const NOW = Date.UTC(2026, 9, 23, 12);
const spaced = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({ callId: "CA-rv2", seq: i + 1, key: `k${i + 1}`, side: l.side, text: l.text, startedAt: NOW - 600_000 + i * 5000, endedAt: NOW - 600_000 + i * 5000 + 3000, final: true, confidence: l.confidence ?? 0.9, checked: true }));
const view = (lines: Line[], actions: AgentAction[] = [], readBack = true) => analyze(pack(readBack), spaced(lines), actions, NOW);
const opening: Line[] = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const nameOk: Line[] = [...opening, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }];
const OK: Line = { side: "agent", text: "Okay." };
const recognised = (f: { state: string; method?: string }, label: string) => f.state === "ok" && (f.method === undefined || f.method === "street and city" || f.method === "email") && label;

test("an everyday 'Sorry, ...' or 'Wait, ...' next to the right name or address still verifies (review 2, regression)", () => {
  for (const t of ["Sam Miller. Sorry, I'm driving.", "Sam Miller. Sorry, bad line.", "Good morning. Sorry, it's Sam Miller.", "I'm driving, sorry. Sam Miller.", "Sam Miller. Wait, hold on, my dog is barking.", "Sam Miller. Sorry, the Tablet is cracked."]) {
    assert.equal(matchName(t, customer), "match", t);
    const v = run(false, [...OPEN, { side: "caller", text: t, s: 15_000, e: 17_000, checked: true }, ADDR_Q], 22_000);
    assert.equal(v.verification.factors[0].state, "ok", t);
  }
  for (const t of ["Hill Road, Dallas. Sorry, I'm driving.", "Hill Road in Dallas. Sorry, the apartment number is 4B.", "s dot miller at example mail dot com. Sorry, that's example dash mail dot com."]) {
    assert.equal(matchAddress(t, customer), "match", t);
    const v = run(false, [...NAME_OK, { side: "caller", text: t, s: 21_000, e: 24_000, checked: true }, DAMAGE_Q], 30_000);
    assert.equal(v.verification.verified, true, t);
  }
  // Two lines: the tick stays.
  const two = run(false, [...OPEN, { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true }, { side: "caller", text: "Sorry, I'm on speaker.", s: 16_300, e: 17_500, checked: true }, ADDR_Q], 22_000);
  assert.equal(two.verification.factors[0].state, "ok");
  // With read-back on, a false conflict no longer closes the read-back for the call.
  const lines: L[] = [...OPEN, { side: "caller", text: "Sam Millar. Sorry, bad line.", s: 15_000, e: 17_000, checked: true }, { side: "agent", text: "Sorry, could I have your full name once more?", s: 18_000, e: 20_000 },
    { side: "caller", text: "Sam Millar.", s: 21_000, e: 22_000, checked: true }, { side: "agent", text: "Thank you.", s: 23_000, e: 23_800 }];
  assert.equal(run(true, lines, 24_000).nameEntry?.readBack, "available");
  // A genuine correction is still asked again.
  for (const t of ["Sam Miller. No wait, it's Tom Baker.", "Sam Miller. Sorry, I meant Tom Baker."]) assert.equal(matchName(t, customer), "ambiguous", t);
  assert.equal(matchAddress("Hill Road in Dallas. No wait, Elm Street in Austin.", customer), "ambiguous");
});

test("an answer to another question is never taken as a second name, and typing the name never touches it (review 2, regression)", () => {
  const press: AgentAction[] = [{ type: "confirm", target: "name", at: T + 26_000 }];
  const cases: [L, L, L][] = [
    [{ side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, conf: 0.3 }, { side: "agent", text: "Thank you. And the email address on the order?", s: 17_000, e: 19_000 }, { side: "caller", text: "s dot miller at example mail dot com.", s: 20_000, e: 23_000, checked: true }],
    [{ side: "caller", text: "Sam Millar.", s: 15_000, e: 16_000, checked: true }, { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 17_000, e: 19_000 }, { side: "caller", text: "It's Hill Road in Dallas.", s: 20_000, e: 23_000, checked: true }],
    [{ side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, conf: 0.3 }, { side: "agent", text: "Thank you.", s: 17_000, e: 18_000 }, { side: "caller", text: "And I'm on Hill Road in Dallas.", s: 19_000, e: 22_000, checked: true }],
    [{ side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, conf: 0.3 }, { side: "agent", text: "Thank you. Is the damage only on the screen?", s: 17_000, e: 19_000 }, { side: "caller", text: "Yes, it's the Samsung one.", s: 20_000, e: 22_500, checked: true }],
  ];
  for (const [nameLine, ask, reply] of cases) {
    const lines: L[] = [...OPEN, nameLine, ask, reply, { side: "agent", text: "Okay, one moment.", s: 24_000, e: 25_000 }];
    const v = run(false, lines, 25_500);
    assert.notEqual(v.verification.factors[0].confirmReason, "ambiguous", reply.text);
    assert.equal(v.nameEntry?.key, "k5", `${reply.text}: the name field stays on the caller's name answer`);
    assert.equal(run(false, lines, 30_000, press).verification.factors[0].method, "confirmed by the agent", reply.text);
    const typed = run(false, lines, 30_000, [{ type: "correct", key: "k5", text: "Sam Miller", at: T + 27_000 }]);
    assert.equal(typed.verification.factors[0].state, "ok", reply.text);
    assert.notEqual(typed.verification.factors[1].state, "failed", `${reply.text}: the address answer is untouched`);
  }
  // With the name a sound-alike, the street answer "It's Hill Road in Dallas." leaves the read-back open, and it counts.
  const rb: L[] = [...OPEN, { side: "caller", text: "Sam Miler.", s: 15_000, e: 16_000, checked: true }, ADDR_Q, { side: "caller", text: "It's Hill Road in Dallas.", s: 20_500, e: 22_500, checked: true },
    { side: "agent", text: "So it's Sam Miller, right?", s: 25_500, e: 27_500 }, { side: "caller", text: "Yes.", s: 28_000, e: 28_400, checked: true }];
  const v = run(true, rb, 30_000);
  assert.equal(v.verification.factors[0].method, NAME_READ_BACK);
  assert.equal(v.verification.verified, true);
  // "Great, thank you." late in the call is not a name either.
  assert.equal(matchName("Great, thank you.", customer) === "match", false);
});

test("a missing part the agent supplies by sound, possessive, plural or spelled out makes the caller's echo assisted (review 2)", () => {
  assert.notEqual(view([...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "And is the last name Miller?" }, { side: "caller", text: "Yes, Sam Miller." }, OK]).verification.factors[0].state, "ok");
  for (const lead of ["And is the last name spelled M I L L E R?", "Is it M-I-L-L-E-R?", "And is that Mr. Miller's account?", "Are you one of the Millers?", "And is the last name Miler?", "And is the last name Millar?"])
    for (const readBack of [true, false]) {
      const n = view([...opening, { side: "caller", text: "Sam." }, { side: "agent", text: lead }, { side: "caller", text: "Yes, Sam Miller." }, OK], [], readBack).verification.factors[0];
      assert.ok(!recognised(n, lead), `${lead}: an echo of the agent's surname verified as the caller's own recognition`);
    }
  for (const [prior, lead] of [["Hill Road.", "And the city, Dalas?"], ["Dallas.", "And the street, is that Hil Road?"]]) {
    const a = view([...nameOk, { side: "caller", text: prior }, { side: "agent", text: lead }, { side: "caller", text: "Yes, Hill Road in Dallas." }, OK]).verification.factors[1];
    assert.ok(!recognised(a, lead), lead);
  }
  // An everyday word that only sounds like a part ("Same here.", "same day") doesn't make the caller's own answer an echo.
  const n = view([...opening.slice(0, 3), { side: "agent", text: "Same here, and it can go out same day. First, can I have your full name, please?" }, { side: "caller", text: "Sam Miller." }, OK]).verification.factors[0];
  assert.equal(n.state, "ok");
  assert.equal(n.method, undefined);
});

test("an email the agent said, repeated by the caller, is not the caller's own recognition (review 2)", () => {
  const askEmail: Line[] = [...opening, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Thank you. And the email on the order?" }];
  const garbled: Line = { side: "caller", text: "Es dot mila at example male dot com.", confidence: 0.4 };
  const echo: Line = { side: "caller", text: "Yes, s dot miller at example mail dot com." };
  for (const [lines, readBack] of [
    [[...askEmail, garbled, { side: "agent", text: "So that's s dot miller at example mail dot com, right?" }, echo, OK], true],
    [[...askEmail, garbled, { side: "agent", text: "So that's s dot miller at example mail dot com, right?" }, echo, OK], false],
    [[...askEmail, garbled, { side: "agent", text: "Is it s dot miller at example mail dot com?" }, echo, OK], true],
    [[...askEmail, { side: "caller", text: "It's s dot miller at, um." }, { side: "agent", text: "At example mail dot com?" }, echo, OK], true],
  ] as [Line[], boolean][]) {
    const a = view(lines, [], readBack).verification.factors[1];
    assert.ok(!(a.state === "ok" && a.method === "email"), "the caller's repeat of the agent's email verified as recognition");
  }
  // The caller's own email still verifies, also after a street-and-city read-back (first review, finding 10).
  assert.equal(view([...askEmail, { side: "caller", text: "s dot miller at example mail dot com." }, OK]).verification.factors[1].method, "email");
});

test("a different surname or first name to 'And the last name?' ends the read-back and Confirm (review 2)", () => {
  const RB: Line = { side: "agent", text: "So it's Sam Miller, right?" };
  const YES: Line = { side: "caller", text: "Yes, that's right." };
  for (const [ask, answer] of [["And the last name?", "Jones."], ["Sorry, what's your surname?", "Baker."], ["And your first name?", "Tom."]]) {
    const base: Line[] = [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: ask }, { side: "caller", text: answer }];
    assert.equal(view(base).verification.factors[0].confirmReason, "ambiguous", answer);
    assert.notEqual(view([...base, RB, YES]).verification.factors[0].state, "ok", `${answer}: read-back`);
    assert.notEqual(view(base, [{ type: "confirm", target: "name", at: NOW - 600_000 + 7 * 5000 + 3500 }]).verification.factors[0].state, "ok", `${answer}: Confirm`);
  }
  // The right surname to the same question changes nothing: the read-back still counts.
  const right: Line[] = [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "And the last name?" }, { side: "caller", text: "Miller." }];
  assert.equal(view([...right, RB, YES]).verification.factors[0].method, NAME_READ_BACK);
});

test("a correction from the record's word to a sound-alike never verifies automatically (review 2)", () => {
  for (const t of ["Sam Miller, sorry, Muller.", "Sam Miller. No, Mueller.", "Sam Miller. Sorry, I meant Millar."]) assert.equal(matchName(t, customer), "close", t);
  for (const t of ["Hill Road in Dallas. Sorry, Hall Road.", "Hill Road in Dallas. Actually, Dulles."]) assert.equal(matchAddress(t, customer), "close", t);
  for (const t of ["Sam Miller, no, M I L L E R.", "Sam Miller. Sorry, some noise here.", "Sam Miller. Sorry, Sam Miller."]) assert.equal(matchName(t, customer), "match", t);
  const v = view([...opening, { side: "caller", text: "Sam Miller, sorry, Muller." }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }, { side: "caller", text: "Hill Road in Dallas. Sorry, Hall Road." }], [], false);
  assert.equal(v.verification.verified, false);
});

test("typing after a read-back the caller didn't confirm says the agent had said it (review 2)", () => {
  const name: Line[] = [...opening, { side: "caller", text: "Sen nilir.", confidence: 0.3 }, { side: "agent", text: "So that's Sam Miller, right?" }, { side: "caller", text: "Yes.", confidence: 0.3 }, { side: "agent", text: "One moment." }];
  const v = view(name);
  assert.equal(v.nameEntry?.readBack, "refused");
  const typed = view(name, [{ type: "correct", key: v.nameEntry!.key!, text: "Sam Miller", at: NOW }]).verification.factors[0];
  assert.equal(typed.method, "typed by the agent, after the agent said it on the call");
  const addr: Line[] = [...nameOk, { side: "caller", text: "Helrout in Dallas.", confidence: 0.3 }, { side: "agent", text: "So that's Hill Road, Dallas, is that right?" }, { side: "caller", text: "Yes.", confidence: 0.3 }, { side: "agent", text: "One moment." }];
  const a = view(addr);
  assert.equal(view(addr, [{ type: "correct", key: a.addressEntry!.key!, text: "Hill Road in Dallas", at: NOW }]).verification.factors[1].method, "street and city, typed by the agent, after the agent said it on the call");
});

test("typing one line of a two-line answer is labelled as typed, and a spoken echo in it still counts as one (review 2)", () => {
  const lines: L[] = [...OPEN, { side: "caller", text: "Sand.", s: 15_000, e: 15_600 }, { side: "caller", text: "Miller.", s: 17_300, e: 17_900, checked: true }, ADDR_Q];
  const v = run(false, lines, 22_000, [{ type: "correct", key: "k5", text: "Sam", at: T + 17_000 }]);
  assert.equal(v.verification.factors[0].state, "ok");
  assert.equal(v.verification.factors[0].method, "typed by the agent");
  // After the agent said the name: "Sand." (typed "Sam") then a spoken "Miller." is still the agent's words.
  const echo: L[] = [...OPEN, { side: "caller", text: "Sand Mila.", s: 15_000, e: 16_000, conf: 0.4 }, { side: "agent", text: "Sorry, can I have your full name again? Is it Sam Miller?", s: 17_000, e: 20_000 },
    { side: "caller", text: "Sand.", s: 20_500, e: 21_000 }, { side: "caller", text: "Miller.", s: 22_600, e: 23_200, checked: true }];
  const n = run(false, echo, 26_000, [{ type: "correct", key: "k7", text: "Sam", at: T + 22_300 }]).verification.factors[0];
  assert.ok(!(n.state === "ok" && n.method === undefined), "an echo verified as recognition");
});

// A third check of the same fixes (23 Oct).
const pressAfter = (lines: Line[], target: "name" | "address"): AgentAction[] => [{ type: "confirm", target, at: NOW - 600_000 + lines.length * 5000 + 500 }];

test("a correction with everyday words before the second name or address is still asked again (third check)", () => {
  for (const t of ["Sam Miller. Wait, I think it's Tom Baker.", "Sam Miller. Actually, it should be Tom Baker.", "Sam Miller. No, sorry, we changed it to Tom Baker."]) assert.equal(matchName(t, customer), "ambiguous", t);
  for (const t of ["Hill Road in Dallas. Actually, we moved, it's Elm Street in Austin now.", "Hill Road in Dallas. Oh wait, no, we had it sent to my office on Elm Street."])
    assert.equal(matchAddress(t, customer), "ambiguous", t);
  for (const t of ["Sam Miller. Wait, do you need my order number?", "Sam Miller. Sorry, the Tablet is cracked.", "Sam Miller, no, M I L L E R.", "Good morning. Sorry, it's Sam Miller."]) assert.equal(matchName(t, customer), "match", t);
});

test("an echo of the street and city with 'at' in it isn't taken as an email (third check)", () => {
  for (const readBack of [false, true])
    for (const echo of ["Yes, it's at Hill Rode in Dallas.", "Yes, we're at Hill Rd in Dallas."]) {
      const lines: Line[] = [...nameOk, { side: "caller", text: "Dallas." }, { side: "agent", text: "And what's the street? Is it Hill Road, in Dallas?" }, { side: "caller", text: echo }];
      for (const actions of [[], pressAfter(lines, "address")]) {
        const a = view(lines, actions, readBack).verification.factors[1];
        assert.notEqual(a.state, "ok", `${echo} (read-back ${readBack}, ${actions.length ? "Confirm" : "no press"})`);
        assert.notEqual(a.method, "email");
      }
    }
  assert.equal(view([...nameOk, { side: "caller", text: "s dot miller at example mail dot com." }, OK]).verification.factors[1].method, "email");
});

test("a caller's 'No.' to the agent saying the detail back, where it can't count as a read-back, stops a Confirm press (third check)", () => {
  for (const [readBack, lines] of [
    [false, [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "So your name is Sam Miller, right?" }, { side: "caller", text: "No." }]],
    [false, [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "So your name is Sam Miller, right?" }, { side: "caller", text: "No, that's not right." }]],
    [true, [...opening, { side: "caller", text: "Tom Baker." }, { side: "agent", text: "Sorry, could I have your full name once more?" }, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "Your full name is Sam Miller, is that correct?" }, { side: "caller", text: "No." }]],
  ] as [boolean, Line[]][])
    assert.notEqual(view(lines, pressAfter(lines, "name"), readBack).verification.factors[0].state, "ok", lines.at(-1)!.text);
  const addr: Line[] = [...nameOk, { side: "caller", text: "Hill Rode in Dalas." }, { side: "agent", text: "So the address is Hill Road, Dallas, right?" }, { side: "caller", text: "No." }];
  assert.notEqual(view(addr, pressAfter(addr, "address"), false).verification.factors[1].state, "ok");
  // A plain yes to it leaves the sound-alike for the agent to confirm, as before.
  const yes: Line[] = [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "So your name is Sam Miller, right?" }, { side: "caller", text: "Yes." }];
  assert.equal(view(yes, pressAfter(yes, "name"), false).verification.factors[0].state, "ok");
});

test("an everyday word in the agent's line that is also a name on the record doesn't make the caller's answer an echo (third check)", () => {
  for (const [first, ask] of [["Will", "I will just need your full name, please."], ["Mark", "Let me mark that down. Can I have your full name, please?"], ["Grace", "There's a grace period on that. Can I have your full name, please?"]]) {
    const cust = { ...customer, name: `${first} Turner` };
    const p: ClientPack = { ...sunlake, customers: sunlake.customers.map((c) => (c.id === cust.id ? cust : c)), orders: sunlake.orders.map((o) => (o.customerId === cust.id ? { ...o, customerName: cust.name } : o)) };
    const lines: Line[] = [{ side: "agent", text: "Thank you for calling Sunlake. How can I help you today?" }, { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked." }, { side: "agent", text: ask }, { side: "caller", text: `${first} Turner.` }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }];
    const n = analyze({ ...p, policy: { ...p.policy, nameReadBack: false, addressReadBack: false } }, spaced(lines), [], NOW).verification.factors[0];
    assert.equal(n.state, "ok", first);
    assert.equal(n.method, undefined, first);
  }
  // The agent supplying the surname, written plainly, still makes the echo the agent's words.
  const lead: Line[] = [...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "And is the last name miller?" }, { side: "caller", text: "Yes, Sam Miller." }, OK];
  assert.ok(!recognised(view(lead).verification.factors[0], "lower-case lead"));
});

test("spelling the name after 'Could you spell the last name?' keeps the sound-alike, Confirm and the read-back (third check)", () => {
  for (const spelled of ["M I L L E R.", "Miller, M I L L E R.", "Miller with an I."]) {
    const lines: Line[] = [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "Could you spell the last name for me?" }, { side: "caller", text: spelled }, OK];
    const v = view(lines);
    assert.equal(v.verification.factors[0].confirmReason, "sounds-like", spelled);
    assert.equal(v.nameEntry?.readBack, "available", spelled);
    assert.equal(v.verification.factors[0].attempts, 0);
  }
  // Spelling a different name is a conflict.
  const other: Line[] = [...opening, { side: "caller", text: "Sam Miler." }, { side: "agent", text: "Could you spell the last name for me?" }, { side: "caller", text: "B A K E R." }, OK];
  assert.notEqual(view(other).nameEntry?.readBack, "available");
});
