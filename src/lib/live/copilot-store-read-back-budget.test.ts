import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/* Outside review of C6, Amendment 7 (23 Oct): at most two read-backs per detail per call, the first and one more, after "Sorry?" or silence. */
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
  const asked: string[] = [];
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
    if (held(key)) {
      at(end + 500 + after);
      checked(key, checkedText);
    }
  };
  const agent = (key: string, text: string, start: number, end: number) => {
    at(end + 500);
    arrive(key, "agent", text, start, end);
  };
  /** Re-runs the rules on the current clock (the store's expiry timer doesn't run in tests). */
  const tick = (t: number) => {
    at(t);
    useCopilot.getState().confirm("issue");
  };
  return { T0, probes, asked, at, arrive, checked, reheard, view, name, address, held, say, agent, tick, s: () => useCopilot.getState() };
}
type C = ReturnType<typeof call>;

function toName(c: C) {
  c.agent("a1", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.say("c1", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 3000, 9000);
  c.agent("a2", "First, can I have your full name, please?", 10_000, 12_000);
  c.say("c2", "Sam Miler.", 12_500, 13_500);
  assert.equal(c.name().confirmReason, "sounds-like");
}
function toAddress(c: C) {
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
const card = (c: C, t: "name" | "address") => c.view().prompts.find((p) => p.target === t)?.text ?? "";


const RB = "So it's Sam Miller, right?";
const RBA = "So that's Hill Road, Dallas, is that right?";

test("name: silence, silence, third read-back + Yes. does not verify; spent budget stays 'expired' after filler", () => {
  const c = call("B1");
  toName(c);
  c.agent("rb1", RB, 15_000, 16_500);
  c.tick(25_000);
  assert.equal(c.view().nameEntry?.readBack, "expired");
  assert.match(card(c, "name"), /Say it back once more/);
  c.agent("rb2", RB, 25_500, 27_000);
  assert.equal(c.view().nameEntry?.readBack, "waiting");
  c.tick(35_500);
  assert.equal(c.view().nameEntry?.readBack, "expired");
  assert.match(card(c, "name"), /reading the name back again won't count on this call/);
  c.agent("f1", "Hello? Are you still there?", 36_000, 37_500);
  assert.equal(c.view().nameEntry?.readBack, "expired", "a filler line doesn't re-offer a spent read-back");
  c.agent("rb3", RB, 38_000, 39_500);
  assert.notEqual(c.view().nameEntry?.readBack, "waiting");
  c.say("y", "Yes.", 40_000, 40_400);
  assert.notEqual(c.name().state, "ok");
  // Typing still works.
  c.s().correct("c2", "Sam Miller");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "typed by the agent, after the agent said it on the call");
});

test("address: silence, silence, third read-back + Yes. does not verify", () => {
  const c = call("B2");
  toAddress(c);
  c.agent("rb1", RBA, 22_000, 24_500);
  c.tick(33_000);
  c.agent("rb2", RBA, 33_500, 36_000);
  assert.equal(c.view().addressEntry?.readBack, "waiting");
  c.tick(44_500);
  assert.equal(c.view().addressEntry?.readBack, "expired");
  c.agent("rb3", RBA, 45_000, 47_500);
  c.say("y", "Yes.", 48_000, 48_400);
  assert.notEqual(c.address().state, "ok");
  assert.equal(c.view().addressEntry?.readBack, "expired");
});

test("name and address: Sorry? -> repeat -> silence -> third read-back + Yes. does not verify", () => {
  const c = call("B3N");
  toName(c);
  c.agent("rb1", RB, 15_000, 17_000);
  c.say("s1", "Sorry?", 17_500, 17_900);
  c.agent("rb2", RB, 20_500, 22_000);
  c.tick(30_500);
  assert.equal(c.view().nameEntry?.readBack, "expired");
  c.agent("rb3", RB, 31_000, 32_500);
  c.say("y", "Yes.", 33_000, 33_400);
  assert.notEqual(c.name().state, "ok");
  const d = call("B3A");
  toAddress(d);
  d.agent("rb1", RBA, 22_000, 24_500);
  d.say("s1", "Sorry, can you say that again?", 25_000, 26_000);
  d.agent("rb2", "Hill Road in Dallas, is that right?", 27_000, 28_500);
  d.tick(37_000);
  d.agent("rb3", RBA, 37_500, 40_000);
  d.say("y", "Yes.", 40_500, 40_900);
  assert.notEqual(d.address().state, "ok");
});

test("name: silence -> second read-back -> Sorry? is not a further repeat (refused); a third read-back + Yes. doesn't count", () => {
  const c = call("B4");
  toName(c);
  c.agent("rb1", RB, 15_000, 16_500);
  c.tick(25_000);
  c.agent("rb2", RB, 25_500, 27_000);
  c.say("s", "Sorry?", 27_500, 27_900);
  assert.notEqual(c.view().nameEntry?.readBackRepeat, true);
  assert.equal(c.view().nameEntry?.readBack, "refused");
  assert.equal(c.name().attempts, 0);
  c.agent("rb3", RB, 30_000, 31_500);
  c.say("y", "Yes.", 32_000, 32_400);
  assert.notEqual(c.name().state, "ok");
});

test("name: asking again between silent read-backs doesn't reset the budget", () => {
  const c = call("B5");
  toName(c);
  let t = 15_000;
  for (let i = 1; i <= 2; i++) {
    c.agent(`rb${i}`, RB, t, t + 1500);
    c.tick(t + 1500 + 8500);
    c.agent(`ask${i}`, "Could you give me your full name once more?", t + 10_500, t + 12_000);
    c.say(`ans${i}`, "Sam Miler.", t + 12_500, t + 13_500);
    t += 16_000;
  }
  c.agent("rb3", RB, t, t + 1500);
  c.say("y", "Yes.", t + 2000, t + 2400);
  assert.notEqual(c.name().state, "ok");
});

test("kept: one silent read-back, then a second read-back answered with a checked Yes. verifies (name and address)", () => {
  const c = call("B6N");
  toName(c);
  c.agent("rb1", RB, 15_000, 16_500);
  c.tick(25_000);
  c.agent("rb2", RB, 25_500, 27_000);
  c.say("y", "Yes.", 27_500, 27_900);
  assert.equal(c.name().method, NAME_READ_BACK);
  const d = call("B6A");
  toAddress(d);
  d.agent("rb1", RBA, 22_000, 24_500);
  d.tick(33_000);
  d.agent("rb2", RBA, 33_500, 36_000);
  d.say("y", "Yes.", 36_500, 36_900);
  assert.equal(d.address().method, ADDRESS_READ_BACK);
});

test("kept: a yes that started in time counts however late its check lands", () => {
  const c = call("B7");
  toName(c);
  c.agent("rb1", RB, 15_000, 17_000);
  c.at(18_400);
  c.arrive("y", "caller", "Yes.", 17_500, 17_900);
  c.tick(26_000);
  assert.equal(c.view().nameEntry?.readBack, "waiting");
  c.at(30_000);
  c.checked("y");
  assert.equal(c.name().method, NAME_READ_BACK);
});

test("no second hearing of a read-back-shaped line once the budget is spent", () => {
  const c = call("B8");
  toName(c);
  c.agent("rb1", RB, 15_000, 16_500);
  c.tick(25_000);
  c.agent("rb2", RB, 25_500, 27_000);
  c.tick(35_500);
  c.agent("rb3", "So it's Samuel Wright.", 36_000, 37_500);
  assert.ok(!c.probes.includes("rb3"));
});
