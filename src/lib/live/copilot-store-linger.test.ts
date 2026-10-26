import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  Outside review of C6, Amendment 2 (23 Oct): an agent line that only holds or acknowledges ("One moment.", "Okay.",
  "Thank you.") used to end the name or address question, so the caller's repeat wasn't held for the second model's
  check: a clear repeat verified on the fast model's words alone, and a misheard one was ignored. The question now
  lingers over such lines for LINGER_MS, hearing only lines that say a part of the detail, and never counting a wrong
  answer from them.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
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
  const say = (key: string, text: string, start: number, end: number, after = 1500, checkedText?: string) => {
    at(end + 500);
    arrive(key, "caller", text, start, end);
    const wasHeld = held(key);
    if (wasHeld) {
      at(end + 500 + after);
      checked(key, checkedText);
    }
    return wasHeld;
  };
  const agent = (key: string, text: string, start: number, end: number) => {
    at(end + 500);
    arrive(key, "agent", text, start, end);
  };
  const f = (x: { state: string; method?: string; confirmReason?: string; attempts: number; evidence?: { key: string } }) =>
    `${x.state}${x.confirmReason ? `/${x.confirmReason}` : ""} method=${x.method ?? "-"} attempts=${x.attempts} ev=${x.evidence?.key ?? "-"}`;
  const log = (label: string) =>
    console.log(`  [${callId}] ${label.padEnd(34)} awaiting=${String(view().awaiting).padEnd(7)} name=${f(name())} | address=${f(address())} | verified=${view().verification.verified}`);
  return { T0, asked, probes, at, arrive, checked, reheard, view, name, address, held, say, agent, log, s: () => useCopilot.getState() };
}
type C = ReturnType<typeof call>;

/** Greeting, the problem (with the customer's choice, checked), the address first (checked), then the name question. */
function toName(c: C) {
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.agent("ax", "First, can I have the street and city for the delivery?", 11_500, 13_500);
  c.say("cx", "Hill Road, in Dallas.", 14_500, 16_000);
  assert.equal(c.address().state, "ok");
  c.agent("a2", "Thank you. And your full name, please?", 18_500, 20_500);
}

/** Greeting, problem, the name heard clearly, then the address question. */
function toAddress(c: C) {
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miller.", 12_500, 13_500);
  assert.equal(c.name().state, "ok");
  c.agent("a3", "Thank you. And the street and city for the delivery?", 15_000, 17_000);
}

/*
  What the proposed fix should give (run against the prototype in verify/proto; fails at HEAD 7af35fd for the linger cases).
*/
for (const filler of ["One moment.", "Okay.", "Thank you.", "Let me check that."])
  test(`(a) name: sound-alike -> "${filler}" -> "Sam Miller." is held, checked, and verifies`, () => {
    const c = call(`FA-${filler}`);
    toName(c);
    c.say("c2", "Sam Miler.", 21_500, 22_500);
    c.agent("a3", filler, 25_500, 26_500);
    assert.equal(c.view().awaiting, "name");
    c.at(29_000);
    c.arrive("c3", "caller", "Sam Miller.", 27_500, 28_500);
    assert.ok(c.held("c3"));
    assert.notEqual(c.name().state, "ok", "nothing counts before the check");
    c.at(30_500);
    c.checked("c3");
    c.log("c3 checked");
    assert.equal(c.name().state, "ok");
    assert.equal(c.name().evidence?.key, "c3");
    assert.equal(c.name().knownAt, c.T0 + 30_500);
  });

test("(a2) the repeat misheard again by the fast model is corrected by the check", () => {
  const c = call("FA2");
  toName(c);
  c.say("c2", "Sam Miler.", 21_500, 22_500);
  c.agent("a3", "One moment.", 25_500, 26_500);
  assert.equal(c.say("c3", "Sam Miler.", 27_500, 28_500, 1500, "Sam Miller."), true);
  c.log("c3 checked as Sam Miller.");
  assert.equal(c.name().state, "ok");
});

test('(b) "John Smith." (failed 1) -> "Okay." -> "Sam Millerius." is held and heard as a sound-alike', () => {
  const c = call("FB");
  toName(c);
  c.say("c2", "John Smith.", 21_500, 22_500);
  c.at(25_000);
  c.agent("a3", "Okay.", 25_500, 26_000);
  assert.equal(c.say("c3", "Sam Millerius.", 27_000, 28_000), true);
  c.at(31_000);
  c.log("c3 checked + settle");
  assert.equal(c.name().state, "confirm");
  assert.equal(c.name().confirmReason, "sounds-like");
  assert.equal(c.name().attempts, 1);
});

test('(c) address: sound-alike -> "Thank you." -> "Hill Road in Dallas." is held, checked, and verifies', () => {
  const c = call("FC");
  toAddress(c);
  c.say("c3", "Little road in Nalist.", 17_500, 19_000, 2000, "Hillwood in the alles.");
  c.agent("a4", "Thank you.", 22_000, 22_800);
  assert.equal(c.view().awaiting, "address");
  assert.equal(c.say("c4", "Hill Road in Dallas.", 23_500, 25_000), true);
  c.log("c4 checked");
  assert.equal(c.address().state, "ok");
  assert.equal(c.address().evidence?.key, "c4");
});

test('(c3) address: wrong first (failed 1) -> "Okay." -> "Hill Rode in Dallas." heard as a sound-alike', () => {
  const c = call("FC3");
  toAddress(c);
  c.say("c3", "Hill Street in Boston.", 17_500, 19_000);
  c.at(21_500);
  c.agent("a4", "Okay.", 22_000, 22_500);
  assert.equal(c.say("c4", "Hill Rode in Dallas.", 23_500, 25_000), true);
  c.at(28_000);
  c.log("c4 checked + settle");
  assert.equal(c.address().state, "confirm");
  assert.equal(c.address().attempts, 1);
});

/* Unrelated caller speech while the question merely lingers: never a failed attempt, never a downgrade. */
for (const said of ["Yes.", "I'd like a refund instead."])
  test(`(h) name: sound-alike -> "One moment." -> "${said}" changes nothing`, () => {
    const c = call(`FH-${said}`);
    toName(c);
    c.say("c2", "Sam Miler.", 21_500, 22_500);
    c.agent("a3", "One moment.", 25_500, 26_500);
    c.say("c3", said, 27_500, 28_500);
    c.at(32_000);
    c.log(`after "${said}" + settle`);
    assert.equal(c.name().state, "confirm");
    assert.equal(c.name().confirmReason, "sounds-like");
    assert.equal(c.name().evidence?.key, "c2");
    assert.equal(c.name().attempts, 0);
    assert.equal(c.view().nameEntry?.readBack, "available", "the read-back stays available");
  });

/*
  A different name while the question lingers is a genuinely conflicting answer: asked again, with no read-back and no
  Confirm, and still never a failed attempt (independent review of C7, 23 Oct: it used to be dropped, so the read-back
  of the earlier sound-alike still counted).
*/
for (const said of ["John Smith.", "Sam Smith.", "Sam Miller or John Smith.", "Actually it's Tom Baker."])
  test(`(h) name: sound-alike -> "One moment." -> "${said}" is asked again, not a failed attempt`, () => {
    const c = call(`FHC-${said}`);
    toName(c);
    c.say("c2", "Sam Miler.", 21_500, 22_500);
    c.agent("a3", "One moment.", 25_500, 26_500);
    c.say("c3", said, 27_500, 28_500);
    c.at(32_000);
    c.log(`after "${said}" + settle`);
    assert.equal(c.name().state, "confirm");
    assert.equal(c.name().confirmReason, "ambiguous");
    assert.equal(c.name().attempts, 0);
    assert.notEqual(c.view().nameEntry?.readBack, "available", "no read-back after a conflicting answer");
  });

test('(h2) name asked, "One moment." before any answer, then a wrong answer: not a failed attempt', () => {
  const c = call("FH2");
  toName(c);
  c.agent("a3", "Sorry, one moment.", 21_000, 22_000);
  c.say("c2", "Sam Smith.", 22_500, 23_500);
  c.at(27_000);
  c.log("after Sam Smith + settle");
  assert.equal(c.name().attempts, 0);
  assert.notEqual(c.name().state, "failed");
});

for (const q of ["Is that with one L?", "Could you repeat that?", "And what's the order number?"])
  test(`(d) any question ends it: sound-alike -> "One moment." -> "${q}" -> "Yes."/"Sam Miller." aren't held for the name`, () => {
    const c = call(`FD-${q}`);
    toName(c);
    c.say("c2", "Sam Miler.", 21_500, 22_500);
    c.agent("a3", "One moment.", 25_500, 26_500);
    c.agent("a4", q, 27_000, 28_500);
    const h = c.say("c3", "Yes.", 29_000, 29_400);
    c.at(33_000);
    c.log(`"Yes." held=${h}`);
    assert.notEqual(c.name().state, "ok");
    assert.equal(c.name().attempts, 0);
  });

test("(i) lingering ends LINGER_MS after the hold line: a repeat 12 s later isn't held", () => {
  const c = call("FI");
  toName(c);
  c.say("c2", "Sam Miler.", 21_500, 22_500);
  c.agent("a3", "One moment.", 25_500, 26_500);
  c.at(39_000);
  c.arrive("c3", "caller", "Sam Miller.", 38_000, 38_800);
  c.log(`c3 held=${c.held("c3")}`);
  assert.equal(c.held("c3"), false);
});

test("(f) a read-back after \"One moment.\" while the name answer is being checked: the yes waits from the start", () => {
  const c = call("FF");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.agent("a3", "One moment.", 23_000, 23_800);
  c.agent("a4", "So it's Sam Miller, right?", 24_500, 26_500);
  assert.equal(c.view().awaiting, "name");
  c.at(28_000);
  c.arrive("c3", "caller", "Yes.", 27_200, 27_600);
  assert.ok(c.held("c3"), "held from its arrival (earlyReadBack), not only later");
  c.at(30_000);
  c.checked("c2");
  c.at(31_500);
  c.checked("c3");
  c.log("c2, c3 checked");
  assert.equal(c.name().method, "name read back by agent, confirmed by caller");
});

test("(g) the item question after a name read-back still isn't held", () => {
  const c = call("FG");
  toName(c);
  c.say("c2", "Sam Miler.", 21_500, 22_500);
  c.agent("a3", "So it's Sam Miller, right?", 25_500, 27_500);
  c.say("c3", "Yes.", 28_200, 28_700);
  c.agent("a4", "And that's the tablet on order 427, is that right?", 29_800, 32_000);
  assert.equal(c.say("c4", "Yes.", 32_300, 32_700), false);
});
