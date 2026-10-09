import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTelegramCredentials } from './adapters/telegram-credentials.ts';
import { assertAccountName, listAccountNames, type Config } from './config.ts';
import { parseTelegramApiHash, parseTelegramApiId } from './config-write.ts';
import { readPhoneCsv, type ParsedInput } from './csv.ts';
import {
  LANGS,
  LANGUAGE_LABEL,
  LANGUAGE_NAMES,
  parseLang,
  resolveLang,
  translate,
  type Lang,
  type MessageArgs,
  type MessageKey,
} from './i18n/index.ts';
import { normalizePhone } from './phone.ts';
import { TELEGRAM_APPS_URL } from './open-url.ts';
import { askHidden, askVisible, PromptCancelled, type PromptIo } from './prompt.ts';
import { qrWindowNeed, type QrStream } from './qr.ts';
import { openRecentFiles, type RecentEntry, type RecentFiles } from './recent.ts';
import { APP_TITLE, banner, reportBox, statusStrip } from './screens.ts';
import { canSelect, selectMany, selectMenu, type SelectItem, type SelectResult } from './select.ts';
import { APPS, terminalSafe, type App, type LoginMethod } from './types.ts';
import { box, createUi, wrap, type Ui, type UiStream } from './ui.ts';

/** Longest user-supplied text (code points) echoed back to the terminal. */
const SHOWN_MAX = 512;
const DEFAULT_REPORT_NAME = 'report.csv';
const DEFAULT_ACCOUNT = 'default';
/** Typed exactly so means "back" in every text prompt of the menu. */
const BACK_CHAR = /^b$/i;

/**
 * Largest QR side (modules) a login is expected to show, per app: the pre-login window check (r3 §3.4 M10)
 * uses it before any code exists. WhatsApp's documented ceiling is 61 (docs/reference.md); Telegram's
 * deep links are short and LINE's are URLs, so theirs are estimated — being off by a version step changes
 * the announced need by a couple of rows, never the flow. Viber pairs over adb: no QR at all.
 */
const QR_MAX_MODULES: Record<App, number> = { telegram: 49, whatsapp: 61, zalo: 61, line: 45, viber: 0, threema: 0, matrix: 0 };

/** Outcome of one CLI command run from the menu; `error` is already terminal-safe. */
export interface CommandResult {
  code: number;
  error?: string;
  /** Set when the command wrote a report: where, and how many numbers still lack a fresh answer. */
  report?: { path: string; inconclusive: number };
}

/** Everything the menu needs from the CLI; tests pass fakes, `cli.ts` passes the real thing. */
export interface MenuHost {
  io: PromptIo;
  version: string;
  cwd: string;
  /** The user's home directory (for `~`). */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** Fresh config read (bootstraps the app home like any command); throws on a broken config. */
  loadConfig: () => Config;
  /** Path of the config file, shown after the Telegram api_id / api_hash are saved there. */
  configFile: () => string;
  /** Save the Telegram api_id / api_hash in the config file (atomic, mode 600, other settings kept); throws on failure. */
  saveTelegramCredentials: (apiId: number, apiHash: string) => void;
  /** Run `phone-app-checker <args...>` exactly as typed on the command line; never throws. */
  run: (args: string[]) => Promise<CommandResult>;
  /** Language given with `--lang` (beats the environment and the saved choice). */
  langFlag?: string;
  /** The saved language code, if any (never throws). Absent when nothing can be saved. */
  readLanguage?: () => string | undefined;
  /** Save the language choice; throws on failure (the menu then keeps the choice for this session only). */
  saveLanguage?: (lang: Lang) => void;
  /** Open an address in the default browser (macOS `open`); resolves false when it could not. Absent: the menu never offers it. */
  openUrl?: (url: string) => Promise<boolean>;
  /** Reveal a file in Finder (macOS `open -R`); resolves false when it could not. Absent: the menu prints the path instead. */
  revealPath?: (path: string) => Promise<boolean>;
}

interface Menu {
  host: MenuHost;
  say: (text?: string) => void;
  /** Language the menu is shown in; the user can change it with `L`. */
  lang: Lang;
  /** The last CSV and report used in this session (defaults for "view latest report"). */
  last: { csv?: string; out?: string };
  /** Colours, icons and window size of the menu's output; plain (no ANSI) unless the output is a real terminal. */
  ui: Ui;
  /** Recent-file store, opened lazily per data directory (one open per config). */
  recents?: { dir: string; files: RecentFiles | null };
}

/** Message `key` in the menu's current language. */
function t<K extends MessageKey>(menu: Menu, key: K, ...args: MessageArgs<K>): string {
  return translate(menu.lang, key, ...args);
}

/** True when both ends are a terminal: only then may the menu open (it would hang a script). */
export function isInteractive(io: PromptIo): boolean {
  return io.input.isTTY === true && 'isTTY' in io.output && io.output.isTTY === true;
}

const shown = (text: string): string => terminalSafe(text, SHOWN_MAX);

/**
 * Turn what a terminal gives for a dragged-in or pasted file into an absolute path: bracketed-paste
 * markers and surrounding whitespace dropped, one pair of quotes removed, shell backslash escapes
 * (`My\ File\ \(1\).csv`) undone, `file://` URLs decoded, `~` expanded, relative paths resolved
 * against `cwd`. `undefined` for an empty answer.
 */
export function normalizeDroppedPath(raw: string, homeDir: string, cwd: string): string | undefined {
  let text = raw.replace(/\[20[01]~/g, '').trim();
  if (text === '') return undefined;
  const quote = text[0];
  if (text.length >= 2 && (quote === "'" || quote === '"') && text.endsWith(quote)) {
    text = text.slice(1, -1);
    if (quote === '"') text = text.replace(/\\(["\\$`])/g, '$1');
  } else {
    text = text.replace(/\\(.)/gs, '$1');
  }
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch {
      // Not a valid file URL: leave it, the existence check reports it.
    }
  }
  if (text === '~' || text.startsWith('~/')) text = join(homeDir, text.slice(1));
  return resolve(cwd, text);
}

/** Why `path` cannot be used as the input CSV, or `undefined` when it is a readable regular file. */
function inputProblem(menu: Menu, path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return t(menu, 'fileNotFound', { path: shown(path) });
  if (!stat.isFile()) return t(menu, 'notAFile', { path: shown(path) });
  if (stat.size === 0) return t(menu, 'fileEmpty', { path: shown(path) });
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return t(menu, 'fileNoPermission', { path: shown(path) });
  }
  return undefined;
}

/** Lower-cased, accents and surrounding blanks removed, so `Có`, `co` and ` CO ` compare equal. */
const foldAnswer = (text: string): string => text.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

/**
 * True for the language's yes words (and always y/yes), false for its no words (and always n/no),
 * `undefined` for anything else. The words are the comma-separated `answerYes` / `answerNo` messages.
 */
export function parseYesNo(answer: string, lang: Lang): boolean | undefined {
  const text = foldAnswer(answer);
  const words = (key: 'answerYes' | 'answerNo'): string[] => translate(lang, key).split(',').map(foldAnswer);
  if (['y', 'yes', ...words('answerYes')].includes(text)) return true;
  if (['n', 'no', ...words('answerNo')].includes(text)) return false;
  return undefined;
}

async function confirm(menu: Menu, question: string, fallback: boolean): Promise<boolean> {
  const hint = t(menu, fallback ? 'confirmHintYes' : 'confirmHintNo');
  for (;;) {
    const answer = await askVisible(`${question} (${hint}): `, menu.host.io);
    if (answer.trim() === '') return fallback;
    const parsed = parseYesNo(answer, menu.lang);
    if (parsed !== undefined) return parsed;
    menu.say(t(menu, 'confirmRetry'));
  }
}

/** Wait for Enter (any line, `b` included) after long output so the menu does not scroll it away. */
async function pauseForMenu(menu: Menu): Promise<void> {
  await askVisible(t(menu, 'pressEnterForMenu'), menu.host.io);
}

/** The recent-file store for this config's data directory; `null` when the directory cannot be used. */
function recentsFor(menu: Menu, cfg: Config): RecentFiles | null {
  if (menu.recents?.dir !== cfg.dataDir) menu.recents = { dir: cfg.dataDir, files: openRecentFiles(cfg.dataDir) };
  return menu.recents.files;
}

/** "just now / n min ago / n h ago / yesterday / a date" for a recent-file row. */
function recentWhen(menu: Menu, at: number): string {
  const age = Date.now() - at;
  if (age < 60_000) return t(menu, 'recentWhenJustNow');
  if (age < 3_600_000) return t(menu, 'recentWhenMinutes', { count: Math.max(1, Math.round(age / 60_000)) });
  if (age < 24 * 3_600_000) return t(menu, 'recentWhenHours', { count: Math.max(1, Math.round(age / 3_600_000)) });
  if (age < 48 * 3_600_000) return t(menu, 'recentWhenYesterday');
  return new Date(at).toLocaleDateString();
}

/** Ask for the input CSV until it is a readable file; `b` (or Esc/q in a list) goes back, `undefined` the result. */
async function typedCsvPath(menu: Menu, entries: readonly { path: string; exists: boolean }[], fallback: string | undefined): Promise<string | undefined> {
  const { host, say } = menu;
  const hint = entries.length > 0 ? t(menu, 'pickCsvRecentHint') : fallback === undefined ? t(menu, 'askCsvHintBack') : t(menu, 'askCsvHintDefault', { path: shown(fallback) });
  for (;;) {
    const answer = (await askVisible(t(menu, 'askCsvPrompt', { hint }), host.io)).trim();
    if (BACK_CHAR.test(answer)) return undefined;
    const num = entries.length > 0 && /^\d+$/.test(answer) ? Number(answer) : 0;
    if (num >= 1 && num <= entries.length) {
      const entry = entries[num - 1] as { path: string; exists: boolean };
      if (entry.exists) return entry.path;
      say(t(menu, 'fileNotFound', { path: shown(entry.path) }));
      continue;
    }
    const path = normalizeDroppedPath(answer, host.homeDir, host.cwd) ?? fallback;
    // An empty answer with no default asks again; every prompt tells the user about `b`.
    if (path === undefined) continue;
    const problem = inputProblem(menu, path);
    if (problem === undefined) return path;
    say(problem);
  }
}

/** One remembered CSV as the picker's "N. name — folder · when" row. */
function recentRowText(menu: Menu, entry: RecentEntry & { exists: boolean }): string {
  return `${shown(basename(entry.path))} — ${shown(dirname(entry.path))} · ${recentWhen(menu, entry.at)}`;
}

/**
 * Choose the input CSV: the last five files used (when remembering is on and they still exist), then
 * a typed/dragged path. `b` goes back; Enter on the typed question accepts `fallback` when there is one.
 */
async function pickCsvPath(menu: Menu, cfg: Config, fallback?: string): Promise<string | undefined> {
  const { host, say } = menu;
  const recents = recentsFor(menu, cfg);
  const entries = recents?.listWithMissing() ?? [];
  if (canSelect(host.io, menu.ui) && entries.length > 0) {
    say(t(menu, 'pickCsvDrag'));
    const items: SelectItem<{ kind: 'path'; path: string } | { kind: 'type' } | { kind: 'clear' }>[] = [
      ...entries.map((entry, index) => ({
        value: { kind: 'path' as const, path: entry.path },
        label: shown(basename(entry.path)),
        detail: entry.exists ? `${shown(dirname(entry.path))} · ${recentWhen(menu, entry.at)}` : t(menu, 'recentMissing'),
        key: String(index + 1),
        enabled: entry.exists,
      })),
      { value: { kind: 'type' as const }, label: t(menu, 'pickCsvType'), key: 't' },
      { value: { kind: 'clear' as const }, label: t(menu, 'recentClear'), key: 'c' },
    ];
    const result = await selectMenu(host.io, menu.ui, { title: t(menu, 'pickCsvTitle'), items, hint: t(menu, 'hintBack') });
    if (result.picked && result.value.kind === 'path') return result.value.path;
    if (result.picked && result.value.kind === 'clear') {
      if (await confirm(menu, t(menu, 'recentConfirm'), false)) {
        recents?.disable();
        say(t(menu, 'recentCleared'));
      }
    } else if (!result.picked) {
      return undefined;
    }
    // "type a path", a cleared list or a refused clear all land on the typed question.
    return typedCsvPath(menu, [], fallback);
  }
  if (entries.length > 0) {
    say(t(menu, 'pickCsvDrag'));
    entries.forEach((entry, index) => say(`  ${index + 1}. ${recentRowText(menu, entry)}${entry.exists ? '' : ` (${t(menu, 'recentMissing')})`}`));
    say(`  c. ${t(menu, 'recentClear')}`);
    for (;;) {
      const answer = (await askVisible(t(menu, 'askCsvPrompt', { hint: t(menu, 'pickCsvRecentHint') }), host.io)).trim();
      if (BACK_CHAR.test(answer)) return undefined;
      if (answer === 'c') {
        if (await confirm(menu, t(menu, 'recentConfirm'), false)) {
          recents?.disable();
          say(t(menu, 'recentCleared'));
        }
        return typedCsvPath(menu, [], fallback);
      }
      const num = /^\d+$/.test(answer) ? Number(answer) : 0;
      if (num >= 1 && num <= entries.length) {
        const entry = entries[num - 1] as RecentEntry & { exists: boolean };
        if (entry.exists) return entry.path;
        say(t(menu, 'fileNotFound', { path: shown(entry.path) }));
        continue;
      }
      const path = normalizeDroppedPath(answer, host.homeDir, host.cwd) ?? fallback;
      if (path === undefined) continue;
      const problem = inputProblem(menu, path);
      if (problem === undefined) return path;
      say(problem);
    }
  }
  if (!canSelect(host.io, menu.ui)) say(t(menu, 'askCsvIntro'));
  return typedCsvPath(menu, [], fallback);
}

/**
 * Show what the chosen file will give the run — rows, usable numbers, unusable examples and the
 * countries found — using the same `readPhoneCsv` the check command uses (local, no network).
 * False when the file cannot be parsed.
 */
function previewCsv(menu: Menu, cfg: Config, path: string): boolean {
  const { say, ui } = menu;
  let parsed: ParsedInput;
  try {
    parsed = readPhoneCsv(path, { defaultRegion: cfg.defaultRegion });
  } catch (error) {
    say(t(menu, 'commandError', { error: shown(error instanceof Error ? error.message : String(error)) }));
    return false;
  }
  say(`${ui.icons.ok} ${t(menu, 'previewTitle', { name: shown(basename(path)), column: parsed.column })}`);
  const unusable = parsed.entries.filter((entry) => entry.phone === null);
  say(`  ${t(menu, 'previewCounts', { rows: parsed.rows, usable: parsed.entries.length - unusable.length, unusable: unusable.length })}`);
  if (unusable.length > 0) {
    const examples = unusable.slice(0, 2).map((entry) => shown(JSON.stringify(entry.input)));
    say(`  ${t(menu, 'previewUnusable', { examples: examples.join(', ') })}`);
  }
  const countries = new Map<string, number>();
  for (const entry of parsed.entries) {
    if (entry.phone !== null && entry.phone.country !== '') countries.set(entry.phone.country, (countries.get(entry.phone.country) ?? 0) + 1);
  }
  if (countries.size > 0) {
    const list = [...countries.entries()].sort((a, b) => b[1] - a[1]).map(([country, count]) => `${country} ${count}`).join(' · ');
    say(`  ${t(menu, 'previewCountries', { list })}`);
  }
  return true;
}

/** Enter (or a yes word) keeps the file; `b` or a no word goes back to picking one. */
async function confirmCsv(menu: Menu): Promise<boolean> {
  for (;;) {
    const answer = (await askVisible(t(menu, 'previewPrompt'), menu.host.io)).trim();
    if (answer === '') return true;
    if (BACK_CHAR.test(answer)) return false;
    const parsed = parseYesNo(answer, menu.lang);
    if (parsed !== undefined) return parsed;
    menu.say(t(menu, 'confirmRetry'));
  }
}

/** The file question plus the preview gate in one loop; `b` backtracks a file at a time. */
async function pickCsvAndPreview(menu: Menu, cfg: Config, fallback?: string): Promise<string | undefined> {
  for (;;) {
    const csv = await pickCsvPath(menu, cfg, fallback);
    if (csv === undefined) return undefined;
    if (previewCsv(menu, cfg, csv) && (await confirmCsv(menu))) return csv;
  }
}

/** Default report location: next to the CSV when that folder is writable, else the current folder. */
function defaultReportPath(csv: string, cwd: string): string {
  const dir = dirname(csv);
  try {
    accessSync(dir, constants.W_OK);
    return join(dir, DEFAULT_REPORT_NAME);
  } catch {
    return join(cwd, DEFAULT_REPORT_NAME);
  }
}

/** Ask where the report goes and confirm before replacing an existing file; `undefined` = cancelled. */
async function askReportPath(menu: Menu, csv: string): Promise<string | undefined> {
  const { host, say } = menu;
  const fallback = defaultReportPath(csv, host.cwd);
  const answer = (await askVisible(t(menu, 'askReportPrompt', { path: shown(fallback) }), host.io)).trim();
  if (BACK_CHAR.test(answer)) return undefined;
  let out = normalizeDroppedPath(answer, host.homeDir, host.cwd) ?? fallback;
  if (statSync(out, { throwIfNoEntry: false })?.isDirectory()) out = join(out, DEFAULT_REPORT_NAME);
  if (existsSync(out) && !(await confirm(menu, t(menu, 'reportExists', { path: shown(out) }), false))) {
    say(t(menu, 'cancelledNoOverwrite'));
    return undefined;
  }
  return out;
}

/** Apps that have at least one logged-in account, each with its account names. */
function loggedInApps(cfg: Config): Map<App, string[]> {
  const found = new Map<App, string[]>();
  for (const app of APPS) {
    const names = listAccountNames(cfg, app);
    if (names.length > 0) found.set(app, names);
  }
  return found;
}

/**
 * Pick apps by number or name ("1,3", "telegram zalo"); Enter = all of `available`.
 * Returns an error message for input that names nothing usable.
 */
function parseAppSelection(menu: Menu, answer: string, available: readonly App[]): App[] | string {
  const tokens = answer.split(/[\s,;]+/).filter((token) => token !== '');
  if (tokens.length === 0) return [...available];
  const picked = new Set<App>();
  for (const token of tokens) {
    const name = token.toLowerCase();
    const app = /^\d+$/.test(token) ? available[Number(token) - 1] : available.find((candidate) => candidate === name);
    if (app === undefined) return t(menu, 'appSelectionUnknown', { token: shown(token) });
    picked.add(app);
  }
  return available.filter((app) => picked.has(app));
}

/**
 * Which logged-in apps the check uses. A checklist on a rich terminal (space ticks, Enter runs),
 * the numbered prompt elsewhere; `b` goes back. `undefined` when the user backs out.
 */
async function chooseApps(menu: Menu, logged: Map<App, string[]>): Promise<App[] | undefined> {
  const available = [...logged.keys()];
  if (available.length === 1) return [...available];
  if (canSelect(menu.host.io, menu.ui)) {
    const items: SelectItem<App>[] = available.map((app) => ({
      value: app,
      label: app,
      detail: (logged.get(app) ?? []).map(shown).join(', ') || undefined,
    }));
    for (;;) {
      const result = await selectMany(menu.host.io, menu.ui, {
        title: t(menu, 'appsTitle'),
        items,
        checked: available,
        hint: t(menu, 'appsHint'),
      });
      if (!result.picked) return undefined;
      if (result.values.length > 0) return result.values;
      menu.say(t(menu, 'appsPickNone'));
    }
  }
  menu.say(t(menu, 'appsLoggedInHeader'));
  available.forEach((app, index) => {
    const names = (logged.get(app) ?? []).map(shown).join(', ');
    menu.say(`  ${index + 1}. ${app}${names === '' ? '' : ` (${names})`}`);
  });
  for (;;) {
    const answer = await askVisible(t(menu, 'appsChoosePrompt'), menu.host.io);
    if (BACK_CHAR.test(answer.trim())) return undefined;
    const picked = parseAppSelection(menu, answer, available);
    if (typeof picked !== 'string') return picked;
    menu.say(picked);
  }
}

function reportCommandResult(menu: Menu, result: CommandResult): void {
  if (result.error !== undefined) menu.say(t(menu, 'commandError', { error: result.error }));
  if (result.code !== 0) menu.say(t(menu, 'commandFailed', { code: result.code }));
}

/** Load the config for an action; on failure show why and return undefined. */
function configOrReport(menu: Menu): Config | undefined {
  try {
    return menu.host.loadConfig();
  } catch (error) {
    menu.say(t(menu, 'configUnreadable', { reason: shown(error instanceof Error ? error.message : String(error)) }));
    menu.say(t(menu, 'configFixHint', { file: shown(menu.host.configFile()) }));
    return undefined;
  }
}

async function checkCsv(menu: Menu): Promise<void> {
  const { host, say } = menu;
  const cfg = configOrReport(menu);
  if (cfg === undefined) return;
  const logged = loggedInApps(cfg);
  if (logged.size === 0) {
    say(t(menu, 'checkNoAccounts'));
    if (await confirm(menu, t(menu, 'checkLoginNow'), true)) await loginApp(menu);
    return;
  }
  const csv = await pickCsvAndPreview(menu, cfg);
  if (csv === undefined) return;
  const apps = await chooseApps(menu, logged);
  if (apps === undefined) return;
  const out = await askReportPath(menu, csv);
  if (out === undefined) return;
  menu.last = { csv, out };
  recentsFor(menu, cfg)?.add(csv);

  say(t(menu, 'checkStarting', { apps: apps.join(', ') }));
  const result = await host.run(['check', '--out', out, '--apps', apps.join(','), '--', csv]);
  reportCommandResult(menu, result);
  if (result.code === 0) {
    showReportDone(menu, out, result, true);
    if (result.report !== undefined) await pauseOrReveal(menu, result.report.path);
  } else if (result.code === 130) {
    printReportBox(menu, out, result);
    say(t(menu, 'checkInterrupted', { path: shown(out) }));
    if (result.report !== undefined) await pauseOrReveal(menu, result.report.path);
  }
}

/** After a check/summary: Enter returns to the menu, `o` reveals the report in Finder. */
async function pauseOrReveal(menu: Menu, path: string): Promise<void> {
  const { host, say } = menu;
  if (host.revealPath === undefined) {
    await pauseForMenu(menu);
    return;
  }
  for (;;) {
    const answer = (await askVisible(t(menu, 'revealPrompt'), host.io)).trim().toLowerCase();
    if (answer !== 'o') return;
    say(t(menu, (await host.revealPath(path)) ? 'revealDone' : 'revealFailed'));
  }
}

/** Closing box of a check on a rich terminal; false (nothing printed) on a plain one or when no report was written. */
function printReportBox(menu: Menu, out: string, result: CommandResult): boolean {
  if (!menu.ui.rich || result.report === undefined) return false;
  for (const line of reportBox(menu.ui, menu.lang, { path: out, inconclusive: result.report.inconclusive })) menu.say(line);
  return true;
}

/** "Report saved to ..." (box on a rich terminal) or the classic one-line message. */
function showReportDone(menu: Menu, out: string, result: CommandResult, withHint: boolean): void {
  if (printReportBox(menu, out, result)) return;
  menu.say(t(menu, 'reportDone', { path: shown(out) }));
  if (withHint) menu.say(t(menu, 'checkSummaryHint'));
}

/** The status text of one app in the login list: "not set up" or "logged in: n accounts (names)". */
function appStatusText(menu: Menu, names: string[] | undefined): string {
  return names === undefined ? t(menu, 'appNotSetUp') : t(menu, 'appLoggedIn', { count: names.length, names: names.map(shown).join(', ') });
}

/** One line per app: number, app name and status; no padding, since CJK/Hangul text has no fixed width. */
function appStatusLine(menu: Menu, app: App, index: number, names: string[] | undefined): string {
  return `  ${index + 1}. ${app}: ${appStatusText(menu, names)}`;
}


/** `Step n/m - title`: the same header on every login screen. */
function stepHeader(menu: Menu, n: number, m: number, title: MessageKey): void {
  const { ui } = menu;
  menu.say(`${ui.bold(ui.cyan(`${t(menu, 'stepLabel', { n, m })} -`))} ${ui.bold(t(menu, title))}`);
}

/** True when the Telegram api_id / api_hash are already known (config file or environment). */
function telegramKeysSaved(menu: Menu, cfg: Config): boolean {
  try {
    readTelegramCredentials(cfg.apps.telegram.options, menu.host.env);
    return true;
  } catch {
    return false;
  }
}

/** Offer to open the Telegram API page in the browser; only on a terminal, only after a yes, only that one fixed address. */
async function offerBrowser(menu: Menu): Promise<void> {
  const { host } = menu;
  if (host.openUrl === undefined || !isInteractive(host.io)) return;
  if (!(await confirm(menu, t(menu, 'tgOpenPrompt'), false))) return;
  menu.say(t(menu, (await host.openUrl(TELEGRAM_APPS_URL)) ? 'tgOpened' : 'tgOpenFailed'));
}

/** Friendly reason why `answer` is not an api_id (a pasted api_hash is the usual mistake). */
function apiIdProblem(menu: Menu, answer: string): string {
  return /^[0-9a-f]{32}$/i.test(answer) ? t(menu, 'telegramApiIdLooksLikeHash') : t(menu, 'telegramApiIdInvalid');
}

/** Friendly reason why `answer` is not an api_hash (the api_id pasted, or the wrong length). */
function apiHashProblem(menu: Menu, answer: string): string {
  if (/^\d{1,12}$/.test(answer)) return t(menu, 'telegramApiHashLooksLikeId');
  if (/^[0-9a-f]+$/i.test(answer)) return t(menu, 'telegramApiHashLength', { count: answer.length });
  return t(menu, 'telegramApiHashInvalid');
}

/**
 * Step 2 of the Telegram login, when the api_id / api_hash are not known yet: ask for them here — the
 * api_id as digits, the api_hash hidden (a mask character per typed character, never the value) — and
 * save them in the config file. True when login may go ahead; Enter or `b` goes back.
 */
async function telegramKeysAsked(menu: Menu): Promise<boolean> {
  stepHeader(menu, 2, 3, 'tgStepSave');
  menu.say(`  ${t(menu, 'telegramStep3')}`);
  menu.say(`  ${t(menu, 'telegramSecretNote')}`);
  let apiId: number | undefined;
  while (apiId === undefined) {
    const answer = (await askVisible(t(menu, 'telegramApiIdPrompt'), menu.host.io)).trim();
    if (BACK_ANSWER.test(answer)) return false;
    apiId = parseTelegramApiId(answer);
    if (apiId === undefined) menu.say(apiIdProblem(menu, answer));
  }
  let apiHash: string | undefined;
  while (apiHash === undefined) {
    const answer = (await askHidden(t(menu, 'telegramApiHashPrompt'), menu.host.io, { mask: menu.ui.rich ? '•' : '*' })).trim();
    if (BACK_ANSWER.test(answer)) return false;
    apiHash = parseTelegramApiHash(answer);
    if (apiHash === undefined) menu.say(apiHashProblem(menu, answer));
  }
  menu.say(t(menu, 'telegramHashAccepted', { count: apiHash.length }));
  try {
    menu.host.saveTelegramCredentials(apiId, apiHash);
  } catch (error) {
    menu.say(t(menu, 'telegramSaveFailed', { reason: shown(error instanceof Error ? error.message : String(error)) }));
    return false;
  }
  menu.say(t(menu, 'telegramCredentialsSaved', { path: shown(menu.host.configFile()) }));
  return true;
}

/** Empty answer or "b": go back (kept for the credential prompts where Enter has no default). */
const BACK_ANSWER = /^(b|)$/i;

/** What to tell the user before a login that does not explain itself on screen. */
const LOGIN_HINTS: Partial<Record<App, MessageKey>> = {
  telegram: 'hintTelegram',
  viber: 'hintViber',
  line: 'hintLine',
  threema: 'hintThreema',
  matrix: 'hintMatrix',
};

/** `undefined` when the user types `b` to go back; the name (or the default) otherwise. */
async function askAccountName(menu: Menu): Promise<string | undefined> {
  for (;;) {
    const answer = (await askVisible(t(menu, 'askAccountPrompt', { name: DEFAULT_ACCOUNT }), menu.host.io)).trim();
    if (BACK_CHAR.test(answer)) return undefined;
    const name = answer === '' ? DEFAULT_ACCOUNT : answer;
    try {
      assertAccountName(name);
      return name;
    } catch {
      menu.say(t(menu, 'accountNameInvalid'));
    }
  }
}

/** Arrow-key list on a rich terminal: the result (also carries `action` when `options.actions` is used). Only call when `canSelect`. */
function pick<V>(menu: Menu, title: string | undefined, items: SelectItem<V>[], hint: MessageKey, initial = 0): Promise<SelectResult<V>> {
  return selectMenu(menu.host.io, menu.ui, { ...(title === undefined ? {} : { title }), items, hint: t(menu, hint), initial });
}

/** `pick` reduced to the chosen value or `undefined` when the user backs out (q / Esc / b). */
async function pickRow<V>(menu: Menu, title: string | undefined, items: SelectItem<V>[], hint: MessageKey, initial = 0): Promise<V | undefined> {
  const result = await pick(menu, title, items, hint, initial);
  return result.picked ? result.value : undefined;
}

/**
 * Two ways to log in (`order` says which method is first); the numbered prompt, where Enter = option 1
 * and `b` goes back, or an arrow-key list on a rich terminal. `details` adds a dimmed sub-line under a
 * method (it carries the why/where the single line used to lose to the window edge).
 */
async function chooseLoginMethod(
  menu: Menu,
  lines: readonly [MessageKey, MessageKey, MessageKey],
  order: readonly [LoginMethod, LoginMethod] = ['qr', 'code'],
  details?: Partial<Record<MessageKey, string>>,
): Promise<LoginMethod | undefined> {
  if (canSelect(menu.host.io, menu.ui)) {
    const rows = [lines[1], lines[2]].map((key, index): SelectItem<LoginMethod> => {
      const detail = details?.[key];
      return {
        value: order[index] ?? order[0],
        label: t(menu, key).replace(/^\d\)\s*/, ''),
        ...(detail === undefined ? {} : { detail }),
        key: String(index + 1),
      };
    });
    return pickRow(menu, t(menu, lines[0]), rows, 'hintBack');
  }
  menu.say(t(menu, lines[0]));
  [lines[1], lines[2]].forEach((key, index) => {
    menu.say(`  ${index + 1}. ${t(menu, key).replace(/^\d\)\s*/, '')}`);
    const detail = details?.[key];
    if (detail !== undefined) menu.say(`     ${detail}`);
  });
  for (;;) {
    const answer = (await askVisible(t(menu, 'loginMethodPrompt', { max: 2 }), menu.host.io)).trim();
    if (answer === '') return order[0];
    if (BACK_CHAR.test(answer)) return undefined;
    if (answer === '1' || answer === '2') return order[Number(answer) - 1] ?? order[0];
    menu.say(t(menu, 'loginMethodInvalid', { max: 2 }));
  }
}

/**
 * The terminal the QR renderer will draw into (the menu's own output), for the pre-login fit check.
 * `getColorDepth` travels with it: it decides colour or plain drawing, and the two need very different window sizes.
 */
function qrStreamFor(menu: Menu): Pick<QrStream, 'isTTY' | 'columns' | 'rows' | 'getColorDepth'> {
  const out = menu.host.io.output as UiStream & Pick<QrStream, 'getColorDepth'>;
  const depth = out.getColorDepth;
  return {
    isTTY: out.isTTY,
    columns: out.columns,
    rows: out.rows,
    ...(typeof depth === 'function' ? { getColorDepth: (env?: NodeJS.ProcessEnv) => depth.call(out, env) } : {}),
  };
}

/**
 * The pre-login QR gate (r3 §3.4 M10): when the window cannot hold the code at all, say the size it
 * needs before anything is drawn, then Enter re-checks after the user enlarges it, `c` switches to the
 * non-QR method when the app has one (WhatsApp pairing code, Telegram login code) and `b` stops.
 */
async function qrGate(menu: Menu, app: App, altKey: 'qrGateAltWhatsapp' | 'qrGateAltTelegram' | undefined): Promise<'ok' | 'alt' | 'back'> {
  if (qrStreamFor(menu).isTTY !== true) return 'ok';
  for (;;) {
    // Read the window again each time: the user enlarges it between the question and the Enter.
    const stream = qrStreamFor(menu);
    const need = qrWindowNeed(QR_MAX_MODULES[app] || 61, stream, menu.host.env);
    if (need.fits) return 'ok';
    menu.say(t(menu, 'qrGateTooSmall', { cols: menu.ui.columns, rows: menu.ui.rows, needCols: need.columns, needRows: need.rows }));
    menu.say(`  ${menu.ui.icons.bullet} ${t(menu, 'qrGateEnlarge')}`);
    const answer = (await askVisible(t(menu, 'qrGatePrompt', { alt: altKey === undefined ? '' : t(menu, altKey) }), menu.host.io)).trim().toLowerCase();
    if (BACK_CHAR.test(answer)) return 'back';
    if (answer === 'c' && altKey !== undefined) return 'alt';
    // Enter (and anything else) re-checks the window.
  }
}

/** WhatsApp's pairing code needs the number of the account being linked; undefined = the user went back. */
async function askWhatsappPhone(menu: Menu, cfg: Config): Promise<string | undefined> {
  for (;;) {
    const answer = (await askVisible(t(menu, 'whatsappPhonePrompt'), menu.host.io)).trim();
    if (BACK_CHAR.test(answer)) return undefined;
    if (answer === '') continue;
    const phone = normalizePhone(answer, cfg.defaultRegion);
    if (phone !== null) return phone.e164;
    menu.say(t(menu, 'whatsappPhoneInvalid'));
  }
}

/** 'Account already exists' confirm; true = go ahead, false = the user backed out. */
async function confirmRelogin(menu: Menu, logged: Map<App, string[]>, app: App, account: string): Promise<boolean> {
  if (!(logged.get(app) ?? []).includes(account)) return true;
  menu.say(t(menu, 'accountExists', { account, app }));
  return confirm(menu, t(menu, 'loginAgainConfirm'), false);
}

/** Which app to log in to: an arrow-key list on a rich terminal, else the numbered list and prompt. `undefined` = the user went back. */
async function chooseLoginApp(menu: Menu, logged: Map<App, string[]>): Promise<App | undefined> {
  const { host, say } = menu;
  if (canSelect(host.io, menu.ui)) {
    const rows = APPS.map((app, index): SelectItem<App> => ({
      value: app,
      label: `${app}: ${appStatusText(menu, logged.get(app))}`,
      key: String(index + 1),
    }));
    return pickRow(menu, t(menu, 'loginPickApp'), rows, 'hintBack');
  }
  say(t(menu, 'loginAppsHeader'));
  APPS.forEach((app, index) => say(appStatusLine(menu, app, index, logged.get(app))));
  for (;;) {
    const answer = (await askVisible(t(menu, 'loginAppPrompt', { max: APPS.length }), host.io)).trim().toLowerCase();
    if (answer === '') return undefined;
    if (BACK_CHAR.test(answer)) return undefined;
    const picked = /^\d+$/.test(answer) ? APPS[Number(answer) - 1] : APPS.find((candidate) => candidate === answer);
    if (picked !== undefined) return picked;
    say(t(menu, 'loginUnknown', { input: shown(answer), max: APPS.length }));
  }
}

async function loginApp(menu: Menu): Promise<void> {
  const cfg = configOrReport(menu);
  if (cfg === undefined) return;
  const logged = loggedInApps(cfg);
  const app = await chooseLoginApp(menu, logged);
  if (app === undefined) return;
  await loginFlow(menu, cfg, app, logged);
}

/**
 * The steps of one login after the app is known. `presetAccount` (the accounts list's Enter/l) skips
 * the name question. Telegram keeps its three-step shape — the account name is asked inside step 1 —
 * the other apps use two steps (name, then link).
 */
async function loginFlow(menu: Menu, cfg: Config, app: App, logged: Map<App, string[]>, presetAccount?: string): Promise<void> {
  const { host, say } = menu;
  const choice: string[] = [];
  let hint: MessageKey | undefined = LOGIN_HINTS[app];
  let account = presetAccount;

  if (app === 'telegram') {
    const keysFound = telegramKeysSaved(menu, cfg);
    say();
    say(menu.ui.bold(t(menu, 'tgLoginTitle')));
    if (keysFound) {
      say(`${menu.ui.green(menu.ui.icons.ok)} ${t(menu, 'tgKeysFound')}`);
    } else {
      stepHeader(menu, 1, 3, 'tgStepKeys');
      say(t(menu, 'telegramIntro'));
      say(`  ${t(menu, 'telegramStep1')}`);
      say(`  ${t(menu, 'telegramStep2')}`);
      say(`  ${t(menu, 'tgFormFields')}`);
      say(`  ${t(menu, 'tgWhyKeys')}`);
      await offerBrowser(menu);
    }
    account ??= await askAccountName(menu);
    if (account === undefined) return;
    if (!(await confirmRelogin(menu, logged, app, account))) return;
    if (!keysFound && !(await telegramKeysAsked(menu))) return;
    stepHeader(menu, 3, 3, 'tgStepSignIn');
    const method = await chooseLoginMethod(menu, ['telegramMethodIntro', 'telegramMethodQr', 'telegramMethodCode']);
    if (method === undefined) return;
    let picked: LoginMethod = method;
    if (method === 'qr') {
      const gate = await qrGate(menu, app, 'qrGateAltTelegram');
      if (gate === 'back') return;
      if (gate === 'alt') picked = 'code';
    }
    choice.push('--method', picked);
    hint = picked === 'qr' ? 'hintTelegramQr' : 'hintTelegram';
  } else {
    if (account === undefined) {
      stepHeader(menu, 1, 2, 'loginStepAccount');
      account = await askAccountName(menu);
      if (account === undefined) return;
    }
    if (!(await confirmRelogin(menu, logged, app, account))) return;
    stepHeader(menu, 2, 2, 'loginStepLink');
    if (app === 'whatsapp') {
      // The pairing code is first and the default: it linked a real phone on the first try, while a QR link only completes when
      // WhatsApp accepts the re-drawn code after a scan (see the adapter), which has not been confirmed on a phone yet.
      const qrNeed = qrWindowNeed(QR_MAX_MODULES.whatsapp, qrStreamFor(menu), host.env);
      const method = await chooseLoginMethod(menu, ['whatsappMethodIntro', 'whatsappMethodCode', 'whatsappMethodQr'], ['code', 'qr'], {
        whatsappMethodCode: t(menu, 'whatsappMethodCodeDetail'),
        whatsappMethodQr: t(menu, 'whatsappMethodQrDetail', { need: `${qrNeed.columns} x ${qrNeed.rows}` }),
      });
      if (method === undefined) return;
      let phone: string | undefined;
      if (method === 'qr') {
        const gate = await qrGate(menu, app, 'qrGateAltWhatsapp');
        if (gate === 'back') return;
        if (gate === 'ok') choice.push('--method', 'qr');
      }
      if (method === 'code' || (method === 'qr' && choice.length === 0)) {
        phone = await askWhatsappPhone(menu, cfg);
        if (phone === undefined) return;
        choice.push('--method', 'code', '--phone', phone);
      }
      hint = undefined;
    } else if (app === 'zalo' || app === 'line') {
      // QR is the only way in; the gate still names the size needed and lets the user retry or stop.
      if ((await qrGate(menu, app, undefined)) === 'back') return;
    }
  }

  // WhatsApp and Zalo print their own instructions together with the code; Telegram, Viber and LINE need an introduction.
  if (hint !== undefined) say(t(menu, hint));
  const result = await host.run(['login', app, '--account', account, ...choice, '--lang', menu.lang]);
  reportCommandResult(menu, result);
  // A successful login already printed its own "Logged in ..." line (the command does, in the menu's language).
  say(result.code === 0 ? t(menu, 'loginNextStep') : t(menu, 'loginFailed', { app, account }));
}

async function viewReport(menu: Menu): Promise<void> {
  const { host, say } = menu;
  const cfg = configOrReport(menu);
  if (cfg === undefined) return;
  say(t(menu, 'reportIntro'));
  const csv = await pickCsvAndPreview(menu, cfg, menu.last.csv);
  if (csv === undefined) return;
  const out = await askReportPath(menu, csv);
  if (out === undefined) return;
  menu.last = { csv, out };
  recentsFor(menu, cfg)?.add(csv);
  const apps = [...loggedInApps(cfg).keys()];
  const result = await host.run(['report', '--out', out, ...(apps.length > 0 ? ['--apps', apps.join(',')] : []), '--', csv]);
  reportCommandResult(menu, result);
  if (result.code === 0) showReportDone(menu, out, result, false);
}

async function showDoctor(menu: Menu): Promise<void> {
  const result = await menu.host.run(['doctor']);
  reportCommandResult(menu, result);
  if (result.code !== 0) menu.say(t(menu, 'doctorFailHint'));
  await pauseForMenu(menu);
}

const GUIDE = [
  'guideTitle',
  'guideConsent',
  'guideNotFound',
  'guideLine',
  'guideZalo',
  'guideBan',
  'guideEvidence',
  'guideDetails',
] as const satisfies readonly MessageKey[];

/**
 * The guide as paged boxes on a rich terminal — a page never exceeds the window — or as plain lines.
 * `b` stops early; the last page waits for Enter so nothing scrolls away unread.
 */
async function showGuide(menu: Menu): Promise<void> {
  const { ui, say } = menu;
  const [title, ...lines] = GUIDE;
  if (!ui.rich) {
    for (const key of GUIDE) say(t(menu, key));
    await pauseForMenu(menu);
    return;
  }
  const inner = Math.max(12, Math.min(ui.columns - 4, 70));
  const pageRows = Math.max(3, ui.rows - 8);
  const pages: string[][] = [];
  let used = 0;
  for (const key of lines) {
    const item = t(menu, key);
    const height = wrap(item, inner).length;
    if (used > 0 && used + height > pageRows) {
      used = 0;
      pages.push([]);
    }
    if (pages.length === 0) pages.push([]);
    (pages[pages.length - 1] as string[]).push(item);
    used += height;
  }
  for (let n = 0; n < pages.length; n += 1) {
    const pageTitle = pages.length === 1 ? t(menu, title) : t(menu, 'guidePage', { n: n + 1, m: pages.length });
    for (const line of box(ui, pageTitle, pages[n] as string[])) say(line);
    if (n + 1 < pages.length) {
      const answer = (await askVisible(t(menu, 'guideNext'), menu.host.io)).trim();
      if (BACK_CHAR.test(answer)) return;
    }
  }
  await pauseForMenu(menu);
}

/** Switch the menu to `picked` and save the choice when the host can; a failed save keeps it for this session and says so. */
function applyLanguage(menu: Menu, picked: Lang): void {
  const { host, say } = menu;
  menu.lang = picked;
  say(t(menu, 'languageChanged', { language: LANGUAGE_NAMES[picked] }));
  try {
    if (host.saveLanguage === undefined) throw new Error('nowhere to save the language');
    host.saveLanguage(picked);
  } catch {
    say(t(menu, 'languageSaveFailed'));
  }
}

/**
 * Choose a language (each in its own script, current one starred) and switch to it: an arrow-key list on a rich terminal,
 * else a numbered list where a number, code or name works. The choice is saved when the host can; a failed save keeps it
 * for this session and says so, it never ends the menu. Enter on an empty answer (q / Esc / b in the list) goes back.
 */
async function chooseLanguage(menu: Menu): Promise<void> {
  const { host, say } = menu;
  if (canSelect(host.io, menu.ui)) {
    const rows = LANGS.map((code, index): SelectItem<Lang> => ({
      value: code,
      label: `${LANGUAGE_NAMES[code]}${code === menu.lang ? ' *' : ''}`,
      key: String(index + 1),
    }));
    const picked = await pickRow(menu, t(menu, 'languageHeader'), rows, 'hintBack', LANGS.indexOf(menu.lang));
    if (picked !== undefined) applyLanguage(menu, picked);
    return;
  }
  say(t(menu, 'languageHeader'));
  LANGS.forEach((code, index) => say(`  ${index + 1}. ${LANGUAGE_NAMES[code]}${code === menu.lang ? ' *' : ''}`));
  for (;;) {
    const answer = (await askVisible(t(menu, 'languagePrompt', { max: LANGS.length }), host.io)).trim();
    if (answer === '') return;
    const picked =
      (/^\d+$/.test(answer) ? LANGS[Number(answer) - 1] : undefined) ??
      parseLang(answer) ??
      LANGS.find((code) => LANGUAGE_NAMES[code].toLowerCase() === answer.toLowerCase());
    if (picked === undefined) {
      say(t(menu, 'languageUnknown', { input: shown(answer) }));
      continue;
    }
    applyLanguage(menu, picked);
    return;
  }
}

/** The numbered entries of the main menu (plain terminals and rich terminals without raw mode). */
function showMenuRows(menu: Menu): void {
  menu.say(`  1. ${t(menu, 'menuCheck')}`);
  menu.say(`  2. ${t(menu, 'menuLogin')}`);
  menu.say(`  3. ${t(menu, 'menuAccounts')}`);
  menu.say(`  4. ${t(menu, 'menuReport')}`);
  menu.say(`  5. ${t(menu, 'menuDoctor')}`);
  menu.say(`  6. ${t(menu, 'menuGuide')}`);
  // Not translated on purpose: it must stay findable whatever language the menu is stuck in.
  menu.say(`  L. ${LANGUAGE_LABEL}: ${LANGUAGE_NAMES[menu.lang]}`);
  menu.say(`  0. ${t(menu, 'menuQuit')}`);
}

/** The plain-tier menu: title line, the accounts status (same facts as the banner strip), the numbered rows. */
function showMenu(menu: Menu): void {
  menu.say();
  menu.say(`=== ${APP_TITLE} ${menu.host.version} ===`);
  let logged: Map<App, string[]> | undefined;
  try {
    logged = loggedInApps(menu.host.loadConfig());
  } catch {
    // A broken config is reported by the actions that need it; the status line is just absent.
  }
  if (logged !== undefined) {
    menu.say(`${t(menu, 'bannerAccounts')} ${statusStrip(menu.ui, menu.lang, logged).join(' · ')}`);
  }
  showMenuRows(menu);
}

/** The main menu as an arrow-key list: each row has the key that picks it at once (1-6, L, 0). */
function menuItems(menu: Menu): SelectItem<string>[] {
  const row = (value: string, key: string, label: string): SelectItem<string> => ({ value, key, label });
  return [
    row('1', '1', t(menu, 'menuCheck')),
    row('2', '2', t(menu, 'menuLogin')),
    row('3', '3', t(menu, 'menuAccounts')),
    row('4', '4', t(menu, 'menuReport')),
    row('5', '5', t(menu, 'menuDoctor')),
    row('6', '6', t(menu, 'menuGuide')),
    // Not translated on purpose: it must stay findable whatever language the menu is stuck in.
    row('l', 'L', `${LANGUAGE_LABEL}: ${LANGUAGE_NAMES[menu.lang]}`),
    row('0', '0', t(menu, 'menuQuit')),
  ];
}

/**
 * One main-menu choice, as the text the switch below understands. A rich terminal shows the banner (name, version, which
 * apps have accounts) and an arrow-key list (q / Esc / b quit) — dropped for a plain status strip under 20 rows and for
 * the numbered list under 12; anything else gets the numbered list and prompt.
 */
async function readChoice(menu: Menu): Promise<string> {
  const { host, ui } = menu;
  if (ui.rich) {
    menu.say();
    let logged: Map<App, string[]> | undefined;
    try {
      logged = loggedInApps(host.loadConfig());
    } catch {
      // A broken config is reported by the actions that need it; the banner just has no accounts strip.
    }
    if (ui.rows >= 20) {
      for (const line of banner(ui, menu.lang, host.version, logged)) menu.say(line);
    } else if (logged !== undefined) {
      for (const line of statusStrip(ui, menu.lang, logged)) menu.say(`  ${line}`);
    }
    if (canSelect(host.io, ui) && ui.rows >= 12) {
      const result = await selectMenu(host.io, ui, { items: menuItems(menu), hint: t(menu, 'hintMenu') });
      return result.picked ? result.value : '0';
    }
    showMenuRows(menu);
    return (await askVisible(t(menu, 'menuPrompt'), host.io)).trim();
  }
  showMenu(menu);
  return (await askVisible(t(menu, 'menuPrompt'), host.io)).trim();
}

/**
 * `accounts` plus actions on a rich terminal: `r` resets the highlighted account's cooldown through the
 * existing `account-reset` command, `l` starts a fresh login, Enter logs the highlighted account in again.
 */
async function showAccounts(menu: Menu): Promise<void> {
  const { host, say } = menu;
  const cfg = configOrReport(menu);
  if (cfg === undefined) return;
  const logged = loggedInApps(cfg);
  if (logged.size === 0) {
    say(t(menu, 'emptyAccounts'));
    return;
  }
  reportCommandResult(menu, await host.run(['accounts']));
  if (!canSelect(host.io, menu.ui)) {
    await pauseForMenu(menu);
    return;
  }
  const items: SelectItem<{ app: App; name: string }>[] = [];
  for (const [app, names] of logged) {
    for (const name of names) items.push({ value: { app, name }, label: `${app}: ${shown(name)}` });
  }
  for (;;) {
    const result = await selectMenu(host.io, menu.ui, {
      title: t(menu, 'accountsTitle'),
      items,
      hint: t(menu, 'accountsActionHint'),
      actions: [{ key: 'r' }, { key: 'l' }],
    });
    if (!result.picked) {
      const action = result.action;
      if (action === undefined) return;
      const row = items[action.index] as SelectItem<{ app: App; name: string }>;
      if (action.key === 'r') {
        reportCommandResult(menu, await host.run(['account-reset', row.value.app, row.value.name]));
        continue;
      }
      if (action.key === 'l') {
        await loginFlow(menu, cfg, row.value.app, logged);
        return;
      }
      return;
    }
    await loginFlow(menu, cfg, result.value.app, logged, result.value.name);
    return;
  }
}

/**
 * Interactive main menu. Resolves with the process exit code (0) when the user quits or the input
 * ends (Ctrl+C / Ctrl+D). Every action runs a normal CLI command that takes and releases its own
 * lifecycle registration and run lock; the menu holds none between actions. The language comes from
 * `--lang`, then `PHONE_APP_CHECKER_LANG`, then the saved choice, then English.
 */
export async function runMenu(host: MenuHost): Promise<number> {
  const lang = resolveLang({ flag: host.langFlag, env: host.env, stored: host.readLanguage?.() });
  const ui = createUi(host.io.output as typeof host.io.output & UiStream, host.env);
  const menu: Menu = {
    host,
    // Every line goes through wrap(): the plain tier wraps at the window like the rich one (r3 §3.6 item 1).
    say: (text = '') => void host.io.output.write(`${wrap(text, ui.columns - 1).join('\n')}\n`),
    lang,
    last: {},
    ui,
  };
  try {
    for (;;) {
      const choice = await readChoice(menu);
      switch (choice) {
        case '1':
          await checkCsv(menu);
          break;
        case '2':
          await loginApp(menu);
          break;
        case '3':
          await showAccounts(menu);
          break;
        case '4':
          await viewReport(menu);
          break;
        case '5':
          await showDoctor(menu);
          break;
        case '6':
          await showGuide(menu);
          break;
        case 'l':
        case 'L':
          await chooseLanguage(menu);
          break;
        case '0':
          menu.say(t(menu, 'goodbye'));
          return 0;
        case '':
          break;
        default:
          menu.say(t(menu, 'menuInvalid', { choice: shown(choice) }));
      }
    }
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    menu.say();
    menu.say(t(menu, 'goodbye'));
    return 0;
  }
}
