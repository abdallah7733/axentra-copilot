"use client";

import { cn } from "@/lib/utils";
import { ApprovalDialog } from "./approval-dialog";
import { ContextualWorkspace } from "./contextual-workspace";
import { CopilotPanel } from "./copilot-panel";
import { CustomerContext } from "./customer-context";
import { SopSheet } from "./sop-sheet";
import { Transcript } from "./transcript";

/*
  The four-zone Agent Workspace. Locked proportions:
  transcript rail 1fr, copilot 1.2fr, customer context + contextual panel 0.9fr.
  Both /demo and /presentation render exactly this tree.
*/
export function Workspace({ className, overlays = true }: { className?: string; overlays?: boolean }) {
  return (
    <div className={cn("grid min-h-0 gap-3 p-3 grid-cols-1 lg:grid-cols-[1fr_1.2fr_0.9fr] lg:grid-rows-[minmax(0,1fr)]", className)}>
      <Transcript className="min-h-[18rem] lg:min-h-0" />
      <CopilotPanel className="min-h-[18rem] lg:min-h-0" />
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-rows-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <CustomerContext />
        <ContextualWorkspace />
      </div>
      {overlays && (
        <>
          <SopSheet />
          <ApprovalDialog />
        </>
      )}
    </div>
  );
}
