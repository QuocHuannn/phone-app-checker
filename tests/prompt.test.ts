import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { askHidden, askVisible, PromptCancelled, type PromptIo } from '../src/prompt.ts';

function terminal() {
  const setRawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  const io: PromptIo = { input, output };
  return { io, input, setRawMode, written: () => written.join('') };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('askHidden on a terminal', () => {
  it('never echoes the secret, honours backspace, and restores the terminal', async () => {
    const t = terminal();
    const answer = askHidden('Password: ', t.io);
    expect(t.setRawMode).toHaveBeenLastCalledWith(true);

    t.input.write('s3cr');
    t.input.write('3x');
    t.input.write('\u007f');
    t.input.write('T\r');

    expect(await answer).toBe('s3cr3T');
    expect(t.written()).toBe('Password: \n');
    expect(t.setRawMode.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it('cancels on Ctrl-C and Ctrl-D and restores the terminal', async () => {
    for (const key of ['\u0003', '\u0004']) {
      const t = terminal();
      const answer = askHidden('Code: ', t.io);
      t.input.write(`12${key}34\r`);
      await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
      expect(t.setRawMode.mock.calls.map((call) => call[0])).toEqual([true, false]);
      expect(t.written()).not.toContain('12');
    }
  });

  it('restores the terminal when the input stream ends or fails', async () => {
    const ended = terminal();
    const first = askHidden('Code: ', ended.io);
    ended.input.end();
    await expect(first).rejects.toBeInstanceOf(PromptCancelled);
    expect(ended.setRawMode).toHaveBeenLastCalledWith(false);

    const failing = terminal();
    const second = askHidden('Code: ', failing.io);
    await tick();
    failing.input.emit('error', new Error('tty gone'));
    await expect(second).rejects.toThrow('tty gone');
    expect(failing.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('stops listening once settled so later input is not captured', async () => {
    const t = terminal();
    const answer = askHidden('Code: ', t.io);
    t.input.write('1\r');
    await answer;
    expect(t.input.listenerCount('data')).toBe(0);
    expect(t.input.listenerCount('error')).toBe(0);
  });
});

describe('prompts on piped input', () => {
  it('reads a hidden answer as one line and writes only the question', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const answer = askHidden('Password: ', { input, output });
    input.write('hunter2\nignored\n');
    expect(await answer).toBe('hunter2');
    expect(written.join('')).toBe('Password: ');
  });

  it('askVisible resolves the typed answer and rejects when input ends early', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askVisible('Phone: ', { input, output });
    input.write('+84901234567\n');
    expect(await answer).toBe('+84901234567');

    const closed = new PassThrough();
    const early = askVisible('Phone: ', { input: closed, output });
    closed.end();
    await expect(early).rejects.toBeInstanceOf(PromptCancelled);
  });
});
