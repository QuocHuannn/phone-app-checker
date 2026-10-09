#!/bin/bash
# Clean-room verification of the macOS portable release archive (checks V1-V19).
# Usage: npm run release:verify [-- path/to/phone-app-checker-<version>-macos-arm64.tar.gz]
# Everything runs inside a temp directory with an empty environment (no Node on PATH, temp HOME whose
# data path contains a space, simulated browser quarantine, installed bundle read-only while it is used).
set -euo pipefail

SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin
MARK_BEGIN='# >>> phone-app-checker >>>'
QUARANTINE_VALUE='0083;5f5e1000;Safari;00000000-0000-0000-0000-000000000000'
# Documented minimum macOS; keep equal to MACOS_FLOOR in scripts/build-release.sh.
MACOS_FLOOR=13.5

T=""

cleanup() {
  if [ -n "$T" ] && [ -d "$T" ]; then
    chmod -R u+w "$T" 2>/dev/null || true
    rm -rf "$T"
  fi
}

# fail <id> <name> <why> [log-file]
fail() {
  printf 'FAIL %s %s: %s\n' "$1" "$2" "$3" >&2
  if [ -n "${4:-}" ] && [ -f "$4" ]; then
    printf -- '--- output ---\n' >&2
    tail -n 40 "$4" >&2 || true
    printf -- '--------------\n' >&2
  fi
  exit 1
}

pass() {
  printf 'PASS %s %s\n' "$1" "$2"
}

mode_of() {
  stat -f '%Lp' "$1"
}

sha_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

main() {
  root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [ "$(uname -s)" = "Darwin" ] || { printf 'verify-release: macOS only.\n' >&2; exit 1; }

  if [ "$#" -gt 0 ]; then
    archive_arg="$1"
  else
    pkg_version="$(/usr/bin/plutil -extract version raw -o - "$root/package.json")"
    archive_arg="$root/dist/phone-app-checker-${pkg_version}-macos-arm64.tar.gz"
  fi
  [ -f "$archive_arg" ] || { printf 'verify-release: archive not found: %s (run npm run release:build)\n' "$archive_arg" >&2; exit 1; }
  archive_dir="$(cd -P "$(dirname "$archive_arg")" && pwd)"
  archive_file="$(basename "$archive_arg")"
  archive="$archive_dir/$archive_file"
  name="${archive_file%.tar.gz}"
  [ "$name" != "$archive_file" ] || { printf 'verify-release: not a .tar.gz archive: %s\n' "$archive_file" >&2; exit 1; }

  T="$(cd -P "$(mktemp -d "${TMPDIR:-/tmp}/phone-app-checker-verify.XXXXXX")" && pwd)"
  trap cleanup EXIT
  mkdir -p "$T/home" "$T/dl" "$T/work"
  chmod 700 "$T"

  user_name="${USER:-$(id -un)}"
  # shellcheck disable=SC2329 # invoked below
  cr() { # clean room: empty environment, PATH without node and without ~/.local/bin
    env -i HOME="$T/home" USER="$user_name" LOGNAME="$user_name" SHELL=/bin/zsh TERM=dumb LANG=en_US.UTF-8 \
      PATH="$SYSTEM_PATH" "$@"
  }
  crp() { # clean room with the installed command on PATH (what a new Terminal window gets from ~/.zprofile)
    env -i HOME="$T/home" USER="$user_name" LOGNAME="$user_name" SHELL=/bin/zsh TERM=dumb LANG=en_US.UTF-8 \
      PATH="$T/home/.local/bin:$SYSTEM_PATH" "$@"
  }

  base="$T/home/Applications/phone-app-checker"
  data_home="$T/home/Library/Application Support/phone-app-checker"
  link="$T/home/.local/bin/phone-app-checker"
  bundle="$T/dl/$name"
  log="$T/last.log"

  # --- V1 checksum -------------------------------------------------------------
  id=V1 label=checksum
  [ -f "$archive.sha256" ] || fail $id $label "missing $archive.sha256"
  (cd "$archive_dir" && shasum -a 256 -c "$archive_file.sha256") >"$log" 2>&1 || fail $id $label "shasum -c failed" "$log"
  pass $id $label

  # --- V2 archive listing ------------------------------------------------------
  id=V2 label=archive-listing
  tar -tzf "$archive" >"$T/listing.txt" || fail $id $label "tar -tzf failed"
  for required in "$name/runtime/bin/node" "$name/runtime/LICENSE" "$name/phone-app-checker" "$name/install.sh" \
    "$name/uninstall.sh" "$name/INSTALL.md" "$name/INSTALL.vi.md" "$name/LICENSE" "$name/THIRD_PARTY_LICENSES.md" \
    "$name/VERSION" "$name/app/BUILD-INFO.json" \
    "$name/app/bin/phone-app-checker.js" "$name/app/checker.config.example.json" \
    "$name/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
    grep -qxF "$required" "$T/listing.txt" || fail $id $label "missing from archive: $required"
  done
  forbidden="$(grep -E -e '/checker\.config\.json$' -e '\.csv$' -e '/\.env(\.[^/]*)?/?$' -e '\.map$' -e '/\.DS_Store$' \
    -e "^$name/data(/|$)" -e "^$name/app/data(/|$)" -e "^$name/app/tests(/|$)" \
    -e "^$name/app/node_modules/vitest(/|$)" -e "^$name/app/node_modules/typescript(/|$)" "$T/listing.txt" || true)"
  [ -z "$forbidden" ] || fail $id $label "forbidden entries in archive: $(printf '%s' "$forbidden" | head -n 5 | tr '\n' ' ')"
  # streaming verbose listing: modes, entry types, link confinement (no extraction, no size limit)
  tar -tzvf "$archive" >"$T/listing-verbose.txt" || fail $id $label "tar -tzvf failed"
  awk -v root="$name" -f "$root/scripts/archive-lint.awk" "$T/listing-verbose.txt" >"$log" 2>&1 \
    || fail $id $label "archive entry lint failed (modes / link targets / paths)" "$log"
  pass $id $label

  # --- V3 extract + simulated quarantine ---------------------------------------
  id=V3 label=extract-and-quarantine
  tar -xzf "$archive" -C "$T/dl" || fail $id $label "tar -xzf failed"
  [ -d "$bundle" ] || fail $id $label "archive does not unpack to $name/"
  find "$bundle" -exec xattr -s -w com.apple.quarantine "$QUARANTINE_VALUE" {} + >"$log" 2>&1 || fail $id $label "cannot set quarantine attribute" "$log"
  for probe in "$bundle/install.sh" "$bundle/runtime/bin/node" "$bundle/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
    xattr -p com.apple.quarantine "$probe" >/dev/null 2>&1 || fail $id $label "quarantine attribute not present on $probe"
  done
  pass $id $label

  # --- V4 no node on PATH ------------------------------------------------------
  id=V4 label=no-node-on-path
  if cr /bin/bash -c 'command -v node' >/dev/null 2>&1; then fail $id $label "node is on the clean-room PATH"; fi
  if crp /bin/bash -c 'command -v node' >/dev/null 2>&1; then fail $id $label "node is on the clean-room PATH (with ~/.local/bin)"; fi
  pass $id $label

  # --- V5 install --------------------------------------------------------------
  id=V5 label=install
  version="$(cat "$bundle/VERSION")"
  installed="$base/$version"
  cr /bin/bash "$bundle/install.sh" >"$T/install.log" 2>&1 || fail $id $label "install.sh exited non-zero" "$T/install.log"
  [ -d "$installed" ] || fail $id $label "missing $installed"
  [ -L "$base/current" ] && [ "$(readlink "$base/current")" = "$version" ] || fail $id $label "current symlink is not -> $version"
  [ -L "$link" ] || fail $id $label "missing command link $link"
  [ "$(readlink "$link")" = "$base/current/phone-app-checker" ] || fail $id $label "command link points to '$(readlink "$link")'"
  [ -f "$T/home/.zprofile" ] || fail $id $label "no ~/.zprofile written"
  [ "$(grep -cF "$MARK_BEGIN" "$T/home/.zprofile")" = "1" ] || fail $id $label "expected exactly one PATH block in ~/.zprofile"
  new_terminal="$(cr /bin/zsh -l -c 'command -v phone-app-checker' 2>/dev/null || true)"
  case "$new_terminal" in
    */phone-app-checker) ;;
    *) fail $id $label "a new login shell does not find phone-app-checker (got '$new_terminal')" ;;
  esac
  pass $id $label

  # --- V6 quarantine cleared, node signature intact ----------------------------
  id=V6 label=quarantine-cleared
  if xattr -lr "$installed" 2>/dev/null | grep -q 'com.apple.quarantine'; then fail $id $label "quarantine attribute left in $installed"; fi
  codesign --verify --strict "$installed/runtime/bin/node" >"$log" 2>&1 || fail $id $label "codesign --verify failed on installed node" "$log"
  cmp -s "$installed/runtime/bin/node" "$bundle/runtime/bin/node" || fail $id $label "installed node differs from the archive's"
  while IFS= read -r -d '' lib; do
    case "$(file -b "$lib")" in
      *Mach-O*arm64*) ;;
      *) fail $id $label "not an arm64 Mach-O: ${lib#"$bundle"/}" ;;
    esac
  done < <(find "$bundle/runtime/bin" "$bundle/app/node_modules" -type f \( -name 'node' -o -name '*.node' -o -name '*.dylib' \) -print0)
  pass $id $label

  # --- V7 first-run bootstrap --------------------------------------------------
  id=V7 label=first-run-bootstrap
  [ -d "$data_home" ] || fail $id $label "missing $data_home (install's doctor should bootstrap it)"
  [ "$(mode_of "$data_home")" = "700" ] || fail $id $label "home mode is $(mode_of "$data_home"), expected 700"
  [ -f "$data_home/checker.config.json" ] || fail $id $label "missing checker.config.json"
  [ "$(mode_of "$data_home/checker.config.json")" = "600" ] || fail $id $label "config mode is $(mode_of "$data_home/checker.config.json"), expected 600"
  cmp -s "$data_home/checker.config.json" "$installed/app/checker.config.example.json" || fail $id $label "config differs from the bundled example"
  config_sha="$(sha_of "$data_home/checker.config.json")"
  pass $id $label

  # --- V8 installed bundle read-only -------------------------------------------
  id=V8 label=bundle-read-only
  chmod -R a-w "$installed"
  if (: >"$installed/.write-probe") 2>/dev/null; then fail $id $label "installed bundle is still writable"; fi
  pass $id $label

  # --- V9 --version ------------------------------------------------------------
  id=V9 label=version
  out="$(crp phone-app-checker --version 2>"$log")" || fail $id $label "--version exited non-zero" "$log"
  [ "$out" = "$version" ] || fail $id $label "printed '$out', expected '$version'"
  pass $id $label

  # --- V10 doctor --------------------------------------------------------------
  id=V10 label=doctor
  crp phone-app-checker doctor >"$T/doctor.log" 2>&1 || fail $id $label "doctor exited non-zero" "$T/doctor.log"
  node_expected="$(/usr/bin/plutil -extract node raw -o - "$installed/app/BUILD-INFO.json")"
  awk -v want="node $node_expected, darwin/arm64" '$2 == "runtime" && index($0, want) { found = 1 } END { exit found ? 0 : 1 }' "$T/doctor.log" \
    || fail $id $label "runtime row does not show 'node $node_expected, darwin/arm64'" "$T/doctor.log"
  for app in telegram whatsapp zalo viber line; do
    row="$(awk -v app="$app" '$2 == app { print $1; exit }' "$T/doctor.log")"
    [ -n "$row" ] || fail $id $label "no doctor row for $app" "$T/doctor.log"
    [ "$row" != "FAIL" ] || fail $id $label "doctor row for $app is FAIL" "$T/doctor.log"
  done
  if awk '$1 == "FAIL" { bad = 1 } END { exit bad ? 0 : 1 }' "$T/doctor.log"; then fail $id $label "doctor reports a FAIL row" "$T/doctor.log"; fi
  pass $id $label

  # --- V11 offline report ------------------------------------------------------
  id=V11 label=offline-report
  printf 'phone\n+84901234567\n0901234568\nabc\n' >"$T/work/numbers.csv"
  (cd "$T/work" && crp phone-app-checker report numbers.csv --apps telegram,zalo) >"$log" 2>&1 || fail $id $label "report exited non-zero" "$log"
  [ -f "$T/work/report.csv" ] || fail $id $label "report.csv not written in the working directory" "$log"
  [ "$(mode_of "$T/work/report.csv")" = "600" ] || fail $id $label "report.csv mode is $(mode_of "$T/work/report.csv"), expected 600"
  grep -E '(^|,)abc(,|$)' "$T/work/report.csv" | grep -q 'invalid' || fail $id $label "'abc' row is not marked invalid" "$T/work/report.csv"
  [ -f "$data_home/data/checker.db" ] || fail $id $label "missing $data_home/data/checker.db"
  pass $id $label

  # --- V12 accounts ------------------------------------------------------------
  id=V12 label=accounts
  crp phone-app-checker accounts >"$log" 2>&1 || fail $id $label "accounts exited non-zero" "$log"
  grep -q 'No accounts yet' "$log" || fail $id $label "output lacks 'No accounts yet'" "$log"
  pass $id $label

  # --- V13 login fails closed --------------------------------------------------
  id=V13 label=login-fails-closed
  rc=0
  crp phone-app-checker login telegram </dev/null >"$log" 2>&1 &
  login_pid=$!
  (sleep 30 && kill "$login_pid") >/dev/null 2>&1 &
  watchdog=$!
  wait "$login_pid" || rc=$?
  kill "$watchdog" >/dev/null 2>&1 || true
  wait "$watchdog" >/dev/null 2>&1 || true
  [ "$rc" = "1" ] || fail $id $label "exit code $rc (expected 1, within 30 s)" "$log"
  grep -qE 'apiId|TELEGRAM_API_ID' "$log" || fail $id $label "message does not mention apiId / TELEGRAM_API_ID" "$log"
  leftover="$(find "$data_home/data/sessions" -mindepth 2 2>/dev/null | head -n 3 || true)"
  [ -z "$leftover" ] || fail $id $label "session directory left behind: $leftover"
  pass $id $label

  # --- V14 idempotent reinstall ------------------------------------------------
  id=V14 label=reinstall-idempotent
  cr /bin/bash "$bundle/install.sh" >"$T/reinstall.log" 2>&1 || fail $id $label "second install.sh exited non-zero" "$T/reinstall.log"
  chmod -R u+w "$installed"
  [ "$(grep -cF "$MARK_BEGIN" "$T/home/.zprofile")" = "1" ] || fail $id $label "PATH block count is not 1 after reinstall"
  [ "$(sha_of "$data_home/checker.config.json")" = "$config_sha" ] || fail $id $label "config changed by reinstall"
  [ "$(readlink "$base/current")" = "$version" ] || fail $id $label "current symlink changed"
  out="$(crp phone-app-checker --version 2>"$log")" || fail $id $label "--version failed after reinstall" "$log"
  [ "$out" = "$version" ] || fail $id $label "--version printed '$out' after reinstall"
  pass $id $label

  # --- V15 uninstall keeps data ------------------------------------------------
  id=V15 label=uninstall-keeps-data
  cr /bin/bash "$base/current/uninstall.sh" >"$T/uninstall.log" 2>&1 || fail $id $label "uninstall.sh exited non-zero" "$T/uninstall.log"
  [ ! -e "$base" ] && [ ! -L "$base" ] || fail $id $label "$base still exists"
  [ ! -e "$link" ] && [ ! -L "$link" ] || fail $id $label "command link still exists"
  if grep -qF "$MARK_BEGIN" "$T/home/.zprofile" 2>/dev/null; then fail $id $label "PATH block still in ~/.zprofile"; fi
  [ -d "$data_home" ] || fail $id $label "data home was removed"
  [ "$(sha_of "$data_home/checker.config.json")" = "$config_sha" ] || fail $id $label "config changed by uninstall"
  [ -f "$data_home/data/checker.db" ] || fail $id $label "checker.db was removed"
  pass $id $label

  # --- V16 reinstall + purge ---------------------------------------------------
  id=V16 label=uninstall-purge-data
  cr /bin/bash "$bundle/install.sh" >"$T/reinstall2.log" 2>&1 || fail $id $label "install.sh after uninstall exited non-zero" "$T/reinstall2.log"
  cr /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$T/purge.log" 2>&1 || fail $id $label "uninstall.sh --purge-data --yes exited non-zero" "$T/purge.log"
  [ ! -e "$data_home" ] || fail $id $label "$data_home still exists"
  [ ! -e "$base" ] && [ ! -L "$base" ] || fail $id $label "$base still exists"
  leftovers="$(find "$T/home" -iname '*phone-app-checker*' -print 2>/dev/null | head -n 5 || true)"
  [ -z "$leftovers" ] || fail $id $label "leftovers under HOME: $leftovers"
  if grep -rqF 'phone-app-checker' "$T/home" 2>/dev/null; then fail $id $label "profile files still mention phone-app-checker"; fi
  pass $id $label

  # --- V17 run lock in a configured dataDir -----------------------------------
  id=V17 label=lifecycle-honours-configured-datadir
  cr /bin/bash "$bundle/install.sh" >"$T/reinstall3.log" 2>&1 || fail $id $label "install.sh exited non-zero" "$T/reinstall3.log"
  printf '{ "dataDir": "./store" }\n' >"$data_home/checker.config.json"
  [ "$(cr "$base/current/phone-app-checker" data-dir)" = "$data_home/store" ] || fail $id $label "data-dir did not report $data_home/store"
  mkdir -p "$data_home/store"
  printf '{"pid":1}\n' >"$data_home/store/check.lock"
  if cr /bin/bash "$bundle/install.sh" >"$log" 2>&1; then fail $id $label "install.sh replaced a version while $data_home/store/check.lock exists" "$log"; fi
  grep -qF "$data_home/store/check.lock" "$log" || fail $id $label "install.sh refusal does not name the lock file" "$log"
  if cr /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$log" 2>&1; then fail $id $label "uninstall.sh ran while $data_home/store/check.lock exists" "$log"; fi
  grep -qF "$data_home/store/check.lock" "$log" || fail $id $label "uninstall.sh refusal does not name the lock file" "$log"
  [ -d "$installed" ] && [ -d "$data_home/store" ] || fail $id $label "a refused lifecycle command still removed files"
  rm -f "$data_home/store/check.lock"
  cr /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$T/purge2.log" 2>&1 || fail $id $label "uninstall.sh --purge-data --yes failed once the lock was gone" "$T/purge2.log"
  [ ! -e "$data_home" ] && [ ! -e "$base" ] || fail $id $label "uninstall left $data_home or $base"
  pass $id $label

  # --- V18 lifecycle exclusion, fail-closed repair, destructive-path ownership ---------------------
  id=V18 label=lifecycle-exclusion-and-ownership
  cr /bin/bash "$bundle/install.sh" >"$T/reinstall4.log" 2>&1 || fail $id $label "install.sh exited non-zero" "$T/reinstall4.log"
  lifecycle="$T/home/Library/Application Support/phone-app-checker-lifecycle"
  # (a) an install/uninstall that died holding the barrier: every entry point and both scripts fail closed
  /bin/bash -c 'exit 0' &
  dead_pid=$!
  wait "$dead_pid" || true
  mkdir -p "$lifecycle"
  printf '{"pid":%s}\n' "$dead_pid" >"$lifecycle/maintenance.lock"
  if crp phone-app-checker accounts >"$log" 2>&1; then fail $id $label "accounts ran while an abandoned maintenance barrier exists" "$log"; fi
  grep -q 'interrupted' "$log" || fail $id $label "accounts refusal does not explain the interrupted install/uninstall" "$log"
  if cr /bin/bash "$bundle/install.sh" >"$log" 2>&1; then fail $id $label "install.sh ran past an abandoned barrier" "$log"; fi
  if cr /bin/bash "$base/current/uninstall.sh" >"$log" 2>&1; then fail $id $label "uninstall.sh ran past an abandoned barrier" "$log"; fi
  [ -f "$lifecycle/maintenance.lock" ] && [ -d "$installed" ] || fail $id $label "a refused run removed the barrier or the installation"
  rm -f "$lifecycle/maintenance.lock"
  crp phone-app-checker accounts >"$log" 2>&1 || fail $id $label "accounts failed after the barrier was repaired" "$log"
  # (b) a running command blocks maintenance (and is named), and nothing is removed
  sleep 60 &
  holder=$!
  mkdir -p "$lifecycle/shared"
  printf '{"pid":%s}\n' "$holder" >"$lifecycle/shared/$holder.verify"
  if cr env PHONE_APP_CHECKER_LIFECYCLE_WAIT=0 /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$log" 2>&1; then
    kill "$holder" >/dev/null 2>&1 || true
    fail $id $label "uninstall.sh ran while a command was registered" "$log"
  fi
  grep -qF "pid $holder" "$log" || { kill "$holder" >/dev/null 2>&1 || true; fail $id $label "uninstall.sh refusal does not name the running command" "$log"; }
  [ ! -e "$lifecycle/maintenance.lock" ] && [ -d "$installed" ] && [ -d "$data_home" ] || fail $id $label "a refused uninstall left a barrier or removed files"
  kill "$holder" >/dev/null 2>&1 || true
  wait "$holder" >/dev/null 2>&1 || true
  rm -f "$lifecycle/shared/$holder.verify"
  # (c) a marker inside the user's own folder never makes it purgeable
  mkdir -p "$T/home/Documents"
  printf 'precious\n' >"$T/home/Documents/sentinel.txt"
  printf '{}\n' >"$T/home/Documents/checker.config.json"
  if cr env PHONE_APP_CHECKER_HOME="$T/home/Documents" /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$log" 2>&1; then fail $id $label "purge accepted ~/Documents carrying a marker" "$log"; fi
  [ -f "$T/home/Documents/sentinel.txt" ] && [ -d "$installed" ] || fail $id $label "a refused purge removed files"
  # (d) the app refuses to bootstrap its home in ~/Documents
  if crp env PHONE_APP_CHECKER_HOME="$T/home/Documents" phone-app-checker accounts >"$log" 2>&1; then fail $id $label "accounts used ~/Documents as its home" "$log"; fi
  grep -q 'your Documents folder' "$log" || fail $id $label "refusal does not name the Documents folder" "$log"
  # (e) the real purge still works and leaves no lifecycle directory behind
  cr /bin/bash "$base/current/uninstall.sh" --purge-data --yes >"$T/purge3.log" 2>&1 || fail $id $label "uninstall.sh --purge-data --yes failed" "$T/purge3.log"
  [ ! -e "$data_home" ] && [ ! -e "$base" ] && [ ! -e "$lifecycle" ] || fail $id $label "uninstall left $data_home, $base or $lifecycle"
  [ -f "$T/home/Documents/sentinel.txt" ] || fail $id $label "uninstall removed ~/Documents content"
  pass $id $label

  # --- V19 minimum-OS floor of the shipped bytes --------------------------------
  # build-release.sh checks the stage; this repeats the same per-Mach-O check on the EXTRACTED archive,
  # so what is verified is what the recipient receives. Load commands only: not a run on macOS ${MACOS_FLOOR}.
  id=V19 label=minimum-os-floor
  command -v vtool >/dev/null 2>&1 || fail $id $label "vtool not found (Xcode command line tools are required for this check)"
  macho_count=0
  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    macho_count=$((macho_count + 1))
    verdict="$(vtool -show-build "$lib" 2>&1 | awk -v floor="$MACOS_FLOOR" '
      function ver(s,  p, n) { n = split(s, p, "."); return p[1] * 10000 + (n > 1 ? p[2] : 0) * 100 + (n > 2 ? p[3] : 0) }
      /^ *cmd LC_BUILD_VERSION/ { mode = "build"; next }
      /^ *cmd LC_VERSION_MIN_MACOSX/ { mode = "legacy"; next }
      /^ *cmd LC_VERSION_MIN_/ { bad = "non-macOS minimum-version command " $2; mode = ""; next }
      mode == "build" && $1 == "platform" && $2 != "MACOS" { bad = "platform " $2 }
      mode == "build" && $1 == "minos" { found++; if (ver($2) > ver(floor)) bad = "minos " $2 " > " floor; if (top == "" || ver($2) > ver(top)) top = $2; mode = "" }
      mode == "legacy" && $1 == "version" { found++; if (ver($2) > ver(floor)) bad = "minos " $2 " > " floor; if (top == "" || ver($2) > ver(top)) top = $2; mode = "" }
      END {
        if (bad != "") print "FAIL " bad
        else if (found == 0) print "FAIL no minimum-OS load command found"
        else print "OK " top
      }')" || fail $id $label "vtool failed on ${lib#"$bundle"/}"
    case "$verdict" in
      OK\ *) ;;
      *) fail $id $label "${lib#"$bundle"/}: ${verdict#FAIL } (the documented floor is macOS $MACOS_FLOOR)" ;;
    esac
  done < <(find "$bundle" -type f -print0 | xargs -0 file -h -0 | tr '\0' '\t' | awk -F'\t: ' '$2 ~ /Mach-O/ { print $1 }')
  [ "$macho_count" -ge 4 ] || fail $id $label "inspected only $macho_count Mach-O files (expected node, better_sqlite3.node, sharp .node, libvips dylib)"
  pass $id "$label ($macho_count Mach-O files, all minos <= $MACOS_FLOOR; load commands only, not a run on macOS $MACOS_FLOOR)"

  printf '\nAll checks passed (V1-V19) for %s\n' "$archive_file"
}

main "$@"
exit $?
