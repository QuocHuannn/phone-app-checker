import { translator, type Translator } from './i18n/index.ts';
import { APPS, type App, type CheckStatus } from './types.ts';
import {
  CURSOR,
  displayWidth,
  formatDuration,
  formatLocalTime,
  truncate,
  truncatePath,
  type DrawStream,
  type Ui,
} from './ui.ts';

/** One account's state inside an app's `check` run, for the per-account dashboard rows. */
export interface AccountProgress {
  account: string;
  /** working: a batch is in flight; waiting: pacing/idle; cooldown: resting after a throttle or cap; disabled: banned/dropped; done: nothing left for it. */
  state: 'working' | 'waiting' | 'cooldown' | 'disabled' | 'done';
  /** When the account is usable again (waiting/cooldown only). */
  waitingUntil?: number;
  /** Numbers this account answered this run, per status. */
  counts: Record<CheckStatus, number>;
  /** Numbers this account answered this run (sum of `counts`). */
  done: number;
  /** Wall time of its last completed batch, for judging whether parallelism pays. */
  lastBatchMs?: number;
}

/** One app's state in a `check` run, reported by the scheduler after every change. */
export interface ProgressEvent {
  app: App;
  /** Numbers this app has to check in this run. */
  needed: number;
  /** Numbers of this app still without an answer (never counts numbers someone else answered). */
  remaining: number;
  /** Set while the app waits instead of working: when it resumes and why (a short pacing delay, or a cooldown / daily cap). */
  waiting?: { until: number; kind: 'pacing' | 'cooldown' };
  /** Per-account rows, in account order; rendered by the dashboard. */
  accounts?: AccountProgress[];
}

export type ProgressMode = 'bar' | 'lines' | 'plain';

export interface ProgressOptions {
  /**
   * `bar`: the live dashboard on a rich terminal. `plain`: the same facts as periodic timestamped
   * lines, no cursor movement (TERM=dumb, NO_COLOR, --plain, PHONE_APP_CHECKER_PLAIN).
   * `lines`: the classic `progress ...` lines for logs and pipes.
   */
  mode: ProgressMode;
  ui: Ui;
  /** Where the dashboard is drawn (`bar` mode). */
  stream: DrawStream;
  /** Where plain progress lines go (`lines` and `plain` modes); one call per line, no trailing newline. */
  line: (text: string) => void;
  now?: () => number;
  /** Message lookup (default: English). */
  tr?: Translator;
  /** Title of the dashboard frame (the run's CSV name); hidden when the window is short. */
  title?: string;
  /** Run log file shown as `Log: <path>` in the dashboard. */
  logPath?: string;
  /** Plain lines are at most this far apart (default 10 s); the first and the last are always written. */
  lineIntervalMs?: number;
  /** Dashboard redraw period, which also animates the cooldown countdown (default 1000 ms: at most 1 Hz). */
  tickMs?: number;
}

/** Narrowest and widest the bar itself is drawn. */
const BAR_MIN = 8;
const BAR_MAX = 28;
/** Seconds of work needed before an ETA is shown (an estimate from less is noise). */
const ETA_MIN_ELAPSED_MS = 2000;
/** How far back the numbers/minute rate looks. */
const RATE_WINDOW_MS = 60_000;

interface Snapshot {
  total: number;
  done: number;
  perApp: { app: App; needed: number; done: number }[];
  waiting: { until: number; kind: 'pacing' | 'cooldown' } | undefined;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Pad on the right with spaces to `width` display cells (no-op when already that wide). */
const padW = (text: string, width: number): string => {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : text;
};

/**
 * Progress of a `check` run.
 *
 * `bar` mode draws a multi-line dashboard on a rich terminal and redraws it at most once a second:
 * a title rule, elapsed/rate/ETA, one row per account (state word + icon, done/target, per-status
 * counts, last batch latency, cooldown countdown in local time) or per app when the window is short,
 * a totals bar, running status counts and the stop hint. There is no spinner; the clock and the
 * countdown carry the activity. `wrapLog` erases the frame, prints and redraws it so log lines never
 * collide with it.
 *
 * `plain` mode prints the same facts as periodic timestamped lines (at most every `lineIntervalMs`,
 * plus state changes) and never moves the cursor. `lines` mode is the classic `progress ...` format
 * for pipes and scripts.
 */
export class ProgressRenderer {
  private readonly options: ProgressOptions;
  private readonly now: () => number;
  private readonly tr: Translator;
  private readonly apps = new Map<App, ProgressEvent>();
  private startedAt: number | undefined;
  private doneAtStart = 0;
  private lastLineAt = -Infinity;
  /** Last waiting kind per app, for the plain tier's state-change lines. */
  private lastWaiting = new Map<App, 'pacing' | 'cooldown' | undefined>();
  private timer: NodeJS.Timeout | undefined;
  /** Dashboard rows currently on screen. */
  private drawn = 0;
  private finished = false;
  private lineWritten = false;
  /** (done, when) samples over the last minute, for the numbers/min rate. */
  private samples: { at: number; done: number }[] = [];

  constructor(options: ProgressOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.tr = options.tr ?? translator();
  }

  /**
   * Record an app's new state. In `bar` mode the frame is redrawn on the 1 Hz timer only (drawing
   * per batch dominates once several accounts report at once); `wrapLog` and `finish` still draw
   * immediately. `lines`/`plain` keep their own throttles; `plain` also prints state changes at once.
   */
  update(event: ProgressEvent): void {
    if (this.finished) return;
    const first = this.startedAt === undefined;
    this.apps.set(event.app, event);
    const snapshot = this.snapshot();
    if (first) {
      this.startedAt = this.now();
      this.doneAtStart = snapshot.done;
    }
    if (snapshot.total === 0) return;
    this.pushSample(snapshot.done);
    if (this.options.mode === 'bar') {
      if (this.timer === undefined) {
        // First frame at once so the user sees the dashboard before the first second is over.
        this.draw();
        this.timer = setInterval(() => this.draw(), this.options.tickMs ?? 1000);
        this.timer.unref();
      }
      return;
    }
    const at = this.now();
    const waitingChanged = this.options.mode === 'plain' && this.waitingChanged();
    if (
      first ||
      waitingChanged ||
      snapshot.done >= snapshot.total ||
      at - this.lastLineAt >= (this.options.lineIntervalMs ?? 10_000)
    ) {
      this.lastLineAt = at;
      this.lineWritten = true;
      this.options.line(this.lineText(snapshot));
    }
  }

  /** `log` that keeps the dashboard intact: the frame is erased, the message written, the frame drawn again. Other modes: `log` itself. */
  wrapLog(log: (message: string) => void): (message: string) => void {
    if (this.options.mode !== 'bar') return log;
    return (message) => {
      this.erase();
      log(message);
      this.draw();
    };
  }

  /** Stop the timer, draw the final state once, and remove the frame. In `lines`/`plain`, write a last line when something was reported. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.options.mode === 'bar') {
      this.draw();
      this.erase();
      return;
    }
    if (this.lineWritten) {
      const snapshot = this.snapshot();
      if (snapshot.done < snapshot.total) this.options.line(this.lineText(snapshot));
    }
  }

  private snapshot(): Snapshot {
    let total = 0;
    let done = 0;
    let waiting: Snapshot['waiting'];
    const perApp: Snapshot['perApp'] = [];
    for (const app of APPS) {
      const event = this.apps.get(app);
      if (event === undefined || event.needed === 0) continue;
      const finished = Math.max(0, Math.min(event.needed, event.needed - event.remaining));
      total += event.needed;
      done += finished;
      perApp.push({ app, needed: event.needed, done: finished });
      if (event.waiting !== undefined && (waiting === undefined || event.waiting.until < waiting.until)) waiting = event.waiting;
    }
    return { total, done, perApp, waiting };
  }

  private pushSample(done: number): void {
    const at = this.now();
    const last = this.samples.at(-1);
    if (last !== undefined && last.done === done) return;
    this.samples.push({ at, done });
    const cutoff = at - RATE_WINDOW_MS;
    while (this.samples.length > 1 && (this.samples[0]?.at ?? 0) < cutoff) this.samples.shift();
  }

  /** Numbers checked per minute over the last RATE_WINDOW_MS (0 before any answer). */
  private ratePerMinute(): number {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (first === undefined || last === undefined || last.at <= first.at) return 0;
    return Math.round(((last.done - first.done) / (last.at - first.at)) * 60_000);
  }

  /** True when some app's waiting state appeared, disappeared or changed kind since the last line. */
  private waitingChanged(): boolean {
    let changed = false;
    for (const [app, event] of this.apps) {
      const kind = event.waiting?.kind;
      if (this.lastWaiting.get(app) !== kind) changed = true;
      this.lastWaiting.set(app, kind);
    }
    return changed;
  }

  private eta(done: number, total: number): number | undefined {
    if (this.startedAt === undefined || done >= total) return undefined;
    const elapsed = this.now() - this.startedAt;
    const progressed = done - this.doneAtStart;
    if (progressed <= 0 || elapsed < ETA_MIN_ELAPSED_MS) return undefined;
    return (elapsed / progressed) * (total - done);
  }

  private notice(waiting: NonNullable<Snapshot['waiting']>): string {
    const left = waiting.until - this.now();
    if (waiting.kind === 'pacing') return left >= 1000 ? this.tr('progressPacing', { time: formatDuration(left) }) : '';
    return this.tr('progressRestingUntil', { clock: formatLocalTime(waiting.until, this.now()) });
  }

  /**
   * Join row cells into one screen line, each padded to its shared column width (the widths are
   * computed per frame from the widest of the header label and every cell, so the header sits
   * exactly above its values; `displayWidth` keeps CJK state words and translated labels right).
   * Columns after the fourth are dropped one by one as the window narrows; when the first four
   * still overflow, the line is truncated. Empty trailing cells leave no trailing spaces.
   */
  private tableRow(cells: string[], cols: number[], width: number): string {
    const ellipsis = this.options.ui.icons.ellipsis;
    let line = '';
    for (let i = 0; i < cells.length; i++) {
      const value = cells[i]!;
      if (i >= 4 && value === '') continue;
      const cell = i === cells.length - 1 ? value : padW(value, cols[i]!);
      const next = line === '' ? cell : `${line}  ${cell}`;
      if (displayWidth(next) > width) {
        if (i >= 4) break;
        return truncate(next, width, ellipsis);
      }
      line = next;
    }
    return line.replace(/ +$/, '');
  }
  private lineText(snapshot: Snapshot): string {
    const { total, done, perApp, waiting } = snapshot;
    const percent = total === 0 ? 100 : Math.floor((done * 100) / total);
    const parts = [this.tr('progressPercent', { percent, done, total })];
    const detail = perApp.length > 1 ? perApp.map((entry) => `${entry.app} ${entry.done}/${entry.needed}`).join(', ') : '';
    const eta = this.eta(done, total);
    const notice = waiting === undefined ? '' : this.notice(waiting);
    const tail = [detail, eta === undefined ? '' : this.tr('progressEta', { time: formatDuration(eta) }), notice].filter((part) => part !== '');
    const text = [...parts, ...tail].join(' | ');
    if (this.options.mode !== 'plain') return text;
    const at = new Date(this.now());
    return `${pad2(at.getHours())}:${pad2(at.getMinutes())} ${text}`;
  }

  // ---- dashboard frame ---------------------------------------------------

  /** The state cell of one account row: icon + word; a countdown in local time while it rests. */
  private stateCell(row: AccountProgress): string {
    const { icons } = this.options.ui;
    const t = this.now();
    const until = row.waitingUntil;
    if ((row.state === 'cooldown' || row.state === 'waiting') && until !== undefined) {
      const left = Math.max(0, until - t);
      return `${icons.waiting} ${this.tr('dashResting', { clock: formatLocalTime(until, t), left: formatDuration(left) })}`;
    }
    switch (row.state) {
      case 'working':
        return `${icons.working} ${this.tr('dashWorking')}`;
      case 'waiting':
        return `${icons.waiting} ${this.tr('dashWaiting')}`;
      case 'cooldown':
        return `${icons.waiting} ${this.tr('dashResting', { clock: formatLocalTime(row.waitingUntil ?? t, t), left: formatDuration(Math.max(0, (row.waitingUntil ?? t) - t)) })}`;
      case 'disabled':
        return `${icons.fail} ${this.tr('dashDisabled')}`;
      case 'done':
        return `${icons.ready} ${this.tr('dashDone')}`;
    }
  }

  /** `12y 3nf 0u` for one account's per-status counts. */
  private statusCell(row: AccountProgress): string {
    return this.tr('dashStatusCounts', { yes: row.counts.yes, notFound: row.counts.not_found, unknown: row.counts.unknown });
  }

  /**
   * The dashboard frame as an array of screen rows (no leading bar characters; the caller adds `│ `).
   * `width` is the inner width available for content; `level` says how much fits:
   * 'full' = header + per-account rows, 'apps' = one row per app, 'totals' = header lines only.
   */
  private frameLines(width: number, level: 'full' | 'apps' | 'totals', detailed: boolean): string[] {
    const { ui } = this.options;
    const t = this.now();
    const snapshot = this.snapshot();
    const lines: string[] = [];

    // Elapsed · rate · ETA.
    const elapsed = this.startedAt === undefined ? 0 : t - this.startedAt;
    const head = [this.tr('dashElapsed', { time: formatDuration(elapsed) }), this.tr('dashSpeed', { rate: this.ratePerMinute() })];
    const eta = this.eta(snapshot.done, snapshot.total);
    if (eta !== undefined) head.push(this.tr('dashEta', { left: formatDuration(eta), clock: formatLocalTime(t + eta, t) }));
    lines.push(truncate(head.join(' · '), width, ui.icons.ellipsis));

    if (level === 'totals') {
      lines.push('');
      lines.push(this.totalsLine(snapshot, width));
      lines.push(truncate(this.countsLine(), width, ui.icons.ellipsis));
      return lines;
    }

    lines.push('');
    const labels = [this.tr('dashColApp'), this.tr('dashColAccount'), this.tr('dashColState'), this.tr('dashColDone'), this.tr('dashColStatus'), this.tr('dashColLast')];
    const rows: string[][] = [];

    if (level === 'apps') {
      for (const entry of snapshot.perApp) {
        const event = this.apps.get(entry.app);
        const working = (event?.accounts ?? []).some((a) => a.state === 'working');
        const resting = (event?.accounts ?? []).filter((a) => a.state === 'cooldown' || (a.state === 'waiting' && a.waitingUntil !== undefined));
        const soonest = resting.reduce<number | undefined>((min, a) => (min === undefined || (a.waitingUntil ?? 0) < min ? a.waitingUntil : min), undefined);
        let state: string;
        if (working) state = `${ui.icons.working} ${this.tr('dashWorking')}`;
        else if (soonest !== undefined)
          state = `${ui.icons.waiting} ${this.tr('dashResting', {
            clock: formatLocalTime(soonest, t),
            left: formatDuration(Math.max(0, soonest - t)),
          })}`;
        else if (entry.done >= entry.needed) state = `${ui.icons.ready} ${this.tr('dashDone')}`;
        else state = `${ui.icons.waiting} ${this.tr('dashWaiting')}`;
        const status = detailed
          ? this.tr('dashStatusCounts', {
              yes: sumCounts(event, 'yes'),
              notFound: sumCounts(event, 'not_found'),
              unknown: sumCounts(event, 'unknown'),
            })
          : '';
        rows.push([entry.app, '', state, `${entry.done}/${entry.needed}`, status, '']);
      }
    } else {
      for (const entry of snapshot.perApp) {
        const event = this.apps.get(entry.app);
        const accounts = event?.accounts ?? [];
        if (accounts.length === 0) {
          rows.push([
            entry.app,
            '—',
            `${ui.icons.waiting} ${this.tr('dashWaiting')}`,
            `${entry.done}/${entry.needed}`,
            detailed ? this.tr('dashStatusCounts', { yes: 0, notFound: 0, unknown: 0 }) : '',
            '',
          ]);
          continue;
        }
        for (const account of accounts) {
          const state = this.stateCell(account);
          const status = detailed ? this.statusCell(account) : '';
          const last = account.lastBatchMs === undefined ? '' : `${(account.lastBatchMs / 1000).toFixed(1)}s`;
          rows.push([entry.app, account.account, state, `${account.done}/${entry.needed}`, status, last]);
        }
      }
    }

    // One width per column: the widest of the header label and every cell, so each label starts
    // exactly above its values. Header and rows are rendered with the same widths.
    const shown = detailed ? 6 : 4;
    const cols = labels.map((label, i) => Math.max(displayWidth(label), ...rows.map((cells) => displayWidth(cells[i]!))));
    lines.push(ui.dim(this.tableRow(labels.slice(0, shown), cols, width)));
    for (const cells of rows) lines.push(this.tableRow(cells.slice(0, shown), cols, width));

    lines.push('');
    lines.push(this.totalsLine(snapshot, width));
    lines.push(truncate(this.countsLine(), width, ui.icons.ellipsis));
    if (detailed || width >= 60) lines.push(truncate(this.tr('dashHintStop'), width, ui.icons.ellipsis));
    if (this.options.logPath !== undefined) lines.push(ui.dim(truncate(this.tr('dashDetailsFile', { path: truncatePath(this.options.logPath, Math.max(10, width - 5), ui.icons.ellipsis) }), width, ui.icons.ellipsis)));
    return lines;
  }

  /** `█████░░ 52% 63 of 120 checks (60 numbers x 2 apps)` sized to `width`. */
  private totalsLine(snapshot: Snapshot, width: number): string {
    const { ui } = this.options;
    const numbers = snapshot.perApp.reduce((max, entry) => Math.max(max, entry.needed), 0);
    const percent = snapshot.total === 0 ? 100 : Math.floor((snapshot.done * 100) / snapshot.total);
    const label = `${percent}%  ${this.tr('dashChecks', { done: snapshot.done, total: snapshot.total, numbers, apps: snapshot.perApp.length })}`;
    const barWidth = Math.max(0, Math.min(BAR_MAX, width - displayWidth(label) - 2));
    if (barWidth < BAR_MIN) return truncate(label, width, ui.icons.ellipsis);
    const filled = Math.round((barWidth * snapshot.done) / Math.max(1, snapshot.total));
    const glyphs = ui.rich ? ['█', '░'] : ['#', '-'];
    return truncate(`${glyphs[0]?.repeat(filled)}${glyphs[1]?.repeat(barWidth - filled)}  ${label}`, width, ui.icons.ellipsis);
  }

  /** Running `yes · not_found · unknown` totals across all account rows. */
  private countsLine(): string {
    let yes = 0;
    let notFound = 0;
    let unknown = 0;
    for (const event of this.apps.values()) {
      for (const account of event.accounts ?? []) {
        yes += account.counts.yes;
        notFound += account.counts.not_found;
        unknown += account.counts.unknown;
      }
    }
    return this.tr('dashCounts', { yes, notFound, unknown });
  }

  /**
   * Draw the whole dashboard frame. Rows are wrapped to `columns - 1` (the box's left bar takes two
   * more cells). The frame collapses to one row per app, then to totals only, when it would not fit
   * the window height; below 60 columns the RESULTS and LAST columns are dropped.
   */
  private draw(): void {
    const { ui, stream } = this.options;
    const snapshot = this.snapshot();
    if (snapshot.total === 0) return;
    const columns = Math.max(20, ui.columns - 1);
    const width = columns - 2; // "│ " + content
    const detailed = ui.columns >= 60;
    const budget = Math.max(4, ui.rows - 2); // leave one row free under the frame

    let level: 'full' | 'apps' | 'totals' = 'full';
    let lines = this.frameLines(width, level, detailed);
    // Top rule + bottom rule add two rows.
    while (lines.length + 2 > budget && level !== 'totals') {
      level = level === 'full' ? 'apps' : 'totals';
      lines = this.frameLines(width, level, detailed);
    }

    this.erase();
    const title = this.options.title ?? '';
    const top = title === '' ? `${ui.icons.topLeft}${ui.icons.rule.repeat(columns - 1)}` : `${ui.icons.topLeft}${ui.icons.rule} ${truncate(title, columns - 6, ui.icons.ellipsis)} ${ui.icons.rule.repeat(Math.max(1, columns - 5 - displayWidth(truncate(title, columns - 6, ui.icons.ellipsis))))}`;
    const frame = [ui.cyan(ui.bold(top)), ...lines.map((line) => `${ui.cyan(ui.icons.bar)} ${line}`), ui.cyan(`${ui.icons.bottomLeft}${ui.icons.rule.repeat(columns - 1)}`)];
    this.drawn = frame.length;
    stream.write(frame.join('\n') + '\n');
  }

  private erase(): void {
    if (this.drawn === 0) return;
    const rows = this.drawn;
    this.drawn = 0;
    this.options.stream.write(CURSOR.upAndClear(rows));
  }
}

/** Sum one status across an app's account rows (0 when the scheduler did not report accounts). */
function sumCounts(event: ProgressEvent | undefined, status: CheckStatus): number {
  let total = 0;
  for (const account of event?.accounts ?? []) total += account.counts[status];
  return total;
}
