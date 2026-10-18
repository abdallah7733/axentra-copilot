/*
  What the harness scores: a hypotheses file, one entry per case and segment, holding the lines the
  recognizer returned (Tier 1 replay or Tier 2 call), or controlled fixture text written to check the
  harness itself. A file says which it is ("kind"), and the report carries that label everywhere:
  fixtures check the harness, they are never speech accuracy or latency results.
*/

import { CASES, callerParts, caseById, MANIFEST_VERSION, type CaseId, type DevCase } from "./cases";
import { collapsedTokens, tagReference } from "./normalize";
import type { CaseLine } from "./workflow";

/** One recognised line. Delays are seconds after the line's end of speech, as the console shows them. */
export type HypLine = {
  /** First-pass text (L1), after the engine's filters. "" for an empty result. */
  first: string;
  /** Checked text (L2), when the line went to the second model. */
  checked?: string;
  checkFailed?: boolean;
  confidence?: number | null;
  /** Start and end of speech, seconds from the start of the case. Synthesized when absent (and reported so). */
  start?: number;
  end?: number;
  /** First text on screen, seconds after the end of speech. */
  firstTextS?: number;
  /** "Checked in": seconds from the first text to the checked text. */
  checkS?: number;
  /** Tier 1 only: request sent to response received. Never compared with the target. */
  engineResponseS?: number;
  queueS?: number;
  decodeS?: number;
};

export type HypSegment = {
  lines: HypLine[];
  /**
   * What was actually said, written by a listener from the recording, with [pause N s] and [unclear]
   * marks (cases file, sections 4 and 5). It is the scored reference. When absent the script is used,
   * and a measurement row says so.
   */
  reference?: string;
  take?: number;
  speaker?: string;
  audioVariant?: string;
  durationS?: number;
  l0Phrases?: number;
  l0CutPoints?: number[];
  /** Why there is no text, when known: "L0", "L1 filtered or blank (unknown which)", "request failed", "cause unknown". */
  missingStage?: string;
  /** How end of speech was found: "waveform reference" (replay) or "console estimate" (live). */
  tEndMethod?: string;
  note?: string;
};

export type HypothesisFile = {
  manifestVersion: string;
  /** "fixture": controlled text that checks the harness. "measurement": real recognizer output. */
  kind: "fixture" | "measurement";
  configId: string;
  route: string;
  runNo?: number;
  coldOrWarm?: "cold" | "warm";
  label?: string;
  cases: Partial<Record<CaseId, { A?: HypSegment; C?: HypSegment }>>;
};

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * Lines with times. Missing times are synthesized: the agent's cue from 0 s, the caller 1 s after it,
 * each line 0.3 s a word (at least 0.5 s), and 1 s between caller lines. Synthesized times only place
 * the lines in order and decide whether two caller lines are one answer; they are never reported as timing.
 */
export function toCaseLines(seg: { A?: HypSegment; C?: HypSegment }, pausesS: number[] = []): { lines: CaseLine[] } {
  const lines: CaseLine[] = [];
  let clock = 0;
  for (const side of ["agent", "caller"] as const) {
    const s = side === "agent" ? seg.A : seg.C;
    (s?.lines ?? []).forEach((h, i) => {
      const text = h.checked ?? h.first;
      const start = h.start ?? clock + (side === "caller" ? (i === 0 ? 1 : pausesS[i] ?? 1) : 0);
      const end = h.end ?? start + Math.max(0.5, 0.3 * words(text));
      clock = end;
      const firstAt = end + (h.firstTextS ?? 1);
      lines.push({
        side,
        first: h.first,
        ...(h.checked !== undefined ? { checked: h.checked, checkedAt: firstAt + (h.checkS ?? 2) } : {}),
        ...(h.checkFailed ? { checkFailed: true } : {}),
        confidence: h.confidence ?? 0.9,
        start,
        end,
        firstAt,
      });
    });
  }
  return { lines };
}

/** The reference itself as recognised text: agent cue, then the caller split at its pauses. */
export function referenceSegments(c: DevCase, rewrite: (caseId: CaseId, part: string, i: number) => string = (_, p) => p): { A: HypSegment; C: HypSegment } {
  const parts = callerParts(c.caller);
  let clock = Math.max(0.5, 0.3 * words(c.agent));
  const lines: HypLine[] = parts.map((p, i) => {
    const text = rewrite(c.id, p.text, i);
    const start = clock + (i === 0 ? 1 : p.pauseBeforeS);
    const end = start + Math.max(0.5, 0.3 * words(p.text));
    clock = end;
    return { first: text, start, end };
  });
  return { A: { lines: [{ first: c.agent, start: 0, end: Math.max(0.5, 0.3 * words(c.agent)) }] }, C: { lines } };
}

/**
 * Number formatting a recognizer may use instead of number words ("58316", "$129", "48"). Constructed
 * text for checking the harness and the rules, not recognizer output.
 */
const NUMERALS: Partial<Record<CaseId, string[]>> = {
  D03: ["Hi. I ordered a wireless speaker last week. The site said 4 to 7 days for delivery, and it came this morning with the front grille smashed. I'd like a replacement, not a refund, please."],
  D04: ["Sure, it's order 58316. It was $129."],
  D05: ["Order 714.", "26."],
  D06: ["It's 06291. Sorry, no, 06294."],
  D08: ["48 Willow Lane", "in Portland."],
};

/** Built-in fixture sets: the reference as written, and the same with numerals. */
export function fixtureFile(variant: "reference-words" | "reference-numerals"): HypothesisFile {
  const cases: HypothesisFile["cases"] = {};
  for (const c of CASES) {
    cases[c.id] = referenceSegments(c, variant === "reference-numerals" ? (id, part, i) => NUMERALS[id]?.[i] ?? part : undefined);
  }
  return { manifestVersion: MANIFEST_VERSION, kind: "fixture", configId: `fixture:${variant}`, route: "controlled text (no audio)", label: variant, cases };
}

/** An empty file to fill in from a replay or a call: every case, both segments, one line each. */
export function templateFile(): HypothesisFile {
  const cases: HypothesisFile["cases"] = {};
  for (const c of CASES) cases[c.id] = { A: { lines: [{ first: "" }] }, C: { lines: c.caller ? [{ first: "" }] : [] } };
  return { manifestVersion: MANIFEST_VERSION, kind: "measurement", configId: "B0", route: "mac-mic replay", runNo: 1, coldOrWarm: "warm", cases };
}

/** Checks a file's shape before scoring, so a typo can't turn into a silent "missing". */
export function validate(file: unknown): HypothesisFile {
  const errors: string[] = [];
  const f = file as HypothesisFile;
  if (!f || typeof f !== "object") throw new Error("Hypotheses file is not a JSON object");
  if (f.manifestVersion !== MANIFEST_VERSION) errors.push(`manifestVersion must be "${MANIFEST_VERSION}" (got ${JSON.stringify(f.manifestVersion)})`);
  if (f.kind !== "fixture" && f.kind !== "measurement") errors.push(`kind must be "fixture" or "measurement"`);
  if (typeof f.configId !== "string" || !f.configId) errors.push("configId is required");
  if (typeof f.route !== "string" || !f.route) errors.push("route is required");
  const ids = new Set(CASES.map((c) => c.id));
  for (const [id, segs] of Object.entries(f.cases ?? {})) {
    if (!ids.has(id as CaseId)) errors.push(`unknown case ${id}`);
    for (const [name, seg] of Object.entries(segs ?? {})) {
      if (name !== "A" && name !== "C") errors.push(`${id}: unknown segment ${name}`);
      if (seg?.reference !== undefined) {
        if (typeof seg.reference !== "string") errors.push(`${id}.${name}: reference must be text`);
        else if (ids.has(id as CaseId) && (name === "A" || name === "C")) {
          // The listener's reference must carry the case's tagged numbers, in order (agent cues have none); a misread number means a new take.
          try {
            tagReference(collapsedTokens(seg.reference), name === "C" ? caseById(id as CaseId).spans : []);
          } catch (e) {
            errors.push(`${id}.${name}: reference doesn't match the case's tagged numbers (${(e as Error).message}); a misread number means re-recording the take`);
          }
        }
      }
      if (!Array.isArray(seg?.lines)) errors.push(`${id}.${name}: lines must be a list`);
      else
        seg.lines.forEach((l: HypLine, i: number) => {
          if (typeof l?.first !== "string") errors.push(`${id}.${name}.lines[${i}]: "first" text is required ("" for an empty result)`);
          if (l?.checked !== undefined && typeof l.checked !== "string") errors.push(`${id}.${name}.lines[${i}]: "checked" must be text`);
          for (const k of ["start", "end", "firstTextS", "checkS", "engineResponseS", "queueS", "decodeS"] as const) {
            if (l?.[k] !== undefined && typeof l[k] !== "number") errors.push(`${id}.${name}.lines[${i}]: ${k} must be a number of seconds`);
          }
        });
    }
  }
  if (!f.cases || typeof f.cases !== "object") errors.push("cases is required");
  if (errors.length) throw new Error(`Hypotheses file is not valid:\n- ${errors.join("\n- ")}`);
  return f;
}
