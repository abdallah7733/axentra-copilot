/*
  Scores a hypotheses file into the v1 score sheet (scoring file, section 6: one row per segment per
  configuration per run) and a summary. Counts are reported side by side and never merged into one
  score (3.3). No target is ever marked passed: a target appears next to the observation as "not
  demonstrated" or "not contradicted by this small sample" (section 5).
*/

import { CASES, MANIFEST_VERSION, callerParts, type CaseId, type DevCase } from "./cases";
import { fieldsOf, textFieldCodes, type FieldCodes } from "./fields";
import type { HypothesisFile, HypSegment } from "./hypotheses";
import { toCaseLines } from "./hypotheses";
import { collapsedTokens, conventionalWords, sameToken, tagReference } from "./normalize";
import { align, errorRate, type ErrorCounts } from "./wer";
import { runCase, type WorkflowCode } from "./workflow";

/** The v1 columns, in order, then the harness's additions (README.md lists why each was added). */
export const COLUMNS = [
  "case_id", "manifest_version", "segment", "role", "speaker", "take", "route", "audio_variant", "duration_s", "config_id", "run_no", "cold_or_warm",
  "reference", "L0_phrases", "L0_cut_points", "L1_text", "L1_empty_reason", "L2_text", "L2_check_time_s", "fields_expected",
  "L1_field_codes", "L2_field_codes", "L3_field_codes", "words_ref", "sub", "del", "ins", "wer", "nc_er", "invented_words",
  "t_end_method", "first_text_s", "checked_text_s", "usable_text_s", "correct_field_s", "engine_response_s", "queue_s", "decode_s",
  "workflow_start_state", "L4_outcome", "confirmation_turns", "missing_stage", "reviewer_note",
  // Harness additions:
  "kind", "L2_sub", "L2_del", "L2_ins", "L2_wer", "L2_nc_er", "L4_note",
] as const;
export type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

export type SegmentScore = {
  caseId: string;
  segment: "A" | "C";
  l1: ErrorCounts & { nc: ErrorCounts };
  l2: (ErrorCounts & { nc: ErrorCounts }) | null;
  inventedWords: number | null;
  l1Fields: FieldCodes;
  l2Fields: FieldCodes | null;
  l3Fields: FieldCodes | null;
  l4: WorkflowCode | null;
  l4Note: string;
  confirmationTurns: number | null;
  /** Where the scored reference came from: the listener's transcript in the file, or the script. */
  referenceFrom: "listener" | "script";
  missing: boolean;
  missingStage: string;
  timing: { firstText: number | null; checkedText: number | null; usableText: number | null; correctField: number | null; engine: number[] };
};

export type Report = { file: HypothesisFile; rows: Row[]; scores: SegmentScore[] };

const r3 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "" : String(Math.round(n * 1000) / 1000));
/** A checked line with no "checked in" time has no usable-text time. */
const finite = (n: number) => (Number.isFinite(n) ? n : null);
/** Times to the millisecond, so sums of seconds don't carry floating-point noise. */
const ms = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);
const codesText = (codes: FieldCodes | null) =>
  codes ? Object.entries(codes).map(([k, v]) => `${k}=${v!.code}${v!.note ? ` (${v!.note})` : ""}`).join("; ") : "";

function wordCounts(reference: string, refSpans: DevCase["spans"], lines: string[]) {
  const counts = align(conventionalWords(reference), conventionalWords(lines.join(" ")), (a, b) => a === b);
  const nc = align(tagReference(collapsedTokens(reference), refSpans), collapsedTokens(lines.join(" ")), sameToken);
  return { ...counts, nc };
}

/** Scores one segment of one case. A case or segment absent from the file counts as missing, never dropped. */
function scoreSegment(file: HypothesisFile, c: DevCase, segment: "A" | "C"): { row: Row; score: SegmentScore } {
  const segs = file.cases[c.id] ?? {};
  const seg: HypSegment | undefined = segs[segment];
  const reference = seg?.reference ?? (segment === "A" ? c.agent : c.caller);
  const referenceFrom = seg?.reference !== undefined ? "listener" : "script";
  const hyp = seg?.lines ?? [];
  const l1Lines = hyp.map((l) => l.first);
  const anyChecked = hyp.some((l) => l.checked !== undefined);
  const l2Lines = anyChecked ? hyp.map((l) => l.checked ?? l.first) : null;
  const spans = segment === "A" ? [] : c.spans;
  const l1 = wordCounts(reference, spans, l1Lines);
  const l2 = l2Lines ? wordCounts(reference, spans, l2Lines) : null;
  const expectsSpeech = !!reference.trim();
  const hasText = hyp.some((l) => (l.checked ?? l.first).trim());
  const missing = expectsSpeech && !hasText;
  const missingStage = missing ? seg?.missingStage ?? (seg ? "filtered or blank (unknown which)" : "no result in the file") : "";
  const emptyReason = hyp.some((l) => !l.first.trim()) || missing ? seg?.missingStage ?? "filtered or blank (unknown which)" : "";

  let l1Fields: FieldCodes = {};
  let l2Fields: FieldCodes | null = null;
  let l3Fields: FieldCodes | null = null;
  let l4: WorkflowCode | null = null;
  let l4Note = "";
  let turns: number | null = null;
  let correctField: number | null = null;
  const { lines: caseLines } = toCaseLines(segs, callerParts(c.caller).map((p) => p.pauseBeforeS));
  // Timing needs measured times on this segment's own lines: a start, an end and a first-text delay each.
  const segTimed = hyp.length > 0 && hyp.every((l) => l.start !== undefined && l.end !== undefined && l.firstTextS !== undefined);
  if (segment === "C") {
    l1Fields = textFieldCodes(c, l1Lines);
    l2Fields = l2Lines ? textFieldCodes(c, l2Lines) : null;
    // The agent's cue comes from the file when present, otherwise from the reference (reported in the note).
    const cue = caseLines.some((l) => l.side === "agent") ? caseLines : [{ side: "agent" as const, first: c.agent, start: 0, end: 2 }, ...caseLines];
    const w = runCase(c, cue, { timed: segTimed });
    l3Fields = fieldsOf(c).length ? w.l3 : null;
    l4 = w.l4;
    l4Note = [w.note, cue === caseLines ? "" : "agent cue from the reference"].filter(Boolean).join("; ");
    turns = w.confirmationTurns;
    correctField = w.correctFieldS;
  }
  const segEnd = segTimed ? Math.max(...hyp.map((l) => l.end!)) : 0;
  const last = hyp[hyp.length - 1];
  const timing = {
    firstText: segTimed ? ms(last.firstTextS!) : null,
    checkedText: segTimed && last.checked !== undefined && last.checkS !== undefined ? ms(last.firstTextS! + last.checkS) : null,
    usableText: segTimed ? ms(finite(Math.max(...hyp.map((l) => l.end! + l.firstTextS! + (l.checked !== undefined ? l.checkS ?? NaN : 0))) - segEnd)) : null,
    correctField: segment === "C" && segTimed ? correctField : null,
    engine: hyp.flatMap((l) => (l.engineResponseS !== undefined ? [l.engineResponseS] : [])),
  };
  const hypWords = conventionalWords(l1Lines.join(" ")).length;
  const row: Row = {
    case_id: c.id,
    manifest_version: MANIFEST_VERSION,
    segment,
    role: segment === "A" ? "agent" : "caller",
    speaker: seg?.speaker ?? "",
    take: seg?.take !== undefined ? String(seg.take) : "",
    route: file.route,
    audio_variant: seg?.audioVariant ?? "",
    duration_s: r3(seg?.durationS),
    config_id: file.configId,
    run_no: file.runNo !== undefined ? String(file.runNo) : "",
    cold_or_warm: file.coldOrWarm ?? "",
    reference,
    L0_phrases: seg?.l0Phrases !== undefined ? String(seg.l0Phrases) : "",
    L0_cut_points: seg?.l0CutPoints?.join("|") ?? "",
    L1_text: l1Lines.join(" | "),
    L1_empty_reason: emptyReason,
    L2_text: l2Lines ? l2Lines.join(" | ") : "",
    L2_check_time_s: hyp.map((l) => r3(l.checkS)).filter(Boolean).join("|"),
    fields_expected: segment === "C" ? fieldsOf(c).map((f) => `${f}=${f === "address" ? "all parts" : String(c.expected[f as keyof DevCase["expected"]] ?? "none")}`).join("; ") : "",
    L1_field_codes: codesText(segment === "C" ? l1Fields : null),
    L2_field_codes: codesText(l2Fields),
    L3_field_codes: codesText(l3Fields),
    words_ref: String(l1.ref),
    sub: String(l1.sub),
    del: String(l1.del),
    ins: String(l1.ins),
    wer: r3(errorRate(l1)),
    nc_er: r3(errorRate(l1.nc)),
    invented_words: expectsSpeech ? "" : String(hypWords),
    t_end_method: segTimed ? seg?.tEndMethod ?? "unspecified" : "",
    first_text_s: r3(timing.firstText),
    checked_text_s: r3(timing.checkedText),
    usable_text_s: r3(timing.usableText),
    correct_field_s: r3(timing.correctField),
    engine_response_s: timing.engine.map((n) => r3(n)).join("|"),
    queue_s: hyp.some((l) => l.queueS !== undefined) ? hyp.map((l) => r3(l.queueS)).join("|") : "unknown",
    decode_s: hyp.some((l) => l.decodeS !== undefined) ? hyp.map((l) => r3(l.decodeS)).join("|") : "unknown",
    workflow_start_state: segment === "C" ? c.startStateText : "",
    L4_outcome: l4 ?? "",
    confirmation_turns: turns !== null ? String(turns) : "",
    missing_stage: missingStage,
    reviewer_note: [seg?.note ?? "", file.kind === "measurement" && seg && referenceFrom === "script" ? "scored against the script: no listener reference in the file" : ""].filter(Boolean).join("; "),
    kind: file.kind,
    L2_sub: l2 ? String(l2.sub) : "",
    L2_del: l2 ? String(l2.del) : "",
    L2_ins: l2 ? String(l2.ins) : "",
    L2_wer: l2 ? r3(errorRate(l2)) : "",
    L2_nc_er: l2 ? r3(errorRate(l2.nc)) : "",
    L4_note: l4Note,
  };
  return {
    row,
    score: {
      caseId: c.id,
      segment,
      l1,
      l2,
      inventedWords: expectsSpeech ? null : hypWords,
      l1Fields,
      l2Fields,
      l3Fields,
      l4,
      l4Note,
      confirmationTurns: turns,
      referenceFrom,
      missing,
      missingStage,
      timing,
    },
  };
}

/** Every case, both segments, in case order. */
export function scoreFile(file: HypothesisFile): Report {
  const rows: Row[] = [];
  const scores: SegmentScore[] = [];
  for (const c of CASES) {
    for (const segment of ["A", "C"] as const) {
      const { row, score } = scoreSegment(file, c, segment);
      rows.push(row);
      scores.push(score);
    }
  }
  return { file, rows, scores };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: Row[]) => [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((k) => csvCell(r[k])).join(","))].join("\n") + "\n";

/* ---------- Summary ---------- */

/** Conventional median: the mean of the two middle values when the count is even (not the console's upper middle, I-08). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** p90 by nearest rank: the value at rank ⌈0.9 n⌉. */
export function p90(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

/** The plan's target for usable text, beside the observation. Never "passed". */
export function targetVerdict(xs: number[], missing: number): string {
  if (!xs.length) return "not demonstrated (no timed results)";
  return median(xs)! <= 1.5 && p90(xs)! <= 2.5 && missing === 0 ? "not contradicted by this small sample" : "not demonstrated";
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const sec = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)} s`);

export function summary(report: Report, code: { matchesB0: boolean; files: { path: string; matches: boolean }[] }): string {
  const { file, scores } = report;
  const out: string[] = [];
  const fixture = file.kind === "fixture";
  out.push(`# Step 7 harness report: ${file.label ?? file.configId}`, "");
  out.push(
    fixture
      ? "> **Harness check on controlled fixture text. This is not a speech accuracy or latency result.** The text was written, not recognised from audio, so it shows what the scorer and the copilot rules do with this exact text, nothing about the recognizer or timing."
      : "> **Measurement.** Recognizer output scored with Step 7 v1 rules. Every result is an observation; no target is marked passed.",
    ""
  );
  out.push(`- Manifest: Step 7 ${file.manifestVersion} (frozen). Configuration: ${file.configId}. Route: ${file.route}.${file.runNo !== undefined ? ` Run ${file.runNo}${file.coldOrWarm ? ` (${file.coldOrWarm})` : ""}.` : ""}`);
  out.push(
    code.matchesB0
      ? "- Copilot code run: matches B0 (5bb7bf2 / 4883603), file by file."
      : `- Copilot code run: **differs from B0** in ${code.files.filter((f) => !f.matches).map((f) => f.path).join(", ")}. These results are not the baseline.`
  );
  out.push("- Workflow (L4): each case on a new call, from its own starting state and evaluation record; nothing carries over between cases.");
  if (!fixture) {
    const fromScript = scores.filter((s) => s.referenceFrom === "script" && file.cases[s.caseId as CaseId]?.[s.segment]).length;
    out.push(
      fromScript
        ? `- References: **${fromScript} segment(s) scored against the script**, not a listener's transcript of the recording. v1 scores what was actually said, so word scores for those segments are provisional.`
        : "- References: every segment scored against the listener's transcript of the recording."
    );
  }
  out.push("");

  out.push("## Words", "", "| Channel | Layer | Segments | Ref words | S | D | I | Conventional WER | NC-ER (number-collapsed; not WER) |", "|---|---|---|---|---|---|---|---|---|");
  for (const seg of ["C", "A"] as const) {
    for (const layer of ["L1", "L2"] as const) {
      const xs = scores.filter((s) => s.segment === seg && s.inventedWords === null && (layer === "L1" || s.l2));
      if (!xs.length) continue;
      const pick = (s: SegmentScore) => (layer === "L1" ? s.l1 : s.l2!);
      const sum = (f: (c: ErrorCounts) => number, nc = false) => xs.reduce((n, s) => n + f(nc ? pick(s).nc : pick(s)), 0);
      const tot: ErrorCounts = { ref: sum((c) => c.ref), sub: sum((c) => c.sub), del: sum((c) => c.del), ins: sum((c) => c.ins) };
      const nc: ErrorCounts = { ref: sum((c) => c.ref, true), sub: sum((c) => c.sub, true), del: sum((c) => c.del, true), ins: sum((c) => c.ins, true) };
      out.push(`| ${seg === "C" ? "Caller" : "Agent"} | ${layer} | ${xs.length} | ${tot.ref} | ${tot.sub} | ${tot.del} | ${tot.ins} | ${pct(errorRate(tot))} | ${pct(errorRate(nc))} |`);
    }
  }
  const d10 = scores.find((s) => s.caseId === "D10" && s.segment === "C");
  out.push("", `L2 rows cover only segments with a checked line. Invented words in D10 (no speech): ${d10?.inventedWords ?? "n/a"}.`, "");

  out.push("## Critical fields", "", "| Case | Field | L1 first pass | L2 checked | L3 copilot read |", "|---|---|---|---|---|");
  const cell = (codes: FieldCodes | null, f: string) => {
    const r = codes?.[f as keyof FieldCodes];
    return r ? `${r.code}${r.note ? ` (${r.note})` : ""}` : "—";
  };
  for (const s of scores.filter((x) => x.segment === "C")) {
    const c = CASES.find((x) => x.id === s.caseId)!;
    for (const f of fieldsOf(c)) out.push(`| ${s.caseId} | ${f} | ${cell(s.l1Fields, f)} | ${cell(s.l2Fields, f)} | ${cell(s.l3Fields, f)} |`);
  }
  const effect = { fixed: 0, broke: 0, bothOk: 0, bothWrong: 0 };
  for (const s of scores.filter((x) => x.segment === "C" && x.l2Fields)) {
    for (const [f, r1] of Object.entries(s.l1Fields)) {
      const r2 = s.l2Fields![f as keyof FieldCodes];
      if (!r1 || !r2) continue;
      const [a, b] = [r1.code === "OK", r2.code === "OK"];
      if (!a && b) effect.fixed++;
      else if (a && !b) effect.broke++;
      else if (a && b) effect.bothOk++;
      else effect.bothWrong++;
    }
  }
  out.push("", `Checker effect, paired L1 → L2 on checked segments: fixed ${effect.fixed}, broke ${effect.broke}, both OK ${effect.bothOk}, both wrong ${effect.bothWrong}.`, "");

  out.push("## Workflow (L4), each case from its own starting state", "", "| Case | Starting state | L4 | What the copilot did | Confirmation turns |", "|---|---|---|---|---|");
  for (const s of scores.filter((x) => x.segment === "C")) {
    const c = CASES.find((x) => x.id === s.caseId)!;
    out.push(`| ${s.caseId} | ${c.startStateText} | ${s.l4} | ${s.l4Note || "—"} | ${s.confirmationTurns ?? ""} |`);
  }
  const unsafe = scores.filter((s) => s.l4 === "UNSAFE").length;
  out.push("", `UNSAFE observed: ${unsafe}. The plan's rule is zero observed in this suite; this is an observation on ${fixture ? "fixture text" : "these results"}, not a pass.`, "");

  const missing = scores.filter((s) => s.missing);
  out.push("## Missing results", "", missing.length ? missing.map((s) => `- ${s.caseId} ${s.segment}: ${s.missingStage}`).join("\n") : "None. Missing results always stay in the denominators.", "");

  out.push("## Timing");
  if (fixture) {
    out.push("", "Not reported: fixture text carries no timing. Timing comes only from a measurement (Tier 2 call for usable text; Tier 1 replay for engine response).", "");
  } else {
    out.push("", "| Measure | Channel | Count | Median | p90 (nearest rank) | Max | Missing |", "|---|---|---|---|---|---|---|");
    const measures = [
      ["First text", "firstText"],
      ["Checked text", "checkedText"],
      ["Usable text (the target's measure)", "usableText"],
      ["Correct field", "correctField"],
    ] as const;
    let usable: number[] = [];
    let usableMissing = 0;
    for (const [label, key] of measures) {
      for (const seg of ["C", "A"] as const) {
        if (key === "correctField" && seg === "A") continue;
        const xs = scores.filter((s) => s.segment === seg && (seg === "A" || s.inventedWords === null));
        const vals = xs.flatMap((s) => (s.timing[key] !== null ? [s.timing[key] as number] : []));
        const miss = key === "checkedText" ? 0 : xs.length - vals.length;
        if (key === "usableText") {
          usable = usable.concat(vals);
          usableMissing += miss;
        }
        out.push(`| ${label} | ${seg === "C" ? "Caller" : "Agent"} | ${vals.length} | ${sec(median(vals))} | ${sec(p90(vals))} | ${sec(vals.length ? Math.max(...vals) : null)} | ${miss} |`);
      }
    }
    out.push("", `Target for usable text (live path): median ≤ 1.5 s and p90 ≤ 2.5 s. Observed: ${targetVerdict(usable, usableMissing)}. Ten cases can't certify a p90.`, "");
    const engine = scores.flatMap((s) => s.timing.engine);
    out.push(
      engine.length
        ? `Engine response (Tier 1; request to response, not speech end to screen, never compared with the target): count ${engine.length}, median ${sec(median(engine))}, p90 ${sec(p90(engine))}, max ${sec(Math.max(...engine))}.`
        : "Engine response: none in this file.",
      ""
    );
  }
  return out.join("\n");
}
