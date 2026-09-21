import Link from "next/link";
import { ArrowRightIcon, PlayIcon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "@/components/ui/button";

export function Closing() {
  return (
    <section className="border-t border-border bg-card">
      <div className="mx-auto max-w-7xl px-6 py-24 text-center md:py-28">
        <h2 className="mx-auto max-w-[24ch] text-balance text-3xl font-medium tracking-tight md:text-4xl">Take the call yourself, or watch it play.</h2>
        <p className="mx-auto mt-4 max-w-[52ch] text-muted-foreground">
          The interactive demo lets you drive every step, including the paths that go wrong. The product experience plays the same workspace as a timed sequence.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" className="h-11 rounded-full px-5 text-[15px]">
            <Link href="/demo">
              Launch Demo <ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-11 rounded-full px-5 text-[15px]">
            <Link href="/presentation">
              <PlayIcon data-icon="inline-start" weight="fill" /> Watch Product Experience
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
