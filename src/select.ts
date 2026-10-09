import { PromptCancelled, type PromptIo } from './prompt.ts';
import { CURSOR, displayWidth, truncate, wrap, type Ui } from './ui.ts';

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
  /** Text of the row (the caller makes it terminal-safe); wrapped to the window, never cut. */
  label: string;
  /** Optional second line under the label (dim), e.g. the path of a method the label names. */
  detail?: string;
  /** Pressing this single key picks the row at once ("1", "0", "l"). Compared case-insensitively. */
  key?: string;
  /** False greys the row out: arrows skip nothing (it stays focusable so its detail is readable) but it cannot be picked. */
  enabled?: boolean;
}

/** An extra key that is not a choice: reported to the caller with the highlighted row (e.g. `r` reset on the accounts list). */
export interface SelectAction {
  key: string;
}

export interface SelectOptions<V> {
  title?: string;
  items: readonly SelectItem<V>[];
  /** The hint footer, e.g. "↑↓ move · Enter select · q quit". */
  hint: string;
  /** Row highlighted first (default 0). */
  initial?: number;
  /** Extra single keys that report `{ picked: false, action }` for the highlighted row instead of picking it. */
  actions?: readonly SelectAction[];
}

export type SelectResult<V> =
  | { picked: true; value: V; label: string }
  | { picked: false; action?: { key: string; index: number } };

/** True when arrow-key selection can run: a rich output and an input that supports raw mode. */
export function canSelect(io: PromptIo, ui: Ui): boolean {
  return ui.rich && io.input.isTTY === true && typeof io.input.setRawMode === 'function';
}

/** `text` on the first line after `prefix`, wrapped so every continuation starts under the text (hanging indent). */
function wrapAfter(prefix: string, text: string, width: number): string[] {
  const room = Math.max(4, width - displayWidth(prefix));
  const parts = wrap(text, room);
  const indent = ' '.repeat(displayWidth(prefix));
  return parts.map((part, index) => (index === 0 ? `${prefix}${part}` : `${indent}${part}`));
}

/**
 * The item indexes that fit on screen around `index`. When the list is taller than the window the
 * selection stays visible and `more` marks hidden rows; never returns an empty range.
 */
function viewport(index: number, count: number, maxRows: number): { top: number; bottom: number; moreAbove: boolean; moreBelow: boolean } {
  if (count <= maxRows) return { top: 0, bottom: count, moreAbove: false, moreBelow: false };
  // Reserve one row for a "more" marker at each end once the window cannot show the whole list.
  const budget = Math.max(1, maxRows - 2);
  let top = Math.min(index, count - budget);
  top = Math.max(0, Math.min(top, index - Math.floor((budget - 1) / 2)));
  const bottom = Math.min(count, top + budget);
  return { top: bottom - budget, bottom, moreAbove: bottom - budget > 0, moreBelow: bottom < count };
}


/**
 * Show a list and let the user pick with ↑/↓ + Enter, a row's own key, or q / Esc / b (cancel:
 * `{ picked: false }`); `actions` keys report the highlighted row without picking it. The list
 * scrolls inside the window when it is taller. Redraws in place, hides the cursor while it is
 * open, and always restores the terminal (raw mode off, cursor back) on pick, cancel, Ctrl+C /
 * Ctrl+D (rejects with `PromptCancelled`), stream errors, thrown errors, SIGINT / SIGTERM / SIGHUP
 * and process exit. Call only when `canSelect` is true.
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
    // Rows the list may occupy: everything minus the title, the hint and one row of echo/prompt.
    const maxListRows = Math.max(1, ui.rows - (options.title === undefined ? 2 : 3));
    const window = viewport(index, items.length, maxListRows);
    const rows: string[] = [];
    if (options.title !== undefined) rows.push(ui.bold(truncate(options.title, width, ui.icons.ellipsis)));
    if (window.moreAbove) rows.push(ui.dim('  ↑ …'));
    for (let position = window.top; position < window.bottom; position += 1) {
      const item = items[position] as SelectItem<V>;
      const selected = position === index;
      const pointer = selected ? ui.icons.pointer : ' ';
      const key = item.key === undefined ? '' : `${item.key} `;
      const prefix = `${pointer} ${key}`;
      const paint = (text: string): string => (selected ? ui.cyan(ui.bold(text)) : item.enabled === false ? ui.dim(text) : text);
      for (const part of wrapAfter(prefix, item.label, width - 1)) rows.push(paint(part));
      if (item.detail !== undefined) {
        for (const part of wrapAfter(`${' '.repeat(displayWidth(prefix))}`, item.detail, width - 1)) rows.push(ui.dim(part));
      }
    }
    if (window.moreBelow) rows.push(ui.dim('  ↓ …'));
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
      if (outcome.picked) {
        const echo = wrap(`${ui.icons.arrow} ${outcome.label}`, ui.columns - 1).map((part) => ui.dim(part));
        output.write(`${echo.join('\n')}\n`);
      }
      resolve(outcome);
    }
  };
  const pick = (position: number): void => {
    const item = items[position] as SelectItem<V>;
    if (item.enabled === false) return;
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
          const action = options.actions?.find((candidate) => candidate.key.toLowerCase() === char);
          if (action !== undefined) return finish({ picked: false, action: { key: action.key, index } });
          if (char === 'q' || char === 'b') return finish({ picked: false });
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

export interface ManyOptions<V> {
  title?: string;
  items: readonly SelectItem<V>[];
  /** Rows ticked at the start (values compared with `===`). Default: none. */
  checked?: readonly V[];
  /** The hint footer, e.g. "↑↓ move · space ticks · Enter start". */
  hint: string;
}

export type ManyResult<V> = { picked: true; values: V[] } | { picked: false };

/**
 * A checklist: ↑/↓ move, Space ticks or unticks the highlighted row, Enter finishes with the ticked
 * values (in list order), q / Esc / b cancel to `{ picked: false }`. Disabled rows cannot be ticked.
 * Same redraw, viewport and terminal-restore discipline as {@link selectMenu}. Call only when
 * `canSelect` is true.
 */
export function selectMany<V>(io: PromptIo, ui: Ui, options: ManyOptions<V>, proc: GuardProcess = process): Promise<ManyResult<V>> {
  const { input, output } = io;
  const { items } = options;
  const { promise, resolve, reject } = Promise.withResolvers<ManyResult<V>>();
  const setRawMode = (input.setRawMode as (mode: boolean) => unknown).bind(input);
  const ticks = new Set<number>(items.map((item, position) => (options.checked?.includes(item.value) === true ? position : -1)).filter((p) => p >= 0));
  let index = Math.max(
    0,
    items.findIndex((item) => item.enabled !== false),
  );
  let drawnRows = 0;
  let open = true;

  const lines = (): string[] => {
    const width = ui.columns - 1;
    const maxListRows = Math.max(1, ui.rows - (options.title === undefined ? 2 : 3));
    const window = viewport(index, items.length, maxListRows);
    const rows: string[] = [];
    if (options.title !== undefined) rows.push(ui.bold(truncate(options.title, width, ui.icons.ellipsis)));
    if (window.moreAbove) rows.push(ui.dim('  ↑ …'));
    for (let position = window.top; position < window.bottom; position += 1) {
      const item = items[position] as SelectItem<V>;
      const selected = position === index;
      const pointer = selected ? ui.icons.pointer : ' ';
      const tick = ticks.has(position) ? '[x]' : '[ ]';
      const prefix = `${pointer} ${tick} `;
      const paint = (text: string): string => (selected ? ui.cyan(ui.bold(text)) : item.enabled === false ? ui.dim(text) : text);
      for (const part of wrapAfter(prefix, item.label, width - 1)) rows.push(paint(part));
      if (item.detail !== undefined) {
        for (const part of wrapAfter(`${' '.repeat(displayWidth(prefix))}`, item.detail, width - 1)) rows.push(ui.dim(part));
      }
    }
    if (window.moreBelow) rows.push(ui.dim('  ↓ …'));
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

  const finish = (outcome: ManyResult<V> | Error): void => {
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
      if (outcome.picked) {
        const names = items.filter((_, position) => ticks.has(position)).map((item) => item.label);
        const echo = wrap(`${ui.icons.arrow} ${names.join(', ')}`, ui.columns - 1).map((part) => ui.dim(part));
        output.write(`${echo.join('\n')}\n`);
      }
      resolve(outcome);
    }
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
        else if (key.name === 'enter') {
          const values = items.filter((_, position) => ticks.has(position)).map((item) => item.value);
          return finish({ picked: true, values });
        } else if (key.name === 'esc') return finish({ picked: false });
        else if (key.name === 'ctrl-c' || key.name === 'ctrl-d') return finish(new PromptCancelled());
        else if (key.name === 'char') {
          const char = key.char.toLowerCase();
          const item = items[index] as SelectItem<V>;
          if (char === ' ' && item.enabled !== false) {
            if (ticks.has(index)) ticks.delete(index);
            else ticks.add(index);
          } else if (char === 'q' || char === 'b') return finish({ picked: false });
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
