import { translate, type Lang } from './i18n/index.ts';
import { APPS, terminalSafe, type App } from './types.ts';
import { box, displayWidth, strip, truncatePath, type BoxLine, type Ui } from './ui.ts';

export const APP_TITLE = 'Phone App Checker';

/** Widest a box is; kept in step with `box` in ui.ts (rules are at most 72 columns, 2 of them the bar). */
const BOX_INNER_MAX = 70;

/** `✔ whatsapp 1 account · ○ telegram none`: one entry per app, icon + word, ready (with the count) or not set up. */
export function statusStrip(ui: Ui, lang: Lang, logged: ReadonlyMap<App, readonly string[]>): string[] {
  return strip(
    ui,
    APPS.map((app) => {
      const count = logged.get(app)?.length ?? 0;
      return count > 0
        ? `${ui.icons.ready} ${app} ${translate(lang, 'accountsWord', { count })}`
        : `${ui.icons.empty} ${app} ${translate(lang, 'accountsNone')}`;
    }),
  );
}

/** The header banner of the main menu: app name and version, then the accounts-ready strip. */
export function banner(ui: Ui, lang: Lang, version: string, logged: ReadonlyMap<App, readonly string[]> | undefined): string[] {
  const body: (string | BoxLine)[] = [];
  if (logged !== undefined) {
    body.push({ text: translate(lang, 'bannerAccounts'), paint: ui.dim }, ...statusStrip(ui, lang, logged));
  }
  return box(ui, `${APP_TITLE} ${terminalSafe(version, 40)}`, body, 'info');
}

/** `'path'` made safe to paste after a command in a shell. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export interface ReportBoxOptions {
  /** Absolute path of the report (made terminal-safe here). */
  path: string;
  /** Numbers still without a fresh answer; > 0 turns the box into an INCOMPLETE warning. */
  inconclusive?: number;
}

/**
 * The closing box of a check: `Report saved to <path>` (a long path is cut from the left), what to do next
 * (Excel / Numbers, `open -R` to reveal it in Finder) and, when the run left work undone, a prominent INCOMPLETE warning.
 */
export function reportBox(ui: Ui, lang: Lang, options: ReportBoxOptions): string[] {
  const path = terminalSafe(options.path, 1024);
  const inner = Math.max(20, Math.min(ui.columns - 1, BOX_INNER_MAX + 2) - 2);
  const room = (text: string): number => Math.max(8, inner - displayWidth(text));
  const title = translate(lang, 'reportSavedTo', {
    path: truncatePath(path, room(translate(lang, 'reportSavedTo', { path: '' })) - 4, ui.icons.ellipsis),
  });
  const commandPrefix = 'open -R ';
  const finderProbe = translate(lang, 'finalNextFinder', { command: commandPrefix });
  const command = `${commandPrefix}${shellQuote(truncatePath(path, room(finderProbe) - commandPrefix.length - 2, ui.icons.ellipsis))}`;
  const lines: (string | BoxLine)[] = [];
  const incomplete = options.inconclusive ?? 0;
  if (incomplete > 0) {
    const warn = (text: string): BoxLine => ({ text, paint: (part) => ui.red(ui.bold(part)) });
    lines.push(warn(`${ui.icons.warn} ${translate(lang, 'finalIncomplete', { count: incomplete })}`), warn(translate(lang, 'finalIncompleteNext')), '');
  }
  lines.push(translate(lang, 'finalNextOpen'), translate(lang, 'finalNextFinder', { command }));
  return box(ui, title, lines, incomplete > 0 ? 'warn' : 'ok');
}
