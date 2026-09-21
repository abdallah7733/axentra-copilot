import { Closing } from "@/components/landing/closing";
import { Footer } from "@/components/landing/footer";
import { Header } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { Problem } from "@/components/landing/problem";
import { Sequence } from "@/components/landing/sequence";
import { Strengths } from "@/components/landing/strengths";

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Problem />
        <Sequence />
        <Strengths />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
