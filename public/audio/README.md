Presentation Mode audio. Files are picked up automatically; mp3, m4a or wav.

- call.mp3     The generated call dialogue. Starts at the "incoming call" scene.
               Generate it with docs/call-audio-prompt.md so the timing matches.
- ambient.m4a  Low ambient bed, loops under the whole presentation at 8% volume.
               Rendered by scripts/render-ambient.mjs. Replace with any track you prefer
               (ambient.mp3 takes precedence if present). If none exists, a soft
               synthesized pad plays instead.
