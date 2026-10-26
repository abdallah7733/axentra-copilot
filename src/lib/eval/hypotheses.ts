/*
  What the harness scores: a hypotheses file, one entry per case and segment, holding the lines the
  recognizer returned (Tier 1 replay or Tier 2 call), or controlled fixture text written to check the
  harness itself. A file says which it is ("kind"), and the report carries that label everywhere:
  fixtures check the harness, they are never speech accuracy or latency results.
*/

import { CASES, callerParts, caseById, MANIFEST_VERSION, type CaseId, type DevCase } from "./cases";
import { saysNegatedRefund, textFieldCodes } from "./fields";
import { collapsedTokens, normalizeText, tagReference, type NumToken, type RangeToken } from "./normalize";
import type { CaseLine } from "./workflow";

/** One recognised line. Delays are seconds after the line's end of speech, as the console shows them. */
export type HypLine = {
  /** First-pass text (L1), after the engine's filters. "" for an empty result or a failed request. */
  first: string;
  /** Checked text (L2), when the line went to the second model and it answered with text. */
  checked?: string;
  /** The check failed, timed out or came back empty: the first text stands, marked doubtful. */
  checkFailed?: boolean;
  /** The first pass's confidence. */
  confidence?: number | null;
  /** The check model's own confidence, only with "checked": the console scores a checked line with it (store.ts). */
  checkedConfidence?: number | null;
  /** Start and end of speech, seconds from the start of the case. Synthesized when absent (and reported so). */
  start?: number;
  end?: number;
  /** First text on screen, seconds after the end of speech. Live calls only: a replay has no screen. */
  firstTextS?: number;
  /** "Checked in": seconds from the first text to the checked text. Live calls only. */
  checkS?: number;
  /**
   * Tier 1 only: when the console's splitter released the phrase, seconds on the case clock (pause end,
   * the 12 s cut, or the end of the file). With the engine times it places the line for the check emulation.
   */
  emittedS?: number;
  /** Tier 1 only: request sent to response received, first pass answered 200. Never compared with the target. */
  engineResponseS?: number;
  /** Tier 1 only: the same for the check request (the second model, answered 200, empty text included), reported apart. */
  checkEngineResponseS?: number;
  /** Tier 1 only: the engine's own elapsedMs / 1000, first pass and check. */
  engineElapsedS?: number;
  checkEngineElapsedS?: number;
  /** Tier 1 only: a first pass with no usable answer ("HTTP 502", "timeout after 130000 ms"), and how long after sending. "first" is then "". */
  engineFailure?: EngineFailure;
  /** Tier 1 only: the same for the check ("HTTP 503", "timeout after 9000 ms"). Not for a 200 with empty text. */
  checkEngineFailure?: EngineFailure;
  queueS?: number;
  decodeS?: number;
};

/** A request that got no usable answer: what happened, and seconds from sending until it failed. */
export type EngineFailure = { outcome: string; afterS: number };

export type HypSegment = {
  lines: HypLine[];
  /**
   * What was actually said, written by a listener from the recording, with [pause N s] and [unclear]
   * marks (cases file, sections 4 and 5). It is the scored reference. When absent the script is used,
   * and a measurement row says so.
   */
  reference?: string;
  /** Who checked the reference: "speaker (one playback; …)" or "second listener: <name>". Absent for the script. */
  referenceCheckedBy?: string;
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
  /**
   * "all": the replay checked every caller line, so L2 scores every check, and the copilot (L3, L4) uses a
   * checked text only where the console would have asked for it. Absent or "console": a checked text is
   * one the console asked for (a live call), and the copilot uses it.
   */
  checks?: "console" | "all";
  cases: Partial<Record<CaseId, { A?: HypSegment; C?: HypSegment }>>;
};

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Where a case's line times came from: the console's screen, the replay's own measures, or made up. */
export type TimesMethod = "measured" | "estimated" | "synthesized";

/**
 * Lines with times, per line:
 * - measured (a live call): first text at end + firstTextS, checked text checkS after it;
 * - estimated (a replay): each side's first passes wait in turn, as in the console's per-side queue
 *   (store.ts sideSink), so first text at max(phrase release, the side's previous first text) + the
 *   engine's time, and the check lands its own engine time later (2 s when unknown);
 * - synthesized, otherwise: the agent's cue from 0 s, the caller 1 s after it, each line 0.3 s a word
 *   (at least 0.5 s), 1 s between caller lines, first text 1 s after the end, checks 2 s.
 * Synthesized times order the lines and decide whether two caller lines are one answer, and in a
 * checks "all" file which lines the console would hold for a check. Estimated and synthesized times
 * are never reported as timing.
 */
export function toCaseLines(seg: { A?: HypSegment; C?: HypSegment }, pausesS: number[] = []): { lines: CaseLine[]; times: TimesMethod } {
  const lines: CaseLine[] = [];
  const used = new Set<TimesMethod>();
  let clock = 0;
  for (const side of ["agent", "caller"] as const) {
    const s = side === "agent" ? seg.A : seg.C;
    let queueFree = -Infinity;
    (s?.lines ?? []).forEach((h, i) => {
      const text = h.checked ?? h.first;
      const start = h.start ?? clock + (side === "caller" ? (i === 0 ? 1 : pausesS[i] ?? 1) : 0);
      const end = h.end ?? start + Math.max(0.5, 0.3 * words(text));
      clock = end;
      const engineS = h.engineResponseS ?? h.engineFailure?.afterS;
      const method: TimesMethod = h.firstTextS !== undefined ? "measured" : h.emittedS !== undefined && engineS !== undefined ? "estimated" : "synthesized";
      used.add(method);
      const firstAt = method === "measured" ? end + h.firstTextS! : method === "estimated" ? Math.max(h.emittedS!, queueFree) + engineS! : end + 1;
      queueFree = firstAt;
      const checkDuration = method === "measured" ? h.checkS ?? 2 : method === "estimated" ? h.checkEngineResponseS ?? h.checkEngineFailure?.afterS ?? 2 : 2;
      const checkedAt = firstAt + checkDuration;
      lines.push({
        side,
        first: h.first,
        ...(h.checked !== undefined ? { checked: h.checked, checkedAt, ...(h.checkedConfidence !== undefined ? { checkedConfidence: h.checkedConfidence } : {}) } : {}),
        ...(h.checkFailed ? { checkFailed: true, ...(method === "estimated" ? { checkedAt } : {}) } : {}),
        ...(h.checkEngineElapsedS !== undefined && (h.checked !== undefined || h.checkFailed) ? { checkEngineS: h.checkEngineElapsedS } : {}),
        // A check that timed out can't have landed before its own wait.
        ...(h.checkFailed && h.checkEngineFailure && /^timeout\b/i.test(h.checkEngineFailure.outcome) ? { checkEngineS: h.checkEngineFailure.afterS } : {}),
        confidence: h.confidence ?? 0.9,
        start,
        end,
        firstAt,
      });
    });
  }
  return { lines, times: used.has("estimated") ? "estimated" : used.has("measured") ? "measured" : "synthesized" };
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

const SPAN_NAMES: Record<string, string> = {
  ORDER_ID: "order number", ORDER_ID_SUPERSEDED: "corrected order number", AMOUNT: "amount", HOUSE_NO: "house number",
  RANGE: "range", NAME: "name", STREET: "street", CITY: "city",
};

/**
 * What in a reference differs from the case's tagged spans, by value: order digits, amounts and house
 * numbers, the range's ends and unit, a name's, street's or city's words in order, and how many times
 * "no" is said. Empty when it matches. Throws when its numbers can't be paired with the spans at all.
 */
export function referenceMismatches(spans: DevCase["spans"], reference: string): string[] {
  const tokens = tagReference(collapsedTokens(reference), spans);
  const out: string[] = [];
  const nums = tokens.filter((t): t is NumToken => t.kind === "num");
  spans
    .filter((s) => /^(ORDER_ID|ORDER_ID_SUPERSEDED|AMOUNT|HOUSE_NO)$/.test(s.tag))
    .forEach((s, i) => {
      const t = nums[i];
      const byValue = s.tag === "AMOUNT" || s.tag === "HOUSE_NO";
      if (byValue ? t.value !== Number(s.canonical) : t.digits !== s.canonical) out.push(`${SPAN_NAMES[s.tag]} "${t.text}" where the case has ${s.canonical}`);
    });
  const ranges = tokens.filter((t): t is RangeToken => t.kind === "range");
  spans
    .filter((s) => s.tag === "RANGE")
    .forEach((s, i) => {
      const [, from, to, unit] = /^(\d+)-(\d+)\s+(\w+)$/.exec(s.canonical ?? "") ?? [];
      const t = ranges[i];
      if (t.from !== Number(from) || t.to !== Number(to) || t.unit !== unit?.replace(/s$/, "")) out.push(`range "${t.text}" where the case has ${s.canonical}`);
    });
  const words = normalizeText(reference).words;
  for (const s of spans.filter((x) => x.tag === "NAME" || x.tag === "STREET" || x.tag === "CITY")) {
    const want = normalizeText(s.canonical ?? "").words;
    let k = 0;
    for (const w of words) if (w === want[k]) k++;
    if (k < want.length) out.push(`no ${SPAN_NAMES[s.tag]} "${s.canonical}"`);
  }
  for (const s of spans.filter((x) => x.tag === "NEG")) {
    const n = words.filter((w) => w === "no").length;
    if (n !== s.count) out.push(`"no" ${n} time(s) where the case has ${s.count}`);
  }
  return out;
}

/** Every key a file, a segment and a line may carry. Any other key is refused, so a misspelt one isn't silently ignored. */
const FILE_KEYS: Record<keyof HypothesisFile, true> = { manifestVersion: true, kind: true, configId: true, route: true, runNo: true, coldOrWarm: true, label: true, checks: true, cases: true };
const SEGMENT_KEYS: Record<keyof HypSegment, true> = {
  lines: true, reference: true, referenceCheckedBy: true, take: true, speaker: true, audioVariant: true, durationS: true, l0Phrases: true, l0CutPoints: true,
  missingStage: true, tEndMethod: true, note: true,
};
const LINE_KEYS: Record<keyof HypLine, true> = {
  first: true, checked: true, checkFailed: true, confidence: true, checkedConfidence: true, start: true, end: true, firstTextS: true, checkS: true, emittedS: true,
  engineResponseS: true, checkEngineResponseS: true, engineElapsedS: true, checkEngineElapsedS: true, engineFailure: true, checkEngineFailure: true, queueS: true, decodeS: true,
};
const unknownKeys = (x: unknown, known: object) => (x && typeof x === "object" ? Object.keys(x).filter((k) => !Object.hasOwn(known, k)) : []);
const listKeys = (keys: string[]) => `unknown key(s) ${keys.map((k) => `"${k}"`).join(", ")} (a misspelt key would be ignored silently)`;
const RETAKE = "a misread number, name, address or choice means re-recording the take";

/** Checks a file's shape before scoring, so a typo can't turn into a silent "missing". */
export function validate(file: unknown): HypothesisFile {
  const errors: string[] = [];
  const f = file as HypothesisFile;
  if (!f || typeof f !== "object") throw new Error("Hypotheses file is not a JSON object");
  const fileExtra = unknownKeys(f, FILE_KEYS);
  if (fileExtra.length) errors.push(`top of the file: ${listKeys(fileExtra)}`);
  if (f.manifestVersion !== MANIFEST_VERSION) errors.push(`manifestVersion must be "${MANIFEST_VERSION}" (got ${JSON.stringify(f.manifestVersion)})`);
  if (f.kind !== "fixture" && f.kind !== "measurement") errors.push(`kind must be "fixture" or "measurement"`);
  if (typeof f.configId !== "string" || !f.configId) errors.push("configId is required");
  if (typeof f.route !== "string" || !f.route) errors.push("route is required");
  if (f.checks !== undefined && f.checks !== "console" && f.checks !== "all") errors.push(`checks must be "console" or "all"`);
  const ids = new Set(CASES.map((c) => c.id));
  for (const [id, segs] of Object.entries(f.cases ?? {})) {
    if (!ids.has(id as CaseId)) errors.push(`unknown case ${id}`);
    for (const [name, seg] of Object.entries(segs ?? {})) {
      if (name !== "A" && name !== "C") errors.push(`${id}: unknown segment ${name}`);
      const segExtra = unknownKeys(seg, SEGMENT_KEYS);
      if (segExtra.length) errors.push(`${id}.${name}: ${listKeys(segExtra)}`);
      if (seg?.reference !== undefined) {
        if (typeof seg.reference !== "string") errors.push(`${id}.${name}: reference must be text`);
        else if (ids.has(id as CaseId) && (name === "A" || name === "C")) {
          // The reference must carry the case's tagged values, in order (agent cues have none): a misread means a new take.
          const c = caseById(id as CaseId);
          let differs: string[];
          try {
            differs = referenceMismatches(name === "C" ? c.spans : [], seg.reference);
          } catch (e) {
            differs = [(e as Error).message];
          }
          if (differs.length) errors.push(`${id}.${name}: reference doesn't match the case's tagged numbers and words (${differs.join("; ")}); ${RETAKE}`);
          else if (name === "C") {
            // Read as text, the reference must give every critical field the case expects: D03's "a replacement, not a refund" too.
            const wrong = Object.entries(textFieldCodes(c, [seg.reference])).filter(([, r]) => r?.code !== "OK");
            if (wrong.length) errors.push(`${id}.${name}: reference doesn't give the case's expected ${wrong.map(([k, r]) => `${k} (read ${r!.code}${r!.note ? `: ${r!.note}` : ""})`).join(", ")}; ${RETAKE}`);
            // A take that leaves the refund out reads refund_wanted OK, but can't show the hazard: a negated refund taken as wanted.
            else if (c.expected.refund_wanted === false && !saysNegatedRefund(seg.reference))
              errors.push(`${id}.${name}: reference doesn't say the refund and its negation after the replacement ("replacement", then "not", then "refund"), so it can't show the case's negated refund; ${RETAKE}`);
          }
        }
      }
      if (seg?.referenceCheckedBy !== undefined && typeof seg.referenceCheckedBy !== "string") errors.push(`${id}.${name}: referenceCheckedBy must be text`);
      if (seg?.referenceCheckedBy !== undefined && seg.reference === undefined) errors.push(`${id}.${name}: referenceCheckedBy says who checked the reference, but the segment has no reference`);
      if (!Array.isArray(seg?.lines)) errors.push(`${id}.${name}: lines must be a list`);
      else
        seg.lines.forEach((l: HypLine, i: number) => {
          const at = `${id}.${name}.lines[${i}]`;
          const lineExtra = unknownKeys(l, LINE_KEYS);
          if (lineExtra.length) errors.push(`${at}: ${listKeys(lineExtra)}`);
          if (typeof l?.first !== "string") errors.push(`${at}: "first" text is required ("" for an empty result)`);
          if (l?.checked !== undefined && typeof l.checked !== "string") errors.push(`${at}: "checked" must be text`);
          if (l?.checkFailed !== undefined && typeof l.checkFailed !== "boolean") errors.push(`${at}: checkFailed must be true or false`);
          for (const k of ["confidence", "checkedConfidence"] as const) {
            if (l?.[k] !== undefined && l[k] !== null && typeof l[k] !== "number") errors.push(`${at}: ${k} must be a number or null`);
          }
          if (l?.checkedConfidence !== undefined && l.checked === undefined) errors.push(`${at}: checkedConfidence is the check's own confidence, so it needs "checked"`);
          for (const k of ["start", "end", "firstTextS", "checkS", "emittedS", "engineResponseS", "checkEngineResponseS", "engineElapsedS", "checkEngineElapsedS", "queueS", "decodeS"] as const) {
            if (l?.[k] !== undefined && typeof l[k] !== "number") errors.push(`${at}: ${k} must be a number of seconds`);
            else if (typeof l?.[k] === "number" && l[k] < 0) errors.push(`${at}: ${k} is a number of seconds, so it can't be negative`);
          }
          for (const k of ["engineFailure", "checkEngineFailure"] as const) {
            const x = l?.[k];
            if (x !== undefined && (typeof x !== "object" || x === null || typeof x.outcome !== "string" || typeof x.afterS !== "number")) errors.push(`${at}: ${k} must be { outcome: text, afterS: seconds }`);
            else if (x !== undefined && x.afterS < 0) errors.push(`${at}: ${k}.afterS is seconds from sending, so it can't be negative`);
          }
          // Each request either answered or got no usable answer, never both; a failed one leaves no text.
          if (l?.engineFailure !== undefined) {
            if (l.engineResponseS !== undefined) errors.push(`${at}: engineResponseS (answered) and engineFailure (no usable answer) can't both be there`);
            if (typeof l.first === "string" && l.first.trim()) errors.push(`${at}: engineFailure means the first pass got no usable answer, so "first" must be ""`);
          }
          if (l?.checkEngineFailure !== undefined) {
            if (l.checkEngineResponseS !== undefined) errors.push(`${at}: checkEngineResponseS (answered) and checkEngineFailure (no usable answer) can't both be there`);
            if (l.checkFailed !== true) errors.push(`${at}: checkEngineFailure means the check failed, so checkFailed must be true`);
          }
          // The engine's own time comes with an answer only.
          if (l?.engineFailure !== undefined && l.engineElapsedS !== undefined) errors.push(`${at}: engineElapsedS is the engine's time for an answer, so it can't be there with engineFailure`);
          if (l?.checkEngineFailure !== undefined && l.checkEngineElapsedS !== undefined) errors.push(`${at}: checkEngineElapsedS is the engine's time for an answer, so it can't be there with checkEngineFailure`);
          // An answered check gives checked text, or checkFailed when it came back empty.
          for (const k of ["checkEngineResponseS", "checkEngineElapsedS"] as const) {
            if (l?.[k] !== undefined && l.checked === undefined && !l.checkFailed) errors.push(`${at}: ${k} is the time of a check, so the line needs "checked" text or checkFailed`);
          }
          if (l?.checked !== undefined && (l.checkFailed || l.checkEngineFailure !== undefined)) errors.push(`${at}: "checked" text means the check answered, so checkFailed and checkEngineFailure can't be there too`);
          // A replay has no screen: its check emulation uses emittedS and the engine times, never screen times.
          if (f.checks === "all" && (l?.firstTextS !== undefined || l?.checkS !== undefined)) errors.push(`${at}: firstTextS and checkS are console screen times, which a replay (checks "all") doesn't have; leave them out`);
        });
    }
  }
  if (!f.cases || typeof f.cases !== "object") errors.push("cases is required");
  if (errors.length) throw new Error(`Hypotheses file is not valid:\n- ${errors.join("\n- ")}`);
  return f;
}
