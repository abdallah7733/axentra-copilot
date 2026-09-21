import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Mono } from "@/components/workspace/bits";
import { SopBody } from "@/components/workspace/sop-sheet";
import { sop } from "@/lib/demo-data";

export const metadata: Metadata = { title: "Billing SOP 4.2, Axentra Agent Copilot" };

export default function SopPage() {
  return (
    <main className="min-h-dvh bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border bg-card px-6">
        <Link href="/" aria-label="Axentra home">
          <Wordmark height={16} />
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild size="sm" className="rounded-full">
            <Link href="/demo">Launch Demo</Link>
          </Button>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-6 py-14">
        <p className="text-xs text-muted-foreground"><Mono>{sop.id}</Mono> · {sop.version} · {sop.owner}</p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight">{sop.title}</h1>
        <p className="mt-3 max-w-[65ch] text-muted-foreground">
          This is the policy the copilot reads from during the demo. Recommendations in the workspace cite the scenario and authority band below. Fictional, written for the AtlasOne Communications scenario.
        </p>
        <div className="mt-10">
          <SopBody highlight="A" />
        </div>
      </article>
    </main>
  );
}
