import { test } from "node:test";
import assert from "node:assert/strict";
import { createSegmenter, type Phrase } from "./engine";

/*
  C12: the store doesn't put the agent's question in front while a phrase that began between the question and the answer
  is still being said (question-check.ts planQuestion `heard`). The segmenter says when the phrase being said now began.
*/
test("speakingSince: when the phrase being said began, and nothing once it has been handed over", () => {
  let now = 50_000;
  Object.defineProperty(performance, "now", { value: () => now, configurable: true, writable: true });
  const phrases: Phrase[] = [];
  const seg = createSegmenter(16_000, (p) => phrases.push(p));
  const frames = (n: number, level: number) => {
    for (let i = 0; i < n; i++) {
      now += 20;
      seg.push(new Float32Array(320).fill(level));
    }
  };
  frames(10, 0);
  assert.equal(seg.speakingSince(), null, "silence");
  frames(20, 0.2);
  const since = seg.speakingSince();
  assert.ok(since !== null && since < now, "speaking");
  assert.equal(phrases.length, 0);
  // 600 ms of silence ends the phrase: it is handed over, and nothing is being said.
  frames(30, 0);
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].startedAt, since);
  assert.equal(seg.speakingSince(), null);
});
