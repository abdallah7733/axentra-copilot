#!/bin/bash
# Builds the console for the local engine: npm run build:console -> out-console/,
# which axentra-local-transcript/server.js serves at http://127.0.0.1:8765/console/
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
LOG=out-console-build.log
echo "Building the Axentra console for the local engine..."
npm run build:console > "$LOG" 2>&1
code=$?
tail -40 "$LOG"
echo "exit=$code" >> "$LOG"
if [ $code -eq 0 ]; then echo "Done. Open http://127.0.0.1:8765/console/live/ (restart the local engine if it is running)."; else echo "Build failed (exit $code). See $LOG."; fi
