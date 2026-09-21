"use client";

import { motion } from "motion/react";
import { workflow } from "@/lib/demo-data";
import { Mono } from "@/components/workspace/bits";

/*
  Nine steps on a horizontal scroll-snap track. Not a nine-card stack.
  The one eyebrow label on the page lives here.
*/
export function Sequence() {
  return (
    <section id="how-it-works" className="scroll-mt-16 border-y border-border bg-card">
      <div className="mx-auto max-w-7xl px-6 pt-20 md:pt-24">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-blue">How it works</p>
        <h2 className="mt-3 max-w-[65ch] text-3xl font-medium tracking-tight md:text-4xl">Nine steps, one call, one human decision.</h2>
        <p className="mt-4 max-w-[65ch] text-muted-foreground">Every step below is a real state in the product. Scroll the track, or open the demo and watch them light up in order.</p>
      </div>
      <div
        className="scrollbar-none mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-20 md:pb-24"
        style={{ paddingInline: "max(1.5rem, calc((100vw - 80rem) / 2 + 1.5rem))", scrollPaddingInline: "max(1.5rem, calc((100vw - 80rem) / 2 + 1.5rem))" }}
      >
        <div className="flex gap-4">
          {workflow.map((w, i) => (
            <motion.div
              key={w.key}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ delay: i * 0.05, duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex w-[17rem] shrink-0 snap-start flex-col justify-between rounded-lg border border-border bg-background p-5"
            >
              <div className="flex items-center justify-between">
                <Mono className="text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</Mono>
                {i === 7 && <span className="rounded-full border border-cyan/60 bg-cyan/10 px-2 py-0.5 text-[11px]">Human</span>}
              </div>
              <div className="mt-10">
                <div className="text-xl font-medium tracking-tight">{w.label}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{w.detail}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
