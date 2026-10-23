import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  The address read-back and the one repeat after "Sorry?" (his yes, 23 Oct), on the console's own clock: performance.now
  is replaced before the stores load, so arrival times, presses and check results move only when a test says so.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");
const { ADDRESS_READ_BACK, NAME_READ_BACK } = await import("@/lib/copilot/copilot");

function call(callId: string) {
  const T0 = epochNow();
  const probes: string[] = [];
  useLive.setState({ checkLine: (key, probe) => (probe && probes.push(key), "started") });
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
  const reheard = (key: string, text: string | null) => liveEvents.emit({ type: "line", line: { ...lines.get(key)!, reheard: { text, confidence: text === null ? null : 0.9, at: epochNow() } } });
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const address = () => view().verification.factors[1];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  /** A caller line that arrives, then (if held) gets its check `after` ms later. */
  const say = (key: string, text: string, start: number, end: number, after = 1500, checkedText?: string) => {
    at(end + 500);
    arrive(key, "caller", text, start, end);
    if (held(key)) {
      at(end + 500 + after);
      checked(key, checkedText);
    }
  };
  const agent = (key: string, text: string, start: number, end: number) => {
    at(end + 500);
    arrive(key, "agent", text, start, end);
  };
  return { T0, probes, at, arrive, checked, reheard, view, name, address, held, say, agent, s: () => useCopilot.getState() };
}

/** Greeting, the problem (checked), the name heard clearly, then the address question and an answer heard as a sound-alike. */
function toAddress(c: ReturnType<typeof call>) {
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miller.", 12_500, 13_500);
  assert.equal(c.name().state, "ok");
  c.agent("a3", "Thank you. And the street and city for the delivery?", 15_000, 17_000);
  c.say("c3", "Little road in Nalist.", 17_500, 19_000, 2000, "Hillwood in the alles.");
  assert.equal(c.address().state, "confirm");
  assert.equal(c.view().addressEntry?.readBack, "available");
}

test("the agent reads the street and city back and the caller's checked yes verifies the address, labelled as a read-back", () => {
  const c = call("AD-OK");
  toAddress(c);
  // The card says what to do without ever showing the order's address.
  const card = c.view().prompts.find((p) => p.target === "address")?.text ?? "";
  assert.match(card, /Say the street and city back as one question/);
  assert.doesNotMatch(card, /Hill Road|Dallas/);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  assert.equal(c.view().addressEntry?.readBack, "waiting");
  c.say("c4", "Yes.", 25_000, 25_400);
  assert.equal(c.address().state, "ok");
  assert.equal(c.address().method, ADDRESS_READ_BACK);
  assert.equal(c.view().verification.verified, true);
});

for (const said of ["So the address is Hill Road in Dallas, right?", "Hill Road, Dallas, Texas?", "Just to confirm, that's Hill Road in Dallas, is that correct?"])
  test(`these count as the address read-back: "${said}"`, () => {
    const c = call("AD-FORMS");
    toAddress(c);
    c.agent("a4", said, 22_000, 24_500);
    c.say("c4", "Yes, that's right.", 25_000, 25_800);
    assert.equal(c.address().method, ADDRESS_READ_BACK);
  });

for (const said of ["So that's Hill Street, Dallas, is that right?", "So that's Hill Road, is that right?", "That's not Hill Road, Dallas, is it?", "Is it Hill Road, Dallas, or Hill Road, Austin?"])
  test(`these don't: "${said}"`, () => {
    const c = call("AD-NOT");
    toAddress(c);
    c.agent("a4", said, 22_000, 24_500);
    c.say("c4", "Yes.", 25_000, 25_400);
    assert.notEqual(c.address().state, "ok");
  });

test("a reply that isn't a plain yes refuses the address read-back, and the Confirm button no longer counts", () => {
  const c = call("AD-NO");
  toAddress(c);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  c.say("c4", "No, that's wrong.", 25_000, 26_000);
  assert.equal(c.view().addressEntry?.readBack, "refused");
  c.at(30_000);
  c.s().confirm("address");
  assert.notEqual(c.address().state, "ok");
  assert.equal(c.view().verification.verified, false);
});

test("a Confirm press on the address waits while the caller's reply to the read-back is still being checked", () => {
  const c = call("AD-PRESS");
  toAddress(c);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  c.at(25_500);
  c.arrive("c4", "caller", "No.", 25_000, 25_300);
  assert.ok(c.held("c4"));
  c.at(25_800);
  c.s().confirm("address");
  assert.notEqual(c.address().state, "ok", "the reply may refuse it");
  c.at(27_500);
  c.checked("c4");
  assert.equal(c.view().addressEntry?.readBack, "refused");
  assert.notEqual(c.address().state, "ok");
});

test("no reply within 8 s: the address read-back expires, and a yes after that doesn't count", () => {
  const c = call("AD-EXPIRE");
  toAddress(c);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  assert.equal(typeof c.view().addressEntry?.readBackUntil, "number");
  c.at(33_000);
  c.s().confirm("issue"); // the store's expiry timer doesn't run in tests; any action re-runs the rules on the current clock
  assert.equal(c.view().addressEntry?.readBack, "expired");
  c.say("c4", "Yes.", 33_500, 33_900);
  assert.notEqual(c.address().state, "ok");
});

test("an address read-back said while the caller's answer is still being checked holds the reply from arrival", () => {
  const c = call("AD-EARLY");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miller.", 12_500, 13_500);
  c.agent("a3", "Thank you. And the street and city for the delivery?", 15_000, 17_000);
  c.at(19_500);
  c.arrive("c3", "caller", "Little road in Nalist.", 17_500, 19_000);
  assert.ok(c.held("c3"));
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 19_500, 21_500);
  c.at(22_600);
  c.arrive("c4", "caller", "Yes.", 22_000, 22_300);
  assert.ok(c.held("c4"), "held from arrival, so it never counts and then disappears");
  c.at(23_000);
  c.checked("c3", "Hillwood in the alles.");
  assert.notEqual(c.address().state, "ok");
  c.at(24_500);
  c.checked("c4");
  assert.equal(c.address().method, ADDRESS_READ_BACK);
});

test("the address read-back stays off when the build doesn't allow it, even with the name read-back on", async () => {
  const { analyze } = await import("@/lib/copilot/copilot");
  const { sunlake } = await import("./sunlake-data");
  const pack = { ...sunlake, policy: { ...sunlake.policy, addressReadBack: false } };
  const c = call("AD-OFF");
  toAddress(c);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  c.say("c4", "Yes.", 25_000, 25_400);
  const off = analyze(pack, c.s().lines, c.s().actions, epochNow());
  assert.notEqual(off.verification.factors[1].state, "ok");
  assert.equal(off.addressEntry?.readBack, undefined);
});

test("\"Sorry?\" after the name read-back allows it once more; the caller's yes to the repeat verifies the name", () => {
  const c = call("RP-NAME");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  assert.equal(c.name().confirmReason, "sounds-like");
  c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
  c.say("c3", "Sorry?", 17_500, 17_900);
  assert.equal(c.view().nameEntry?.readBack, "available");
  assert.equal(c.view().nameEntry?.readBackRepeat, true);
  assert.match(c.view().prompts.find((p) => p.target === "name")?.text ?? "", /asked to hear it again/);
  assert.equal(c.name().attempts, 0, "a \"Sorry?\" is never a failed attempt");
  c.at(20_000);
  c.s().confirm("name");
  assert.notEqual(c.name().state, "ok", "the caller hasn't confirmed anything, so the Confirm button doesn't count");
  c.agent("a4", "So it's Sam Miller, right?", 20_500, 22_000);
  c.say("c4", "Yes.", 22_500, 22_900);
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, NAME_READ_BACK);
});

test("only one repeat: a second \"Sorry?\" ends the read-back for the call", () => {
  const c = call("RP-TWICE");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
  c.say("c3", "Sorry?", 17_500, 17_900);
  c.agent("a4", "So it's Sam Miller, right?", 20_500, 22_000);
  c.say("c4", "Pardon?", 22_500, 22_900);
  assert.equal(c.view().nameEntry?.readBack, "refused");
  c.agent("a5", "So it's Sam Miller, right?", 25_000, 26_500);
  c.say("c5", "Yes.", 27_000, 27_400);
  assert.notEqual(c.name().state, "ok");
});

for (const reply of ["Sorry? No.", "Sorry, it's Sam Miller.", "What? Who is this?"])
  test(`a reply that does more than ask to hear it again refuses as before ("${reply}")`, () => {
    const c = call("RP-MORE");
    c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
    c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
    c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
    c.say("c2", "Sam Miler.", 12_500, 13_500);
    c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
    c.say("c3", reply, 17_500, 18_500);
    assert.notEqual(c.view().nameEntry?.readBackRepeat, true);
  });

test("a \"Sorry?\" followed by more of the same reply waits for that line's check before allowing the repeat", () => {
  const c = call("RP-WAIT");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
  c.say("c3", "Sorry?", 17_500, 17_900);
  c.at(20_200);
  c.arrive("c3b", "caller", "No, no.", 19_000, 19_400);
  assert.ok(c.held("c3b"));
  assert.notEqual(c.view().nameEntry?.readBackRepeat, true);
  c.at(21_000);
  c.checked("c3b");
  assert.equal(c.view().nameEntry?.readBack, "refused");
});

test("after \"Sorry?\", a repeat the fast model mishears is heard again by the second model", () => {
  const c = call("RP-PROBE");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
  c.say("c3", "Sorry?", 17_500, 17_900);
  c.agent("a4", "So it's Samuel Wright.", 20_500, 22_000);
  assert.ok(c.probes.includes("a4"));
  c.at(23_000);
  c.reheard("a4", "So it's Sam Miller, right?");
  c.say("c4", "Yes.", 23_200, 23_600);
  assert.equal(c.name().method, NAME_READ_BACK);
});

test("\"Sorry?\" after the address read-back allows it once more, too", () => {
  const c = call("RP-ADDR");
  toAddress(c);
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 22_000, 24_500);
  c.say("c4", "Sorry, can you say that again?", 25_000, 26_000);
  assert.equal(c.view().addressEntry?.readBackRepeat, true);
  assert.equal(c.address().attempts, 0);
  c.agent("a5", "Hill Road in Dallas, is that right?", 27_000, 28_500);
  c.say("c5", "Yes.", 29_000, 29_400);
  assert.equal(c.address().method, ADDRESS_READ_BACK);
});

/* Fixes from the independent review of 55b74f2 (23 Oct). */
function toName(c: ReturnType<typeof call>) {
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  assert.equal(c.name().confirmReason, "sounds-like");
}

for (const reply of ["Sorry, I didn't say that.", "What? I didn't say that.", "Sorry, that's not it.", "Sorry, say what?"])
  test(`a disputing reply refuses the read-back instead of allowing a repeat ("${reply}")`, () => {
    const c = call("RV-DISPUTE");
    toName(c);
    c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
    c.say("c3", reply, 17_500, 18_500);
    assert.notEqual(c.view().nameEntry?.readBackRepeat, true);
    c.agent("a4", "So it's Sam Miller, right?", 20_500, 22_000);
    c.say("c4", "Yes.", 22_500, 22_900);
    assert.notEqual(c.name().state, "ok");
  });

for (const reply of ["Pardon me?", "Can you say that again, please?", "I didn't catch that.", "Sorry, could you repeat it?", "Come again?"])
  test(`these ask to hear it again ("${reply}")`, () => {
    const c = call("RV-AGAIN");
    toName(c);
    c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
    c.say("c3", reply, 17_500, 18_500);
    assert.equal(c.view().nameEntry?.readBackRepeat, true);
  });

for (const [what, result] of [
  ["whose check failed", { checkFailed: true }],
  ["heard with low confidence", { checked: true, confidence: 0.2 }],
] as const)
  test(`a "Sorry?" ${what} refuses the read-back as before, and a later yes doesn't count`, () => {
    const c = call("RV-UNCLEAR");
    toName(c);
    c.agent("a3", "So it's Sam Miller, right?", 15_000, 17_000);
    c.at(18_400);
    c.arrive("c3", "caller", "Sorry?", 17_500, 17_900);
    liveEvents.emit({ type: "line", line: { ...c.s().lines.find((l) => l.key === "c3")!, checking: undefined, ...result } as TranscriptEvent });
    assert.notEqual(c.view().nameEntry?.readBackRepeat, true);
    assert.equal(c.view().nameEntry?.readBack, "refused");
    c.agent("a4", "So it's Sam Miller, right?", 20_500, 22_000);
    c.say("c4", "Yes.", 22_500, 22_900);
    assert.notEqual(c.name().state, "ok");
  });

test("an address read-back waiting before the name is verified still tells the store when it runs out", () => {
  const c = call("RV-ADDRFIRST");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a3", "Can I have the street and city for the delivery?", 10_000, 12_000);
  c.say("c3", "Little road in Nalist.", 12_500, 14_000, 2000, "Hillwood in the alles.");
  c.agent("a4", "So that's Hill Road, Dallas, is that right?", 17_000, 19_000);
  assert.equal(c.view().addressEntry, null, "no address field until the name is verified");
  assert.equal(c.view().readBackUntil, c.T0 + 19_000 + 8000);
});

test("while the caller's reply to the name read-back is being checked, the address read-back isn't offered yet", () => {
  const c = call("RV-BUSY");
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "Can I have the street and city for the delivery?", 10_000, 12_000);
  c.say("c2", "Little road in Nalist.", 12_500, 14_000, 2000, "Hillwood in the alles.");
  c.agent("a3", "And your full name, please?", 17_000, 18_500);
  c.say("c3", "Sam Miler.", 19_000, 20_000);
  c.agent("a4", "So it's Sam Miller, right?", 21_000, 22_500);
  c.at(23_500);
  c.arrive("c4", "caller", "Yes.", 23_000, 23_300);
  assert.ok(c.held("c4"));
  assert.notEqual(c.view().verification.factors[1].state, "ok");
  const offered = c.view().prompts.find((p) => p.target === "address")?.text ?? "";
  assert.doesNotMatch(offered, /Say the street and city back/);
});
