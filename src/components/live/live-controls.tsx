"use client";

import { useState, type FormEvent } from "react";
import { MicrophoneIcon, PhoneDisconnectIcon, PhoneIcon, PhoneXIcon, PlayIcon, StopIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LiveDot } from "@/components/workspace/bits";
import { replayScripts } from "@/lib/live/replay-scripts";
import { useLive } from "@/lib/live/store";

const selectClass =
  "h-7 max-w-64 rounded-full border border-input bg-transparent px-2.5 text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/* Rehearsal: replays a script through the copilot with no call, audio or engine. */
function Replay() {
  const phase = useLive((s) => s.phase);
  const replaying = useLive((s) => s.replaying);
  const replay = useLive((s) => s.replay);
  const stopReplay = useLive((s) => s.stopReplay);
  const [id, setId] = useState(replayScripts[0].id);
  if (phase === "incoming" || phase === "active" || phase === "connecting") return null;
  return (
    <span className="flex items-center gap-1.5">
      <select value={id} onChange={(e) => setId(e.target.value)} disabled={replaying} aria-label="Replay script" className={selectClass}>
        {replayScripts.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </select>
      {replaying ? (
        <Button variant="outline" size="sm" className="rounded-full" onClick={stopReplay}>
          <StopIcon data-icon="inline-start" /> Stop replay
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => replay(replayScripts.find((r) => r.id === id)!.lines)}>
          <PlayIcon data-icon="inline-start" /> Replay (no call)
        </Button>
      )}
    </span>
  );
}

/* Presenter controls for a real call. The access code is typed here, kept in
   memory for token refresh only, and cleared from the field immediately. */
export function LiveControls() {
  const phase = useLive((s) => s.phase);
  const status = useLive((s) => s.status);
  const error = useLive((s) => s.error);
  const mics = useLive((s) => s.mics);
  const micId = useLive((s) => s.micId);
  const setMic = useLive((s) => s.setMic);
  const connect = useLive((s) => s.connect);
  const answer = useLive((s) => s.answer);
  const decline = useLive((s) => s.decline);
  const hangUp = useLive((s) => s.hangUp);
  const clearTranscript = useLive((s) => s.clearTranscript);
  const lineCount = useLive((s) => s.lines.length);
  const [code, setCode] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = code;
    setCode("");
    void connect(value);
  };

  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {(phase === "setup" || phase === "connecting") && (
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Private access code"
              aria-label="Private access code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={phase === "connecting"}
              className="h-7 w-52 rounded-full"
            />
            <Button type="submit" size="sm" className="rounded-full" disabled={phase === "connecting" || !code}>
              <PhoneIcon data-icon="inline-start" /> {phase === "connecting" ? "Connecting…" : "Start receiving calls"}
            </Button>
          </form>
        )}
        {phase === "incoming" && (
          <>
            <Button size="sm" className="rounded-full" onClick={answer}>
              <PhoneIcon data-icon="inline-start" /> Answer
            </Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={decline}>
              <PhoneXIcon data-icon="inline-start" /> Decline
            </Button>
          </>
        )}
        {phase === "active" && (
          <Button variant="destructive" size="sm" className="rounded-full" onClick={hangUp}>
            <PhoneDisconnectIcon data-icon="inline-start" /> Hang up
          </Button>
        )}
        <Replay />
        {phase !== "active" && phase !== "incoming" && lineCount > 0 && (
          <Button variant="ghost" size="sm" className="rounded-full" onClick={clearTranscript}>
            Clear transcript
          </Button>
        )}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <LiveDot active={phase === "ready" || phase === "incoming" || phase === "active"} />
          {status}
        </span>
        {error && (
          <span className="flex items-center gap-1.5 text-xs text-destructive">
            <WarningIcon className="size-3.5" /> {error}
          </span>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <MicrophoneIcon className="size-3.5" />
        <span className="hidden sm:inline">Agent microphone</span>
        <select
          value={micId}
          onChange={(e) => setMic(e.target.value)}
          disabled={phase === "active"}
          className={selectClass}
        >
          <option value="">System default</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </footer>
  );
}
