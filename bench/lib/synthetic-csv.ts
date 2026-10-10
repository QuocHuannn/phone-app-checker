// Deterministic synthetic input for the benchmark. Numbers are generated, never looked up:
// fake Vietnam mobile shapes (~80% national, ~12% +84…, ~8% 84…), 3% duplicate cells, 2% invalid.

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIXES = ['90', '91', '93', '94', '96', '97', '98', '86', '88', '32', '33', '35', '36', '37', '38', '39', '70', '76', '77', '78', '79'];

/** The synthetic input file for `rows` lines under `seed`; identical on every run and machine. */
export function generateCsv(rows: number, seed: number): string {
  const rnd = mulberry32(seed);
  const digits = (k: number) => Array.from({ length: k }, () => Math.floor(rnd() * 10)).join('');
  const lines = ['name,phone_number,city'];
  const valid: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    const r = rnd();
    let cell: string;
    if (r < 0.03 && valid.length > 0) {
      cell = valid[Math.floor(rnd() * valid.length)] as string;
    } else if (r < 0.05) {
      cell = `xx${digits(3)}`;
    } else {
      const national = `0${PREFIXES[Math.floor(rnd() * PREFIXES.length)]}${digits(7)}`;
      const f = rnd();
      cell = f < 0.8 ? national : f < 0.92 ? `+84${national.slice(1)}` : `84${national.slice(1)}`;
      valid.push(cell);
    }
    lines.push(`Person ${i},${cell},Hanoi`);
  }
  return `${lines.join('\n')}\n`;
}
