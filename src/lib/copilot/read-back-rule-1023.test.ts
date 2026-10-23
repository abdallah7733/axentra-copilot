import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_READ_BACK, NAME_READ_BACK, analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { readBackFits } from "./verification";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  His read-back rule (23 Oct, after the outside review of the C6 report), with "Back to before": read-back only for a
  recognition error, repeating what was heard and never filling in what wasn't. A matching city, common first name or
  street word alone never opens it; after a wrong answer the caller gives the detail again; a caller repeating the
  detail after the agent said it is never counted as their own answer; typing records what the caller supplied.
*/

const customer = sunlake.customers[0];
const NOW = Date.UTC(2026, 9, 23, 12);
type Line = { side: "caller" | "agent"; text: string; confidence?: number; firstHeard?: string; checked?: boolean };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-rule",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: l.confidence ?? 0.9,
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
    ...(l.checked ? { checked: true } : {}),
  }));
const both: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true, addressReadBack: true } };
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(both, events(lines), actions, NOW);
const name = (v: CopilotView) => v.verification.factors[0];
const address = (v: CopilotView) => v.verification.factors[1];
const opening = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const NAME_OK: Line[] = [...opening, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }];
const YES: Line = { side: "caller", text: "Yes, that's right.", checked: true };
const at = (n: number) => NOW - 600_000 + (n - 1) * 5000 + 100;

test("which answers a read-back may follow: every part heard, or none of them; never one part carrying the rest", () => {
  const fits: [string, boolean][] = [
    ["Sam Miller", true],
    ["Sam Muller", true],
    ["Sandler", true],
    ["Sammílis", true],
    ["Sam Jones", false],
    ["Pam Miller", false],
    ["Sam Mills", false],
    ["Sam", false],
    ["Sam Miller or John Smith", false],
    ["Not Sam Miller", false],
  ];
  for (const [text, want] of fits) assert.equal(readBackFits("name", text, customer), want, text);
  const addresses: [string, boolean][] = [
    ["Hill Road in Dallas", true],
    ["Will Road in Dallas", true],
    ["Helrout Indalis", true],
    ["Helrout in Dallas", true],
    ["Hillwood in the alles", true],
    ["Elm Road in Dallas", false],
    ["Hill Road in Dalton", false],
    ["Hill Road in Austin", false],
    ["Hill Street in Dallas", false],
    ["Dallas", false],
    ["s dot miller at example mail dot com", false],
  ];
  for (const [text, want] of addresses) assert.equal(readBackFits("address", text, customer), want, text);
});

test("a doubtful name with only the first name right offers no read-back, and a yes to one doesn't verify", () => {
  const lines: Line[] = [...opening, { side: "caller", text: "Sam Jones.", confidence: 0.3 }, { side: "agent", text: "Thank you." }];
  let v = view(lines);
  assert.equal(name(v).state, "confirm");
  assert.equal(v.nameEntry?.readBack ?? "off", "off");
  assert.doesNotMatch(v.prompts.find((p) => p.target === "name")!.text, /Say back/);
  v = view([...lines, { side: "agent", text: "That's Sam Miller, is that right?" }, YES]);
  assert.notEqual(name(v).state, "ok");
  assert.equal(name(v).method, undefined);
});

test("a doubtful address with only the city right, or another street type, offers no read-back", () => {
  for (const text of ["Elm Road in Dallas.", "Hill Street in Dallas."]) {
    const lines: Line[] = [...NAME_OK, { side: "caller", text, confidence: 0.3 }, { side: "agent", text: "Okay." }];
    let v = view(lines);
    assert.equal(address(v).state, "confirm", text);
    assert.equal(v.addressEntry?.readBack ?? "off", "off", text);
    v = view([...lines, { side: "agent", text: "So that's Hill Road, Dallas, is that right?" }, YES]);
    assert.notEqual(address(v).state, "ok", text);
  }
});

test("a whole-answer mishearing of the address still offers the read-back, and the checked yes verifies it as a read-back", () => {
  const lines: Line[] = [...NAME_OK, { side: "caller", text: "Helrout in Dallas.", confidence: 0.3 }, { side: "agent", text: "Okay." }];
  assert.equal(view(lines).addressEntry?.readBack, "available");
  const v = view([...lines, { side: "agent", text: "So that's Hill Road, Dallas, is that right?" }, YES]);
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, ADDRESS_READ_BACK);
});

test("one model hearing the whole name is enough: the read-back follows the fast model's reading when the check lost it", () => {
  const lines: Line[] = [...opening, { side: "caller", text: "Sam Jones.", firstHeard: "Sam Miller.", checked: true }, { side: "agent", text: "Thank you." }];
  let v = view(lines);
  assert.equal(name(v).confirmReason, "disagree");
  assert.equal(v.nameEntry?.readBack, "available");
  v = view([...lines, { side: "agent", text: "That's Sam Miller, is that right?" }, YES]);
  assert.equal(name(v).method, NAME_READ_BACK);
});

test("after the agent says the name, even a sound-alike from the caller opens neither Confirm nor a read-back", () => {
  const lines: Line[] = [...opening, { side: "caller", text: "Sam." }, { side: "agent", text: "Could you repeat your full name? Is it Sam Miller?" }, { side: "caller", text: "Sam Millar." }, { side: "agent", text: "Okay." }];
  let v = view(lines);
  assert.equal(name(v).confirmReason, "after-read-back");
  assert.equal(v.nameEntry?.readBack ?? "off", "off");
  v = view(lines, [{ type: "confirm", target: "name", at: at(8) }]);
  assert.notEqual(name(v).state, "ok", "a Confirm press can't vouch for an echo");
  v = view([...lines, { side: "agent", text: "That's Sam Miller, is that right?" }, YES]);
  assert.notEqual(name(v).state, "ok");
  // Typing what the caller said is recorded as typed, never as the caller's own answer.
  v = view(lines, [{ type: "correct", key: "k7", text: "Sam Miller", at: at(8) }]);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, "typed by the agent, after the agent said it on the call");
});

// His decision of 23 Oct 12:35 ("Count it"): a checked yes with the exact full name now confirms the read-back, labelled as
// read back, never as the caller's own answer (before, it didn't count at all).
test("a caller's 'Yes, Sam Miller.' to a read-back confirms it, labelled as read back, never as their own answer", () => {
  const lines: Line[] = [
    ...opening,
    { side: "caller", text: "Sammílis.", firstHeard: "Sen nilir.", checked: true },
    { side: "agent", text: "That's Sam Miller, is that right?" },
    { side: "caller", text: "Yes, Sam Miller.", checked: true },
    { side: "agent", text: "Thank you. And the street and city for the delivery?" },
  ];
  const v = view(lines);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, NAME_READ_BACK);
  assert.equal(name(v).attempts, 0);
});

test("a caller correcting themselves inside one answer is asked again, whichever way round; a plain 'No, it's…' still counts", async () => {
  const { matchAddress, matchName } = await import("./verification");
  const names: [string, string][] = [
    ["Sam Miller. No wait, it's Tom Baker.", "ambiguous"],
    ["Tom Baker. No wait, it's Sam Miller.", "ambiguous"],
    ["Sam Miller, actually Tom Baker.", "ambiguous"],
    ["No, it's Sam Miller.", "match"],
    ["No, it's Sam Miller, from Dallas.", "match"],
    ["Sam Miller. And it's about order 427.", "match"],
  ];
  for (const [text, want] of names) assert.equal(matchName(text, customer), want, text);
  const addresses: [string, string][] = [
    ["Hill Road in Dallas. Actually, Elm Road in Austin.", "ambiguous"],
    ["Hill Road in Dallas, no wait, Texas.", "match"],
  ];
  for (const [text, want] of addresses) assert.equal(matchAddress(text, customer), want, text);
});
