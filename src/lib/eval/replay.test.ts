import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, caseById, type CaseId } from "./cases";
import { fixtureFile, toCaseLines, validate, type HypLine, type HypSegment, type HypothesisFile } from "./hypotheses";
import { evalPack } from "./records";
import { scoreFile, summary, toCsv } from "./score";
import { consoleChecks, runCase, startState, type CaseLine } from "./workflow";

/*
  A replay that checked every caller line (checks "all"), emulated the way the console decides which
  checks the copilot sees, and the replay's own fields (check confidence, phrase release, engine times
  and failures). Harness checks on constructed text and times: nothing about speech or real timing.
*/

const file = (id: CaseId, C: HypSegment, checks?: "all", A?: HypSegment): HypothesisFile => ({
  manifestVersion: "v1",
  kind: "measurement",
  configId: "test",
  route: "constructed text (no audio)",
  ...(checks ? { checks } : {}),
  cases: { [id]: { A: A ?? { lines: [{ first: caseById(id).agent, start: 0, end: 2 }] }, C } },
});
const C = (f: HypothesisFile, id: CaseId) => scoreFile(f).scores.find((s) => s.caseId === id && s.segment === "C")!;
const D03_LINE1 = "Hi. I ordered a wireless speaker last week. The site said four to seven days for delivery, and it came this morning with the front grille smashed.";
const TIMES_ESTIMATED = "check times estimated from the replay (phrase release + measured engine time); the estimate leaves out the 100 ms capture-block lag, waits inside the engine and the GPU shared with running checks";

test("a checked line carries the check's own confidence, as the console does", () => {
  const d09 = (first: number, checked: number) =>
    C(file("D09", { lines: [{ first: "Grace Whitfield.", checked: "Grace Whitfield.", confidence: first, checkedConfidence: checked, start: 3, end: 4.2 }] }, "all"), "D09");
  assert.equal(d09(0.45, 0.9).l4, "DONE_RIGHT");
  const low = d09(0.9, 0.45);
  assert.deepEqual([low.l4, low.l4Note.split("; ")[0], low.confirmationTurns], ["CLARIFY", "please confirm (low-confidence)", 1]);
});

test("D03 cut at 12 s: which lines the console checks depends on the check time, and the report says so", () => {
  // Line 1 is the 12 s cut (released at the cut); line 2 ends at a pause (released 0.6 s after) and its first pass drops "a replacement, not".
  const d03 = (check1: number, extra1: Partial<HypLine> = {}, route?: string): HypothesisFile => ({
    ...file(
      "D03",
      {
        lines: [
          { first: `${D03_LINE1} I'd`, checked: `${D03_LINE1} I'd`, start: 5.68, end: 17.68, emittedS: 17.68, engineResponseS: 0.5, checkEngineResponseS: check1, ...extra1 },
          { first: "like a refund, please.", checked: "like a replacement, not a refund, please.", start: 17.68, end: 20.58, emittedS: 21.18, engineResponseS: 0.3, checkEngineResponseS: 1.5 },
        ],
      },
      "all",
      { lines: [{ first: caseById("D03").agent, start: 0.8, end: 3.9, emittedS: 4.5, engineResponseS: 0.3 }] }
    ),
    ...(route ? { route } : {}),
  });
  const early = "with checks landing early (after the engine's own time, a timed-out check after its own wait, or at once when neither is recorded) the console would check 1 of 2 caller line(s), L4 UNSAFE";
  const late = "with every later first pass 1.5 s late (a GPU shared with a running check) the console would check 1 of 2 caller line(s), L4 UNSAFE";
  const both = "with only caller line 2's first pass 1.5 s late and checks landing early the console would check 1 of 2 caller line(s), L4 UNSAFE";
  // Line 1's check lands at 20.18 s, before line 2's first text (21.48 s): the copilot no longer awaits an answer, so line 2 counts unchecked.
  const short = C(d03(2), "D03");
  assert.deepEqual([short.l4, short.l3Fields!.choice!.code, short.timingDependent], ["UNSAFE", "WRONG", true]);
  assert.match(short.l4Note, /console would check: 1 of 2 caller line\(s\); check times estimated from the replay \(phrase release \+ measured engine time\); the estimate leaves out the 100 ms capture-block lag, waits inside the engine and the GPU shared with running checks/);
  assert.ok(short.l4Note.endsWith("; timing-dependent: with 9 s checks the console would check 2 of 2 caller line(s), L4 CLARIFY"), short.l4Note);
  // A 4 s check is still running when line 2 arrives (22.18 s against 21.48 s), so line 2 is held and its check counts. Less
  // than a second either way changes that: a check landing at once, or line 2's first pass 1.5 s later behind it.
  const long = C(d03(4), "D03");
  assert.deepEqual([long.l4, long.l3Fields!.choice!.code, long.timingDependent], ["CLARIFY", "OK", true]);
  assert.ok(long.l4Note.endsWith(`; console would check: 2 of 2 caller line(s); ${TIMES_ESTIMATED}; timing-dependent: ${early}; ${late}; ${both}`), long.l4Note);
  // With the check's own engine time recorded (3.9 s), landing early still holds line 2: only the later first pass changes it.
  const recorded = C(d03(4, { checkEngineElapsedS: 3.9 }), "D03");
  assert.ok(recorded.l4Note.endsWith(`; timing-dependent: ${late}; ${both}`), recorded.l4Note);
  // A 5 s check (4.5 s of it in the engine) holds line 2 with an early check alone (22.68 s against 21.48 s) and with line 2
  // late alone (23.18 s against 22.98 s), but not with both at once (22.68 s against 22.98 s).
  const together = C(d03(5, { checkEngineElapsedS: 4.5 }), "D03");
  assert.deepEqual([together.l4, together.timingDependent], ["CLARIFY", true]);
  assert.ok(together.l4Note.endsWith(`; timing-dependent: ${both}`), together.l4Note);
  // A 6 s check (5.9 s of it in the engine) is still running when line 2 arrives in every run.
  assert.equal(C(d03(6, { checkEngineElapsedS: 5.9 }), "D03").timingDependent, false);
  assert.match(summary(scoreFile(d03(4)), { matchesB0: true, files: [] }), /Timing-dependent cases \(the console's choice of checked lines changes with 9 s checks, with checks landing early, or with later first passes 1\.5 s late\): 1 \(D03\)\./);
  // The combined pass sent both sides at once, so its engine times already hold that overlap.
  const combined = C(d03(2, {}, "Tier 1 replay; combined pass: each case's agent and caller phrases sent together, checks outside the caller queue"), "D03");
  assert.match(combined.l4Note, /check times estimated from the replay \(phrase release \+ measured engine time, which in this combined pass includes the overlap of both sides' requests and the checks\); the estimate leaves out the 100 ms capture-block lag;/);
  // Without release and engine times the check times are made up, and the note says which lines may differ live.
  const untimed = file("D03", { lines: d03(2).cases.D03!.C!.lines.map(({ first, checked, start, end }) => ({ first, checked, start, end })) }, "all");
  assert.match(C(untimed, "D03").l4Note, /check times synthesized \(1 s to first text, 2 s checks\): which lines the console would check may differ live/);
});

test("D03 split at its reading pauses: a later first pass slowed on its own can land after the check before it", () => {
  // Three caller lines, 4 s checks (3.9 s in the engine). Line 3's first pass drops "a replacement, not"; its check hears it.
  const d03 = (line3S: number) =>
    C(
      file(
        "D03",
        {
          lines: [
            { first: "Hi.", checked: "Hi.", checkedConfidence: 0.9, start: 5.68, end: 6.18, emittedS: 6.78, engineResponseS: 0.3, checkEngineResponseS: 4, checkEngineElapsedS: 3.9 },
            { first: D03_LINE1.slice(4), checked: D03_LINE1.slice(4), checkedConfidence: 0.9, start: 6.98, end: 16.98, emittedS: 17.58, engineResponseS: 0.5, checkEngineResponseS: 4, checkEngineElapsedS: 3.9 },
            { first: "I'd like a refund, please.", checked: "I'd like a replacement, not a refund, please.", checkedConfidence: 0.9, start: 17.98, end: 20.68, emittedS: 21.28, engineResponseS: line3S, checkEngineResponseS: 2, checkEngineElapsedS: 1.9 },
          ],
        },
        "all",
        { lines: [{ first: caseById("D03").agent, start: 0.8, end: 3.9, emittedS: 4.5, engineResponseS: 0.3 }] }
      ),
      "D03"
    );
  // Line 3's first text (21.58 s) comes before line 2's check (22.08 s), so it is held. Slowed alone by a check beside it, it
  // would land after that check, though slowing every later first pass moves line 2's check with it and changes nothing.
  const held = d03(0.3);
  assert.deepEqual([held.l4, held.l3Fields!.choice!.code, held.timingDependent], ["CLARIFY", "OK", true]);
  assert.ok(held.l4Note.includes("timing-dependent: with only caller line 3's first pass 1.5 s late the console would check 2 of 3 caller line(s), L4 UNSAFE"), held.l4Note);
  assert.doesNotMatch(held.l4Note, /every later first pass/);
});

test("in the early run, a check that timed out lands after its own wait, not at once", () => {
  const f = file(
    "D03",
    {
      lines: [
        { first: `${D03_LINE1} I'd`, checkFailed: true, start: 5.68, end: 17.68, emittedS: 17.68, engineResponseS: 0.5, checkEngineFailure: { outcome: "timeout after 9000 ms", afterS: 9 } },
        { first: "like a refund, please.", checked: "like a replacement, not a refund, please.", checkedConfidence: 0.9, start: 17.68, end: 20.58, emittedS: 21.18, engineResponseS: 1.5, checkEngineResponseS: 2, checkEngineElapsedS: 1.9 },
      ],
    },
    "all",
    { lines: [{ first: caseById("D03").agent, start: 0.8, end: 3.9, emittedS: 4.5, engineResponseS: 0.3 }] }
  );
  const d03 = C(validate(f), "D03");
  assert.deepEqual([d03.l4, d03.timingDependent], ["CLARIFY", false], d03.l4Note);
  // A check that failed another way may have failed sooner, so it still lands at once in the early run.
  const http = structuredClone(f);
  http.cases.D03!.C!.lines[0].checkEngineFailure = { outcome: "HTTP 503", afterS: 9 };
  assert.equal(C(validate(http), "D03").timingDependent, true);
});

test("the settle re-run after the answer gap decides whether a later caller line is held", () => {
  // Two decoy names: the second failed attempt counts once the caller has been quiet for the 2 s answer gap, and then
  // nothing is awaited. "It's Mariam Haddad." starts 2.3 s after it, so it is a new line, not part of that answer.
  const c = caseById("D07");
  const pack = evalPack(c.record);
  const lines = (secondCheckLands: number): CaseLine[] => [
    { side: "agent", first: c.agent, start: 0, end: 2, firstAt: 2.5 },
    { side: "caller", first: "Marian Hadley.", checked: "Marian Hadley.", start: 3, end: 4.2, firstAt: 4.7, checkedAt: 5.2 },
    { side: "agent", first: "Sorry, can I have your full name again?", start: 7, end: 9, firstAt: 9.5 },
    { side: "caller", first: "Marian Hadley.", checked: "Marian Hadley.", start: 10, end: 11.2, firstAt: 11.7, checkedAt: secondCheckLands },
    { side: "caller", first: "It's Mariam Haddad.", checked: "It's Mariam Haddad.", start: 13.5, end: 14.5, firstAt: 15, checkedAt: 15.5 },
  ];
  // The last event (12.2 s) is more than 2.1 s before the line (15 s): the console has re-run the view since, with the
  // second attempt failed and identity locked, so the line isn't held.
  assert.deepEqual(consoleChecks(c, pack, startState(c, pack), lines(12.2)).checked, [1, 3]);
  // The last event at 13.1 s is under 2.1 s before it: the view is still the one from then, awaiting the name, so it's held.
  assert.deepEqual(consoleChecks(c, pack, startState(c, pack), lines(13.1)).checked, [1, 3, 4]);
});

test("a line the copilot names a key answer only at a later event is checked from then", () => {
  // The caller's choice reaches the screen (22 s) before the agent's question that it answers (23 s).
  const c = caseById("D03");
  const pack = evalPack(c.record);
  const lines: CaseLine[] = [
    { side: "agent", first: c.agent, start: 0.8, end: 3.9, firstAt: 4.2 },
    { side: "caller", first: D03_LINE1, checked: D03_LINE1, start: 5.68, end: 17.68, firstAt: 18.18, checkedAt: 20.18 },
    { side: "agent", first: "Which do you prefer, a replacement or a refund?", start: 18, end: 20, firstAt: 23 },
    { side: "caller", first: "A replacement, please.", checked: "A replacement, please.", start: 20.5, end: 21.5, firstAt: 22, checkedAt: 24.5 },
  ];
  const r = consoleChecks(c, pack, startState(c, pack), lines);
  assert.deepEqual(r.checked, [1, 3]);
  assert.equal(r.lines[1].checkedAt, 20.18); // asked on arrival
  assert.equal(r.lines[3].checkedAt, 25.5); // asked at 23 s, and its check takes 2.5 s
});

test("a line the console wouldn't check loses its failed check for L3 and L4", () => {
  const c = caseById("D03");
  const pack = evalPack(c.record);
  const lines: CaseLine[] = [
    { side: "agent", first: c.agent, start: 0.8, end: 3.9, firstAt: 4.2 },
    { side: "caller", first: `${D03_LINE1} I'd`, checked: `${D03_LINE1} I'd`, start: 5.68, end: 17.68, firstAt: 18.18, checkedAt: 20.18 },
    { side: "caller", first: "like a replacement, not a refund, please.", checkFailed: true, start: 17.68, end: 20.58, firstAt: 21.48, checkedAt: 23 },
  ];
  const r = consoleChecks(c, pack, startState(c, pack), lines);
  assert.deepEqual(r.checked, [1]);
  assert.deepEqual([r.lines[2].checkFailed, r.lines[2].checked, r.lines[2].checkedAt], [undefined, undefined, undefined]);
  // Unchecked, the choice reads at full confidence; marked doubtful (a live file), it would not be taken.
  assert.equal(runCase(c, lines, { checks: "all", times: "estimated" }).l4, "CLARIFY");
  assert.equal(runCase(c, lines).l4, "MISSED");
});

test("a blank first pass never reaches the copilot, so it can't join two answers across the 2 s gap", () => {
  for (const gap of [2.4, 2.8, 3.2]) {
    const l1 = { first: "It's Mariam", start: 3, end: 4.2 };
    const l2 = { first: "Haddad.", start: 4.2 + gap, end: 5 + gap };
    const blank = { first: "", start: 4.05 + gap / 2, end: 4.35 + gap / 2 };
    for (const checks of [undefined, "all"] as const) {
      const without = C(file("D07", { lines: [l1, l2] }, checks), "D07");
      const withBlank = C(file("D07", { lines: [l1, blank, l2] }, checks), "D07");
      assert.deepEqual([withBlank.l3Fields!.name!.code, withBlank.l4], [without.l3Fields!.name!.code, without.l4], `gap ${gap} s, checks ${checks}`);
      assert.deepEqual([without.l3Fields!.name!.code, without.l4], ["SPLIT", "CLARIFY"]);
    }
  }
  // The note counts only the caller lines that reached the copilot.
  const d08 = C(file("D08", { lines: [{ first: "", checked: "Forty-eight Willow Lane", start: 3, end: 4.2 }, { first: "in Portland.", checked: "in Portland.", start: 5.2, end: 6 }] }, "all"), "D08");
  assert.match(d08.l4Note, /console would check: 1 of 1 caller line\(s\)/);
});

test("replay times: each side's first passes wait in turn, and checks take their measured time", () => {
  const { lines, times } = toCaseLines({
    C: {
      lines: [
        { first: "Order seven one four", checked: "Order seven one four", checkedConfidence: 0.75, start: 4.75, end: 6.25, emittedS: 6.75, engineResponseS: 2.25, checkEngineResponseS: 2.5, checkEngineElapsedS: 2.375 },
        // Released at 8.5 s, while line 1's first pass is still out (until 9 s).
        { first: "two six.", checkFailed: true, start: 7.5, end: 7.9, emittedS: 8.5, engineResponseS: 0.5, checkEngineFailure: { outcome: "timeout after 9000 ms", afterS: 9 } },
        { first: "", start: 8.5, end: 8.75, emittedS: 9.25, engineFailure: { outcome: "HTTP 502", afterS: 0.25 } },
      ],
    },
  });
  assert.equal(times, "estimated");
  // The check's own engine time goes with it: the soonest it could land, for the timing check.
  assert.deepEqual(
    lines.map((l) => [l.firstAt, l.checkedAt, l.checkedConfidence, l.checkEngineS]),
    [
      [9, 11.5, 0.75, 2.375],
      // A check that timed out can't have answered before its own wait.
      [9.5, 18.5, undefined, 9],
      [9.75, undefined, undefined, undefined],
    ]
  );
  assert.equal(toCaseLines({ C: { lines: [{ first: "Haddad.", start: 1, end: 2 }] } }).times, "synthesized");
  assert.deepEqual(toCaseLines({ C: { lines: [{ first: "Haddad.", checked: "Haddad.", start: 1, end: 2, firstTextS: 0.5, checkS: 1.5 }] } }), {
    lines: [{ side: "caller", first: "Haddad.", checked: "Haddad.", checkedAt: 4, confidence: 0.9, start: 1, end: 2, firstAt: 2.5 }],
    times: "measured",
  });
});

test("engine response: failed requests are counted and listed beside the answered ones, never averaged in", () => {
  const f = file(
    "D04",
    {
      lines: [
        { first: "Sure, it's order five eight three one six.", checkFailed: true, start: 3, end: 5, emittedS: 5.6, engineResponseS: 0.5, engineElapsedS: 0.25, checkEngineFailure: { outcome: "HTTP 503", afterS: 8.012 } },
        { first: "", checked: "It was a hundred and twenty-nine dollars.", start: 5.5, end: 7.5, emittedS: 8.1, engineFailure: { outcome: "timeout after 130000 ms", afterS: 130 }, checkEngineResponseS: 3.5, checkEngineElapsedS: 3.25 },
      ],
    },
    "all",
    { lines: [{ first: caseById("D04").agent, start: 0, end: 2, emittedS: 2.6, engineResponseS: 0.25, engineElapsedS: 0.125 }] }
  );
  const report = scoreFile(validate(f));
  const md = summary(report, { matchesB0: true, files: [] });
  const table = md.split("\n").filter((l) => /^\| (First pass|Check)\b/.test(l));
  assert.match(md, /\| Request \| Channel \| Sent \| Answered \| Median \| p90 \(nearest rank\) \| Max \| Answered, time not in the file \| Failed or no answer \|/);
  // Each channel has its own row, as in the timing table; checks are caller lines only.
  assert.deepEqual(table, [
    "| First pass (main model) | Caller | 2 | 1 | 0.50 s | 0.50 s | 0.50 s | 0 | 1 (timeout after 130000 ms, 130.00 s from sending) |",
    "| First pass (main model) | Agent | 1 | 1 | 0.25 s | 0.25 s | 0.25 s | 0 | 0 |",
    "| Check (second model) | Caller | 2 | 1 | 3.50 s | 3.50 s | 3.50 s | 0 | 1 (HTTP 503, 8.01 s from sending) |",
    "| First pass: engine's own time (elapsedMs) | Caller | 2 | 1 | 0.25 s | 0.25 s | 0.25 s | 0 | 1 (timeout after 130000 ms, 130.00 s from sending) |",
    "| First pass: engine's own time (elapsedMs) | Agent | 1 | 1 | 0.13 s | 0.13 s | 0.13 s | 0 | 0 |",
    "| Check: engine's own time (elapsedMs) | Caller | 2 | 1 | 3.25 s | 3.25 s | 3.25 s | 0 | 1 (HTTP 503, 8.01 s from sending) |",
  ]);
  assert.match(md, /Failed requests are counted beside the answered ones and listed; they are never averaged in\./);
  const row = (seg: string) => report.rows.find((r) => r.case_id === "D04" && r.segment === seg)!;
  assert.deepEqual([row("C").engine_failures, row("C").engine_elapsed_s, row("C").check_engine_elapsed_s, row("A").engine_elapsed_s], ["first p2: timeout after 130000 ms, 130 s from sending; check p1: HTTP 503, 8.012 s from sending", "0.25", "3.25", "0.125"]);
  assert.ok(toCsv(report.rows).split("\n")[0].endsWith(",check_engine_response_s,engine_elapsed_s,check_engine_elapsed_s,engine_failures"));
});

test("a file from an older replay toolkit: requests it doesn't record are still counted, and the report says what's missing", () => {
  // No elapsedMs, no failure records and no check confidence, as the older toolkit wrote them.
  const f = file(
    "D05",
    {
      lines: [
        { first: "Order seven one four.", checked: "Order seven one four.", start: 3, end: 4.5, engineResponseS: 0.5, checkEngineResponseS: 2 },
        { first: "two six.", checkFailed: true, start: 5.5, end: 6, engineResponseS: 0.25 },
        { first: "", checked: "Thanks.", start: 7, end: 7.5 },
      ],
    },
    "all",
    { lines: [{ first: caseById("D05").agent, start: 0, end: 2, engineResponseS: 0.25 }] }
  );
  const report = scoreFile(validate(f));
  const md = summary(report, { matchesB0: true, files: [] });
  const table = md.split("\n").filter((l) => /^\| (First pass|Check)\b/.test(l));
  // The blank first pass with no answer recorded and the failed check with no record are counted as sent and failed.
  assert.deepEqual(table, [
    "| First pass (main model) | Caller | 3 | 2 | 0.38 s | 0.50 s | 0.50 s | 0 | 1 (1 with the outcome not in the file) |",
    "| First pass (main model) | Agent | 1 | 1 | 0.25 s | 0.25 s | 0.25 s | 0 | 0 |",
    "| Check (second model) | Caller | 3 | 2 | 2.00 s | 2.00 s | 2.00 s | 1 | 1 (1 with the outcome not in the file) |",
    // Answered requests with no elapsedMs are counted apart, not as failed.
    "| First pass: engine's own time (elapsedMs) | Caller | 3 | 2 | n/a | n/a | n/a | 2 | 1 (1 with the outcome not in the file) |",
    "| First pass: engine's own time (elapsedMs) | Agent | 1 | 1 | n/a | n/a | n/a | 1 | 0 |",
    "| Check: engine's own time (elapsedMs) | Caller | 3 | 2 | n/a | n/a | n/a | 2 | 1 (1 with the outcome not in the file) |",
  ]);
  assert.equal(report.rows.find((r) => r.case_id === "D05" && r.segment === "C")!.engine_failures, "first p3: outcome not in the file; check p2: outcome not in the file");
  assert.match(md, /- Check confidence: \*\*2 checked line\(s\) have no checkedConfidence\*\*, as in a file from an older replay toolkit, so for those the copilot used the first pass's confidence\. Re-run with the current toolkit\./);
  // A current file, with every check confidence, says nothing about it.
  const current = file("D09", { lines: [{ first: "Grace Whitfield.", checked: "Grace Whitfield.", checkedConfidence: null, start: 3, end: 4.2 }] }, "all");
  assert.doesNotMatch(summary(scoreFile(current), { matchesB0: true, files: [] }), /Check confidence/);
});

test("LOST with text in the file: only the replay's check of a blank first pass, listed with its stage", () => {
  const report = scoreFile(file("D01", { lines: [{ first: "", checked: "Thank you.", start: 3, end: 3.9 }], missingStage: "L1 filtered or blank (unknown which)" }, "all"));
  const d01 = report.scores.find((s) => s.caseId === "D01" && s.segment === "C")!;
  const stage = "L1 filtered or blank (unknown which); only the replay's own check has text, and the console drops a blank first pass before any check";
  assert.deepEqual([d01.l4, d01.missing, d01.lostBeforeCopilot, d01.missingStage], ["LOST", false, true, stage]);
  assert.equal(report.rows.find((r) => r.case_id === "D01" && r.segment === "C")!.missing_stage, stage);
  assert.ok(summary(report, { matchesB0: true, files: [] }).includes(`## Missing results\n\n- D01 C: ${stage}`));
  // When the first pass's request failed, the console never had a line to drop.
  const failed = C(file("D01", { lines: [{ first: "", checked: "Thank you.", start: 3, end: 3.9, emittedS: 4.5, engineFailure: { outcome: "HTTP 502", afterS: 0.2 }, checkEngineResponseS: 1 }], missingStage: "request failed (HTTP 502)" }, "all"), "D01");
  assert.deepEqual([failed.l4, failed.missingStage], ["LOST", "request failed (HTTP 502); only the replay's own check has text, and the console never gets a line from a failed request"]);
});

test("a reference must carry the case's values, not only as many numbers; who checked it is reported", () => {
  const ref = (id: CaseId, reference: string) => validate(file(id, { reference, lines: [] }));
  for (const [id, said, what] of [
    ["D04", "Sure, it's order five eight three one seven. It was a hundred and twenty-nine dollars.", /order number "five eight three one seven" where the case has 58316/],
    ["D04", "Sure, it's order five eight three one six. It was a hundred and thirty-nine dollars.", /amount "one hundred thirty nine" where the case has 129/],
    ["D06", "It's zero six two nine one. Sorry, no, zero six two nine five.", /order number "zero six two nine five" where the case has 06294/],
    ["D07", "It's Miriam [pause 1.0 s] Haddad.", /no name "Mariam Haddad"/],
    ["D08", "Forty-nine Willow Lane [pause 1.0 s] in Portland.", /house number "forty nine" where the case has 48/],
    ["D08", "Forty-eight Willow Way [pause 1.0 s] in Portland.", /no street "Willow Lane"/],
    ["D03", caseById("D03").caller.replace("seven days", "six days"), /range "four to six days" where the case has 4-7 days/],
    ["D02", "No.", /"no" 1 time\(s\) where the case has 2/],
  ] as [CaseId, string, RegExp][]) {
    assert.throws(() => ref(id, said), what, `${id}: ${said}`);
    assert.throws(() => ref(id, said), /a misread number, name, address or choice means re-recording the take/);
  }
  // Read as text, the reference must also give the case's critical fields: D03's "a replacement, not a refund".
  const d03 = (said: string) => caseById("D03").caller.replace("a replacement, not a refund", said);
  assert.throws(() => ref("D03", d03("a refund, not a replacement")), /D03\.C: reference doesn't give the case's expected choice \(read WRONG: replacement negated\), refund_wanted \(read WRONG: refund not negated\); a misread number, name, address or choice means re-recording the take/);
  assert.throws(() => ref("D03", d03("a replacement, a refund")), /D03\.C: reference doesn't give the case's expected refund_wanted \(read WRONG: refund not negated\);/);
  // Leaving the refund out reads refund_wanted OK, but the take can't show the case's negated refund.
  for (const said of ["a replacement", "not a refund, a replacement"]) {
    assert.throws(() => ref("D03", d03(said)), /D03\.C: reference doesn't say the refund and its negation after the replacement \("replacement", then "not", then "refund"\), so it can't show the case's negated refund; a misread number, name, address or choice means re-recording the take/, said);
  }
  assert.doesNotThrow(() => ref("D03", d03("a replacement, not a refund")));
  assert.doesNotThrow(() => ref("D03", d03("a replacement [pause 0.8 s], not a refund")));
  assert.throws(() => validate(file("D09", { lines: [{ first: "Grace Whitfield.", checkedConfidence: 0.8 }] })), /checkedConfidence .* needs "checked"/);
  assert.throws(() => validate(file("D09", { lines: [{ first: "Grace Whitfield.", firstTextS: 1 }] }, "all")), /firstTextS and checkS are console screen times/);
  assert.doesNotThrow(() => validate(file("D09", { lines: [{ first: "Grace Whitfield.", firstTextS: 1 }] })));
  // Every reference as written, and both fixture files, are accepted.
  const asWritten: HypothesisFile = { ...fixtureFile("reference-words"), kind: "measurement", cases: {} };
  const by = "speaker (one playback; v1 second-person check of numbers, names and addresses not done)";
  for (const c of CASES) asWritten.cases[c.id] = { A: { reference: c.agent, lines: [{ first: c.agent }] }, C: { reference: c.caller, ...(c.spans.length ? { referenceCheckedBy: by } : {}), lines: c.caller ? [{ first: c.caller }] : [] } };
  assert.doesNotThrow(() => validate(asWritten));
  assert.doesNotThrow(() => validate(fixtureFile("reference-words")));
  assert.doesNotThrow(() => validate(fixtureFile("reference-numerals")));
  const report = scoreFile(asWritten);
  const md = summary(report, { matchesB0: true, files: [] });
  assert.match(md, /References: every segment scored against a reference written from the recording\. Checked by the speaker only \(one playback\) for 8 segment\(s\); v1's second-person check of numbers, names and addresses was not done\./);
  assert.doesNotMatch(md, /listener's transcript/);
  assert.equal(report.rows.find((r) => r.case_id === "D04" && r.segment === "C")!.reviewer_note, `reference checked by ${by}`);
  // Said once: not again when the segment's own note already says it.
  const noted = `reference: speaker's note after playback; reference checked by ${by}; waveform speech 1-5.8 s of the take`;
  const d04 = scoreFile({ ...asWritten, cases: { D04: { ...asWritten.cases.D04, C: { ...asWritten.cases.D04!.C!, note: noted } } } }).rows.find((r) => r.case_id === "D04" && r.segment === "C")!;
  assert.equal(d04.reviewer_note, noted);
});

test("a file with a key the harness doesn't read, or fields that contradict each other, is refused", () => {
  const D09 = (line: object, seg: object = {}, top: object = {}) => validate({ ...file("D09", { lines: [{ first: "Grace Whitfield.", ...line }], ...seg }, "all"), ...top });
  const refused = (line: object, message: RegExp, seg?: object, top?: object) => assert.throws(() => D09(line, seg, top), message);
  // Misspelt keys would be ignored silently and change L4, so each level lists them.
  refused({ checked: "Grace Whitfield.", checkConfidence: 0.9, emitedS: 4.8 }, /D09\.C\.lines\[0\]: unknown key\(s\) "checkConfidence", "emitedS" \(a misspelt key would be ignored silently\)/);
  refused({}, /D09\.C: unknown key\(s\) "referenceCheckBy"/, { referenceCheckBy: "speaker" });
  refused({}, /top of the file: unknown key\(s\) "check"/, {}, { check: "all" });
  // Each request either answered or got no usable answer, and a failed one leaves no text.
  const failure = { outcome: "HTTP 502", afterS: 0.25 };
  refused({ first: "", engineResponseS: 0.5, engineFailure: failure }, /engineResponseS \(answered\) and engineFailure \(no usable answer\) can't both be there/);
  refused({ engineFailure: failure }, /engineFailure means the first pass got no usable answer, so "first" must be ""/);
  refused({ checkFailed: true, checkEngineResponseS: 0.5, checkEngineFailure: failure }, /checkEngineResponseS \(answered\) and checkEngineFailure \(no usable answer\) can't both be there/);
  refused({ checked: "Grace Whitfield.", checkFailed: true }, /"checked" text means the check answered, so checkFailed and checkEngineFailure can't be there too/);
  refused({ checked: "Grace Whitfield.", checkFailed: true, checkEngineFailure: failure }, /"checked" text means the check answered/);
  refused({ checkEngineFailure: failure }, /checkEngineFailure means the check failed, so checkFailed must be true/);
  refused({ checkFailed: true, checkEngineFailure: { outcome: "HTTP 503", afterS: -1 } }, /checkEngineFailure\.afterS is seconds from sending, so it can't be negative/);
  // The engine's own time comes with an answer, a check's times with a check result, and no time is negative.
  refused({ first: "", engineFailure: failure, engineElapsedS: 0.2 }, /engineElapsedS is the engine's time for an answer, so it can't be there with engineFailure/);
  refused({ checkFailed: true, checkEngineFailure: failure, checkEngineElapsedS: 0.2 }, /checkEngineElapsedS is the engine's time for an answer, so it can't be there with checkEngineFailure/);
  refused({ checkEngineResponseS: 2 }, /checkEngineResponseS is the time of a check, so the line needs "checked" text or checkFailed/);
  refused({ checkEngineElapsedS: 2 }, /checkEngineElapsedS is the time of a check, so the line needs "checked" text or checkFailed/);
  for (const k of ["engineResponseS", "checkEngineResponseS", "emittedS", "start"]) {
    refused({ checked: "Grace Whitfield.", [k]: -1 }, new RegExp(`${k} is a number of seconds, so it can't be negative`));
  }
  refused({}, /D09\.C: referenceCheckedBy says who checked the reference, but the segment has no reference/, { referenceCheckedBy: "speaker (one playback)" });
  // What the contract allows: a failed first pass with no text, a failed check, and an empty check (answered, marked failed).
  assert.doesNotThrow(() => D09({ first: "", engineFailure: failure, checked: "Grace Whitfield.", checkedConfidence: 0.9, checkEngineResponseS: 1 }));
  assert.doesNotThrow(() => D09({ checkFailed: true, checkEngineFailure: { outcome: "timeout after 9000 ms", afterS: 9 } }));
  assert.doesNotThrow(() => D09({ checkFailed: true, checkEngineResponseS: 0.5 }));
});
