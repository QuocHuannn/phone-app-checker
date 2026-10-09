import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Streams a prompt talks to; tests pass fakes, production uses the process TTY. */
export interface PromptIo {
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: Writable;
}

const defaultIo = (): PromptIo => ({ input: process.stdin, output: process.stdout });

export class PromptCancelled extends Error {
  constructor() {
    super('Input cancelled');
    this.name = 'PromptCancelled';
  }
}

/** Ask a question whose answer may be shown on screen (e.g. the account's own phone number). */
export function askVisible(question: string, io: PromptIo = defaultIo()): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const rl = createInterface({ input: io.input, output: io.output, terminal: io.input.isTTY === true });
  let answered = false;
  rl.once('SIGINT', () => {
    rl.close();
    reject(new PromptCancelled());
  });
  rl.once('close', () => {
    if (!answered) reject(new PromptCancelled());
  });
  rl.question(question, (answer) => {
    answered = true;
    rl.close();
    resolve(answer);
  });
  return promise;
}

/**
 * Ask for a secret (login code, two-step password) without echoing it. On a terminal the input is
 * read in raw mode and nothing but the prompt is written (or, with `options.mask`, one mask character per
 * typed character, so a paste visibly arrived without showing it); the terminal is restored on success,
 * Ctrl-C/Ctrl-D, stream errors and early end of input. Non-terminal input is read as one line.
 */
export function askHidden(question: string, io: PromptIo = defaultIo(), options: { mask?: string } = {}): Promise<string> {
  const { input, output } = io;
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    // Piped input never echoes; read a single line without writing it anywhere.
    return askVisible(question, { input, output });
  }

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const setRawMode = input.setRawMode.bind(input);
  let secret = '';
  output.write(question);
  setRawMode(true);
  input.resume();

  const finish = (outcome: { value: string } | { error: Error }): void => {
    input.off('data', onData);
    input.off('error', onError);
    input.off('end', onEnd);
    try {
      setRawMode(false);
    } finally {
      input.pause();
      output.write('\n');
    }
    if ('error' in outcome) reject(outcome.error);
    else resolve(outcome.value);
  };
  const onError = (error: Error): void => finish({ error });
  const onEnd = (): void => finish({ error: new PromptCancelled() });
  const onData = (chunk: Buffer | string): void => {
    for (const char of chunk.toString('utf8')) {
      if (char === '\r' || char === '\n') return finish({ value: secret });
      if (char === '\u0003' || char === '\u0004') return finish({ error: new PromptCancelled() });
      if (char === '\u007f' || char === '\b') {
        if (secret.length > 0 && options.mask !== undefined) output.write('\b \b');
        secret = secret.slice(0, -1);
      } else if (char >= ' ') {
        secret += char;
        if (options.mask !== undefined) output.write(options.mask);
      }
    }
  };
  input.on('data', onData);
  input.on('error', onError);
  input.on('end', onEnd);
  return promise;
}
