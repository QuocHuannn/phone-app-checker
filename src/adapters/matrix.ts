import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { translate, translator } from '../i18n/index.ts';
import { askHidden, askVisible } from '../prompt.ts';
import {
  AccountBanned,
  RateLimited,
  maskPhone,
  type Adapter,
  type AdapterContext,
  type CheckStatus,
  type PhoneNumber,
  type Session,
} from '../types.ts';

/**
 * Matrix (Element), through the official Identity Service API
 * (https://spec.matrix.org/v1.19/identity-service-api/): `POST /_matrix/identity/v2/lookup` takes hashed
 * phone numbers and answers with the Matrix IDs that published a binding for them. Nothing is ever sent to
 * the person. Only people who linked their phone number to an identity server are found, so `not_found`
 * mostly means "not linked", not "no Matrix account".
 *
 * Address format (spec appendix "3PID Types", PSTN phone numbers, medium `msisdn`): the E.164 number
 * "without a leading '+'". Hash (identity spec, algorithm `sha256`): SHA-256 over the string
 * `<address> msisdn <pepper>`, encoded as URL-safe unpadded base64. The spec's own example is
 * `18005552067` with pepper `matrixrocks` -> `nlo35_T5fzSGZzJApqu8lgIudJvmOQtDaHtr-I4rU7I`.
 *
 * Login chain (done once): password login on the homeserver -> `openid/request_token` -> identity
 * `account/register` (gives the identity token) -> terms of service if the server asks -> `hash_details`
 * (gives the pepper). Only `{identityServer, identityToken, lookupPepper}` is kept; the homeserver access
 * token is logged out again and the password is never stored. Tokens and the password are never logged.
 */

const CREDENTIALS_FILE = 'credentials.json';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOGIN_ATTEMPTS = 3;
const DEVICE_NAME = 'phone-app-checker';

export const DEFAULT_HOMESERVER = 'https://matrix.org';
export const DEFAULT_IDENTITY_SERVER = 'https://vector.im';

/** E.164 digits only: the same bound libphonenumber enforces. */
const E164 = /^\+[1-9]\d{6,14}$/;

interface StoredCredentials {
  identityServer: string;
  identityToken: string;
  lookupPepper: string;
}

/** Hash the identity server expects for a number (see the module comment). */
export function addressHash(e164: string, pepper: string): string {
  return createHash('sha256').update(`${e164.replace(/^\+/, '')} msisdn ${pepper}`).digest('base64url');
}

/** `https://host[:port]` without a trailing slash; undefined for anything else (passwords and tokens must not travel in clear text). */
export function normalizeServerUrl(value: string): string | undefined {
  const text = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.identityServer === 'string' &&
    normalizeServerUrl(v.identityServer) !== undefined &&
    typeof v.identityToken === 'string' &&
    v.identityToken !== '' &&
    typeof v.lookupPepper === 'string' &&
    v.lookupPepper !== ''
  );
}

async function saveCredentials(ctx: AdapterContext, credentials: StoredCredentials): Promise<void> {
  await mkdir(ctx.accountDir, { recursive: true, mode: 0o700 });
  const target = join(ctx.accountDir, CREDENTIALS_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(credentials), { mode: 0o600 });
  // mode in writeFile is subject to umask and ignored for pre-existing files.
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

async function loadCredentials(ctx: AdapterContext): Promise<StoredCredentials> {
  let raw: string;
  try {
    raw = await readFile(join(ctx.accountDir, CREDENTIALS_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No Matrix credentials for account "${ctx.account}". Run: login matrix --account ${ctx.account}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Matrix credentials file for account "${ctx.account}" is corrupt; run login again.`);
  }
  if (!isStoredCredentials(parsed)) {
    throw new Error(`Matrix credentials file for account "${ctx.account}" is missing a valid identityServer/identityToken/lookupPepper; run login again.`);
  }
  return { ...parsed, identityServer: normalizeServerUrl(parsed.identityServer) as string };
}

/** One HTTP answer, already parsed as far as the Matrix error format goes. */
interface Reply {
  status: number;
  body: Record<string, unknown>;
  /** Matrix `errcode` (for example `M_TERMS_NOT_SIGNED`), when the body has one. */
  errcode: string | undefined;
  retryAfterMs: number | undefined;
}

interface CallOptions {
  /** Sent as `Authorization: Bearer`. */
  token?: string;
  body?: unknown;
  /** Strings that must not appear in an error message (the token, the password). */
  secrets?: string[];
}

function retryAfter(response: Response, body: Record<string, unknown>): number | undefined {
  // Matrix rate-limit errors carry `retry_after_ms`; proxies may send the HTTP `Retry-After` seconds instead.
  if (typeof body.retry_after_ms === 'number' && body.retry_after_ms > 0) return body.retry_after_ms;
  const header = response.headers.get('retry-after');
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** One request. Network failures are rebuilt without their cause chain and without the URL or any secret. */
async function call(method: 'GET' | 'POST', server: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${server}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    let text = err instanceof Error ? err.message : String(err);
    for (const secret of [options.token, ...(options.secrets ?? [])]) {
      if (secret !== undefined && secret !== '') text = text.split(secret).join('[secret]');
    }
    throw new Error(`Matrix request to ${new URL(server).host} failed: ${text}`);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy error page, an empty body): the status alone decides.
  }
  return {
    status: response.status,
    body,
    errcode: typeof body.errcode === 'string' ? body.errcode : undefined,
    retryAfterMs: retryAfter(response, body),
  };
}

const describeReply = (reply: Reply): string => `HTTP ${reply.status}${reply.errcode === undefined ? '' : ` ${reply.errcode}`}`;

/** The pepper from `GET hash_details`, requiring the `sha256` algorithm every server must support. */
function pepperFrom(reply: Reply): string {
  const { algorithms, lookup_pepper: pepper } = reply.body;
  if (!Array.isArray(algorithms) || !algorithms.includes('sha256') || typeof pepper !== 'string' || pepper === '') {
    throw new Error('The identity server\'s hash_details does not offer sha256 with a pepper; response not understood');
  }
  return pepper;
}

/** Turn a failed identity-server answer into the error the scheduler understands. */
function failure(reply: Reply, partial: Map<string, CheckStatus>): Error {
  if (reply.status === 429 || reply.errcode === 'M_LIMIT_EXCEEDED') {
    return new RateLimited(`Matrix identity server throttled the account (${describeReply(reply)})`, reply.retryAfterMs, partial);
  }
  if (reply.errcode === 'M_TERMS_NOT_SIGNED') {
    return new AccountBanned('The Matrix identity server wants new terms accepted. Run login again to read and accept them.', partial);
  }
  if (reply.status === 401 || reply.errcode === 'M_UNAUTHORIZED') {
    return new AccountBanned('The Matrix identity server rejected the saved token. Run login again.', partial);
  }
  return new Error(`Matrix identity server answered ${describeReply(reply)}`);
}

class MatrixSession implements Session {
  readonly #server: string;
  readonly #token: string;
  #pepper: string;
  readonly #log: (message: string) => void;

  constructor(credentials: StoredCredentials, log: (message: string) => void) {
    this.#server = credentials.identityServer;
    this.#token = credentials.identityToken;
    this.#pepper = credentials.lookupPepper;
    this.#log = log;
  }

  async check(numbers: PhoneNumber[]): Promise<Map<string, CheckStatus>> {
    // Malformed numbers are left out and reported as `unknown`.
    const valid = [...new Set(numbers.map((n) => n.e164).filter((e164) => E164.test(e164)))];
    const results = new Map<string, CheckStatus>();
    if (valid.length === 0) return results;

    let attempt = await this.#lookup(valid);
    if (attempt.reply.errcode === 'M_INVALID_PEPPER') {
      // The server rotated its pepper: fetch the new one and retry exactly once (no retry loop).
      await this.#refreshPepper();
      attempt = await this.#lookup(valid);
    }
    const { reply, hashes } = attempt;
    if (reply.status !== 200) {
      this.#log(`matrix lookup failed for ${valid.length} number(s), first ${maskPhone(valid[0] as string)}: ${describeReply(reply)}`);
      throw failure(reply, results);
    }
    const mappings = reply.body.mappings;
    if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
      throw new Error('Matrix lookup returned 200 without a mappings object; response not understood');
    }
    // A hash present in `mappings` is a published binding. Only the presence matters: the Matrix ID is neither kept nor logged.
    for (const [e164, hash] of hashes) results.set(e164, Object.hasOwn(mappings, hash) ? 'yes' : 'not_found');
    return results;
  }

  async #lookup(e164s: string[]): Promise<{ reply: Reply; hashes: Map<string, string> }> {
    const hashes = new Map(e164s.map((e164) => [e164, addressHash(e164, this.#pepper)] as const));
    const reply = await call('POST', this.#server, '/_matrix/identity/v2/lookup', {
      token: this.#token,
      body: { addresses: [...hashes.values()], algorithm: 'sha256', pepper: this.#pepper },
    });
    return { reply, hashes };
  }

  async #refreshPepper(): Promise<void> {
    const reply = await call('GET', this.#server, '/_matrix/identity/v2/hash_details', { token: this.#token });
    if (reply.status !== 200) throw failure(reply, new Map());
    this.#pepper = pepperFrom(reply);
  }

  async close(): Promise<void> {
    // Plain HTTPS requests: there is no connection to close.
  }
}

/** One terms URL per policy: English when offered, otherwise the first language that has a URL. */
function policyUrls(policies: unknown): string[] {
  if (typeof policies !== 'object' || policies === null) return [];
  const urls: string[] = [];
  for (const policy of Object.values(policies)) {
    if (typeof policy !== 'object' || policy === null) continue;
    const languages = Object.entries(policy).filter(([key, value]) => key !== 'version' && typeof value === 'object' && value !== null);
    const preferred = languages.find(([key]) => key === 'en') ?? languages[0];
    const url = preferred === undefined ? undefined : (preferred[1] as Record<string, unknown>).url;
    if (typeof url === 'string' && url !== '') urls.push(url);
  }
  return urls;
}

async function askServer(ctx: AdapterContext, defaultUrl: string): Promise<string> {
  const say = translator(ctx.lang);
  for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
    const answer = (await askVisible(say('matrixHomeserverPrompt', { url: defaultUrl }))).trim();
    if (answer === '') return defaultUrl;
    const url = normalizeServerUrl(answer);
    if (url !== undefined) return url;
    ctx.log(say('matrixHomeserverInvalid'));
  }
  throw new Error(say('matrixHomeserverInvalid'));
}

function configuredServer(ctx: AdapterContext, key: 'homeserver' | 'identityServer', fallback: string): string {
  const value = ctx.options[key];
  if (value === undefined) return fallback;
  const url = typeof value === 'string' ? normalizeServerUrl(value) : undefined;
  if (url === undefined) throw new Error(`Config apps.matrix.options.${key} must be an https:// address; got ${JSON.stringify(value)}`);
  return url;
}

/** The person agrees in their own language or with y/yes. */
function isYes(answer: string, ctx: AdapterContext): boolean {
  const text = answer.trim().toLowerCase();
  const words = translate(ctx.lang ?? 'en', 'answerYes').split(',').map((word) => word.trim().toLowerCase());
  return ['y', 'yes', ...words].includes(text);
}

/** Show the identity server's terms and send the agreement; throws when the person declines. */
async function acceptTerms(ctx: AdapterContext, server: string, token: string): Promise<void> {
  const say = translator(ctx.lang);
  const terms = await call('GET', server, '/_matrix/identity/v2/terms');
  const urls = terms.status === 200 ? policyUrls(terms.body.policies) : [];
  if (urls.length === 0) throw new Error(`The identity server wants terms accepted but did not list any (${describeReply(terms)}); nothing was saved.`);
  ctx.log(say('matrixTermsIntro', { server: new URL(server).host }));
  for (const url of urls) ctx.log(`  ${url}`);
  if (!isYes(await askVisible(say('matrixTermsPrompt')), ctx)) throw new Error(say('matrixTermsDeclined'));
  const accepted = await call('POST', server, '/_matrix/identity/v2/terms', { token, body: { user_accepts: urls } });
  if (accepted.status !== 200) throw new Error(`The identity server did not take the terms agreement (${describeReply(accepted)}); nothing was saved.`);
}

export const matrixAdapter: Adapter = {
  app: 'matrix',

  async login(ctx) {
    const say = translator(ctx.lang);
    // Validate the configured addresses before asking anything, so a bad config never costs the person a typed answer.
    const defaultHomeserver = configuredServer(ctx, 'homeserver', DEFAULT_HOMESERVER);
    const identityServer = configuredServer(ctx, 'identityServer', DEFAULT_IDENTITY_SERVER);
    const homeserver = await askServer(ctx, defaultHomeserver);
    const user = (await askVisible(say('matrixUserPrompt'))).trim();
    if (user === '') throw new Error('No username entered; nothing was saved.');
    const password = await askHidden(say('matrixPasswordPrompt'));
    if (password === '') throw new Error('No password entered; nothing was saved.');

    // 1. Homeserver login: only to prove who we are to the identity server. The session is dropped at the end.
    const session = await call('POST', homeserver, '/_matrix/client/v3/login', {
      secrets: [password],
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        initial_device_display_name: DEVICE_NAME,
      },
    });
    if (session.status === 403) throw new Error('The Matrix homeserver rejected the username or password; nothing was saved.');
    if (session.status === 429) throw new Error('The Matrix homeserver is throttling logins; wait a while and try again. Nothing was saved.');
    const accessToken = session.body.access_token;
    const userId = session.body.user_id;
    if (session.status !== 200 || typeof accessToken !== 'string' || typeof userId !== 'string') {
      throw new Error(`The Matrix homeserver login failed (${describeReply(session)}); nothing was saved.`);
    }

    try {
      // 2. OpenID token from the homeserver, 3. registered with the identity server for an identity token.
      const openid = await call('POST', homeserver, `/_matrix/client/v3/user/${encodeURIComponent(userId)}/openid/request_token`, {
        token: accessToken,
        body: {},
      });
      if (openid.status !== 200) throw new Error(`The Matrix homeserver would not issue an OpenID token (${describeReply(openid)}); nothing was saved.`);
      const registered = await call('POST', identityServer, '/_matrix/identity/v2/account/register', { body: openid.body });
      const identityToken = registered.body.token;
      if (registered.status !== 200 || typeof identityToken !== 'string' || identityToken === '') {
        throw new Error(`The identity server ${new URL(identityServer).host} did not accept the OpenID token (${describeReply(registered)}); nothing was saved.`);
      }

      // 4. The pepper. A server that wants terms says so here; show them, take the agreement, ask again.
      let details = await call('GET', identityServer, '/_matrix/identity/v2/hash_details', { token: identityToken });
      if (details.errcode === 'M_TERMS_NOT_SIGNED') {
        await acceptTerms(ctx, identityServer, identityToken);
        details = await call('GET', identityServer, '/_matrix/identity/v2/hash_details', { token: identityToken });
      }
      if (details.status !== 200) throw new Error(`The identity server refused hash_details (${describeReply(details)}); nothing was saved.`);
      await saveCredentials(ctx, { identityServer, identityToken, lookupPepper: pepperFrom(details) });
    } finally {
      // Least privilege: the homeserver session is not needed any more. Best effort; a failure here changes nothing.
      await call('POST', homeserver, '/_matrix/client/v3/logout', { token: accessToken, body: {} }).catch(() => undefined);
    }
  },

  async open(ctx) {
    return new MatrixSession(await loadCredentials(ctx), ctx.log);
  },
};
