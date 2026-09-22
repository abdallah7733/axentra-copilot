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
exports/.pngs2mp4 exports/.frames "$FPS" exports/axentra-demo-call.mp4
rm -rf exports/.frames exports/presentation.webm
echo "done: exports/axentra-demo-call.mp4"
