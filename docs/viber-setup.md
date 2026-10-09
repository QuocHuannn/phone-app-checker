# Viber setup (Android emulator or phone)

Viber has no lookup API. The Viber adapter drives the **real Viber app on Android**:

1. injects the batch of numbers into the Android contacts under a dedicated account (`phone-app-checker` / `phone-app-checker.local`),
2. waits for Viber's own phonebook sync,
3. reads Viber's local SQLite database to see which of those numbers Viber marked as Viber users,
4. deletes the injected contacts (always, also after errors).

It never sends a message, places a call, or reads profiles. Unofficial automation can get the Viber account restricted; this is an accepted risk. Use a dedicated SIM/account, not a personal one.

Result meaning: `yes` = Viber marked the number as a user. `not_found` = Viber ingested the contact but did not mark it; this may include users who are hidden from contact discovery, so it is **not** proof that no account exists. `unknown` = sync did not finish or the number could not be read.

## 1. Requirements

- macOS with Homebrew, Node >= 22.18, `sqlite3` (preinstalled on macOS).
- A phone/SIM able to receive the Viber activation SMS or call.
- **Root access to Viber's private data** (`/data/data/com.viber.voip/databases`). That is why the emulator image must be **"Google APIs"** (rootable), not **"Google Play"** (not rootable). A rooted physical phone also works. There is deliberately no UI-scraping fallback: it would depend on unverified screen layouts. Without root the adapter stops with an actionable error.

## 2. Android SDK + AVD on macOS (Apple Silicon)

```sh
brew install --cask android-commandlinetools
brew install --cask temurin          # JDK for sdkmanager (any JDK 17+)
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
mkdir -p "$ANDROID_SDK_ROOT"
export PATH="$PATH:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"

sdkmanager --sdk_root="$ANDROID_SDK_ROOT" "platform-tools" "emulator" \
  "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n viber-checker -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6
emulator -avd viber-checker -no-snapshot-save -netdelay none -netspeed full &
adb wait-for-device && adb devices
adb root && adb shell id -u          # must print 0
```

(Alternatively install Android Studio and create the same AVD in Device Manager; choose a **Google APIs** arm64 image.)

If `adb shell id -u` does not print `0`, the image is a Google Play one: recreate the AVD with `google_apis`.

Keep the AVD private: its snapshots contain the Viber account and customer contacts. Do not share or back up `~/.android/avd/viber-checker.avd`.

## 3. Install and activate Viber

1. Download a **pinned** Viber APK (arm64) from a trusted source and note the version; the DB schema changes between versions, so do not auto-update.
   ```sh
   adb install -r viber.apk
   adb shell pm grant com.viber.voip android.permission.READ_CONTACTS
   adb shell pm grant com.viber.voip android.permission.WRITE_CONTACTS
   ```
   Disable auto-update (the Play Store is absent on Google APIs images, which helps).
2. Open Viber on the emulator and activate manually with the dedicated SIM. Viber sends an SMS/call code to that number; type the code into the emulator. (For SMS received on another device you must read it there. Activation is intentionally not automated.)
3. Finish the welcome screens, allow contacts access, and make sure Viber's contact sync is enabled. Viber may refuse to activate on an emulator: use the physical-device path below.

## 4. Discover the DB schema for your Viber version

The adapter has **no built-in schema**. List candidates:

```sh
scripts/viber-discover-schema.sh            # or: scripts/viber-discover-schema.sh emulator-5554
```

It copies each database under `/data/data/com.viber.voip/databases` (file names come from the app, so only plain names `[A-Za-z0-9_][A-Za-z0-9._-]*` are ever used; anything else is skipped with a warning, and every value is shell-quoted for the device, including the inner command of `su -c`), then prints tables, columns, row counts, columns whose names suggest phone numbers / registration, and distributions of small integer flag columns (no text row values, so no phone numbers). `VIBER_PACKAGE` must be a plain Android package name. From it choose:

| option | meaning | required shape |
| --- | --- | --- |
| `syncedQuery` | every number Viber ingested from the phonebook | `SELECT ... AS number` |
| `registeredQuery` | numbers Viber marked as Viber users | `SELECT ... AS number` |
| `authQuery` | returns >= 1 row only while the app is activated | any single-statement SELECT |

Rules the adapter enforces (fail closed):

- Queries must be one `SELECT`/`WITH` statement; they run on a throwaway copy of the DB opened `query_only`.
- `registeredQuery` / `syncedQuery` must return exactly one column named `number`. Digits are compared after stripping everything else, and must be the **full international form** (e.g. `84901234567`); transform in SQL if Viber stores national/partial forms. If they do not match, results simply stay `unknown`, never a wrong `yes`.
- The queries must compile in exactly one database in the directory. Zero matches or several matches is an error; set `dbPath` to disambiguate.
- A number is `yes` only if listed by `registeredQuery`; `not_found` only if Viber ingested it (`syncedQuery`) and the registered set was stable for `stablePolls` polls; otherwise it stays `unknown`.

**Spike before trusting it:** inject ~10 numbers you know are on Viber and ~10 you know are not, run `check`, and compare. Re-do this after any Viber update.

## 5. Configure

`checker.config.json`:

```json
{
  "apps": {
    "viber": {
      "options": {
        "serial": "emulator-5554",
        "registeredQuery": "SELECT <number column> AS number FROM <table> WHERE <viber-user condition>",
        "syncedQuery": "SELECT <number column> AS number FROM <table>",
        "authQuery": "SELECT 1 FROM <table> WHERE <row present only when activated> LIMIT 1"
      }
    }
  }
}
```

Optional options: `adbPath`, `dbPath` (absolute device path, pins the DB), `contactAccountName` (default `phone-app-checker`), `contactAccountType` (default `phone-app-checker.local`; must not be a real account type such as `com.google`), `syncTimeoutMs` (180000), `pollIntervalMs` (5000), `minWaitMs` (15000), `stablePolls` (2), `foreground` (true, brings Viber to front after injection).

Then verify the whole setup (adb device, `com.viber.voip` installed, root, queries valid in exactly one DB, app activated):

```sh
npm run cli -- login viber --account viber-main
```

`login` does not activate Viber; it only verifies, and stores the device serial, DB path and Viber version in `viber-device.json` (mode 0600) inside the account directory under `data/`.

## 6. Operations

- Per batch the adapter: pings adb, checks `authQuery`, removes leftovers of its own account, injects contacts, waits for sync, reads results, deletes contacts and verifies none remain. Cleanup only ever touches contacts whose `account_name` **and** `account_type` equal the configured dedicated pair, and is idempotent. Leftovers of a crashed run are removed at the start of the next batch.
- Error mapping: adb disconnect/offline or sync timeout -> `RateLimited` (batch retried later, results obtained so far kept); `authQuery` empty or the DB gone (logged out, reset) -> `AccountBanned` (needs a human); schema/query mismatch or missing root -> hard error with instructions.
- **Consistent snapshots.** The main database and its `-wal` are read in one root `tar -cf -` stream (one read boundary, parsed locally and checked for truncation) instead of two separate pulls. Viber can still checkpoint while the archive is read; a copy that then fails to open or query as "malformed" is treated as a *torn read*, not a schema problem: it is re-pulled up to 3 times and, if it keeps failing, surfaces as a transient adb error (`RateLimited` with `errorCooldownMs`). This needs a `tar` binary on the device (present on Android 6+ images; **not yet confirmed on a real device/emulator in this repo**).
- Contacts injection runs one `content insert` per row (about 3 per number), so a 100-number batch takes a minute or two before the sync wait. Defaults (100 per batch, 30 min between batches) are a starting point; tune with a pilot.
- Expected caveat to confirm in the spike: Android may purge raw contacts of an account type that is not registered on the device when accounts change. If injected contacts vanish mid-batch, results stay `unknown`; adjust `contactAccountType` after testing on your image.

## 7. Physical-device fallback

If Viber refuses to activate or run on the emulator:

1. Use an Android phone you can **root** (a userdebug/engineering build, or a rooted ROM; Magisk `su` also works). Enable Developer options > USB debugging, connect by USB, accept the RSA prompt; `adb devices` must show `device`.
2. Confirm `adb root` or `adb shell su -c id` reports uid 0. Without root, DB reading is impossible and the adapter will refuse to run.
3. Install/activate Viber on the phone (it can keep the real SIM there, so the activation SMS arrives directly), then continue from section 4. Set `serial` if several devices are attached.
4. Use a dedicated phone: injected contacts sync like any other contacts, though they are deleted after every batch. Keep it plugged in, screen-lock off (`adb shell svc power stayon usb`) during runs.
