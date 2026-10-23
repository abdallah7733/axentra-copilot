import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_READ_BACK, analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  The 21 Oct stage-call review (NAME_DELAY_PLAN_2026-10-21.md): about 3.3 s of computing and about 10 s of
  recovery before the caller's name ticked, and a refund term heard as "carriers can't return" that was never
  re-heard. Ranks 1 to 4 of the plan: the agent's read-back with the caller's yes (only where the client allows
  it), a name field ready while the second model checks, a terms recheck after approval, and a name card that
  leads with what to do.
*/

const NOW = Date.UTC(2026, 9, 21, 15);
type Line = { side: "caller" | "agent"; text: string; confidence?: number | null; checking?: boolean; firstHeard?: string; checkFailed?: boolean; checked?: boolean; shift?: number; availableAt?: number };

/** Script lines as transcript events, 5 s apart (moved by `shift` ms). */
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-stage",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000 + (l.shift ?? 0),
    endedAt: NOW - 600_000 + i * 5000 + 3000 + (l.shift ?? 0),
    final: true,
    confidence: l.confidence === undefined ? 0.9 : l.confidence,
    ...(l.checking ? { checking: true } : {}),
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
    ...(l.checkFailed ? { checkFailed: true } : {}),
    ...(l.checked ? { checked: true } : {}),
    ...(l.availableAt !== undefined ? { availableAt: l.availableAt } : {}),
  }));
const script = (replace: Record<number, Line | null> = {}, extra: Line[] = []): Line[] => [
  ...scriptV2.flatMap((l) => (l.n in replace ? (replace[l.n] ? [replace[l.n]!] : []) : [{ side: l.side, text: l.text }])),
  ...extra,
];
/** Time of line n (1-based), plus a little. */
const at = (n: number, plus = 100) => NOW - 600_000 + (n - 1) * 5000 + plus;
const withReadBack: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true } };
const noReadBack: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: false } };
/** `now` defaults to 10 minutes after the call's first line: long after any read-back's 8 s wait. */
const view = (lines: Line[], actions: AgentAction[] = [], pack: ClientPack = sunlake, now = NOW) => analyze(pack, events(lines), actions, now);
const nameOf = (v: CopilotView) => v.verification.factors[0];
const nameCard = (v: CopilotView) => v.prompts.find((p) => p.target === "name");

// The stage call: the fast model heard "Sen nilir.", the check "Sammílis." (with the accent) for "Sam Miller".
const NAME = { side: "caller" as const, text: "Sammílis.", firstHeard: "Sen nilir." };
/** The call up to the caller's name answer (line 5), then the given lines in place of the rest. */
const upToName = (answer: Line, then: Line[] = []) => [...script().slice(0, 4), answer, ...then];
const ADDRESS_Q: Line = { side: "agent", text: "Thank you. And the street and city for the delivery?" };
const READ_BACK: Line = { side: "agent", text: "That's Sam Miller, is that right?" };
/** The second model checked it and kept the fast model's words. */
const YES: Line = { side: "caller", text: "Yes, that's right.", checked: true };

/* ---------- Rank 2: the name field is ready while the second model checks ---------- */

test("the name field binds to the caller's answer while it is still being checked", () => {
  const v = view(upToName({ side: "caller", text: "Sen nilir.", checking: true }));
  assert.deepEqual(v.nameEntry, { key: "k5", checking: true, readBack: "off" });
  assert.equal(nameOf(v).state, "asking", "the line is held back: nothing is judged yet");
  assert.equal(nameCard(v), undefined, "no card until the check settles");
});

test("no field flashes up when the fast model already heard the name clearly", () => {
  const v = view(upToName({ side: "caller", text: "Sam Miller.", checking: true }));
  assert.equal(v.nameEntry, null);
});

test("after the check, the card leads with what to do and the field stays on the same answer", () => {
  let v = view(upToName(NAME, [ADDRESS_Q]), [], noReadBack);
  assert.equal(nameOf(v).state, "confirm");
  assert.equal(nameOf(v).confirmReason, "disagree");
  assert.equal(nameOf(v).attempts, 0, "never a failed attempt");
  assert.match(nameCard(v)!.text, /^Name not recognised\. Type what the caller said \(N\), or ask again\. Heard "Sammílis\.", first heard as "Sen nilir\."/);
  assert.equal(nameCard(v)!.askAgain, true, "no Confirm button for a name that doesn't match");
  assert.deepEqual(v.nameEntry, { key: "k5", checking: false, readBack: "off" });

  // With read-back allowed, the card offers it first; typing stays.
  v = view(upToName(NAME, [ADDRESS_Q]), [], withReadBack);
  assert.match(nameCard(v)!.text, /^Name not recognised\. Say the full name back and wait for the caller's yes \(it counts only if it is the name on the order\), or type it \(N\)\. Heard "Sammílis\."/);
  assert.deepEqual(v.nameEntry, { key: "k5", checking: false, readBack: "available" });
});

test("a name typed while the line is still being checked verifies it, and the late check can't overwrite it", () => {
  const typed: AgentAction[] = [{ type: "correct", key: "k5", text: "Sam Miller", at: at(5, 3500) }];
  let v = view(upToName({ side: "caller", text: "Sen nilir.", checking: true }), typed);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, "typed by the agent");
  assert.equal(v.nameEntry, null, "the field goes once the name is verified");

  // The check result arrives after the typing.
  v = view(upToName(NAME, [ADDRESS_Q]), typed);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, "typed by the agent");
  assert.equal(nameOf(v).evidence?.typedFrom, "Sammílis.", "the record keeps what recognition heard");
});

test("an empty field or an acknowledgement is never used as the caller's name", () => {
  for (const text of ["", "   ", "Confirmed", "checked", "OK"]) {
    const v = view(upToName(NAME, [ADDRESS_Q]), [{ type: "correct", key: "k5", text, at: at(6) }]);
    assert.notEqual(nameOf(v).state, "ok", `"${text}"`);
    assert.equal(nameOf(v).evidence?.text, "Sammílis.", `"${text}" doesn't replace the answer`);
  }
});

test("a wrong typed name never verifies, and a failed or locked name keeps the field for a correction", () => {
  let v = view(upToName(NAME, [ADDRESS_Q]), [{ type: "correct", key: "k5", text: "Sam Mueller", at: at(6) }]);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(nameOf(v).attempts, 1, "typed words get no sound-alike leniency");
  assert.equal(v.nameEntry?.key, "k5");

  // Two clear wrong answers lock the check; the field stays on the latest one.
  v = view(upToName({ side: "caller", text: "John Smith." }, [
    { side: "agent", text: "Sorry, could I have your full name again?" },
    { side: "caller", text: "John Smith." },
    ADDRESS_Q,
  ]));
  assert.equal(v.verification.locked, true);
  assert.deepEqual(v.nameEntry, { key: "k7", checking: false, readBack: "off" });
});

/* ---------- Rank 1: the agent's read-back and the caller's yes (only where the client allows it) ---------- */

// His conditions, 22 Oct: the caller gives the name first and the copilot never suggests one; the agent's complete
// name, word for word, as a question; the caller's finished, checked, plain yes to that question. A no, a "yes, but",
// silence, unclear speech or a yes to another question never verifies. The address check and typing stay. Labelled
// "Name read back by agent, confirmed by caller", never scored as recognition.

test("read-back is a build setting, off by default; a client without it leaves the name unverified", () => {
  // Review, 22 Oct: merging must not turn it on publicly. Only a build with NEXT_PUBLIC_NAME_READ_BACK=1 has it.
  assert.equal(sunlake.policy.nameReadBack, process.env.NEXT_PUBLIC_NAME_READ_BACK === "1");
  const v = view(upToName(NAME, [READ_BACK, YES, ADDRESS_Q]), [], noReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(nameOf(v).confirmedBy, undefined);
  assert.equal(v.nameEntry?.readBack, "off");
});

test("the agent's exact words plus the caller's checked plain yes verify the name, labelled as read back", () => {
  let v = view(upToName(NAME, [ADDRESS_Q]), [], withReadBack);
  assert.equal(v.nameEntry?.readBack, "available");
  assert.doesNotMatch(nameCard(v)!.text, /Sam Miller/, "the card never shows the name on the record");

  // 1 s after the read-back ends.
  v = view(upToName(NAME, [READ_BACK]), [], withReadBack, at(6, 4000));
  assert.equal(v.nameEntry?.readBack, "waiting");
  assert.equal(v.nameEntry?.readBackUntil, at(6, 3000) + 8000, "the console looks again when the wait runs out");
  assert.match(nameCard(v)!.text, /^Name not recognised\. Wait for the caller's yes to your read-back, or type what the caller said \(N\)\./);
  assert.equal(v.awaiting, "name", "the caller's next line is the key answer");

  const lines = upToName(NAME, [READ_BACK, YES, ADDRESS_Q]);
  v = view(lines, [], withReadBack);
  const name = nameOf(v);
  assert.equal(name.state, "ok");
  assert.equal(name.method, NAME_READ_BACK);
  assert.equal(name.method, "name read back by agent, confirmed by caller");
  assert.equal(name.evidence?.text, READ_BACK.text, "the name comes from the agent's words");
  assert.equal(name.confirmedBy?.text, YES.text);
  assert.equal(name.heard, "Sammílis.", "the yes isn't heard as the name");
  assert.ok(v.keyAnswers.includes("k7"), "the caller's yes gets the second model's check");
  assert.equal(v.steps.find((s) => s.id === "name")!.detail, "Name read back by agent, confirmed by caller");
  assert.equal(v.verification.verified, false, "the street and city are still required");
  assert.equal(v.nameEntry, null);
  assert.equal(nameCard(v), undefined);

  v = view([...lines, { side: "caller", text: "Hill Road, in Dallas." }], [], withReadBack);
  assert.equal(v.verification.verified, true);
  assert.match(v.documentation.find((d) => d.label === "Case summary")!.value ?? "", /verified by full name \(name read back by agent, confirmed by caller\)/);
});

test("Call details can time it: from the end of the caller's answer to the yes being usable", () => {
  // The answer ends at line 5's end; the yes (line 7) is usable when it arrives, 13 s later in this script.
  const name = nameOf(view(upToName(NAME, [READ_BACK, YES, ADDRESS_Q]), [], withReadBack));
  assert.equal(name.answeredAt, NOW - 600_000 + 4 * 5000 + 3000);
  assert.equal(name.knownAt, NOW - 600_000 + 6 * 5000 + 3000);

  // Typing: from the same answer to the typed words.
  const typed = nameOf(view(upToName(NAME, [ADDRESS_Q]), [{ type: "correct", key: "k5", text: "Sam Miller", at: at(6, 1500) }], withReadBack));
  assert.equal(typed.method, "typed by the agent");
  assert.equal(typed.answeredAt, NOW - 600_000 + 4 * 5000 + 3000);
  assert.equal(typed.knownAt, at(6, 1500));
});

test("while the caller's yes is being checked, nothing is verified and the field stays on the name answer", () => {
  // Long after the 8 s: a yes that started in time keeps the wait open for as long as its check takes.
  const v = view(upToName(NAME, [READ_BACK, { side: "caller", text: "Yes.", checking: true }]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(v.nameEntry?.key, "k5");
  assert.equal(v.nameEntry?.readBack, "waiting");
  assert.equal(v.nameEntry?.readBackUntil, undefined, "no expiry while the yes is being checked");
});

test("a read-back counts only as the full name word for word, asked as one question, and not negated", () => {
  for (const text of [
    "That's Sam Mila, is that right?",
    "Is that Sam?",
    "Thank you, Sam Miller.",
    "That's not Sam Miller, is it?",
    "So that isn't Sam Miller?",
    "Sam Miller, and is the damage only on the screen?",
    "Is the damage only on the screen? Sam Miller, right?",
    "Sam Miller, did it arrive damaged?",
  ]) {
    const v = view(upToName(NAME, [{ side: "agent", text }, YES, ADDRESS_Q]), [], withReadBack);
    assert.notEqual(nameOf(v).state, "ok", text);
  }
  for (const text of ["So that's Sam Miller, is that correct.", "Is that Sam Miller?", "Okay, just to confirm, Sam Miller?", "Sam Miller, right?"]) {
    const v = view(upToName(NAME, [{ side: "agent", text }, YES, ADDRESS_Q]), [], withReadBack);
    assert.equal(nameOf(v).state, "ok", text);
  }
});

test("the agent can't lead with the name: a read-back needs the caller's answer first", () => {
  const lines = [...script().slice(0, 3), { side: "agent" as const, text: "Am I speaking with Sam Miller?" }, YES, ADDRESS_Q];
  const v = view(lines, [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
});

test("no read-back after a partial or two-name answer: the agent asks for the full name", () => {
  for (const answer of [{ side: "caller" as const, text: "Sam." }, { side: "caller" as const, text: "Sam Miller or John Smith." }]) {
    const v = view(upToName(answer, [READ_BACK, YES, ADDRESS_Q]), [], withReadBack);
    assert.notEqual(nameOf(v).state, "ok", answer.text);
    assert.equal(nameOf(v).method, undefined, answer.text);
  }
});

test("read-back is still allowed after one failed answer (his choice, 23 Oct), and the caller's checked yes verifies the name", () => {
  const before = view(upToName({ side: "caller", text: "John Smith." }, [{ side: "agent", text: "Thank you." }]), [], withReadBack);
  assert.equal(nameOf(before).attempts, 1);
  assert.equal(nameOf(before).state, "failed");
  assert.equal(before.nameEntry?.readBack, "available");
  const v = view(upToName({ side: "caller", text: "John Smith." }, [{ side: "agent", text: "Thank you." }, READ_BACK, YES, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(v).attempts, 1);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, NAME_READ_BACK);
});

test("no read-back once identity is locked after two failed answers", () => {
  const lines = upToName({ side: "caller", text: "John Smith." }, [
    { side: "agent", text: "Could you say your full name once more?" },
    { side: "caller", text: "John Smith.", checked: true },
    { side: "agent", text: "Thank you." },
    READ_BACK,
    YES,
  ]);
  const v = view(lines, [], withReadBack);
  assert.equal(nameOf(v).attempts, 2);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(v.verification.locked, true);
});

test("each reply that isn't a finished, checked, plain yes leaves the name unverified, says why, and isn't a failed attempt", () => {
  // What to do next (review, 22 Oct): after the caller's no, or any reply the caller made that isn't a plain yes, ask for
  // the full name again; type only when the system couldn't confirm a yes the agent clearly heard.
  const ASK = /Ask for the full name again, and type the new answer \(N\) only if it still isn't recognised\. Reading the name back again won't count on this call\./;
  const TYPE = /If you clearly heard the caller give their name and say yes, type the name \(N\); otherwise ask for the full name again\. Reading the name back again won't count on this call\./;
  const cases: [Line, RegExp, "ask" | "type"][] = [
    [{ side: "caller", text: "No.", checked: true }, /isn't a plain yes/, "ask"],
    [{ side: "caller", text: "No, that's not right.", checked: true }, /isn't a plain yes/, "ask"],
    [{ side: "caller", text: "Yes, but it's spelled differently.", checked: true }, /isn't a plain yes/, "ask"],
    [{ side: "caller", text: "Yes?", checked: true }, /isn't a plain yes/, "ask"],
    [{ side: "caller", text: "Yes, that's right." }, /didn't finish checking/, "type"],
    [{ side: "caller", text: "Yes.", checkFailed: true }, /didn't finish checking/, "type"],
    [{ side: "caller", text: "Yes.", checked: true, firstHeard: "No." }, /fast model heard "No\."/, "ask"],
    [{ side: "caller", text: "Yes.", checked: true, confidence: 0.3 }, /unclear/, "type"],
    [{ side: "caller", text: "Yes.", checked: true, shift: -2500 }, /started before the question ended/, "ask"],
  ];
  for (const [reply, why, recovery] of cases) {
    const v = view(upToName(NAME, [READ_BACK, reply, ADDRESS_Q]), [], withReadBack);
    const label = JSON.stringify(reply);
    assert.notEqual(nameOf(v).state, "ok", label);
    assert.equal(nameOf(v).attempts, 0, `${label}: never a failed attempt`);
    assert.equal(nameOf(v).heard, "Sammílis.", `${label}: a yes or no is never the name`);
    assert.equal(v.nameEntry?.readBack, "refused", label);
    assert.equal(v.nameEntry?.readBackRecovery, recovery, label);
    assert.equal(v.nameEntry?.key, "k5", `${label}: typing corrects the caller's name answer`);
    const card = nameCard(v)!;
    assert.match(card.text, /^Read-back not confirmed: the caller's reply/, label);
    assert.match(card.text, why, label);
    assert.match(card.text, recovery === "ask" ? ASK : TYPE, label);
    assert.equal(card.askAgain, true, `${label}: no Confirm button`);
  }

  // A yes long after the question isn't its answer.
  const late = view(upToName(NAME, [READ_BACK, { side: "caller", text: "Yes.", checked: true, shift: 8500 }]), [], withReadBack);
  assert.notEqual(nameOf(late).state, "ok");
  assert.match(nameCard(late)!.text, /came too long after the question/);
  assert.equal(late.nameEntry?.readBackRecovery, "ask");

  // Silence: no reply, then the agent moves on. Nothing verifies and it isn't a refusal: the read-back is offered again.
  const silent = view(upToName(NAME, [READ_BACK, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(silent).state, "ok");
  assert.equal(nameOf(silent).attempts, 0);
  assert.equal(silent.nameEntry?.readBack, "available");
});

test("silence after the read-back: the wait ends 8 s after the question, and a yes after that doesn't count", () => {
  // The read-back (line 6) ends at at(6, 3000); the wait runs to 8 s after that, inclusive.
  const until = at(6, 3000) + 8000;
  let v = view(upToName(NAME, [READ_BACK]), [], withReadBack, until);
  assert.equal(v.nameEntry?.readBack, "waiting");
  v = view(upToName(NAME, [READ_BACK]), [], withReadBack, until + 1);
  assert.equal(v.nameEntry?.readBack, "expired");
  assert.equal(v.nameEntry?.readBackUntil, undefined);
  assert.equal(nameOf(v).attempts, 0, "silence isn't a failed attempt");
  assert.match(nameCard(v)!.text, /^Name not recognised\. No reply to your read-back within 8 s, so a yes now won't count\. Ask for the full name again, or type it \(N\)\. Heard "Sammílis\."/);
  assert.equal(nameCard(v)!.askAgain, true);

  // The caller's yes starting exactly at the end of the wait still counts; 1 ms later it doesn't.
  // Line 7 starts 2 s after line 6 ends, so a shift of 6000 puts its start at `until`.
  assert.equal(nameOf(view(upToName(NAME, [READ_BACK, { ...YES, shift: 6000 }]), [], withReadBack)).state, "ok");
  v = view(upToName(NAME, [READ_BACK, { ...YES, shift: 6001 }]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.match(nameCard(v)!.text, /came too long after the question\. Ask for the full name again/);
});

test("a yes to another question never verifies the name", () => {
  const v = view(upToName(NAME, [READ_BACK, { side: "agent", text: "And did it arrive damaged?" }, { side: "caller", text: "Yes.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
});

test("after a refused read-back: no second read-back, Confirm does nothing, typing verifies, the address is still needed", () => {
  const no: Line = { side: "caller", text: "No, that's not right.", checked: true };
  const again = upToName(NAME, [READ_BACK, no, READ_BACK, YES, ADDRESS_Q]);
  let v = view(again, [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok", "reading it back again doesn't count");

  v = view(upToName(NAME, [READ_BACK, no, ADDRESS_Q]), [{ type: "confirm", target: "name", at: at(8) }], withReadBack);
  assert.notEqual(nameOf(v).state, "ok", "the Confirm button doesn't override the caller's no");

  const typed: AgentAction[] = [{ type: "correct", key: "k5", text: "Sam Miller", at: at(8) }];
  v = view(upToName(NAME, [READ_BACK, no, ADDRESS_Q]), typed, withReadBack);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, "typed by the agent");
  assert.equal(v.verification.verified, false, "the street and city are still required");
  v = view(upToName(NAME, [READ_BACK, no, ADDRESS_Q, { side: "caller", text: "Hill Road, in Dallas." }]), typed, withReadBack);
  assert.equal(v.verification.verified, true);

  // Asked again, a new answer the models still can't confirm: the card says to type, with the new answer.
  v = view(upToName(NAME, [READ_BACK, no, { side: "agent", text: "Sorry, could I have your full name again?" }, { side: "caller", text: "Sammílis.", firstHeard: "Sam Ellis." }]), [], withReadBack);
  assert.match(nameCard(v)!.text, /^Name not recognised\. Type what the caller said \(N\), or ask again\. Heard "Sammílis\."\. The read-back wasn't confirmed earlier/);
  assert.equal(nameCard(v)!.askAgain, true);
});

test("the caller's own correction is heard as usual, never as the read-back", () => {
  let v = view(upToName(NAME, [READ_BACK, { side: "caller", text: "No, it's Sam Miller.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, undefined, "recognised from the caller's words, not the read-back");

  // A different name in the reply is a wrong answer, as anywhere else... once it says part of the name.
  v = view(upToName(NAME, [READ_BACK, { side: "caller", text: "No, it's Sam Smith.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(nameOf(v).attempts, 1);

  // "Yes, it's Sam Millar": not a plain yes, and the sound-alike needs typing (Confirm is off after a refused read-back).
  v = view(upToName(NAME, [READ_BACK, { side: "caller", text: "Yes, it's Sam Millar.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(nameCard(v)!.askAgain, true);
});

test("an unclear read-back line doesn't count", () => {
  const v = view(upToName(NAME, [{ ...READ_BACK, confidence: 0.3 }, YES, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
});

/* ---------- Outside review of C2, 22 Oct (sections 2 and 3) ---------- */

test("review 2A: a checked yes followed by a separate correction doesn't verify the name", () => {
  const yes: Line = { side: "caller", text: "Yes.", checked: true };
  const butNo: Line = { side: "caller", text: "But no, that's not right.", checked: true };
  let v = view(upToName(NAME, [READ_BACK, yes, butNo, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok", "the correction in the same reply ends the read-back");
  v = view(upToName(NAME, [READ_BACK, yes, butNo, ADDRESS_Q, { side: "caller", text: "Hill Road, in Dallas." }]), [], withReadBack);
  assert.equal(v.verification.verified, false, "the address can't complete identity on the earlier yes");
  // The correction still being checked when the yes's check finishes: nothing verifies until it is heard.
  v = view(upToName(NAME, [READ_BACK, yes, { ...butNo, checked: undefined, checking: true }]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok", "held while the rest of the reply is being checked");
});

test("review 2B: a late check result can't move the time a typed name was accepted", () => {
  const typedAt = at(5, 3500);
  const typed: AgentAction[] = [{ type: "correct", key: "k5", text: "Sam Miller", at: typedAt }];
  const lateCheck = { ...NAME, checked: true, availableAt: at(6, 2500) };
  const v = view(upToName(lateCheck, [ADDRESS_Q]), typed, withReadBack);
  assert.equal(nameOf(v).method, "typed by the agent");
  assert.equal(nameOf(v).knownAt, typedAt);
});

test("review 3: the overlap tolerance is 250 ms, at the boundary", () => {
  // The read-back ends 2 s before the next line starts in this script.
  const ok = view(upToName(NAME, [READ_BACK, { ...YES, shift: -2250 }, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(ok).state, "ok", "starting 250 ms before the question ends is tolerated");
  const early = view(upToName(NAME, [READ_BACK, { ...YES, shift: -2251 }, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(early).state, "ok", "251 ms is overlap");
});

test("review 2A: the rest of the reply decides; more yes is fine, a new name ends the read-back and is heard as usual", () => {
  const yes: Line = { side: "caller", text: "Yes.", checked: true };
  let v = view(upToName(NAME, [READ_BACK, yes, { side: "caller", text: "Yes, that's right.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(v).state, "ok", "a second plain yes is still a plain yes");
  assert.equal(nameOf(v).method, NAME_READ_BACK);

  v = view(upToName(NAME, [READ_BACK, yes, { side: "caller", text: "Actually it's Sam Millar.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.notEqual(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, undefined);
  assert.equal(nameOf(v).attempts, 0, "a sound-alike is never a failed attempt");
  assert.equal(nameOf(v).heard, "Actually it's Sam Millar.", "the caller's new words are the name answer now");
  assert.match(nameCard(v)!.text, /^Name not recognised\. Type what the caller said \(N\), or ask again\./);
  assert.equal(nameCard(v)!.askAgain, true, "no Confirm button after a read-back that wasn't confirmed");
});

test("review, dev call 5: after the caller's no, the agent asks again and the caller's new answer is what counts", () => {
  const no: Line = { side: "caller", text: "No, that's not right.", checked: true };
  const ASK_AGAIN: Line = { side: "agent", text: "Sorry about that. Could I have your full name again, please?" };
  let v = view(upToName(NAME, [READ_BACK, no]), [], withReadBack);
  assert.match(nameCard(v)!.text, /Ask for the full name again/);
  assert.equal(v.nameEntry?.readBackRecovery, "ask");

  // Recognised this time: no typing needed.
  v = view(upToName(NAME, [READ_BACK, no, ASK_AGAIN, { side: "caller", text: "Sam Miller.", checked: true }, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, undefined, "recognised from the caller's own words");
  assert.equal(nameOf(v).answeredAt, at(5, 3000), "still timed from the end of the first name answer");

  // Still not recognised: the agent types the new answer, and the field is on it.
  const again: Line = { side: "caller", text: "Sammílis.", checked: true, firstHeard: "Sam Ellis." };
  v = view(upToName(NAME, [READ_BACK, no, ASK_AGAIN, again]), [], withReadBack);
  assert.equal(v.nameEntry?.key, "k9");
  v = view(upToName(NAME, [READ_BACK, no, ASK_AGAIN, again, ADDRESS_Q]), [{ type: "correct", key: "k9", text: "Sam Miller", at: at(10) }], withReadBack);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).method, "typed by the agent");
  assert.equal(nameOf(v).answeredAt, at(5, 3000));
  assert.equal(nameOf(v).knownAt, at(10));
});

test("review: the timer starts at the end of the caller's whole first name answer, the same for every route", () => {
  // A first answer in two lines, before the agent speaks again.
  const v = view(upToName({ side: "caller", text: "Sam." }, [{ side: "caller", text: "Miller.", shift: -1500 }, ADDRESS_Q]), [], withReadBack);
  assert.equal(nameOf(v).state, "ok");
  assert.equal(nameOf(v).answeredAt, at(6, 3000 - 1500), "the end of the second line of the same answer");
});

/* ---------- Rank 3: terms checked again after approval ---------- */

// The stage call's end: the caller chose the refund, the agent approved in the panel, then said the terms.
const refundCall = (terms: Line[]) => script({ 11: { side: "caller", text: "A refund, please." }, 12: null, 13: null, 14: null, 15: null }, terms);
const approveAfterChoice: AgentAction[] = [{ type: "approve", at: at(11, 4000) }];
const SET_UP: Line = { side: "agent", text: "I've set up a full refund of $329.00 to your Visa ending 2208." };
const MISHEARD: Line = { side: "agent", text: "It's issued when the carriers can't return." };
const TIMING: Line = { side: "agent", text: "And it takes 3 to 5 business days to appear." };
const LABEL: Line = { side: "agent", text: "You'll get an email with a free return label." };

test("a misheard term after approval gets the second model's check, and the record says why", () => {
  const v = view(refundCall([SET_UP, MISHEARD]), approveAfterChoice);
  assert.equal(v.recommendation?.approval.state, "approved");
  assert.ok(v.keyAnswers.includes("k13"), "the misheard terms line is checked");
  assert.deepEqual(v.agentChecks.find((c) => c.key === "k13"), { key: "k13", check: true, reason: "a term isn't heard yet since the approval" });
});

test("once the check hears the term, the terms complete and later lines aren't held back", () => {
  const checked = { ...MISHEARD, text: "It's issued when the carrier scans the return.", firstHeard: MISHEARD.text };
  const v = view(refundCall([SET_UP, checked, TIMING, LABEL, { side: "agent", text: "Is there anything else I can help with?" }]), approveAfterChoice);
  assert.equal(v.steps.find((s) => s.id === "docs")!.detail, "Terms heard on the call");
  assert.ok(!v.keyAnswers.includes("k15"), "with every term heard, no line is held back");
  assert.ok(!v.keyAnswers.includes("k16"));
  assert.equal(v.agentChecks.find((c) => c.key === "k16")?.check, false);
});

test("the negation rules still decide what counts after a checked line", () => {
  const negated = { ...MISHEARD, text: "We don't need a scan, it takes 3 to 5 business days.", firstHeard: MISHEARD.text };
  const v = view(refundCall([SET_UP, negated, LABEL]), approveAfterChoice);
  assert.match(v.steps.find((s) => s.id === "docs")!.detail ?? "", /Not heard yet: when it's issued and how long it takes/);
});

test("before approval, lines are checked as before: only about the outcome or unclear", () => {
  const v = view(refundCall([MISHEARD]));
  assert.notEqual(v.recommendation?.approval.state, "approved");
  assert.ok(!v.keyAnswers.includes("k12"));
  assert.equal(v.agentChecks.find((c) => c.key === "k12")?.reason, "not about the outcome");
});
