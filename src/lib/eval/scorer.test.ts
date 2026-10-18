import { test } from "node:test";
import assert from "node:assert/strict";
import { addressCodes, nameCode, noOrderCode, orderCode } from "./fields";
import { collapsedTokens, conventionalWords, normalizeText, sameNumber, type NumToken } from "./normalize";
import { median, p90, targetVerdict } from "./score";
import { align, errorRate } from "./wer";

/*
  The scorer against Step 7 v1's own rules and examples (02_SCORING_AND_NORMALIZATION). Harness
  checks on constructed text: they show the scorer applies the rules, nothing about speech.
*/

const num = (text: string) => collapsedTokens(text).find((t): t is NumToken => t.kind === "num")!;
const ref = (digits: string, tag: string, value: number | null = null): NumToken => ({ kind: "num", digits, value, form: "digits", text: digits, tag });

test("2.1 words: case, punctuation, hyphens, equivalences and fillers; pauses aren't words; unclear spans listed", () => {
  assert.deepEqual(normalizeText("“It’s” twenty-nine, OK? Um, I'd… uh I'm sure I don't.").words, ["it", "is", "twenty", "nine", "okay", "i", "would", "i", "am", "sure", "i", "do", "not"]);
  assert.deepEqual(normalizeText("Order seven one four [pause 1.0 s] two six.").words, ["order", "seven", "one", "four", "two", "six"]);
  const n = normalizeText("It's [unclear] Haddad.");
  assert.deepEqual([n.words, n.unclear], [["it", "is", "haddad"], ["[unclear]"]]);
  // Kept and scored: negation, repetition, self-corrections, leading zeros.
  assert.deepEqual(normalizeText("No. No.").words, ["no", "no"]);
  assert.deepEqual(normalizeText("06291. Sorry, no, 06294.").words, ["06291", "sorry", "no", "06294"]);
});

test("2.2 conventional words: numerals become number words by a fixed rule", () => {
  assert.deepEqual(conventionalWords("Order 06294"), ["order", "zero", "six", "two", "nine", "four"]);
  assert.deepEqual(conventionalWords("it's 58316"), ["it", "is", "five", "eight", "three", "one", "six"]);
  assert.deepEqual(conventionalWords("order 714"), ["order", "seven", "one", "four"]);
  assert.deepEqual(conventionalWords("48 Willow Lane"), ["forty", "eight", "willow", "lane"]);
  // The amount reads the same written or spoken.
  assert.deepEqual(conventionalWords("It was $129."), conventionalWords("It was a hundred and twenty-nine dollars."));
  assert.deepEqual(conventionalWords("4-7 days"), conventionalWords("four to seven days"));
});

test("2.2 number spans: the equal and not-equal forms in the v1 table", () => {
  const id = ref("06294", "ORDER_ID");
  for (const t of ["zero six two nine four", "06294", "0 6 2 9 4", "oh six two nine four", "0-6-2-9-4"]) assert.ok(sameNumber(id, num(t)), t);
  for (const t of ["6294", "0629"]) assert.ok(!sameNumber(id, num(t)), t);
  const amount = ref("129", "AMOUNT", 129);
  for (const t of ["a hundred and twenty-nine dollars", "$129", "129 dollars"]) assert.ok(sameNumber(amount, num(t)), t);
  const house = ref("48", "HOUSE_NO", 48);
  for (const t of ["forty-eight", "48"]) assert.ok(sameNumber(house, num(t)), t);
  for (const t of ["4 8", "408"]) assert.ok(!sameNumber(house, num(t)), t);
  for (const t of ["four to seven days", "4 to 7 days", "4-7 days"]) assert.deepEqual(collapsedTokens(t).map((x) => x.kind), ["range"], t);
  // A number split over two transcript lines is two tokens.
  assert.equal(collapsedTokens(["Order 714.", "26."]).filter((t) => t.kind === "num").length, 2);
  assert.equal(collapsedTokens("Oh, okay.")[0].kind, "word");
});

test("3.3 error counts: substitutions, deletions and insertions apart; empty reference has no rate", () => {
  assert.deepEqual(align(["a", "b", "c"], ["a", "x", "c", "d"], (x, y) => x === y), { ref: 3, sub: 1, del: 0, ins: 1 });
  assert.deepEqual(align(["no", "no"], ["no"], (x, y) => x === y), { ref: 2, sub: 0, del: 1, ins: 0 });
  assert.equal(errorRate({ ref: 0, sub: 0, del: 0, ins: 2 }), null);
});

test("3.2 order number codes: exact, partial, ambiguous, wrong, missing, the final value after a correction", () => {
  assert.equal(orderCode("order 42791", "42791").code, "OK");
  assert.equal(orderCode("probably 427", "42791").code, "PARTIAL");
  assert.equal(orderCode("order four to seven", "427").code, "AMBIGUOUS");
  assert.equal(orderCode("order 527", "427").code, "WRONG");
  assert.equal(orderCode("I don't know it", "427").code, "MISSING");
  assert.equal(orderCode("It's 06291. Sorry, no, 06294. It was $129.", "06294").code, "OK");
  assert.equal(orderCode("It's 06294. Sorry, no, 06291.", "06294").code, "WRONG");
  assert.equal(noOrderCode("The site said four to seven days and it was 84 dollars.").code, "OK");
  assert.equal(noOrderCode("The site said 427.").code, "INVENTED");
});

test("3.1 names and addresses: exact parts; a sound-alike is a field error, labelled", () => {
  assert.equal(nameCode("It's Mariam Haddad.", "Mariam Haddad").code, "OK");
  assert.equal(nameCode("Mariam.", "Mariam Haddad").code, "PARTIAL");
  assert.deepEqual(nameCode("Grace Whitford.", "Grace Whitfield"), { code: "WRONG", note: 'sound-alike: "whitford" for "whitfield"' });
  assert.equal(nameCode("Yes.", "Grace Whitfield").code, "MISSING");
  const want = { house_no: "48", street: "Willow Lane", city: "Portland" };
  assert.equal(addressCodes("48 Willow Ln in Portland", want).address!.code, "OK");
  assert.equal(addressCodes("Willow Way in Portland", want).street!.code, "WRONG");
  assert.equal(addressCodes("4 8 Willow Lane, Portland", want).house_no!.code, "WRONG");
});

test("5 statistics: conventional median, p90 by nearest rank, and a target never marked passed", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
  assert.equal(targetVerdict([1.0, 1.2, 1.4], 0), "not contradicted by this small sample");
  assert.equal(targetVerdict([1.0, 1.2, 3.0], 0), "not demonstrated");
  assert.equal(targetVerdict([1.0], 1), "not demonstrated");
  assert.equal(targetVerdict([], 0), "not demonstrated (no timed results)");
});
