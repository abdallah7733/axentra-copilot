import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  C12 (his "Build C12", 23 Nov 2026), the copilot store: a key answer to his usual name or address question asks the
  live store for its check with that question named, both when the answer arrives while it is awaited and when the
  question reaches the console after the answer. A read-back's reply, a probe and any other line name none.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
process.env.NEXT_PUBLIC_AGENT_CONFIRMS_MATCH = "1";
process.env.NEXT_PUBLIC_STRICT_MATCH = "1";
process.env.NEXT_PUBLIC_QUESTION_IN_CHECK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");

function call(callId: string) {
  const T0 = epochNow();
  const asked: { key: string; probe: boolean; question?: string }[] = [];
  useLive.setState({
    checkLine: (key: string, probe = false, question?: string) => {
      asked.push({ key, probe, ...(question ? { question } : {}) });
      return "started";
    },
  });
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
  const checked = (key: string) => liveEvents.emit({ type: "line", line: { ...lines.get(key)!, checked: true, availableAt: epochNow() } });
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  return { at, arrive, checked, held, asked, view: () => useCopilot.getState().view };
}
type C = ReturnType<typeof call>;

function toName(c: C) {
  c.at(2500);
  c.arrive("a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0, 2000);
  c.at(9500);
  c.arrive("c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked. I'd like a new one, please.", 3000, 9000);
  c.at(11_000);
  if (c.held("c1")) c.checked("c1");
}

test("an answer awaited to his usual question asks for its check with that question", () => {
  const c = call("Q-1");
  toName(c);
  c.at(14_000);
  c.arrive("a2", "agent", "First, can I have your full name, please?", 11_500, 13_500);
  assert.equal(c.view().awaitingAsk, "a2");
  c.at(16_500);
  c.arrive("c2", "caller", "Sam Miller.", 14_500, 16_000);
  assert.ok(c.held("c2"));
  assert.deepEqual(c.asked.find((a) => a.key === "c2"), { key: "c2", probe: false, question: "a2" });
  assert.equal(c.asked.find((a) => a.key === "c1")?.question, undefined, "the problem line names no question");
  c.at(18_000);
  c.checked("c2");
  c.at(21_000);
  c.arrive("a3", "agent", "Thank you. And the street and city for the delivery?", 18_500, 20_500);
  c.at(23_500);
  c.arrive("c3", "caller", "Hill Road, in Dallas.", 21_500, 23_000);
  assert.deepEqual(c.asked.find((a) => a.key === "c3"), { key: "c3", probe: false, question: "a3" });
});

test("an answer that reaches the console before his question still gets the question, once the question lands", () => {
  const c = call("Q-2");
  toName(c);
  // The caller's answer arrives first; nothing is awaited yet, so its check waits for the question.
  assert.equal(c.view().awaiting, null);
  c.at(16_500);
  c.arrive("c2", "caller", "Sam Miller.", 14_500, 16_000);
  assert.equal(c.asked.find((a) => a.key === "c2"), undefined);
  c.at(16_800);
  c.arrive("a2", "agent", "First, can I have your full name, please?", 11_500, 13_500);
  assert.deepEqual(c.asked.find((a) => a.key === "c2"), { key: "c2", probe: false, question: "a2" });
});

test("a name question with a name in it names no question", () => {
  const c = call("Q-3");
  toName(c);
  c.at(14_000);
  c.arrive("a2", "agent", "Could you repeat your full name, Sam?", 11_500, 13_500);
  assert.equal(c.view().awaiting, "name");
  c.at(16_500);
  c.arrive("c2", "caller", "Sam Miller.", 14_500, 16_000);
  assert.deepEqual(c.asked.find((a) => a.key === "c2"), { key: "c2", probe: false }, "checked, on its own");
});

test("the caller's reply to a read-back is checked on its own", () => {
  const c = call("Q-4");
  toName(c);
  c.at(14_000);
  c.arrive("a2", "agent", "Thank you. And your full name, please?", 11_500, 13_500);
  c.at(16_500);
  // A sound-alike, so the read-back can count (as on C11, the caller's checked yes verifies it).
  c.arrive("c2", "caller", "Sam Miler.", 14_500, 16_000);
  assert.deepEqual(c.asked.find((a) => a.key === "c2"), { key: "c2", probe: false, question: "a2" });
  c.at(18_000);
  c.checked("c2");
  c.at(21_000);
  c.arrive("a3", "agent", "So it's Sam Miller, right?", 18_500, 20_500);
  assert.equal(c.view().awaitingAsk, undefined);
  c.at(22_500);
  c.arrive("c3", "caller", "Yes.", 21_000, 21_500);
  assert.ok(c.held("c3"), "the reply waits for its check");
  assert.deepEqual(c.asked.find((a) => a.key === "c3"), { key: "c3", probe: false }, "on its own");
  c.at(24_000);
  c.checked("c3");
  assert.equal(c.view().verification.factors[0].state, "ok", "as on C11, the checked yes verifies the name");
});
