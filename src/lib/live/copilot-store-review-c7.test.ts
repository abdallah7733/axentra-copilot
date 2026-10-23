import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  Independent review of C7 (23 Oct): approvals, self-corrections and waits, as checked against the code. A spoken
  approval counts only on identity verified before it, like a panel one. A caller correcting themselves anywhere in the
  same answer (after a filler line, after a Confirm press, after a volunteered match, or before the line that matched)
  is asked again, and an approval given before that correction never comes back. A read-back that says "name" or
  "address" while the rest of the answer is still being checked waits for it. A line that reached the console only
  after a press doesn't take that press back. A read-back's two-line yes counts when its last line is checked. And a
  split or disputed answer during the linger after "One moment, please." is heard, not dropped.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");

const IDENTITY_LATER = /verified only after it/;

function call(callId: string) {
  const T0 = epochNow();
  useLive.setState({ checkLine: () => "started" });
  liveEvents.emit({ type: "call-started", callId, at: T0 });
  let seq = 0;
  const lines = new Map<string, TranscriptEvent>();
  const at = (t: number) => {
    assert.ok(T0 + t >= epochNow(), "the clock only moves forward");
    mono += T0 + t - epochNow();
  };
  const arrive = (key: string, side: "caller" | "agent", text: string, start: number, end: number) => {
    const l: TranscriptEvent = { callId, seq: ++seq, key, side, text, startedAt: T0 + start, endedAt: T0 + end, final: true, confidence: 0.9, availableAt: epochNow() };
    lines.set(key, l);
    liveEvents.emit({ type: "line", line: l });
  };
  const checked = (key: string, text?: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, text: text ?? l.text, ...(text && text !== l.text ? { firstHeard: l.text } : {}), checked: true, availableAt: epochNow() } });
  };
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const address = () => view().verification.factors[1];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  const approval = () => view().recommendation?.approval.state;
  const history = () => view().recommendation?.history ?? [];
  return { T0, at, arrive, checked, view, name, address, held, approval, history, s: () => useCopilot.getState() };
}
type C = ReturnType<typeof call>;

/** Greeting, the problem with the choice (checked), the address heard clearly (checked), then the name question. */
function toName(c: C) {
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
  c.at(14_000);
  c.arrive("ax", "agent", "First, can I have the street and city for the delivery?", 11_500, 13_500);
  c.at(16_500);
  c.arrive("cx", "caller", "Hill Road, in Dallas.", 14_500, 16_000);
  c.at(18_000);
  if (c.held("cx")) c.checked("cx");
  assert.equal(c.address().state, "ok");
  c.at(21_000);
  c.arrive("a2", "agent", "Thank you. And your full name, please?", 18_500, 20_500);
}

/** "Sam Miler." (checked, a sound-alike), the read-back, and the caller's "Yes." (checked): verified by the read-back. */
function readBackYes(c: C) {
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(25_000);
  if (c.held("c2")) c.checked("c2");
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
  c.at(28_900);
  c.arrive("c3", "caller", "Yes.", 28_000, 28_400);
  c.at(29_500);
  if (c.held("c3")) c.checked("c3");
  assert.equal(c.view().verification.verified, true);
  c.at(29_700);
  c.s().confirm("order");
}

/* Finding 1: the spoken approval had no knownAt gate. */

test("a spoken approval said before the caller's refusal reached the console doesn't come back when the agent types the name (review finding 1)", () => {
  const c = call("R1");
  readBackYes(c);
  c.at(32_200);
  c.arrive("a4", "agent", "Done. The new tablet ships today.", 30_000, 32_000);
  c.at(32_300);
  c.arrive("c4", "caller", "But no, that's not right.", 29_200, 30_400);
  assert.ok(c.held("c4"));
  c.at(33_800);
  c.checked("c4");
  assert.equal(c.view().verification.verified, false);
  assert.notEqual(c.approval(), "approved");
  // Typing over the old answer doesn't get past the caller's "no" (his decision, 23 Oct 12:35); the new answer is typed.
  c.at(36_000);
  c.s().correct("c2", "Sam Miller");
  assert.notEqual(c.name().state, "ok");
  c.at(39_000);
  c.arrive("a5", "agent", "Sorry, could I have your full name again?", 36_500, 38_500);
  c.at(41_000);
  c.arrive("c5", "caller", "Sammílis.", 39_200, 40_200);
  if (c.held("c5")) {
    c.at(42_000);
    c.checked("c5");
  }
  c.at(43_000);
  c.s().correct("c5", "Sam Miller");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "typed by the agent, after the agent said it on the call");
  assert.notEqual(c.approval(), "approved", "the agent approves again, on what is verified now");

  const spoken = c.history().find((h) => h.at === c.T0 + 32_000);
  assert.equal(spoken?.via, "call");
  assert.equal(spoken?.counted, false);
  // Kept in the history as not counted: the caller's rejection, said before it, reached the console after it.
  assert.match(spoken?.reason ?? "", /said before it, which reached the console after it, undid identity/);
});

test("a spoken approval after a read-back with a checked plain yes still counts (review finding 1)", () => {
  const c = call("R1-control");
  readBackYes(c);
  c.at(32_200);
  c.arrive("a4", "agent", "Done. The new tablet ships today.", 30_000, 32_000);
  c.at(34_000);
  c.arrive("c4", "caller", "Thank you.", 32_500, 33_200);
  if (c.held("c4")) {
    c.at(35_000);
    c.checked("c4");
  }
  assert.equal(c.approval(), "approved");
  assert.deepEqual(
    c.history().map((h) => ({ at: h.at - c.T0, via: h.via, counted: h.counted })),
    [{ at: 32_000, via: "call", counted: true }],
  );
});

/* Finding 4: the self-correction check joined the match only with the very next caller line. */

test('"Sam Miller." "Um." "No wait, it\'s Tom Baker." is asked again, and an approval doesn\'t count (review finding 4)', () => {
  const c = call("R4a");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(23_600);
  c.arrive("c2b", "caller", "Um.", 22_800, 23_100);
  c.at(25_500);
  c.arrive("c2c", "caller", "No wait, it's Tom Baker.", 23_600, 25_000);
  c.at(26_000);
  for (const k of ["c2", "c2b", "c2c"]) if (c.held(k)) c.checked(k);
  assert.equal(c.name().state, "confirm");
  assert.equal(c.name().confirmReason, "ambiguous");
  assert.equal(c.name().attempts, 0);
  assert.equal(c.view().verification.verified, false);
  c.at(27_000);
  c.s().confirm("order");
  c.at(27_500);
  c.s().approve();
  assert.notEqual(c.approval(), "approved");
  assert.ok(!c.history().some((h) => h.counted));
});

test('"Sam Miller." "No wait, it\'s Tom Baker." "Sorry, Sam Miller." stays asked again (review finding 4)', () => {
  const c = call("R4b");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(24_800);
  c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 22_800, 24_400);
  c.at(26_400);
  c.arrive("c2c", "caller", "Sorry, Sam Miller.", 25_000, 26_000);
  c.at(27_000);
  for (const k of ["c2", "c2b", "c2c"]) if (c.held(k)) c.checked(k);
  assert.equal(c.name().state, "confirm");
  assert.equal(c.name().confirmReason, "ambiguous");
  assert.equal(c.view().verification.verified, false);
});

test('"Sam Miller." "Um." "That\'s it." still verifies, recognised (review finding 4)', () => {
  const c = call("R4-control");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(23_600);
  c.arrive("c2b", "caller", "Um.", 22_800, 23_100);
  c.at(25_500);
  c.arrive("c2c", "caller", "That's it.", 23_600, 25_000);
  c.at(26_000);
  for (const k of ["c2", "c2b", "c2c"]) if (c.held(k)) c.checked(k);
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, undefined, "recognised");
  assert.equal(c.view().verification.verified, true);
});

/* Finding 5: a volunteered match and a Confirm press skipped the self-correction rule. */

test("a name volunteered at the opening and corrected in the next line is asked again (review finding 5)", () => {
  const c = call("R5a");
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(5000);
  c.arrive("c1", "caller", "Hi, this is Sam Miller.", 3000, 4500);
  c.at(5500);
  if (c.held("c1")) c.checked("c1");
  c.at(9500);
  c.arrive("c1b", "caller", "No wait, it's Tom Baker. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 4800, 9000);
  // It reached the console after the tick showed, so the tick stays while it is checked (as for a press; second review
  // of C7, 23 Oct); the check then withdraws it.
  c.at(11_000);
  if (c.held("c1b")) c.checked("c1b");
  assert.equal(c.name().state, "confirm");
  assert.equal(c.name().confirmReason, "ambiguous");
  c.at(14_000);
  c.arrive("ax", "agent", "Can I have the street and city for the delivery?", 11_500, 13_500);
  c.at(16_500);
  c.arrive("cx", "caller", "Hill Road, in Dallas.", 14_500, 16_000);
  c.at(18_000);
  if (c.held("cx")) c.checked("cx");
  assert.equal(c.address().state, "ok");
  c.at(19_000);
  c.s().confirm("order");
  c.at(19_500);
  c.s().approve();
  assert.equal(c.view().verification.verified, false);
  assert.notEqual(c.approval(), "approved");
});

test("a name volunteered at the opening with no correction after it still verifies (review finding 5)", () => {
  const c = call("R5a-control");
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(5000);
  c.arrive("c1", "caller", "Hi, this is Sam Miller.", 3000, 4500);
  c.at(5500);
  if (c.held("c1")) c.checked("c1");
  c.at(9500);
  c.arrive("c1b", "caller", "I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 4800, 9000);
  c.at(11_000);
  if (c.held("c1b")) c.checked("c1b");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().evidence?.key, "c1");
});

for (const [rest, withdrawn] of [
  ["No wait, it's Tom Baker.", true],
  ["And it's about the tablet.", false],
] as const)
  test(`a Confirm press on a sound-alike ${withdrawn ? "is withdrawn by" : "stands after"} the caller's next line in the same answer: "${rest}" (review finding 5)`, () => {
    const c = call(`R5b-${rest}`);
    toName(c);
    c.at(23_000);
    c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
    c.at(23_500);
    if (c.held("c2")) c.checked("c2");
    assert.equal(c.name().confirmReason, "sounds-like");
    c.at(23_700);
    c.s().confirm("name");
    assert.equal(c.name().state, "ok");
    c.at(25_500);
    c.arrive("c2b", "caller", rest, 23_900, 25_000);
    c.at(26_500);
    if (c.held("c2b")) c.checked("c2b");
    if (withdrawn) {
      assert.equal(c.name().state, "confirm");
      assert.equal(c.name().confirmReason, "ambiguous");
      assert.equal(c.name().method, undefined, "no longer shown as confirmed by the agent");
      assert.ok(c.view().prompts.some((p) => p.target === "name"), "the agent is told to ask again");
      c.at(27_000);
      c.s().confirm("order");
      c.at(28_000);
      c.s().approve();
      assert.notEqual(c.approval(), "approved");
    } else {
      assert.equal(c.name().state, "ok");
      assert.equal(c.name().method, "confirmed by the agent");
      assert.equal(c.name().knownAt, c.T0 + 23_700);
    }
  });

/* Finding 6: the same-answer wait only looked forward. */

test("an exact name doesn't verify while an earlier line of the same answer is still being checked (review finding 6)", () => {
  const c = call("R6");
  toName(c);
  c.at(24_000);
  c.arrive("c2", "caller", "Tom Baker, no wait,", 21_500, 23_300);
  c.at(25_000);
  c.arrive("c2b", "caller", "it's Sam Miller.", 23_600, 24_600);
  assert.ok(c.held("c2") && c.held("c2b"));
  c.at(25_500);
  c.checked("c2b");
  assert.notEqual(c.name().state, "ok");
  assert.equal(c.view().verification.verified, false);
  c.at(25_800);
  c.s().confirm("order");
  c.at(26_000);
  c.s().approve();
  assert.notEqual(c.approval(), "approved");
  c.at(27_000);
  c.checked("c2");
  assert.equal(c.name().confirmReason, "ambiguous");
  assert.equal(c.view().verification.verified, false);
  assert.notEqual(c.approval(), "approved");
});

test("an exact name after an earlier line that only leads in verifies once both lines are checked (review finding 6)", () => {
  const c = call("R6-control");
  toName(c);
  c.at(24_000);
  c.arrive("c2", "caller", "Yes, of course, it's", 21_500, 23_300);
  c.at(25_000);
  c.arrive("c2b", "caller", "Sam Miller.", 23_600, 24_600);
  c.at(25_500);
  c.checked("c2b");
  assert.equal(c.view().verification.verified, false, "waits for the earlier line");
  c.at(27_000);
  c.checked("c2");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().knownAt, c.T0 + 27_000);
  assert.equal(c.view().verification.verified, true);
});

/* Finding 7: an approval given before a same-answer correction came back once the name was given again. */

test("an approval pressed between a match and the caller's same-answer correction doesn't come back when the name is given again (review finding 7)", () => {
  const c = call("R7");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(23_500);
  if (c.held("c2")) c.checked("c2");
  c.at(23_600);
  c.s().confirm("order");
  c.at(23_800);
  c.s().approve();
  assert.equal(c.approval(), "approved");
  c.at(25_700);
  c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 24_000, 25_200);
  c.at(26_500);
  if (c.held("c2b")) c.checked("c2b");
  assert.equal(c.view().verification.verified, false);
  c.at(29_200);
  c.arrive("a3", "agent", "Sorry, could I have your full name once more?", 27_000, 29_000);
  c.at(31_000);
  c.arrive("c3", "caller", "Sam Miller.", 29_500, 30_500);
  c.at(31_500);
  if (c.held("c3")) c.checked("c3");
  assert.equal(c.name().state, "ok");
  assert.equal(c.view().verification.verified, true);
  assert.notEqual(c.approval(), "approved");
  const first = c.history().find((h) => h.at === c.T0 + 23_800);
  assert.equal(first?.counted, false);
  assert.match(first?.reason ?? "", /corrected after it/);
  // The agent approves again, on what is verified now.
  c.at(32_000);
  c.s().approve();
  assert.equal(c.approval(), "approved");
  assert.ok(c.history().some((h) => h.at === c.T0 + 32_000 && h.counted));
});

/* Finding 12 (the part fixed): the linger after "One moment, please." dropped a split or disputed answer. */

test('a split answer ("Sam." "Miller.") during the linger after "One moment, please." joins up and verifies (review finding 12)', () => {
  const c = call("R12-split");
  toName(c);
  c.at(22_500);
  c.arrive("a3", "agent", "One moment, please.", 21_000, 22_000);
  c.at(24_100);
  c.arrive("c2", "caller", "Sam.", 23_000, 23_600);
  c.at(25_100);
  c.arrive("c3", "caller", "Miller.", 23_900, 24_600);
  assert.ok(c.held("c2") && c.held("c3"));
  c.at(25_600);
  c.checked("c2");
  c.at(26_600);
  c.checked("c3");
  c.at(28_000);
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().evidence?.key, "c3");
  assert.equal(c.name().heard, "Sam. Miller.");
  assert.equal(c.view().verification.verified, true);
});

test("a whole name the two models disagree on during the linger opens the read-back, never a failed attempt (review finding 12)", () => {
  const c = call("R12-disagree");
  toName(c);
  c.at(22_500);
  c.arrive("a3", "agent", "One moment, please.", 21_000, 22_000);
  c.at(24_100);
  c.arrive("c2", "caller", "Sam Miller.", 23_000, 23_600);
  assert.ok(c.held("c2"));
  assert.notEqual(c.name().state, "ok", "the fast model's words alone don't verify");
  c.at(25_600);
  c.checked("c2", "Sam Jones.");
  c.at(28_000);
  assert.equal(c.name().state, "confirm");
  assert.equal(c.name().confirmReason, "disagree");
  assert.equal(c.name().attempts, 0);
  assert.equal(c.view().nameEntry?.readBack, "available");
  assert.equal(c.view().verification.verified, false);
});

/* Finding 18: a read-back that says "name"/"address" moved the question past the answer still being checked. */

/** "Sam Miler." (checked, a sound-alike), then a second line of the same answer that is still being checked. */
function twoLineAnswer(c: C, rest: string) {
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(24_000);
  c.checked("c2");
  assert.equal(c.name().confirmReason, "sounds-like");
  c.at(25_000);
  c.arrive("c2b", "caller", rest, 23_000, 24_500);
  assert.ok(c.held("c2b"), "the rest of the answer goes to the second model");
}

for (const [rest, counts] of [
  ["No wait, it's Tom Baker.", false],
  ["M I L L E R.", true],
] as const)
  test(`"So your name is Sam Miller, right?" said while the rest of the answer is checked waits, and a Confirm press and an approval don't count early: "${rest}" (review finding 18)`, () => {
    const c = call(`R18-D-${rest}`);
    twoLineAnswer(c, rest);
    c.at(27_500);
    c.arrive("a3", "agent", "So your name is Sam Miller, right?", 25_000, 27_000);
    assert.equal(c.view().nameEntry?.readBack, "waiting");
    assert.match(c.view().prompts.find((p) => p.target === "name")!.text, /Your read-back counts once the rest of the caller's answer is checked/);
    c.at(27_800);
    c.s().confirm("name");
    assert.notEqual(c.name().state, "ok", "the press waits");
    c.at(28_000);
    c.s().confirm("order");
    c.at(28_200);
    c.s().approve();
    assert.equal(c.view().verification.verified, false);
    assert.notEqual(c.approval(), "approved");
    c.at(29_500);
    c.checked("c2b");
    assert.notEqual(c.approval(), "approved");
    assert.ok(!c.history().some((h) => h.at === c.T0 + 28_200 && h.counted), "the approval given while the press waited never counts");
    if (counts) {
      assert.equal(c.name().state, "ok");
      assert.equal(c.name().method, "confirmed by the agent");
      assert.equal(c.name().knownAt, c.T0 + 29_500, "counted when the check it waited for landed");
    } else {
      assert.equal(c.name().confirmReason, "ambiguous");
      assert.equal(c.view().verification.verified, false);
    }
  });

for (const [rest, counts] of [
  ["No wait, it's Tom Baker.", false],
  ["M I L L E R.", true],
] as const)
  test(`a Confirm press before the read-back isn't released by it while the rest of the answer is checked: "${rest}" (review finding 18)`, () => {
    const c = call(`R18-D3-${rest}`);
    twoLineAnswer(c, rest);
    c.at(26_000);
    c.s().confirm("name");
    assert.notEqual(c.name().state, "ok");
    c.at(27_200);
    c.arrive("a3", "agent", "So your name is Sam Miller, right?", 25_000, 27_000);
    assert.notEqual(c.name().state, "ok");
    c.at(28_000);
    c.checked("c2b");
    if (counts) {
      assert.equal(c.name().state, "ok");
      assert.equal(c.name().knownAt, c.T0 + 28_000, "never dated before it could first be shown");
    } else assert.equal(c.name().confirmReason, "ambiguous");
  });

test('"So the address is Hill Road, Dallas, right?" said while the rest of the address answer is checked: a Confirm press waits, and a correction is asked again (review finding 18)', () => {
  const c = call("R18-F");
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
  c.at(14_000);
  c.arrive("an", "agent", "Can I have your full name, please?", 11_500, 13_500);
  c.at(16_000);
  c.arrive("cn", "caller", "Sam Miller.", 14_000, 15_000);
  c.at(17_000);
  if (c.held("cn")) c.checked("cn");
  c.at(20_000);
  c.arrive("a2", "agent", "Thank you. And the street and city for the delivery?", 17_500, 19_500);
  c.at(22_000);
  c.arrive("c3", "caller", "Hill Rode, in Dalas.", 20_000, 21_500);
  c.at(22_500);
  if (c.held("c3")) c.checked("c3");
  assert.equal(c.address().confirmReason, "sounds-like");
  c.at(23_000);
  c.arrive("c3b", "caller", "No wait, it's Elm Street in Boston.", 21_800, 22_800);
  assert.ok(c.held("c3b"));
  c.at(25_000);
  c.arrive("a4", "agent", "So the address is Hill Road, Dallas, right?", 23_000, 24_800);
  assert.equal(c.view().addressEntry?.readBack, "waiting");
  c.at(25_300);
  c.s().confirm("address");
  assert.notEqual(c.address().state, "ok", "the press waits");
  assert.equal(c.view().verification.verified, false);
  c.at(27_000);
  c.checked("c3b");
  assert.equal(c.address().confirmReason, "ambiguous");
  assert.equal(c.view().verification.verified, false);
});

for (const [rest, counts] of [
  ["M I L L E R.", true],
  ["No wait, it's Tom Baker.", false],
] as const)
  test(`the caller's "Yes." to that read-back keeps it waiting, not a new name answer: "${rest}" (review finding 18)`, () => {
    const c = call(`R18-yes-${rest}`);
    twoLineAnswer(c, rest);
    c.at(27_500);
    c.arrive("a3", "agent", "So your name is Sam Miller, right?", 25_000, 27_000);
    c.at(28_200);
    c.arrive("c3", "caller", "Yes.", 27_300, 27_700);
    c.at(29_000);
    if (c.held("c3")) c.checked("c3");
    assert.equal(c.name().state, "confirm", "the sound-alike isn't lost");
    assert.equal(c.view().nameEntry?.readBack, "waiting");
    assert.equal(c.view().verification.verified, false);
    c.at(30_500);
    c.checked("c2b");
    if (counts) {
      assert.equal(c.name().state, "ok");
      assert.equal(c.name().method, "name read back by agent, confirmed by caller");
      assert.equal(c.name().knownAt, c.T0 + 30_500);
    } else {
      assert.equal(c.name().confirmReason, "ambiguous");
      assert.equal(c.view().verification.verified, false);
    }
  });

/* Finding 19: a held line that arrived after a press took the press back, and the approval was refused for good. */

for (const [label, agentLine, callerLine] of [
  ["after a hold line", "Thank you.", "You're welcome."],
  ["after a choice question", "And would you prefer a replacement or a refund?", "A replacement, please."],
  ["when the reply isn't held", "Let me pull up the order details now.", "You're welcome."],
] as const)
  test(`a caller line said before a Confirm press but arriving after it doesn't take the press or the approval back (${label}) (review finding 19)`, () => {
    const c = call(`R19-${label}`);
    toName(c);
    c.at(23_000);
    c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
    c.at(24_000);
    c.checked("c2");
    c.at(25_100);
    c.arrive("a3", "agent", agentLine, 24_500, 25_000);
    c.at(26_000);
    c.s().confirm("name");
    assert.equal(c.name().state, "ok");
    c.at(26_300);
    c.s().confirm("order");
    c.at(26_600);
    c.s().approve();
    assert.equal(c.approval(), "approved");
    c.at(27_200);
    c.arrive("c3", "caller", callerLine, 25_500, 27_000);
    assert.equal(c.approval(), "approved", "the panel doesn't take back what it showed");
    c.at(28_500);
    if (c.held("c3")) c.checked("c3");
    c.at(40_000);
    c.arrive("a9", "agent", "Okay.", 39_000, 39_500);
    assert.equal(c.name().state, "ok");
    assert.equal(c.name().knownAt, c.T0 + 26_000);
    assert.equal(c.approval(), "approved");
    assert.equal(c.view().recommendation?.staleApproval, undefined);
    assert.deepEqual(
      c.history().map((h) => ({ at: h.at - c.T0, counted: h.counted })),
      [{ at: 26_600, counted: true }],
    );
  });

test("a correction said before a Confirm press but arriving after it still withdraws the press and the approval (review finding 19)", () => {
  const c = call("R19-correction");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(24_000);
  c.checked("c2");
  c.at(25_100);
  c.arrive("a3", "agent", "Thank you.", 24_500, 25_000);
  c.at(26_000);
  c.s().confirm("name");
  c.at(26_300);
  c.s().confirm("order");
  c.at(26_600);
  c.s().approve();
  assert.equal(c.approval(), "approved");
  c.at(27_200);
  c.arrive("c3", "caller", "No wait, it's Tom Baker.", 25_500, 27_000);
  assert.ok(c.held("c3"));
  c.at(28_500);
  c.checked("c3");
  assert.equal(c.view().verification.verified, false);
  assert.notEqual(c.approval(), "approved");
  assert.notEqual(c.view().nameEntry?.readBack, "available");
  c.at(40_000);
  c.arrive("a9", "agent", "Okay.", 39_000, 39_500);
  assert.equal(c.name().confirmReason, "ambiguous");
  assert.equal(c.name().attempts, 0);
  assert.notEqual(c.approval(), "approved");
});

/* Finding 20: a read-back's two-line yes was dated before its second line was checked. */

test("a read-back yes in two lines counts when the second line is checked, and an approval before that doesn't count (review finding 20)", () => {
  const c = call("R20");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(25_000);
  c.checked("c2");
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
  c.at(28_900);
  c.arrive("c3", "caller", "Yes.", 28_000, 28_400);
  c.at(29_900);
  c.arrive("c3b", "caller", "That's right.", 28_800, 29_600);
  assert.ok(c.held("c3") && c.held("c3b"));
  c.at(30_500);
  c.checked("c3");
  assert.equal(c.view().verification.verified, false);
  assert.equal(c.view().nameEntry?.readBack, "waiting");
  c.at(31_200);
  c.s().approve();
  c.at(31_500);
  c.checked("c3b");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "name read back by agent, confirmed by caller");
  assert.equal(c.name().knownAt, c.T0 + 31_500, "not before the name could first be shown");
  assert.equal(c.view().verification.verifiedKnownAt, c.T0 + 31_500);
  const early = c.history().find((h) => h.at === c.T0 + 31_200);
  assert.equal(early?.counted, false);
  assert.match(early?.reason ?? "", IDENTITY_LATER);
  // Confirmed and approved after it: counts.
  c.at(32_000);
  c.s().confirm("order");
  c.at(32_500);
  c.s().approve();
  assert.equal(c.approval(), "approved");
  assert.ok(c.history().some((h) => h.at === c.T0 + 32_500 && h.counted));
});
