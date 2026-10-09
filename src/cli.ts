import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadAdapter as defaultLoadAdapter } from './adapters/index.ts';
import { listDevices } from './android/adb.ts';
import {
  accountDirPath,
  assertAccountName,
  configFilePath,
  ensureAccountDir,
  HOME_ENV,
  listAccountNames,
  loadConfig,
  type Config,
} from './config.ts';
import { saveTelegramCredentials } from './config-write.ts';
import { formatDoctor, runDoctor } from './doctor.ts';
import { bootstrapHome, ensureHomeDirectory, packageVersion } from './home.ts';
import { LANG_ENV, resolveLang, translate, type Lang } from './i18n/index.ts';
import { LANG_FILE, readLanguageFile, writeLanguageFile } from './i18n/store.ts';
import { readPhoneCsv, safeLabel, type ParsedInput } from './csv.ts';
import { acquireLifecycleShared, acquireRunLock, lifecycleDir, type RunLock } from './lock.ts';
import { isInteractive, runMenu, type CommandResult, type MenuHost } from './menu.ts';
import { openUrl } from './open-url.ts';
import { ProgressRenderer } from './progress.ts';
import type { PromptIo } from './prompt.ts';
import { reportBox } from './screens.ts';
import { createUi, PLAIN_UI, type DrawStream, type UiStream } from './ui.ts';
import {
  buildReport,
  checkReportTarget,
  formatSummary,
  summarize,
  writeReport,
  type ReportFreshness,
  type ReportTarget,
} from './report.ts';
import { plural } from './plural.ts';
import { describeRun, runChecks, type SchedulerOptions } from './scheduler.ts';
import { ensureDataDirectory, localDay, Store } from './store.ts';
import { APPS, redactPhones, terminalSafe, type Adapter, type App, type LoginMethod } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest path (code points) echoed to the terminal; longer ones are cut with "...". */
const DISPLAY_PATH_MAX = 512;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Injection points for tests; production uses the defaults. */
export interface CliDeps {
  loadAdapter?: (app: App) => Promise<Adapter>;
  /** Package-resolution probe `doctor` uses by default (production default: resolve each adapter's package). */
  resolveAdapter?: (app: App) => void;
  now?: () => number;
  sleep?: SchedulerOptions['sleep'];
  random?: () => number;
  /** Progress and warnings (default: stderr). */
  log?: (message: string) => void;
  /** Tables and summaries (default: stdout). */
  print?: (text: string) => void;
  /** Process exit used on forced shutdown (default: process.exit). */
  exit?: (code: number) => void;
  /** Environment (default: process.env); `PHONE_APP_CHECKER_HOME` switches to release mode. */
  env?: NodeJS.ProcessEnv;
  /** `adb devices` used by `doctor` (default: the real adb). */
  listDevices?: typeof listDevices;
  /** Directory of the install/uninstall exclusion protocol (default: derived from `$HOME`, as the scripts do). */
  lifecycleDir?: string;
  /** Terminal the menu talks to when no arguments are given (default: process.stdin / process.stdout). */
  terminal?: PromptIo;
  /**
   * Do not print the "First run: created ..." notice (it points at the `doctor` command, which is for command-line users);
   * the menu sets it for the commands it runs.
   */
  quietFirstRun?: boolean;
  /** Terminal the progress bar, spinner and colours are drawn on (default: stderr, when `log` is not injected). */
  display?: UiStream & DrawStream;
  /** Terminal the result tables are coloured for (default: stdout, when `print` is not injected). */
  printDisplay?: UiStream;
  /** Called each time a command has written a report. */
  onReport?: (info: { path: string; inconclusive: number }) => void;
  /** The commands run from the menu: it draws its own closing box, so the command does not. */
  embedded?: boolean;
}

interface GlobalOptions {
  config?: string;
}

interface ReportOptions {
  out: string;
  apps?: string;
  column?: string;
  force?: boolean;
  maxAge?: number;
}

interface CheckOptions extends ReportOptions {
  wait: boolean;
  progress: 'auto' | 'lines' | 'off';
}

function validCount(input: ParsedInput): number {
  return input.entries.filter((entry) => entry.phone !== null).length;
}

function noValidNumbersMessage(input: ParsedInput): string {
  return `no valid phone numbers (${input.entries.length - validCount(input)} invalid); check --column and the file's phone column and country codes`;
}

function parseNonNegative(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < 0) throw new InvalidArgumentError('must be a number >= 0');
  return n;
}

function parseLoginMethod(value: string): LoginMethod {
  const method = value.trim().toLowerCase();
  if (method !== 'qr' && method !== 'code') throw new InvalidArgumentError('must be "qr" or "code"');
  return method;
}

export function parseApp(value: string): App {
  const app = value.trim().toLowerCase();
  if (!(APPS as readonly string[]).includes(app)) {
    throw new Error(`Unknown app "${value}". Choose one of: ${APPS.join(', ')}`);
  }
  return app as App;
}

/** `--apps a,b` -> validated list; defaults to the apps enabled in the config. */
export function resolveApps(config: Config, flag: string | undefined): App[] {
  if (flag !== undefined) {
    const apps = [...new Set(flag.split(',').filter((part) => part.trim() !== '').map(parseApp))];
    if (apps.length === 0) throw new Error('--apps needs at least one app');
    return apps;
  }
  const apps = APPS.filter((app) => config.apps[app].enabled);
  if (apps.length === 0) throw new Error('No apps are enabled. Enable some in checker.config.json or pass --apps.');
  return apps;
}

/**
 * Validate and harden `dataDir` (it holds the lock file), then take the exclusive run lock in it.
 * Everything that touches accounts or sessions holds this lock, so none of them can race.
 */
function lockDataDir(dataDir: string): RunLock {
  ensureDataDirectory(dataDir);
  return acquireRunLock(dataDir);
}

/** `lockDataDir`, then open the database: nothing opens (or creates) the database before it holds the lock. */
function openLockedStore(dataDir: string): { store: Store; lock: RunLock } {
  const lock = lockDataDir(dataDir);
  try {
    return { store: Store.open(dataDir), lock };
  } catch (error) {
    lock.release();
    throw error;
  }
}

export function createProgram(deps: CliDeps = {}): Command {
  const loadAdapter = deps.loadAdapter ?? defaultLoadAdapter;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.error(message));
  const print = deps.print ?? ((text: string) => console.log(text));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const env = deps.env ?? process.env;
  const adbDevices = deps.listDevices ?? listDevices;
  // Colour, the progress bar and the closing box exist only on a real terminal and only on the default sinks: an injected `log` / `print` stays plain.
  const display = deps.display ?? (deps.log === undefined ? process.stderr : undefined);
  const ui = display === undefined ? PLAIN_UI : createUi(display, env);
  const printUi = deps.printDisplay !== undefined ? createUi(deps.printDisplay, env) : deps.print === undefined ? createUi(process.stdout, env) : PLAIN_UI;

  const program = new Command();
  program
    .name('phone-app-checker')
    .description('Check which messaging apps a list of phone numbers is registered on.')
    .option('--config <path>', 'config file (default: ./checker.config.json, or $PHONE_APP_CHECKER_HOME/checker.config.json when set)')
    .version(packageVersion(), '-V, --version')
    // One error style for everything the command line says: commander's "error: ..." becomes "Error: ...".
    .configureOutput({ outputError: (message, write) => write(message.replace(/^error: /, 'Error: ')) })
    .addHelpText('after', `\nRun with no arguments in a terminal to open an interactive menu: no commands to remember. English by default; press L in the menu to switch language (saved), or set ${LANG_ENV}=<en|vi|id|ms|ko|zh>.`);

  const home = env[HOME_ENV] || undefined;

  /**
   * Every command that can touch the app home, the config or the data holds a shared lifecycle
   * registration for its whole run (see lock.ts). install.sh / uninstall.sh hold it exclusively, so
   * none of them overlaps a command, whichever home, --config or dataDir the command uses. It is taken
   * before the app home is bootstrapped or any database is opened. The hidden `data-dir` command is
   * exempt: install.sh calls it while it holds the exclusive side.
   */
  const lifecycle = deps.lifecycleDir ?? lifecycleDir(env.HOME || undefined);
  function guarded<A extends unknown[]>(body: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
    return async (...args: A) => {
      const hold = acquireLifecycleShared(lifecycle);
      try {
        await body(...args);
      } finally {
        hold.release();
      }
    };
  }

  /** Release mode: make sure the app home and its config exist before the first config read. */
  function prepareHome(): void {
    if (home !== undefined && program.opts<GlobalOptions>().config === undefined) bootstrapHome(home, deps.quietFirstRun ? () => {} : log);
  }

  const config = () => {
    prepareHome();
    return loadConfig(program.opts<GlobalOptions>().config, home);
  };

  /** A path from the command line or the customer's file system can hold ESC/CR/LF/bidi: print a bounded, control-stripped copy; file operations keep the original. */
  const shownPath = (path: string): string => terminalSafe(path, DISPLAY_PATH_MAX);

  function readInput(csv: string, options: ReportOptions, cfg: Config): ParsedInput {
    const input = readPhoneCsv(csv, { column: options.column, defaultRegion: cfg.defaultRegion });
    // The title comes from the customer's file: print a bounded, control-stripped, digit-masked form only.
    const labelled = input.hasHeader ? `column "${safeLabel(input.column)}"` : `column ${input.column} (no header row)`;
    log(
      `${shownPath(csv)}: using ${labelled}; ${plural(input.rows, 'row')}, ${input.entries.length} unique` +
        (input.duplicates > 0 ? `, ${plural(input.duplicates, 'duplicate')} merged` : '') +
        `, ${input.entries.filter((e) => e.phone === null).length} invalid`,
    );
    return input;
  }

  function emitReport(
    store: Store,
    input: ParsedInput,
    apps: App[],
    out: string,
    target: ReportTarget,
    freshness: ReportFreshness,
  ): void {
    const rows = buildReport(store, input.entries, apps, freshness);
    writeReport(out, rows, target);
    print(formatSummary(summarize(rows), printUi));
    log(`Report written to ${shownPath(resolve(out))}`);
  }

  /** Tell the caller a report was written and, on a terminal, close with the "Report saved to ..." box. */
  function announceReport(path: string, inconclusive: number): void {
    deps.onReport?.({ path, inconclusive });
    if (ui.rich && !deps.embedded) for (const line of reportBox(ui, loginLanguage(undefined), { path, inconclusive })) log(line);
  }

  /** Output safety rules: never the input CSV, never inside the data directory, no silent overwrite. */
  function reportTarget(cfg: Config, csv: string, options: ReportOptions): ReportTarget {
    return { force: options.force, protectedFiles: [csv], protectedDirs: [cfg.dataDir] };
  }

  /** Language of login instructions: `--lang`, then the environment, then the saved menu choice, then English. */
  function loginLanguage(flag: string | undefined): Lang {
    const languageFile = home === undefined ? undefined : join(resolve(home), LANG_FILE);
    return resolveLang({ flag, env, stored: languageFile === undefined ? undefined : readLanguageFile(languageFile) });
  }

  program
    .command('login <app>')
    .description('Log an account in to an app (OTP / QR) and store its session under data/sessions')
    .option('--account <name>', 'account name', 'default')
    .option(
      '--method <method>',
      'how to log in: "qr" (scan a QR code) or "code" (WhatsApp: pairing code, needs --phone, the recommended way; Telegram: phone number + login code). Telegram default: code; WhatsApp default: QR unless apps.whatsapp.options.pairingPhone is set',
      parseLoginMethod,
    )
    .option('--phone <number>', 'WhatsApp pairing code: phone number of the account being linked, with country code (+84901234567)')
    .addOption(new Option('--lang <code>', 'language of the login instructions (en, vi, id, ms, ko, zh)').hideHelp())
    .action(guarded(async (appName: string, options: { account: string; method?: LoginMethod; phone?: string; lang?: string }) => {
      const app = parseApp(appName);
      assertAccountName(options.account);
      const cfg = config();
      // Exclusive with `check`, `account-reset` and other logins: a second session on the same account
      // (or a re-pair under a running check) would get it logged out or banned. The data directory is
      // validated and hardened first (lock file and session directories live in it).
      const lock = lockDataDir(cfg.dataDir);
      try {
        const adapter = await loadAdapter(app);
        const accountDir = accountDirPath(cfg, app, options.account);
        const isNew = !existsSync(accountDir);
        ensureAccountDir(cfg, app, options.account);
        // A half-created directory would otherwise show up as an account that cannot open.
        const discardNewDir = () => {
          if (isNew) rmSync(accountDir, { recursive: true, force: true });
        };
        const onInterrupt = () => {
          discardNewDir();
          log('Login interrupted; nothing was saved.');
          lock.release();
          exit(130);
        };
        for (const signal of STOP_SIGNALS) process.on(signal, onInterrupt);
        try {
          await adapter.login({
            app,
            account: options.account,
            accountDir,
            pacing: cfg.apps[app],
            options: cfg.apps[app].options,
            // Login output carries no customer numbers but does carry QR codes, URLs and pairing
            // codes the operator must read verbatim, so it is deliberately not phone-redacted.
            log,
            lang: loginLanguage(options.lang),
            loginChoice: { method: options.method, phone: options.phone },
          });
        } catch (error) {
          discardNewDir();
          throw error;
        } finally {
          for (const signal of STOP_SIGNALS) process.off(signal, onInterrupt);
        }
        // Account state is touched only after a successful login.
        const store = Store.open(cfg.dataDir);
        try {
          store.resetAccount(app, options.account);
        } finally {
          store.close();
        }
        log(translate(loginLanguage(options.lang), 'loginDone', { app, account: options.account }));
      } finally {
        lock.release();
      }
    }));

  program
    .command('check <csv>')
    .description('Check every number in the CSV and write the report (resumable; results are cached)')
    .option('--out <file>', 'report file', 'report.csv')
    .option('--force', 'overwrite --out even when it exists and is not a report written by this tool')
    .option('--apps <list>', `comma-separated apps to check (${APPS.join(',')}); default: enabled apps in config`)
    .option('--column <name|index>', 'phone column header or 1-based index (default: auto-detect)')
    .option('--max-age <days>', 'reuse yes/not_found results younger than this (default: config maxAgeDays)', parseNonNegative)
    .option('--no-wait', 'stop instead of sleeping when every account is cooling down or at its daily cap')
    .addOption(
      new Option('--progress <mode>', 'progress display: auto (a bar on a terminal, nothing extra otherwise), lines (plain progress lines, for logs) or off')
        .choices(['auto', 'lines', 'off'])
        .default('auto'),
    )
    .action(guarded(async (csv: string, options: CheckOptions) => {
      const cfg = config();
      const target = reportTarget(cfg, csv, options);
      checkReportTarget(options.out, target);
      const apps = resolveApps(cfg, options.apps);
      const input = readInput(csv, options, cfg);
      if (validCount(input) === 0) throw new Error(noValidNumbersMessage(input));
      const maxAgeDays = options.maxAge ?? cfg.maxAgeDays;

      const { store, lock } = openLockedStore(cfg.dataDir);
      const abort = new AbortController();
      const progress =
        options.progress === 'lines'
          ? new ProgressRenderer({ mode: 'lines', ui, stream: { write: () => undefined }, line: log, now })
          : options.progress === 'auto' && ui.rich && display !== undefined
            ? new ProgressRenderer({ mode: 'bar', ui, stream: display, line: log, now })
            : undefined;
      // Log lines (and the interrupt notices) go around the bar, never through it.
      const say = progress?.wrapLog(log) ?? log;
      const onInterrupt = () => {
        if (abort.signal.aborted) {
          say('Second interrupt, exiting now.');
          exit(130);
          return;
        }
        say('Interrupt received: finishing the current batch, then writing the report (Ctrl-C again to force quit)...');
        abort.abort();
      };
      for (const signal of STOP_SIGNALS) process.on(signal, onInterrupt);
      try {
        const numbers = input.entries.flatMap((entry) => (entry.phone ? [entry.phone] : []));
        const summaries = await runChecks({
          store,
          config: cfg,
          numbers,
          apps,
          maxAgeMs: maxAgeDays * DAY_MS,
          wait: options.wait,
          signal: abort.signal,
          loadAdapter,
          listAccounts: (app) => listAccountNames(cfg, app),
          accountDir: (app, name) => accountDirPath(cfg, app, name),
          now,
          sleep: deps.sleep,
          random: deps.random,
          log: say,
          ...(progress === undefined ? {} : { onProgress: (event) => progress.update(event) }),
        });
        progress?.finish();
        const run = describeRun(summaries);
        for (const line of run.lines) log(line);
        emitReport(store, input, apps, options.out, target, { now: now(), maxAgeMs: maxAgeDays * DAY_MS });
        // Exit code is unchanged (0 = the command produced its report); the banner is the warning.
        for (const line of run.banner) log(ui.bold(ui.red(line)));
        announceReport(resolve(options.out), summaries.reduce((total, s) => total + s.inconclusive, 0));
        if (abort.signal.aborted) process.exitCode = 130;
      } finally {
        progress?.finish();
        for (const signal of STOP_SIGNALS) process.off(signal, onInterrupt);
        store.close();
        lock.release();
      }
    }));

  program
    .command('report <csv>')
    .description('Rebuild the report from stored results without checking anything')
    .option('--out <file>', 'report file', 'report.csv')
    .option('--force', 'overwrite --out even when it exists and is not a report written by this tool')
    .option('--apps <list>', `comma-separated apps to include (${APPS.join(',')}); default: enabled apps in config`)
    .option('--column <name|index>', 'phone column header or 1-based index (default: auto-detect)')
    .option('--max-age <days>', 'mark yes/not_found results older than this as stale (default: config maxAgeDays)', parseNonNegative)
    .action(guarded(async (csv: string, options: ReportOptions) => {
      const cfg = config();
      const target = reportTarget(cfg, csv, options);
      checkReportTarget(options.out, target);
      const apps = resolveApps(cfg, options.apps);
      const input = readInput(csv, options, cfg);
      const maxAgeMs = (options.maxAge ?? cfg.maxAgeDays) * DAY_MS;
      const store = Store.open(cfg.dataDir);
      try {
        emitReport(store, input, apps, options.out, target, { now: now(), maxAgeMs });
        announceReport(resolve(options.out), 0);
        // The report is still written (its invalid rows show what went wrong), but an input without a
        // single valid number must not look like a successful report: same failure as `check`.
        if (validCount(input) === 0) {
          log(`WARNING: ${noValidNumbersMessage(input)}. The report above lists only invalid rows.`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    }));

  program
    .command('accounts')
    .description('List accounts with cooldown, ban state and today\'s usage')
    .action(guarded(async () => {
      const cfg = config();
      const store = Store.open(cfg.dataDir);
      try {
        const today = localDay(now());
        const header = ['app', 'account', 'state', 'used today'];
        const lines: string[][] = [];
        const recorded = store.listAccounts();
        for (const app of APPS) {
          const names = new Set([
            ...listAccountNames(cfg, app),
            ...recorded.filter((a) => a.app === app).map((a) => a.name),
          ]);
          for (const name of [...names].sort()) {
            const state = store.getAccount(app, name);
            const used = state.day === today ? state.usedToday : 0;
            let status = 'ready';
            if (state.disabledReason !== null) status = `DISABLED: ${state.disabledReason}`;
            else if (state.cooldownUntil > now()) status = `cooling down until ${new Date(state.cooldownUntil).toLocaleString('sv-SE')}`;
            lines.push([app, name, status, `${used}/${cfg.apps[app].dailyCap}`]);
          }
        }
        if (lines.length === 0) {
          print('No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).');
          return;
        }
        lines.unshift(header);
        const widths = header.map((_, i) => Math.max(...lines.map((row) => (row[i] ?? '').length)));
        print(lines.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n'));
      } finally {
        store.close();
      }
    }));

  program
    .command('account-reset <app> <account>')
    .description('Clear cooldown / disabled flag of an account (today\'s usage is kept)')
    .action(guarded(async (appName: string, account: string) => {
      const app = parseApp(appName);
      assertAccountName(account);
      const cfg = config();
      // Same exclusive lock as `check`/`login`: a reset must not change account state under a running check.
      const { store, lock } = openLockedStore(cfg.dataDir);
      try {
        if (!store.resetAccount(app, account)) {
          log(`No recorded state for ${app} account "${account}"; nothing to reset.`);
          return;
        }
      } finally {
        store.close();
        lock.release();
      }
      log(`Cleared cooldown and disabled flag for ${app} account "${account}".`);
    }));

  program
    .command('doctor')
    .description('Check runtime, config, data directory and adapters; exit 1 when a check reports FAIL')
    .option('--deep', 'load every adapter module as well (default only resolves each adapter package)')
    .action(guarded(async (options: { deep?: boolean }) => {
      const explicit = program.opts<GlobalOptions>().config;
      let setupError: unknown;
      try {
        prepareHome();
      } catch (error) {
        // Reported as a failing `config` check below instead of aborting the whole report.
        setupError = error;
      }
      const configFile = configFilePath(explicit, home);
      const checks = await runDoctor({
        home,
        configFile,
        configExists: existsSync(configFile),
        loadConfig: () => {
          if (setupError !== undefined) throw setupError;
          return loadConfig(explicit, home);
        },
        loadAdapter,
        resolveAdapter: deps.resolveAdapter,
        deep: options.deep === true,
        listDevices: adbDevices,
        env,
      });
      print(formatDoctor(checks));
      if (checks.some((check) => check.level === 'fail')) process.exitCode = 1;
    }));

  // Internal: lets install.sh / uninstall.sh find the run lock the same way every other command does.
  // Reads the config but never creates the app home or the config file.
  program
    .command('data-dir', { hidden: true })
    .description('Print the absolute data directory (internal, used by install.sh and uninstall.sh)')
    .action(() => {
      print(loadConfig(program.opts<GlobalOptions>().config, home).dataDir);
    });

  return program;
}

/** Run one command line; never throws. `error` (terminal-safe) carries the message of a failure. */
async function execute(argv: string[], deps: CliDeps): Promise<{ code: number; error?: string }> {
  try {
    await createProgram(deps).parseAsync(argv, { from: 'node' });
    return { code: process.exitCode === undefined ? 0 : Number(process.exitCode) };
  } catch (error) {
    // Messages can quote customer-controlled text (a CSV title or record): no escape sequences or bidi controls reach the terminal.
    return { code: 1, error: terminalSafe(redactPhones(error instanceof Error ? error.message : String(error)), 4000, true) };
  }
}

/**
 * The menu's view of this CLI: each action is an ordinary command run, so locks and lifecycle registration are per action.
 * `langFlag` is the value of `--lang`. In release mode the language choice lives in the app home; without one
 * (a source checkout) there is nowhere private to keep it, so a choice only lasts for the session.
 */
function menuHost(io: PromptIo, deps: CliDeps, langFlag?: string): MenuHost {
  const env = deps.env ?? process.env;
  const home = env[HOME_ENV] || undefined;
  const lifecycle = deps.lifecycleDir ?? lifecycleDir(env.HOME || undefined);
  const appHome = home === undefined ? undefined : resolve(home);
  const languageFile = appHome === undefined ? undefined : join(appHome, LANG_FILE);
  return {
    io,
    version: packageVersion(),
    cwd: process.cwd(),
    homeDir: homedir(),
    env,
    langFlag,
    loadConfig: () => {
      // Same exclusion as every command that reads the config or creates the app home (see `guarded`).
      const hold = acquireLifecycleShared(lifecycle);
      try {
        if (home !== undefined) bootstrapHome(home, () => {});
        return loadConfig(undefined, home);
      } finally {
        hold.release();
      }
    },
    configFile: () => configFilePath(undefined, home),
    saveTelegramCredentials: (apiId, apiHash) => {
      // Same exclusion and home validation as every other write in the app home.
      const hold = acquireLifecycleShared(lifecycle);
      try {
        if (appHome !== undefined) ensureHomeDirectory(appHome);
        saveTelegramCredentials(configFilePath(undefined, home), apiId, apiHash);
      } finally {
        hold.release();
      }
    },
    ...(appHome === undefined || languageFile === undefined
      ? {}
      : {
          readLanguage: () => readLanguageFile(languageFile),
          saveLanguage: (lang: Lang) => {
            // The app home is validated (never `/`, the user's home, a synced or shared folder, a symlink) before
            // anything is written in it, under the same lifecycle exclusion as every other write there.
            const hold = acquireLifecycleShared(lifecycle);
            try {
              ensureHomeDirectory(appHome);
              writeLanguageFile(languageFile, lang);
            } finally {
              hold.release();
            }
          },
        }),
    openUrl: (url) => openUrl(url),
    run: async (args) => {
      // A previous action's exit code must not leak into this one, nor into the menu's own exit code.
      process.exitCode = undefined;
      let report: CommandResult['report'];
      const result = await execute(['node', 'phone-app-checker', ...args], {
        ...deps,
        quietFirstRun: true,
        embedded: true,
        onReport: (info) => {
          report = info;
          deps.onReport?.(info);
        },
      });
      process.exitCode = undefined;
      return report === undefined ? result : { ...result, report };
    },
  };
}

/**
 * Arguments that still mean "open the menu": none at all, or only the hidden `--lang <code>` /
 * `--lang=<code>` (the language the menu starts in). `undefined` for any other command line.
 */
function menuArguments(args: string[]): { langFlag?: string } | undefined {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--lang' && args[1] !== undefined) return { langFlag: args[1] };
  if (args.length === 1 && args[0]?.startsWith('--lang=')) return { langFlag: args[0].slice('--lang='.length) };
  return undefined;
}

/** Run the CLI; resolves with the process exit code. No arguments (or only `--lang <code>`) on a terminal opens the menu. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const terminal = deps.terminal ?? { input: process.stdin, output: process.stdout };
  const menuArgs = menuArguments(argv.slice(2));
  if (menuArgs !== undefined && isInteractive(terminal)) return runMenu(menuHost(terminal, deps, menuArgs.langFlag));
  const result = await execute(argv, deps);
  if (result.error !== undefined) console.error(`Error: ${result.error}`);
  return result.code;
}

/**
 * End the process once everything written is out. Baileys leaves query timers (60 s) behind when a WhatsApp
 * session is closed right after it opened, which would keep a finished command alive for up to a minute
 * (`login` / `check` that already printed their result); every connection and file is closed by now, so exit.
 */
export async function exitWhenFlushed(
  code: number,
  streams: readonly { write(text: string, callback: () => void): unknown }[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (value) => process.exit(value),
): Promise<void> {
  await Promise.all(streams.map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))));
  exit(code);
}

if (import.meta.main) {
  await exitWhenFlushed(await main(process.argv));
}
