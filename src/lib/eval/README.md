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

- `reference` is what was actually said, written by a listener from the recording, with `[pause N s]` and `[unclear]` marks. v1 scores against it, not the script. When it is absent the script is used, each measurement row says so, and the report counts those segments as provisional. A reference whose numbers don't match the case's tagged spans is refused: a misread number means a new take.
- `first` is the first-pass text (L1), `""` for an empty result. `checked` is the checked text (L2), only when the line was checked.
- `start` and `end` are seconds from the start of the case; `firstTextS` is the delay the console shows after the end of speech; `checkS` is "checked in". Tier 1 adds `engineResponseS` and `checkEngineResponseS` (request to response, first pass and check, reported apart), and `queueS`, `decodeS` when known.
- `checks: "all"` at the top of a file says the replay checked every caller line (Tier 1). L2 then scores every check, and the copilot (L3, L4) uses a checked text only where the console would have asked for it. Without it, a checked text is one the console asked for, as on a live call.
- A case or segment left out of the file counts as missing (LOST), never dropped from the denominators. `missingStage` says why, when known.
- Lines without times get synthesized times that only order the lines and decide whether two caller lines are one answer (1 s apart unless given). They are never reported as timing.

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
12. **Score sheet.** The v1 columns in v1's order, then `kind`, `L2_sub`, `L2_del`, `L2_ins`, `L2_wer`, `L2_nc_er` (v1 has one set of word scores per row; these are the L2 ones), `L4_note` and `check_engine_response_s` (`engine_response_s` holds the first-pass requests). Multi-line text is shown joined by " | ".
13. **Records.** v1 gives the names, order numbers, the R-D07 to R-D09 streets and cities, and the decoys. The harness adds emails, states, items and prices, streets for R-D03 to R-D06 (Bay Street, Seattle; Oak Avenue, Phoenix; Pine Drive, Chicago; Lake Road, Miami), and streets for the decoy customers. All fictional.
14. **Which checks the copilot sees in a replay.** v1's usable text is "the checked text for a key caller answer the copilot holds for the check". The replay checks every caller line, so for L3 and L4 the harness applies the console's own rule (`copilot-store.ts`): a caller line is held for the check when it arrives while the copilot awaits an answer (issue, name, address or choice), or once the copilot names it a key answer, and the check lands that long after it was asked. Agent lines are checked live only when the rules name them; the replay doesn't check them, so their first text is used. On the reference text B0 would check every caller line in all nine cases with speech.
