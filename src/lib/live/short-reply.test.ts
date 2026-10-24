import { test } from "node:test";
import assert from "node:assert/strict";
import { createSegmenter, type Phrase } from "./engine";
import { isShortReply, sendShortReply } from "./short-reply";

/*
  6:03 PM call (23 Oct) and 2:15 AM call (24 Oct): the caller's quick "Yes." to a read-back (9-10 voiced 20 ms frames,
  about 0.3 s) was dropped by the phrase splitter before any model heard it. Development console only, with a read-back
  build setting on: a short caller phrase right after the agent speaks is sent, and kept only if heard as one reply word.
*/

const RATE = 16000;
const FRAME = 320;
/** Quiet room noise, then `ms` of a loud tone, then a second of quiet. */
function phrasesFor(ms: number): Phrase[] {
  const out: Phrase[] = [];
  const seg = createSegmenter(RATE, (p) => out.push(p));
  const quiet = (frames: number) => {
    const a = new Float32Array(frames * FRAME);
    for (let i = 0; i < a.length; i++) a[i] = (((i * 7919) % 200) / 200 - 0.5) * 0.004;
    return a;
  };
  const tone = (frames: number) => {
    const a = new Float32Array(frames * FRAME);
    for (let i = 0; i < a.length; i++) a[i] = 0.2 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    return a;
  };
  seg.push(quiet(50));
  seg.push(tone(Math.round(ms / 20)));
  seg.push(quiet(50));
  return out;
}

test("the splitter keeps a 0.16-0.22 s phrase's audio, marked short; under 0.12 s stays dropped; 0.3 s+ is a normal phrase", () => {
  for (const ms of [160, 200, 220]) {
    const [p] = phrasesFor(ms);
    assert.ok(p?.samples, `${ms} ms has audio`);
    assert.equal(p.short, true, `${ms} ms is short`);
  }
  const [tiny] = phrasesFor(80);
  assert.equal(tiny?.samples ?? null, null, "80 ms: no audio, as before");
  const [normal] = phrasesFor(400);
  assert.ok(normal?.samples);
  assert.equal(normal.short, undefined);
});

test("a short caller phrase is sent only right after the agent speaks, and only in a build with read-back on", () => {
  const short = (startedAt: number): Phrase => ({ id: 1, startedAt, endedAt: startedAt + 300, samples: new Float32Array(10), short: true });
  const agentEnd = 10_000;
  assert.equal(sendShortReply(short(11_300), "caller", agentEnd, true), true, "1.3 s after the agent stops (2:15 AM call)");
  assert.equal(sendShortReply(short(9_700), "caller", agentEnd, true), true, "overlapping the agent's last 0.3 s");
  assert.equal(sendShortReply(short(15_500), "caller", agentEnd, true), false, "more than 5 s later");
  assert.equal(sendShortReply(short(8_000), "caller", agentEnd, true), false, "while the agent was still talking");
  assert.equal(sendShortReply(short(11_300), "caller", null, true), false, "the agent hasn't spoken yet");
  assert.equal(sendShortReply(short(11_300), "agent", agentEnd, true), false, "agent side");
  assert.equal(sendShortReply(short(11_300), "caller", agentEnd, false), false, "build without read-back (pitch console, public site)");
  assert.equal(sendShortReply({ ...short(11_300), short: undefined }, "caller", agentEnd, true), false, "not a short phrase");
});

test("a short phrase is kept only if heard as one reply word", () => {
  for (const t of ["Yes.", "yes", "Yeah.", "No.", "Nope.", "Correct.", "That's right.", "Mm-hmm.", " Yes. "]) assert.equal(isShortReply(t), true, t);
  for (const t of ["", "Thank you.", "you", "Bye.", "Sam.", "Yes, sorry.", "Yes yes", "Dallas."]) assert.equal(isShortReply(t), false, t);
});
