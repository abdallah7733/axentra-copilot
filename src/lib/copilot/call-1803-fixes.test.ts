import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, type CopilotView } from "./copilot";
import type { AgentAction, ClientPack, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Two fixes from the 6:03 PM call (23 Oct), development console:
  - Once the agent has said the detail on the call, the card says to type what the caller said, not to ask the caller to
    repeat it: a repeat after that is the agent's words again and can't verify it.
  - "Typed by the agent, after the agent said it on the call" is judged on what the caller's line was heard as when the
    agent spoke, not on words typed later. The agent said "Hill Road in Dallas, right?" (fast model: "hill road in
    dollars right") and then typed "Hill Road, Dallas"; the typed words had hidden that the agent said "hill road" first.
*/

const NOW = Date.UTC(2026, 9, 23, 16);
const T0 = NOW - 600_000;
type Line = { side: "caller" | "agent"; text: string; firstHeard?: string; checked?: boolean };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-1803",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: T0 + i * 5000,
    endedAt: T0 + i * 5000 + 3000,
    final: true,
    confidence: 0.9,
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
    ...(l.checked ? { checked: true } : {}),
  }));
const both: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true, addressReadBack: true } };
const view = (lines: Line[], actions: AgentAction[] = []) => analyze(both, events(lines), actions, NOW);
const address = (v: CopilotView) => v.verification.factors[1];
const card = (v: CopilotView, target: "name" | "address") => v.prompts.find((p) => p.target === target)?.text ?? "";
const at = (n: number) => T0 + (n - 1) * 5000 + 100;

const opening: Line[] = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const UP_TO_ADDRESS: Line[] = [
  ...opening,
  { side: "caller", text: "Sam Miller.", checked: true },
  { side: "agent", text: "Thank you. And the street and city for the delivery?" },
  { side: "caller", text: "Little Root in Dallas.", firstHeard: "Middle Road in Dallas.", checked: true },
];
const TYPED: AgentAction[] = [{ type: "correct", key: "k7", text: "Hill Road, Dallas", at: at(9) }];

test("6:03 PM call: after the agent says the address, the card says to type it, not to ask for a repeat", () => {
  let v = view(UP_TO_ADDRESS);
  assert.match(card(v, "address"), /Ask the caller to repeat it, or type what they said\./, "before the agent says it: unchanged");
  v = view([...UP_TO_ADDRESS, { side: "agent", text: "hill road in dollars right" }]);
  assert.match(card(v, "address"), /Type what the caller said \(A\)\. You've said the street and city on the call, so the caller repeating them can't verify them\./);
  assert.doesNotMatch(card(v, "address"), /repeat it, or/);
});

test("6:03 PM call: typed after the agent said it is labelled so, whatever the fast model made of the agent's line", () => {
  for (const said of ["hill road in dollars right", "Hill Road in Dallas, right?", "So that's Hill Road, Dallas, is that right?"]) {
    const v = view([...UP_TO_ADDRESS, { side: "agent", text: said }], TYPED);
    assert.equal(address(v).state, "ok", said);
    assert.equal(address(v).method, "street and city, typed by the agent, after the agent said it on the call", said);
  }
  // Typed with nothing said back: unchanged.
  const v = view([...UP_TO_ADDRESS, { side: "agent", text: "Let me check that for you." }], TYPED);
  assert.equal(address(v).method, "street and city, typed by the agent");
});
