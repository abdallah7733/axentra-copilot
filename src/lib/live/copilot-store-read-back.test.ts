import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  The name read-back as a development build runs it. It is a build setting (NEXT_PUBLIC_NAME_READ_BACK=1), read once
  when the client pack loads, so it is set before the store is imported; node --test runs each file in its own process.
*/
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");

const T0 = Date.UTC(2026, 9, 21, 15);
const line = (callId: string, seq: number, key: string, side: "caller" | "agent", text: string, startedAt: number): TranscriptEvent => ({
  callId,
  seq,
  key,
  side,
  text,
  startedAt: T0 + startedAt,
  endedAt: T0 + startedAt + 2000,
  final: true,
  confidence: 0.9,
});
const emit = (l: TranscriptEvent) => liveEvents.emit({ type: "line", line: l });
const name = () => useCopilot.getState().view.verification.factors[0];

test("the build setting is on in this file", async () => {
  const { sunlake } = await import("./sunlake-data");
  assert.equal(sunlake.policy.nameReadBack, true);
});

test("read-back as the console runs it: the caller's yes gets its check, and only the checked yes verifies", () => {
  const asked: string[] = [];
  useLive.setState({ checkLine: (key) => (asked.push(key), key.startsWith("c") ? "started" : "no-audio") });
  liveEvents.emit({ type: "call-started", callId: "CA-RB", at: T0 });
  emit(line("CA-RB", 1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0));
  emit(line("CA-RB", 2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000));
  emit(line("CA-RB", 3, "a2", "agent", "First, can I have your full name, please?", 11_000));
  const answer = line("CA-RB", 4, "c2", "caller", "Sen nilir.", 14_000);
  emit(answer);
  emit({ ...answer, text: "Sammílis.", firstHeard: "Sen nilir.", checked: true });
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "available");

  // Transcribed separately: here the caller's yes arrives before the agent's read-back line.
  const yes = line("CA-RB", 6, "c3", "caller", "Yes, that's right.", 21_000);
  emit(yes);
  emit(line("CA-RB", 5, "a3", "agent", "That's Sam Miller, is that right?", 17_500));
  assert.ok(asked.includes("c3"), "once the read-back is heard, the yes goes to the second check");
  assert.notEqual(name().state, "ok", "nothing verifies while the yes is being checked");
  // These lines are long past by the console's clock, but the yes started in time: the wait lasts as long as its check.
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "waiting");
  assert.equal(useCopilot.getState().view.nameEntry?.readBackUntil, undefined);

  emit({ ...yes, checked: true });
  assert.equal(name().state, "ok");
  assert.equal(name().method, "name read back by agent, confirmed by caller");
  assert.equal(name().answeredAt, T0 + 16_000, "timed from the end of the caller's answer");
  liveEvents.emit({ type: "cleared" });
});

test("the console shows the read-back's wait running out, even when nobody speaks", async () => {
  useLive.setState({ checkLine: () => "no-audio" });
  // Lines timed against the console's own clock, so the 8 s wait ends about 150 ms after the read-back arrives.
  const now = epochNow();
  const at = (startedAt: number, endedAt: number, rest: Omit<TranscriptEvent, "callId" | "startedAt" | "endedAt" | "final" | "confidence">): TranscriptEvent => ({
    callId: "CA-EXP",
    startedAt: now + startedAt,
    endedAt: now + endedAt,
    final: true,
    confidence: 0.9,
    ...rest,
  });
  liveEvents.emit({ type: "call-started", callId: "CA-EXP", at: now - 40_000 });
  emit(at(-40_000, -38_000, { seq: 1, key: "a1", side: "agent", text: "Thank you for calling Sunlake. How can I help you today?" }));
  emit(at(-36_000, -31_000, { seq: 2, key: "c1", side: "caller", text: "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked." }));
  emit(at(-29_000, -27_000, { seq: 3, key: "a2", side: "agent", text: "First, can I have your full name, please?" }));
  emit(at(-26_000, -24_000, { seq: 4, key: "c2", side: "caller", text: "Sammílis.", firstHeard: "Sen nilir.", checked: true }));
  emit(at(-9_500, -7_850, { seq: 5, key: "a3", side: "agent", text: "That's Sam Miller, is that right?" }));
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "waiting");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "expired", "looked again when the wait ran out");
  assert.match(useCopilot.getState().view.prompts.find((p) => p.target === "name")?.text ?? "", /No reply to your read-back within 8 s/);
  liveEvents.emit({ type: "cleared" });
});
