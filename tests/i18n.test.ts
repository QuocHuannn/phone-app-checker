import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGS, DEFAULT_LANG, LANG_ENV, LANGS, LANGUAGE_NAMES, parseLang, resolveLang, translate, type Lang } from '../src/i18n/index.ts';
import { LANG_FILE, readLanguageFile, writeLanguageFile } from '../src/i18n/store.ts';

type Message = string | ((params: Record<string, string>) => string);
const entries = (lang: Lang): [string, Message][] => Object.entries(CATALOGS[lang]) as [string, Message][];

/** Parameter names a message uses, found by handing it a proxy that records every property read. */
function usedParameters(message: Message): string[] {
  if (typeof message === 'string') return [];
  const used = new Set<string>();
  const probe = new Proxy({} as Record<string, string>, {
    get: (_target, name) => {
      used.add(String(name));
      return `<<${String(name)}>>`;
    },
  });
  message(probe);
  return [...used].sort();
}

const render = (message: Message): string => (typeof message === 'string' ? message : message(new Proxy({} as Record<string, string>, { get: (_t, name) => `<<${String(name)}>>` })));

const english = CATALOGS[DEFAULT_LANG];
const EN_KEYS = Object.keys(english).sort();

describe('catalogs', () => {
  it('lists six languages with English first and as the default', () => {
    expect([...LANGS]).toEqual(['en', 'vi', 'id', 'ms', 'ko', 'zh']);
    expect(DEFAULT_LANG).toBe('en');
    expect(Object.keys(CATALOGS).sort()).toEqual([...LANGS].sort());
  });

  it('names every language in its own script', () => {
    expect(LANGUAGE_NAMES).toEqual({
      en: 'English',
      vi: 'Tiếng Việt',
      id: 'Bahasa Indonesia',
      ms: 'Bahasa Melayu',
      ko: '한국어',
      zh: '简体中文',
    });
  });

  describe.each(LANGS)('%s', (lang) => {
    it('has exactly the same keys as English', () => {
      expect(Object.keys(CATALOGS[lang]).sort()).toEqual(EN_KEYS);
    });

    it('defines every message with the same kind (string or function) as English', () => {
      for (const [key, message] of entries(lang)) {
        expect(typeof message, key).toBe(typeof english[key as keyof typeof english]);
      }
    });

    it('uses exactly the same placeholders as English, each one in the output', () => {
      for (const [key, message] of entries(lang)) {
        const wanted = usedParameters(english[key as keyof typeof english] as Message);
        expect(usedParameters(message), key).toEqual(wanted);
        const output = render(message);
        for (const name of wanted) expect(output, `${key} must show {${name}}`).toContain(`<<${name}>>`);
      }
    });

    it('has no empty or blank message', () => {
      for (const [key, message] of entries(lang)) {
        expect(render(message).trim(), key).not.toBe('');
      }
    });

    it('has no raw control, format, line-break or replacement characters', () => {
      for (const [key, message] of entries(lang)) {
        expect(render(message), key).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFFFD]/u);
      }
    });

    it('has no leftover template syntax', () => {
      for (const [key, message] of entries(lang)) {
        expect(render(message).replace(/<<\w+>>/g, ''), key).not.toMatch(/\$\{|\{\w+\}|undefined|\[object/);
      }
    });

    it('keeps the technical tokens that users must still recognise', () => {
      const tokens: Record<string, string[]> = {
        menuPrompt: ['0-6', 'L'],
        menuInvalid: ['0', '6', 'L'],
        menuDoctor: ['doctor'],
        configFixHint: ['(5)'],
        doctorFailHint: ['FAIL', '5'],
        guideNotFound: ['not_found'],
        guideLine: ['HK / JP / KR / TW / TH'],
        guideZalo: ['+84'],
        guideBan: ['ban'],
        guideDetails: ['README.md', 'docs/install-macos.md'],
        hintTelegram: ['+84'],
        hintViber: ['docs/viber-setup.md'],
        hintLine: ['docs/line-setup.md'],
        telegramIntro: ['api_id', 'api_hash'],
        telegramStep1: ['https://my.telegram.org/apps'],
        telegramStep2: ['api_id', 'api_hash'],
        telegramStep3: [],
        telegramSecretNote: ['api_hash'],
        telegramApiIdPrompt: ['api_id', 'b = '],
        telegramApiHashPrompt: ['api_hash', '0-9', 'a-f', '32', 'b = '],
        telegramApiHashInvalid: ['api_hash', '32', '0-9', 'a-f', 'my.telegram.org/apps'],
        telegramSaveFailed: ['api_id / api_hash'],
        telegramCredentialsSaved: ['api_id', 'api_hash'],
        hintTelegramQr: ['Telegram'],
        whatsappMethodCode: ['8'],
        whatsappPhonePrompt: ['+84901234567'],
        whatsappPhoneInvalid: ['+84901234567'],
        qrPlainNote: ['NO_COLOR'],
        qrTooBig: ['Cmd+'],
        whatsappPairingSteps: ['WhatsApp'],
        telegramPhonePrompt: ['+84901234567'],
        checkStarting: ['Ctrl+C'],
        languagePrompt: ['1-'],
        telegramApiIdLooksLikeHash: ['api_hash', 'api_id'],
        telegramApiHashLooksLikeId: ['api_hash', 'api_id'],
        telegramApiHashLength: ['api_hash', '32', '0-9', 'a-f'],
        telegramHashAccepted: ['api_hash'],
        stepLabel: ['<<n>>/<<m>>'],
        tgWhyKeys: ['Telegram', '3'],
        tgKeysFound: ['API', '1', '2'],
        tgFormFields: ['App title', 'Short name', 'Platform: Other', 'Create application'],
        tgOpenPrompt: ['https://my.telegram.org/apps'],
        tgBackHint: ['b'],
        telegramErrMigrate: ['PHONE_MIGRATE'],
        telegramErrPasswordNeeded: ['SESSION_PASSWORD_NEEDED'],
        telegramErrPhoneInvalid: ['+84901234567'],
        telegramErrApiId: ['api_id', 'api_hash', 'API_ID_INVALID', 'https://my.telegram.org/apps', 'docs/telegram-setup.md'],
        telegramErrGeneric: ['docs/telegram-setup.md'],
        hintMenu: ['↑↓', 'Enter', 'q'],
        hintBack: ['↑↓', 'Enter', 'Esc', 'q'],
        finalNextOpen: ['Excel', 'Numbers'],
        finalNextFinder: ['Finder'],
        finalIncomplete: ['INCOMPLETE'],
      };
      for (const [key, wanted] of Object.entries(tokens)) {
        const output = render(CATALOGS[lang][key as keyof typeof english] as Message);
        for (const token of wanted) expect(output, `${key} lacks ${token}`).toContain(token);
      }
    });

    it('offers non-empty yes and no answer words, separated by commas', () => {
      for (const key of ['answerYes', 'answerNo'] as const) {
        const words = CATALOGS[lang][key].split(',').map((word) => word.trim());
        expect(words.length, key).toBeGreaterThanOrEqual(2);
        for (const word of words) expect(word, key).not.toBe('');
      }
    });

    it('does not use column padding for alignment (no runs of spaces inside a message)', () => {
      for (const [key, message] of entries(lang)) {
        expect(render(message).trimStart(), key).not.toMatch(/\S {2,}\S/);
      }
    });
  });

  it('translations are really translated: no other language repeats English text', () => {
    // Allowed to match English: only text that is the same in every language by nature.
    const sameEverywhere = new Set<string>(['askCsvHintDefault']); // "Enter = <path>"
    for (const lang of LANGS.filter((code) => code !== 'en')) {
      for (const [key, message] of entries(lang)) {
        if (sameEverywhere.has(key)) continue;
        expect(render(message), `${lang}.${key}`).not.toBe(render(english[key as keyof typeof english] as Message));
      }
    }
  });

  it('translate fills in the parameters', () => {
    expect(translate('en', 'menuInvalid', { choice: 'zz' })).toContain('"zz"');
    expect(translate('vi', 'commandFailed', { code: 7 })).toContain('mã 7');
    expect(translate('zh', 'goodbye')).toBe('再见。');
    expect(translate('ko', 'reportDone', { path: '/a/b.csv' })).toContain('/a/b.csv');
  });
});

describe('parseLang', () => {
  it.each([
    ['en', 'en'],
    ['VI', 'vi'],
    [' zh ', 'zh'],
    ['Id', 'id'],
    ['ms', 'ms'],
    ['ko', 'ko'],
  ] as const)('%j -> %s', (input, expected) => {
    expect(parseLang(input)).toBe(expected);
  });

  it.each(['', '  ', 'xx', 'english', 'vi-VN', 'zh_CN', 'en_US.UTF-8', 'vietnamese', '1', 'vi\nko'])('%j is not a language', (input) => {
    expect(parseLang(input)).toBeUndefined();
  });

  it('undefined is not a language', () => {
    expect(parseLang(undefined)).toBeUndefined();
  });
});

describe('resolveLang', () => {
  it('defaults to English, and ignores the system locale', () => {
    expect(resolveLang({ env: {} })).toBe('en');
    expect(resolveLang({ env: { LANG: 'vi_VN.UTF-8', LC_ALL: 'vi_VN.UTF-8', LC_MESSAGES: 'ko_KR.UTF-8', LANGUAGE: 'zh' } })).toBe('en');
  });

  it('applies flag > environment > saved > default', () => {
    expect(resolveLang({ flag: 'ko', env: { [LANG_ENV]: 'zh' }, stored: 'vi' })).toBe('ko');
    expect(resolveLang({ env: { [LANG_ENV]: 'zh' }, stored: 'vi' })).toBe('zh');
    expect(resolveLang({ env: {}, stored: 'vi' })).toBe('vi');
    expect(resolveLang({ env: {} })).toBe('en');
  });

  it('treats an empty flag or variable as not set', () => {
    expect(resolveLang({ flag: '', env: { [LANG_ENV]: ' ' }, stored: 'id' })).toBe('id');
  });

  it('gives English for a flag or variable that is set but unknown, and for an unknown saved value', () => {
    expect(resolveLang({ flag: 'klingon', env: { [LANG_ENV]: 'zh' }, stored: 'vi' })).toBe('en');
    expect(resolveLang({ env: { [LANG_ENV]: 'klingon' }, stored: 'vi' })).toBe('en');
    expect(resolveLang({ env: {}, stored: 'klingon' })).toBe('en');
  });
});

describe('language file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pac-lang-'));
    chmodSync(dir, 0o700);
    file = join(dir, LANG_FILE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a private file holding just the code, and reads it back', () => {
    for (const lang of LANGS) {
      writeLanguageFile(file, lang);
      expect(readFileSync(file, 'utf8')).toBe(`${lang}\n`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readLanguageFile(file)).toBe(lang);
    }
    expect(readdirSync(dir)).toEqual([LANG_FILE]);
  });

  it('replaces a file that is group/world readable with a private one', () => {
    writeFileSync(file, 'vi\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(readLanguageFile(file)).toBeUndefined();
    writeLanguageFile(file, 'ko');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readLanguageFile(file)).toBe('ko');
  });

  it('replaces a symlink at the target instead of writing through it', () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'precious\n', { mode: 0o600 });
    symlinkSync(victim, file);
    writeLanguageFile(file, 'zh');
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    expect(statSync(file).isFile()).toBe(true);
    expect(readLanguageFile(file)).toBe('zh');
  });

  it('does not touch a hard link to somewhere else', () => {
    const other = join(dir, 'other');
    writeFileSync(other, 'keep\n', { mode: 0o600 });
    linkSync(other, file);
    writeLanguageFile(file, 'id');
    expect(readFileSync(other, 'utf8')).toBe('keep\n');
    expect(readFileSync(file, 'utf8')).toBe('id\n');
  });

  it('throws and leaves no temporary file when the target cannot be replaced', () => {
    mkdirSync(join(file, 'inner'), { recursive: true });
    expect(() => writeLanguageFile(file, 'vi')).toThrow();
    expect(readdirSync(dir)).toEqual([LANG_FILE]);
  });

  it('throws when the folder is missing or read-only', () => {
    expect(() => writeLanguageFile(join(dir, 'missing', LANG_FILE), 'vi')).toThrow();
    chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() !== 0) expect(() => writeLanguageFile(file, 'vi')).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reads nothing from a missing, unreadable-folder or odd file, and never throws', () => {
    expect(readLanguageFile(file)).toBeUndefined();
    expect(readLanguageFile(join(dir, 'missing', LANG_FILE))).toBeUndefined();
    writeFileSync(file, `vi${' '.repeat(65)}`, { mode: 0o600 });
    expect(readLanguageFile(file)).toBeUndefined();
    writeFileSync(file, 'vi\n', { mode: 0o600 });
    chmodSync(file, 0o620);
    expect(readLanguageFile(file)).toBeUndefined();
    chmodSync(file, 0o604);
    expect(readLanguageFile(file)).toBeUndefined();
    chmodSync(file, 0o400);
    expect(readLanguageFile(file)).toBe('vi');
  });

  it('returns the raw trimmed content; the caller decides whether it is a language', () => {
    writeFileSync(file, '  KO \n\n', { mode: 0o600 });
    expect(readLanguageFile(file)).toBe('KO');
    expect(parseLang(readLanguageFile(file))).toBe('ko');
    writeFileSync(file, 'garbage\n', { mode: 0o600 });
    expect(readLanguageFile(file)).toBe('garbage');
    expect(parseLang(readLanguageFile(file))).toBeUndefined();
  });
});
