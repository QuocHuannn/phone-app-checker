import { APPS, type App } from './types.ts';
import { CURSOR, displayWidth, formatDuration, truncate, type DrawStream, type Ui } from './ui.ts';

/** One app's state in a `check` run, reported by the scheduler after every change. */
export interface ProgressEvent {
  app: App;
  /** Numbers this app has to check in this run. */
  needed: number;
  /** Numbers of this app still without an answer (never counts numbers someone else answered). */
  remaining: number;
  /** Set while the app waits instead of working: when it resumes and why (a short pacing delay, or a cooldown / daily cap). */
  waiting?: { until: number; kind: 'pacing' | 'cooldown' };
}

export type ProgressMode = 'bar' | 'lines';

export interface ProgressOptions {
  mode: ProgressMode;
  ui: Ui;
  /** Where the in-place bar is drawn (`bar` mode). */
  stream: DrawStream;
  /** Where plain progress lines go (`lines` mode); one call per line, no trailing newline. */
  line: (text: string) => void;
  now?: () => number;
  /** Plain lines are at most this far apart (default 10 s); the first and the last are always written. */
  lineIntervalMs?: number;
  /** Redraw period of the bar, which also animates the spinner and the countdown (default 150 ms). */
  tickMs?: number;
}

/** Narrowest and widest the bar itself is drawn. */
const BAR_MIN = 8;
const BAR_MAX = 28;
/** Seconds of work needed before an ETA is shown (an estimate from less is noise). */
const ETA_MIN_ELAPSED_MS = 2000;

interface Snapshot {
  total: number;
  done: number;
  perApp: { app: App; needed: number; done: number }[];
  waiting: { until: number; kind: 'pacing' | 'cooldown' } | undefined;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Progress of a `check` run. In `bar` mode (a rich terminal) one line is redrawn in place: spinner, bar, percentage,
 * processed/total, per-app counters, ETA and the current pacing / cooldown notice. In `lines` mode plain text lines are
 * written now and then (for logs and pipes). Log lines from the run go through `wrapLog` so they never collide with the bar.
 */
export class ProgressRenderer {
  private readonly options: ProgressOptions;
  private readonly now: () => number;
  private readonly apps = new Map<App, ProgressEvent>();
  private startedAt: number | undefined;
  private doneAtStart = 0;
  private lastLineAt = -Infinity;
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private barVisible = false;
  private finished = false;
  private lineWritten = false;

  constructor(options: ProgressOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an app's new state. In `bar` mode the line is redrawn on the tick timer only (updating
   * per batch used to draw once per call, which dominates once several accounts report at once);
   * `lines` mode keeps its own throttle. `wrapLog` and `finish` still draw immediately.
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
    if (this.options.mode === 'bar') {
      if (this.timer === undefined) {
        this.timer = setInterval(() => this.draw(), this.options.tickMs ?? 150);
        this.timer.unref();
      }
      return;
    }
    const at = this.now();
    if (first || snapshot.done >= snapshot.total || at - this.lastLineAt >= (this.options.lineIntervalMs ?? 10_000)) {
      this.lastLineAt = at;
      this.lineWritten = true;
      this.options.line(this.text(snapshot, undefined));
    }
  }

  /** `log` that keeps the bar intact: the bar is erased, the message written, the bar drawn again. Plain mode: `log` itself. */
  wrapLog(log: (message: string) => void): (message: string) => void {
    if (this.options.mode !== 'bar') return log;
    return (message) => {
      this.erase();
      log(message);
      this.draw();
    };
  }

  /** Stop animating, draw the final state once (a run can finish between ticks), and remove the bar. In `lines` mode, write a last line when something was reported. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.options.mode === 'bar') this.draw();
    this.erase();
    if (this.options.mode === 'lines' && this.lineWritten) {
      const snapshot = this.snapshot();
      if (snapshot.done < snapshot.total) this.options.line(this.text(snapshot, undefined));
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

  /** The progress text: a plain `progress ...` line when `barWidth` is undefined, else the bar line (a bar of that many cells; 0 = no bar, used to measure). */
  private text(snapshot: Snapshot, barWidth: number | undefined): string {
    const { ui } = this.options;
    const { total, done, perApp, waiting } = snapshot;
    const percent = total === 0 ? 100 : Math.floor((done * 100) / total);
    const parts: string[] = [];
    if (barWidth !== undefined && barWidth > 0) {
      const filled = Math.round((barWidth * done) / Math.max(1, total));
      const glyphs = ui.rich ? ['█', '░'] : ['#', '-'];
      parts.push(`${glyphs[0]?.repeat(filled)}${glyphs[1]?.repeat(barWidth - filled)}`);
    }
    parts.push(`${percent}% ${done}/${total}`);
    const detail = perApp.length > 1 ? perApp.map((entry) => `${entry.app} ${entry.done}/${entry.needed}`).join(barWidth === undefined ? ', ' : ' · ') : '';
    const eta = this.eta(done, total);
    const notice = waiting === undefined ? '' : this.notice(waiting);
    const tail = [detail, eta === undefined ? '' : `ETA ${formatDuration(eta)}`, notice].filter((part) => part !== '');
    const spinner = ui.icons.spinner[this.frame % ui.icons.spinner.length] as string;
    const head = barWidth === undefined ? 'progress ' : `${spinner} `;
    return `${head}${[...parts, ...tail].join(barWidth === undefined ? ' | ' : '  ')}`;
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
    if (waiting.kind === 'pacing') return left >= 1000 ? `pacing ${formatDuration(left)}` : '';
    const at = new Date(waiting.until);
    return `resting until ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  }

  private draw(): void {
    const { ui, stream } = this.options;
    const snapshot = this.snapshot();
    if (snapshot.total === 0) return;
    const columns = ui.columns - 1;
    // Give the bar what the text leaves free: measure the line without it first.
    const bare = displayWidth(this.text(snapshot, 0));
    const barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX, columns - bare - 3));
    const line = truncate(this.text(snapshot, barWidth), columns, ui.icons.ellipsis);
    this.frame += 1;
    this.barVisible = true;
    stream.write(`${CURSOR.clearLine}${ui.cyan(line)}`);
  }

  private erase(): void {
    if (!this.barVisible) return;
    this.barVisible = false;
    this.options.stream.write(CURSOR.clearLine);
  }
}
