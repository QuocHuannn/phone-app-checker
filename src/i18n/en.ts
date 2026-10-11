/**
 * English catalog: the source of truth for the set of message keys and for the parameters each
 * message takes. Every other language must define exactly the same keys with the same parameter
 * types (checked at compile time by `satisfies Catalog` and again by tests/i18n.test.ts).
 *
 * A message is a plain string, or a function of one named-parameter object for messages that embed
 * runtime values. Values that come from the user or the file system (paths, tokens, error text) are
 * made terminal-safe by the caller before they get here.
 */
export const en = {
  // Main menu.
  menuCheck: 'Check a CSV file',
  menuLogin: 'Log in an app account',
  menuAccounts: 'View logged-in accounts',
  menuReport: 'Rebuild the latest report',
  menuDoctor: 'Check this Mac is ready (doctor)',
  menuGuide: 'Guide / warnings',
  menuQuit: 'Quit',
  menuPrompt: 'Choose 0-6 or L, then Enter: ',
  menuInvalid: ({ choice }: { choice: string }) => `Invalid choice: "${choice}". Type a number from 0 to 6, or L, then press Enter.`,
  goodbye: 'Goodbye.',

  // Language chooser.
  languageHeader: 'Choose a language:',
  languagePrompt: ({ max }: { max: number }) => `Language (number 1-${max} or code, Enter to go back): `,
  languageUnknown: ({ input }: { input: string }) => `Did not understand "${input}". Type a number from the list, or a code such as en or vi.`,
  languageChanged: ({ language }: { language: string }) => `Language: ${language}.`,
  languageSaveFailed: 'Could not save the language choice; it applies to this session only.',

  // Files and confirmations.
  fileNotFound: ({ path }: { path: string }) => `File not found: ${path}`,
  notAFile: ({ path }: { path: string }) => `This is not a file: ${path}`,
  fileEmpty: ({ path }: { path: string }) => `This file is empty: ${path}`,
  fileNoPermission: ({ path }: { path: string }) => `Cannot read the file (no permission): ${path}`,
  confirmHintYes: 'Y/n; y = yes, n = no',
  confirmHintNo: 'y/N; y = yes, n = no',
  confirmRetry: 'Please type y (yes) or n (no).',
  answerYes: 'y, yes',
  answerNo: 'n, no',
  cancelledNoOverwrite: 'Cancelled, no file was overwritten.',

  // Asking for the CSV and the report.
  askCsvIntro: 'Drag the CSV file from Finder into this window (or type its path), then press Enter.',
  askCsvPrompt: ({ hint }: { hint: string }) => `CSV file (${hint}): `,
  askCsvHintBack: 'b = back',
  askCsvHintDefault: ({ path }: { path: string }) => `b = back · Enter = ${path}`,
  askReportPrompt: ({ path }: { path: string }) => `Report file (Enter = ${path}): `,
  reportExists: ({ path }: { path: string }) => `File ${path} already exists. Overwrite`,

  // Choosing apps.
  appsLoggedInHeader: 'Logged-in apps:',
  appsChoosePrompt: 'Check which apps? (Enter = all, or numbers separated by commas): ',
  appSelectionUnknown: ({ token }: { token: string }) =>
    `Did not understand "${token}". Type numbers from the list above (for example 1,2) or press Enter to choose all.`,

  // Command results and configuration.
  commandError: ({ error }: { error: string }) => `Error: ${error}`,
  commandFailed: ({ code }: { code: number }) => `The command did not succeed (code ${code}). You are still in the menu.`,
  configUnreadable: ({ reason }: { reason: string }) => `Cannot read the configuration: ${reason}`,
  configFixHint: ({ file }: { file: string }) => `Open ${file} to fix it, then choose "Check this Mac is ready (doctor)" (5) for details.`,

  // 1 - check a CSV.
  checkNoAccounts: 'No account is logged in yet, so nothing can be checked.',
  checkLoginNow: 'Log in an account now?',
  checkStarting: ({ apps }: { apps: string }) =>
    `Starting the check with: ${apps}. It can take a long time; press Ctrl+C once to stop and save the report.`,
  reportDone: ({ path }: { path: string }) => `Done. Report: ${path}`,
  checkSummaryHint: 'The summary table for each app is just above. Open the report file with Excel or Numbers.',
  checkInterrupted: ({ path }: { path: string }) =>
    `Stopped midway. Report (incomplete): ${path}. Run again with the same CSV file to continue; the results already collected are kept.`,

  // 2 - login.
  appNotSetUp: 'not set up',
  appLoggedIn: ({ count, names }: { count: number; names: string }) =>
    `logged in: ${count} ${count === 1 ? 'account' : 'accounts'} (${names})`,
  loginAppsHeader: 'Apps:',
  loginAppPrompt: ({ max }: { max: number }) => `Log in to which app? (number 1-${max}, b = back): `,
  loginUnknown: ({ input, max }: { input: string; max: number }) => `Did not understand "${input}". Type a number from 1 to ${max}.`,
  askAccountPrompt: ({ name }: { name: string }) => `Account name (Enter = ${name}, b = back): `,
  accountNameInvalid: 'Use only letters without accents, digits, "-" or "_" (up to 32 characters, starting with a letter or digit).',
  accountExists: ({ account, app }: { account: string; app: string }) =>
    `Account "${account}" of ${app} already exists. Logging in again replaces the old login session.`,
  loginAgainConfirm: 'Log in again anyway?',
  loginDone: ({ app, account }: { app: string; account: string }) => `Logged in ${app} (account ${account}).`,
  loginNextStep: 'Next step: choose 1 ("Check a CSV file") to look up phone numbers with this account.',
  hintTelegram: 'Telegram will ask for: your phone number (+84...), the login code (not shown while you type) and the two-step password if you have one.',
  hintViber: 'Viber needs an Android phone connected by USB cable (see docs/viber-setup.md).',
  hintLine: 'LINE will guide you on the screen (see docs/line-setup.md).',
  hintThreema: 'Threema will ask for: your Gateway ID (starts with *, 8 characters) and its secret (not shown while you type). See docs/threema-setup.md.',
  hintMatrix: 'Matrix will ask for: your homeserver (Enter = matrix.org), your username and your password (not shown while you type). The password is used once and never saved. See docs/matrix-setup.md.',

  // 2 - choosing how to log in.
  loginMethodPrompt: ({ max }: { max: number }) => `Choose 1-${max} (Enter = 1): `,
  loginMethodInvalid: ({ max }: { max: number }) => `Please type a number from 1 to ${max}.`,
  loginFailed: ({ app, account }: { app: string; account: string }) =>
    `Login of ${app} (account ${account}) did not finish and nothing was saved. You are back in the menu: choose 2 to try again.`,
  whatsappMethodIntro: 'How do you want to link WhatsApp?',
  whatsappMethodCode: 'Link with your phone number: type an 8-character code on your phone (recommended)',
  whatsappMethodQr: 'Scan a QR code with your phone',
  whatsappMethodCodeDetail: 'On the phone: WhatsApp > Settings > Linked devices > Link with phone number',
  whatsappMethodQrDetail: ({ need }: { need: string }) => `Needs a window of at least ${need}`,
  whatsappPhonePrompt: 'Phone number of the WhatsApp account you are linking, with country code (for example +84901234567; b = back): ',
  whatsappPhoneInvalid: 'This does not look like a valid phone number. Include the country code, for example +84901234567.',
  telegramMethodIntro: 'How do you want to log in to Telegram?',
  telegramMethodQr: 'Scan a QR code with the Telegram app on your phone (default)',
  telegramMethodCode: 'Type the login code Telegram sends, using your phone number',
  hintTelegramQr:
    'Telegram will show a QR code: on your phone open Telegram > Settings > Devices > Link Desktop Device, then scan it. A two-step password, if you have one, is asked after scanning (not shown while you type).',

  // 2 - Telegram api_id / api_hash, asked once.
  telegramIntro: 'Telegram needs an api_id and an api_hash (obtained once, free):',
  telegramStep1: '1) Open https://my.telegram.org/apps and sign in with the phone number of the account used for checking.',
  telegramStep2: '2) Create an "application" (any name), then copy the api_id (a number) and the api_hash (32 letters and digits).',
  telegramStep3: 'Type them below. They are saved in the config file, which only you can read.',
  telegramSecretNote: 'The api_hash is a secret: it is not shown while you type or anywhere else; do not send it to anyone or paste it into a chat.',
  telegramApiIdPrompt: 'api_id (digits only; b = back): ',
  telegramApiIdInvalid: 'The api_id is a number made of digits only, for example 1234567.',
  telegramApiHashPrompt: 'api_hash (32 characters 0-9 and a-f, hidden while you type; b = back): ',
  telegramApiHashInvalid: 'The api_hash is exactly 32 characters made of digits 0-9 and letters a-f. Copy it again from my.telegram.org/apps.',
  telegramApiIdLooksLikeHash: 'That looks like the api_hash (the long code). The api_id is the short number shown above it.',
  telegramApiHashLooksLikeId: 'That looks like the api_id (the short number). The api_hash is the long 32-character code shown below it.',
  telegramApiHashLength: ({ count }: { count: number }) =>
    `The api_hash you typed has ${count} characters; it needs exactly 32 (0-9 and a-f). Copy it again, with nothing before or after it.`,
  telegramHashAccepted: ({ count }: { count: number }) => `api_hash accepted (${count} characters, kept hidden).`,
  telegramCredentialsSaved: ({ path }: { path: string }) => `api_id and api_hash saved in ${path} (the api_hash is not shown).`,
  telegramSaveFailed: ({ reason }: { reason: string }) => `Could not save the api_id / api_hash: ${reason}`,

  // 2 - Telegram login in three steps.
  stepLabel: ({ n, m }: { n: number; m: number }) => `Step ${n}/${m}`,
  tgStepKeys: 'Get your free Telegram API keys (one-time)',
  tgStepSave: 'Save the keys',
  tgStepSignIn: 'Scan the QR code (or enter phone + code)',
  tgWhyKeys:
    'Why keys? Telegram requires them from every program that logs in to Telegram. The QR code appears in Step 3, right after the keys are saved.',
  tgKeysFound: 'API keys found: steps 1 and 2 are already done.',
  tgFormFields:
    'In the form: App title and Short name can be anything (for example "Checker" and "checker1"); Platform: Other; leave the other fields empty; then click "Create application".',
  tgOpenPrompt: 'Open https://my.telegram.org/apps in your browser now?',
  tgOpened: 'Opened in your browser. Come back to this window when you have both values.',
  tgOpenFailed: 'Could not open the browser. Open the address above by hand.',
  tgBackHint: 'Type b at any question here to go back.',
  telegramLinked: ({ who }: { who: string }) => `Telegram account linked: ${who}.`,
  loginStepAccount: 'Name this account',
  loginStepLink: 'Link the account',

  // 2 - Telegram refused something (mtcute / Telegram error codes in plain words).
  telegramErrFlood: ({ wait }: { wait: string }) =>
    `Telegram asks you to wait ${wait} before trying again (too many attempts). Nothing is wrong with your account; try again later.`,
  telegramErrMigrate: 'Telegram is moving this number to another server (PHONE_MIGRATE). Run the login again; it normally works the second time.',
  telegramErrPasswordNeeded:
    'This account has a two-step password (SESSION_PASSWORD_NEEDED). Run the login again and type that password when asked; it is not shown.',
  telegramErrPhoneInvalid: 'Telegram does not accept this phone number. Use the international format, for example +84901234567.',
  telegramErrCodeInvalid: 'The login code is wrong. Check the latest message from Telegram and try again.',
  telegramErrCodeExpired: 'The login code expired. Run the login again to get a new one.',
  telegramErrPasswordInvalid: 'The two-step password is wrong. Run the login again and retype it.',
  telegramErrApiId:
    'Telegram rejected the api_id / api_hash (API_ID_INVALID). Copy both values again from https://my.telegram.org/apps, then see docs/telegram-setup.md to replace the saved ones.',
  telegramErrBanned: 'Telegram does not let this phone number log in (it is banned or blocked by Telegram).',
  telegramErrTooMany: 'Telegram blocked further login attempts for this number for now (too many attempts). Wait a few hours, then try again.',
  telegramErrGeneric: ({ code }: { code: string }) =>
    `Telegram refused the request (${code}). Try again in a few minutes; if it keeps happening, see docs/telegram-setup.md.`,
  spinConnecting: 'Connecting to Telegram...',
  spinWaitingScan: 'Waiting for you to scan the code...',

  // Rich terminal screens: hints, empty states, final box.
  hintMenu: '↑↓ move · Enter select · q quit',
  hintBack: '↑↓ move · Enter select · Esc, q or b back',
  bannerAccounts: 'Accounts ready:',
  emptyAccounts: 'No account is logged in yet. Choose "Log in an app account" first, then come back here.',
  loginPickApp: 'Log in to which app?',
  reportSavedTo: ({ path }: { path: string }) => `Report saved to ${path}`,
  finalNextOpen: 'Next: open the file with Excel or Numbers (double-click it).',
  finalNextFinder: ({ command }: { command: string }) => `To show it in Finder, type: ${command}`,
  finalIncomplete: ({ count }: { count: number }) =>
    `INCOMPLETE: the report is NOT final. Numbers without a fresh answer: ${count}.`,
  finalIncompleteNext: 'Run the same check again with the same file to continue; finished numbers are not repeated.',

  // Shown while a login runs (QR codes, pairing codes, prompts).
  qrPlainNote: 'Plain-text QR code (no colours). If it will not scan, use a light terminal theme or a normal colour terminal (without NO_COLOR).',
  qrTooBig: ({ needColumns, needRows, haveColumns, haveRows }: { needColumns: number; needRows: number; haveColumns: number; haveRows: number }) =>
    `The QR code does not fit in this window (it needs at least ${needColumns} columns x ${needRows} rows; this window is ${haveColumns} x ${haveRows}). Enlarge the window, or press Cmd+minus to make the text smaller: the code is drawn again as soon as it fits.`,
  qrRefreshed: ({ count }: { count: number }) =>
    `New QR code (#${count}). The previous code no longer works. This one lasts about 20 seconds, then the next one replaces it automatically.`,
  qrFirst: 'This code lasts about 60 seconds, then a new code replaces it automatically.',
  qrRescan: 'WhatsApp asked for a fresh code after your scan (the phone may show an error once). Scan this new code.',
  whatsappQrReconnecting: ({ attempt, max }: { attempt: number; max: number }) =>
    `The connection to WhatsApp dropped before the code was scanned. Trying again (${attempt}/${max}).`,
  whatsappQrFailedHint:
    'QR code not working? Use the pairing code instead: choose 2 in the menu, then WhatsApp, then option 1 (or run: login whatsapp --method code --phone +84...).',
  whatsappQrTitle: 'Scan this QR code with the phone that owns the WhatsApp account.',
  whatsappQrSteps: 'On the phone: WhatsApp > Settings > Linked devices > Link a device, then point the camera at the code.',
  whatsappPairingCode: ({ code }: { code: string }) => `Pairing code: ${code}`,
  whatsappPairingSteps:
    'On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then type this code.',
  zaloQrTitle: 'Scan this QR code with the Zalo app on your phone.',
  zaloQrSteps: 'In Zalo tap the QR scanner icon next to the search bar, scan the code, then confirm the login on the phone.',
  zaloQrFile: ({ path }: { path: string }) => `This window cannot show the code; scan this picture instead: ${path}`,
  zaloQrOpened: 'The QR picture was opened on this Mac.',
  zaloQrScanned: 'QR code scanned. Confirm the login on your phone.',
  zaloQrExpired: ({ attempt, max }: { attempt: number; max: number }) => `The QR code expired. Making a new one (${attempt}/${max}).`,
  zaloQrGaveUp: 'The QR code expired too many times. Run the login again.',
  zaloQrDeclined: 'Zalo login was declined on the phone.',
  threemaIdPrompt: 'Threema Gateway ID (8 characters, starts with *, for example *ABCDEFG): ',
  threemaSecretPrompt: 'Threema Gateway API secret (not shown while you type): ',
  threemaIdInvalid: 'A Gateway ID is "*" followed by 7 capital letters or digits, for example *ABCDEFG. Try again.',
  matrixHomeserverPrompt: ({ url }: { url: string }) => `Matrix homeserver address (Enter = ${url}): `,
  matrixHomeserverInvalid: 'Type an address that starts with https://, for example https://matrix.org. Try again.',
  matrixUserPrompt: 'Matrix username (for example alice, or @alice:matrix.org): ',
  matrixPasswordPrompt: 'Matrix password (not shown while you type; used once, never saved): ',
  matrixTermsIntro: ({ server }: { server: string }) => `The identity server ${server} asks you to accept its terms before it answers lookups. Read them here:`,
  matrixTermsPrompt: 'Do you accept these terms? (y/n): ',
  matrixTermsDeclined: 'The terms were not accepted; nothing was saved.',
  telegramPhonePrompt: 'Telegram phone number (international format, for example +84901234567): ',
  telegramCodePrompt: 'Login code sent by Telegram (not shown while you type): ',
  telegramPasswordPrompt: 'Two-step verification password (not shown while you type): ',
  telegramInvalidCode: 'Invalid code, try again.',
  telegramInvalidPassword: 'Invalid password, try again.',
  telegramQrTitle: 'Scan this QR code with the Telegram app on your phone.',
  telegramQrSteps: 'On the phone: Telegram > Settings > Devices > Link Desktop Device, then scan the code. It is renewed about every 30 seconds.',
  telegramQrTimeout: 'Nobody scanned the QR code in time. Run the login again.',
  lineQrTitle: 'Scan this QR code with the LINE app on the phone that owns the account.',
  lineQrUrl: ({ url }: { url: string }) => `(or open: ${url})`,
  linePin: ({ pin }: { pin: string }) => `Enter PIN ${pin} on the phone to confirm the login.`,

  // 4 - rebuild the report.
  reportIntro: 'Rebuilds the report from the saved results (no new checks are made).',

  // 5 - doctor.
  doctorFailHint: 'A line says FAIL: fix it as described on that line, then choose item 5 again.',

  // 6 - guide and warnings.
  guideTitle: 'GUIDE AND WARNINGS',
  guideConsent: '- Only check numbers of people who agreed to be contacted. The tool does not verify consent for you.',
  guideNotFound: '- "not_found" does not necessarily mean there is no account: the user may hide their phone number from search (privacy).',
  guideLine: '- LINE is only meaningful for HK / JP / KR / TW / TH numbers; for other countries it gives almost no information.',
  guideZalo: '- Zalo only checks Vietnamese numbers (+84).',
  guideBan: '- Use the company\'s own disposable SIM / accounts: accounts can be restricted or banned.',
  guideEvidence: '- A result is only an observation at the time of checking, not evidence.',
  guideDetails: '- Details: README.md and docs/install-macos.md.',

  // v0.2.0: recent files, CSV preview, checklist, QR gate, accounts actions, guide pages.
  accountsWord: ({ count }: { count: number }) => (count === 1 ? '1 account' : `${count} accounts`),
  accountsNone: 'none',
  pickCsvTitle: 'Choose the phone list (CSV)',
  pickCsvDrag: 'Drag a CSV file from Finder into this window, or pick one you used before.',
  pickCsvType: 'Type or paste a path',
  pickCsvRecentHint: 'a number from the list, or b = back',
  recentClear: 'clear the list and stop remembering files',
  recentConfirm: 'Clear the recent files and stop remembering them?',
  recentCleared: 'Recent files cleared; remembering is now off.',
  recentMissing: 'missing',
  recentWhenJustNow: 'just now',
  recentWhenMinutes: ({ count }: { count: number }) => `${count} min ago`,
  recentWhenHours: ({ count }: { count: number }) => `${count} h ago`,
  recentWhenYesterday: 'yesterday',
  previewTitle: ({ name, column }: { name: string; column: string }) => `${name} · phone column "${column}"`,
  previewCounts: ({ rows, usable, unusable }: { rows: number; usable: number; unusable: number }) =>
    `${rows} rows · ${usable} usable numbers · ${unusable} unusable`,
  previewUnusable: ({ examples }: { examples: string }) => `Unusable, for example: ${examples} (kept in the report)`,
  previewCountries: ({ list }: { list: string }) => `Countries: ${list}`,
  previewPrompt: 'Use this file? (Enter = continue, b = pick another): ',
  appsTitle: 'Which apps?',
  appsHint: '↑↓ move · space ticks · Enter start · b back',
  appsPickNone: 'Tick at least one app with the space bar.',
  accountsTitle: 'Accounts',
  accountsActionHint: '↑↓ move · r reset cooldown · l log in again · b back',
  pressEnterForMenu: 'Press Enter for the menu.',
  guidePage: ({ n, m }: { n: number; m: number }) => `Guide and warnings · page ${n} of ${m}`,
  guideNext: 'Enter = next page · b back',
  qrGateTooSmall: ({ cols, rows, needCols, needRows }: { cols: number; rows: number; needCols: number; needRows: number }) =>
    `This window is ${cols} x ${rows}; the code needs ${needCols} x ${needRows}.`,
  qrGateEnlarge: 'Enlarge the window (drag a corner), or press Cmd+minus once to shrink the text.',
  qrGateAltWhatsapp: 'use the pairing code instead',
  qrGateAltTelegram: 'use the phone-number code instead',
  qrGatePrompt: ({ alt }: { alt: string }) =>
    `Enlarge the window, then press Enter to try again${alt === '' ? '' : `, or type c to ${alt}`} (b = back): `,
  tgLoginTitle: 'Log in to Telegram',

  // v0.2.0: live run dashboard, run log, summary, --plain flag.
  dashTitle: ({ file, numbers }: { file: string; numbers: number }) => `Checking ${file} · ${numbers} numbers`,
  dashElapsed: ({ time }: { time: string }) => `Elapsed ${time}`,
  dashSpeed: ({ rate }: { rate: number }) => `${rate}/min`,
  dashEta: ({ left, clock }: { left: string; clock: string }) => `about ${left} left · finish about ${clock}`,
  dashColApp: 'APP',
  dashColAccount: 'ACCOUNT',
  dashColState: 'STATE',
  dashColDone: 'DONE',
  dashColStatus: 'RESULTS',
  dashColLast: 'LAST',
  dashWorking: 'working',
  dashWaiting: 'waiting',
  dashResting: ({ clock, left }: { clock: string; left: string }) => `resting · resumes ${clock} (in ${left})`,
  dashDisabled: 'disabled',
  dashDone: 'done',
  dashStatusCounts: ({ yes, notFound, unknown }: { yes: number; notFound: number; unknown: number }) =>
    `${yes}y ${notFound}nf ${unknown}u`,
  dashChecks: ({ done, total, numbers, apps }: { done: number; total: number; numbers: number; apps: number }) =>
    `${done} of ${total} checks (${numbers} numbers x ${apps} ${apps === 1 ? 'app' : 'apps'})`,
  dashCounts: ({ yes, notFound, unknown }: { yes: number; notFound: number; unknown: number }) =>
    `yes ${yes} · not_found ${notFound} · unknown ${unknown}`,
  dashHintStop: 'Ctrl+C finishes this batch and saves the report.',
  dashDetailsFile: ({ path }: { path: string }) => `Log: ${path}`,
  progressPercent: ({ percent, done, total }: { percent: number; done: number; total: number }) =>
    `progress ${percent}% ${done}/${total}`,
  progressEta: ({ time }: { time: string }) => `ETA ${time}`,
  progressPacing: ({ time }: { time: string }) => `pacing ${time}`,
  progressRestingUntil: ({ clock }: { clock: string }) => `resting until ${clock}`,
  summaryDone: ({ time, numbers, unfinished }: { time: string; numbers: number; unfinished: number }) =>
    `Done in ${time} · ${numbers} numbers · ${unfinished} unfinished`,
  summaryNumbers: ({ total, valid, invalid }: { total: number; valid: number; invalid: number }) =>
    `Numbers: ${total} unique (${valid} valid, ${invalid} invalid)`,
  summaryAccountsUsed: ({ list }: { list: string }) => `Accounts used: ${list}`,
  summaryColApp: 'app',
  summaryColYes: 'yes',
  summaryColNotFound: 'not_found',
  summaryColUnknown: 'unknown',
  summaryColSkipped: 'skipped',
  summaryColInvalid: 'invalid',
  summaryColCountry: 'country',
  summaryYesByCountry: 'Registered (yes) by country:',
  summaryStale: ({ apps, count }: { apps: string; count: number }) =>
    `STALE: ${apps} — ${count} yes/not_found ${count === 1 ? 'result is' : 'results are'} older than the max age or dated in the future ` +
    '(see <app>_checked_at / <app>_stale in the report): kept, not re-confirmed.',
  summaryFootnote:
    '`not_found` can also mean the person hides their number from search; `unknown` = not checked yet or throttled.',
  cliNoValidNumbers: ({ invalid }: { invalid: number }) =>
    `no valid phone numbers (${invalid} invalid); check --column and the file's phone column and country codes`,
  cliCsvColumn: ({ name }: { name: string }) => `column "${name}"`,
  cliCsvColumnIndex: ({ index }: { index: string }) => `column ${index} (no header row)`,
  cliCsvRead: ({ file, labelled, rows, unique, invalid, duplicates }: { file: string; labelled: string; rows: number; unique: number; invalid: number; duplicates: number }) =>
    `${file}: using ${labelled}; ${rows} ${rows === 1 ? 'row' : 'rows'}, ${unique} unique` +
    `${duplicates === 0 ? '' : `, ${duplicates} ${duplicates === 1 ? 'duplicate' : 'duplicates'} merged`}, ${invalid} invalid`,
  cliReportWritten: ({ path }: { path: string }) => `Report written to ${path}`,
  cliInterruptOnce: 'Interrupt received: finishing the current batch, then writing the report (Ctrl-C again to force quit)...',
  cliInterruptOnceParallel:
    'Interrupt received: waiting for the batches in flight, then writing the report (Ctrl-C again to force quit)...',
  cliInterruptTwice: 'Second interrupt, exiting now.',
  cliWarnNoValid: ({ reason }: { reason: string }) => `WARNING: ${reason}. The report above lists only invalid rows.`,
  cliColApp: 'app',
  cliColAccount: 'account',
  cliColState: 'state',
  cliColUsedToday: 'used today',
  cliColBatchTime: 'batch time (avg / last)',
  cliAccountReady: 'ready',
  cliAccountDisabled: ({ reason }: { reason: string }) => `DISABLED: ${reason}`,
  cliAccountCooling: ({ time }: { time: string }) => `cooling down until ${time}`,
  cliNoAccounts: 'No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).',
  cliNoResetState: ({ app, account }: { app: string; account: string }) =>
    `No recorded state for ${app} account "${account}"; nothing to reset.`,
  cliResetDone: ({ app, account }: { app: string; account: string }) =>
    `Cleared cooldown and disabled flag for ${app} account "${account}".`,
  revealPrompt: 'o = show in Finder · Enter = menu',
  revealDone: 'The report is shown in Finder.',
  revealFailed: 'Could not open Finder; the path is above.',
  schNoAccounts: ({ numbers, app }: { numbers: number; app: string }) =>
    `no accounts, ${numbers} ${numbers === 1 ? 'number' : 'numbers'} left unchecked. Run: login ${app} --account <name>`,
  schToCheck: ({ numbers, accounts }: { numbers: number; accounts: number }) =>
    `${numbers} ${numbers === 1 ? 'number' : 'numbers'} to check with ${accounts} ${accounts === 1 ? 'account' : 'accounts'}`,
  schFailedBefore: ({ count }: { count: number }) =>
    `${count} ${count === 1 ? 'number' : 'numbers'} failed in an earlier run: checking them last, one by one`,
  schRateLimited: ({ account, time }: { account: string; time: string }) => `${account}: rate limited, resting until ${time}`,
  schBanned: ({ account, reason, app }: { account: string; reason: string; app: string }) =>
    `WARNING ${account}: account disabled (${reason}). Fix it, then: login ${app} --account ${account}`,
  schBatchError: ({ account, errors, max, reason }: { account: string; errors: number; max: number; reason: string }) =>
    `${account}: error (${errors}/${max}): ${reason}`,
  schParked: ({ count, failures }: { count: number; failures: number }) =>
    `${count} ${count === 1 ? 'number' : 'numbers'} failed ${failures} times in a run that otherwise works; ` +
    'leaving them unknown for this run (no account is put on cooldown for it)',
  schDropped: ({ account }: { account: string }) => `${account}: dropped for the rest of this run after repeated errors`,
  schBatchTimeout: ({ account, count }: { account: string; count: number }) =>
    `${account}: a batch of ${count} ${count === 1 ? 'number' : 'numbers'} did not return in time; its numbers stay unknown and count against today's cap`,
  schNoUsable: ({ count }: { count: number }) =>
    `no usable account left (disabled or failing), ${count} ${count === 1 ? 'number' : 'numbers'} unchecked`,
  schAllBlockedNowait: ({ count }: { count: number }) =>
    `all accounts are cooling down or at their daily cap, ${count} ${count === 1 ? 'number' : 'numbers'} unchecked (--no-wait)`,
  schAllResting: ({ time, count }: { time: string; count: number }) =>
    `all accounts are resting; resuming at ${time} (${count} left)`,
  schChecked: ({ account, count, left }: { account: string; count: number; left: number }) =>
    `${account}: ${count} checked, ${left} left`,
  schCloseError: ({ account, reason }: { account: string; reason: string }) =>
    `${account}: error while closing session: ${reason}`,
  schStoppedByError: ({ reason }: { reason: string }) => `stopped by an unexpected error: ${reason}`,
  runComplete: 'all conclusive',
  runNotConclusive: 'finished, NOT conclusive',
  runStopDone: 'finished',
  runStopAborted: 'interrupted',
  runStopNoAccounts: 'no usable account',
  runStopBlocked: 'blocked',
  runStopAdapterError: 'adapter could not load',
  runKept: ({ count }: { count: number }) => `, ${count} keep an older result`,
  runLine: ({ app, needed, attempted, conclusive, inconclusive, kept, remaining, label }: { app: string; needed: number; attempted: number; conclusive: number; inconclusive: number; kept: string; remaining: number; label: string }) =>
    `${app}: needed ${needed}, attempted ${attempted}, conclusive ${conclusive}, ` +
    `inconclusive ${inconclusive}${kept}, no answer ${remaining} (${label})`,
  runIncomplete: ({ inconclusive, needed }: { inconclusive: number; needed: number }) =>
    `INCOMPLETE: ${inconclusive} of ${needed} ${needed === 1 ? 'check has' : 'checks have'} no fresh yes/not_found answer.`,
  runNotFinal:
    'The report is NOT final: cells marked unknown are unchecked, and an older yes/not_found may be outdated.',
  runAppLine: ({ app, inconclusive, attempted, conclusive }: { app: string; inconclusive: number; attempted: number; conclusive: number }) =>
    `${app}: ${inconclusive} inconclusive (${attempted} attempted, ${conclusive} conclusive)`,
  runReasonNoAccounts: ({ app }: { app: string }) =>
    `no_accounts: no usable ${app} account (log in, or fix a disabled one: login ${app} --account <name>)`,
  runReasonAdapterError: ({ app }: { app: string }) => `adapter_error: the ${app} adapter could not be loaded`,
  runReasonAborted: 'aborted: the run was interrupted',
  runReasonCooldown: 'cooldown: every account is resting after a rate limit or an error',
  runReasonDailyCap: 'daily cap: every usable account reached its daily limit',
  runReasonErrors: ({ count }: { count: number }) => `errors: ${count} ${count === 1 ? 'batch' : 'batches'} failed`,
  runReasonParked: ({ batches, numbers }: { batches: number; numbers: number }) =>
    `parked batches: ${batches} ${batches === 1 ? 'batch' : 'batches'}, ${numbers} ${numbers === 1 ? 'number' : 'numbers'}, given up for this run`,
  runReasonUnknown: ({ count }: { count: number }) =>
    `unknown answers: ${count} ${count === 1 ? 'number' : 'numbers'} came back unknown`,
  runReasonNotReached: 'not_reached: some numbers were not checked',
  runResumeHint: 'Run the same command again to continue (finished numbers are not repeated).',
  runResumeAt: ({ time }: { time: string }) =>
    `Next resume: ${time}. Run the same command again then (finished numbers are not repeated).`,
  themeAuto: 'Auto (detect from terminal)',
  themeDark: 'Dark',
  themeLight: 'Light',
  themeHighContrast: 'High contrast',
};
