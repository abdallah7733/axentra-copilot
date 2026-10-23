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

/*
  23 Oct C3 call (2:24 AM): the agent said "So it's Sam Miller, right?" and the fast model wrote "So it's Samuel Wright.",
  so the read-back was never seen. The second model heard it right from the same mic offline. While read-back is allowed,
  an agent line shaped like a read-back is now heard again by the second model, without being held back: it counts as
  heard meanwhile, and only what depends on whether it was a read-back waits for that check. The live store keeps the
  line's fast text and reports the second hearing beside it (`reheard`).
*/
const c3Start = (callId: string, asked: string[], answer = "Sandler.") => {
  useLive.setState({ checkLine: (key) => (asked.push(key), "started") });
  liveEvents.emit({ type: "call-started", callId, at: T0 });
  emit(line(callId, 1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0));
  const opening = line(callId, 2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000);
  emit(opening);
  emit({ ...opening, checked: true });
  emit(line(callId, 3, "a2", "agent", "First, can I have your full name, please?", 11_000));
  const first = line(callId, 4, "c2", "caller", "Senleli.", 14_000);
  emit(first);
  emit({ ...first, text: answer, firstHeard: "Senleli.", checked: true });
  assert.equal(useCopilot.getState().view.nameEntry?.readBack, "available");
};
const copilotLine = (key: string) => useCopilot.getState().lines.find((l) => l.key === key);
const misheard = (callId: string) => line(callId, 5, "a3", "agent", "So it's Samuel Wright.", 17_500);
/** The live store's result for a line heard again: the fast text stays, the second model's hearing beside it. */
const reheard = (l: TranscriptEvent, text: string | null) => ({ ...l, reheard: { text, confidence: text === null ? null : 0.9, at: epochNow() } });
const heardAgain = (l: TranscriptEvent) => reheard(l, "So it's Sam Miller, right?");
const card = () => useCopilot.getState().view.nameEntry?.readBack;
const PROBE_CARD = /Checking your last line with the second model in case it was the name read-back/;

test("a read-back the fast model misheard is heard again without being held back, and verifies only with the caller's checked yes", () => {
  const asked: string[] = [];
  c3Start("CA-C3", asked);
  const readBack = misheard("CA-C3");
  emit(readBack);
  assert.ok(asked.includes("a3"), "the agent's line goes to the second model");
  assert.equal(copilotLine("a3")?.checking, undefined, "not held back");
  assert.equal(copilotLine("a3")?.probing, true);
  assert.equal(card(), "waiting");
  assert.match(useCopilot.getState().view.prompts.find((p) => p.target === "name")?.text ?? "", PROBE_CARD);

  // The caller's next line may be the reply: it waits for its own check from the start.
  const yes = line("CA-C3", 6, "c3", "caller", "Yes, that's right.", 21_000);
  emit(yes);
  assert.ok(asked.includes("c3"));
  assert.equal(copilotLine("c3")?.checking, true);
  assert.notEqual(name().state, "ok");

  emit(heardAgain(readBack));
  assert.equal(copilotLine("a3")?.text, "So it's Samuel Wright.", "the fast text stays for every other rule");
  assert.equal(copilotLine("a3")?.reheard?.text, "So it's Sam Miller, right?");
  assert.notEqual(name().state, "ok", "nothing verifies while the yes is being checked");
  assert.equal(card(), "waiting");

  emit({ ...yes, checked: true });
  assert.equal(name().state, "ok");
  assert.equal(name().method, "name read back by agent, confirmed by caller");
  assert.equal(name().evidence?.text, "So it's Sam Miller, right?", "the read-back as the second model heard it");
  assert.equal(name().evidence?.firstHeard, "So it's Samuel Wright.");
  liveEvents.emit({ type: "cleared" });
});

test("the C3 call as it went: the read-back heard again, then 'Sorry?', is refused as before", () => {
  const asked: string[] = [];
  c3Start("CA-C3B", asked);
  const readBack = misheard("CA-C3B");
  emit(readBack);
  const sorry = line("CA-C3B", 6, "c3", "caller", "Sorry?", 21_000);
  emit(sorry);
  emit(heardAgain(readBack));
  emit({ ...sorry, checked: true });
  assert.notEqual(name().state, "ok");
  assert.equal(card(), "refused");
  assert.equal(useCopilot.getState().view.nameEntry?.readBackRecovery, "ask");
  // The repeat that followed on the call ("It is Sam Miller.", then the caller's "Sam Millerius." heard unclearly) still changes nothing.
  emit(line("CA-C3B", 7, "a4", "agent", "It is Sam Miller.", 23_000));
  emit({ ...line("CA-C3B", 8, "c4", "caller", "Sam Millerius.", 25_500), confidence: 0.4, checked: true });
  assert.notEqual(name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("when the second model hears the same misheard line, or its check fails, nothing changes", () => {
  for (const text of ["So it's Samuel Wright.", null]) {
    const asked: string[] = [];
    c3Start("CA-C3C", asked);
    const readBack = misheard("CA-C3C");
    emit(readBack);
    emit(reheard(readBack, text));
    const kept = copilotLine("a3");
    assert.equal(kept?.probing, false);
    assert.equal(kept?.checkFailed, undefined, "a failed check doesn't make the agent's line doubtful");
    assert.equal(kept?.confidence, 0.9);
    const yes = line("CA-C3C", 6, "c3", "caller", "Yes, that's right.", 21_000);
    emit(yes);
    assert.ok(!asked.includes("c3"), String(text));
    assert.notEqual(name().state, "ok", String(text));
    assert.equal(name().attempts, 0, "the yes isn't a failed attempt");
    assert.equal(card(), "available", "read-back is still allowed");
    liveEvents.emit({ type: "cleared" });
  }
});

test("only a line shaped like a read-back, while the name question is the latest, is heard again", () => {
  const cases: [string, boolean][] = [
    ["So it's Sam Miller, is that right?", false], // heard as a read-back already
    ["Sorry, could you tell me your full name again?", false], // asks again
    ["Great, thank you.", false],
    ["One moment, please.", false],
    ["Thank you, one moment.", false],
    ["Okay, let me check.", false],
    ["That's not Sam Miller.", false],
    ["Sorry?", false],
    ["Pardon?", false],
    ["Are you still there?", false],
    ["Can you hear me?", false],
    ["And your first name?", false],
    ["Is that with a C?", false],
    ["Could you repeat that?", false],
    ["Sandler, is that correct?", true],
    ["So it's similar, right?", true],
    ["Sam Millar?", true],
    ["Is it Sandler?", true],
    ["Thank you, Mr Miller.", true], // names someone: heard again, nothing waits on it unless the caller replies
  ];
  for (const [text, probed] of cases) {
    const asked: string[] = [];
    c3Start("CA-C3D", asked);
    emit(line("CA-C3D", 5, "a3", "agent", text, 17_500));
    assert.equal(asked.includes("a3"), probed, text);
    liveEvents.emit({ type: "cleared" });
  }
  // Once the agent has moved on to the street and city, a later line isn't heard again.
  const asked: string[] = [];
  c3Start("CA-C3E", asked);
  emit(line("CA-C3E", 5, "a3", "agent", "And the street and city for the delivery?", 17_500));
  emit(line("CA-C3E", 6, "c3", "caller", "Hill Road in Dallas.", 21_000));
  emit(line("CA-C3E", 7, "a4", "agent", "So it's Samuel Wright.", 24_000));
  assert.ok(!asked.includes("a4"));
  assert.equal(copilotLine("a4")?.probing, undefined);
  liveEvents.emit({ type: "cleared" });
});

test("after a read-back heard right, the agent's next line isn't heard again, and a yes to it never verifies the name", () => {
  for (const next of ["And it arrived yesterday, right.", "And did the tablet arrive damaged?"]) {
    const asked: string[] = [];
    c3Start("CA-C3F", asked);
    emit(line("CA-C3F", 5, "a3", "agent", "That's Sam Miller, is that right?", 17_500));
    emit(line("CA-C3F", 6, "a4", "agent", next, 20_000));
    assert.ok(!asked.includes("a4"), next);
    const yes = line("CA-C3F", 7, "c3", "caller", "Yes.", 23_000);
    emit(yes);
    assert.notEqual(name().state, "ok", next);
    emit({ ...yes, checked: true });
    assert.notEqual(name().state, "ok", next);
    liveEvents.emit({ type: "cleared" });
  }
});

test("a caller's yes that arrives before the agent's line is no failed attempt and doesn't move the name field", () => {
  const asked: string[] = [];
  c3Start("CA-C3G", asked);
  // The two sides are transcribed separately: here the caller's yes reaches the console first, while the name is awaited.
  const yes = line("CA-C3G", 6, "c3", "caller", "Yes, that's right.", 21_000);
  emit(yes);
  assert.ok(asked.includes("c3"));
  const readBack = misheard("CA-C3G");
  emit(readBack);
  assert.ok(asked.includes("a3"));
  emit({ ...yes, checked: true });
  assert.equal(name().attempts, 0);
  assert.equal(useCopilot.getState().view.nameEntry?.key, "c2", "the field stays on the caller's name answer");
  assert.notEqual(name().state, "ok");
  emit(heardAgain(readBack));
  assert.equal(name().state, "ok");
  assert.equal(name().method, "name read back by agent, confirmed by caller");
  liveEvents.emit({ type: "cleared" });
});

test("a Confirm press on the name waits while the caller's reply may still refuse a read-back", () => {
  // "Sam Miler." only sounds like the record, so the agent may confirm it in the panel.
  for (const outcome of ["same", "read back, then Sorry?"] as const) {
    const asked: string[] = [];
    c3Start("CA-C3H", asked, "Sam Miler.");
    const readBack = misheard("CA-C3H");
    emit(readBack);
    const reply = line("CA-C3H", 6, "c3", "caller", outcome === "same" ? "Yes." : "Sorry?", 21_000);
    emit(reply);
    useCopilot.getState().confirm("name");
    assert.notEqual(name().state, "ok", `${outcome}: not while the line is being heard again`);
    if (outcome === "same") {
      emit(reheard(readBack, readBack.text));
      assert.equal(name().state, "ok", "the press counts once the line turns out not to be a read-back");
      assert.equal(name().method, "confirmed by the agent");
    } else {
      emit(heardAgain(readBack));
      assert.notEqual(name().state, "ok", "nor while the caller's reply to the read-back is being checked (second review)");
      assert.equal(useCopilot.getState().view.verification.verified, false);
      emit({ ...reply, checked: true });
      assert.notEqual(name().state, "ok", "after a refused read-back the press never counts");
      assert.equal(card(), "refused");
    }
    liveEvents.emit({ type: "cleared" });
  }
});

test("a press made before the caller replies counts at once and stays counted when the agent's line is heard again", () => {
  const asked: string[] = [];
  c3Start("CA-C3J", asked, "Sam Miler.");
  useCopilot.getState().confirm("name");
  assert.equal(name().state, "ok");
  // Here the press lands before the line the agent was saying reaches the console.
  emit(misheard("CA-C3J"));
  assert.equal(name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("once the agent goes on talking, a reply to the read-back still being checked keeps the card waiting and holds a press", () => {
  const asked: string[] = [];
  c3Start("CA-C3K", asked, "Sam Miler.");
  const readBack = misheard("CA-C3K");
  emit(readBack);
  const yes = line("CA-C3K", 6, "c3", "caller", "Yes.", 21_000);
  emit(yes);
  emit(heardAgain(readBack));
  emit(line("CA-C3K", 7, "a4", "agent", "And the street and city for the delivery?", 24_000));
  assert.equal(card(), "waiting");
  useCopilot.getState().confirm("name");
  assert.notEqual(name().state, "ok");
  emit({ ...yes, checked: true });
  assert.equal(name().state, "ok");
  assert.equal(name().method, "name read back by agent, confirmed by caller");
  liveEvents.emit({ type: "cleared" });
});

test("a caller line that already counted is never hidden later, when the agent's line turns out to be a read-back", () => {
  const asked: string[] = [];
  c3Start("CA-C3L", asked, "Sam Miler.");
  const readBack = misheard("CA-C3L");
  emit(readBack);
  const states: string[] = [];
  const said = line("CA-C3L", 6, "c3", "caller", "Sam Miller.", 21_000);
  emit(said);
  states.push(name().state);
  emit(heardAgain(readBack));
  states.push(name().state);
  emit({ ...said, checked: true });
  states.push(name().state);
  const first = states.indexOf("ok");
  assert.ok(first === -1 || states.slice(first).every((x) => x === "ok"), states.join(" → "));
  liveEvents.emit({ type: "cleared" });
});

test("an agent line said before a press is never heard again afterwards (undo, then Confirm again)", () => {
  const asked: string[] = [];
  c3Start("CA-C3M", asked, "Sam Miler.");
  useCopilot.getState().confirm("name");
  emit(line("CA-C3M", 5, "a3", "agent", "Thank you, Mr Miller.", 17_500));
  assert.ok(!asked.includes("a3"), "the name was already confirmed");
  useCopilot.getState().undo("name");
  useCopilot.getState().confirm("name");
  emit(line("CA-C3M", 6, "a4", "agent", "And the street and city for the delivery?", 20_000));
  assert.ok(!asked.includes("a3"), "said before the presses: never sent later");
  assert.equal(name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("a pass rebuilding an earlier moment sees the line as the copilot did then", async () => {
  const { analyze } = await import("@/lib/copilot/copilot");
  const { sunlake } = await import("./sunlake-data");
  const lines: TranscriptEvent[] = [
    line("CA-C3I", 1, "a1", "agent", "Thank you for calling Sunlake. How can I help you today?", 0),
    line("CA-C3I", 2, "c1", "caller", "Hello. I need help with order 427. The tablet came yesterday, and the screen is cracked.", 4000),
    line("CA-C3I", 3, "a2", "agent", "First, can I have your full name, please?", 11_000),
    { ...line("CA-C3I", 4, "c2", "caller", "Sandler.", 14_000), firstHeard: "Senleli.", checked: true },
    { ...line("CA-C3I", 5, "a3", "agent", "So it's Samuel Wright.", 17_500), probedAt: T0 + 20_000, reheard: { text: "So it's Sam Miller, right?", confidence: 0.9, at: T0 + 23_500 } },
    { ...line("CA-C3I", 6, "c3", "caller", "Yes, that's right.", 21_000), checked: true },
  ];
  assert.equal(analyze(sunlake, lines.slice(0, 5), [], T0 + 19_800).nameEntry?.readBack, "available", "before the second hearing started");
  const during = analyze(sunlake, lines, [], T0 + 23_000);
  assert.notEqual(during.verification.factors[0].state, "ok");
  assert.equal(during.nameEntry?.readBack, "waiting");
  const after = analyze(sunlake, lines, [], T0 + 24_000);
  assert.equal(after.verification.factors[0].state, "ok");
  assert.equal(after.verification.factors[0].knownAt, T0 + 23_500, "verified from when the second model's result arrived");
});
