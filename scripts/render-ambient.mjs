// Renders public/audio/ambient.wav: a 100 s ambient pad for the presentation.
// Pure Node, no dependencies. Convert to AAC afterwards with:
//   afconvert -f m4af -d aac -b 96000 public/audio/ambient.wav public/audio/ambient.m4a
import { writeFileSync } from "node:fs";

const SR = 44100;
const DUR = 100;
const N = SR * DUR;
const out = new Float32Array(N * 2);

// Slow chord progression in C, one chord every 20 s, crossfaded.
// Voicings are low and open so they sit under speech.
const chords = [
  [65.41, 98.0, 130.81, 146.83, 196.0], // Cadd9
  [55.0, 82.41, 130.81, 164.81, 196.0], // Am7-ish
  [43.65, 87.31, 130.81, 174.61, 220.0], // Fmaj7-ish
  [49.0, 98.0, 146.83, 196.0, 246.94], // G
  [65.41, 98.0, 130.81, 146.83, 196.0], // Cadd9
];
const CHORD_S = DUR / chords.length;

const rnd = (() => {
  let s = 1234567;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
})();

// Per-voice phase and detune, two slightly detuned oscillators per note per chord.
const voices = chords.map((c) =>
  c.map((f) => ({
    f,
    d: [1 + (rnd() - 0.5) * 0.003, 1 - (rnd() - 0.5) * 0.003],
    p: [rnd() * Math.PI * 2, rnd() * Math.PI * 2],
    vib: 0.05 + rnd() * 0.08,
    vp: rnd() * Math.PI * 2,
  }))
);

// Simple feedback delay "reverb" (two taps, different lengths per channel)
const dl = new Float32Array(Math.floor(SR * 0.311));
const dr = new Float32Array(Math.floor(SR * 0.427));
let il = 0, ir = 0;

// One-pole lowpass state
let lpL = 0, lpR = 0;

for (let n = 0; n < N; n++) {
  const t = n / SR;
  const ci = Math.min(chords.length - 1, Math.floor(t / CHORD_S));
  const cf = (t - ci * CHORD_S) / CHORD_S; // 0..1 within chord
  // crossfade window: fade in over first 25%, fade out over last 25%
  const env = (x) => (x < 0.25 ? x / 0.25 : x > 0.75 ? (1 - x) / 0.25 : 1);
  let l = 0, r = 0;
  const mix = [
    [ci, env(cf)],
    [ci + 1 < chords.length ? ci + 1 : ci, cf > 0.75 ? (cf - 0.75) / 0.25 : 0],
  ];
  for (const [k, g] of mix) {
    if (g <= 0) continue;
    const vs = voices[k];
    for (let v = 0; v < vs.length; v++) {
      const o = vs[v];
      const vib = 1 + 0.0015 * Math.sin(2 * Math.PI * o.vib * t + o.vp);
      const a = (v === 0 ? 0.55 : 0.32) * g;
      const s0 = Math.sin(2 * Math.PI * o.f * o.d[0] * vib * t + o.p[0]);
      const s1 = Math.sin(2 * Math.PI * o.f * o.d[1] * vib * t + o.p[1]);
      // soft triangle-ish overtone for a little air
      const h = 0.12 * Math.sin(2 * Math.PI * o.f * 2 * vib * t + o.p[0]);
      l += a * (s0 + h);
      r += a * (s1 + h);
    }
  }
  // gentle breathing tremolo
  const breathe = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.045 * t);
  l *= breathe * 0.12;
  r *= breathe * 0.12;
  // lowpass ~500 Hz
  const k = 0.07;
  lpL += k * (l - lpL);
  lpR += k * (r - lpR);
  // reverb-ish delay
  const wl = dl[il], wr = dr[ir];
  dl[il] = lpL + wr * 0.62;
  dr[ir] = lpR + wl * 0.62;
  il = (il + 1) % dl.length;
  ir = (ir + 1) % dr.length;
  let oL = lpL + 0.55 * wl;
  let oR = lpR + 0.55 * wr;
  // master fade in / out
  const fade = Math.min(1, t / 4, (DUR - t) / 5);
  out[n * 2] = oL * fade;
  out[n * 2 + 1] = oR * fade;
}

// normalise to -3 dBFS peak
let peak = 0;
for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
const gain = 0.7 / peak;

const buf = Buffer.alloc(44 + out.length * 2);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + out.length * 2, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(out.length * 2, 40);
for (let i = 0; i < out.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * gain)) * 32767), 44 + i * 2);
writeFileSync("public/audio/ambient.wav", buf);
console.log("wrote public/audio/ambient.wav", (buf.length / 1e6).toFixed(1), "MB, peak gain", gain.toFixed(2));
