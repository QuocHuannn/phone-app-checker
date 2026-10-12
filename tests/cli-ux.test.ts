import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram, type CliDeps } from '../src/cli.ts';
import { AccountBanned, type Adapter, type App, type CheckStatus } from '../src/types.ts';
import { stripAnsi } from '../src/ui.ts';

const NOW = Date.UTC(2026, 9, 8, 5, 0, 0);
const ESC = '\u001b';
const RICH_ENV = { TERM: 'xterm-256color' };
const CSV = ['name,phone', 'An,0901234567', 'Binh,+65 9123 4567', 'Chi,abc', ''].join('\n');

let dir: string;
let csv: string;
let out: string;
let config: string;
let logs: string[];
let printed: string[];
let screen: string[];
let reports: { path: string; inconclusive: number }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checker-ux-'));
  config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      defaultRegion: 'VN',
      dataDir: join(dir, 'data'),
      apps: {
        telegram: { enabled: true, batchSize: 1, minIntervalMs: 0, jitterMs: 0 },
        whatsapp: { enabled: false },
        zalo: { enabled: true, batchSize: 1, minIntervalMs: 0, jitterMs: 0 },
      },
    }),
  );
  csv = join(dir, 'customers.csv');
  out = join(dir, 'report.csv');
  writeFileSync(csv, CSV);
  mkdirSync(join(dir, 'data', 'sessions', 'telegram', 'a'), { recursive: true });
  mkdirSync(join(dir, 'data', 'sessions', 'zalo', 'z'), { recursive: true });
  logs = [];
  printed = [];
  screen = [];
  reports = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adapter(app: App, banned = false): Adapter {
  return {
    app,
    async login() {},
    async open() {
      return {
        async check(batch) {
          if (banned) throw new AccountBanned('logged out');
          return new Map<string, CheckStatus>(batch.map((n) => [n.e164, n.country === 'VN' ? 'yes' : 'not_found']));
        },
        async close() {},
      };
    },
  };
}

const display = (columns = 100, isTTY = true) => ({ isTTY, columns, rows: 30, write: (text: string) => void screen.push(text) });

async function run(args: string[], deps: Partial<CliDeps> = {}, banned = false): Promise<void> {
  const program = createProgram({
    loadAdapter: async (app) => adapter(app, banned && app === 'zalo'),
    now: () => NOW,
    sleep: async () => {},
    random: () => 0,
    lifecycleDir: join(dir, 'lifecycle'),
    log: (message) => logs.push(message),
    print: (text) => printed.push(text),
    exit: () => {},
    ...deps,
  });
  await program.parseAsync(['--config', config, ...args], { from: 'user' });
}

describe('check output when it is not a terminal (compatibility)', () => {
  it('is plain output as before: no ANSI, no progress lines, no box, aligned summary text', async () => {
    await run(['check', csv, '--out', out]);
    const everything = [...logs, ...printed].join('\n');
    expect(everything).not.toContain(ESC);
    expect(logs.some((line) => line.startsWith('progress '))).toBe(false);
    expect(logs.some((line) => line.includes('Report saved to'))).toBe(false);
    expect(logs).toContain(`Report written to ${out}`);
    expect(printed.join('\n')).toContain('app           yes  not_found  unknown  skipped  invalid');
    expect(screen).toEqual([]);
  });

  it('a non-terminal display (stderr piped) behaves the same even with a good TERM', async () => {
    await run(['check', csv, '--out', out], { display: display(100, false), env: RICH_ENV });
    expect(screen).toEqual([]);
    expect([...logs, ...printed].join('\n')).not.toContain(ESC);
  });

  it('NO_COLOR and TERM=dumb on a terminal: no ANSI at all either', async () => {
    for (const env of [{ ...RICH_ENV, NO_COLOR: '1' }, { TERM: 'dumb' }, {}]) {
      logs.length = 0;
      printed.length = 0;
      await run(['check', csv, '--out', out, '--force'], { display: display(), printDisplay: display(), env });
      expect(screen).toEqual([]);
      expect([...logs, ...printed].join('\n')).not.toContain(ESC);
      expect(logs.some((line) => line.includes('Report saved to'))).toBe(false);
    }
  });
});

describe('check --progress lines', () => {
  it('writes plain progress lines through the log, never an escape sequence', async () => {
    await run(['check', csv, '--out', out, '--progress', 'lines']);
    const lines = logs.filter((line) => line.startsWith('progress '));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toMatch(/^progress 100% 3\/3 \| telegram 2\/2, zalo 1\/1$|^progress 100% 3\/3 \| zalo 1\/1, telegram 2\/2$|^progress 100% 3\/3 \| telegram 2\/2, zalo 1\/1$/);
    for (const line of lines) expect(line).not.toMatch(/[\u001b\r]/);
    // The existing log lines are all still there.
    expect(logs.some((line) => /telegram: a: \d checked, \d left/.test(line))).toBe(true);
    // The numbers themselves never reach the screen.
    expect(logs.join('\n')).not.toContain('+84901234567');
  });

  it('--progress off adds nothing, whatever the terminal', async () => {
    await run(['check', csv, '--out', out, '--progress', 'off'], { display: display(), env: RICH_ENV });
    expect(screen).toEqual([]);
    expect(logs.some((line) => line.startsWith('progress '))).toBe(false);
  });
});

describe('check on a rich terminal', () => {
  it('draws the run dashboard on the display and erases the frame before the summary', async () => {
    await run(['check', csv, '--out', out], { display: display(100), printDisplay: display(100), env: RICH_ENV });
    const drawn = screen.join('');
    // Multi-line framed dashboard: header, per-account rows, totals bar, counts and the run log path.
    const text = stripAnsi(drawn);
    expect(text).toContain('Checking customers.csv');
    for (const label of ['APP', 'ACCOUNT', 'STATE', 'DONE']) expect(text).toContain(label);
    expect(text).toMatch(/telegram\s+a\s+.*0\/2/);
    expect(text).toContain('3 of 3 checks');
    expect(text).toContain('yes 2 · not_found 1 · unknown 0');
    expect(text).toMatch(/Log: .*check-.*\.log/);
    // The whole frame is taken down at the end: cursor up over every row, then erase below.
    expect(drawn).toMatch(/\[\d+A\r\[J/);
    // The dashboard lives on the display stream only; the run's own log lines stay in the log.
    expect(logs.join('\n')).not.toContain('ACCOUNT');
    expect(logs.some((line) => /telegram: a: \d checked, \d left/.test(line))).toBe(false);
  });

  it('colours the summary table (yes green, not_found yellow, zero counts dim) and keeps the columns aligned', async () => {
    await run(['check', csv, '--out', out], { display: display(), printDisplay: display(), env: RICH_ENV });
    const text = printed.join('\n');
    expect(text).toContain(`${ESC}[32m`);
    expect(text).toContain(`${ESC}[33m`);
    expect(text).toContain(`${ESC}[2m`);
    expect(text).toContain(`${ESC}[31m`);
    // Same layout as the plain table once the colours are removed.
    const plain = stripAnsi(text).split('\n');
    expect(plain).toContain('app           yes  not_found  unknown  skipped  invalid');
    expect(plain.find((line) => line.startsWith('telegram'))).toBe('telegram  1 (33%)    1 (33%)   0 (0%)   0 (0%)  1 (33%)');
  });

  it('closes with the "Report saved to" box, translated, with the next steps', async () => {
    await run(['check', csv, '--out', out], {
      display: display(110),
      printDisplay: display(),
      env: { ...RICH_ENV, PHONE_APP_CHECKER_LANG: 'vi' },
    });
    const box = stripAnsi(logs.slice(logs.findIndex((line) => stripAnsi(line).startsWith('╭─'))).join('\n'));
    expect(box).toMatch(/^╭─ Đã lưu báo cáo vào /);
    expect(box).toContain('Excel hoặc Numbers');
    expect(box).toContain('open -R');
    expect(reports).toEqual([]);
  });

  it('an incomplete run shows the INCOMPLETE banner in bold red and the warning inside the box', async () => {
    await run(['check', csv, '--out', out, '--no-wait'], { display: display(110), printDisplay: display(), env: RICH_ENV, onReport: (info) => reports.push(info) }, true);
    const banner = logs.filter((line) => stripAnsi(line).startsWith('INCOMPLETE:'));
    expect(banner).toHaveLength(1);
    expect(banner[0]).toBe(`${ESC}[1m${ESC}[31m${stripAnsi(banner[0] ?? '')}${ESC}[39m${ESC}[22m`);
    const box = stripAnsi(logs.join('\n')).replace(/\n│ /g, ' ');
    expect(box).toContain('INCOMPLETE: the report is NOT final. Numbers without a fresh answer: 1.');
    expect(reports).toEqual([{ path: out, inconclusive: 1 }]);
  });

  it('truncates nothing and wraps nothing wider than a 50-column window', async () => {
    await run(['check', csv, '--out', out, '--no-wait'], { display: display(50), printDisplay: display(50), env: RICH_ENV }, true);
    const boxStart = logs.findIndex((line) => stripAnsi(line).startsWith('╭─'));
    for (const line of logs.slice(boxStart)) {
      for (const part of stripAnsi(line).split('\n')) expect([...part].length).toBeLessThanOrEqual(49);
    }
  });
});

describe('the --theme flag and the theme config key', () => {
  it('accepts every theme value and the run still completes with its summary and box', async () => {
    // Command output uses the semantic tones (ok/warn/error), not the accent — the accent itself is
    // exercised per-theme in ui.test.ts and reaches the banner once the menu's Ui is themed (phase 4).
    for (const theme of ['auto', 'dark', 'light', 'high-contrast']) {
      await run(['check', csv, '--out', out, '--force', '--theme', theme], { display: display(), printDisplay: display(), env: RICH_ENV });
      expect(logs.some((line) => stripAnsi(line).startsWith('╭─')), theme).toBe(true);
      expect(logs, theme).toContain(`Report written to ${out}`);
      logs.length = 0;
      printed.length = 0;
      screen.length = 0;
    }
  });

  it('accepts the theme config key and keeps COLORFGBG-driven runs working', async () => {
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), theme: 'light' }));
    await run(['check', csv, '--out', out], { display: display(), printDisplay: display(), env: { ...RICH_ENV, COLORFGBG: '0;15' } });
    expect(logs.some((line) => stripAnsi(line).startsWith('╭─'))).toBe(true);
    expect(logs).toContain(`Report written to ${out}`);
  });

  it('--plain wins over every theme: no ANSI anywhere', async () => {
    await run(['check', csv, '--out', out, '--theme', 'high-contrast', '--plain'], { display: display(), printDisplay: display(), env: RICH_ENV });
    expect([...logs, ...printed].join('\n')).not.toContain(ESC);
  });

  it('rejects an unknown theme the same way every bad option is rejected', async () => {
    const program = createProgram({ env: RICH_ENV, exit: () => {} });
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(['--config', config, '--theme', 'neon', 'check', csv, '--out', out], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
    expect(program.helpInformation()).toContain('--theme <mode>');
  });
});

describe('embedded (run from the menu) and the report command', () => {
  it('embedded: no closing box (the menu draws its own) but the report hook still fires', async () => {
    await run(['check', csv, '--out', out], { display: display(110), printDisplay: display(), env: RICH_ENV, embedded: true, onReport: (info) => reports.push(info) });
    expect(logs.some((line) => stripAnsi(line).startsWith('╭─'))).toBe(false);
    expect(reports).toEqual([{ path: out, inconclusive: 0 }]);
  });

  it('report: the same hook and box; an injected log stays plain', async () => {
    await run(['check', csv, '--out', out]);
    logs.length = 0;
    await run(['report', csv, '--out', join(dir, 'again.csv')], { onReport: (info) => reports.push(info) });
    expect(reports).toEqual([{ path: join(dir, 'again.csv'), inconclusive: 0 }]);
    expect(logs.join('\n')).not.toContain(ESC);
    expect(readFileSync(join(dir, 'again.csv'), 'utf8')).toBe(readFileSync(out, 'utf8'));
  });
});
