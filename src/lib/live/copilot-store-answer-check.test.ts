import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEvent } from "@/lib/copilot/types";

/*
  Outside review of C6, Amendment 3 (23 Oct), as checked against the code: when the caller's answer runs over two lines
  and the second is still with the second speech model, a read-back's yes or a Confirm press counted on the first line
  alone, and then the tick, the approval and its history vanished when the second line's check landed. A read-back,
  a press and an exact match now wait for that check. A caller correcting themselves inside the answer ("No wait,
  it's Tom Baker.") is asked again (his rule, 23 Oct). And a panel approval given while the read-back it relied on
  was still undecided doesn't come back when the agent types the name later.
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
  const checked = (key: string, text?: string) => {
    const l = lines.get(key)!;
    liveEvents.emit({ type: "line", line: { ...l, text: text ?? l.text, ...(text && text !== l.text ? { firstHeard: l.text } : {}), checked: true, availableAt: epochNow() } });
  };
  const view = () => useCopilot.getState().view;
  const name = () => view().verification.factors[0];
  const held = (key: string) => !!useCopilot.getState().lines.find((l) => l.key === key)?.checking;
  return { T0, at, arrive, checked, view, name, held, s: () => useCopilot.getState() };
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
  assert.equal(c.view().verification.factors[1].state, "ok");
  c.at(21_000);
  c.arrive("a2", "agent", "Thank you. And your full name, please?", 18_500, 20_500);
}

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
  ["M I L L E R.", true],
  ["No wait, it's Tom Baker.", false],
  ["Or maybe it's Tom Baker.", false],
] as const)
  test(`a read-back said while the rest of the answer is checked waits for it, and its yes never counts early: "${rest}"`, () => {
    const c = call(`AC-1c-${rest}`);
    twoLineAnswer(c, rest);
    c.at(27_500);
    c.arrive("a3", "agent", "So it's Sam Miller, right?", 25_000, 27_000);
    assert.equal(c.view().nameEntry?.readBack, "waiting");
    assert.match(c.view().prompts.find((p) => p.target === "name")!.text, /Your read-back counts once the rest of the caller's answer is checked/);
    c.at(28_200);
    c.arrive("c3", "caller", "Yes.", 27_300, 27_700);
    assert.ok(c.held("c3"), "the reply waits for its check from the start");
    c.at(29_000);
    c.checked("c3");
    assert.equal(c.view().verification.verified, false, "no tick while the answer's second line is still being checked");
    c.at(29_300);
    c.s().confirm("order");
    c.at(29_500);
    c.s().approve();
    assert.notEqual(c.view().recommendation?.approval.state, "approved");
    c.at(30_500);
    c.checked("c2b");
    assert.equal(c.view().verification.verified, counts);
    if (counts) {
      assert.equal(c.name().method, "name read back by agent, confirmed by caller");
      assert.equal(c.name().knownAt, c.T0 + 30_500, "counted when the last line of the answer was checked");
    } else assert.equal(c.name().confirmReason, "ambiguous", "a conflicting answer is asked again");
  });

for (const [rest, counts] of [
  ["M I L L E R.", true],
  ["No wait, it's Tom Baker.", false],
] as const)
  test(`a Confirm press while the rest of the answer is checked waits for it: "${rest}"`, () => {
    const c = call(`AC-1d-${rest}`);
    twoLineAnswer(c, rest);
    c.at(25_500);
    c.s().confirm("name");
    assert.notEqual(c.name().state, "ok", "the press waits");
    c.at(26_500);
    c.checked("c2b");
    assert.equal(c.name().state === "ok", counts);
    if (counts) {
      assert.equal(c.name().method, "confirmed by the agent");
      assert.equal(c.name().knownAt, c.T0 + 26_500, "counted when the check it waited for landed");
    }
  });

for (const order of ["first line checked first", "second line checked first"] as const)
  test(`"Sam Miller." then "No wait, it's Tom Baker." never ticks, and is asked again (${order})`, () => {
    const c = call(`AC-2-${order}`);
    toName(c);
    c.at(23_000);
    c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
    c.at(25_100);
    c.arrive("c2b", "caller", "No wait, it's Tom Baker.", 22_800, 24_600);
    const [first, second] = order === "first line checked first" ? ["c2", "c2b"] : ["c2b", "c2"];
    c.at(25_500);
    c.checked(first);
    assert.equal(c.view().verification.verified, false);
    c.at(27_000);
    c.checked(second);
    assert.equal(c.view().verification.verified, false);
    assert.equal(c.name().confirmReason, "ambiguous");
    assert.equal(c.name().attempts, 0);
  });

test("an exact name followed by a still-checked line that only adds something verifies once that line lands", () => {
  const c = call("AC-2-adds");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miller.", 21_500, 22_500);
  c.at(25_100);
  c.arrive("c2b", "caller", "And it's about the tablet.", 22_800, 24_600);
  c.at(25_500);
  c.checked("c2");
  assert.equal(c.view().verification.verified, false, "waits for the rest of the answer");
  c.at(27_000);
  c.checked("c2b");
  assert.equal(c.view().verification.verified, true);
  assert.equal(c.name().method, undefined, "recognised");
});

test("an approval given while the read-back's yes was later refused doesn't come back when the agent types the name", () => {
  const c = call("AC-4R");
  toName(c);
  c.at(23_000);
  c.arrive("c2", "caller", "Sam Miler.", 21_500, 22_500);
  c.at(25_000);
  c.checked("c2");
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
  assert.equal(c.view().recommendation?.approval.state, "approved");
  // Said before the approval, but reached the console after it: the read-back wasn't confirmed after all.
  c.at(32_300);
  c.arrive("c4", "caller", "But no, that's not right.", 29_200, 30_400);
  if (c.held("c4")) {
    c.at(33_800);
    c.checked("c4");
  }
  assert.notEqual(c.view().recommendation?.approval.state, "approved");
  c.at(36_000);
  c.s().correct(c.view().nameEntry!.key!, "Sam Miller");
  assert.equal(c.name().state, "ok");
  assert.notEqual(c.view().recommendation?.approval.state, "approved", "the agent approves again, on what is verified now");
  const history = c.view().recommendation?.history ?? [];
  assert.ok(history.some((h) => h.at === c.T0 + 30_000 && !h.counted));
});
