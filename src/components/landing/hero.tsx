import Link from "next/link";
import { ArrowRightIcon, PlayIcon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "@/components/ui/button";
import { HeroPreview } from "./hero-preview";

export function Hero() {
  return (
    <section className="bg-navy text-white">
      <div className="mx-auto max-w-7xl px-6 pb-16 pt-14 md:pb-20 md:pt-20">
        <h1 className="max-w-[30ch] text-balance text-4xl font-medium tracking-tighter leading-none md:text-5xl xl:text-6xl">
          AI Assistance That Works Alongside Your Customer Experience Team
        </h1>
        <div className="mt-10 grid items-start gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
          <div className="max-w-[40ch]">
            <p className="text-lg leading-relaxed text-white/75">
              Listens to the call, verifies the customer, finds the SOP answer, and waits for a human to approve.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-11 rounded-full bg-cyan px-5 text-[15px] text-navy hover:bg-cyan/85">
                <Link href="/demo">
                  Launch Demo <ArrowRightIcon data-icon="inline-end" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 rounded-full border-white/25 bg-transparent px-5 text-[15px] text-white hover:bg-white/10 hover:text-white">
                <Link href="/presentation">
                  <PlayIcon data-icon="inline-start" weight="fill" /> Watch Product Experience
                </Link>
              </Button>
            </div>
          </div>
          <HeroPreview />
        </div>
      </div>
    </section>
  );
}
