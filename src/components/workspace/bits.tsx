"use client";

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDownIcon, InfoIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono tabular text-[0.92em]", className)}>{children}</span>;
}

/** Small cyan pulse that only appears when something is genuinely live. */
export function LiveDot({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden>
      {active && <span className="absolute inset-0 rounded-full bg-cyan animate-ping opacity-60" />}
      <span className={cn("relative inline-flex size-2 rounded-full", active ? "bg-cyan" : "bg-muted-foreground/30")} />
    </span>
  );
}

export function PanelHeader({ title, meta, children, className }: { title: string; meta?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border", className)}>
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="text-[13px] font-medium tracking-tight">{title}</h2>
        {meta && <span className="text-xs text-muted-foreground truncate">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/** Inline "why" disclosure. Never a modal, so it does not break flow on camera. */
export function Explain({ label = "Why", children, defaultOpen = false, className }: { label?: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-muted-blue hover:text-foreground transition-colors"
      >
        <InfoIcon className="size-3.5" />
        <span>{label}</span>
        <CaretDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-2 text-muted-foreground leading-relaxed">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const spring = { type: "spring", stiffness: 260, damping: 28 } as const;
export const ease = [0.2, 0.8, 0.2, 1] as const;
