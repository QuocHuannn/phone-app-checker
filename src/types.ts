import type { Lang } from './i18n/index.ts';

export const APPS = ['telegram', 'whatsapp', 'zalo', 'viber', 'line', 'threema'] as const;
export type App = (typeof APPS)[number];

/** Final value written in a report cell. */
export type Status = 'yes' | 'not_found' | 'unknown' | 'skipped' | 'invalid';
/** Value an adapter can return for a number it attempted to check. */
export type CheckStatus = 'yes' | 'not_found' | 'unknown';

export interface PhoneNumber {
  /** E.164, e.g. +84901234567 */
  e164: string;
  /** ISO 3166-1 alpha-2 country code, '' when non-geographic. */
  country: string;
}

/** Per-app pacing settings, all overridable in checker.config.json. */
export interface PacingSettings {
  enabled: boolean;
  /** Numbers handed to Session.check per call. */
  batchSize: number;
  /** Max numbers checked per account per local calendar day. */
  dailyCap: number;
  /** Minimum delay between two batches on the same account. */
  minIntervalMs: number;
  /** Random extra delay (0..jitterMs) added to minIntervalMs. */
  jitterMs: number;
  /** Cooldown applied when the platform throttles and gives no explicit wait time. */
  rateLimitCooldownMs: number;
  /** Cooldown applied after an unexpected error (network, protocol). */
  errorCooldownMs: number;
}

/** How to log in when an app offers more than one way: scan a QR code, or type a code (WhatsApp: pairing code, Telegram: SMS/app login code). */
export type LoginMethod = 'qr' | 'code';

export interface LoginChoice {
  method?: LoginMethod;
  /** WhatsApp pairing code: phone number of the account being linked (any common format with country code). */
  phone?: string;
}

export interface AdapterContext {
  app: App;
  /** Account name chosen at login time. */
  account: string;
  /** Private directory for this account's session files (mode 700). */
  accountDir: string;
  pacing: PacingSettings;
  /** App-specific options from config `apps.<app>` (e.g. Telegram apiId). */
  options: Record<string, unknown>;
  log: (message: string) => void;
  /** Language of the login instructions and prompts (default: English). Only `login` reads it. */
  lang?: Lang;
  /** What the person chose for this login (menu choices or command-line flags). Only `login` reads it. */
  loginChoice?: LoginChoice;
}

export interface Session {
  /**
   * Check a batch. Return a status per E.164; numbers missing from the map are
   * treated as `unknown`. Throw RateLimited / AccountBanned to signal account state.
   */
  check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>>;
  close(): Promise<void>;
}

export interface Adapter {
  app: App;
  /** Interactive login (OTP, QR, ...). Persists credentials inside ctx.accountDir. */
  login(ctx: AdapterContext): Promise<void>;
  /** Open a session from credentials saved by login(). */
  open(ctx: AdapterContext): Promise<Session>;
}

/** Platform throttled the account. Results already obtained may be passed in `partial`. */
export class RateLimited extends Error {
  readonly retryAfterMs: number | undefined;
  readonly partial: Map<string, CheckStatus>;
  constructor(message: string, retryAfterMs?: number, partial?: Map<string, CheckStatus>) {
    super(message);
    this.name = 'RateLimited';
    this.retryAfterMs = retryAfterMs;
    this.partial = partial ?? new Map();
  }
}

/** Account is logged out, banned, or otherwise unusable until a human intervenes. */
export class AccountBanned extends Error {
  readonly partial: Map<string, CheckStatus>;
  constructor(message: string, partial?: Map<string, CheckStatus>) {
    super(message);
    this.name = 'AccountBanned';
    this.partial = partial ?? new Map();
  }
}

/**
 * Mask the middle digits of a phone number for logs. Numbers of 10+ characters keep a 5-character
 * prefix and 3-character suffix; shorter ones (7-9 characters) keep only as much as still leaves
 * four characters hidden, so no run is ever returned whole.
 */
export function maskPhone(e164: string): string {
  if (e164.length < 7) return e164;
  if (e164.length < 10) {
    const visible = e164.length - 4;
    return `${e164.slice(0, visible - 1)}****${e164.slice(-1)}`;
  }
  return `${e164.slice(0, 5)}****${e164.slice(-3)}`;
}

// Up to two separators between digits so "(090) 123-4567" is one run, not an unmasked "090".
const PHONE_RUN = new RegExp(String.raw`\+?\d(?:[\s().-]{0,2}\d){6,}`, 'g');

/**
 * Mask every phone-number-looking digit run in free text (error messages, adapter logs), with no
 * exemption for URLs or paths: those can embed numbers too (account directories, query strings).
 * Interactive login output, which must stay verbatim, simply does not go through this function.
 */
export function redactPhones(text: string): string {
  return text.replace(PHONE_RUN, (match) => maskPhone(match.replace(/[^\d+]/g, '')));
}

/**
 * Make text that may carry customer-controlled characters (a CSV title, a parser message quoting a
 * record) safe for a terminal or log: whole ANSI escape sequences (CSI, OSC) are dropped; every other
 * control, format (bidi override/isolate, zero-width), line/paragraph separator character and U+FFFD
 * becomes a space, so nothing can move the cursor, erase output, reorder text or forge extra lines;
 * `keepNewlines` keeps line feeds and tabs for messages that are legitimately multi-line. The result
 * is capped to `max` characters (code points) with "...".
 */
export function terminalSafe(text: string, max: number, keepNewlines = false): string {
  const stripped = text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ');
  const clean = (
    keepNewlines
      ? stripped.replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFD]/gu, ' ')
      : stripped.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFD]+/gu, ' ')
  ).trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : clean;
}
