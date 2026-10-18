/*
  Which copilot code a run measured. The baseline B0 is the stage build, 5bb7bf2 (main merge
  4883603): these are the SHA-256 hashes of the files the harness runs at that commit, identical at
  both (git diff 5bb7bf2 4883603 -- src/ is empty). Every report states whether the code it ran
  matches B0, so a baseline can't be measured on changed code by mistake, and a later fix is
  measured as a difference from B0.
*/

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const B0 = {
  label: "B0: console 5bb7bf2 (main merge 4883603), rules only",
  files: {
    "src/lib/copilot/copilot.ts": "35489fa4883724358cf5746f98b6484e8e84f56be4d9e4587232d6fae7c30999",
    "src/lib/copilot/orders.ts": "0b055125d94931560a1dad6eb9d2042ce384553c38abfb0b070ab87bd7058a25",
    "src/lib/copilot/signals.ts": "01239c8d5a5e6785b9b769e548bd301e4228080c1f0e50eef9e54cbfe677e8e6",
    "src/lib/copilot/text.ts": "5620b94886bc373461d29910f9e3cd8c181392d554fcf604e3263b60df678447",
    "src/lib/copilot/verification.ts": "e21ab156e261826b41ee4f7d82d755ff9587bed6877f56043b15c92c028f4332",
    "src/lib/copilot/types.ts": "98d5c12e7e9ad9e2b97ddebd8e5a3ab3601c8aabf74c04fad6a8ee6a49b70a0d",
    "src/lib/live/sunlake-data.ts": "421589f09882d12ffff3c13ab972adc8d8e3c8554c697d6afc3bf9f3ecc6d2b3",
  } as Record<string, string>,
};

/** The hashes of the files this checkout would run, and whether each matches B0. */
export function codeFingerprint(): { matchesB0: boolean; files: { path: string; sha256: string; matches: boolean }[] } {
  const root = new URL("../../../", import.meta.url);
  const files = Object.entries(B0.files).map(([path, expected]) => {
    const sha256 = createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");
    return { path, sha256, matches: sha256 === expected };
  });
  return { matchesB0: files.every((f) => f.matches), files };
}
