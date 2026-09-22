"use client";

import Link from "next/link";
import { ArrowLeftIcon, BookOpenTextIcon } from "@phosphor-icons/react";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { company, stepTitles } from "@/lib/demo-data";
import { useDemo } from "@/lib/store";
import { LiveDot, Mono } from "./bits";

export function TopBar() {
  const step = useDemo((s) => s.step);
  const setSop = useDemo((s) => s.setSop);
  const live = step !== "idle" && step !== "resolved";
  return (
    <header className="flex h-12 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-4 min-w-0">
        <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground" aria-label="Back to home">
          <ArrowLeftIcon className="size-4" />
        </Link>
        <Wordmark height={16} opticalCenter />
        <span className="hidden h-4 w-px bg-border sm:block" />
        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span>{company.name}</span>
          <span className="opacity-40">/</span>
          <span>{company.agent.team}</span>
          <span className="opacity-40">/</span>
          <Mono>{company.caseId}</Mono>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs md:flex">
          <LiveDot active={live} />
          {stepTitles[step]}
        </span>
        <span className="hidden text-[11px] text-muted-foreground lg:block">Prototype. Simulated CRM and billing integration.</span>
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => setSop(true)}>
          <BookOpenTextIcon data-icon="inline-start" /> SOP
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
