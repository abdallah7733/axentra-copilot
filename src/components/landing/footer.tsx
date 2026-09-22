import Link from "next/link";
import { SLOGAN, Wordmark } from "@/components/brand/wordmark";

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-10 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <Wordmark height={16} />
          <span className="hidden h-4 w-px bg-border md:block" />
          <span className="text-[13px] tracking-[0.12em]">{SLOGAN}</span>
        </div>
        <nav className="flex flex-wrap gap-5" aria-label="Footer">
          <Link href="/demo" className="hover:text-foreground">Launch Demo</Link>
          <Link href="/presentation" className="hover:text-foreground">Watch Product Experience</Link>
          <Link href="/sop" className="hover:text-foreground">SOP</Link>
        </nav>
      </div>
      <div className="mx-auto max-w-7xl px-6 pb-8 text-xs text-muted-foreground/80">
        Prototype. Simulated CRM and billing integration. AtlasOne Communications and all customer data are fictional.
      </div>
    </footer>
  );
}
