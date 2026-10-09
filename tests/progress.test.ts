import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator, type Translator } from '../src/i18n/index.ts';
import { ProgressRenderer, type AccountProgress, type ProgressEvent } from '../src/progress.ts';
import type { CheckStatus } from '../src/types.ts';
import { createUi, displayWidth, formatLocalTime, PLAIN_UI, stripAnsi } from '../src/ui.ts';
import { screenGrid, type ScreenGrid } from './helpers/screen-grid.ts';

const ESC = '';
const RICH_ENV = { TERM: 'xterm-256color' };

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: {
  mode: 'bar' | 'lines' | 'plain';
  columns?: number;
  rows?: number;
  rich?: boolean;
  tickMs?: number;
  title?: string;
  logPath?: string;
  tr?: Translator;
  lineIntervalMs?: number;
}) {
  vi.useFakeTimers();
  let clock = 1_000_000;
  const writes: string[] = [];
  const lines: string[] = [];
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  const stream = { isTTY: options.rich !== false, columns, rows };
  const ui = options.rich === false ? PLAIN_UI : createUi(stream, RICH_ENV);
  const grid = screenGrid({ columns, rows });
  const renderer = new ProgressRenderer({
    mode: options.mode,
    ui,
    stream: {
      write: (text) => {
        writes.push(text);
        grid.feed(text);
      },
    },
    line: (text) => lines.push(text),
    now: () => clock,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    ...(options.lineIntervalMs === undefined ? {} : { lineIntervalMs: options.lineIntervalMs }),
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.tr === undefined ? {} : { tr: options.tr }),
  });
  // In bar mode `update` only records; the frame is drawn by the 1 Hz interval (the first update
  // draws once at once). Firing the timer draws the recorded state.
  const draw = () => vi.advanceTimersByTime(options.tickMs ?? 1000);
  return {
    renderer,
    writes,
    lines,
    draw,
    grid,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    now: () => clock,
    /** The rows a terminal would show right now, as one string. */
    screen: () => grid.snapshot(),
  };
}

const event = (
  app: ProgressEvent['app'],
  needed: number,
  remaining: number,
  waiting?: ProgressEvent['waiting'],
  accounts?: AccountProgress[],
): ProgressEvent => ({
  app,
  needed,
  remaining,
  ...(waiting === undefined ? {} : { waiting }),
  ...(accounts === undefined ? {} : { accounts }),
});

const ALL_STATUSES: Record<CheckStatus, number> = { yes: 0, not_found: 0, unknown: 0 };

const acct = (
  account: string,
  state: AccountProgress['state'],
  extra: Partial<AccountProgress> = {},
): AccountProgress => {
  const counts: Record<CheckStatus, number> = { ...ALL_STATUSES, ...(extra.counts ?? {}) };
  const { counts: _counts, done: explicitDone, ...rest } = extra;
  const done = explicitDone ?? counts.yes + counts.not_found + counts.unknown;
  return { account, state, ...rest, counts, done };
};

describe('ProgressRenderer on a rich terminal (dashboard)', () => {
  it('draws a framed dashboard: elapsed/rate, per-account rows, totals bar, counts and the log path', () => {
    const t = setup({ mode: 'bar', columns: 80, rows: 24, logPath: '/tmp/run.log' });
    const resume = t.now() + 90 * 60_000;
    t.renderer.update(
      event('telegram', 40, 40, undefined, [
        acct('a', 'working', { counts: { ...ALL_STATUSES, yes: 5 }, done: 5, lastBatchMs: 1200 }),
        acct('b', 'cooldown', { waitingUntil: resume }),
      ]),
    );
    t.renderer.update(event('whatsapp', 40, 40, undefined, [acct('w', 'done', { counts: { ...ALL_STATUSES, yes: 40 }, done: 40 })]));
    t.draw(); // the second update was recorded; the timer draws it
    const text = t.screen();
    expect(text).toContain('Elapsed');
    expect(text).toContain('/min');
    expect(text).toContain('APP');
    expect(text).toContain('ACCOUNT');
    expect(text).toContain('working');
    expect(text).toContain('resting');
    expect(text).toContain(`resumes ${formatLocalTime(resume, t.now())}`);
    expect(text).toContain('5/40');
    expect(text).toContain('of 80 checks');
    expect(text).toContain('40 numbers x 2 apps');
    expect(text).toContain('yes 45');
    expect(text).toContain('Ctrl+C');
    expect(text).toContain('Log: /tmp/run.log');
    t.renderer.finish();
  });

  it.each([
    ['en', translator()],
    ['vi', translator('vi')],
  ] as const)('aligns every translated table header with its values (%s)', (_lang, tr) => {
    const t = setup({ mode: 'bar', columns: 80, rows: 24, tr });
    t.renderer.update(
      event('telegram', 4, 3, undefined, [acct('acct-one', 'working', { counts: { ...ALL_STATUSES, yes: 1 }, done: 1, lastBatchMs: 700 })]),
    );
    t.draw();

    const labels = ['dashColApp', 'dashColAccount', 'dashColState', 'dashColDone', 'dashColStatus', 'dashColLast'] as const;
    const header = t.grid.text().find((line) => labels.every((key) => line.includes(tr(key))));
    const row = t.grid.text().find((line) => line.includes('acct-one'));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    const starts = labels.map((key) => header!.indexOf(tr(key)));
    expect(row!.indexOf('telegram')).toBe(starts[0]);
    expect(row!.indexOf('acct-one')).toBe(starts[1]);
    expect(row![starts[2]!]).not.toBe(' ');
    expect(row!.indexOf('1/4')).toBe(starts[3]);
    expect(row!.indexOf(tr('dashStatusCounts', { yes: 1, notFound: 0, unknown: 0 }))).toBe(starts[4]);
    expect(row!.indexOf('0.7s')).toBe(starts[5]);
    t.renderer.finish();
  });

  it('redraws at most once a second: many batch reports between ticks make one frame', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 10, 10, undefined, [acct('z', 'working')]));
    expect(t.writes).toHaveLength(1); // the first frame is drawn at once
    for (let left = 9; left >= 5; left--) t.renderer.update(event('zalo', 10, left, undefined, [acct('z', 'working')]));
    expect(t.writes).toHaveLength(1); // recorded only, nothing redrawn yet
    t.draw();
    expect(t.writes).toHaveLength(3); // erase + one frame for all five reports
    t.advance(1000);
    expect(t.writes).toHaveLength(5); // the timer keeps redrawing once a second
    t.renderer.finish();
  });

  it('animates the cooldown countdown on the timer', () => {
    const t = setup({ mode: 'bar' });
    const resume = t.now() + 90 * 60_000;
    t.renderer.update(event('zalo', 10, 5, undefined, [acct('z', 'cooldown', { waitingUntil: resume })]));
    expect(t.screen()).toContain('in 1 h 30 min');
    t.advance(60_000);
    expect(t.screen()).toContain('in 1 h 29 min');
    t.renderer.finish();
  });

  it('collapses to one row per app on a short window and to totals on a tiny one', () => {
    const accounts = ['a1', 'a2', 'a3'].map((name) => acct(name, 'working'));
    const fill = (renderer: ProgressRenderer) => {
      renderer.update(event('telegram', 60, 60, undefined, accounts));
      renderer.update(event('zalo', 60, 60, undefined, [acct('z1', 'working')]));
    };

    const short = setup({ mode: 'bar', columns: 80, rows: 14 });
    fill(short.renderer);
    short.draw();
    const appView = short.screen();
    expect(appView).toContain('telegram');
    expect(appView).toContain('zalo');
    expect(appView).not.toContain('a1');
    expect(appView).toContain('of 120 checks');
    short.renderer.finish();

    const tiny = setup({ mode: 'bar', columns: 80, rows: 10 });
    fill(tiny.renderer);
    tiny.draw();
    const totalsView = tiny.screen();
    expect(totalsView).toContain('of 120 checks');
    expect(totalsView).toContain('yes 0');
    expect(totalsView).not.toContain('ACCOUNT');
    tiny.renderer.finish();
  });

  it('drops the RESULTS and LAST columns below 60 columns and never draws past the window edge', () => {
    for (const columns of [80, 59, 40, 24]) {
      const t = setup({ mode: 'bar', columns, rows: 30 });
      const accounts = [acct('a', 'working', { counts: { ...ALL_STATUSES, yes: 3 }, lastBatchMs: 900, done: 3 })];
      t.renderer.update(event('telegram', 100, 90, { until: t.now() + 3_600_000, kind: 'cooldown' }, accounts));
      t.draw();
      const text = t.screen();
      if (columns >= 60) {
        expect(text).toContain('RESULTS');
        expect(text).toContain('LAST');
      } else {
        expect(text).not.toContain('RESULTS');
        expect(text).not.toContain('LAST');
      }
      for (const line of t.writes.join('').split('\n')) {
        expect(displayWidth(stripAnsi(line)), `@${columns}`).toBeLessThanOrEqual(columns - 1);
      }
      t.renderer.finish();
    }
  });

  it('shows an ETA once the pace is measurable, and the rate over the last minute', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 100, 100, undefined, [acct('z', 'working')]));
    t.advance(1000);
    t.renderer.update(event('zalo', 100, 90, undefined, [acct('z', 'working')]));
    t.draw();
    expect(t.screen()).not.toContain('left · finish');
    t.advance(9000);
    t.renderer.update(event('zalo', 100, 50, undefined, [acct('z', 'working')]));
    t.draw();
    // 50 checks in ~10 s: about 10 s left for the other 50.
    expect(t.screen()).toContain('about 10 s left');
    expect(t.screen()).toMatch(/\d+\/min/);
    t.renderer.finish();
  });

  it('wrapLog erases the frame, writes the message, then draws the frame again', () => {
    const t = setup({ mode: 'bar' });
    const logged: string[] = [];
    const say = t.renderer.wrapLog((message) => {
      logged.push(message);
      t.writes.push(`LOG:${message}\n`);
      t.grid.feed(`LOG:${message}\n`);
    });
    t.renderer.update(event('zalo', 10, 5, undefined, [acct('z', 'working')]));
    const before = t.writes.length;
    say('zalo: 5 checked, 5 left');
    const tail = t.writes.slice(before);
    expect(stripAnsi(tail[0] ?? '')).toBe('\r');
    expect(tail[0]).toMatch(/^\[\d+A/); // cursor up over the drawn frame
    expect(tail[0]).toContain('[J'); // erase below
    expect(tail[1]).toBe('LOG:zalo: 5 checked, 5 left\n');
    expect(stripAnsi(tail[2] ?? '')).toContain('of 10 checks');
    expect(t.screen()).toContain('zalo: 5 checked, 5 left');
    expect(logged).toEqual(['zalo: 5 checked, 5 left']);
    t.renderer.finish();
  });

  it('finish() draws the last state, removes the frame and ignores later updates', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 10, 5, undefined, [acct('z', 'working')]));
    t.draw();
    t.renderer.finish();
    expect(t.writes.at(-1)).toMatch(/^\[\d+A/); // the erase after the final draw
    expect(t.screen().trim()).toBe('');
    const count = t.writes.length;
    t.renderer.update(event('zalo', 10, 0));
    t.advance(5000);
    expect(t.writes.length).toBe(count);
  });

  it('draws nothing while there is nothing to check', () => {
    const t = setup({ mode: 'bar' });
    t.renderer.update(event('zalo', 0, 0));
    t.advance(3000);
    t.renderer.finish();
    expect(t.writes).toEqual([]);
  });
});

describe('ProgressRenderer as timestamped plain lines', () => {
  it('writes HH:MM-stamped lines without escapes; state changes print at once, progress at most every 10 s', () => {
    const t = setup({ mode: 'plain', rich: false });
    t.renderer.update(event('telegram', 40, 40));
    expect(t.lines).toEqual([expect.stringMatching(/^\d\d:\d\d progress 0% 0\/40$/)]);
    t.advance(3000);
    t.renderer.update(event('telegram', 40, 30));
    expect(t.lines).toHaveLength(1); // inside the 10 s window: throttled
    t.renderer.update(event('telegram', 40, 30, { until: t.now() + 60_000, kind: 'cooldown' }));
    expect(t.lines).toHaveLength(2); // a state change always prints
    expect(t.lines[1]).toMatch(/^\d\d:\d\d progress 25% 10\/40 \| ETA \d+ s \| resting until \d\d:\d\d$/);
    t.renderer.update(event('telegram', 40, 30));
    expect(t.lines).toHaveLength(3); // back to work is a state change too
    t.advance(10_000);
    t.renderer.update(event('telegram', 40, 0));
    expect(t.lines.at(-1)).toMatch(/progress 100% 40\/40/);
    for (const line of t.lines) {
      expect(line).not.toContain(ESC);
      expect(line).not.toContain('\r');
      expect(line).not.toContain('\n');
    }
    expect(t.writes).toEqual([]);
    t.renderer.finish();
  });

  it('finish() writes the last state when the run stops early, and nothing when nothing was reported', () => {
    const early = setup({ mode: 'plain', rich: false });
    early.renderer.update(event('zalo', 10, 10));
    early.advance(1000);
    early.renderer.update(event('zalo', 10, 8));
    early.renderer.finish();
    expect(early.lines.at(-1)).toMatch(/progress 20% 2\/10$/);

    const silent = setup({ mode: 'plain', rich: false });
    silent.renderer.finish();
    expect(silent.lines).toEqual([]);
  });

  it('wrapLog is the log itself: nothing is added or reordered', () => {
    const t = setup({ mode: 'plain', rich: false });
    const log = (message: string): void => void message;
    expect(t.renderer.wrapLog(log)).toBe(log);
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
