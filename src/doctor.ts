import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdbError, type AdbDevice } from './android/adb.ts';
import { readTelegramCredentials } from './adapters/telegram-credentials.ts';
import { accountDirPath, listAccountNames, type Config } from './config.ts';
import { packageVersion, readBuildInfo } from './home.ts';
import { plural } from './plural.ts';
import { Store } from './store.ts';
import { APPS, redactPhones, type Adapter, type App } from './types.ts';
import { wrap } from './ui.ts';

export type DoctorLevel = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  level: DoctorLevel;
  detail: string;
}

export interface DoctorInput {
  /** `PHONE_APP_CHECKER_HOME` when set (release mode), otherwise undefined. */
  home: string | undefined;
  configFile: string;
  configExists: boolean;
  /** May throw: reported as a `config` failure and the config-dependent checks are skipped. */
  loadConfig: () => Config;
  /** Imported adapter modules; only used when `deep` is set (default `doctor` never loads them). */
  loadAdapter: (app: App) => Promise<Adapter>;
  /**
   * Package-resolution probe used by the default (shallow) doctor for the adapter's client library.
   * Viber has no npm package (first-party code + adb): it is never called for that app.
   */
  resolveAdapter?: (app: App) => void;
  /** Import every adapter module (the pre-0.2.0 behaviour); without it only the packages' presence is checked. */
  deep?: boolean;
  listDevices: (adbPath?: string) => Promise<AdbDevice[]>;
  env: NodeJS.ProcessEnv;
}

/** npm package that carries the app's client library; undefined when the adapter is first-party. */
const ADAPTER_PACKAGE: Record<App, string | undefined> = {
  telegram: '@mtcute/node',
  whatsapp: 'baileys',
  zalo: 'zca-js',
  viber: undefined,
  line: '@evex/linejs',
  threema: undefined,
  matrix: undefined,
};

const requireForPackages = createRequire(import.meta.url);

/**
 * Default shallow probe: resolving a package entry point checks the dependency is installed without
 * paying its import cost (tens to hundreds of ms per adapter, r2 §4.6).
 */
export function resolveAdapterPackage(app: App): void {
  const pkg = ADAPTER_PACKAGE[app];
  if (pkg !== undefined) requireForPackages.resolve(pkg);
}

const MIN_NODE = [22, 18, 0] as const;

/** Error text for the report: phone numbers masked and 32+ character hex strings (API hashes, tokens) never shown. */
function message(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]');
  return redactPhones(text);
}

function nodeIsSupported(version: string): boolean {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== MIN_NODE[i]) return have > (MIN_NODE[i] ?? 0);
  }
  return true;
}

function versionCheck(): DoctorCheck {
  const version = packageVersion();
  try {
    const info = readBuildInfo();
    const detail = info === null ? `${version} (source checkout)` : `${version} (node ${info.node}, built ${info.builtAt})`;
    return { name: 'version', level: 'ok', detail };
  } catch (error) {
    return { name: 'version', level: 'warn', detail: `${version}; build info unreadable: ${message(error)}` };
  }
}

function runtimeCheck(): DoctorCheck {
  const node = process.versions.node;
  const detail = `node ${node}, ${process.platform}/${process.arch}`;
  if (!nodeIsSupported(node)) return { name: 'runtime', level: 'fail', detail: `${detail}; Node ${MIN_NODE.join('.')} or newer is required` };
  return { name: 'runtime', level: 'ok', detail };
}

function sqliteCheck(): DoctorCheck {
  try {
    const db = new DatabaseSync(':memory:');
    try {
      db.prepare('SELECT 1').get();
    } finally {
      db.close();
    }
    return { name: 'sqlite', level: 'ok', detail: 'node:sqlite works' };
  } catch (error) {
    return { name: 'sqlite', level: 'fail', detail: message(error) };
  }
}

function configCheck(input: DoctorInput): { check: DoctorCheck; config: Config | undefined } {
  try {
    const config = input.loadConfig();
    const state = input.configExists ? 'exists' : 'missing: built-in defaults';
    return { check: { name: 'config', level: input.configExists ? 'ok' : 'warn', detail: `${input.configFile} (${state})` }, config };
  } catch (error) {
    return { check: { name: 'config', level: 'fail', detail: message(error) }, config: undefined };
  }
}

function dataCheck(config: Config): DoctorCheck {
  try {
    Store.open(config.dataDir).close();
    return { name: 'data', level: 'ok', detail: config.dataDir };
  } catch (error) {
    return { name: 'data', level: 'fail', detail: message(error) };
  }
}

async function adbProblem(config: Config, input: DoctorInput): Promise<{ level: 'warn' | 'fail'; detail: string } | undefined> {
  const configured = config.apps.viber.options.adbPath;
  try {
    const devices = await input.listDevices(typeof configured === 'string' && configured !== '' ? configured : undefined);
    if (devices.some((device) => device.state === 'device')) return undefined;
    return { level: 'warn', detail: 'no Android device ready (adb devices)' };
  } catch (error) {
    return { level: error instanceof AdbError && error.kind === 'adb-missing' ? 'fail' : 'warn', detail: message(error) };
  }
}

/**
 * Threema and Matrix keep their login in `credentials.json` inside each account directory. A missing
 * file means that account never finished login; a group/world-readable one exposes the secret.
 */
function credentialFileProblems(config: Config, app: 'threema' | 'matrix'): string[] {
  const problems: string[] = [];
  for (const name of listAccountNames(config, app)) {
    const file = join(accountDirPath(config, app, name), 'credentials.json');
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat === undefined) problems.push(`account "${name}" has no credentials.json: run login ${app} --account ${name}`);
    else if ((stat.mode & 0o077) !== 0) problems.push(`account "${name}" credentials.json is readable by others (mode ${(stat.mode & 0o777).toString(8)}): run chmod 600 on it`);
  }
  return problems;
}

async function appCheck(app: App, config: Config, input: DoctorInput): Promise<DoctorCheck> {
  // Shallow (default): the adapter's client package must only resolve, which is ~1 ms; deep
  // (`doctor --deep`) imports the module like doctor always did before 0.2.0.
  const deep = input.deep === true;
  try {
    if (deep) await input.loadAdapter(app);
    else (input.resolveAdapter ?? resolveAdapterPackage)(app);
  } catch (error) {
    return { name: app, level: 'fail', detail: message(error) };
  }
  const available = deep ? 'module loads' : ADAPTER_PACKAGE[app] === undefined ? 'adapter available' : 'adapter package installed';
  const settings = config.apps[app];
  if (!settings.enabled) return { name: app, level: 'ok', detail: `disabled (${available})` };

  const warnings: string[] = [];
  let failure: string | undefined;
  const accounts = listAccountNames(config, app).length;
  if (accounts === 0) warnings.push(`no account yet: log in (menu item 2, or: phone-app-checker login ${app} --account <name>)`);
  if (app === 'telegram') {
    try {
      readTelegramCredentials(settings.options, input.env);
    } catch {
      warnings.push(`api_id/api_hash: the menu asks for them when you log in; or set apps.telegram.options.apiId/apiHash in ${input.configFile} (or TELEGRAM_API_ID / TELEGRAM_API_HASH)`);
    }
  }
  if (app === 'viber') {
    const problem = await adbProblem(config, input);
    if (problem?.level === 'fail') failure = problem.detail;
    else if (problem !== undefined) warnings.push(problem.detail);
  }
  if (app === 'threema' || app === 'matrix') warnings.push(...credentialFileProblems(config, app));
  if (failure !== undefined) return { name: app, level: 'fail', detail: [failure, ...warnings].join('; ') };
  if (warnings.length > 0) return { name: app, level: 'warn', detail: warnings.join('; ') };
  return { name: app, level: 'ok', detail: `${available}; ${plural(accounts, 'account')}` };
}

/** Read-only prerequisites check (apart from `Store.open` hardening the data directory, as `report` does). */
export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [versionCheck(), runtimeCheck(), sqliteCheck()];
  const { check, config } = configCheck(input);
  checks.push(check);
  if (config === undefined) return checks;
  checks.push(dataCheck(config));
  for (const app of APPS) checks.push(await appCheck(app, config, input));
  return checks;
}

const LEVEL_LABEL: Record<DoctorLevel, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };

/**
 * Printed after every report. `doctor` never opens a connection to a messaging app, so no row can say an
 * account is still logged in; a green table must not be read as "results are trustworthy".
 * docs/install-macos.md and docs/install-macos.vi.md quote these lines verbatim.
 */
export const DOCTOR_FOOTER = [
  'NOTE: doctor checks offline readiness only (no live account authentication).',
  'OK does not prove an account can check numbers: run `phone-app-checker login <app> --account <name>`,',
  'then a small trial on numbers whose answers you already know, before trusting any result.',
].join('\n');

/**
 * One aligned `LEVEL  name  detail` line per check, a blank line, then {@link DOCTOR_FOOTER} as its
 * own paragraph. Details wrap to `columns` with a hanging indent under the detail column, so a fix
 * instruction is never cut mid-token at a narrow window.
 */
export function formatDoctor(checks: DoctorCheck[], columns = 80): string {
  const nameWidth = Math.max(0, ...checks.map((check) => check.name.length));
  const rows: string[] = [];
  for (const check of checks) {
    const prefix = `${LEVEL_LABEL[check.level].padEnd(4)}  ${check.name.padEnd(nameWidth)}  `;
    const parts = wrap(check.detail, Math.max(12, columns - prefix.length));
    for (const [index, part] of parts.entries()) rows.push(index === 0 ? `${prefix}${part}`.trimEnd() : `${' '.repeat(prefix.length)}${part}`.trimEnd());
  }
  return `${rows.join('\n')}\n\n${DOCTOR_FOOTER}`;
}
