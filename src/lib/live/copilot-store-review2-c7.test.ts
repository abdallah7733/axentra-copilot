import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  Second independent review of C7 (23 Oct), timing findings, on a simulated clock. An approval that counted stays
  counted when a later line of the same answer is checked and changes nothing. Spelling the same name while the
  question lingers is not a second name. A caller line after the 8 s window is not a reply to the read-back, so the
  one more read-back the card offers still counts. An exact name's tick stays while a harmless later line is checked.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
const { useCopilot, pack } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");
const { analyze } = await import("@/lib/copilot/copilot");

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
  const checked = (key: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, checked: true, availableAt: epochNow() } });
  };
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  return { T0, at, arrive, checked, view, name, held, s: () => useCopilot.getState() };
}
type C = ReturnType<typeof call>;
const approval = (c: C) => c.view().recommendation?.approval.state;

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
  assert.equal(c.view().verification.factors[1].state, "ok");
  c.at(21_000);
  c.arrive("a2", "agent", "Thank you. And your full name, please?", 18_500, 20_500);
}

/** The name asked first, before the address. */
function toNameFirst(c: C) {
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
  c.at(14_000);
  c.arrive("a2", "agent", "First, can I have your full name, please?", 11_500, 13_500);
}

/** "Sam Miler." heard and checked: a sound-alike, so Confirm and the read-back are open. */
function soundAlike(c: C) {
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(24_000);
  c.checked("c2");
}

test("a panel approval after a Confirm press stays counted when the caller's spelling of the same name is checked later (review 2, timing 1)", () => {
  const c = call("t1a");
  soundAlike(c);
  c.at(25_000);
  c.s().confirm("name");
  c.at(25_500);
  c.s().confirm("order");
  c.at(26_000);
  c.s().approve();
  assert.equal(approval(c), "approved");
  c.at(26_800);
  c.arrive("c2b", "caller", "M I L L E R.", 24_200, 26_400);
  assert.ok(c.held("c2b"));
  assert.equal(c.name().state, "ok");
  c.at(28_000);
  c.checked("c2b");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().knownAt, c.T0 + 25_000, "a line that arrived after the press doesn't re-date it");
  assert.equal(approval(c), "approved");
});

test("a spoken approval after a Confirm press stays counted when a later line of the same answer is checked (review 2, timing 1)", () => {
  const c = call("t1b");
  soundAlike(c);
  c.at(24_200);
  c.s().confirm("name");
  c.at(24_400);
  c.s().confirm("order");
  c.at(25_600);
  c.arrive("c2b", "caller", "M I L L E R.", 23_000, 25_200);
  assert.equal(c.name().state, "ok");
  c.at(27_200);
  c.arrive("a3", "agent", "Thank you, Sam. Done, the new tablet ships today.", 25_400, 27_000);
  assert.equal(approval(c), "approved");
  c.at(27_400);
  c.checked("c2b");
  assert.equal(approval(c), "approved");
});

test("an approval after a read-back's checked yes stays counted when the rest of the reply arrives later (review 2, timing 1)", () => {
  const c = call("t1c");
  soundAlike(c);
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
  c.at(28_900);
  c.arrive("c3", "caller", "Yes.", 28_000, 28_400);
  c.at(29_500);
  c.checked("c3");
  assert.equal(c.view().verification.verified, true);
  c.at(29_800);
  c.s().confirm("order");
  c.at(30_000);
  c.s().approve();
  assert.equal(approval(c), "approved");
  c.at(30_600);
  c.arrive("c3b", "caller", "That's right.", 29_000, 30_200);
  c.at(31_500);
  c.checked("c3b");
  assert.equal(c.view().verification.verified, true);
  assert.equal(approval(c), "approved");
});

test("a correction that arrives after a Confirm press still withdraws it, and the approval given before it stays refused (review 2, timing 1 control)", () => {
  const c = call("t1x");
  soundAlike(c);
  c.at(25_000);
  c.s().confirm("name");
  c.at(25_500);
  c.s().confirm("order");
  c.at(26_000);
  c.s().approve();
  c.at(26_800);
  c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 24_200, 26_400);
  c.at(28_000);
  c.checked("c2b");
  assert.notEqual(c.name().state, "ok");
  assert.notEqual(approval(c), "approved");
});

for (const hold of ["One moment, please.", "Okay."])
  for (const said of ["It's Miller with two Ls.", "Miller, M I L L E R.", "That's Miller, double L."])
    test(`spelling the same name while the question lingers keeps the sound-alike and the read-back: "${hold}" then "${said}" (review 2, timing 3)`, () => {
      const c = call(hold + said);
      toNameFirst(c);
      c.at(16_000);
      c.arrive("c2", "caller", "Sam Miler.", 14_500, 15_500);
      c.at(17_000);
      if (c.held("c2")) c.checked("c2");
      c.at(19_000);
      c.arrive("a3", "agent", hold, 17_500, 18_500);
      c.at(21_500);
      c.arrive("c3", "caller", said, 19_500, 21_000);
      c.at(22_500);
      if (c.held("c3")) c.checked("c3");
      c.at(25_000);
      c.arrive("a4", "agent", "Okay.", 24_000, 24_400);
      assert.notEqual(c.name().confirmReason, "ambiguous");
      assert.equal(c.view().nameEntry?.readBack, "available");
    });

test("a different name while the question lingers is still a conflict (review 2, timing 3 control)", () => {
  const c = call("t3x");
  toNameFirst(c);
  c.at(16_000);
  c.arrive("c2", "caller", "Sam Miler.", 14_500, 15_500);
  c.at(17_000);
  if (c.held("c2")) c.checked("c2");
  c.at(19_000);
  c.arrive("a3", "agent", "One moment, please.", 17_500, 18_500);
  c.at(21_500);
  c.arrive("c3", "caller", "Sorry, it's Tom Baker.", 19_500, 21_000);
  c.at(22_500);
  if (c.held("c3")) c.checked("c3");
  assert.notEqual(c.view().nameEntry?.readBack, "available");
  assert.notEqual(c.name().state, "ok");
});

for (const late of ["Yes.", "Sorry?", "Hello?"])
  test(`a caller's "${late}" after the 8 s window isn't a reply, so the one more read-back the card offers still counts (review 2, timing 4)`, () => {
    const c = call(`t4${late}`);
    soundAlike(c);
    c.at(28_000);
    c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
    c.at(35_600);
    const st = c.s();
    assert.match(analyze(pack, st.lines, st.actions, epochNow()).prompts.find((p) => p.target === "name")!.text, /Say it back once more/);
    c.at(37_000);
    c.arrive("c3", "caller", late, 36_000, 36_600);
    c.at(38_000);
    if (c.held("c3")) c.checked("c3");
    assert.notEqual(c.name().state, "ok", "the late line verifies nothing");
    c.at(41_000);
    c.arrive("a4", "agent", "So it's Sam Miller, right?", 38_500, 40_500);
    c.at(42_000);
    c.arrive("c4", "caller", "Yes.", 41_000, 41_400);
    c.at(43_000);
    if (c.held("c4")) c.checked("c4");
    assert.equal(c.view().verification.verified, true);
  });

for (const [late, why] of [["No, it's Tom Baker.", "a different name"], ["Sam Miller.", "the agent's words repeated"]])
  test(`after the 8 s window, "${late}" is still heard: ${why} doesn't verify (review 2, timing 4 control)`, () => {
    const c = call(`t4y${late}`);
    soundAlike(c);
    c.at(28_000);
    c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
    c.at(37_000);
    c.arrive("c3", "caller", late, 36_000, 37_000);
    c.at(38_000);
    if (c.held("c3")) c.checked("c3");
    assert.notEqual(c.name().state, "ok");
    assert.ok(c.name().state !== "confirm" || c.name().confirmReason !== "sounds-like", "the answer isn't left as a plain sound-alike");
    assert.notEqual(c.view().nameEntry?.readBack, "available");
  });

test("after the second read-back, a third doesn't count however the window ended (review 2, timing 4 control)", () => {
  const c = call("t4x");
  soundAlike(c);
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
  c.at(37_000);
  c.arrive("c3", "caller", "Hello?", 36_000, 36_600);
  c.at(41_000);
  c.arrive("a4", "agent", "So it's Sam Miller, right?", 38_500, 40_500);
  c.at(52_000);
  c.arrive("a5", "agent", "So it's Sam Miller, right?", 49_500, 51_500);
  c.at(53_000);
  c.arrive("c5", "caller", "Yes.", 52_000, 52_400);
  c.at(54_000);
  if (c.held("c5")) c.checked("c5");
  assert.notEqual(c.name().state, "ok");
});

test("an exact name's tick and the approval stay while a harmless later line of the same answer is checked (review 2, timing 5)", () => {
  const c = call("t5");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(24_000);
  if (c.held("c2")) c.checked("c2");
  c.at(24_300);
  c.s().confirm("order");
  c.at(24_600);
  c.s().approve();
  assert.equal(approval(c), "approved");
  c.at(25_100);
  c.arrive("c2b", "caller", "M I L L E R.", 22_800, 24_700);
  assert.ok(c.held("c2b"));
  const during = { state: c.name().state, approval: approval(c) ?? "-" };
  c.at(26_300);
  c.checked("c2b");
  assert.deepEqual(during, { state: "ok", approval: "approved" });
  assert.equal(approval(c), "approved");
});

for (const how of ["slow check", "check timed out"] as const)
  test(`an approval on the answer to a re-ask stands when an earlier correction's check lands after it (${how}) (third check)`, () => {
    const c = call(`s2${how}`);
    toName(c);
    c.at(23_000);
    c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
    c.at(23_500);
    if (c.held("c2")) c.checked("c2");
    c.at(24_600);
    c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 22_900, 24_200);
    assert.ok(c.held("c2b"));
    c.at(26_300);
    c.arrive("a3", "agent", "Sorry, could I have your full name again?", 24_600, 26_000);
    c.at(27_800);
    c.arrive("c3", "caller", "Sam Miller.", 26_500, 27_400);
    c.at(28_800);
    if (c.held("c3")) c.checked("c3");
    c.at(29_000);
    c.s().confirm("order");
    c.at(29_300);
    c.s().approve();
    assert.equal(approval(c), "approved");
    if (how === "slow check") {
      c.at(30_000);
      c.checked("c2b");
    } else {
      c.at(33_600);
      const l = c.s().lines.find((x) => x.key === "c2b")!;
      liveEvents.emit({ type: "line", line: { ...l, checking: undefined, heldAt: undefined, first: undefined, checkFailed: true, availableAt: epochNow() } });
    }
    c.at(45_000);
    assert.equal(c.view().verification.verified, true);
    assert.equal(approval(c), "approved");
  });

test("an approval given before a correction of the answer it relied on still doesn't count after a re-ask (third check control)", () => {
  const c = call("s2x");
  soundAlike(c);
  c.at(24_100);
  c.s().confirm("name");
  c.at(24_200);
  c.s().confirm("order");
  c.at(24_300);
  c.s().approve();
  c.at(26_000);
  c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 24_400, 25_600);
  c.at(27_300);
  if (c.held("c2b")) c.checked("c2b");
  c.at(29_300);
  c.arrive("a3", "agent", "Sorry, could I have your full name again?", 27_500, 29_000);
  c.at(30_800);
  c.arrive("c3", "caller", "Sam Miller.", 29_500, 30_400);
  c.at(31_800);
  if (c.held("c3")) c.checked("c3");
  c.at(40_000);
  assert.equal(c.view().verification.verified, true);
  assert.notEqual(approval(c), "approved");
});

for (const [rest, counts] of [["Great, thank you so much.", true], ["Thanks.", true], ["Actually, that's not my name.", false]] as const)
  test(`"${rest}" after a read-back's yes and an approval ${counts ? "doesn't take" : "takes"} the approval back (third check)`, () => {
    const c = call(`s4${rest}`);
    soundAlike(c);
    c.at(27_800);
    c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_000, 27_500);
    c.at(28_600);
    c.arrive("c3", "caller", "Yes.", 27_800, 28_200);
    c.at(29_500);
    if (c.held("c3")) c.checked("c3");
    c.at(30_200);
    c.s().confirm("order");
    c.at(30_600);
    c.s().approve();
    assert.equal(approval(c), "approved");
    c.at(32_300);
    c.arrive("c4", "caller", rest, 31_000, 32_000);
    c.at(33_500);
    if (c.held("c4")) c.checked("c4");
    c.at(45_000);
    assert.equal(c.view().verification.verified, counts);
    assert.equal(approval(c) === "approved", counts);
  });
