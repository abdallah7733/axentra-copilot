import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  His decisions of 23 Oct 12:35 as the console runs them, on a simulated clock, with the second model's results arriving
  late. The caller's reply to a read-back of a name already accepted (a Confirm press) is held for its check, and nothing
  can be approved meanwhile. A rejection heard by either model reopens the name and the approval given on it stops
  counting; a plain yes leaves it standing. "Yes, Sam Miller." counts once its check hears exactly the name read back.
*/
let mono = 1_000_000;
Object.defineProperty(performance, "now", { value: () => mono, configurable: true, writable: true });
process.env.NEXT_PUBLIC_NAME_READ_BACK = "1";
process.env.NEXT_PUBLIC_ADDRESS_READ_BACK = "1";
const { useCopilot } = await import("./copilot-store");
const { epochNow, liveEvents, useLive } = await import("./store");

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
  /** The second model's result: what it heard, with the fast model's text kept beside it. */
  const checked = (key: string, text?: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, text: text ?? l.text, firstHeard: l.text, checked: true, availableAt: epochNow() } });
  };
  const failed = (key: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, checkFailed: true, availableAt: epochNow() } });
  };
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  return { T0, at, arrive, checked, failed, view, name, held, s: () => useCopilot.getState() };
}
type C = ReturnType<typeof call>;
const approval = (c: C) => c.view().recommendation?.approval.state;

/** Greeting, the problem with the choice, the address heard clearly, then "Sam Miler." (a sound-alike) checked. */
function soundAlike(c: C) {
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
  c.at(21_000);
  c.arrive("a2", "agent", "Thank you. And your full name, please?", 18_500, 20_500);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(24_000);
  c.checked("c2");
}

/** Confirm on the name and the item, then the approval in the panel. */
function approved(c: C) {
  soundAlike(c);
  c.at(25_000);
  c.s().confirm("name");
  c.at(25_500);
  c.s().confirm("order");
  c.at(26_000);
  c.s().approve();
  assert.equal(approval(c), "approved");
}

/** The agent reads the name back after the approval and the caller answers; the reply is held for its check. */
function readBackThenReply(c: C, fast: string) {
  c.at(28_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 26_500, 28_000);
  // Said after the approval, the agent's line is held for its own check (terms said after an approval are heard again).
  assert.ok(c.held("a3"));
  c.at(29_200);
  c.arrive("c3", "caller", fast, 28_400, 29_000);
  assert.ok(c.held("c3"), "the reply to the read-back is held for its check");
  assert.equal(c.name().state, "ok", "nothing changes before the checks");
  assert.notEqual(approval(c), "approved", "but nothing can be approved while the read-back and its reply are checked");
  c.at(29_800);
  c.checked("a3");
  assert.equal(c.name().state, "ok", "nothing changes before the check");
  assert.notEqual(approval(c), "approved", "but nothing can be approved while it is checked");
  assert.equal(c.view().recommendation?.checkingIdentity?.text, fast);
  assert.ok(c.view().recommendation?.suspended, "the approval given is on hold");
}

test("a no to the read-back after Confirm and an approval: held for its check, then the name reopens and the approval stops counting", () => {
  const c = call("d1");
  approved(c);
  readBackThenReply(c, "No.");
  c.at(31_000);
  c.checked("c3");
  assert.notEqual(c.name().state, "ok");
  assert.equal(c.view().verification.verified, false);
  assert.notEqual(approval(c), "approved");
  // Pressing Confirm again doesn't bring it back.
  c.at(32_000);
  c.s().confirm("name");
  assert.notEqual(c.name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("the fast model's 'Yes.' checked as 'No, it's Tom Baker.': the check's rejection reopens the name", () => {
  const c = call("d2");
  approved(c);
  readBackThenReply(c, "Yes.");
  c.at(31_000);
  c.checked("c3", "No, it's Tom Baker.");
  assert.notEqual(c.name().state, "ok");
  assert.notEqual(approval(c), "approved");
  liveEvents.emit({ type: "cleared" });
});

test("the fast model's 'No.' checked as 'Yes.': either model hearing a rejection reopens the name (the safe side)", () => {
  const c = call("d3");
  approved(c);
  readBackThenReply(c, "No.");
  c.at(31_000);
  c.checked("c3", "Yes.");
  assert.notEqual(c.name().state, "ok");
  assert.notEqual(approval(c), "approved");
  liveEvents.emit({ type: "cleared" });
});

test("a yes to the read-back after Confirm and an approval: held, then the approval stands again", () => {
  const c = call("d4");
  approved(c);
  readBackThenReply(c, "Yes, that's right.");
  c.at(31_000);
  c.checked("c3");
  assert.equal(c.name().state, "ok");
  assert.equal(c.view().verification.verified, true);
  assert.equal(approval(c), "approved");
  assert.equal(c.view().recommendation?.checkingIdentity, undefined);
  liveEvents.emit({ type: "cleared" });
});

test("a check that fails releases the hold: the fast text decides, so a no reopens and a yes leaves it standing", () => {
  let c = call("d5");
  approved(c);
  readBackThenReply(c, "No.");
  c.at(35_000);
  c.failed("c3");
  assert.equal(c.held("c3"), false);
  assert.notEqual(c.name().state, "ok");
  assert.notEqual(approval(c), "approved");
  liveEvents.emit({ type: "cleared" });

  c = call("d6");
  approved(c);
  readBackThenReply(c, "Yes.");
  c.at(35_000);
  c.failed("c3");
  assert.equal(c.name().state, "ok");
  assert.equal(approval(c), "approved");
  liveEvents.emit({ type: "cleared" });
});

test("a no more than 8 s after the read-back isn't a reply to it: not held, and the name and approval stand", () => {
  const c = call("d7");
  approved(c);
  c.at(28_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 26_500, 28_000);
  c.at(29_500);
  c.checked("a3");
  c.at(37_500);
  c.arrive("c3", "caller", "No.", 36_500, 37_000);
  assert.equal(c.held("c3"), false);
  assert.equal(c.name().state, "ok");
  assert.equal(approval(c), "approved");
  liveEvents.emit({ type: "cleared" });
});

test("'Yes, Sam Miller.' to a read-back counts once its check hears exactly that name, even after the agent has spoken again", () => {
  let c = call("d8");
  soundAlike(c);
  c.at(27_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 25_500, 27_000);
  c.at(29_000);
  c.arrive("c3", "caller", "Yes, Sam Miller.", 27_400, 28_800);
  assert.ok(c.held("c3"));
  assert.notEqual(c.name().state, "ok");
  c.at(31_000);
  c.arrive("a4", "agent", "Thank you. One moment.", 29_500, 30_500);
  c.at(32_000);
  c.checked("c3");
  assert.equal(c.name().state, "ok");
  assert.equal(c.name().method, "name read back by agent, confirmed by caller");
  liveEvents.emit({ type: "cleared" });

  // The check hears another surname: it doesn't count.
  c = call("d9");
  soundAlike(c);
  c.at(27_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 25_500, 27_000);
  c.at(29_000);
  c.arrive("c3", "caller", "Yes, Sam Miller.", 27_400, 28_800);
  c.at(32_000);
  c.checked("c3", "Yes, Sam Millar.");
  assert.notEqual(c.name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("a correction after the yes, in the same reply and checked later, takes the read-back back", () => {
  const c = call("d10");
  soundAlike(c);
  c.at(27_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 25_500, 27_000);
  c.at(28_600);
  c.arrive("c3", "caller", "Yes, Sam Miller.", 27_400, 28_400);
  c.at(29_500);
  c.checked("c3");
  c.at(31_000);
  c.arrive("c3b", "caller", "Sorry, no, it's Tom Baker.", 29_000, 30_800);
  c.at(32_500);
  if (c.held("c3b")) c.checked("c3b");
  assert.notEqual(c.name().state, "ok");
  liveEvents.emit({ type: "cleared" });
});

test("a no to the read-back after a Confirm press, before any approval: held for its check, then the name reopens", () => {
  const c = call("d11");
  soundAlike(c);
  c.at(25_000);
  c.s().confirm("name");
  assert.equal(c.name().state, "ok");
  c.at(27_200);
  c.arrive("a3", "agent", "That's Sam Miller, is that right?", 25_500, 27_000);
  assert.equal(c.held("a3"), false, "not held: the name was already accepted, so it isn't heard again");
  c.at(28_400);
  c.arrive("c3", "caller", "No, it's Tom Baker.", 27_300, 28_200);
  assert.ok(c.held("c3"));
  assert.notEqual(approval(c), "approved");
  c.at(30_000);
  c.checked("c3");
  assert.notEqual(c.name().state, "ok");
  assert.match(c.view().prompts.find((p) => p.target === "name")?.text ?? "", /rejects the read-back/);
  liveEvents.emit({ type: "cleared" });
});
