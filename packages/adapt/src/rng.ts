/** Deterministic randomness: every fit and evaluation is reproducible from its seed. */
export class Rng {
  #s: number;
  constructor(seed: number) { this.#s = seed | 0; }
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.#s ^ (this.#s >>> 15), 1 | this.#s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(n: number): number { return Math.floor(this.next() * n); }
  gaussian(): number { const u = 1 - this.next(), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}
