import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTelegramCredentials } from './adapters/telegram-credentials.ts';
import { assertAccountName, listAccountNames, type Config } from './config.ts';
import { parseTelegramApiHash, parseTelegramApiId } from './config-write.ts';
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
import { banner, reportBox } from './screens.ts';
import { canSelect, selectMenu, type SelectItem } from './select.ts';
import { APPS, terminalSafe, type App, type LoginMethod } from './types.ts';
import { box, createUi, wrap, type Ui, type UiStream } from './ui.ts';

/** Longest user-supplied text (code points) echoed back to the terminal. */
const SHOWN_MAX = 512;
const DEFAULT_REPORT_NAME = 'report.csv';
const DEFAULT_ACCOUNT = 'default';

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
  let text = raw.replace(/\u001b\[20[01]~/g, '').trim();
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

/** Ask for the input CSV until it is a readable file; `undefined` when the user presses Enter on an empty answer. */
async function askCsvPath(menu: Menu, fallback?: string): Promise<string | undefined> {
  const { host, say } = menu;
  say(t(menu, 'askCsvIntro'));
  for (;;) {
    const hint = fallback === undefined ? t(menu, 'askCsvHintBack') : t(menu, 'askCsvHintDefault', { path: shown(fallback) });
    const answer = await askVisible(t(menu, 'askCsvPrompt', { hint }), host.io);
    const path = normalizeDroppedPath(answer, host.homeDir, host.cwd) ?? fallback;
    if (path === undefined) return undefined;
    const problem = inputProblem(menu, path);
    if (problem === undefined) return path;
    say(problem);
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
  const answer = await askVisible(t(menu, 'askReportPrompt', { path: shown(fallback) }), host.io);
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

async function chooseApps(menu: Menu, available: readonly App[]): Promise<App[]> {
  if (available.length === 1) return [...available];
  menu.say(t(menu, 'appsLoggedInHeader'));
  available.forEach((app, index) => menu.say(`  ${index + 1}. ${app}`));
  for (;;) {
    const answer = await askVisible(t(menu, 'appsChoosePrompt'), menu.host.io);
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
  const csv = await askCsvPath(menu);
  if (csv === undefined) return;
  const apps = await chooseApps(menu, [...logged.keys()]);
  const out = await askReportPath(menu, csv);
  if (out === undefined) return;
  menu.last = { csv, out };

  say(t(menu, 'checkStarting', { apps: apps.join(', ') }));
  const result = await host.run(['check', '--out', out, '--apps', apps.join(','), '--', csv]);
  reportCommandResult(menu, result);
  if (result.code === 0) {
    showReportDone(menu, out, result, true);
  } else if (result.code === 130) {
    printReportBox(menu, out, result);
    say(t(menu, 'checkInterrupted', { path: shown(out) }));
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

const TELEGRAM_STEPS = ['tgStepKeys', 'tgStepSave', 'tgStepSignIn'] as const satisfies readonly MessageKey[];
/** Empty answer or "b": go back. */
const BACK_ANSWER = /^(b|)$/i;

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

/** Shown before anything is asked: the three steps, and why the QR code only comes after the keys are saved. */
function telegramOverview(menu: Menu, keysFound: boolean): void {
  const { ui } = menu;
  menu.say();
  TELEGRAM_STEPS.forEach((key, index) => {
    const marker = keysFound && index < 2 ? `${ui.green(ui.icons.ok)} ` : '';
    menu.say(`  ${marker}${t(menu, 'stepLabel', { n: index + 1, m: 3 })} - ${t(menu, key)}`);
  });
  menu.say(keysFound ? `${ui.green(ui.icons.ok)} ${t(menu, 'tgKeysFound')}` : t(menu, 'tgWhyKeys'));
}

/** Offer to open the Telegram API page in the browser; only on a terminal, only after a yes, only that one fixed address. */
async function offerBrowser(menu: Menu): Promise<void> {
  const { host } = menu;
  if (host.openUrl === undefined || !isInteractive(host.io)) return;
  if (!(await confirm(menu, t(menu, 'tgOpenPrompt'), true))) return;
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
 * Steps 1 and 2 of the Telegram login, when the api_id / api_hash are not known yet: explain how to get them (and offer to
 * open the page), then ask for them here: the api_id as digits, the api_hash hidden (a mask character per typed
 * character, never the value), then save them in the config file. True when login may go ahead; Enter or `b` goes back.
 */
async function telegramCredentialsReady(menu: Menu, keysFound: boolean): Promise<boolean> {
  if (keysFound) return true;
  stepHeader(menu, 1, 3, 'tgStepKeys');
  for (const key of ['telegramIntro', 'telegramStep1', 'telegramStep2', 'tgFormFields'] as const) {
    menu.say(key === 'telegramIntro' ? t(menu, key) : `  ${t(menu, key)}`);
  }
  await offerBrowser(menu);
  menu.say(t(menu, 'tgBackHint'));
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

/** What to tell the user before a login that does not explain itself on screen. */
const LOGIN_HINTS: Partial<Record<App, MessageKey>> = {
  telegram: 'hintTelegram',
  viber: 'hintViber',
  line: 'hintLine',
};

async function askAccountName(menu: Menu): Promise<string> {
  for (;;) {
    const answer = (await askVisible(t(menu, 'askAccountPrompt', { name: DEFAULT_ACCOUNT }), menu.host.io)).trim();
    const name = answer === '' ? DEFAULT_ACCOUNT : answer;
    try {
      assertAccountName(name);
      return name;
    } catch {
      menu.say(t(menu, 'accountNameInvalid'));
    }
  }
}

/** Arrow-key list on a rich terminal: the chosen value, or `undefined` when the user backs out (q / Esc). Only call when `canSelect`. */
async function pickRow<V>(menu: Menu, title: string | undefined, items: SelectItem<V>[], hint: 'hintMenu' | 'hintBack', initial = 0): Promise<V | undefined> {
  const result = await selectMenu(menu.host.io, menu.ui, { ...(title === undefined ? {} : { title }), items, hint: t(menu, hint), initial });
  return result.picked ? result.value : undefined;
}

/**
 * Two ways to log in (`order` says which method is first); the numbered prompt, where Enter = option 1, or an arrow-key list
 * on a rich terminal, where backing out gives `undefined`.
 */
async function chooseLoginMethod(
  menu: Menu,
  lines: readonly [MessageKey, MessageKey, MessageKey],
  order: readonly [LoginMethod, LoginMethod] = ['qr', 'code'],
): Promise<LoginMethod | undefined> {
  if (canSelect(menu.host.io, menu.ui)) {
    const rows = [lines[1], lines[2]].map((key, index): SelectItem<LoginMethod> => ({
      value: order[index] ?? order[0],
      label: t(menu, key).replace(/^\d\)\s*/, ''),
      key: String(index + 1),
    }));
    return pickRow(menu, t(menu, lines[0]), rows, 'hintBack');
  }
  menu.say(t(menu, lines[0]));
  menu.say(`  ${t(menu, lines[1])}`);
  menu.say(`  ${t(menu, lines[2])}`);
  for (;;) {
    const answer = (await askVisible(t(menu, 'loginMethodPrompt', { max: 2 }), menu.host.io)).trim();
    if (answer === '') return order[0];
    if (answer === '1' || answer === '2') return order[Number(answer) - 1] ?? order[0];
    menu.say(t(menu, 'loginMethodInvalid', { max: 2 }));
  }
}

/** WhatsApp's pairing code needs the number of the account being linked; undefined = the user went back. */
async function askWhatsappPhone(menu: Menu, cfg: Config): Promise<string | undefined> {
  for (;;) {
    const answer = (await askVisible(t(menu, 'whatsappPhonePrompt'), menu.host.io)).trim();
    if (answer === '') return undefined;
    const phone = normalizePhone(answer, cfg.defaultRegion);
    if (phone !== null) return phone.e164;
    menu.say(t(menu, 'whatsappPhoneInvalid'));
  }
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
    const picked = /^\d+$/.test(answer) ? APPS[Number(answer) - 1] : APPS.find((candidate) => candidate === answer);
    if (picked !== undefined) return picked;
    say(t(menu, 'loginUnknown', { input: shown(answer), max: APPS.length }));
  }
}

async function loginApp(menu: Menu): Promise<void> {
  const { host, say } = menu;
  const cfg = configOrReport(menu);
  if (cfg === undefined) return;
  const logged = loggedInApps(cfg);
  const app = await chooseLoginApp(menu, logged);
  if (app === undefined) return;
  // Telegram shows its three steps (and why the keys come first) before anything is asked; the other apps have two.
  const telegram = app === 'telegram';
  const keysFound = telegram && telegramKeysSaved(menu, cfg);
  if (telegram) telegramOverview(menu, keysFound);
  else stepHeader(menu, 1, 2, 'loginStepAccount');
  const account = await askAccountName(menu);
  if ((logged.get(app) ?? []).includes(account)) {
    say(t(menu, 'accountExists', { account, app }));
    if (!(await confirm(menu, t(menu, 'loginAgainConfirm'), false))) return;
  }
  if (!telegram) stepHeader(menu, 2, 2, 'loginStepLink');

  // Apps with more than one way to log in: ask how, and collect what that way needs, before anything runs.
  const choice: string[] = [];
  let hint: MessageKey | undefined = LOGIN_HINTS[app];
  if (app === 'whatsapp') {
    // The pairing code is first and the default: it linked a real phone on the first try, while a QR link only completes when
    // WhatsApp accepts the re-drawn code after a scan (see the adapter), which has not been confirmed on a phone yet.
    const method = await chooseLoginMethod(menu, ['whatsappMethodIntro', 'whatsappMethodCode', 'whatsappMethodQr'], ['code', 'qr']);
    if (method === undefined) return;
    if (method === 'code') {
      const phone = await askWhatsappPhone(menu, cfg);
      if (phone === undefined) return;
      choice.push('--method', 'code', '--phone', phone);
      hint = undefined;
    } else {
      choice.push('--method', 'qr');
    }
  } else if (telegram) {
    if (!(await telegramCredentialsReady(menu, keysFound))) return;
    stepHeader(menu, 3, 3, 'tgStepSignIn');
    const method = await chooseLoginMethod(menu, ['telegramMethodIntro', 'telegramMethodQr', 'telegramMethodCode']);
    if (method === undefined) return;
    choice.push('--method', method);
    hint = method === 'qr' ? 'hintTelegramQr' : 'hintTelegram';
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
  const csv = await askCsvPath(menu, menu.last.csv);
  if (csv === undefined) return;
  const out = await askReportPath(menu, csv);
  if (out === undefined) return;
  menu.last = { csv, out };
  const apps = [...loggedInApps(cfg).keys()];
  const result = await host.run(['report', '--out', out, ...(apps.length > 0 ? ['--apps', apps.join(',')] : []), '--', csv]);
  reportCommandResult(menu, result);
  if (result.code === 0) showReportDone(menu, out, result, false);
}

async function showDoctor(menu: Menu): Promise<void> {
  const result = await menu.host.run(['doctor']);
  reportCommandResult(menu, result);
  if (result.code !== 0) menu.say(t(menu, 'doctorFailHint'));
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
 * for this session and says so, it never ends the menu. Enter on an empty answer (q / Esc in the list) goes back.
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

function showMenu(menu: Menu): void {
  menu.say();
  menu.say(`=== Phone App Checker ${menu.host.version} ===`);
  showMenuRows(menu);
}

const MENU_ICONS: Record<string, string> = { '1': '🔍', '2': '🔑', '3': '👤', '4': '📄', '5': '🩺', '6': '📖', l: '🌐', '0': '🚪' };

/** The main menu as an arrow-key list: each row has the key that picks it at once (1-6, L, 0). */
function menuItems(menu: Menu): SelectItem<string>[] {
  const row = (value: string, key: string, label: string): SelectItem<string> => ({ value, key, label: `${MENU_ICONS[value]} ${label}` });
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
 * apps have accounts) and an arrow-key list (q / Esc quit); anything else gets the numbered list and prompt.
 */
async function readChoice(menu: Menu): Promise<string> {
  const { host, ui } = menu;
  if (!ui.rich) {
    showMenu(menu);
    return (await askVisible(t(menu, 'menuPrompt'), host.io)).trim();
  }
  menu.say();
  let logged: Map<App, string[]> | undefined;
  try {
    logged = loggedInApps(host.loadConfig());
  } catch {
    // A broken config is reported by the actions that need it; the banner just has no accounts strip.
  }
  for (const line of banner(ui, menu.lang, host.version, logged)) menu.say(line);
  if (canSelect(host.io, ui)) {
    const result = await selectMenu(host.io, ui, { items: menuItems(menu), hint: t(menu, 'hintMenu') });
    return result.picked ? result.value : '0';
  }
  showMenuRows(menu);
  return (await askVisible(t(menu, 'menuPrompt'), host.io)).trim();
}

/** `accounts`; on a rich terminal with nobody logged in, a friendly hint instead of the bare command message. */
async function showAccounts(menu: Menu): Promise<void> {
  if (menu.ui.rich) {
    const cfg = configOrReport(menu);
    if (cfg === undefined) return;
    if (loggedInApps(cfg).size === 0) {
      menu.say(t(menu, 'emptyAccounts'));
      return;
    }
  }
  reportCommandResult(menu, await menu.host.run(['accounts']));
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
    say: (text = '') => void host.io.output.write(`${ui.rich ? wrap(text, ui.columns - 1).join('\n') : text}\n`),
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
          if (menu.ui.rich) {
            const [title, ...lines] = GUIDE;
            for (const line of box(menu.ui, t(menu, title), lines.map((key) => t(menu, key)))) menu.say(line);
          } else {
            for (const key of GUIDE) menu.say(t(menu, key));
          }
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
