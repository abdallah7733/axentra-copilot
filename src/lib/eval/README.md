# Step 7 offline evaluation harness

Scores recognised text against the frozen Step 7 v1 package (ten development cases, scoring and normalization rules, expected outcomes) and runs each case through the unchanged copilot rules from its own starting state.

It is offline only. It reads files and runs the copilot rules in this process: it sends nothing to the engine, needs no network, and changes nothing in the console, the stage pack or the public site. Nothing in the app imports it (`isolation.test.ts`).

## Two kinds of input, never mixed up

| Kind | What it is | What it can show |
|---|---|---|
| `fixture` | Text written to check the harness (the references, numeral variants, decoys) | That the scorer applies v1's rules, and what the copilot rules do with that exact text. **Never a speech accuracy or latency result.** No audio, no recognizer, no timing |
| `measurement` | Text the recognizer actually returned (Tier 1 replay or Tier 2 call), with its times | Speech results, scored with v1's rules. Every result is an observation; no target is ever marked passed |

Every report and every score-sheet row carries its kind.

## Commands

```
npm run eval -- fixtures --out <dir>              # the built-in fixtures (harness checks)
npm run eval -- template <file.json>              # an empty hypotheses file to fill in from a replay or call
npm run eval -- score <file.json> --out <dir>     # score it: <name>.csv (v1 score sheet) and <name>.md (summary)
npm test                                          # includes the harness checks (src/lib/eval/*.test.ts)
```

## Hypotheses file

```json
{
  "manifestVersion": "v1",
  "kind": "measurement",
  "configId": "B0",
  "route": "live phone",
  "runNo": 1,
  "cases": {
    "D05": {
      "A": { "lines": [{ "first": "And which order is this about?", "start": 0.0, "end": 1.9, "firstTextS": 1.0 }] },
      "C": {
        "reference": "Order seven one four [pause 1.2 s] two six.",
        "lines": [
          { "first": "Order 714.", "checked": "Order 714.", "start": 3.1, "end": 4.2, "firstTextS": 1.0, "checkS": 2.3 },
          { "first": "26.", "start": 5.2, "end": 5.6, "firstTextS": 0.9 }
        ],
        "tEndMethod": "console estimate"
      }
    }
  }
}
```

- `reference` is what was actually said, written from the recording, with `[pause N s]` and `[unclear]` marks. v1 scores against it, not the script. When it is absent the script is used, each measurement row says so, and the report counts those segments as provisional. A reference whose values don't match the case's tagged spans is refused: order digits, amounts and house numbers, the range, a name's, street's or city's words in order, and how many times "no" is said. So is a reference that, read as text, doesn't give every critical field the case expects (for D03, "a replacement, not a refund": the choice and the negated refund). For D03 the refund must also be said and negated after the replacement ("replacement", then "not", then "refund"): a take that leaves the refund out reads the refund field OK, but can't show the case's hazard. A misread number, name, address or choice means a new take. `referenceCheckedBy` says who checked the reference ("speaker (one playback; …)" or "second listener: <name>"), and needs a `reference`; the row's reviewer note carries it (once, when the segment's own note doesn't already say it), and the report counts references checked by the speaker only.
- `first` is the first-pass text (L1), `""` for an empty result. `checked` is the checked text (L2), only when the line was checked; `checkedConfidence` is the check's own confidence, which the console puts on the checked line (only with `checked`).
- `start` and `end` are seconds from the start of the case; `firstTextS` is the delay the console shows after the end of speech; `checkS` is "checked in". Tier 1 adds `emittedS` (when the console's splitter released the phrase, on the case clock), `engineResponseS` and `checkEngineResponseS` (request to response of answered requests, first pass and check, reported apart), `engineElapsedS` and `checkEngineElapsedS` (the engine's own elapsedMs), `engineFailure` and `checkEngineFailure` (`{ outcome, afterS }` for a request with no usable answer), and `queueS`, `decodeS` when known.
- `checks: "all"` at the top of a file says the replay checked every caller line (Tier 1). L2 then scores every check, and the copilot (L3, L4) uses a checked text only where the console would have asked for it (item 14). Without it, a checked text is one the console asked for, as on a live call. A replay has no screen, so such a file can't carry `firstTextS` or `checkS`: they are refused. A file from an older replay toolkit (no `checkedConfidence` on its checked lines) still scores, and the report says so: for those lines the copilot used the first pass's confidence, so re-run with the current toolkit.
- Any key not listed here, at the top of the file, on a segment or on a line, is refused and named, so a misspelt key can't be ignored silently. So are fields that contradict each other: `engineResponseS` with `engineFailure`, `engineFailure` with first-pass text, `checkEngineResponseS` with `checkEngineFailure`, `checked` with `checkFailed` or `checkEngineFailure`, `checkEngineFailure` without `checkFailed`, `engineElapsedS` with `engineFailure` and `checkEngineElapsedS` with `checkEngineFailure` (the engine's own time comes with an answer only), `checkEngineResponseS` or `checkEngineElapsedS` on a line with neither `checked` nor `checkFailed`, and a negative `afterS` or a negative value in any other seconds field.
- A case or segment left out of the file counts as missing (LOST), never dropped from the denominators. `missingStage` says why, when known. A caller segment that is LOST although the file has text for it (only the replay's check of a blank first pass, or of one whose request failed) is listed with the missing results too.
- Lines without times get synthesized times: 1 s between caller lines unless given, first text 1 s after the end, checks 2 s. They order the lines, decide whether two caller lines are one answer, and in a `checks: "all"` file decide which lines the console would hold for a check. That is why a replay writes `emittedS` and its engine times: the harness estimates the check emulation's times from them instead (item 14). Synthesized and estimated times are never reported as timing.

## What a run does

1. **Words (L1, L2).** Conventional WER, and beside it the number-collapsed error rate (NC-ER), never mixed up. Invented words for D10.
2. **Fields (L1, L2)** from the text, exactly, with the v1 codes. Nothing is looked up in the records.
3. **Workflow (L3, L4).** Each case on a new call with its own evaluation record (`records.ts`), brought to its starting state by typed answers and panel actions only (`workflow.ts`), then the case's lines. The copilot's view gives what it read (L3) and what it did (L4). Every run starts empty, so cases are independent.
4. **Code fingerprint.** Every report says whether the copilot code it ran matches B0 (5bb7bf2 / 4883603) file by file (`fingerprint.ts`). A baseline is only a baseline if it does.

## How v1 is read (interpretations for review)

v1 is frozen and left unchanged. Where it doesn't say exactly how to compute something, the harness does the following. Each item is a candidate for a v2 note if Abdallah wants it changed.

1. **Numerals in conventional WER.** A numeral is expanded digit by digit when it has a leading zero, four or more digits, or follows "order" ("order 714" → "seven one four"); otherwise as a cardinal ("48" → "forty eight"). So "26" written for a spoken "two six" is one substitution in conventional WER. NC-ER is reported beside it for this reason.
2. **Amounts.** "a hundred" reads as "one hundred", and "and" after "hundred" is dropped, on both sides, so the AMOUNT forms v1 lists as equal read the same. "oh" for zero is equal inside a number span (v1's table) but stays its own word in conventional WER.
3. **Hyphens.** Digits joined by hyphens ("0-6-2-9-1") are digits said one by one; "4-7 days" is "4 to 7 days"; any other hyphen is a space.
4. **NC-ER.** Equality follows the span's tag: an order number by its digits (written or said digit by digit), an amount or house number by its value (written or said as a value, so "4 8" isn't 48), a range by both ends and the unit. A segment's lines are joined first, as for conventional WER and the fields, so a number split over two lines is still one span here; the split itself shows at L3 (SPLIT). Order digits grouped differently ("four twenty seven", "714 26") are accepted as the same digits.
5. **Fields at L1 and L2** are read from the case's caller lines joined in order; SPLIT is an L3 code only, as v1 says. Intent and choice are read at text level only as "the deciding words are there": a damage word; "replacement" not negated; "refund" negated. D02's "choice unchanged" at text level means no choice word was invented.
6. **L3** is the copilot's own reading: the latest order number it heard, the name or address answer it assembled. SPLIT when the joined text is right but the copilot didn't read it whole; FROM_RECORD when only its "only recent order" suggestion filled the field.
7. **L4.**
   - Order cases: matched without needing confirmation is DONE_RIGHT; matched but needing confirmation (closest, sound-alike, only recent order) is CLARIFY; any other order shown, even for confirmation, is UNSAFE; no order is MISSED.
   - Identity cases: verified is DONE_RIGHT if the field is right, otherwise UNSAFE; "please confirm" or "asks for the rest" is CLARIFY; still listening is MISSED. A counted failed attempt is CLARIFY with the attempt noted: v1 has no separate code for it.
   - D03: refund taken as the choice, or an order number that would match once identity is verified, is UNSAFE; no damage issue or no replacement choice read is MISSED; damage read with low certainty (the copilot asks the agent to confirm it) is CLARIFY; otherwise DONE_RIGHT.
   - D01, D02, D10: any change to the issue, identity, order, choice or approval is UNSAFE; otherwise NO_EFFECT.
8. **Confirmation turns:** the prompts about the case's step still waiting at the end. For a no-effect case, any prompt its line added.
9. **Starting states.** D01's "replacement approved" also needs the damage established (the copilot can't approve without it), so D01 starts with it. Its choice is typed by the agent; the item is read back by the agent; the approval is the panel's Approve.
10. **Agent cue.** From the hypotheses file when present, otherwise the reference (the row says so).
11. **Timing** is per segment, from the end of its last caller line. Usable text is when the last line's usable text arrived (checked text for a checked line); correct field is the first moment every field of the case reads OK at L3, found by stepping through each arrival. Computed only from measured times.
12. **Score sheet.** The v1 columns in v1's order, then `kind`, `L2_sub`, `L2_del`, `L2_ins`, `L2_wer`, `L2_nc_er` (v1 has one set of word scores per row; these are the L2 ones), `L4_note`, `check_engine_response_s` (`engine_response_s` holds the first-pass requests), `engine_elapsed_s` and `check_engine_elapsed_s` (the engine's own elapsedMs), and `engine_failures` (each request with no usable answer, as "check p1: HTTP 503, 8.012 s from sending", p being the line in the segment). Multi-line text is shown joined by " | ". In the summary the engine table has a row per request kind and channel (Caller, Agent), as the timing table does; failed requests are counted beside the answered ones and listed, never averaged in, and an answered request whose time isn't in the file is counted apart. In a `checks: "all"` file every line was sent and every line with a check result was checked, so a blank first pass, or a failed check, with neither a time nor a failure record (an older replay toolkit) counts as failed, "outcome not in the file".
13. **Records.** v1 gives the names, order numbers, the R-D07 to R-D09 streets and cities, and the decoys. The harness adds emails, states, items and prices, streets for R-D03 to R-D06 (Bay Street, Seattle; Oak Avenue, Phoenix; Pine Drive, Chicago; Lake Road, Miami), and streets for the decoy customers. All fictional.
14. **Which checks the copilot sees in a replay.** v1's usable text is "the checked text for a key caller answer the copilot holds for the check". The replay checks every caller line, so for L3 and L4 the harness applies the console's own rule (`copilot-store.ts`): a caller line is held for the check when it arrives while the copilot awaits an answer (issue, name, address or choice), or once the copilot names it a key answer, and the check lands that long after it was asked, with the check's own confidence. A blank first pass never reaches the copilot (`store.ts` drops it), in any file; L1 and L2 still score it. Agent lines are checked live only when the rules name them; the replay doesn't check them, so their first text is used.
    - Which lines are held depends on when each first text and check lands. For a replay these times are estimated: the phrase's release plus the engine's measured time, each side's first passes in turn as in the console's queue, then the check's measured time (or the time it failed). The estimate leaves out the 100 ms capture-block lag, waits inside the engine, and the GPU shared with running checks (in the combined pass the measured times include that pass's own overlap). So each case runs again with other times: every check taking 9 s, the longest the console waits; every check landing early, after only the engine's own time (`checkEngineElapsedS`), a timed-out check after its own wait (`checkEngineFailure.afterS`), or at once when neither is recorded; every first pass that lands after the case's first caller check could start coming 1.5 s late; and each of those first passes 1.5 s late on its own (its side's later first passes waiting behind it), once with the estimated check times and once with checks landing early. 1.5 s is an assumed shared-GPU slowdown, not measured and not given in the step's documents. One first pass slowed on its own is what can make it land after a check that was already running (D03 split at its reading pauses: the third line's first pass beside the second line's check). These runs flag results within these bounds of an edge; a result can still sit near an edge they don't try (other slowdowns, or other combinations), and none of them measures the slowdown. When any of them changes which caller lines would be checked, the L4 note says "timing-dependent", names the run that changed it and gives the L4 it would lead to, and the report lists those cases.
    - On the reference text, as one line or split at its pauses, the emulation checks every caller line in all nine cases with speech, in the estimate and in every extra run, with synthesized times and with estimated ones (0.5 s first passes, 2 s checks). A line goes unchecked when it arrives after an earlier line's check has landed and the copilot no longer awaits an answer: D03 cut at 12 s, with a 4 s first check and its second line's first pass in 0.3 s, holds that line ("…not a refund…") for its check, but a check landing at once, or that line's first pass 1.5 s later, leaves it to its first text, so that case is reported timing-dependent.
