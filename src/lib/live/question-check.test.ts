import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUT_FLOOR,
  answerConfidence,
  checkWithQuestion,
  cutAnswer,
  joinClip,
  matchRatio,
  plain,
  planQuestion,
  questionPause,
  type Heard,
  type WordScore,
} from "./question-check";

/*
  C12 (his "Build C12", 23 Nov 2026): the cut and the answer's own score are the re-score's (analyse_rs.py `split` and
  `answer_conf`, 23 Nov); the values below are Python's own for the same inputs.
*/
const W = (t: string) => t.split(" ").filter(Boolean);

test("matchRatio gives Python difflib's ratio (autojunk off)", () => {
  for (const [a, b, ratio] of [
    ["and the street and city for the delivery", "and the street and city for delivery", 0.9333333333333333],
    ["a b a b c", "b a b c a", 0.8],
    ["can i have your full name please sam miller", "can i have your full name please", 0.875],
    ["the the the street", "street the the", 0.5714285714285714],
    ["x y z", "a b c", 0],
    ["", "", 1],
    ["x", "", 0],
    ["one two three two one", "two one two three", 0.6666666666666666],
  ] as const)
    assert.equal(matchRatio(W(a), W(b)), ratio, `${a} | ${b}`);
});

test("plain keeps letters and digits only, lower case", () => {
  assert.equal(plain("  Can I have your full name, please?  Sam Miller. "), "can i have your full name please sam miller");
  assert.equal(plain("?!."), "");
});

test("cutAnswer cuts the check's text after his question", () => {
  const q = "Can I have your full name, please?";
  assert.deepEqual(cutAnswer("Can I have your full name, please? Sam Miller.", q), { question: q, answer: "Sam Miller.", ratio: 1.001 });
  // The check model's words for his line differ a little from the fast model's: the cut still finds it.
  assert.deepEqual(cutAnswer("And the street and city for the delivery? Hill Road in Dallas.", "and the street and city for delivery."), {
    question: "And the street and city for the delivery?",
    answer: "Hill Road in Dallas.",
    ratio: 0.9343333333333333,
  });
  assert.equal(cutAnswer(q, q).answer, "", "only his question came back");
  const dropped = cutAnswer("Sam Miller.", q);
  assert.ok(dropped.ratio < CUT_FLOOR, "his question dropped: no clean cut");
});

const SAM: WordScore[] = [
  [" Can", 0.9],
  [" I", 0.95],
  [" have", 0.9],
  [" your", 0.9],
  [" full", 0.9],
  [" name", 0.9],
  [",", 0.8],
  [" please", 0.9],
  ["?", 0.7],
  [" Sam", 0.6],
  [" Miller", 0.7],
  [".", 0.9],
];

test("answerConfidence is the mean score of the answer's own last words, punctuation included", () => {
  assert.equal(answerConfidence(SAM, "Sam Miller."), 0.73);
  assert.equal(answerConfidence(SAM, "Hill Road."), null, "the words don't end the way the answer does");
  assert.equal(answerConfidence(undefined, "Sam Miller."), null);
  assert.equal(answerConfidence(SAM, ""), null);
  // A mean exactly on a half rounds as Python's did (its sum is compensated): 4.075 / 5 = 0.815 -> 0.82, not 0.81.
  const half: WordScore[] = [
    [" Hill", 0.7267],
    [" Road", 0.9846],
    [" in", 0.9749],
    [" Dallas", 0.4858],
    [".", 0.903],
  ];
  assert.equal(answerConfidence(half, "Hill Road in Dallas."), 0.82);
});

test("questionPause keeps the real pause between 0.3 and 1.5 s, and refuses an answer that began over the question", () => {
  assert.equal(questionPause({ endedAtEpoch: 10_000 }, { startedAtEpoch: 11_000 }), 0.8);
  assert.equal(questionPause({ endedAtEpoch: 10_000 }, { startedAtEpoch: 10_100 }), 0.3);
  assert.equal(questionPause({ endedAtEpoch: 10_000 }, { startedAtEpoch: 15_000 }), 1.5);
  assert.equal(questionPause({ endedAtEpoch: 10_000 }, { startedAtEpoch: 9_999 }), null);
});

test("joinClip puts the question, the silence, then the answer", () => {
  assert.deepEqual([...joinClip(new Float32Array([1, 2]), 0.25, new Float32Array([3]), 8)], [1, 2, 0, 0, 3]);
});

test("planQuestion sends the question only with word scores, its line and audio held, and no overlap", () => {
  const audio = new Float32Array(4);
  const question = { text: "Your full name, please?", endedAtEpoch: 10_000 };
  const answer = { startedAtEpoch: 11_000 };
  assert.deepEqual(planQuestion({ question, audio, answer, wordScores: true }), { send: { audio, text: question.text, pause: 0.8 } });
  assert.deepEqual(planQuestion({ question, audio, answer, wordScores: false }), { notSent: "no-scores" });
  assert.deepEqual(planQuestion({ question: undefined, audio, answer, wordScores: true }), { notSent: "no-audio" });
  assert.deepEqual(planQuestion({ question, audio: undefined, answer, wordScores: true }), { notSent: "no-audio" });
  assert.deepEqual(planQuestion({ question, audio, answer: { startedAtEpoch: 9_000 }, wordScores: true }), { notSent: "overlap" });
});

/** A stand-in for the engine: what the clip with the question comes back as, and what the answer alone does. */
function engine(both: Heard | Error, alone: Heard | Error = { text: "Sam Miller.", confidence: 0.81 }) {
  const calls: { samples: Float32Array; words: boolean }[] = [];
  const hear = async (samples: Float32Array, words: boolean) => {
    calls.push({ samples, words });
    const r = words ? both : alone;
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, hear };
}
const answer = new Float32Array([0.5, 0.5]);
const question = new Float32Array([0.1, 0.1, 0.1]);
const input = (hear: (s: Float32Array, w: boolean) => Promise<Heard>) => ({ answer, question, questionText: "Can I have your full name, please?", pause: 0.3, hear });
const WHOLE = "Can I have your full name, please? Sam Miller.";

test("checkWithQuestion: the answer is cut out and judged on its own score", async () => {
  const e = engine({ text: WHOLE, confidence: 0.86, words: SAM, looped: false });
  const { heard, outcome } = await checkWithQuestion(input(e.hear));
  assert.deepEqual(heard, { text: "Sam Miller.", confidence: 0.73 });
  assert.deepEqual(outcome, { kind: "used", whole: WHOLE, wholeConfidence: 0.86, ratio: 1.001, pause: 0.3 });
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].words, true);
  assert.equal(e.calls[0].samples.length, question.length + Math.round(0.3 * 16000) + answer.length, "question, pause, answer");
});

test("checkWithQuestion: a looping hearing keeps the engine's 0.5 cap on the answer's own score", async () => {
  const { heard } = await checkWithQuestion(input(engine({ text: WHOLE, confidence: 0.5, words: SAM, looped: true }).hear));
  assert.equal(heard.confidence, 0.5);
});

test("checkWithQuestion: anything unusable is heard again on its own, as today's check hears it", async () => {
  for (const [both, why] of [
    [{ text: " ", confidence: null, words: [] }, "empty"],
    [{ text: "Can I have your full name, please?", confidence: 0.9, words: SAM.slice(0, 9) }, "only-question"],
    [{ text: "Sam Miller.", confidence: 0.7, words: SAM.slice(9) }, "weak-cut"],
    [{ text: WHOLE, confidence: 0.86 }, "no-scores"],
    [{ text: WHOLE, confidence: 0.86, words: SAM.slice(0, 9) }, "no-own-score"],
  ] as const) {
    const e = engine(both);
    const { heard, outcome } = await checkWithQuestion(input(e.hear));
    assert.deepEqual(heard, { text: "Sam Miller.", confidence: 0.81 }, why);
    assert.deepEqual(outcome, { kind: "alone", why, whole: both.text, pause: 0.3 }, why);
    assert.equal(e.calls.length, 2, why);
    assert.equal(e.calls[1].samples, answer, `${why}: the answer's own audio`);
    assert.equal(e.calls[1].words, false, why);
  }
});

test("checkWithQuestion: a failed request fails the check, as today, and nothing is heard again after it", async () => {
  const first = engine(new Error("timeout"));
  await assert.rejects(checkWithQuestion(input(first.hear)), /timeout/);
  assert.equal(first.calls.length, 1);
  const second = engine({ text: "", confidence: null }, new Error("HTTP 503"));
  await assert.rejects(checkWithQuestion(input(second.hear)), /HTTP 503/);
  assert.equal(second.calls.length, 2);
});
