# Freeze record: Sunlake evaluation scenarios v1

Frozen at 2026-11-25T21:13:59Z (UTC), before any run of any system against them.

- Development set (21): `scenarios-dev/sunlake-scenarios-v1-dev.json` sha256 `368924b5ef5d068b7316bcc9505c91db0a1fd719454d437514549a3b0403e13c`
- Sealed held-out set (9): `sealed-holdout/sunlake-scenarios-v1-holdout.json` sha256 `fee2c38d59e7a203491436b357eee41b45a1ebd8674217326720c60a0bf2f31d`
- Held-out IDs: S01, S05, S07, S14, S19, S22, S24, S29, S30. Chosen by a seeded random draw, about a third of each category, seed = sha256 of the authoring file `4f7cf8b3e6b863d968e6da1d181ddc68d098905f12d135f49bd5a6dcf6a05c35`.

Rules for the held-out set: its scenarios are never used to write, tune or check a rule, prompt or instruction. Its results are reported only as totals and failure classes. Opening it for rule work makes it a development set; a new held-out set is then needed.

Expected results were written from the written SOP (CS-SOP-3.1 Rev. 2) before any run. They are not expert-validated.

## v1.1 supplement (frozen 2026-11-25T21:25:31Z UTC, before it was run)

- `scenarios-dev/sunlake-scenarios-v1.1-supplement-dev.json` sha256 `fd50e043232ea60ca2466c2472ea654ed6212747fca68fed0929de99ebff9121`: S25b and S26b, the two "get around a rule" scenarios reworded ("snapped" and "crushed" become "cracked") so they reach the point they test. Expected results copied unchanged from S25 and S26, which stay in the v1 set as they were. No sealed scenario was opened or changed.
