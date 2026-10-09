import type { App, CheckStatus } from '../../src/types.ts';

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** What the fake platforms know about a number: the same answer on every run and in every process. */
export function truth(app: App, e164: string): Exclude<CheckStatus, 'unknown'> {
  return hash(`${app}|${e164}`) % 3 === 0 ? 'yes' : 'not_found';
}
