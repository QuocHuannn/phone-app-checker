# phone-app-checker - macOS install guide (Apple Silicon)

Vietnamese version: install-macos.vi.md

> **Use responsibly.** phone-app-checker checks a list of phone numbers to see whether each one has a Telegram, WhatsApp, Zalo, Viber or LINE account, using *unofficial* methods. This may **violate each platform's terms of service**, and the accounts used for checks can be restricted or banned. Use only **dedicated SIMs/accounts you can afford to lose**; never a personal number or a number that serves your business. Only check numbers of people who have agreed to be contacted. The tool does **not** verify that consent. The project is not affiliated with Telegram, WhatsApp, Zalo, Viber or LINE. Results are observations, not proof: `not_found` can mean the person hides their number from search; LINE is only meaningful for HK/JP/KR/TW/TH; Zalo checks only `+84` numbers. Check the privacy law where you live (this is not legal advice). Read [responsible-use.md](responsible-use.md) before you run anything.
>
> This build has only been tested automatically on a development Mac (macOS 27, Apple Silicon). **Only WhatsApp has been tried against the real service (one account, a few lookups). Telegram, Zalo, Viber and LINE have not been verified on the live platforms, and the archive has not been tested on your Mac or on macOS 13.5.** A `yes` or `not_found` result is an observation at one point in time. It does not confirm who the person is, whether the account is still active, or that the answer stays the same. Cross-check manually as described in section 12 before you trust any result.

## Quick start: install once, then just type `phone-app-checker`

1. Install (section 4): `bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/install.sh`.
2. Open a **new** Terminal window, type exactly this command and nothing else, then press Enter:

   ```sh
   phone-app-checker
   ```

3. A **menu** appears: a title box with the version, an `Accounts ready:` line showing which apps have an account, and a coloured list. The menu is in **English** by default. To switch to Vietnamese, press `L`, then `2` (Tiếng Việt). The choice is remembered (see "Menu language" below). **Use the arrow keys ↑ ↓ and Enter**, or press a menu number (`1`–`6`, `L`, `0`) directly, without Enter. Press `q` or `Esc` to quit (or to go back from a sub-list). After each task the menu returns to the list. Ctrl-C or Ctrl-D also quit cleanly. If the Terminal does not support this (for example `NO_COLOR` is set or `TERM=dumb`), the menu falls back to the classic style: type a number and press Enter.

   | Key | Menu item (English label) | What it does |
   | --- | --- | --- |
   | 1 | `Check a CSV file` | **Drag the CSV file from Finder into the Terminal window**, press Enter, choose the app, then choose where to save the report (by default `report.csv` next to the CSV file). If a file with that name exists, the menu asks before overwriting it. If no account is logged in yet, the menu says so and offers to log in now. |
   | 2 | `Log in an app account` | Choose an app and name the account (Enter = `default`). WhatsApp and Telegram also ask how to log in (QR code, or pairing code / phone number + code). Telegram asks for `api_id` and `api_hash` once and saves them to the config file (section 6.1). The QR code appears directly in the window (section 6.0). |
   | 3 | `View logged-in accounts` | Runs `accounts` (section 8). |
   | 4 | `Rebuild the latest report` | Runs `report`: rebuilds the report from saved results, without checking anything new. |
   | 5 | `Check this Mac is ready (doctor)` | Runs `doctor` (section 5). Still an offline check; it does not prove that an account works. |
   | 6 | `Guide / warnings` | Short guide and warnings: you need the consent of the person whose number is checked; `not_found` may mean they hid their number; LINE is only meaningful for HK/JP/KR/TW/TH; Zalo only `+84` numbers; risk of account restriction. |
   | L | `Language / Ngôn ngữ / …` | Change the menu language (see below). |
   | 0 | `Quit` | Quit. |

   Each menu item runs the matching command. If a command fails, the menu prints the error and stays open. The menu **only opens when you type `phone-app-checker` with nothing after it**. In scripts, or when you type a sub-command (`check`, `login`, `doctor`, …), everything runs as before (section 8 lists them).

   **Menu language.** The menu is **English by default**, even on a Mac set to Vietnamese. Press `L` and Enter to choose: `1` English, `2` Tiếng Việt, `3` Bahasa Indonesia, `4` Bahasa Melayu, `5` 한국어, `6` 简体中文. The change takes effect at once and is remembered for the next launch. It is stored in a file called `menu-language` in the data folder `~/Library/Application Support/phone-app-checker`; that file is deleted with the folder when you uninstall with `--purge-data`. To change language for one run without saving it: `phone-app-checker --lang vi`, or set `PHONE_APP_CHECKER_LANG=vi`. Priority: `--lang`, then the environment variable, then the saved choice, then English. An invalid value gives English without an error. Language codes: `en`, `vi`, `id`, `ms`, `ko`, `zh`. If the menu is in a language you cannot read, the line `L. Language / Ngôn ngữ / Bahasa / 언어 / 语言` is always shown on every menu screen. Just type `L`.

   > **Honesty about translations:** English and Vietnamese are the reference versions of the menu. The **Bahasa Indonesia, Bahasa Melayu, 한국어 and 简体中文 versions are first drafts made by machine translation and have not been reviewed by native speakers.** They may contain mistakes or sound unnatural. Only the menu is translated. The messages of `doctor`, `check`, `login` and the other commands stay in English, and this guide is in English. If you are a native speaker and see a mistake, please report it so it can be fixed.

   **What you will see on each screen.** These are text captures from an automated test run in an 80x24 window. They are illustrations only and were **not** run with real accounts. Colours and icons look different in a real Terminal.

   - *Main menu*: title box with the version, the status of each app (`✅` account present and the count, `⬜` none yet), a list with icons, and a key-hint line at the bottom.

     ```text
     ╭─ Phone App Checker 0.1.0 ──────────────────────────────────────────
     │ Accounts ready:
     │ ⬜ telegram – · ✅ whatsapp 1 · ⬜ zalo – · ⬜ viber – · ⬜ line –
     ╰────────────────────────────────────────────────────────────────────
     ❯ 1 🔍 Check a CSV file
       2 🔑 Log in an app account
       ...
       0 🚪 Quit
     ↑↓ move · Enter select · q quit
     ```

   - *Telegram login* (menu `2` → Telegram): before asking anything, the screen explains the **3 steps** and **why keys are needed**. Telegram requires every login program to have an `api_id` and `api_hash`. They are free, you create them once, and each person creates their own. This tool does not ship shared keys, because that breaks Telegram's rules and could get accounts banned. **The QR code only appears in Step 3, right after the keys are saved.** If keys are already saved, the screen shows `API keys found` and jumps to Step 3.

     ```text
       Step 1/3 - Get your free Telegram API keys (one-time)
       Step 2/3 - Save the keys
       Step 3/3 - Scan the QR code (or enter phone + code)
     Why keys? Telegram requires them from every program that logs in to Telegram.
     The QR code appears in Step 3, right after the keys are saved.
     Account name (Enter = default):
     ```

     Step 1 prints <https://my.telegram.org/apps>, explains what to fill in the form (`App title` and `Short name` can be anything, `Platform: Other`), and asks `Open https://my.telegram.org/apps in your browser now? (Y/n …)`. The Mac only opens the browser if you answer **y**. Step 2 asks for `api_id` (digits only), then `api_hash` (32 characters, `0-9` and `a-f`). While you type or paste the hash, only `••••` is shown, never the value. Mistakes get a clear message, for example pasting the `api_hash` into the `api_id` field, or a wrong length. Type `b` or press Enter in these fields to go back. Step 3: choose the QR code or phone number + code. When the scan is done, the screen shows the linked account name and the phone number **partly masked**. The session itself is never shown.

   - *Waiting for QR scan / connecting*: a spinner shows `⠋ Connecting to Telegram...` and `⠋ Waiting for you to scan the code...`. These only appear in an interactive Terminal; through a pipe or a log file nothing extra is printed.
   - *Telegram rejects something*: each error is one clear sentence, for example `Telegram rejected the api_id / api_hash (API_ID_INVALID). Copy both values again from https://my.telegram.org/apps, …`. `FLOOD_WAIT` tells you how long to wait.
   - *Checking in progress* (menu `1`): one progress line that redraws in place:

     ```text
     ⠹ ████████░░░░░░░░░░░░░░░░░░░░  27% 30/108  telegram 12/36 · whatsapp 12/36 · zalo 6/36
     ```

     It shows the percentage, done/total, the count for each app, an estimated remaining time (`ETA`, shown after a few seconds), and when an account is resting, `pacing 4 s` or `resting until 14:05`. Press Ctrl-C once: the run stops cleanly and the report is saved.
   - *Result*: a coloured summary table (`yes` green, `not_found` yellow, `invalid` red, `unknown`/`skipped` dimmed), then a final box:

     ```text
     ╭─ Report saved to /tmp/ux/report.csv ──────────────────────────────
     │ ⚠ INCOMPLETE: the report is NOT final. Numbers without a fresh
     │ answer: 18.
     │ Run the same check again with the same file to continue; finished
     │ numbers are not repeated.
     │
     │ Next: open the file with Excel or Numbers (double-click it).
     │ To show it in Finder, type: open -R '/tmp/ux/report.csv'
     ╰───────────────────────────────────────────────────────────────────
     ```

     If every number has a result, the box is green and has no `INCOMPLETE` part. If some numbers still have no result, the box is yellow, the warning line is **bold and red**, and the report is **not final**: run the same command again to continue. Numbers already done are not asked again. Very long paths are cut on the left (for example `…/Customers/report.csv`) so the box does not break; the full path is on the `Report written to …` line just above the box.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Check the downloaded files](#2-check-the-downloaded-files)
3. [Unpack the archive](#3-unpack-the-archive)
4. [Install](#4-install)
5. [First-time setup and `doctor`](#5-first-time-setup-and-doctor)
6. [Log in accounts for each app](#6-log-in-accounts-for-each-app)
7. [The list of numbers (CSV file)](#7-the-list-of-numbers-csv-file)
8. [Run checks, view reports, view accounts](#8-run-checks-view-reports-view-accounts)
9. [Reading the results in the report](#9-reading-the-results-in-the-report)
10. [Where the data lives](#10-where-the-data-lives)
11. [Privacy and safety](#11-privacy-and-safety)
12. [Suggested trial procedure and sending results back](#12-suggested-trial-procedure-and-sending-results-back)
13. [Updating, rolling back, uninstalling](#13-updating-rolling-back-uninstalling)
14. [Common problems](#14-common-problems)

---

## 1. What you need

- A Mac with an **Apple Silicon** chip (M1, M2, M3, M4 …). Check: Apple menu → *About This Mac* → the **Chip** line must say "Apple M…". Intel Macs **cannot** run this build.
- **macOS 13.5 or later** (Apple menu → *About This Mac* → version, or `sw_vers -productVersion` in Terminal). The 13.5 minimum comes from the bundled Node.js. Every executable in the package has been checked to declare a minimum of 13.5 or lower, but that is only a check of file metadata. **It has not been run on macOS 13.5**; the only run was on macOS 27. If your Mac runs macOS 13.x or 14.x, include the exact version when you send results back (section 12).
- The Terminal app (built into macOS). If your Terminal runs in Rosetta (Intel) mode, turn that off (see section 14).
- About 600 MB of free disk space (download about 65 MB, unpacked folder about 240 MB, installed copy about 240 MB; you can delete the download and the unpacked folder after installing).
- Each app you want to check needs its **own account**, and that account's phone/SIM must be nearby when you log in for the first time (to receive codes or scan QR codes).
- **Viber only**: an Android phone (or Android emulator) plus the **`adb`** tool (Android platform-tools). `adb` is **not** in the download. Viber setup is technically complex (several hours), so leave it for later (section 6.4). You can skip Viber and still use the other four apps.

## 2. Check the downloaded files

Download both files from the project's GitHub Releases page, <https://github.com/QuocHuannn/phone-app-checker/releases>, into the same folder (for example *Downloads*):

- `phone-app-checker-0.1.0-macos-arm64.tar.gz`
- `phone-app-checker-0.1.0-macos-arm64.tar.gz.sha256`

Check that the file was not corrupted or changed in transit:

```sh
cd ~/Downloads
shasum -a 256 -c phone-app-checker-0.1.0-macos-arm64.tar.gz.sha256
```

Correct result:

```
phone-app-checker-0.1.0-macos-arm64.tar.gz: OK
```

If you see `FAILED` or `No such file`: **stop**. Do not unpack the archive. Download both files again, or make sure you are in the folder that contains them (the `cd` command above).

> `.sha256` only detects a file that is damaged or changed *compared with the `.sha256` file next to it*. Download both files only from this project's GitHub Releases page.

> The first time Terminal reads a file in *Downloads*, macOS may ask "Terminal would like to access files in your Downloads folder". Click **Allow**. If you clicked Don't Allow by mistake, or you get `Operation not permitted`, see section 14.

## 3. Unpack the archive

Option 1 (Finder): double-click the `.tar.gz` file in *Downloads*. A folder `phone-app-checker-0.1.0-macos-arm64` appears.

Option 2 (Terminal):

```sh
cd ~/Downloads
tar -xzf phone-app-checker-0.1.0-macos-arm64.tar.gz
```

The folder contains: `install.sh`, `uninstall.sh`, `INSTALL.md` (English guide), `INSTALL.vi.md` (Vietnamese guide), `LICENSE`, `THIRD_PARTY_LICENSES.md`, `VERSION`, `phone-app-checker`, `runtime/` (bundled Node.js) and `app/`.

## 4. Install

```sh
bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/install.sh
```

> Run it with `bash …` as shown. **Do not double-click `install.sh`** in Finder: macOS may block it or open it with another app.

The installer does not need an administrator password (it does not use `sudo`):

1. Checks the Mac: Apple Silicon chip (not a Rosetta Terminal), macOS ≥ 13.5. If a check fails, it prints the reason and stops, without changing anything.
2. Holds a "maintenance lock" until installation finishes. While it is held, no `phone-app-checker` command can run or open the data. If a command is already running, the installer waits about 3 seconds and then **refuses** (section 14).
3. Copies the program into a temporary folder next to the install location, then swaps it into `~/Applications/phone-app-checker/0.1.0`. An older copy with the same version number (if any) is **kept until the new copy runs `phone-app-checker --version` successfully**. On error or interruption it goes back to the old copy.
4. Removes macOS's "downloaded from the Internet" mark (quarantine) from the installed copy, so Gatekeeper does not block it.
5. Creates the `phone-app-checker` command in `~/.local/bin` and, if needed, adds a small block to `~/.zprofile` (or `~/.bash_profile`) so Terminal can find it. The shell file is written to a temporary file in the same folder, then renamed over the original (permissions kept; never left half-written). The block sits between `# >>> phone-app-checker >>>` and `# <<< phone-app-checker <<<` and is removed when you uninstall.
6. Runs `phone-app-checker --version` and `phone-app-checker doctor` (see section 5).

At the end, the installer prints the install path, the config file path, and how to delete older copies if there are any. **The first summary line never says "done" by itself**:

- If `doctor` has no `FAIL`, it prints `Đã chép file / Files installed: phone-app-checker 0.1.0 (doctor: không có FAIL / no FAIL)` (*Files copied; doctor: no FAIL*), followed by `NOT yet trustworthy: doctor checks offline readiness only. Run login, then a small trial with known-truth numbers.` This means the files are copied. It does **not** mean you have logged in, and it does **not** mean the tool has been tested against known answers (sections 6 and 12).
- If `doctor` reports `FAIL`, it prints `CHƯA SẴN SÀNG / NOT READY: phone-app-checker 0.1.0 đã được chép vào máy nhưng doctor báo FAIL (mã / exit 1).` (*Not ready: copied, but doctor reports FAIL*). The files stay on the Mac, so `install.sh` exits with code `0`. **Do not** treat that exit code as "it works". Fix every `FAIL` line above, then run `phone-app-checker doctor` again until no `FAIL` remains.

When you uninstall, the PATH block in `~/.zprofile`/`~/.bash_profile` is only removed if its two marker lines are **still exactly as written** (no extra spaces or comments at the end of the line) and come in matching pairs. If you have edited them, the uninstaller **does not touch** the file and prints instructions instead: delete the lines from `# >>> phone-app-checker >>>` to `# <<< phone-app-checker <<<` yourself. If `~/.zprofile` (or `~/.bash_profile`) **was created by the installer** (it did not exist before) and becomes empty after the PATH block is removed, the empty file is deleted too. A file that existed before, including an empty one, or that still has other content, is **always kept**. The record of "files created by the installer" is in `~/Applications/phone-app-checker/.created-profiles` (deleted with the install folder).

**Open a new Terminal window** (or close and reopen Terminal), then try:

```sh
phone-app-checker --version
```

It must print `0.1.0`. If it says `command not found`, see section 14.

Then type `phone-app-checker` on its own to open the menu (see "Quick start" at the top). Sections 5 to 8 describe the same tasks as typed commands, and work alongside the menu.

Running the same install command several times is safe. While **any** `phone-app-checker` command is running (`check`, `login`, `report`, `accounts`, `account-reset`, `doctor`), installing, reinstalling or uninstalling is **refused** (after about 3 seconds of waiting, it prints the process ID). The reverse also holds: while an install or uninstall runs, those commands refuse to start. Wait for the other side to finish, then try again (section 14). **If an install was cut off suddenly** (power loss, force-quitting Terminal, `kill -9`), running `install.sh` again is **refused**, because a leftover lock file `maintenance.lock` (in `~/Library/Application Support/phone-app-checker-lifecycle/`) remains. The error message gives the full path of that file. Do this in order: (1) make sure no `install.sh`, `uninstall.sh` or `phone-app-checker` command is running (`ps aux | grep phone-app-checker`; after a restart, nothing is running); (2) delete the `maintenance.lock` file named in the message (`rm ~/Library/Application\ Support/phone-app-checker-lifecycle/maintenance.lock`). The program **deliberately does not delete this file itself**; (3) run `install.sh` again from the downloaded package. It then restores any leftover old copy (`~/Applications/phone-app-checker/.replaced.<version>.*`) and cleans up the temporary `.incoming.*` folders. While you wait, `phone-app-checker --version` still runs, but the other commands refuse to start and name the file to delete. If a `phone-app-checker` command that does not belong to this program already exists in `~/.local/bin`, the installer stops and does not overwrite it. Rename or delete it, then run the installer again.

## 5. First-time setup and `doctor`

The first run creates the data folder and a config file:

```
~/Library/Application Support/phone-app-checker/checker.config.json
```

Open the file with TextEdit:

```sh
open -e ~/Library/Application\ Support/phone-app-checker/checker.config.json
```

> **Important: turn off "Smart Quotes" before typing.** TextEdit automatically changes straight quotes `"` into curly quotes `“ ”`. That breaks the JSON file, and `doctor` reports `FAIL config … curly quotes at line …`. In TextEdit, open *Edit → Substitutions* and untick **Smart Quotes** (and **Smart Dashes**), then type. An alternative without TextEdit: `nano ~/Library/Application\ Support/phone-app-checker/checker.config.json` (save: Ctrl+O then Enter; exit: Ctrl+X). If you paste an `apiHash` from the website, paste it between the straight `"` quotes that are already there, rather than retyping the quotes.

> **The config file must be plain text, named exactly `checker.config.json`, with the `.json` extension.** TextEdit can save *Rich Text*: if the *Format* menu has **Make Plain Text** (Shift + Cmd + T), choose it before saving. Do not let TextEdit add a `.rtf` or `.txt` extension: `checker.config.json.txt` is a different file, the program does not read it, and it keeps using the old file. `nano` (above) is the lowest-risk option.

Places you will usually need to edit:

**a) Telegram `apiId` / `apiHash`** (required if you use Telegram). **Easiest: you do not need to edit the file.** Menu 2 → Telegram asks for these two values and saves them (section 6.1). To fill them in by hand, get them at <https://my.telegram.org/apps> using the phone number of the account you will check with (full steps: section 6.1). Put them in exactly this place: `apiId` is a number (no quotes), and `apiHash` goes inside double quotes:

```json
"telegram": {
  "enabled": true,
  "options": {
    "apiId": 1234567,
    "apiHash": "0123456789abcdef0123456789abcdef"
  }
}
```

(In the real file, other keys such as `batchSize` and `dailyCap` sit in the same `telegram` block. Keep them. Only change `apiId` and `apiHash`.)

**b) Turn each app on or off** with `"enabled": true` or `false`. By default Telegram, WhatsApp and Zalo are **on**; Viber and LINE are **off**.

**c) `defaultRegion`** (default `"VN"`): the country used for numbers written without a country code, for example `0901234567`.

Rules when editing JSON: keep the `"`, `,`, `{` and `}` characters (quotes must be straight quotes), and no extra comma after the last item. If the syntax is wrong, `doctor` reports `FAIL config` with the position (line, column). The program deliberately does not print the file contents, so your `apiHash` is never exposed. Keys **outside the `options` block** that are not in the sample file are rejected, so a typo is not silently ignored. Inside `options` you may add app-specific settings (for example `adbPath` for Viber). `batchSize` and `dailyCap` must be whole numbers ≥ 1. `defaultRegion` must be a real country code (`VN`, `GB`, **not** `UK`). Time values are milliseconds and at most one year. `dataDir` must not be empty. A file saved from Notepad (with a BOM) still reads correctly. To restore the original: rename the current config file (for example add `.bak`), then run `phone-app-checker doctor`; the program creates a new file.

Save the file (Cmd + S), then run:

```sh
phone-app-checker doctor
```

`doctor` prints a table. Each row shows a level, the check name and the details:

| Level | Meaning | What to do |
| --- | --- | --- |
| `OK` | This item is ready. | Nothing. |
| `WARN` | A setup step is not finished (for example `apiId`/`apiHash` not entered, no account logged in, no Android device seen for Viber). **It still runs**, but that app cannot be used yet. | Follow the hint at the end of the row. On the first install, `WARN` rows are normal. |
| `FAIL` | The program cannot run (bad config file, wrong permissions on the data folder, `adb` missing while Viber is enabled, …). | Fix what the row describes, then run `doctor` again. |

`doctor` exits with an error code only if there is a `FAIL`. Repeat until there is **no `FAIL`**. Rows for all five apps (telegram, whatsapp, zalo, viber, line) are always present, including disabled apps. `OK … disabled (module loads)` means the program could load that app's module.

**`doctor` only tells you the Mac is ready *offline*** (the Mac, the config, the data folder, that modules load, that the accounts folder exists). `OK` does **not** mean an account is still logged in or that an app still answers correctly. You only learn that after you `login` and run a trial on about 20 numbers whose answers you already know (section 12). `doctor` reads no phone numbers and does not connect to any messaging app. For that reason `doctor` **always** ends with these three lines, whether or not there is a `FAIL`:

```
NOTE: doctor checks offline readiness only (no live account authentication).
OK does not prove an account can check numbers: run `phone-app-checker login <app> --account <name>`,
then a small trial on numbers whose answers you already know, before trusting any result.
```

The first run of `doctor` also creates a `data/` folder inside the data folder (section 10).

## 6. Log in accounts for each app

Each account logs in **once**. The session is saved, so you are not asked again next time. Give each account a short name (`--account`): 1–32 characters, letters, digits, `-` and `_` only (for example `tg1`, `wa1`). You can log in several accounts for one app to spread the load. Logins must run in a real Terminal window (interactive keyboard input), one `login` command at a time.

Check at any time:

```sh
phone-app-checker accounts
```

Each account line shows `ready`, `cooling down until …` (resting, see "Rate limiting" in section 14), or `DISABLED: <reason>` (needs a person to act).

Detailed guides, prompts and error meanings for each app are in the documentation folder of the installed copy: `~/Applications/phone-app-checker/current/app/docs/`. Open it with `open ~/Applications/phone-app-checker/current/app/docs`.

### 6.0 If the QR code does not appear or cannot be scanned

- The QR code is drawn in **fixed colours** (pure black on white, with a white border), so it scans in both dark and light Terminal themes. Hold the phone at a comfortable distance and keep the screen bright.
- A WhatsApp code is about 35 lines tall and about 70 columns wide. If the Terminal window is too small (the default 80x24 is **not enough**), the program does **not** draw a cut or broken code. It prints how many columns × rows are needed. Make the window bigger (drag it or use the green full-screen button), or press **Cmd + minus** to make the text smaller. The code appears by itself once the window is big enough.
- Codes change all the time (WhatsApp about every 20 seconds, Telegram about every 30 seconds). A new code replaces the old one in place. Scan the code that is currently showing.
- If `NO_COLOR` is set or you are not in a Terminal, the program prints a text version made of `##` characters with a note. That version only works on a **light** background.

### 6.1 Telegram

Menu **2 → Telegram** does all of the following without editing any file:

1. **Step 1/3 – get the keys (once, free).** If you do not have `api_id` / `api_hash` yet, the menu explains why they are needed, prints <https://my.telegram.org/apps>, and asks whether to open that page in the browser (answer `y`; the browser only opens if you agree). On the page: log in with the phone number of the account you will check with, fill in the form (**App title** and **Short name** can be anything, for example `Checker` and `checker1`; **Platform**: choose `Other`; leave the other fields empty), then click **Create application**. Copy the `api_id` (a short number) and the `api_hash` (32 characters).
2. **Step 2/3 – save the keys.** Type or paste the `api_id` (digits only), then the `api_hash` (exactly 32 characters, `0-9` and `a-f`). The `api_hash` **is not shown while you type** (only `••••`, so you can see the paste worked), and it is never printed again. Type `b` or press Enter to go back from any field. The menu checks the format, shows a clear error if you made a mistake, then saves the keys to the config file (written atomically, permissions 600, other settings unchanged). If keys are already saved, the menu shows `API keys found` and skips these two steps. *(The old way still works: fill them in by hand as in section 5a, or set the environment variables `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`. A value in the file takes priority.)*
3. **Step 3/3 – scan the QR code (or use phone number + code).** Choice `1)` scans the QR code with the Telegram app (the default): *Settings → Devices → Link Desktop Device*. Choice `2)` enters your phone number, then the Telegram code sent to you. The Telegram QR code changes about every 30 seconds (each new code replaces the old one). If the account has two-step verification, the program asks for the password after the scan; typing does not show characters. When the scan is done, the screen shows the account name and the phone number, partly masked. If nobody scans within 5 minutes, you get an error and must run it again. For choice 2: enter the phone number in international format (`+84…`), then the Telegram code sent to you (typing shows no characters), then the two-step password if there is one.

Run it directly: `phone-app-checker login telegram --account tg1 --method qr` (or leave out `--method` to enter a phone number + code). Press Ctrl-C to cancel.

Brand-new Telegram accounts are often restricted quickly. Use the account normally for a few days before running bulk checks.

### 6.2 WhatsApp

```sh
phone-app-checker login whatsapp --account wa1
```

Menu **2** asks: `1)` link by phone number: enter the 8-character pairing code shown on the phone (**recommended**, the default, press Enter), or `2)` scan a QR code.

- **Pairing code (recommended):** the menu asks for the phone number of the WhatsApp account to link (with its country code; a wrong number is asked again), then prints an 8-character code in the form `ABCD-1234`. On the phone: *WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead*, then enter the code. You do not need to edit the config file. Run it directly: `phone-app-checker login whatsapp --account wa1 --method code --phone +84901234567`. When it is done, the menu prints `Logged in...` once and suggests **choose 1 to check a CSV file**.
- **QR:** the Terminal prints a **QR** code (see 6.0). The first code is valid for about 60 seconds, later codes for about 20 seconds; a new code replaces the old one. From 28/07/2026, WhatsApp requires a new code immediately after a scan. The program handles this (the phone may show an error once, so scan the new code that appears). **Not yet confirmed on a real phone**: if the QR still fails, use the pairing code.

### 6.3 Zalo (Vietnamese `+84` numbers only)

```sh
phone-app-checker login zalo --account z1
```

The Terminal **draws the QR code inside the window**; you do not need to open an image file. In Zalo, tap the QR scan icon next to the search bar, scan the code, then confirm the login on the phone. The program reports "scanned", "expired" (a code expires after about 100 seconds and is regenerated up to 3 times; a new code replaces the old one) or "rejected". Only if the QR cannot be read does it fall back: it prints the path of an image file `login-qr.png` (permissions 600, inside the account folder, deleted when finished) and opens it on the Mac. Numbers that are not `+84` are recorded as `skipped` in the Zalo column.

### 6.4 Viber (optional, technical)

Viber has no official lookup method. The program drives the **real Viber app on an Android device** (a "Google APIs" emulator or a rooted phone) through `adb`, then reads Viber's database. You need:

- The `adb` tool installed on the Mac and callable (`adb version`). If `adb` is not on your PATH, give the full path in `apps.viber.options.adbPath`.
- An Android device with root access, Viber activated with a dedicated SIM, and contact sync turned on.
- **The three SQL queries (`registeredQuery`, `syncedQuery`, `authQuery`) must be found by you, matching the Viber version installed.** The sample file contains deliberate placeholders that do not run. A helper script to discover them: `~/Applications/phone-app-checker/current/app/scripts/viber-discover-schema.sh`.
- Turn off Viber's automatic updates (its data structure changes between versions).

This is work for a technical person. Read `~/Applications/phone-app-checker/current/app/docs/viber-setup.md`. Only set `"enabled": true` for Viber once everything is done. If Viber is enabled and `adb` is missing, `doctor` reports `FAIL`; if Viber is enabled but no Android device is visible yet, `doctor` reports `WARN`. Once setup is done:

```sh
phone-app-checker login viber --account vb1
```

This command **only checks** that the Android device and `adb` are set up correctly. It does not log in for you.

### 6.5 LINE

Phone-number lookup only means something in Hong Kong, Japan, South Korea, Taiwan and Thailand (and for old LINE accounts created before version 13.11). Elsewhere, `not_found` is almost meaningless. Set `"enabled": true` for LINE in the config file, then:

```sh
phone-app-checker login line --account l1
```

By default it shows a QR code in the Terminal (the same drawing as WhatsApp, Zalo and Telegram, see 6.0). Scan it with the LINE app on the account's phone, then enter the PIN shown in the Terminal on the phone. An alternative mode, `"loginMode": "password"` (email + password), is set in `apps.line.options`.

## 7. The list of numbers (CSV file)

Create a working folder **inside your home folder, not in a synced folder**, and keep the list file there:

```sh
mkdir -p ~/phone-checks
cd ~/phone-checks
```

> **Do not keep customer files in `Documents`, `Desktop`, iCloud Drive, Dropbox, Google Drive…** On many Macs `Desktop` and `Documents` sync to iCloud automatically (even if you do not remember enabling it), so customers' numbers get copied to a third-party service. macOS also asks Terminal for permission when it reads those folders (section 14, `Operation not permitted`). `~/phone-checks` avoids both problems. If you want to use *Downloads* or *Desktop* only to receive files, copy the file to `~/phone-checks` and delete the original.

The file is a CSV (export from Excel or Numbers: *Save As / Export → CSV UTF-8*), one customer per line. Example `customers.csv`:

```csv
name,phone
An,+84901234567
Binh,+84 90 765 4321
Chi,+82 10-1234-5678
```

- The phone column is detected from its header (`phone`, `mobile`, …) or from the content (a column whose values look like phone numbers). To choose it yourself: `--column phone` or `--column 2` (column 2, counting from 1).
- Separators `,` `;` or Tab, Windows or old-Mac line endings, UTF-8 files with a BOM, and Excel's *Unicode Text* export (UTF-16 with a BOM) are all handled. An `.xlsx` file (not a CSV) or UTF-16 without a BOM is refused, with a message to save again as *CSV UTF-8*. If the first line has the same number of `,` and `;` and later lines cannot be separated, the program stops with `Cannot tell how the columns are separated` instead of guessing. Save again as *CSV UTF-8 (Comma delimited)*, use simple column headers, or keep only the phone column.
- Numbers without a country code (for example `0901234567`) are read using `defaultRegion` (default Vietnam). Write international numbers in full, as `+country-code…`.
- **Be careful with Excel. It is the number one cause of wrong numbers:**
  - **Format the phone column as *Text* before you paste or type numbers** (select the column → *Format Cells → Text*; when you open a `.csv` with *Data → From Text/CSV*, choose *Text* for that column). Otherwise Excel drops the leading `0` (`0901…` becomes `901…`; the tool still reads `901234567` as a Vietnamese number through `defaultRegion`), and turns long numbers into scientific notation (`8.49E+10`).
  - Export with **CSV UTF-8 (Comma delimited)**.
  - Digits lost to scientific notation **cannot be recovered**. The program records them as `invalid` and does not guess. Export again from the original data, which still has all the digits. Do not fill in missing digits yourself.
  - Writing numbers as `+84…` avoids most of these problems.
- A duplicate number is checked only once. A cell that is not a valid phone number is recorded as `invalid`.
- If there are **no valid numbers at all** (wrong column, or everything is `invalid`), `check` stops at once with exit code `1`: `no valid phone numbers (N invalid); check --column …`. It does **not** create a report. This is an error, not a finished run.
- Names and other columns in the input file are **not** copied into the report. The report only contains the `input` column (the original phone cell) and the result columns.

## 8. Run checks, view reports, view accounts

Always run these commands from the working folder (section 7). Dragging a file into the Terminal window fills in its path.

> Do not want to remember commands? Type `phone-app-checker` on its own to use the menu (menu item 1 = `check`, 3 = `accounts`, 4 = `report`, 5 = `doctor`).

**First time: run a small batch with someone sitting next to you**, using a file of about 20 staff numbers whose status you know for each app (section 12). **Do not** use the real customer list:

```sh
phone-app-checker check staff.csv --apps telegram --out staff-telegram.csv --no-wait
```

- `--no-wait`: if every account is resting or has used its daily limit, the run **stops** (it prints `Next resume: …`, the time it can resume) instead of sleeping for days.
- **Keep the Mac plugged in** and do not close the lid. **When the Mac sleeps, the process is frozen** (it checks nothing, but the clock keeps running); it resumes when the Mac wakes.
- To stop: press **Ctrl-C exactly once, then wait**. The program finishes the current batch, writes the report and exits (code 130). This can take from a few tens of seconds to a few minutes. Do not press it a second time, close the window, or force-quit (Force Quit / `kill -9`): saved results are not lost, but the running batch may be asked again, and temporary contacts on a Telegram or Viber account may be left behind (section 12, step C). Run the same command again to continue.

After a successful small trial (section 12), run the real list:

```sh
phone-app-checker check customers.csv --out report.csv
```

- Limit the apps: `--apps telegram,zalo` (other app columns are `skipped`).
- `--max-age 7`: reuse `yes`/`not_found` results younger than 7 days. `--max-age 0`: check everything again. The default comes from `maxAgeDays` in the config (30 days). Results dated in the **future** (for example because the Mac clock was set back) are never reused, even with a very large `--max-age`.
- `--out` must not be the input file. An old report written by this tool is overwritten; a file with the same name that this tool did not write is refused unless you add `--force` (do not use `--force` unless you are sure).
- Progress and results are saved to the database after **each batch**. Run the same command again to resume where it stopped; numbers that already have results are not asked again. A re-check that gets no answer does **not** overwrite an old `yes`/`not_found` result, but it also does **not** make the old result new. See the `<app>_checked_at` and `<app>_stale` columns (section 9). Numbers in a failed batch are remembered. The next run checks them **last and one at a time**, so the healthy numbers that shared the batch get answers first.
- Each account has a daily limit (`dailyCap`) and a pause between batches (`minIntervalMs`). **Daily throughput ≈ number of accounts × `dailyCap`**: one Telegram account with the default `dailyCap` of 200 needs about 50 days for 10,000 numbers. When every account has reached its limit and `--no-wait` is not used, `check` **sleeps and waits**, possibly for days. To stop the Mac sleeping on its own: `caffeinate -i phone-app-checker check customers.csv --out report.csv` (keeps the Mac awake; keep it plugged in and the lid open).
- **Read the end of the run, do not just look at the exit code.** Exit code `0` only means the command finished and wrote the report. It does **not** mean every number has a fresh result (`130` means interrupted, `1` means an error or no valid numbers). Each app has a line `needed N, attempted …, conclusive …, inconclusive …`. If numbers still lack a fresh result, the end of the screen shows an **INCOMPLETE** box (section 9).

Rebuild the report from saved results, **without using the network** and without asking any app:

```sh
phone-app-checker report customers.csv --out report.csv
```

(`report` shows the most recent answer even if it is older than `maxAgeDays`. Any cell older than the limit **or dated in the future** (because the clock is wrong) is marked `<app>_stale` = `yes`, and the summary has a `STALE:` line ("older than the max age or dated in the future"). Change the limit with `--max-age <days>`. If there are no valid numbers at all, `report` still writes the file (only `invalid` rows), prints `WARNING: no valid phone numbers`, and exits with code `1`.)

View accounts and today's usage:

```sh
phone-app-checker accounts
```

After you have fixed the cause (for example you reconnected a phone or re-paired a device), clear an account's resting or blocked state:

```sh
phone-app-checker account-reset telegram tg1
```

Full list of commands and options: `phone-app-checker --help` and `phone-app-checker <command> --help`. Version information (send it along when asking for help): `phone-app-checker --version`.

`report.csv` and the input file live in your **working folder**, not in the data folder (section 10).

## 9. Reading the results in the report

Report columns: `input` (the original cell you entered), `e164` (the standard international number), `country`, `telegram`, `whatsapp`, `zalo`, `viber`, `line`, then:

- `last_checked_at`: the **most recent** UTC time of *any* saved result for this number, including an attempt that gave no answer. It says nothing specific about one app. Empty for `invalid` rows.
- `telegram_checked_at`, `whatsapp_checked_at`, `zalo_checked_at`, `viber_checked_at`, `line_checked_at`: the UTC time of that app's **own `yes`/`not_found` answer**. Empty for `unknown`, `skipped` and `invalid`.
- `telegram_stale`, …, `line_stale`: `yes` if the answer is older than the limit (`--max-age` / `maxAgeDays`) or dated in the future, `no` if recent, empty if the cell is not `yes`/`not_found`. Old reports without these 10 columns are still overwritten normally.

| Value | Meaning |
| --- | --- |
| `yes` | The app answered, **at the time in `<app>_checked_at`**, that this number has an account. This is an observation. It does not confirm who the person is, that the account is still active, or that it still exists now. |
| `not_found` | The app **returned no account** for this number. **This is not evidence that the person does not use the app.** People can hide themselves from phone-number search (Telegram, Zalo, LINE), and Viber results depend on contact sync. If an app silently restricts the tool, a false `not_found` can appear and the tool may not notice. |
| `unknown` | Not checked yet, or the check failed or was rate-limited, or the app has no logged-in account. Run `check` again: `unknown` numbers are retried. |
| `skipped` | The app is disabled, not in `--apps`, or the number is outside the app's scope (Zalo only checks `+84`). |
| `invalid` | The cell is not a valid phone number (after normalising with `defaultRegion`; Excel numbers already turned into scientific notation also end up here). Written in every app column. |

Keep in mind: both `yes` and `not_found` are the result of **one question asked at one moment**. A `not_found` can still be a false negative. Accuracy with real accounts **has not been measured** yet (section 12).

### The INCOMPLETE box

At the end of each `check` (after the `Report written to …` line), if some numbers still have no fresh `yes`/`not_found` answer **in this run**, the program prints:

```
========================================================================
INCOMPLETE: 6 of 6 checks have no fresh yes/not_found answer.
The report is NOT final: cells marked unknown are unchecked, and an older yes/not_found may be outdated.
  telegram: 2 inconclusive (0 attempted, 0 conclusive)
    - no_accounts: no usable telegram account (log in, or fix a disabled one: login telegram --account <name>)
Run the same command again to continue (finished numbers are not repeated).
========================================================================
```

This means: **the report is not complete. Do not use it as a final result.** Common reasons (each line starts with `- <reason>`): `no_accounts` (not logged in, or the account is disabled); an account is resting or has reached its daily limit (with a `Next resume: <UTC time>` line); `adapter_error` (an error from the app); `aborted` (you pressed Ctrl-C); a batch was set aside after repeated failures. Fix the cause, then run the **same command** again. Only when this box is gone (each app's summary line ends with `(all conclusive)` instead of a remaining count) can you say the run has asked every number. Even then, check `<app>_stale`. The box and the `STALE:` line appear only on screen and are **not** in the CSV file, so copy them when you send a report (section 12).

## 10. Where the data lives

| Path | Contents | How long it lasts |
| --- | --- | --- |
| `~/Applications/phone-app-checker/<version>/` | The program (only copied here; no data is written here) | Older versions are kept so you can roll back |
| `~/Applications/phone-app-checker/current` | Link to the version in use | Changes when another version is installed |
| `~/.local/bin/phone-app-checker` | The `phone-app-checker` command | Removed on uninstall |
| `~/.zprofile` or `~/.bash_profile` | The PATH block between `# >>> phone-app-checker >>>` and `# <<< phone-app-checker <<<` (added only when needed) | The block is removed on uninstall; an empty file created by the installer is also removed |
| `~/Library/Application Support/phone-app-checker/checker.config.json` | Your configuration | **Kept** after updates and normal uninstalls. Deleted only with `--purge-data` |
| `~/Library/Application Support/phone-app-checker/data/checker.db` | Every checked number, results, times, account states | As above |
| `~/Library/Application Support/phone-app-checker/data/sessions/<app>/<account>/` | **Login sessions** of the checking accounts | As above |
| `~/Library/Application Support/phone-app-checker/data/check.lock` | "A run is in progress" lock | Deleted automatically when the run ends |
| `~/Library/Application Support/phone-app-checker/data/check.lock.reclaim` | Exists only for a moment while an old lock is being reclaimed | If left behind → section 14 ("Lock recovery was interrupted") |
| `~/Library/Application Support/phone-app-checker-lifecycle/` (**outside** the data and install folders) | `shared/<pid>.…` for each running command; `maintenance.lock` while installing or uninstalling | Cleaned up automatically; if `maintenance.lock` is left behind → section 14 |
| `~/Applications/phone-app-checker/.incoming.*`, `.replaced.*` | A copy being written, or an old copy kept temporarily during an install | Deleted when the install finishes; if left behind, run `install.sh` again |
| Your working folder (for example `~/phone-checks`) | Input CSV files and `report.csv` | You manage them. **Not** in `Documents`, `Desktop` or any synced folder |

The data folder and `dataDir` must be a dedicated folder, **not synced**, and **outside** `~/Applications/phone-app-checker`: customer data and login sessions **must not be in a synced folder**. The program refuses (even with a marker file present) when `PHONE_APP_CHECKER_HOME` or `dataDir` is `Documents`, `Desktop`, `Downloads`, `Library`, `Applications`, `Movies`, `Music`, `Pictures`, `Public`, `.local`, `.config`, `Library/Application Support`, `.local/bin`, the home folder or one of its parents, or equal to or containing the install folder. Use a dedicated subfolder. It also refuses **synced folders and anything inside them**: iCloud Drive (`~/Library/Mobile Documents`, `~/iCloud Drive`), `~/Library/CloudStorage/*` (Dropbox, Google Drive, OneDrive, Box managed by macOS), and `~/Dropbox*`, `~/Google Drive*` (`~/GoogleDrive*`), `~/OneDrive*`, `~/Box`, `~/Box Sync`, `~/Box Drive` (even when they are symlinks to another disk). Good choices: `~/phone-checks`, or keep the default. Desktop and Documents may sync to iCloud without the program detecting it, so do not put data there.

The database `checker.db` now uses **schema version 2** (it adds a `failed_checks` table that remembers numbers in failed batches, and upgrades automatically from version 1 when opened). After a newer build has opened it, **older builds cannot open it** (`Database was written by a newer version`). Do not go back to an older build on the same data folder unless you have backed up `checker.db` first.

Open the data folder: `open ~/Library/Application\ Support/phone-app-checker`. The `Library` folder is hidden in Finder. Use the command above, or in Finder choose *Go → Go to Folder…* and paste `~/Library/Application Support/phone-app-checker`.

## 11. Privacy and safety

- The tool **does not send messages, make calls, add contacts or invite people to groups**. It does not read or store names, profile photos, user IDs, last-seen times or profile details. Screen logs hide phone numbers (for example `+8490****567`). The full number is only stored in the local database and in the `report.csv` you asked for. Apart from the queries the messaging app itself performs, nothing is sent to third parties.
- **The folder `~/Library/Application Support/phone-app-checker` holds login sessions, which give full access to the checking accounts**, plus the list of checked numbers (customers' personal data). Do not send it, do not copy it into a synced folder (iCloud Drive, Dropbox, Google Drive…), do not attach it when asking for help, and do not put it in a backup you do not control. The folder is created so that only you can read it; do not change its permissions. Uninstalling with data deletion does **not** log the accounts out remotely, and it is **not** a secure erase (backups and Time Machine snapshots may still contain copies).
- `report.csv` and customer lists contain real phone numbers. Keep them in a non-synced folder and delete them when no longer needed. When you need to send a trial report to someone else, use **only numbers of staff who have agreed** (section 12).
- Use **dedicated SIMs/accounts you can afford to lose**. Every app here is accessed through unofficial software, and accounts can be restricted or permanently banned. Do not use a personal number or a number that serves your business.
- Only check numbers of people who have agreed to be contacted. The program does not verify that consent. Legal responsibility and compliance rest with you.
- Start with the default (slow) speed. Increase `batchSize` and `dailyCap` step by step, and watch `phone-app-checker accounts`. The real limits of each platform **have not been verified**.
- Do not run two `check`/`login` commands at once. The program blocks this with `check.lock` (a second WhatsApp connection may get the account disabled). The lock only covers one process on **this Mac**. The data folder must be on a local, non-synced disk (not iCloud, not a network drive). If a process is forced to stop midway, the program cannot guarantee "no repeated queries" or "no leftover contacts". See section 8.

## 12. Suggested trial procedure and sending results back

Goal: check that the program runs correctly on your Mac, and that `yes`/`not_found` match reality. **Only WhatsApp has had a small live trial; no known-answer comparison of ~20 numbers has been done for any app, and nothing has been run on macOS 13.5**, so this comparison is required before you run a real list.

**Step A: receive the files, check them, install** (sections 2–5), using the same channel you will really use (AirDrop, a download, and so on), so the "downloaded from the Internet" mark is applied. Record: whether Gatekeeper blocks it, and the **exact** message ("unidentified developer" or "is damaged" are different cases, see section 14); whether Terminal asks for folder access; whether the Mac is managed by an organisation (MDM). Then save support information in the working folder:

```sh
mkdir -p ~/phone-checks && cd ~/phone-checks
phone-app-checker --version > support.txt 2>&1
phone-app-checker doctor >> support.txt 2>&1
sw_vers >> support.txt 2>&1
uname -m >> support.txt 2>&1
```

Reminder: the `doctor` result only covers offline readiness.

**Step B: for each app you want to try** (section 6): did the login succeed? Does `phone-app-checker accounts` show `ready`? (Only a real `login` proves an account works.)

**Step C: a trial file of about 20 numbers of staff who have agreed**, each person's status for each app known for certain (include a few people who turned on the privacy setting "do not allow finding me by phone number", if any, and record that group separately). Create `staff.csv` in `~/phone-checks` (column `phone`), then run a **small batch, one app at a time, with `--no-wait`, Mac plugged in**:

```sh
phone-app-checker check staff.csv --apps telegram --out staff-telegram.csv --no-wait
```

Replace `telegram` with `whatsapp`, `zalo`, `viber` or `line` as needed. After each run, record:

- Is there an `INCOMPLETE` box? If yes, what is the reason (copy it word for word)? A report with this box **does not count as a result**: fix the cause and run again until it is gone.
- Does a person who definitely **has** an account get `yes`? Does a person who definitely **does not** get `not_found`? Is `<app>_stale` `no`? (A person hidden from search may get `not_found` even with an account; record them separately. Do not compute one overall "accuracy" figure. Split results into: findable / hidden from search / `unknown`.)
- Are there `DISABLED`, `cooling down`, `rate limit` lines, or many `unknown` numbers? (`phone-app-checker accounts`.)
- Press **Ctrl-C once** partway through, **wait** until it has written the report, then run again: are numbers that already have results not asked again? (Do not test forced exits on important data.)
- Telegram: is the checking account's contact list empty after the run? Viber: is there still a contact named `phone-app-checker` on the Android device?
- How long did the batch take, and was the pause between batches reasonable?

**Step D: update, roll back, uninstall** (section 13) on that same Mac: is anything left behind after uninstalling? (Try `--purge-data` only after copying off anything you need.)

**Step E: what to send back:**

| Send | Do not send |
| --- | --- |
| `~/phone-checks/support.txt` (version, `doctor`, macOS, chip) | **The `Application Support/phone-app-checker` folder** (contains login sessions!) |
| The **exact** `INCOMPLETE` box, `STALE:` line and error messages from the Terminal (Cmd + A, Cmd + C; phone numbers in logs are already masked) | `checker.config.json` while it still contains `apiHash` (remove or mask the `apiId`/`apiHash` values before sending) |
| The output of `phone-app-checker accounts` | QR images, OTP codes, passwords, pairing codes |
| `staff-*.csv` **only if** the numbers are of staff who agreed and you send them over a secure channel; **or** a version with the numbers hidden: open it in Excel or Numbers, delete the two columns `input` and `e164`, and save as a **new** file (do not edit the original). This still lets you compare `country`, results, `*_checked_at` and `*_stale`. Include a table of the "correct answers" you wrote yourself | Any file containing **customers'** phone numbers |
| Notes: which app and account were tried, what happened, screenshots of error messages (phone numbers hidden) | |

If you can, also say: the chip (About This Mac), the **macOS version** (especially if 13.x or 14.x), whether the Mac is managed by an organisation (MDM), and how you received the files (AirDrop, USB, internal file sharing…).

**Opening the report in Excel:** `report.csv` is a comma-separated, UTF-8 CSV without a BOM. Do not double-click it (Excel on Windows may show Vietnamese characters in the `input` column wrongly). Use *Data → From Text/CSV*, choose **UTF-8**, separator **Comma**, and set the `input` and `e164` columns to **Text** so Excel does not change the numbers.

## 13. Updating, rolling back, uninstalling

**Update:** get the new files (repeat sections 2–3 for the new version; the folder name contains the new version number), then run:

```sh
bash ~/Downloads/phone-app-checker-<new version>-macos-arm64/install.sh
```

The new program is copied into its own folder, and `current` switches to it. **Configuration, login sessions and results are kept.** The old copy is kept too; the installer prints an `rm -rf` command you can run to delete it. Note the database schema point (section 10): the new version may upgrade `checker.db`, and then the older version can no longer open it.

**Roll back to an older version** (for example `0.1.0`):

```sh
bash ~/Applications/phone-app-checker/0.1.0/install.sh
```

This only switches the `current` link back; the data does not change (read the schema note in section 10 before going back to an older build).

**Uninstall** (removes the program, the command and the PATH block; **keeps** configuration, login sessions and results):

```sh
bash ~/Applications/phone-app-checker/current/uninstall.sh
```

**Uninstall and also delete all data** (cannot be undone: all login sessions, saved results and the configuration are lost):

```sh
bash ~/Applications/phone-app-checker/current/uninstall.sh --purge-data
```

The program asks again. Type exactly `DELETE` (in capitals) to confirm. **If you type something else or leave it empty, the program still uninstalls** (command, PATH block, install folder), and only the data is kept. In that case the command `~/Applications/phone-app-checker/current/uninstall.sh` above **no longer exists**. To delete the data later, run `uninstall.sh` **from the downloaded and unpacked package** (for example `bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/uninstall.sh --purge-data`). It still reads `dataDir` from `checker.config.json` **before** deleting anything, and reports if `dataDir` is outside the normal folder (in that case it is **not** deleted). If it cannot be sure what `dataDir` is, it refuses to delete data and keeps the configuration; check `dataDir` in that file and delete that folder yourself. Before deleting, log out the linked devices on your phone (WhatsApp → Linked devices; Zalo and LINE are similar) if you will not use those accounts again. Deleting data **only removes files on this Mac. It does not log out remotely, and it is not a secure erase** (backups and Time Machine may still contain copies). CSV files and `report.csv` in the working folder **are not touched**; delete them yourself if you do not need them.

After the program has been removed, `uninstall.sh` reads `checker.config.json` with a **real JSON parser** (Node bundled in the package, or the macOS `osascript` tool), the same way the program reads it, so a key written as `"\u0064ataDir"` is still recognised. It **never** concludes "there is no `dataDir`" by searching the text. If no parser is available, the file cannot be read, or it is not valid JSON, `--purge-data` refuses (nothing is deleted, the configuration is kept). Uninstalling without `--purge-data` still runs and notes that `dataDir` could not be read with certainty.

Install, reinstall and uninstall are all **refused** while any `phone-app-checker` command is running (including `report`, `accounts` and `doctor`), after about 3 seconds of waiting. The `check.lock` file (section 14) only blocks **reinstalling the same version** and **uninstalling**; installing a **different** version does not check `check.lock`. Commands from version 0.1.0 onwards are still protected by the running-command registry described above. Uninstalling is also refused (nothing deleted) if the data folder or `dataDir` is **inside** `~/Applications/phone-app-checker`, because it would be deleted with it.

`--purge-data` only deletes a whole folder when that folder is **a dedicated folder named `phone-app-checker`** (by default `~/Library/Application Support/phone-app-checker`) and it contains a real `checker.config.json` or `data/checker.db` (not a symlink). It **refuses** (even with `--yes` and even if a marker file exists) when the path is: the home folder or one of its parents, a symlink, not owned by you, one of your personal folders (`Documents`, `Desktop`, `Downloads`, `Library`, …), equal to or containing the install folder, or a custom folder whose name is not `phone-app-checker`. When it refuses, nothing is deleted; delete what you created inside it yourself (`checker.config.json`, the `data` folder). If `dataDir` in the config is an absolute path **outside** that folder, it is **not** deleted, and the command prints the remaining path so you can deal with it.

`--purge-data` also refuses to touch synced folders themselves (`~/Library/Mobile Documents`, `~/Library/CloudStorage` and each subfolder of it, `~/Dropbox*`, `~/Google Drive*`, `~/OneDrive*`, `~/Box`, `~/Box Sync`, `~/Box Drive`, `~/iCloud Drive`), so it never deletes your whole sync library. If you once put a dedicated `phone-app-checker` data folder (with a marker file) *inside* a synced folder in an older version, only that dedicated folder is deleted. Move the data to a local disk afterwards.

## 14. Common problems

**`command not found: phone-app-checker`**
Open a **new Terminal window** after installing. If it still fails:

```sh
export PATH="$HOME/.local/bin:$PATH"
phone-app-checker --version
```

If that works, the PATH was not saved permanently (for example your shell is not zsh or bash); the installer printed the line to add to your shell startup file. Alternatively, run the program by its full path: `~/Applications/phone-app-checker/current/phone-app-checker --version`.

**macOS says "cannot be opened because the developer cannot be verified" / "Apple cannot check it for malicious software" (developer not identified)**
macOS marks files downloaded from the Internet. The installer removed this mark from the installed copy. If it is still blocked and the file **already passed the checksum check in section 2**, run:

```sh
xattr -dr com.apple.quarantine ~/Applications/phone-app-checker
xattr -dr com.apple.quarantine ~/Downloads/phone-app-checker-0.1.0-macos-arm64
```

If it is still blocked: *System Settings → Privacy & Security* → scroll down to the message about `node` or `phone-app-checker` → **Open Anyway**, then run again. If the Mac is managed by an organisation (MDM), it may block programs that are not signed or approved: tell your IT administrator or whoever gave you the package, and include the message text.

**macOS says "is damaged and can't be opened" / "will damage your computer". STOP, this is a different case**
Do not run `xattr`, and do not click **Open Anyway**. This message means the file may be corrupted or altered: delete the unpacked folder, download the files again from the GitHub Releases page, and repeat section 2 (`shasum -c` must print `OK`). If it still fails, report it with the exact message text. **Never** turn off SIP or Gatekeeper for the whole Mac (`spctl --master-disable`) to run this build. It is not necessary and makes the Mac less secure.

**Messages about Rosetta / an Intel Mac / "not an Apple Silicon Mac"**
This build only runs on Apple Silicon, in a Terminal that runs **natively**. If your Mac is an M1/M2/M3… but Terminal says it runs through Rosetta: in Finder go to *Applications → Utilities → Terminal*, right-click, *Get Info*, untick **Open using Rosetta**, and reopen Terminal. Check: `uname -m` must print `arm64`. If it prints `x86_64` on an Apple Silicon Mac, Terminal is still under Rosetta. A real Intel Mac does not support this build.

**"macOS too old" / needs 13.5**
You need macOS 13.5 or later. Update in *System Settings → General → Software Update*. If you cannot update, you cannot run this build; tell the person who gave you the package.

**`Operation not permitted` / "Permission denied" when reading files in *Downloads*, *Documents* or *Desktop* (or you accidentally clicked Don't Allow)**
macOS blocks the Terminal app from reading these folders until you allow it. Open *System Settings → Privacy & Security → Files & Folders*, find **the Terminal app you use** (Terminal, iTerm, …), turn on the folder you need, then open a new Terminal window. A cleaner option: copy the files into `~/phone-checks` (section 7) and run them from there. You do **not** need *Full Disk Access*, and you do **not** use `sudo`.

**`check.lock` / "Another check or login is already running" / install or uninstall refused because a command is running**
Only one `check`, `login` or `account-reset` may run at a time (this prevents using one account twice). The program's message: `Another check or login is already running (pid …, lock …). Wait for it to finish; if nothing is running, delete <lock file path> (the pid may have been reused after a crash or power cut).` After a restart, the process ID in the lock file may have been reused by another process, so it looks as if it is still running. Check with `ps aux | grep phone-app-checker`, then delete exactly the file named in the message. Wait for the other command to finish, or close the Terminal window running it (press Ctrl-C first). When you run `check` or `login` again, a lock left by a process that has died (or a corrupted lock file) is reclaimed automatically. **The installer and the uninstaller do not reclaim it**: they only check whether the file exists (`A command is still running … check.lock`). If you are **certain** no command is running (check `ps aux | grep phone-app-checker`) and it still blocks you, delete the file:

```sh
rm ~/Library/Application\ Support/phone-app-checker/data/check.lock
```

The installer and uninstaller look for the lock file in the data folder the program uses: the `dataDir` in `checker.config.json` (default `data/`; it can be `./store` or an absolute path), and any `check.lock` file directly inside the program's data folder. The refusal message always gives the full path of the lock file to delete.

**`Lock recovery was interrupted: … was left by a process that is no longer running … Repair: … delete …check.lock.reclaim`**
A command was force-stopped while it was cleaning up an old lock. The program **deliberately does not repair this itself**, because a wrong repair could let two commands use the same account. Do this in order: (1) close every Terminal window running phone-app-checker, and check that `ps aux | grep phone-app-checker` shows no running processes; (2) delete **exactly the file named in the message** (usually `~/Library/Application Support/phone-app-checker/data/check.lock.reclaim`); (3) run the command again. The old `check.lock` will then be reclaimed as normal. The message `Could not acquire the run lock …` also names `check.lock.reclaim`: it means another process is cleaning up the lock. Wait a few seconds and run again. If it is still blocked and `ps` shows no running command, delete exactly the `check.lock.reclaim` file named in the message.

**`An earlier install or uninstall of phone-app-checker was interrupted: …maintenance.lock was left by …`** (every command refuses and opens nothing)
An earlier install or uninstall was interrupted while it held the maintenance lock. Make sure no `install.sh`, `uninstall.sh` or `phone-app-checker` command is running, delete the `maintenance.lock` file named in the message (in `~/Library/Application Support/phone-app-checker-lifecycle/`), then run `install.sh` from the downloaded package to make sure the installed copy is intact. **`An install or uninstall … is in progress (pid …, <file>)`** / **`a phone-app-checker command is running (pid …, file <file>)`**: the other side seems to be alive. Wait for it to finish, or close the matching Terminal window, then try again. But after a power cut or restart the process ID in the file may have been reused by another process. If `ps aux | grep -E 'phone-app-checker|install.sh|uninstall.sh'` shows **nothing** running, delete the file the message names (`If nothing is running, delete <file>`). The program never deletes these files by itself.

**`… is your Documents folder (or Desktop, …), which holds your own files; refusing to use it …` / `… is, or lies inside, the synced folder …` / `… overlaps the installation folder …`**
`PHONE_APP_CHECKER_HOME` or `dataDir` points at one of your personal folders, a synced folder (iCloud Drive, `~/Library/CloudStorage/*`, Dropbox, Google Drive, OneDrive, Box), or a folder that contains or is inside `~/Applications/phone-app-checker`. Do not try to work around this: customer data and login sessions must not be in a synced folder. Use a dedicated subfolder outside those places (the message suggests a name), or remove the custom setting to use the default.

**`Database was written by a newer version (schema 2, supported 1)`**
You are running an older build on data that a newer build has already upgraded (section 10). Install the newer build again. Only rename `checker.db` (and `-wal`/`-shm`) so the older build can create a new one if you accept losing the saved results.

**`no valid phone numbers (N invalid)` / `Cannot find a phone column` / `Cannot tell how the columns are separated`**
The program stops before asking any app. Open the CSV file, check the phone column, use `--column phone` or `--column 2`, and save again as *CSV UTF-8 (Comma delimited)* (section 7). Also check whether Excel changed the numbers to scientific notation. The message deliberately does not print phone numbers from the file.

**`INCOMPLETE`**
This is not an error. It is a warning that results are not complete yet. See "The INCOMPLETE box" in section 9.

**Rate limiting (throttling): `cooling down until …`, `rate limit`, `FLOOD_WAIT`, many `unknown` numbers**
The app has asked the program to slow down. The account rests for a few hours up to 24 hours (Telegram and WhatsApp 6 hours, Zalo and LINE 24 hours, Viber 12 hours, unless the app says otherwise). This is a protection mechanism, not a bug. Check the status with `phone-app-checker accounts`. What to do: wait, then run `check` again (`unknown` numbers are retried); add more accounts; lower `batchSize` or `dailyCap`, or raise `minIntervalMs` in the config file; do not use brand-new accounts. If you see `DISABLED` (for example `PEER_FLOOD`, or a WhatsApp device was unlinked), a person has to act: check the phone and the account, then log in again with `login <app> --account <name>`, or run `phone-app-checker account-reset <app> <name>` after the cause is fixed. Large lists can take several days; see `caffeinate` and `--no-wait` in section 8.

**`adb not found` / "no Android device ready" (Viber only)**
Install the Android platform-tools (they provide `adb`) and make sure `adb version` runs; alternatively set `apps.viber.options.adbPath`. Connect the Android device or start the emulator. `adb devices` must list the device with status `device`. Details: `~/Applications/phone-app-checker/current/app/docs/viber-setup.md`. If you do not use Viber, set `"enabled": false`.

**`doctor` reports `FAIL config`**
The file `checker.config.json` has a JSON syntax error, or an unknown key or invalid value. The error line says where. Fix it and run again, or rename the file so the program creates a fresh template (section 5).

**`doctor` reports `FAIL data`**
The data folder has wrong permissions, has been replaced with a symbolic link (symlink), or belongs to another user. Do not change it by hand. Send the text of the failing row to whoever is helping you (section 12).

**What to send when you ask for help:** the output of `phone-app-checker --version` and `phone-app-checker doctor`, the chip and macOS version, and the exact `INCOMPLETE` box and error messages (section 12, step E).

---

**Licence:** GPL-3.0-or-later. `LICENSE` and `THIRD_PARTY_LICENSES.md` are included in the archive folder.