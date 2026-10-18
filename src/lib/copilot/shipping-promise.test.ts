import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "./copilot";
import type { TranscriptEvent } from "./types";
import { scriptV2, sunlake, sunlakeSop } from "@/lib/live/sunlake-data";

/*
  18 Oct 2026, Abdallah's decision after the Call 13 review: the replacement ships the same day by expedited
  shipping. Before, the SOP and the panel said "within 1 business day" while the suggested lines, the script and
  the "Ships today" term said today. Same day is when it ships, never when it arrives.
*/

const NOW = Date.UTC(2026, 8, 27, 12);
const events = (upTo: number): TranscriptEvent[] =>
  scriptV2
    .filter((l) => l.n <= upTo)
    .map((l, i) => ({
      callId: "CA-same-day",
      seq: i + 1,
      key: `t${i + 1}`,
      side: l.side,
      text: l.text,
      startedAt: NOW - 600_000 + i * 5000,
      endedAt: NOW - 600_000 + i * 5000 + 3000,
      final: true,
      confidence: 0.9,
    }));
const at = (upTo: number) => analyze(sunlake, events(upTo), [], NOW);

test("the SOP, the panel and the suggested lines all say the replacement ships today, by expedited shipping", () => {
  const scenarioA = sunlakeSop.scenarios.find((s) => s.id === "A")!;
  assert.match(scenarioA.action, /It ships the same day by expedited shipping\. Same day is the ship date, not the delivery date\./);

  const chosen = at(11);
  const rec = chosen.recommendation!;
  assert.equal(rec.action, "Replace the Sunlake Tab 11 at no charge; it ships the same day by expedited shipping. Email a prepaid return label.");
  assert.equal(rec.prepared?.kind, "replacement");
  assert.equal(rec.prepared?.lines[0], "Sunlake Tab 11 at no charge; ships the same day by expedited shipping");
  assert.match(chosen.suggestedReply!.text, /^Done\. The new tablet ships today\./);
  assert.match(at(9).suggestedReply!.text, /A new tablet ships today at no cost/);
});

test("nothing the agent reads or says promises when the tablet arrives", () => {
  const promisesArrival = /\b(arrives?|arriving|delivered|delivery|gets? there) (today|the same day|tomorrow)\b|same[- ]day delivery|business day by expedited/i;
  const shown: string[] = [JSON.stringify(sunlakeSop), ...scriptV2.map((l) => l.text)];
  for (let n = 1; n <= scriptV2.length; n++) {
    const v = at(n);
    shown.push(v.suggestedReply?.text ?? "", v.recommendation?.action ?? "", ...(v.recommendation?.prepared?.lines ?? []));
    shown.push(...v.documentation.map((d) => `${d.label}: ${d.value}`));
  }
  for (const text of shown) assert.doesNotMatch(text, promisesArrival, text);
});
