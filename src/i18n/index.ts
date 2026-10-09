import { createRequire } from 'node:module';
import { en } from './en.ts';

/**
 * Catalog loading: English is always needed (the menu's fallback and the default), the other five
 * cost ~8 ms of startup and are only read when the run actually uses that language, so they load on
 * first access. `require` of an ESM module keeps `translate` synchronous; the sibling file is `.ts`
 * in a source checkout and `.js` in the compiled tree (`import.meta.url` tells which).
 */
const requireCatalog = createRequire(import.meta.url);
const catalogExt = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const catalogCache: Partial<Record<Lang, Catalog>> = {};
function catalog(lang: Lang): Catalog {
  if (lang === 'en') return en;
  const cached = catalogCache[lang];
  if (cached !== undefined) return cached;
  const loaded = (requireCatalog(`./${lang}${catalogExt}`) as Record<Lang, Catalog>)[lang];
  if (typeof loaded !== 'object' || loaded === null) throw new Error(`i18n catalog "${lang}" is missing or malformed`);
  catalogCache[lang] = loaded;
  return loaded;
}

/** Menu languages, in the order the language chooser lists them. English is the default. */
export const LANGS = ['en', 'vi', 'id', 'ms', 'ko', 'zh'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

/** Environment variable that overrides the saved language (and is overridden by `--lang`). */
export const LANG_ENV = 'PHONE_APP_CHECKER_LANG';

/** Each language named in its own script. Never translated, never padded: CJK/Hangul have no fixed width. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  ko: '한국어',
  zh: '简体中文',
};

/** Shown on every menu so that someone who landed in a language they cannot read can still find the switch. */
export const LANGUAGE_LABEL = 'Language / Ngôn ngữ / Bahasa / 언어 / 语言';

export type MessageKey = keyof typeof en;

/** The shape every language must have: English's keys, each with English's value type (string or typed function). */
export type Catalog = { [K in MessageKey]: (typeof en)[K] };

/** Arguments `translate` takes after the key: one parameter object for functions, nothing for plain strings. */
export type MessageArgs<K extends MessageKey> = Catalog[K] extends (params: infer P) => string ? [params: P] : [];

/** Exactly one catalog per language: a missing or extra language is a compile error. */
export const CATALOGS: Record<Lang, Catalog> = {
  get en() {
    return catalog('en');
  },
  get vi() {
    return catalog('vi');
  },
  get id() {
    return catalog('id');
  },
  get ms() {
    return catalog('ms');
  },
  get ko() {
    return catalog('ko');
  },
  get zh() {
    return catalog('zh');
  },
};

/** `value` as a language code (exact code, any case, surrounding blanks ignored), else `undefined`. */
export function parseLang(value: string | undefined): Lang | undefined {
  const code = value?.trim().toLowerCase();
  return LANGS.find((lang) => lang === code);
}

/**
 * Language for this run. Precedence: `--lang` flag, then `PHONE_APP_CHECKER_LANG`, then the saved
 * choice, then English. A flag or variable that is set but not a supported code gives English
 * (silently); an empty one counts as not set. The system locale is deliberately ignored.
 */
export function resolveLang(sources: { flag?: string; env: NodeJS.ProcessEnv; stored?: string }): Lang {
  const flag = sources.flag?.trim();
  if (flag !== undefined && flag !== '') return parseLang(flag) ?? DEFAULT_LANG;
  const fromEnv = sources.env[LANG_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return parseLang(fromEnv) ?? DEFAULT_LANG;
  return parseLang(sources.stored) ?? DEFAULT_LANG;
}

/** Look a message up in `lang`'s catalog and fill in its parameters. */
export function translate<K extends MessageKey>(lang: Lang, key: K, ...args: MessageArgs<K>): string {
  // Each function takes its own parameter type; `MessageArgs<K>` already guarantees the right one is passed.
  const message: string | ((params: never) => string) = catalog(lang)[key];
  return typeof message === 'function' ? message(args[0] as never) : message;
}

/** `translate` bound to one language. */
export type Translator = <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string;

/** `translate` bound to one language (English when none): what a login adapter uses for its screen output. */
export function translator(lang: Lang = DEFAULT_LANG): Translator {
  return (key, ...args) => translate(lang, key, ...args);
}
