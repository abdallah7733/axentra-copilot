import { test } from "node:test";
import assert from "node:assert/strict";
import { caseById, type CaseId } from "./cases";
import { fixtureFile, templateFile, validate, type HypLine, type HypothesisFile } from "./hypotheses";
import { scoreFile, summary, toCsv, COLUMNS, type SegmentScore } from "./score";

/*
  Controlled fixtures: text written to check the harness, run through the UNCHANGED copilot rules
  (B0). They pin what the scorer and the rules do with this exact text. They are harness checks,
  never speech accuracy or latency results: no audio, no recognizer, no timing.

  When a later fix changes the copilot (I-43, I-44), the lines marked "B0 behaviour" change with it,
  and the fix's pull request updates them, so each change shows up here as a difference from B0.
*/

const C = (s: SegmentScore[], id: CaseId) => s.find((x) => x.caseId === id && x.segment === "C")!;
const codes = (s: SegmentScore, layer: "l1Fields" | "l3Fields") => Object.fromEntries(Object.entries(s[layer] ?? {}).map(([k, v]) => [k, v!.code]));

/** One case with constructed caller lines, the agent's cue from the reference. */
function one(id: CaseId, caller: (string | HypLine)[], gapS = 1, kind: HypothesisFile["kind"] = "fixture"): SegmentScore {
  let t = 3;
  const lines = caller.map((x, i) => {
    const start = t + (i ? gapS : 0);
    t = start + 1.2;
    return typeof x === "string" ? { first: x, start, end: t } : { start, end: t, ...x };
  });
  const file: HypothesisFile = { manifestVersion: "v1", kind, configId: "fixture:test", route: "controlled text (no audio)", cases: { [id]: { A: { lines: [{ first: caseById(id).agent, start: 0, end: 2 }] }, C: { lines } } } };
  return C(scoreFile(file).scores, id);
}

test("reference words, run through B0: every field right in the text; what the rules read and did", () => {
  const s = scoreFile(fixtureFile("reference-words")).scores;
  for (const id of ["D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09"] as CaseId[]) assert.ok(Object.values(codes(C(s, id), "l1Fields")).every((c) => c === "OK"), id);
  const errors = (k: "l1" | "nc") => s.filter((x) => x.inventedWords === null).reduce((n, x) => { const w = k === "l1" ? x.l1 : x.l1.nc; return n + w.sub + w.del + w.ins; }, 0);
  assert.deepEqual([errors("l1"), errors("nc")], [0, 0]); // the reference scores itself as exact, split number included
  // B0 behaviour (observed in this harness on fixture text; live behaviour untested):
  assert.deepEqual(codes(C(s, "D03"), "l3Fields"), { intent: "OK", choice: "OK", refund_wanted: "OK", order_id: "OK" });
  assert.equal(C(s, "D03").l3Fields!.intent!.note, "low certainty");
  assert.deepEqual(codes(C(s, "D04"), "l3Fields"), { order_id: "PARTIAL" }); // 5831: digit by digit, read to four digits (I-43)
  assert.deepEqual(codes(C(s, "D05"), "l3Fields"), { order_id: "SPLIT" }); // two lines, not joined (I-43)
  assert.deepEqual(codes(C(s, "D06"), "l3Fields"), { order_id: "FROM_RECORD" }); // nothing read; the only recent order offered
  assert.deepEqual(
    Object.fromEntries(s.filter((x) => x.segment === "C").map((x) => [x.caseId, x.l4])),
    { D01: "NO_EFFECT", D02: "NO_EFFECT", D03: "CLARIFY", D04: "CLARIFY", D05: "CLARIFY", D06: "CLARIFY", D07: "DONE_RIGHT", D08: "DONE_RIGHT", D09: "DONE_RIGHT", D10: "NO_EFFECT" }
  );
  assert.equal(s.filter((x) => x.l4 === "UNSAFE").length, 0);
});

test("reference with numerals, run through B0: written numbers are read; the split number still isn't", () => {
  const s = scoreFile(fixtureFile("reference-numerals")).scores;
  assert.deepEqual(codes(C(s, "D04"), "l3Fields"), { order_id: "OK" });
  assert.deepEqual(codes(C(s, "D06"), "l3Fields"), { order_id: "OK" }); // the later number wins, leading zero kept
  assert.deepEqual(codes(C(s, "D05"), "l3Fields"), { order_id: "SPLIT" });
  assert.deepEqual(codes(C(s, "D08"), "l3Fields"), { house_no: "OK", street: "OK", city: "OK", address: "OK" });
  assert.deepEqual([C(s, "D04").l4, C(s, "D05").l4, C(s, "D06").l4], ["DONE_RIGHT", "CLARIFY", "DONE_RIGHT"]);
  // "26" for spoken "two six" is a conventional-WER substitution; NC-ER reads "714" and "26" as the one order number.
  assert.deepEqual([C(s, "D05").l1.sub, C(s, "D05").l1.nc.sub, C(s, "D05").l1.nc.ins], [1, 0, 0]);
});

test("the safety list: decoys and sound-alikes are never accepted on their own", () => {
  assert.equal(one("D09", ["Grace Whitford."]).l4, "CLARIFY");
  assert.equal(one("D07", ["It's Mariam Hadad."]).l4, "CLARIFY");
  const hadley = one("D07", ["Marian Hadley."]);
  assert.deepEqual([hadley.l4, hadley.l4Note], ["CLARIFY", "counted as a failed attempt (1 of 2)"]);
  assert.equal(one("D08", ["48 Willow Way in Portland."]).l4, "CLARIFY");
  for (const [id, said] of [["D04", "order 58361"], ["D05", "order 71462"], ["D06", "It's 06291."]] as [CaseId, string][]) {
    const r = one(id, [said]);
    assert.equal(r.l3Fields!.order_id!.code, "WRONG", id);
    assert.equal(r.l4, "CLARIFY", id); // the customer's own order offered to confirm, never the decoy
  }
});

test("the harness catches an unsafe outcome when one happens", () => {
  const d10 = one("D10", ["A refund, please."]);
  assert.equal(d10.l4, "UNSAFE");
  assert.equal(d10.inventedWords, 3);
  assert.equal(one("D02", ["Yes, a refund."]).l4, "UNSAFE");
  // Invented words that change nothing are counted, and the workflow is untouched.
  const thanks = one("D10", ["Thank you."]);
  assert.deepEqual([thanks.l4, thanks.inventedWords], ["NO_EFFECT", 2]);
  assert.equal(one("D02", ["No."]).l1.del, 1);
});

test("observed on constructed text: a pause over 2 s splits answers, and a house number turns half an address into a failed attempt", () => {
  // B0 behaviour; live behaviour untested. Identity answers join only within 2 s (ANSWER_GAP_MS).
  const name = one("D07", ["It's Mariam", "Haddad."], 2.5);
  assert.deepEqual([name.l3Fields!.name!.code, name.l4], ["SPLIT", "CLARIFY"]);
  const withNumber = one("D08", ["Forty-eight Willow Lane", "in Portland."], 2.5);
  assert.deepEqual([withNumber.l4, withNumber.l4Note], ["CLARIFY", "asks for the rest; 1 failed attempt counted"]);
  const without = one("D08", ["Willow Lane", "in Portland."], 2.5);
  assert.deepEqual([without.l4, without.l4Note], ["CLARIFY", "asks for the rest"]);
});

test("the copilot reads the checked text, and the checker's effect is paired field by field", () => {
  // Hyphenated digits from a recognizer (probe finding 3): right in the text, unread by the rules.
  const hyphen = one("D06", ["It's 0-6-2-9-1. Sorry, no, 0-6-2-9-4."]);
  assert.deepEqual([hyphen.l1Fields.order_id!.code, hyphen.l3Fields!.order_id!.code], ["OK", "FROM_RECORD"]);
  const rewritten = one("D04", [{ first: "Sure, it's order 58316. It was $129.", checked: "Sure, it's order five eight three one six. It was a hundred and twenty-nine dollars." }]);
  assert.deepEqual([rewritten.l1Fields.order_id!.code, rewritten.l2Fields!.order_id!.code, rewritten.l3Fields!.order_id!.code], ["OK", "OK", "PARTIAL"]);
});

test("missing results stay in the denominators and are LOST at L4", () => {
  const file: HypothesisFile = { ...fixtureFile("reference-words"), cases: { ...fixtureFile("reference-words").cases } };
  delete file.cases.D07;
  file.cases.D09 = { A: file.cases.D09!.A, C: { lines: [{ first: "" }], missingStage: "L1 filtered or blank (unknown which)" } };
  const s = scoreFile(file).scores;
  assert.deepEqual([C(s, "D07").l4, C(s, "D07").missingStage, C(s, "D07").l1.del], ["LOST", "no result in the file", 4]);
  assert.deepEqual([C(s, "D09").l4, C(s, "D09").missingStage], ["LOST", "L1 filtered or blank (unknown which)"]);
});

test("timing is computed only from measured times: usable text, correct field and engine response apart", () => {
  const timed = one("D07", [{ first: "It's Mariam", firstTextS: 1.1 }, { first: "Hadad.", checked: "Haddad.", firstTextS: 0.9, checkS: 2.3, engineResponseS: 0.7 }], 1, "measurement");
  // Second line ends at 3 + 1.2 + 1 + 1.2 = 6.4 s; checked text at 6.4 + 0.9 + 2.3 = 9.6 s.
  assert.deepEqual(timed.timing, { firstText: 0.9, checkedText: 3.2, usableText: 3.2, correctField: 3.2, engine: [0.7] });
  assert.equal(one("D07", ["It's Mariam Haddad."]).timing.usableText, null);
});

test("the report and score sheet: v1 columns, labelled kind, no target marked passed", () => {
  const report = scoreFile(fixtureFile("reference-words"));
  const csv = toCsv(report.rows);
  assert.equal(csv.split("\n")[0], COLUMNS.join(","));
  assert.equal(report.rows.length, 20);
  assert.ok(report.rows.every((r) => r.kind === "fixture"));
  const md = summary(report, { matchesB0: true, files: [] });
  assert.match(md, /not a speech accuracy or latency result/);
  assert.doesNotMatch(md, /\bpassed\b|target met/i);
  const measured = summary(scoreFile({ ...fixtureFile("reference-words"), kind: "measurement" }), { matchesB0: false, files: [{ path: "src/lib/copilot/orders.ts", matches: false }] });
  assert.match(measured, /differs from B0/);
  assert.match(measured, /not demonstrated \(no timed results\)/);
});

test("the listener's reference is what gets scored; without one, a measurement row says it used the script", () => {
  const base = fixtureFile("reference-words");
  const said = "Sure, it is order five eight three one six. It was a hundred twenty-nine dollars.";
  const file: HypothesisFile = { ...base, kind: "measurement", cases: { D04: { A: base.cases.D04!.A, C: { reference: said, lines: [{ first: said }] } }, D07: base.cases.D07 } };
  const report = scoreFile(validate(file));
  const d04 = C(report.scores, "D04");
  assert.deepEqual([d04.referenceFrom, d04.l1.sub + d04.l1.del + d04.l1.ins, d04.l1.nc.sub], ["listener", 0, 0]);
  const row = (id: string, seg: string) => report.rows.find((r) => r.case_id === id && r.segment === seg)!;
  assert.equal(row("D04", "C").reference, said);
  assert.equal(row("D04", "C").reviewer_note, "");
  assert.equal(row("D07", "C").reviewer_note, "scored against the script: no listener reference in the file");
  assert.match(summary(report, { matchesB0: true, files: [] }), /3 segment\(s\) scored against the script/);
  // A reference whose numbers don't match the case's tagged spans is refused, not scored.
  assert.throws(() => validate({ ...file, cases: { D04: { C: { reference: "Sure, it's order five eight three one six.", lines: [] } } } }), /tagged numbers.*re-recording/);
});

test("hypotheses files are checked before scoring", () => {
  assert.doesNotThrow(() => validate(templateFile()));
  assert.throws(() => validate({ ...templateFile(), manifestVersion: "v2" }), /manifestVersion/);
  assert.throws(() => validate({ ...templateFile(), cases: { D11: {} } }), /unknown case D11/);
  assert.throws(() => validate({ ...templateFile(), cases: { D01: { C: { lines: [{ text: "Thank you." }] } } } }), /"first" text is required/);
});
