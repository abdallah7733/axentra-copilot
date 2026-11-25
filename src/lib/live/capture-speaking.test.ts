import { test } from "node:test";
import assert from "node:assert/strict";
import { audio, clock, nodes, settle } from "./live-call-fakes";
import { captureStream, type Phrase } from "./engine";

/*
  C12 (check of the C12 fixes, 23 Nov): the real captureStream's CaptureHandle. speakingSince is the phrase cutter's
  start of the phrase being said (performance.now() clock), and null once close() has begun, even while close() still
  waits for the worklet.
*/
test("CaptureHandle.speakingSince: the phrase's start while it is said; null from the moment close() begins", async () => {
  const stream = { getAudioTracks: () => [{ label: "x" }] } as unknown as MediaStream;
  const phrases: Phrase[] = [];
  const handle = await captureStream(stream, (p) => phrases.push(p));
  const node = nodes.find((n) => n.stream === stream)!;
  const t0 = clock.mono;
  const push = (n: number, level: number) => {
    for (let i = 0; i < n; i++) {
      clock.mono += 20;
      node.port.onmessage?.({ data: new Float32Array(320).fill(level) });
    }
  };
  push(20, 0);
  assert.equal(handle.speakingSince(), null);
  push(20, 0.2);
  assert.equal(handle.speakingSince(), t0 + 400 - 240, "voice from 400 ms, less 240 ms of pre-roll");
  audio.holdFlush = true; // the worklet doesn't answer: close() waits its real 1 s
  const closing = handle.close();
  assert.equal(handle.speakingSince(), null, "closing: null at once, though the phrase isn't cut yet");
  assert.equal(phrases.length, 0);
  await closing;
  audio.holdFlush = false;
  await settle();
  assert.equal(phrases.length, 1, "the flush cut the phrase");
  assert.equal(phrases[0].startedAt, t0 + 400 - 240);
  assert.equal(handle.speakingSince(), null);
});
