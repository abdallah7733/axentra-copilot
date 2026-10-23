import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS_READ_BACK, NAME_READ_BACK, analyze, type CopilotView } from "./copilot";
import type { ClientPack, TranscriptEvent } from "./types";
import { scriptV2, sunlake } from "@/lib/live/sunlake-data";

/*
  Outside review of C6, Amendment 5, as checked against the code (23 Oct): a read-back that says "name" or "address"
  ("So your name is Sam Miller, right?") was read as a new question for that detail, so the caller's "Yes." became the
  answer and the sound-alike, its Confirm and the read-back were lost. Such a line is now a read-back, misheard or not;
  a real question ("What's your name?") is still a question.
*/

const NOW = Date.UTC(2026, 9, 23, 12);
type Line = { side: "caller" | "agent"; text: string; firstHeard?: string; reheard?: string };
const events = (lines: Line[]): TranscriptEvent[] =>
  lines.map((l, i) => ({
    callId: "CA-wording",
    seq: i + 1,
    key: `k${i + 1}`,
    side: l.side,
    text: l.text,
    startedAt: NOW - 600_000 + i * 5000,
    endedAt: NOW - 600_000 + i * 5000 + 3000,
    final: true,
    confidence: 0.9,
    checked: true,
    ...(l.firstHeard !== undefined ? { firstHeard: l.firstHeard } : {}),
    ...(l.reheard !== undefined ? { probedAt: NOW - 600_000 + i * 5000 + 3200, reheard: { text: l.reheard, confidence: 0.9, at: NOW - 600_000 + i * 5000 + 4000 } } : {}),
  }));
const both: ClientPack = { ...sunlake, policy: { ...sunlake.policy, nameReadBack: true, addressReadBack: true } };
const view = (lines: Line[]) => analyze(both, events(lines), [], NOW);
const name = (v: CopilotView) => v.verification.factors[0];
const address = (v: CopilotView) => v.verification.factors[1];
const opening: Line[] = scriptV2.slice(0, 4).map((l) => ({ side: l.side, text: l.text }));
const SOUND_ALIKE: Line[] = [...opening, { side: "caller", text: "Sam Miler." }];
const YES: Line = { side: "caller", text: "Yes, that's right." };

test("a name read-back that says 'your name' is a read-back, and its checked yes verifies it as one", () => {
  for (const said of ["So your name is Sam Miller, right?", "Your full name is Sam Miller, is that correct?"]) {
    const v = view([...SOUND_ALIKE, { side: "agent", text: said }, YES]);
    assert.equal(name(v).state, "ok", said);
    assert.equal(name(v).method, NAME_READ_BACK, said);
  }
});

test("misheard with 'your name' in it, the line is heard again, and counts if the second model heard the name", () => {
  const misheard: Line = { side: "agent", text: "So your name is Samuel Wright, right?" };
  let v = view([...SOUND_ALIKE, misheard]);
  assert.deepEqual(v.readBackChecks, ["k6"]);
  v = view([...SOUND_ALIKE, misheard, YES]);
  assert.equal(name(v).confirmReason, "sounds-like", "the sound-alike isn't lost to the yes");
  v = view([...SOUND_ALIKE, { ...misheard, reheard: "So your name is Sam Miller, right?" }, YES]);
  assert.equal(name(v).method, NAME_READ_BACK);
});

test("'What's your name?' after a sound-alike is still a question, and a clear answer to it is recognised", () => {
  const v = view([...SOUND_ALIKE, { side: "agent", text: "Sorry, what's your name?" }, { side: "caller", text: "Sam Miller." }]);
  assert.equal(name(v).state, "ok");
  assert.equal(name(v).method, undefined);
});

const NAME_OK: Line[] = [...opening, { side: "caller", text: "Sam Miller." }, { side: "agent", text: "Thank you. And the street and city for the delivery?" }];
const ADDR_ALIKE: Line[] = [...NAME_OK, { side: "caller", text: "Hillwood in the alles.", firstHeard: "Little road in Nalist." }];

test("a misheard address read-back that says 'address' doesn't make the caller's yes a new answer", () => {
  const v = view([...ADDR_ALIKE, { side: "agent", text: "So the address is Hill rode, Dallas, right?" }, YES]);
  assert.equal(address(v).state, "confirm");
  assert.equal(address(v).confirmReason, "sounds-like");
  assert.equal(address(v).heard, "Hillwood in the alles.");
  assert.equal(v.addressEntry?.readBack, "available", "it can still be said back");
});

test("the address read-back heard right still counts, and 'What's the delivery address?' is still a question", () => {
  let v = view([...ADDR_ALIKE, { side: "agent", text: "So the address is Hill Road, Dallas, right?" }, YES]);
  assert.equal(address(v).method, ADDRESS_READ_BACK);
  v = view([...ADDR_ALIKE, { side: "agent", text: "Sorry, what's the delivery address?" }, { side: "caller", text: "Hill Road in Dallas." }]);
  assert.equal(address(v).state, "ok");
  assert.equal(address(v).method, "street and city");
});
