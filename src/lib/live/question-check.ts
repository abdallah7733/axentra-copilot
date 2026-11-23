/*
  C12 (his "Build C12", 23 Nov 2026): a name or address answer is checked with the agent's question in front of it. The
  check model hears the question, the real pause and the answer as one clip; the answer is cut back out of what it wrote
  and judged on its own words' scores, which the engine copy with word scores sends (his "Engine copy with word scores").
  An answer that comes back with only his question is heard again on its own, the way today's check hears it.

  The cut and the answer's own score are ported from the re-score of 23 Nov (analyse_rs.py `split` and `answer_conf`,
  re-score report Sections 7 and 8), so C12 judges answers the way that test did. Pure functions; the store sends the
  audio (store.ts checkLine).
*/

import { words } from "@/lib/copilot/text";
import { isQuestionWord, questionGap, usualDetail } from "@/lib/copilot/usual-questions";

/** One word as the check model wrote it, with its score (0 to 1). Punctuation comes as words of its own. */
export type WordScore = readonly [string, number];

/** What one check request came back with. `words` and `looped` only from the engine copy with word scores. */
export type Heard = { text: string; confidence: number | null; words?: readonly WordScore[]; looped?: boolean };

/** Lower case; anything but letters and digits becomes a space (the re-score's `norm`). */
export const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const plainWords = (text: string) => plain(text).split(" ").filter(Boolean);

/**
 * How alike two word lists are, 0 to 1: twice the words in matching runs over both lengths. The same figure as Python's
 * difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), which the re-score used.
 */
export function matchRatio(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length;
  if (!total) return 1;
  const where = new Map<string, number[]>();
  b.forEach((word, j) => {
    const list = where.get(word);
    if (list) list.push(j);
    else where.set(word, [j]);
  });
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let best: [number, number, number] = [alo, blo, 0];
    let runs = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of where.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (runs.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > best[2]) best = [i - k + 1, j - k + 1, k];
      }
      runs = next;
    }
    return best;
  };
  let matched = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    matched += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return (2 * matched) / total;
}

/**
 * Cuts the check's text into the question's part and the answer: the first words that best match the question's fast-model
 * words are the question, a cut after punctuation winning a tie. `ratio`: how well that part matched (1.001 at best).
 */
export function cutAnswer(text: string, question: string): { question: string; answer: string; ratio: number } {
  const said = text.split(/\s+/).filter(Boolean);
  const asked = plainWords(question);
  let best = -1;
  let cut = 0;
  for (let k = 0; k <= said.length; k++) {
    const score = matchRatio(plainWords(said.slice(0, k).join(" ")), asked) + (k > 0 && /[.?!,]$/.test(said[k - 1]) ? 0.001 : 0);
    if (score > best) [best, cut] = [score, k];
  }
  return { question: said.slice(0, cut).join(" "), answer: said.slice(cut).join(" "), ratio: best };
}

/**
 * A sum the way Python 3.12 and later add floats (Neumaier's compensated sum), so a mean near a half rounds as the
 * re-score's did: the scores 0.9297, 0.564 and 0.9813, added from the last word back as answerConfidence adds them,
 * come to 2.4749999999999996 there and to 2.475 with plain addition, which would round the answer's score up to 0.83
 * instead of 0.82.
 */
function pythonSum(values: readonly number[]): number {
  let sum = 0;
  let lost = 0;
  for (const value of values) {
    const next = sum + value;
    lost += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + lost;
}

/**
 * Words of his question that the fast model left off its end ("please?", "on the account?", "for the delivery?") come
 * back at the start of the answer, because the cut follows the fast model's words for his line (the re-score cut
 * against the check model's own). They go back to his part only when they are all words of his usual questions, end a
 * sentence, and leave his line at least as close to one of his usual questions: an echo of his question ("Name?") or
 * any word of the caller's own takes it further, and stays with the answer.
 */
export function moveHisTail(cut: { question: string; answer: string }, questionText: string): { question: string; answer: string } {
  const detail = usualDetail(questionText);
  if (!detail) return cut;
  const said = cut.answer.split(/\s+/).filter(Boolean);
  for (let k = 1; k <= said.length; k++) {
    if (!words(said[k - 1]).every(isQuestionWord)) return cut;
    if (!/[.?!]$/.test(said[k - 1])) continue;
    const question = [cut.question, ...said.slice(0, k)].join(" ");
    return questionGap(question, detail) <= questionGap(cut.question, detail) ? { question, answer: said.slice(k).join(" ") } : cut;
  }
  return cut;
}

/**
 * The answer's own score: the mean score of the last words the check model wrote, enough of them to spell the answer,
 * punctuation included (as the engine's own figure counts it). Null when those words don't end the way the answer does.
 */
export function answerConfidence(words: readonly WordScore[] | undefined, answer: string): number | null {
  if (!words?.length || !answer) return null;
  const target = plain(answer).replace(/ /g, "");
  let spelled = "";
  const scores: number[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    spelled = plain(words[i][0]).replace(/ /g, "") + spelled;
    scores.push(words[i][1]);
    if (spelled.length >= target.length) break;
  }
  if (!spelled.endsWith(target.slice(-Math.max(1, Math.min(target.length, 3))))) return null;
  return Math.floor((pythonSum(scores) / scores.length) * 100 + 0.5) / 100;
}

/** The audio a phrase keeps after its last voiced frame (engine.ts createSegmenter: 10 frames of 20 ms). */
export const PHRASE_TAIL_MS = 200;
/**
 * The silence put between the question's audio and the answer's: the real pause, kept within what was tested on 23 Nov
 * (0.3 s, and the 21 Nov call's real pauses of 0.95 to 1.33 s), so a longer pause is shortened to 1.5 s.
 */
export const PAUSE_MIN_S = 0.3;
export const PAUSE_MAX_S = 1.5;
/** Below this, the check's text can't be cut cleanly (the re-score's real cuts were 0.89 and up; a dropped question, 0). */
export const CUT_FLOOR = 0.6;

/**
 * Seconds of silence to put between the question and the answer, or null when the answer's audio began before the
 * question's speech ended (the caller spoke over it, or the line is an echo): then the question isn't used.
 * Epoch milliseconds as the store keeps them: a phrase's audio starts at startedAt, and its speech ends at endedAt.
 */
export function questionPause(question: { endedAtEpoch: number }, answer: { startedAtEpoch: number }): number | null {
  if (answer.startedAtEpoch < question.endedAtEpoch) return null;
  const real = (answer.startedAtEpoch - question.endedAtEpoch - PHRASE_TAIL_MS) / 1000;
  return Math.min(PAUSE_MAX_S, Math.max(PAUSE_MIN_S, real));
}

/**
 * Why the question wasn't put in front: the engine has no word scores, its audio is gone, the answer began over it, or
 * something else began between them that isn't on the console yet (still being said or still being written down).
 */
export type QuestionNotSent = "no-scores" | "no-audio" | "overlap" | "unsettled";

/**
 * Whether the question can go in front of this answer's check: only with the engine copy that returns word scores,
 * while the question's line and audio are still held, when the answer began after the question ended, and when nothing
 * else that began between them is still being heard. `heard`: when each phrase still being said or still with the fast
 * model began (epoch ms), on either side. The copilot named the question from the lines on the console; a phrase that
 * hasn't landed yet could be something said in between, so the answer keeps today's check (the two sides are written
 * down separately, so the question and the answer can land before a line said between them).
 */
export function planQuestion(input: {
  question: { text: string; startedAtEpoch: number; endedAtEpoch: number } | undefined;
  audio: Float32Array | undefined;
  answer: { startedAtEpoch: number };
  wordScores: boolean;
  heard?: readonly number[];
}): { send: { audio: Float32Array; text: string; pause: number } } | { notSent: QuestionNotSent } {
  if (!input.wordScores) return { notSent: "no-scores" };
  if (!input.question || !input.audio) return { notSent: "no-audio" };
  const pause = questionPause(input.question, input.answer);
  if (pause === null) return { notSent: "overlap" };
  const { startedAtEpoch: asked } = input.question;
  if (input.heard?.some((began) => began >= asked && began < input.answer.startedAtEpoch)) return { notSent: "unsettled" };
  return { send: { audio: input.audio, text: input.question.text, pause } };
}

/** The question's audio, `pause` seconds of silence, then the answer's audio (16 kHz). */
export function joinClip(question: Float32Array, pause: number, answer: Float32Array, rate = 16000): Float32Array {
  const gap = Math.round(pause * rate);
  const clip = new Float32Array(question.length + gap + answer.length);
  clip.set(question);
  clip.set(answer, question.length + gap);
  return clip;
}

/**
 * Whether the question can go in front on this engine, for the screen: not before the engine has answered, and only with
 * a check model that returns word scores (the engine copy with word scores); otherwise every answer keeps today's check.
 */
export const questionInCheckState = (health: { check?: boolean; wordScores?: boolean } | null): "waiting" | "no-model" | "no-scores" | "on" =>
  !health ? "waiting" : !health.check ? "no-model" : !health.wordScores ? "no-scores" : "on";

/** Why an answer sent with the question in front was heard again on its own. */
export type AloneWhy = "empty" | "only-question" | "weak-cut" | "no-scores" | "no-own-score";
export type QuestionOutcome =
  | { kind: "used"; whole: string; wholeConfidence: number | null; ratio: number; pause: number }
  | { kind: "alone"; why: AloneWhy; whole: string; pause: number };

/**
 * Checks an answer with the question in front, and falls back to today's check, the answer heard on its own, when the
 * check comes back empty or with only the question, when the question can't be cut out cleanly, or when there are no
 * word scores to judge the answer by. A failed request rejects, as today's check does: nothing is heard again then.
 * Words of his question that the fast model had left off are his, not the caller's (moveHisTail).
 */
export async function checkWithQuestion(input: {
  answer: Float32Array;
  question: Float32Array;
  questionText: string;
  pause: number;
  hear: (samples: Float32Array, words: boolean) => Promise<Heard>;
}): Promise<{ heard: Heard; outcome: QuestionOutcome }> {
  const both = await input.hear(joinClip(input.question, input.pause, input.answer), true);
  const alone = async (why: AloneWhy) => ({
    heard: await input.hear(input.answer, false),
    outcome: { kind: "alone" as const, why, whole: both.text, pause: input.pause },
  });
  if (!plain(both.text)) return alone("empty");
  if (!both.words) return alone("no-scores");
  const cut = cutAnswer(both.text, input.questionText);
  if (cut.ratio < CUT_FLOOR) return alone("weak-cut");
  const { answer } = moveHisTail(cut, input.questionText);
  if (!plain(answer)) return alone("only-question");
  const own = answerConfidence(both.words, answer);
  if (own === null) return alone("no-own-score");
  return {
    // The engine caps a looping hearing's figure at 0.5; the answer's own score keeps that cap.
    heard: { text: answer, confidence: both.looped ? Math.min(own, 0.5) : own },
    outcome: { kind: "used", whole: both.text, wholeConfidence: both.confidence, ratio: Math.round(cut.ratio * 1000) / 1000, pause: input.pause },
  };
}
