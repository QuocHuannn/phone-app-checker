import { PromptCancelled, type PromptIo } from './prompt.ts';
import { CURSOR, truncate, type Ui } from './ui.ts';

/** A key press, decoded from the bytes a terminal sends in raw mode. */
export type Key =
  | { name: 'up' | 'down' | 'home' | 'end' | 'enter' | 'esc' | 'backspace' | 'ctrl-c' | 'ctrl-d' }
  | { name: 'char'; char: string };

/** Decode one chunk of raw-mode input into key presses (arrow keys arrive as `ESC [ A` / `ESC O A`; a lone ESC is the Esc key). */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  const chars = Array.from(chunk);
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    if (char === '\u001b') {
      const next = chars[i + 1];
      if (next !== '[' && next !== 'O') {
        keys.push({ name: 'esc' });
        continue;
      }
      // CSI / SS3 sequence: parameters, then one final byte in @..~.
      let j = i + 2;
      while (j < chars.length && !/[@-~]/.test(chars[j] as string)) j += 1;
      const final = chars[j];
      if (final === 'A') keys.push({ name: 'up' });
      else if (final === 'B') keys.push({ name: 'down' });
      else if (final === 'H') keys.push({ name: 'home' });
      else if (final === 'F') keys.push({ name: 'end' });
      i = j;
    } else if (char === '\r' || char === '\n') {
      keys.push({ name: 'enter' });
      if (char === '\r' && chars[i + 1] === '\n') i += 1;
    } else if (char === '\u0003') keys.push({ name: 'ctrl-c' });
    else if (char === '\u0004') keys.push({ name: 'ctrl-d' });
    else if (char === '\u007f' || char === '\b') keys.push({ name: 'backspace' });
    else if (char >= ' ') keys.push({ name: 'char', char });
  }
  return keys;
}

/** What the guard needs from `process`: events and exit. Tests pass an EventEmitter with an `exit` spy. */
export interface GuardProcess {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  exit(code?: number): unknown;
}

const GUARDED_SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const;

/**
 * Run `restore` when the process is about to die while the terminal is in a special mode: on SIGINT / SIGTERM / SIGHUP
 * (then exit with 128 + signal, which is what the default action would have reported) and on exit. Returns the disposer.
 */
export function guardTerminal(restore: () => void, proc: GuardProcess = process): () => void {
  const handlers = GUARDED_SIGNALS.map(([signal, code]) => {
    const handler = (): void => {
      restore();
      dispose();
      proc.exit(code);
    };
    return [signal, handler] as const;
  });
  const onExit = (): void => restore();
  for (const [signal, handler] of handlers) proc.on(signal, handler);
  proc.on('exit', onExit);
  function dispose(): void {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
    proc.off('exit', onExit);
  }
  return dispose;
}

export interface SelectItem<V> {
  value: V;
  /** Text of the row (the caller makes it terminal-safe). */
  label: string;
  /** Pressing this single key picks the row at once ("1", "0", "l"). Compared case-insensitively. */
  key?: string;
}

export interface SelectOptions<V> {
  title?: string;
  items: readonly SelectItem<V>[];
  /** The hint footer, e.g. "↑↓ move · Enter select · q quit". */
  hint: string;
  /** Row highlighted first (default 0). */
  initial?: number;
}

export type SelectResult<V> = { picked: true; value: V; label: string } | { picked: false };

/** True when arrow-key selection can run: a rich output and an input that supports raw mode. */
export function canSelect(io: PromptIo, ui: Ui): boolean {
  return ui.rich && io.input.isTTY === true && typeof io.input.setRawMode === 'function';
}

/**
 * Show a list and let the user pick with ↑/↓ + Enter, a row's own key, or q / Esc (cancel: `{ picked: false }`).
 * Redraws in place, hides the cursor while it is open, and always restores the terminal (raw mode off, cursor
 * back) on pick, cancel, Ctrl+C / Ctrl+D (rejects with `PromptCancelled`), stream errors, thrown errors,
 * SIGINT / SIGTERM / SIGHUP and process exit. Call only when `canSelect` is true.
 */
export function selectMenu<V>(io: PromptIo, ui: Ui, options: SelectOptions<V>, proc: GuardProcess = process): Promise<SelectResult<V>> {
  const { input, output } = io;
  const { items } = options;
  const { promise, resolve, reject } = Promise.withResolvers<SelectResult<V>>();
  const setRawMode = (input.setRawMode as (mode: boolean) => unknown).bind(input);
  let index = Math.min(Math.max(options.initial ?? 0, 0), Math.max(0, items.length - 1));
  let drawnRows = 0;
  let open = true;

  const lines = (): string[] => {
    const width = ui.columns - 1;
    const rows: string[] = [];
    if (options.title !== undefined) rows.push(ui.bold(truncate(options.title, width, ui.icons.ellipsis)));
    items.forEach((item, position) => {
      const key = item.key === undefined ? '  ' : `${item.key} `;
      const text = truncate(`${position === index ? ui.icons.pointer : ' '} ${key}${item.label}`, width - 1, ui.icons.ellipsis);
      rows.push(position === index ? ui.cyan(ui.bold(text)) : text);
    });
    rows.push(ui.dim(truncate(options.hint, width, ui.icons.ellipsis)));
    return rows;
  };

  const draw = (): void => {
    const rows = lines();
    output.write(`${CURSOR.upAndClear(drawnRows)}${rows.join('\n')}\n`);
    drawnRows = rows.length;
  };

  const restore = (): void => {
    if (!open) return;
    open = false;
    input.off('data', onData);
    input.off('error', onError);
    input.off('end', onEnd);
    try {
      setRawMode(false);
    } finally {
      input.pause();
      output.write(`${CURSOR.upAndClear(drawnRows)}${CURSOR.show}`);
    }
  };
  const release = guardTerminal(restore, proc);

  const finish = (outcome: SelectResult<V> | Error): void => {
    if (!open) return;
    try {
      restore();
    } catch (error) {
      release();
      reject(error);
      return;
    }
    release();
    if (outcome instanceof Error) reject(outcome);
    else {
      if (outcome.picked) output.write(`${ui.dim(`${ui.icons.arrow} ${outcome.label}`)}\n`);
      resolve(outcome);
    }
  };
  const pick = (position: number): void => {
    const item = items[position] as SelectItem<V>;
    finish({ picked: true, value: item.value, label: item.label });
  };

  function onError(error: Error): void {
    finish(error);
  }
  function onEnd(): void {
    finish(new PromptCancelled());
  }
  function onData(chunk: Buffer | string): void {
    try {
      for (const key of parseKeys(chunk.toString('utf8'))) {
        if (!open) return;
        if (key.name === 'up') index = (index + items.length - 1) % items.length;
        else if (key.name === 'down') index = (index + 1) % items.length;
        else if (key.name === 'home') index = 0;
        else if (key.name === 'end') index = items.length - 1;
        else if (key.name === 'enter') return pick(index);
        else if (key.name === 'esc') return finish({ picked: false });
        else if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return finish(new PromptCancelled());
        else if (key.name === 'char') {
          const char = key.char.toLowerCase();
          const byKey = items.findIndex((item) => item.key?.toLowerCase() === char);
          if (byKey >= 0) return pick(byKey);
          if (char === 'q') return finish({ picked: false });
        }
      }
      draw();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }

  try {
    output.write(CURSOR.hide);
    setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);
    draw();
  } catch (error) {
    finish(error instanceof Error ? error : new Error(String(error)));
  }
  return promise;
}
