#!/usr/bin/env bash
# Records Presentation Mode and exports exports/axentra-demo-call.mp4 (1920x1080, H.264, 30 fps),
# trimmed to start exactly at the "incoming call" scene so it lines up with the call audio.
#   scripts/export-video.sh [baseUrl]
set -euo pipefail
cd "$(dirname "$0")/.."
FF=$(ls "$HOME"/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-mac | head -1)
FPS=30

node scripts/record-presentation.mjs "${1:-http://localhost:3000}"
TRIM_MS=$(node -p 'require("./exports/presentation.json").trimMs')

rm -rf exports/.frames && mkdir -p exports/.frames
"$FF" -hide_banner -loglevel error -ss "$(node -p "$TRIM_MS/1000")" -i exports/presentation.webm -r "$FPS" exports/.frames/%05d.png

if [ ! -x exports/.pngs2mp4 ]; then
  xcrun swiftc -O -o exports/.pngs2mp4 scripts/pngs2mp4.swift
fi
exports/.pngs2mp4 exports/.frames "$FPS" exports/axentra-demo-silent.mp4
rm -rf exports/.frames exports/presentation.webm

# Mux the call dialogue and the ambient bed in, when they are present.
if [ -f public/audio/call.mp3 ]; then
  [ -x exports/.mux-av ] || xcrun swiftc -O -parse-as-library -o exports/.mux-av scripts/mux-av.swift
  AUDIO=("public/audio/call.mp3:1.0")
  for bed in public/audio/ambient.mp3 public/audio/ambient.m4a; do
    [ -f "$bed" ] && AUDIO+=("$bed:0.08:loop") && break
  done
  exports/.mux-av exports/axentra-demo-silent.mp4 exports/axentra-demo.mp4 "${AUDIO[@]}"
  echo "done: exports/axentra-demo.mp4 (with audio)"
else
  mv exports/axentra-demo-silent.mp4 exports/axentra-demo.mp4
  echo "done: exports/axentra-demo.mp4 (no audio; add public/audio/call.mp3 and re-run)"
fi
