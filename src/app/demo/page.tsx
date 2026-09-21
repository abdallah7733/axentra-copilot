import type { Metadata } from "next";
import { DemoControls } from "@/components/workspace/demo-controls";
import { TopBar } from "@/components/workspace/top-bar";
import { Workspace } from "@/components/workspace/workspace";

export const metadata: Metadata = { title: "Interactive Demo, Axentra Agent Copilot" };

export default function DemoPage() {
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col min-h-0 overflow-y-auto lg:overflow-hidden">
        <Workspace className="flex-1" />
      </div>
      <DemoControls />
    </main>
  );
}
