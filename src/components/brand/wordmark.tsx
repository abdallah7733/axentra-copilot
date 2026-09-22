import { cn } from "@/lib/utils";

/*
  The Axentra wordmark, geometry copied verbatim from
  public/brand/axentra-wordmark-navy.svg (Reference 4, refined).
  Never re-typeset. Two lockups only: navy on light, reversed on navy.
  Fill uses currentColor so the lockup follows the surface it sits on.
*/
const PATH =
  "M228.01 -300H310V0H228.01V-13.24C206.25 -1.6 181.4 5 155 5C69.4 5 0 -64.4 0 -150C0 -235.6 69.4 -305 155 -305C181.4 -305 206.25 -298.4 228.01 -286.76ZM1872.12 -300H1954.11V0H1872.12V-13.24C1850.37 -1.6 1825.51 5 1799.11 5C1713.51 5 1644.11 -64.4 1644.11 -150C1644.11 -235.6 1713.51 -305 1799.11 -305C1825.51 -305 1850.37 -298.4 1872.12 -286.76ZM943.93 -150C943.93 -137.28 942.4 -124.93 939.51 -113.1H725.03C737.47 -89.62 761.42 -73.72 788.93 -73.72C805.06 -73.72 819.96 -79.18 832.04 -88.43L877.84 -23.02C852.67 -5.36 822.01 5 788.93 5C703.33 5 633.93 -64.4 633.93 -150C633.93 -235.6 703.33 -305 788.93 -305C874.54 -305 943.93 -235.6 943.93 -150ZM1162.52 -170C1162.52 -201.08 1138.79 -226.28 1109.52 -226.28C1080.25 -226.28 1056.52 -201.08 1056.52 -170V0H974.52V-300H1056.52V-294.2C1072.79 -301.15 1090.71 -305 1109.52 -305C1183.91 -305 1244.25 -244.83 1244.52 -170.5V0H1162.52ZM340.21 -300H434.13L483.71 -226.4L533.28 -300H627.21L530.67 -156.68L636.21 0H542.28L483.71 -86.96L425.13 0H331.21L436.74 -156.68ZM1448.66 5C1356.59 5 1281.93 -69.5 1281.66 -161.5V-368.36L1363.66 -395V-300H1448.66V-224.56H1363.66V-162C1363.66 -113.24 1401.71 -73.72 1448.66 -73.72ZM1641.79 -305V-226.28C1594.84 -226.28 1556.79 -186.76 1556.79 -138V0H1474.79V-138.5C1475.06 -230.5 1549.72 -305 1641.79 -305ZM228 -150C228 -192.13 195.32 -226.28 155 -226.28C114.68 -226.28 82 -192.13 82 -150C82 -107.87 114.68 -73.72 155 -73.72C195.32 -73.72 228 -107.87 228 -150ZM1872.11 -150C1872.11 -192.13 1839.43 -226.28 1799.11 -226.28C1758.8 -226.28 1726.11 -192.13 1726.11 -150C1726.11 -107.87 1758.8 -73.72 1799.11 -73.72C1839.43 -73.72 1872.11 -107.87 1872.11 -150ZM788.93 -226.28C761.42 -226.28 737.47 -210.38 725.03 -186.9H852.84C840.39 -210.38 816.44 -226.28 788.93 -226.28Z";

type Lockup = "navy" | "reversed" | "auto";

/**
 * The wordmark's SVG box spans the top of the `t` ascender to the round-letter
 * overshoot, but the ink sits lower than that box: its measured centroid is 9.1%
 * of the height below the box centre. Anything aligned to the box therefore reads
 * high next to the letters. `opticalCenter` lifts the mark so its centroid lands
 * on the row's centre line, which is what the eye expects in a header or footer.
 */
const OPTICAL_CENTER_RATIO = 0.091;

export function Wordmark({
  lockup = "auto",
  className,
  height = 22,
  opticalCenter = false,
}: {
  lockup?: Lockup;
  className?: string;
  /** Rendered height in px. Width follows the 1954:400 ratio. */
  height?: number;
  /** Align the letters' visual centre, not the SVG box, with centred siblings. */
  opticalCenter?: boolean;
}) {
  const color =
    lockup === "navy" ? "text-navy" : lockup === "reversed" ? "text-white" : "text-navy dark:text-white";
  return (
    <svg
      role="img"
      aria-label="Axentra"
      viewBox="0 -395 1954.11 400"
      height={height}
      width={height * (1954.11 / 400)}
      style={opticalCenter ? { transform: `translateY(${-(height * OPTICAL_CENTER_RATIO).toFixed(2)}px)` } : undefined}
      className={cn("shrink-0 fill-current", color, className)}
    >
      <path d={PATH} />
    </svg>
  );
}

/**
 * The brand slogan. One wording, used everywhere it appears.
 */
export const SLOGAN = "AI-Assisted CX Copilot";

/**
 * Wordmark with the slogan set beneath it, as one locked unit.
 * Both the gap and the slogan size are derived from the wordmark height, so the
 * proportions hold at every size. The wordmark itself is never altered.
 */
export function WordmarkLockup({
  lockup = "auto",
  height = 48,
  className,
}: {
  lockup?: Lockup;
  className?: string;
  height?: number;
}) {
  const sloganSize = Math.max(12, Math.round(height * 0.26));
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <Wordmark lockup={lockup} height={height} />
      <span
        className={cn(
          "whitespace-nowrap font-medium",
          lockup === "navy" ? "text-navy/70" : lockup === "reversed" ? "text-white/65" : "text-navy/70 dark:text-white/65"
        )}
        style={{ marginTop: Math.round(height * 0.34), fontSize: sloganSize, letterSpacing: "0.14em" }}
      >
        {SLOGAN}
      </span>
    </div>
  );
}

/** Compact mark: the "a" glyph inside a navy disc, for avatars and small chrome. */
export function CompactMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={cn("shrink-0", className)} aria-hidden>
      <circle cx="256" cy="256" r="256" className="fill-navy dark:fill-white" />
      <g transform="translate(124.5 383.75) scale(0.85)">
        <path
          className="fill-white dark:fill-navy"
          d="M228.01 -300H310V0H228.01V-13.24C206.25 -1.6 181.4 5 155 5C69.4 5 0 -64.4 0 -150C0 -235.6 69.4 -305 155 -305C181.4 -305 206.25 -298.4 228.01 -286.76ZM228 -150C228 -192.13 195.32 -226.28 155 -226.28C114.68 -226.28 82 -192.13 82 -150C82 -107.87 114.68 -73.72 155 -73.72C195.32 -73.72 228 -107.87 228 -150Z"
        />
      </g>
    </svg>
  );
}
