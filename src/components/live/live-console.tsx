"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeftIcon, BookOpenTextIcon, LockKeyIcon } from "@phosphor-icons/react";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { SopSheet } from "@/components/workspace/sop-sheet";
import { pack, useCopilot } from "@/lib/live/copilot-store";
import { useLive } from "@/lib/live/store";
import { CallDetails } from "./call-details";
import { LiveControls } from "./live-controls";
import { LiveCopilot } from "./live-copilot";
import { LiveTranscript } from "./live-transcript";

function LiveTopBar() {
  const setSop = useLive((s) => s.setSop);
  // The client and copilot labels only appear on the presenter's machine; the public page keeps its note.
  const online = useLive((s) => s.engine === "online");
  return (
    <header className="flex h-12 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-4 min-w-0">
        <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground" aria-label="Back to home">
          <ArrowLeftIcon className="size-4" />
        </Link>
        <Wordmark height={16} opticalCenter />
        <span className="hidden h-4 w-px bg-border sm:block" />
        <span className="hidden text-xs text-muted-foreground sm:block">Live call mode</span>
        {online && (
          <>
            <span className="hidden h-4 w-px bg-border md:block" />
            <span className="hidden truncate text-xs text-muted-foreground md:block">
              {pack.company.name}, fictional client <span className="mx-1">/</span> {pack.agent.name}, {pack.agent.team}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {online ? (
          <span className="hidden text-[11px] text-muted-foreground xl:block">Real call. Speech and copilot run on this Mac. No cloud AI.</span>
        ) : (
          <span className="hidden text-[11px] text-muted-foreground lg:block">Real call. Speech recognition runs on this Mac. No cloud transcription.</span>
        )}
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => setSop(true)}>
          <BookOpenTextIcon data-icon="inline-start" /> SOP
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}

/** Sunlake's SOP, highlighting the scenario and authority band the copilot recommends. */
function LiveSopSheet() {
  const open = useLive((s) => s.sopOpen);
  const setSop = useLive((s) => s.setSop);
  const rec = useCopilot((s) => s.view.recommendation);
  return (
    <SopSheet
      sop={pack.sop}
      open={open}
      onOpenChange={setSop}
      highlight={rec?.scenario}
      authorityRow={rec?.authorityRow}
      note={`${pack.company.name} is a fictional client.`}
    />
  );
}

/* Shown on the public site, where the local engine does not exist. */
function Unavailable() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md space-y-4 rounded-lg border border-border bg-card p-6 text-center">
        <LockKeyIcon className="mx-auto size-6 text-muted-foreground" />
        <h1 className="text-base font-medium">Live call mode runs on the presenter&apos;s machine</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          It needs the Axentra local speech engine and the private demo phone line, so it is not available on the public site. The full copilot
          workflow is available in the Interactive Demo.
        </p>
        <Button asChild size="sm" className="rounded-full">
          <Link href="/demo">Open the Interactive Demo</Link>
        </Button>
      </div>
    </div>
  );
}

export function LiveConsole() {
  const engine = useLive((s) => s.engine);
  const checkEngine = useLive((s) => s.checkEngine);

  useEffect(() => {
    void checkEngine();
  }, [checkEngine]);

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background">
      <LiveTopBar />
      {engine === "checking" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Looking for the local speech engine…</div>
      ) : engine === "offline" ? (
        <Unavailable />
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col min-h-0 overflow-y-auto lg:overflow-hidden">
            {/* Same four-zone proportions as the scripted Agent Workspace. */}
            <div className="grid flex-1 min-h-0 gap-3 p-3 grid-cols-1 lg:grid-cols-[1fr_1.2fr_0.9fr] lg:grid-rows-[minmax(0,1fr)]">
              <LiveTranscript className="min-h-[18rem] lg:min-h-0" />
              <LiveCopilot className="min-h-[18rem] lg:min-h-0" />
              <CallDetails />
            </div>
          </div>
          <LiveControls />
        </>
      )}
      <LiveSopSheet />
    </main>
  );
}
