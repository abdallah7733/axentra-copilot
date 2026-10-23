import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  The name read-back on the console's own clock (third review, 23 Oct): performance.now is replaced before the stores
  load, so epochNow() (arrival times, presses, check results) moves only when a test says so. Each line has real speech
  times and arrives when the test says; checks finish when the test delivers them, the way the live store sends them.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");

function call(callId: string) {
  const T0 = epochNow();
  const asked: string[] = [];
  const probes: string[] = [];
  useLive.setState({ checkLine: (key, probe) => (asked.push(key), probe && probes.push(key), "started") });
  liveEvents.emit({ type: "call-started", callId, at: T0 });
  let seq = 0;
  const lines = new Map<string, TranscriptEvent>();
  /** Moves the console clock to T0 + t. */
  const at = (t: number) => {
    assert.ok(T0 + t >= epochNow(), "the clock only moves forward");
    mono += T0 + t - epochNow();
  };
  /** A line spoken from `start` to `end` (ms after T0), arriving now. */
  const arrive = (key: string, side: "caller" | "agent", text: string, start: number, end: number) => {
    const l: TranscriptEvent = { callId, seq: ++seq, key, side, text, startedAt: T0 + start, endedAt: T0 + end, final: true, confidence: 0.9, availableAt: epochNow() };
    lines.set(key, l);
    liveEvents.emit({ type: "line", line: l });
  };
  /** The second model's check of a held line lands now. */
  const checked = (key: string, text?: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, text: text ?? l.text, ...(text && text !== l.text ? { firstHeard: l.text } : {}), checked: true, availableAt: epochNow() } });
  };
  /** The second hearing of an agent line lands now: the fast text stays, what the second model heard goes beside it. */
  const reheard = (key: string, text: string | null) => liveEvents.emit({ type: "line", line: { ...lines.get(key)!, reheard: { text, confidence: text === null ? null : 0.9, at: epochNow() } } });
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  return { T0, asked, probes, at, arrive, checked, reheard, view, name, held, s: () => useCopilot.getState() };
}

/** Greeting, the problem with the customer's choice (checked), the address (checked), then the name: "Sam Miler.", which only sounds like the record. */
function opening(c: ReturnType<typeof call>, addressFirst = true) {
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
  if (addressFirst) {
    c.at(14_000);
    c.arrive("ax", "agent", "First, can I have the street and city for the delivery?", 11_500, 13_500);
    c.at(16_500);
    c.arrive("cx", "caller", "Hill Road, in Dallas.", 14_500, 16_000);
    c.at(18_000);
    if (c.held("cx")) c.checked("cx");
  }
  c.at(21_000);
  c.arrive("a2", "agent", addressFirst ? "Thank you. And your full name, please?" : "First, can I have your full name, please?", 18_500, 20_500);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(25_000);
  if (c.held("c2")) c.checked("c2");
  assert.equal(c.name().confirmReason, "sounds-like");
}

test("an approval said while a name press waits for the caller's reply doesn't count once that reply's check lands", () => {
  const c = call("CA-T2");
  opening(c);
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Samuel Wright.", 25_500, 27_500);
  assert.ok(c.probes.includes("a3"));
  c.at(29_400);
  c.arrive("c3", "caller", "Yes.", 28_200, 28_700);
  assert.ok(c.held("c3"));
  c.at(29_600);
  c.s().confirm("name");
  assert.equal(c.name().state, "confirm", "the press waits for the reply");
  c.at(31_000);
  c.reheard("a3", "So it's Sam Miller, right?");
  c.at(32_600);
  c.arrive("a4", "agent", "And that's the tablet on order 427, is that right?", 29_800, 32_000);
  c.at(34_600);
  c.arrive("a5", "agent", "Perfect, the new tablet ships today.", 32_200, 34_000);
  assert.equal(c.view().verification.verified, false, "on screen, the identity wasn't verified when the agent committed");
  c.at(35_200);
  c.checked("c3");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "name read back by agent, confirmed by caller");
  // Before, the pass that rebuilt 34.0 s left the reply out altogether, so the held press counted there.
  assert.notEqual(c.view().recommendation?.approval.state, "approved");
});

test("a name press that waited for a second hearing is dated when it counted, not when it was made", () => {
  const c = call("CA-KNOWN");
  opening(c);
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Samuel Wright.", 25_500, 27_500);
  c.at(29_400);
  c.arrive("c3", "caller", "Yes.", 28_200, 28_700);
  c.at(29_600);
  c.s().confirm("name");
  c.at(30_500);
  c.checked("c3");
  c.at(31_000);
  // The second model heard the same words: it wasn't a read-back, so the press counts from now.
  c.reheard("a3", "So it's Samuel Wright.");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "confirmed by the agent");
  assert.equal(c.name().knownAt, c.T0 + 31_000);
});

test("a read-back nobody answered doesn't hold the name press while the answer to the next question is checked", () => {
  const c = call("CA-T3");
  opening(c, false);
  c.at(28_000);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 25_500, 27_500);
  c.at(30_000);
  c.arrive("a4", "agent", "And the street and city for the delivery?", 28_000, 29_500);
  c.at(32_000);
  c.arrive("c4", "caller", "Hill Road, in Dallas.", 30_000, 31_500);
  assert.ok(c.held("c4"));
  c.at(32_500);
  c.s().confirm("name");
  assert.equal(c.name().state, "ok", "the address answer isn't a reply to the read-back");
  assert.equal(c.name().knownAt, c.T0 + 32_500);
});

for (const reply of ["Yes.", "Sorry?"])
  test(`a reply that talks over the end of the read-back holds the name press until its check ("${reply}")`, () => {
    const c = call("CA-OVERLAP");
    opening(c);
    c.at(28_800);
    c.arrive("c3", "caller", reply, 26_900, 28_300);
    c.at(29_000);
    c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
    c.at(29_500);
    c.s().confirm("name");
    assert.notEqual(c.name().state, "ok");
    assert.equal(c.view().verification.verified, false);
    c.at(31_500);
    if (c.held("c3")) c.checked("c3");
    // It started 600 ms before the question ended, so it never confirms the read-back, and the press can't count instead.
    assert.equal(c.view().nameEntry?.readBack, "refused");
    assert.equal(c.view().verification.verified, false);
  });

test("a later line of the same reply, long after the read-back, still holds the name press until its check", () => {
  const c = call("CA-LATE");
  opening(c);
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_500, 27_500);
  c.at(29_000);
  c.arrive("c3", "caller", "Yes.", 28_000, 28_400);
  c.at(31_000);
  c.checked("c3");
  c.at(36_800);
  c.arrive("c4", "caller", "Hmm, well, no, not quite.", 35_600, 36_200);
  assert.ok(c.held("c4"));
  c.at(37_500);
  c.s().confirm("name");
  assert.notEqual(c.name().state, "ok", "the rest of the reply is still being checked");
  c.at(39_500);
  c.checked("c4");
  assert.equal(c.view().nameEntry?.readBack, "refused");
  assert.notEqual(c.name().state, "ok");
});

test("a read-back said while the name answer is still being checked: the caller's reply waits for its check from the start", () => {
  const c = call("CA-EARLY");
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
  c.at(14_000);
  c.arrive("a2", "agent", "First, can I have your full name, please?", 11_500, 13_500);
  c.at(16_000);
  c.arrive("c2", "caller", "Sam Miler.", 14_500, 15_500);
  assert.ok(c.held("c2"));
  c.at(18_600);
  c.arrive("a3", "agent", "So it's Samuel Wright.", 16_000, 18_000);
  c.at(20_000);
  c.arrive("c3", "caller", "Yes, Sam Miller.", 18_200, 19_400);
  assert.ok(c.held("c3"), "held from arrival, so it never counts and then disappears");
  const seen: boolean[] = [c.view().verification.factors[0].state === "ok"];
  c.at(20_500);
  c.checked("c2");
  seen.push(c.name().state === "ok");
  c.at(23_000);
  if (c.probes.includes("a3")) c.reheard("a3", "So it's Sam Miller, right?");
  seen.push(c.name().state === "ok");
  c.at(25_500);
  c.checked("c3");
  seen.push(c.name().state === "ok");
  assert.deepEqual(seen, [false, false, false, true], "accepted once, after the reply's check, and never taken back");
});

test("no second hearing once the name is accepted: a reply that already counted isn't reopened", () => {
  const c = call("CA-ACCEPTED");
  opening(c);
  c.at(27_000);
  c.arrive("a3", "agent", "Okay, thank you.", 25_200, 26_400);
  // The two sides are transcribed separately: the caller's line arrives before the agent's line said just before it.
  c.at(30_000);
  c.arrive("c3", "caller", "Sam Miller.", 28_800, 29_600);
  c.at(30_100);
  if (c.held("c3")) c.checked("c3");
  assert.equal(c.name().state, "ok");
  c.at(30_500);
  c.arrive("a4", "agent", "So it's Samuel Wright.", 26_600, 28_600);
  assert.ok(!c.probes.includes("a4"));
  assert.equal(c.name().state, "ok");
});

test("pressing Confirm on the problem doesn't stop a misheard read-back from being heard again", () => {
  const c = call("CA-ISSUE");
  opening(c, false);
  c.at(27_400);
  c.s().confirm("issue");
  c.at(28_000);
  c.arrive("a3", "agent", "So it's Samuel Wright.", 25_500, 27_200);
  assert.ok(c.probes.includes("a3"));
  assert.equal(c.view().nameEntry?.readBackProbe, true, "the field says it is checking the agent's line");
  c.at(29_400);
  c.arrive("c3", "caller", "Yes.", 28_200, 28_700);
  c.at(30_500);
  c.reheard("a3", "So it's Sam Miller, right?");
  assert.equal(c.view().nameEntry?.readBackProbe, undefined);
  c.at(31_500);
  c.checked("c3");
  assert.equal(c.name().method, "name read back by agent, confirmed by caller");
});
