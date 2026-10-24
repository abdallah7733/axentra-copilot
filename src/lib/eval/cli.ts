/*
  Step 7 harness command line. Offline only: it reads files and runs the copilot rules in this
  process. It sends nothing to the engine and needs no network.

    npm run eval -- fixtures --out <dir>        score the built-in controlled fixtures (harness checks)
    npm run eval -- score <file.json> --out <dir>   score a hypotheses file from a replay or a call
    npm run eval -- template <file.json>        an empty hypotheses file to fill in

  Writes <name>.csv (the v1 score sheet) and <name>.md (the summary) into --out, or prints the
  summary when --out is left out.
*/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeFingerprint } from "./fingerprint";
import { fixtureFile, templateFile, validate, type HypothesisFile } from "./hypotheses";
import { scoreFile, summary, toCsv } from "./score";

function write(file: HypothesisFile, name: string, out: string | undefined) {
  const report = scoreFile(file);
  const md = summary(report, codeFingerprint());
  if (!out) return void console.log(md);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.csv`), toCsv(report.rows));
  writeFileSync(join(out, `${name}.md`), md + "\n");
  console.log(`Wrote ${join(out, `${name}.csv`)} and ${join(out, `${name}.md`)}`);
}

const [command, ...rest] = process.argv.slice(2);
const outAt = rest.indexOf("--out");
const out = outAt >= 0 ? rest[outAt + 1] : undefined;

if (command === "fixtures") {
  for (const variant of ["reference-words", "reference-numerals"] as const) write(fixtureFile(variant), `fixture-${variant}`, out);
} else if (command === "score" && rest[0] && rest[0] !== "--out") {
  const file = validate(JSON.parse(readFileSync(rest[0], "utf8")));
  write(file, rest[0].replace(/^.*\//, "").replace(/\.json$/, ""), out);
} else if (command === "template") {
  const json = JSON.stringify(templateFile(), null, 2) + "\n";
  if (rest[0]) writeFileSync(rest[0], json);
  else process.stdout.write(json);
} else {
  console.error("Usage: npm run eval -- fixtures [--out dir] | score <file.json> [--out dir] | template [file.json]");
  process.exitCode = 1;
}
