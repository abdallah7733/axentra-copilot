import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_READ_BACK, NAME_READ_BACK, analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { matchAddress, matchName } from "./verification";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Independent review of C7 (23 Oct): what the fixes for findings 2, 3, 8 to 11 and 13 to 17 now do. A re-ask with a name
  in it stays a question. A caller who corrects themselves to another name or address is asked again, while an everyday
  "wait" or a spelling isn't. A read-back opens only when everything the caller said for the detail fits it, never when a
  first name or city carries the rest, and never after a different answer while the question lingers. A leading question
  that supplies a missing part makes the caller's echo an assisted answer. The email route stays open after a
  street-and-city read-back. Typing over the reply to a refused read-back records nothing the caller said. Each finding
  also keeps the case that must still verify, so over-blocking shows up too.
*/

const customer = sunlake.customers[0];
const NOW = Date.UTC(2026, 9, 23, 12);
const T0 = NOW - 600_000;
// Lines are 3 s long, 2 s apart (gapBefore changes the gap), unless s and e give their times in ms from T0.
type Line = { side: "caller" | "agent"; text: string; confidence?: number; firstHeard?: string; checked?: boolean; s?: number; e?: number; gapBefore?: number };
const events = (lines: Line[]): TranscriptEvent[] => {
  let t = T0;
  return lines.map((l, i) => {
    if (i > 0) t += 3000 + (l.gapBefore ?? 2000);
    return {
      callId: "CA-review-c7",
      seq: i + 1,
      key: `k${i + 1}`,
      side: l.side,
      text: l.text,
      startedAt: l.s !== undefined ? T0 + l.s : t,
      endedAt: l.e !== undefined ? T0 + l.e : t + 3000,
      final: true,
      confidence: l.confidence ?? 0.9,
      ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
      ...(l.checked ? { checked: true } : {}),
    };
  });
};
const both: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true, addressReadBack: true } };
const view = (lines: Line[], actions: AgentAction[] = [], now = NOW) => analyze(both, events(lines), actions, now);
const name = (v: CopilotView) => v.verification.factors[0];
const address = (v: CopilotView) => v.verification.factors[1];
const prompt = (v: CopilotView, target: "name" | "address") => v.prompts.find((p) => p.target === target)?.text ?? "";
/** During the n-th line (counted from 1) of an evenly spaced call. */
const at = (n: number) => T0 + (n - 1) * 5000 + 100;
/** `ms` after T0, for the timed calls. */
const T = (ms: number) => T0 + ms;

const opening: Line[] = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const NAME_OK: Line[] = [...opening, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }];
const YES: Line = { side: "caller", text: "Yes, that's right.", checked: true };
const NAME_BACK: Line = { side: "agent", text: "That's Sam Miller, is that right?" };
const ADDR_BACK: Line = { side: "agent", text: "So that's Hill Road, Dallas, is that right?" };

// The same opening with real timings, for answers that join or pause.
const OPEN_T: Line[] = [
  { side: "agent", text: "Thank you for calling Sunlake. How can I help you today?", s: 0, e: 2000 },
  { side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", s: 3000, e: 9000, checked: true },
  { side: "agent", text: "I'm sorry to hear that. I can send you a new one today.", s: 10_000, e: 12_000 },
  { side: "agent", text: "First, can I have your full name, please?", s: 12_500, e: 14_500 },
];
const NAME_OK_T: Line[] = [
  ...OPEN_T,
  { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true },
  { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 17_000, e: 19_000 },
];
const DAMAGE_T: Line = { side: "agent", text: "Thank you, Sam. I can see the tablet on order 427. Is the damage only on the screen?", s: 28_000, e: 31_000 };

/* Finding 2: a re-ask with a capitalised word in it was taken for a read-back. */

const ADDR_ALIKE: Line[] = [...NAME_OK, { side: "caller", text: "Hillwood in the alles.", firstHeard: "Little road in Nalist.", checked: true }];

test("an address re-ask with a name in it stays a question: the reply is held, and a wrong one is a failed attempt that closes the read-back (review finding 2)", () => {
  for (const reask of ["What's the address on your Sunlake order?", "Could you repeat the address, Sam?", "What's the street and city, Mr. Miller?"]) {
    const asked: Line[] = [...ADDR_ALIKE, { side: "agent", text: reask }];
    assert.equal(view(asked).awaiting, "address", reask);
    const wrong: Line[] = [...asked, { side: "caller", text: "Elm Road in Austin.", checked: true }, { side: "agent", text: "Okay." }];
    let v = view(wrong);
    assert.ok(v.keyAnswers.includes("k9"), `${reask}: the reply gets the second model's check`);
    assert.equal(address(v).state, "failed", reask);
    assert.equal(address(v).attempts, 1, reask);
    assert.notEqual(v.addressEntry?.readBack, "available", reask);
    v = view([...wrong, ADDR_BACK, { side: "caller", text: "Yes.", checked: true }]);
    assert.notEqual(address(v).state, "ok", `${reask}: no read-back after a wrong answer`);
    assert.equal(v.verification.verified, false, reask);
    // Control: the right answer to the same re-ask is the caller's own.
    v = view([...asked, { side: "caller", text: "Hill Road in Dallas.", checked: true }, { side: "agent", text: "Okay." }]);
    assert.ok(v.keyAnswers.includes("k9"), reask);
    assert.equal(address(v).state, "ok", reask);
    assert.equal(address(v).method, "street and city", reask);
  }
});

test("a name re-ask with the caller's first name in it stays a question, and a wrong reply then a read-back doesn't verify (review finding 2)", () => {
  const before: Line[] = [
    ...opening,
    { side: "caller", text: "Sam Miler.", checked: true },
    { side: "agent", text: "Thank you. And the street and city for the delivery?" },
    { side: "caller", text: "Hill Road, in Dallas.", checked: true },
    { side: "agent", text: "And your full name again, Sam?" },
  ];
  assert.equal(view(before).awaiting, "name");
  const wrong: Line[] = [...before, { side: "caller", text: "Tom Baker.", checked: true }, { side: "agent", text: "Okay." }];
  let v = view(wrong);
  assert.equal(name(v).state, "failed");
  assert.equal(name(v).attempts, 1);
  assert.notEqual(v.nameEntry?.readBack, "available");
  v = view([...wrong, { side: "agent", text: "So it's Sam Miller, right?" }, { side: "caller", text: "Yes.", checked: true }]);
  assert.notEqual(name(v).state, "ok");
  // Control: the right answer to it is recognised.
  v = view([...before, { side: "caller", text: "Sam Miller.", checked: true }, { side: "agent", text: "Okay." }]);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, undefined);
});

test("the caller repeating the detail after a misheard read-back is never counted as their own recognition (review finding 2)", () => {
  let v = view([...ADDR_ALIKE, { side: "agent", text: "So the address is Hell Road, Dallas, right?" }, { side: "caller", text: "Yes, Hill Road in Dallas.", checked: true }, { side: "agent", text: "Okay." }]);
  assert.ok(address(v).state !== "ok" || address(v).method === ADDRESS_READ_BACK, `address: ${address(v).state} ${address(v).method}`);
  assert.notEqual(address(v).method, "street and city");
  v = view([...opening, { side: "caller", text: "Sam Miler.", checked: true }, { side: "agent", text: "So your name is Sam Miler, right?" }, { side: "caller", text: "Yes, Sam Miller.", checked: true }, { side: "agent", text: "Okay." }]);
  assert.ok(name(v).state !== "ok" || name(v).method === NAME_READ_BACK, `name: ${name(v).state} ${name(v).method}`);
});

/* Finding 3: everyday self-corrections ("Sorry, I meant ...") were missed. */

test("a self-correction to another name or address with sorry, meant, oops or scratch that is asked again (review finding 3)", () => {
  for (const said of ["Sam Miller. Sorry, I meant Tom Baker.", "Sam Miller. Sorry, it's Tom Baker.", "Sam Miller. Oops, Tom Baker.", "Sam Miller. Scratch that, Tom Baker.", "Sam Miller. Sorry, my mistake, Tom Baker."])
    assert.equal(matchName(said, customer), "ambiguous", said);
  assert.equal(matchAddress("Hill Road in Dallas. Sorry, I meant Elm Road in Austin.", customer), "ambiguous");
  // Controls: more words after the name, or a "sorry" before it, are no correction.
  for (const said of ["Sam Miller. And it's about order 427.", "Sorry, it's Sam Miller."]) assert.equal(matchName(said, customer), "match", said);
  assert.equal(matchAddress("Sorry, Hill Road in Dallas.", customer), "match");
});

test("a correction said as the next line takes the name back, and an approval can't count on it (review finding 3)", () => {
  const call = (second: string): CopilotView =>
    view(
      [
        ...OPEN_T,
        { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true },
        { side: "caller", text: second, s: 16_300, e: 18_000, checked: true },
        { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 19_000, e: 21_000 },
        { side: "caller", text: "Hill Road in Dallas.", s: 22_000, e: 23_500, checked: true },
        { side: "agent", text: "Thank you, Sam. Is the damage only on the screen?", s: 24_500, e: 27_000 },
      ],
      [
        { type: "confirm", target: "order", at: T(28_000) },
        { type: "approve", at: T(28_500) },
      ],
      T(40_000),
    );
  for (const fix of ["Sorry, I meant Tom Baker.", "Sorry, it's Tom Baker."]) {
    const v = call(fix);
    assert.equal(name(v).state, "confirm", fix);
    assert.equal(name(v).confirmReason, "ambiguous", fix);
    assert.notEqual(v.nameEntry?.readBack, "available", fix);
    assert.equal(v.verification.verified, false, fix);
    assert.notEqual(v.recommendation?.approval.state, "approved", fix);
    assert.ok(!(v.recommendation?.history ?? []).some((h) => h.counted), fix);
  }
  // Control: a second line that adds something else leaves the name verified, and the approval counts.
  const v = call("And it's about order 427.");
  assert.equal(name(v).state, "ok");
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.ok((v.recommendation?.history ?? []).some((h) => h.counted));
});

/* Finding 8: a no-record-part reading from one model let a first-name-only or city-only reading open the read-back. */

test("no read-back when one model heard only the first name or the city and the other heard no part of the record (review finding 8)", () => {
  for (const [text, firstHeard] of [
    ["Sam Jones.", "Tom Jones."],
    ["Tom Jones.", "Sam Jones."],
  ]) {
    const lines: Line[] = [...opening, { side: "caller", text, firstHeard, checked: true }, { side: "agent", text: "Thank you." }];
    let v = view(lines);
    assert.equal(name(v).state, "confirm", text);
    assert.notEqual(v.nameEntry?.readBack, "available", text);
    v = view([...lines, NAME_BACK, YES]);
    assert.notEqual(name(v).state, "ok", text);
    assert.equal(name(v).method, undefined, text);
  }
  const lines: Line[] = [...NAME_OK, { side: "caller", text: "Elm Road in Dallas.", firstHeard: "Helm rode in the less.", checked: true }, { side: "agent", text: "Okay." }];
  let v = view(lines);
  assert.notEqual(v.addressEntry?.readBack, "available");
  v = view([...lines, ADDR_BACK, YES]);
  assert.notEqual(address(v).state, "ok");
  assert.equal(v.verification.verified, false);
});

test("a sound-alike of the whole name or address still opens the read-back, and the checked yes verifies it as one (review finding 8)", () => {
  let lines: Line[] = [...opening, { side: "caller", text: "Sam Miler.", checked: true }, { side: "agent", text: "Thank you." }];
  assert.equal(view(lines).nameEntry?.readBack, "available");
  assert.equal(name(view([...lines, NAME_BACK, YES])).method, NAME_READ_BACK);
  lines = [...ADDR_ALIKE, { side: "agent", text: "Okay." }];
  assert.equal(view(lines).addressEntry?.readBack, "available");
  const v = view([...lines, ADDR_BACK, YES]);
  assert.equal(address(v).method, ADDRESS_READ_BACK);
  assert.equal(v.verification.verified, true);
});

/* Finding 9: an everyday "wait", "actually" or a spelling after a clear answer made it ambiguous. */

test("a clear answer followed by an everyday wait, actually or a spelling still matches; a real correction doesn't (review finding 9)", () => {
  for (const said of ["Sam Miller. Wait, do you need my order number?", "Sam Miller. Actually, I'd rather have a refund.", "Sam Miller, no, M I L L E R.", "Sam Miller. No, Miller with two Ls.", "It's Sam Miller. Wait, is that what you needed?"])
    assert.equal(matchName(said, customer), "match", said);
  for (const said of ["Hill Road in Dallas. Actually it's 4512 Hill Road.", "Hill Road in Dallas. Wait, do you need the zip code?", "Hill Road in Dallas. Wait, do you need the zip code too?"])
    assert.equal(matchAddress(said, customer), "match", said);
  assert.equal(matchName("Sam Miller. No wait, it's Tom Baker.", customer), "ambiguous");
});

test("a second line that asks something or spells the name doesn't take back a clear name or address (review finding 9)", () => {
  const nameThen = (second: string) =>
    view(
      [
        ...OPEN_T,
        { side: "caller", text: "Sam Miller.", s: 15_000, e: 16_000, checked: true },
        { side: "caller", text: second, s: 16_300, e: 18_000, checked: true },
        { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 19_000, e: 21_000 },
      ],
      [],
      T(30_000),
    );
  let v = nameThen("Wait, do you need my order number?");
  assert.equal(name(v).state, "ok");
  assert.equal(prompt(v, "name"), "", "no 'ask once more' card");
  v = view([...OPEN_T, { side: "caller", text: "Sam Miller, no, M I L L E R.", s: 15_000, e: 17_000, checked: true }, { side: "agent", text: "Thank you. And the street and city for the delivery?", s: 18_000, e: 20_000 }], [], T(30_000));
  assert.equal(name(v).state, "ok", "a caller who spells the name");
  for (const second of ["Wait, do you need the zip code too?", "Actually it's 4512 Hill Road."]) {
    v = view(
      [
        ...NAME_OK_T,
        { side: "caller", text: "Hill Road in Dallas.", s: 20_000, e: 21_500, checked: true },
        { side: "caller", text: second, s: 21_800, e: 23_500, checked: true },
        { ...DAMAGE_T, s: 24_500, e: 27_000 },
      ],
      [],
      T(35_000),
    );
    assert.equal(address(v).state, "ok", second);
    assert.equal(address(v).method, "street and city", second);
    assert.equal(v.verification.verified, true, second);
  }
  // Control: a real correction on the next line is still asked again.
  v = nameThen("No wait, it's Tom Baker.");
  assert.equal(name(v).state, "confirm");
  assert.equal(name(v).confirmReason, "ambiguous");
});

/* Finding 10: after a street-and-city read-back, the email the caller gave instead was taken for an echo. */

test("after a street-and-city read-back the email route still verifies, as email and never as an echo (review finding 10)", () => {
  const sounded: Line[] = [...NAME_OK_T, { side: "caller", text: "Hill Rode in Dallas.", s: 20_000, e: 21_500, checked: true }];
  const readBack: Line = { ...ADDR_BACK, s: 22_500, e: 24_500 };
  const email: Line[] = [
    ...sounded,
    readBack,
    { side: "caller", text: "No.", s: 25_000, e: 25_400, checked: true },
    { side: "agent", text: "Okay. Could you give me the email address on the order instead?", s: 26_500, e: 29_000 },
    { side: "caller", text: "s dot miller at example mail dot com.", s: 29_500, e: 32_000, checked: true },
    { ...DAMAGE_T, s: 33_000, e: 36_000 },
  ];
  let v = view(email, [], T(40_000));
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "email");
  assert.equal(v.verification.verified, true);
  assert.equal(prompt(v, "address"), "");
  // With no reply to the read-back at all.
  v = view(
    [
      ...sounded,
      readBack,
      { side: "agent", text: "Okay. Could you give me the email address on the order instead?", s: 33_500, e: 36_000 },
      { side: "caller", text: "s dot miller at example mail dot com.", s: 36_500, e: 39_000, checked: true },
      { ...DAMAGE_T, s: 40_000, e: 43_000 },
    ],
    [],
    T(50_000),
  );
  assert.equal(address(v).method, "email");
  // Typed, it says only that it was typed: the agent never said the email.
  v = view(email, [{ type: "correct", key: "k11", text: "s dot miller at example mail dot com", at: T(41_000) }], T(45_000));
  assert.equal(address(v).method, "email, typed by the agent");
  // Control: the street and city repeated after the read-back is still the agent's words.
  v = view(
    [
      ...sounded,
      readBack,
      { side: "caller", text: "No.", s: 25_000, e: 25_400, checked: true },
      { side: "agent", text: "Okay. Could you give me the street and city once more?", s: 26_500, e: 29_000 },
      { side: "caller", text: "Hill Road in Dallas.", s: 29_500, e: 31_000, checked: true },
      { ...DAMAGE_T, s: 33_000, e: 36_000 },
    ],
    [],
    T(40_000),
  );
  assert.notEqual(address(v).state, "ok");
  assert.equal(address(v).confirmReason, "after-read-back");
});

/* Finding 11: an address re-ask that names the city or the caller lost the reply. */

test("an address re-ask naming the city or the caller keeps the reply as the address answer: held, joined and heard afresh (review finding 11)", () => {
  const doubtful: Line[] = [...NAME_OK_T, { side: "caller", text: "Helrout in Dallas.", s: 20_000, e: 21_500, confidence: 0.3 }];
  const street: Line = { side: "agent", text: "Sorry, what's the street in Dallas?", s: 22_500, e: 24_500 };
  const emailAsk: Line = { side: "agent", text: "What's the email on the order, Sam?", s: 22_500, e: 24_500 };
  for (const q of [street, emailAsk]) assert.equal(view([...doubtful, q], [], T(24_600)).awaiting, "address", q.text);
  let v = view(
    [...doubtful, street, { side: "caller", text: "Hill Road.", s: 25_000, e: 25_800, checked: true }, { side: "caller", text: "In Dallas.", s: 26_100, e: 26_800, checked: true }, DAMAGE_T],
    [],
    T(40_000),
  );
  assert.ok(v.keyAnswers.includes("k9") && v.keyAnswers.includes("k10"), "both lines get the second model's check");
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "street and city");
  assert.equal(address(v).heard, "Hill Road. In Dallas.");
  v = view(
    [
      ...doubtful,
      emailAsk,
      { side: "caller", text: "It's s dot miller", s: 25_000, e: 26_200, checked: true },
      { side: "caller", text: "at example mail dot com.", s: 26_500, e: 28_000, checked: true },
      { ...DAMAGE_T, s: 29_000, e: 32_000 },
    ],
    [],
    T(40_000),
  );
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "email");
  v = view([...doubtful, street, { side: "caller", text: "Hill Rode in Dallas.", s: 25_000, e: 26_500, checked: true }, { side: "agent", text: "Okay.", s: 28_000, e: 28_500 }], [], T(30_000));
  assert.equal(address(v).heard, "Hill Rode in Dallas.", "the new answer replaces the old one");
  assert.equal(address(v).confirmReason, "sounds-like");
});

/* Finding 13: a leading question with only the missing part let the caller's echo count as recognition. */

test("a leading question that supplies the missing part of the name leaves the caller's echo unverified (review finding 13)", () => {
  for (const [given, lead] of [
    ["Sam.", "And is the last name Miller?"],
    ["Sam.", "And your last name is Miller, right?"],
    ["Sam.", "Miller?"],
    ["Miller.", "And your first name, Sam?"],
  ]) {
    const v = view([...opening, { side: "caller", text: given }, { side: "agent", text: lead }, { side: "caller", text: "Yes, Sam Miller." }, { side: "agent", text: "Okay." }]);
    assert.notEqual(name(v).state, "ok", lead);
    assert.equal(name(v).method, undefined, lead);
    assert.match(prompt(v, "name"), /Ask for the full name again/, lead);
  }
});

test("a leading question that supplies the street or the city makes the caller's echo an assisted answer (review finding 13)", () => {
  for (const [given, lead] of [
    ["Dallas.", "And the street, is that Hill Road?"],
    ["Hill Road.", "And the city, Dallas?"],
  ]) {
    const v = view([...NAME_OK, { side: "caller", text: given }, { side: "agent", text: lead }, { side: "caller", text: "Yes, Hill Road in Dallas." }, { side: "agent", text: "Okay." }]);
    assert.equal(address(v).state, "confirm", lead);
    assert.equal(address(v).confirmReason, "after-read-back", lead);
    assert.equal(v.verification.verified, false, lead);
  }
});

test("the agent repeating a part the caller already gave doesn't make the caller's full answer an echo (review finding 13)", () => {
  let v = view([...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "Thanks, Sam. Could I have your full name, please?" }, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Okay." }]);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, undefined);
  v = view([...NAME_OK, { side: "caller", text: "Dallas." }, { side: "agent", text: "And the street in Dallas?" }, { side: "caller", text: "Hill Road in Dallas." }, { side: "agent", text: "Okay." }]);
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "street and city");
});

/* Finding 14: a city or first name, then a doubtful different word across a re-ask or a pause, opened the read-back. */

test("a city or first name first, then a doubtful different word, never opens the read-back across a re-ask or a pause (review finding 14)", () => {
  const cases: [string, Line[], Line][] = [
    ["address, re-asked", [...NAME_OK, { side: "caller", text: "Dallas." }, { side: "agent", text: "And the street, please?" }, { side: "caller", text: "Elm Road.", confidence: 0.3 }, { side: "agent", text: "Okay." }], ADDR_BACK],
    ["address, after a pause", [...NAME_OK, { side: "caller", text: "Dallas." }, { side: "caller", text: "Elm Road.", confidence: 0.3 }, { side: "agent", text: "Okay." }], ADDR_BACK],
    ["name, re-asked", [...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "Sorry, can I have your full name again?" }, { side: "caller", text: "Jones.", confidence: 0.3 }, { side: "agent", text: "Okay." }], NAME_BACK],
    ["name, after a pause", [...opening, { side: "caller", text: "Sam." }, { side: "caller", text: "Jones.", confidence: 0.3 }, { side: "agent", text: "Okay." }], NAME_BACK],
  ];
  for (const [label, lines, back] of cases) {
    const factor = back === NAME_BACK ? name : address;
    let v = view(lines);
    assert.equal(factor(v).confirmReason, "low-confidence", label);
    assert.notEqual((back === NAME_BACK ? v.nameEntry : v.addressEntry)?.readBack, "available", label);
    v = view([...lines, back, YES]);
    assert.notEqual(factor(v).state, "ok", label);
    assert.equal(v.verification.verified, false, label);
  }
});

test("a first name, then the whole name as a sound-alike after a re-ask, still opens the read-back (review finding 14)", () => {
  const lines: Line[] = [...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "Sorry, can I have your full name again?" }, { side: "caller", text: "Sam Miler.", checked: true }, { side: "agent", text: "Okay." }];
  assert.equal(view(lines).nameEntry?.readBack, "available");
  const v = view([...lines, NAME_BACK, YES]);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, NAME_READ_BACK);
});

/* Finding 15: a different answer while the question lingered was dropped, so the read-back and Confirm still counted. */

test("a different name while the question lingers is asked again: no read-back, no Confirm, no failed attempt (review finding 15)", () => {
  for (const said of ["Sorry, it's Sam Jones.", "Actually it's Tom Baker.", "No, my name is Pam Miller."]) {
    const lines: Line[] = [...opening, { side: "caller", text: "Sam Miller.", confidence: 0.4 }, { side: "agent", text: "One moment." }, { side: "caller", text: said }, { side: "agent", text: "Okay." }];
    let v = view(lines);
    assert.equal(name(v).state, "confirm", said);
    assert.equal(name(v).confirmReason, "ambiguous", said);
    assert.equal(name(v).heard, said, "the card shows what the caller said last");
    assert.equal(name(v).attempts, 0, said);
    assert.notEqual(v.nameEntry?.readBack, "available", said);
    v = view([...lines, NAME_BACK, YES]);
    assert.notEqual(name(v).state, "ok", `${said}: read-back`);
    v = view(lines, [{ type: "confirm", target: "name", at: at(8) }]);
    assert.notEqual(name(v).state, "ok", `${said}: Confirm`);
  }
});

test("the same for the address, and for a different name after an agent line that asks nothing (review finding 15)", () => {
  const addr: Line[] = [...NAME_OK, { side: "caller", text: "Hill Road in Dallas.", confidence: 0.4 }, { side: "agent", text: "One moment." }, { side: "caller", text: "Sorry, it's Elm Road in Austin." }, { side: "agent", text: "Okay." }];
  let v = view(addr);
  assert.equal(address(v).confirmReason, "ambiguous");
  assert.notEqual(v.addressEntry?.readBack, "available");
  assert.equal(view([...addr, ADDR_BACK, YES]).verification.verified, false);
  assert.equal(view(addr, [{ type: "confirm", target: "address", at: at(10) }]).verification.verified, false);
  const pulling: Line[] = [...opening, { side: "caller", text: "Sam Miller.", confidence: 0.4 }, { side: "agent", text: "I am pulling up your account now." }, { side: "caller", text: "Actually it's Tom Baker." }, { side: "agent", text: "Okay." }];
  v = view(pulling);
  assert.equal(name(v).confirmReason, "ambiguous");
  assert.notEqual(v.nameEntry?.readBack, "available");
  assert.notEqual(name(view([...pulling, NAME_BACK, YES])).state, "ok");
  assert.notEqual(name(view(pulling, [{ type: "confirm", target: "name", at: at(8) }])).state, "ok");
});

test("unrelated speech while the question lingers keeps the read-back, and a wrong answer to the question is still a failed attempt (review finding 15)", () => {
  const lines: Line[] = [...opening, { side: "caller", text: "Sam Miller.", confidence: 0.4 }, { side: "agent", text: "One moment." }, { side: "caller", text: "I'd like a refund instead." }, { side: "agent", text: "Okay." }];
  assert.equal(view(lines).nameEntry?.readBack, "available");
  assert.equal(name(view([...lines, NAME_BACK, YES])).method, NAME_READ_BACK);
  const v = view([...opening, { side: "caller", text: "Sorry, it's Sam Jones." }, { side: "agent", text: "Okay." }]);
  assert.equal(name(v).state, "failed");
  assert.equal(name(v).attempts, 1);
});

/* Finding 16: a reading with no record word let the read-back open over one that heard another surname or street. */

test("a reading with no record word doesn't open the read-back over one that heard another surname or street (review finding 16)", () => {
  for (const [text, firstHeard] of [
    ["Sam Jones.", "Sandler."],
    ["Sandler.", "Sam Jones."],
  ]) {
    const lines: Line[] = [...opening, { side: "caller", text, firstHeard, checked: true }, { side: "agent", text: "Thank you." }];
    assert.notEqual(view(lines).nameEntry?.readBack, "available", text);
    assert.notEqual(name(view([...lines, NAME_BACK, YES])).state, "ok", text);
  }
  for (const [text, firstHeard] of [
    ["Elm Road in Dallas.", "Helrout Indalis."],
    ["Helrout Indalis.", "Elm Road in Dallas."],
  ]) {
    const lines: Line[] = [...NAME_OK, { side: "caller", text, firstHeard, checked: true }, { side: "agent", text: "Okay." }];
    assert.notEqual(view(lines).addressEntry?.readBack, "available", text);
    assert.equal(view([...lines, ADDR_BACK, YES]).verification.verified, false, text);
  }
});

test("a doubtful whole-answer garble with no record word still opens the read-back (review finding 16)", () => {
  let lines: Line[] = [...opening, { side: "caller", text: "Sandler.", confidence: 0.3 }, { side: "agent", text: "Thank you." }];
  assert.equal(view(lines).nameEntry?.readBack, "available");
  assert.equal(name(view([...lines, NAME_BACK, YES])).method, NAME_READ_BACK);
  lines = [...NAME_OK, { side: "caller", text: "Helrout Indalis.", confidence: 0.3 }, { side: "agent", text: "Okay." }];
  assert.equal(view(lines).addressEntry?.readBack, "available");
  assert.equal(address(view([...lines, ADDR_BACK, YES])).method, ADDRESS_READ_BACK);
});

/* Finding 17: the record name typed over the caller's "Yes." to a refused read-back verified it. */

test("typing the record's detail over the caller's yes to a refused read-back doesn't verify it (review finding 17)", () => {
  const nameLines: Line[] = [...opening, { side: "caller", text: "Sam Miller.", confidence: 0.4 }, NAME_BACK, { side: "caller", text: "Yes.", checked: true, firstHeard: "No." }, { side: "agent", text: "Okay." }];
  assert.equal(view(nameLines).nameEntry?.readBack, "refused");
  let v = view(nameLines, [{ type: "correct", key: "k7", text: "Sam Miller", at: at(8) }]);
  assert.notEqual(name(v).state, "ok");
  assert.equal(v.nameEntry?.readBack, "refused");
  assert.match(prompt(v, "name"), /Ask for the full name again/);
  assert.match(prompt(v, "name"), /the caller's reply "Yes\." doesn't count/, "the card quotes what the caller said, not what was typed");
  const addrLines: Line[] = [...NAME_OK, { side: "caller", text: "Hill Road in Dallas.", confidence: 0.4 }, ADDR_BACK, { side: "caller", text: "Yes.", checked: true, firstHeard: "No." }, { side: "agent", text: "Okay." }];
  v = view(addrLines, [{ type: "correct", key: "k9", text: "Hill Road in Dallas", at: at(10) }]);
  assert.notEqual(address(v).state, "ok");
  assert.equal(v.verification.verified, false);
  assert.match(prompt(v, "address"), /Ask for the street and city again/);
});

test("typing over the caller's own earlier answer still verifies, labelled as typed (review finding 17)", () => {
  const nameLines: Line[] = [...opening, { side: "caller", text: "Sam Miller.", confidence: 0.4 }, NAME_BACK, { side: "caller", text: "Yes.", checked: true, firstHeard: "No." }, { side: "agent", text: "Okay." }];
  let v = view(nameLines, [{ type: "correct", key: "k5", text: "Sam Miller", at: at(8) }]);
  assert.equal(name(v).state, "ok");
  // The agent had said the name back before typing it, so the label says so (second review of C7, 23 Oct).
  assert.equal(name(v).method, "typed by the agent, after the agent said it on the call");
  const addrLines: Line[] = [...NAME_OK, { side: "caller", text: "Hill Road in Dallas.", confidence: 0.4 }, ADDR_BACK, { side: "caller", text: "Yes.", checked: true, firstHeard: "No." }, { side: "agent", text: "Okay." }];
  v = view(addrLines, [{ type: "correct", key: "k7", text: "Hill Road in Dallas", at: at(10) }]);
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "street and city, typed by the agent, after the agent said it on the call");
});
