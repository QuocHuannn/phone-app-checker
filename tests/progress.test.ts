import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressRenderer, type ProgressEvent } from '../src/progress.ts';
import { createUi, displayWidth, PLAIN_UI, stripAnsi } from '../src/ui.ts';

const ESC = '\u001b';
const RICH_ENV = { TERM: 'xterm-256color' };

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { mode: 'bar' | 'lines'; columns?: number; rich?: boolean }) {
  vi.useFakeTimers();
  let clock = 1_000_000;
  const writes: string[] = [];
  const lines: string[] = [];
  const stream = { isTTY: options.rich !== false, columns: options.columns ?? 100, rows: 30 };
  const ui = options.rich === false ? PLAIN_UI : createUi(stream, RICH_ENV);
  const renderer = new ProgressRenderer({
    mode: options.mode,
    ui,
    stream: { write: (text) => writes.push(text) },
    line: (text) => lines.push(text),
    now: () => clock,
  });
  return {
    renderer,
    writes,
    lines,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    now: () => clock,
    /** The line currently on screen (what is left after the last carriage return). */
    screen: () => stripAnsi(writes.join('')).split('\r').filter((part) => part !== '').at(-1) ?? '',
  };
}

const event = (app: ProgressEvent['app'], needed: number, remaining: number, waiting?: ProgressEvent['waiting']): ProgressEvent => ({
  app,
  needed,
  remaining,
  ...(waiting === undefined ? {} : { waiting }),
});

describe('ProgressRenderer on a rich terminal (bar)', () => {
  it('draws spinner, bar, percentage, processed/total and per-app counters, redrawn in place', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('telegram', 100, 100));
    t.renderer.update(event('whatsapp', 100, 100));
    t.renderer.update(event('telegram', 100, 40));
    const text = t.screen();
    expect(text).toMatch(/^⠋|^[⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(text).toContain('30% 60/200');
    expect(text).toContain('telegram 60/100');
    expect(text).toContain('whatsapp 0/100');
    expect(text).toMatch(/[█░]{8,}/);
    // Every draw first erases the line (carriage return + clear line); nothing is ever written with a newline.
    expect(t.writes.every((w) => w.startsWith(`\r${ESC}[2K`))).toBe(true);
    expect(t.writes.join('')).not.toContain('\n');
    t.renderer.finish();
  });

  it('shows no per-app counters for a single app, and a full bar at 100%', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 10, 10));
    t.renderer.update(event('zalo', 10, 0));
    expect(t.screen()).toContain('100% 10/10');
    expect(t.screen()).not.toContain('zalo 10/10');
    expect(t.screen()).not.toContain('░');
    t.renderer.finish();
  });

  it('keeps animating the spinner on its own timer, and stops after finish()', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 10, 10));
    const first = t.writes.length;
    t.advance(500);
    expect(t.writes.length).toBeGreaterThan(first + 2);
    t.renderer.finish();
    const after = t.writes.length;
    t.advance(2000);
    expect(t.writes.length).toBe(after);
  });

  it('finish() erases the bar and later updates are ignored', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 10, 5));
    t.renderer.finish();
    expect(t.writes.at(-1)).toBe(`\r${ESC}[2K`);
    const count = t.writes.length;
    t.renderer.update(event('zalo', 10, 0));
    t.renderer.finish();
    expect(t.writes.length).toBe(count);
  });

  it('estimates the time left from the pace so far, only after a few seconds of work', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 100, 100));
    t.advance(1000);
    t.renderer.update(event('zalo', 100, 90));
    expect(t.screen()).not.toContain('ETA');
    t.advance(9000);
    t.renderer.update(event('zalo', 100, 50));
    // 50 numbers in 10 s: 50 left take 10 s.
    expect(t.screen()).toContain('ETA 10 s');
    t.renderer.finish();
  });

  it('says when it is waiting: a cooldown shows when it resumes, a pacing delay how long', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('telegram', 10, 5));
    const resume = new Date(t.now() + 90 * 60_000);
    t.renderer.update(event('telegram', 10, 5, { until: resume.getTime(), kind: 'cooldown' }));
    const hh = String(resume.getHours()).padStart(2, '0');
    const mm = String(resume.getMinutes()).padStart(2, '0');
    expect(t.screen()).toContain(`resting until ${hh}:${mm}`);
    t.renderer.update(event('telegram', 10, 5, { until: t.now() + 4000, kind: 'pacing' }));
    expect(t.screen()).toContain('pacing 4 s');
    t.renderer.update(event('telegram', 10, 5));
    expect(t.screen()).not.toContain('resting');
    expect(t.screen()).not.toContain('pacing');
    t.renderer.finish();
  });

  it('never draws a line wider than the window, at 80 and at 40 columns, and shrinks the bar first', () => {
    for (const columns of [120, 80, 40, 24]) {
      const t = setup({ mode: 'bar', columns });
      for (const app of ['telegram', 'whatsapp', 'zalo', 'viber', 'line'] as const) t.renderer.update(event(app, 1234, 1000));
      t.renderer.update(event('telegram', 1234, 1000, { until: t.now() + 3_600_000, kind: 'cooldown' }));
      for (const text of t.writes.map(stripAnsi)) expect(displayWidth(text.replace(/^\r\u001b?\[?2?K?/, '')), `@${columns}`).toBeLessThanOrEqual(columns - 1);
      t.renderer.finish();
    }
  });

  it('wrapLog erases the bar, writes the message, then draws the bar again', () => {
    const t = setup({ mode: 'bar' });
    const logged: string[] = [];
    const say = t.renderer.wrapLog((message) => {
      logged.push(message);
      t.writes.push(`LOG:${message}\n`);
    });
    t.renderer.update(event('zalo', 10, 5));
    const before = t.writes.length;
    say('zalo: 5 checked, 5 left');
    const tail = t.writes.slice(before);
    expect(tail[0]).toBe(`\r${ESC}[2K`);
    expect(tail[1]).toBe('LOG:zalo: 5 checked, 5 left\n');
    expect(stripAnsi(tail[2] ?? '')).toContain('50% 5/10');
    expect(logged).toEqual(['zalo: 5 checked, 5 left']);
    t.renderer.finish();
  });

  it('draws nothing while there is nothing to check', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 0, 0));
    t.advance(1000);
    t.renderer.finish();
    expect(t.writes).toEqual([]);
  });
});

describe('ProgressRenderer as plain lines (not a terminal)', () => {
  it('writes periodic plain lines and never an escape sequence or a carriage return', () => {
    const t = setup({ mode: 'lines', rich: false });
    t.renderer.update(event('telegram', 100, 100));
    t.renderer.update(event('whatsapp', 100, 100));
    // The first line is written at the first report (apps start in parallel, so the total grows as the others report in).
    expect(t.lines).toEqual(['progress 0% 0/100']);
    t.advance(3000);
    t.renderer.update(event('telegram', 100, 70));
    // Not enough time passed since the last line: nothing new.
    expect(t.lines).toHaveLength(1);
    t.advance(8000);
    t.renderer.update(event('telegram', 100, 40));
    expect(t.lines).toHaveLength(2);
    expect(t.lines[1]).toMatch(/^progress 30% 60\/200 \| telegram 60\/100, whatsapp 0\/100 \| ETA \d+ s$/);
    t.renderer.update(event('telegram', 100, 0));
    t.renderer.update(event('whatsapp', 100, 0));
    // Finishing always writes the last state once.
    expect(t.lines.at(-1)).toBe('progress 100% 200/200 | telegram 100/100, whatsapp 100/100');
    for (const line of t.lines) {
      expect(line).not.toContain(ESC);
      expect(line).not.toContain('\r');
      expect(line).not.toContain('\n');
    }
    expect(t.writes).toEqual([]);
    t.renderer.finish();
  });

  it('writes a closing line when the run stops early, and none when nothing was reported', () => {
    const early = setup({ mode: 'lines', rich: false });
    early.renderer.update(event('zalo', 10, 10));
    early.advance(1000);
    early.renderer.update(event('zalo', 10, 8));
    early.renderer.finish();
    expect(early.lines.at(-1)).toBe('progress 20% 2/10');

    const silent = setup({ mode: 'lines', rich: false });
    silent.renderer.finish();
    expect(silent.lines).toEqual([]);
  });

  it('wrapLog is the log itself: nothing is added or reordered', () => {
    const t = setup({ mode: 'lines', rich: false });
    const log = (message: string): void => void message;
    expect(t.renderer.wrapLog(log)).toBe(log);
  });

  it('reports a cooldown as plain text', () => {
    const t = setup({ mode: 'lines', rich: false });
    t.renderer.update(event('zalo', 10, 4, { until: t.now() + 60 * 60_000, kind: 'cooldown' }));
    expect(t.lines[0]).toMatch(/^progress 60% 6\/10 \| resting until \d\d:\d\d$/);
  });
});
