/*
  Word error counts by minimum edit distance (scoring file, section 3.3): substitutions, deletions
  and insertions against the reference, never merged into one figure without the parts.
*/

export type ErrorCounts = { ref: number; sub: number; del: number; ins: number };

/** The fewest substitutions, deletions and insertions that turn `ref` into `hyp`. */
export function align<R, H>(ref: R[], hyp: H[], same: (r: R, h: H) => boolean): ErrorCounts {
  type Cell = { cost: number; sub: number; del: number; ins: number };
  let prev: Cell[] = Array.from({ length: hyp.length + 1 }, (_, j) => ({ cost: j, sub: 0, del: 0, ins: j }));
  for (let i = 1; i <= ref.length; i++) {
    const row: Cell[] = [{ cost: i, sub: 0, del: i, ins: 0 }];
    for (let j = 1; j <= hyp.length; j++) {
      const match = same(ref[i - 1], hyp[j - 1]);
      const diag = prev[j - 1];
      const options: Cell[] = [
        { cost: diag.cost + (match ? 0 : 1), sub: diag.sub + (match ? 0 : 1), del: diag.del, ins: diag.ins },
        { cost: prev[j].cost + 1, sub: prev[j].sub, del: prev[j].del + 1, ins: prev[j].ins },
        { cost: row[j - 1].cost + 1, sub: row[j - 1].sub, del: row[j - 1].del, ins: row[j - 1].ins + 1 },
      ];
      // Fewest edits; on a tie, prefer a substitution over a deletion plus an insertion, as is conventional.
      row.push(options.reduce((best, o) => (o.cost < best.cost ? o : best)));
    }
    prev = row;
  }
  const end = prev[hyp.length];
  return { ref: ref.length, sub: end.sub, del: end.del, ins: end.ins };
}

/** (S + D + I) ÷ reference length, or null when the reference is empty (report invented words instead). */
export const errorRate = (c: ErrorCounts): number | null => (c.ref ? (c.sub + c.del + c.ins) / c.ref : null);
