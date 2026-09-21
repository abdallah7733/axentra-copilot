# Call audio generation prompt (Axentra Agent Copilot demo)

Paste everything below the line into your AI audio tool (ElevenLabs dialogue / text-to-speech, or similar). When the file is done, save it as `public/audio/call.mp3`. Presentation Mode plays it automatically, in sync with the scenes.

---

## Brief

Generate a single audio file of a realistic customer-support phone call between a support agent and a customer. Two voices, no music, no sound effects, no narration. The file is played under a screen recording, so timing matters more than anything else: each line must START at the timestamp given. If a line finishes early, leave silence until the next timestamp. Do not compress or stretch the gaps.

Total length: exactly 82.2 seconds (pad the end with silence if needed).

## Voices

**Maya (agent).** Woman, late 20s to 30s, neutral American accent. Warm, calm, unhurried, professional. Speaks like someone who does this all day and is good at it: clear, friendly, never salesy, never over-apologetic. Pace about 160 to 170 words per minute. Clean studio quality (she is on a headset in a quiet office).

**Daniel (customer).** Man, 30s to 40s, neutral American accent. Slightly annoyed at the start (he was charged twice), relaxes as the call goes on, genuinely pleased at the end. Natural, not theatrical. His side sounds like a mobile phone call: apply a light phone-line band-pass (roughly 300 Hz to 3.4 kHz) and a touch of room tone, but keep him fully intelligible.

## Script with timestamps

Timestamps are seconds from the start of the file. "[silence]" means nothing is spoken until the next timestamp.

| Start | Speaker | Line |
|---|---|---|
| 0.0 | [silence] | (0.8 s of quiet line tone, the call has just connected) |
| 0.8 | Maya | Thank you for calling AtlasOne Communications, this is Maya. How can I help you today? |
| 6.8 | Daniel | Hi. I'm looking at my card statement and I was charged twice for my internet bill this month. Both on the 14th. |
| 15.8 | Maya | I'm sorry about that, let me look into it. First I need to verify the account. Can you confirm the email address on file? |
| 24.8 | Daniel | It's d dot carter at example-mail dot com. |
| 28.5 | Maya | Thank you. And the last four digits of the card used for payment? |
| 33.2 | Daniel | Four four seven one. |
| 35.0 | [silence] | (quiet line, about 2.7 s) |
| 37.7 | Maya | You're verified, Daniel. I have your account open. Let me pull up the recent payments. |
| 43.5 | [silence] | (quiet line, about 2.5 s) |
| 46.0 | Maya | I can see two charges of forty-nine dollars, about a minute and a half apart, on September fourteenth. The second one is a duplicate. |
| 55.0 | Maya | I can refund the duplicate to your Visa right now. It usually shows up within three to five business days. |
| 62.4 | Daniel | That would be great, thank you. |
| 65.5 | [silence] | (quiet line, hold until 69.5. This gap is where the agent approves the refund on screen.) |
| 69.5 | Maya | Done. The forty-nine dollar refund is processed. You'll get an email confirmation in a few minutes. |
| 76.0 | Daniel | Perfect. Thanks, Maya. |
| 78.0 | Maya | You're welcome. Is there anything else I can help with today? |
| 82.2 | [end] | |

## Delivery notes

- Maya's line at 0.8 s is the standard greeting; bright but not chirpy.
- Daniel at 6.8 s: mildly frustrated, matter-of-fact, not angry.
- Maya at 15.8 s: the apology is one short beat, then straight into the process.
- Daniel at 24.8 s reads the email slowly and clearly, the way people do when they know it is being typed.
- Daniel at 33.2 s: just the digits, evenly spaced.
- Maya at 46.0 s: explaining, slightly slower, so the numbers land.
- Daniel at 62.4 s: relieved.
- Maya at 69.5 s: "Done." is its own beat, then the rest.
- Keep every gap as written. The screen recording has fixed scene lengths and the file is seeked to fixed offsets, so a line that starts early or late will drift against the picture.

## Output

- MP3, 44.1 kHz, 192 kbps or better (WAV also fine, then convert to MP3).
- Mono or stereo, no panning tricks.
- Loudness around -16 LUFS integrated, peaks under -1 dBTP.
- No music, no ringing, no hold tones, no hangup click. Music is handled separately.

---

## After generating

1. Save as `public/audio/call.mp3`.
2. Optionally add a low ambient bed as `public/audio/ambient.mp3` (loops under everything at 8 percent volume). If you skip it, a soft synthesized pad plays instead.
3. Open `/presentation`, press Start. The dialogue begins on the "incoming call" scene. At the approval scene the audio holds after Daniel's line and continues when you click Approve.
