import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { PromptIo } from '../../src/prompt.ts';
import type { GuardProcess } from '../../src/select.ts';

export interface FakeTty {
  io: PromptIo;
  /** Type bytes as the terminal would send them (a single chunk). */
  send: (chunk: string) => Promise<void>;
  /** Everything written to the screen so far. */
  screen: () => string;
  /** Every `setRawMode` call, in order. */
  rawModes: boolean[];
  /** True while the input is flowing (resumed and not paused). */
  flowing: () => boolean;
  /** Number of `data` listeners still attached to the input. */
  dataListeners: () => number;
}

/** A terminal with raw-mode support: a TTY input that records `setRawMode`, and a TTY output of `columns` x `rows`. */
export function fakeTty(options: { columns?: number; rows?: number; rawMode?: boolean } = {}): FakeTty {
  const input = new PassThrough();
  const output = new PassThrough();
  const rawModes: boolean[] = [];
  Object.assign(input, { isTTY: true });
  if (options.rawMode !== false) {
    Object.assign(input, {
      setRawMode: (mode: boolean) => {
        rawModes.push(mode);
        return input;
      },
    });
  }
  Object.assign(output, { isTTY: true, columns: options.columns ?? 80, rows: options.rows ?? 24 });
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  return {
    io: { input, output } as PromptIo,
    send: async (chunk) => {
      input.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    },
    screen: () => written.join(''),
    rawModes,
    flowing: () => input.readableFlowing === true,
    dataListeners: () => input.listenerCount('data'),
  };
}

/** A stand-in for `process` with signals and an `exit` that only records. */
export function fakeProcess(): GuardProcess & EventEmitter & { exits: number[] } {
  const emitter = new EventEmitter() as GuardProcess & EventEmitter & { exits: number[] };
  emitter.exits = [];
  emitter.exit = (code?: number) => {
    emitter.exits.push(code ?? 0);
  };
  return emitter;
}
