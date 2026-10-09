import { PassThrough, Readable } from 'node:stream';
import type { PromptIo } from '../../src/prompt.ts';

export interface ScriptedTerminal {
  io: PromptIo;
  /** Everything written to the screen so far. */
  screen: () => string;
  /** Answers not consumed yet. */
  remaining: () => string[];
}

/**
 * A terminal without a TTY: each time something reads the input it receives the next scripted answer
 * as one line, and end-of-input once the script is used up (Ctrl+D). Answers are produced on demand,
 * so a prompt that is closed and reopened between questions (as `askVisible` does) never loses one.
 */
export function scriptedTerminal(answers: string[], tty = false): ScriptedTerminal {
  const queue = [...answers];
  const input = new Readable({
    read() {
      setImmediate(() => {
        const next = queue.shift();
        this.push(next === undefined ? null : `${next}\n`);
      });
    },
  });
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  if (tty) {
    Object.assign(input, { isTTY: true });
    Object.assign(output, { isTTY: true });
  }
  return { io: { input, output }, screen: () => written.join(''), remaining: () => [...queue] };
}
