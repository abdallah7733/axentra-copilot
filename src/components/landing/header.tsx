import Link from "next/link";
import { SLOGAN, Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const nav = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "/demo", label: "Interactive Demo" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-white/10 bg-navy text-white">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-6">
        <div className="flex items-center gap-3">
          <Link href="/" aria-label="Axentra home" className="flex items-center">
            <Wordmark lockup="reversed" height={18} opticalCenter />
          </Link>
          <span className="hidden h-4 w-px bg-white/20 sm:block" />
          <span className="hidden text-[11px] tracking-[0.12em] text-white/65 sm:inline">{SLOGAN}</span>
        </div>
        <nav className="hidden items-center gap-7 text-sm text-white/80 md:flex" aria-label="Primary">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="transition-colors hover:text-white">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle className="text-white/80 hover:bg-white/10 hover:text-white" />
          <Button asChild className="rounded-full bg-cyan px-4 text-navy hover:bg-cyan/85">
            <Link href="/demo">Launch Demo</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
