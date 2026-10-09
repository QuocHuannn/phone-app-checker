#!/bin/bash
# phone-app-checker uninstaller. Usage: bash uninstall.sh [--purge-data] [--yes]
# Keeps ~/Library/Application Support/phone-app-checker (sessions, config, results) unless --purge-data.
#
# It holds the exclusive lifecycle lock for its whole run, including the DELETE confirmation, so no
# phone-app-checker command runs (or starts) while files are removed. --purge-data deletes one
# dedicated folder named "phone-app-checker" that carries the app's own marker file; it refuses
# the user's own folders, custom folders and anything overlapping the installation tree.
set -euo pipefail

MARK_BEGIN='# >>> phone-app-checker >>>'
MARK_END='# <<< phone-app-checker <<<'

usage() {
  printf 'Usage: bash uninstall.sh [--purge-data] [--yes]\n' >&2
}

# >>> shared helpers: identical in install.sh and uninstall.sh (tests/release-scripts.test.ts compares them) >>>
# --- lifecycle exclusion ------------------------------------------------------------------------
# install.sh / uninstall.sh HOLD the exclusive side for their whole run; every phone-app-checker
# command (check, login, report, accounts, doctor, account-reset) holds the shared side from before
# it opens anything (src/lock.ts has the other half of this protocol and the reasoning). The
# directory is per user and outside every tree that install or purge replaces, so it also covers
# another PHONE_APP_CHECKER_HOME, --config and an external dataDir.
#   <dir>/maintenance.lock       exclusive barrier, published atomically with ln (never overwritten)
#   <dir>/shared/<pid>.<token>   one file per running command
# The barrier is published FIRST, then registrations are read; commands register FIRST, then read
# the barrier. A barrier whose owner died is never broken here: everything fails closed until a
# person has checked that nothing runs and deleted it.
lifecycle_held=0

lc_fail() {
  printf 'Lỗi / Error: %s\n' "$1" >&2
  exit 1
}

# Pid recorded in a lock or registration file ({"pid":N,...}); prints nothing when there is none.
lifecycle_pid_of() {
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1 || true
}

# True when a process with pid $1 exists, also one owned by another user (EPERM): the same rule as
# processExists in src/lock.ts, so shell and Node agree. A pid reused by an unrelated process after
# a crash or reboot therefore counts as alive and the run is refused (fail closed), with the file
# named so a person can delete it once nothing runs.
lifecycle_pid_alive() {
  kill -0 "$1" 2>/dev/null && return 0
  [ -n "$(ps -p "$1" -o pid= 2>/dev/null)" ]
}

# The barrier exists and is not ours: say whether it is a running install/uninstall or a leftover.
# Both branches name the file and how to clear it: a "running" owner may be a reused pid.
lifecycle_busy() {
  local barrier="$1" owner
  owner="$(lifecycle_pid_of "$barrier")"
  case "$owner" in
    '' | *[!0-9]*) owner="" ;;
  esac
  if [ -n "$owner" ] && lifecycle_pid_alive "$owner"; then
    lc_fail "đang có lệnh cài đặt/gỡ cài đặt khác chạy (pid $owner, file $barrier); hãy chờ xong rồi chạy lại. Nếu không có install.sh/uninstall.sh nào đang chạy, hãy xóa $barrier (pid có thể đã bị tiến trình khác dùng lại, ví dụ sau khi mất điện) rồi chạy lại. / another install or uninstall is running (pid $owner, file $barrier); wait for it to finish, then run this again. If nothing is running, delete $barrier (the pid may have been reused by another process, for example after a power cut), then run this again."
  fi
  lc_fail "lần cài đặt/gỡ cài đặt trước bị gián đoạn (file $barrier${owner:+, pid $owner đã dừng / pid $owner is gone}). Hãy chắc chắn không còn install.sh/uninstall.sh hay lệnh phone-app-checker nào đang chạy, xóa $barrier rồi chạy lại; nếu bản cài trông không đầy đủ, chạy lại install.sh từ gói đã tải. / an earlier install or uninstall was interrupted (file $barrier${owner:+, pid $owner is gone}). Make sure no install.sh/uninstall.sh and no phone-app-checker command is running; if nothing is running, delete $barrier, then run this again; if the installation looks incomplete, run install.sh from the downloaded bundle again."
}

lifecycle_acquire() {
  local dir="$HOME/Library/Application Support/phone-app-checker-lifecycle"
  local barrier="$dir/maintenance.lock"
  local tmp="$dir/maintenance.lock.tmp.$$"
  local wait_s="${PHONE_APP_CHECKER_LIFECYCLE_WAIT:-3}"
  local start f name p live live_files
  case "$wait_s" in
    '' | *[!0-9]*) wait_s=3 ;;
  esac
  (umask 077 && mkdir -p "$dir/shared") || lc_fail "không tạo được $dir. / Cannot create $dir."
  if [ -e "$barrier" ] || [ -L "$barrier" ]; then lifecycle_busy "$barrier"; fi
  (umask 077 && printf '{"pid":%s,"startedAt":"%s"}\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$tmp") || lc_fail "không ghi được $tmp. / Cannot write $tmp."
  if ln "$tmp" "$barrier" 2>/dev/null; then
    rm -f "$tmp"
  else
    rm -f "$tmp"
    lifecycle_busy "$barrier"
  fi
  lifecycle_held=1
  start=$SECONDS
  while :; do
    live=""
    live_files=""
    for f in "$dir/shared"/*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      name="${f##*/}"
      p="${name%%.*}"
      case "$p" in
        '' | *[!0-9]*) continue ;;
      esac
      if lifecycle_pid_alive "$p"; then
        live="$live $p"
        live_files="${live_files:+$live_files, }$f"
      else
        rm -f "$f" # a command that died without cleaning up: it holds nothing
      fi
    done
    [ -n "$live" ] || return 0
    if [ $((SECONDS - start)) -ge "$wait_s" ]; then
      lifecycle_release
      lc_fail "đang có lệnh phone-app-checker chạy (pid$live, file $live_files); hãy chờ xong (hoặc đóng cửa sổ Terminal đó) rồi chạy lại. Nếu không có lệnh phone-app-checker nào đang chạy, hãy xóa $live_files (pid có thể đã bị tiến trình khác dùng lại) rồi chạy lại. / a phone-app-checker command is running (pid$live, file $live_files); wait for it to finish (or close that Terminal window), then run this again. If nothing is running, delete $live_files (the pid may have been reused by another process), then run this again."
    fi
    sleep 0.2
  done
}

lifecycle_release() {
  local barrier="$HOME/Library/Application Support/phone-app-checker-lifecycle/maintenance.lock"
  if [ "$lifecycle_held" = "1" ]; then
    lifecycle_held=0
    # Only a barrier that still names this process.
    if [ "$(lifecycle_pid_of "$barrier")" = "$$" ]; then rm -f "$barrier"; fi
  fi
}

# Remove the (then empty) lifecycle directories after the last release; a command that registered
# meanwhile keeps them (rmdir fails on a non-empty directory) and retries by itself.
lifecycle_cleanup() {
  local dir="$HOME/Library/Application Support/phone-app-checker-lifecycle"
  rmdir "$dir/shared" 2>/dev/null || true
  rmdir "$dir" 2>/dev/null || true
}

# --- paths ----------------------------------------------------------------------------------------
# Physical path of $1, also when its tail does not exist yet (symlinked ancestors are resolved).
# Fails on "." or ".." inside the part that does not exist.
canon_path() {
  local path="$1" tail="" name target phys out hops=0
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac
  while [ "${path%/}" != "$path" ] && [ -n "${path%/}" ]; do path="${path%/}"; done
  while [ ! -d "$path" ] && [ "$path" != "/" ]; do
    if [ -L "$path" ]; then
      # dangling link: follow it, so a link to a folder that does not exist yet still resolves
      hops=$((hops + 1))
      [ "$hops" -le 20 ] || return 1
      target="$(readlink "$path")" || return 1
      case "$target" in
        /*) path="$target" ;;
        *) path="${path%/*}/$target" ;;
      esac
      while [ "${path%/}" != "$path" ] && [ -n "${path%/}" ]; do path="${path%/}"; done
      continue
    fi
    name="${path##*/}"
    case "$name" in
      '' | . | ..) return 1 ;;
    esac
    tail="/$name$tail"
    path="${path%/*}"
    [ -n "$path" ] || path="/"
  done
  phys="$(cd -P "$path" 2>/dev/null && pwd)" || return 1
  [ "$phys" != "/" ] || phys=""
  out="$phys$tail"
  printf '%s\n' "${out:-/}"
}

# $1 is $2 or lies below it (compared case-folded: APFS is case-insensitive by default).
path_inside() {
  local child parent
  child="$(printf '%s/' "${1%/}" | tr '[:upper:]' '[:lower:]')"
  parent="$(printf '%s/' "${2%/}" | tr '[:upper:]' '[:lower:]')"
  case "$child" in
    "$parent"*) return 0 ;;
  esac
  return 1
}

paths_overlap() {
  path_inside "$1" "$2" || path_inside "$2" "$1"
}

# Prints the name of the user's own folder (Documents, Desktop, ~/.config, iCloud Drive, ...) that
# directory $1 is, judged by inode so symlinks and letter case cannot disguise it; returns 1 when
# it is none. Keep in step with SHARED_USER_DIRS in src/paths.ts.
shared_folder_name() {
  local name
  for name in Documents Desktop Downloads Library Applications Movies Music Pictures Public .local .config "Library/Application Support" .local/bin "Library/Mobile Documents" "Library/CloudStorage"; do
    if [ -d "$HOME/$name" ] && [ "$1" -ef "$HOME/$name" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

# Prints the name of the synced folder (~/Library/CloudStorage/*, ~/Dropbox, ~/Google Drive,
# ~/OneDrive*, ~/Box, ~/iCloud Drive) that directory $1 is; returns 1 when it is none. Keep in step
# with SYNCED_HOME_FOLDER in src/paths.ts.
synced_folder_name() {
  local dir base lower
  for dir in "$HOME"/Library/CloudStorage/*; do
    if [ -d "$dir" ] && [ "$1" -ef "$dir" ]; then
      printf 'Library/CloudStorage/%s\n' "${dir##*/}"
      return 0
    fi
  done
  for dir in "$HOME"/*; do
    [ -d "$dir" ] || continue
    base="${dir##*/}"
    lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      dropbox* | onedrive* | googledrive* | "google drive"* | iclouddrive | "icloud drive" | box | "box sync" | "box drive")
        if [ "$1" -ef "$dir" ]; then
          printf '%s\n' "$base"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

# Absolute dataDir the installed CLI reports for home $1 (hidden `data-dir` command); prints nothing
# when the launcher $2 is missing, fails, or answers something that is not an absolute path.
query_data_dir() {
  local answer
  [ -x "$2" ] || return 0
  answer="$(PHONE_APP_CHECKER_HOME="$1" "$2" data-dir 2>/dev/null </dev/null | head -n 1 || true)"
  case "$answer" in
    /*) printf '%s\n' "$answer" ;;
  esac
  return 0
}

# Prints the first run-lock file (check.lock) found for the data home and returns 0; returns 1 when none.
# check/login/account-reset lock "<dataDir>/check.lock", and dataDir comes from checker.config.json
# (default ./data, relative to the data home; absolute paths allowed), so look in two ways:
# the dataDir the CLI itself reports and any check.lock shallowly under the data home. This covers
# runs of an older version that did not register in the lifecycle directory; existence is enough to
# refuse (a stale lock names itself in the message and is safe to delete by hand).
find_run_lock() {
  local found="" dir
  if [ -d "$1" ]; then
    found="$(find -H "$1" -maxdepth 4 -name check.lock -print 2>/dev/null | head -n 1 || true)"
  fi
  if [ -z "$found" ]; then
    dir="$(query_data_dir "$1" "$2")"
    if [ -n "$dir" ] && { [ -e "$dir/check.lock" ] || [ -L "$dir/check.lock" ]; }; then found="$dir/check.lock"; fi
  fi
  [ -n "$found" ] || return 1
  printf '%s\n' "$found"
}

# --- shell profile rewrites -----------------------------------------------------------------------
# A profile is never truncated in place: the new content is written to a temp file next to the real
# file (a symlinked profile is resolved first, the link itself stays), which keeps the original's mode,
# owner, flags and extended attributes (cp -p), and is then renamed over it. An interrupted or failed
# rewrite leaves the original untouched.
resolve_link() {
  local path="$1" target n=0
  while [ -L "$path" ]; do
    n=$((n + 1))
    [ "$n" -le 20 ] || return 1
    target="$(readlink "$path")" || return 1
    case "$target" in
      /*) path="$target" ;;
      *) path="$(dirname "$path")/$target" ;;
    esac
  done
  printf '%s\n' "$path"
}

# Sets PROFILE_TARGET (real file) and PROFILE_TMP (new private file beside it, same metadata).
# Returns 1 when the profile cannot be replaced safely (directory or file not writable, ...).
profile_stage() {
  local dir
  PROFILE_TARGET="$(resolve_link "$1")" || return 1
  dir="$(dirname "$PROFILE_TARGET")"
  [ -d "$dir" ] && [ -w "$dir" ] || return 1
  if [ -e "$PROFILE_TARGET" ]; then
    [ -f "$PROFILE_TARGET" ] && [ -w "$PROFILE_TARGET" ] || return 1
  fi
  PROFILE_TMP="$(umask 077 && mktemp "$dir/.phone-app-checker-profile.XXXXXX")" || return 1
  if [ -e "$PROFILE_TARGET" ]; then
    cp -p "$PROFILE_TARGET" "$PROFILE_TMP" 2>/dev/null || { rm -f "$PROFILE_TMP"; return 1; }
  else
    chmod "$(printf '%o' $((0666 & ~$(umask))))" "$PROFILE_TMP" || { rm -f "$PROFILE_TMP"; return 1; }
  fi
}

profile_commit() {
  mv -f "$PROFILE_TMP" "$PROFILE_TARGET" || { rm -f "$PROFILE_TMP"; return 1; }
}

profile_discard() {
  rm -f "$PROFILE_TMP"
}
# <<< shared helpers <<<

strip_block() {
  profile="$1"
  [ -f "$profile" ] || return 0
  grep -qF "$MARK_BEGIN" "$profile" || return 0
  # Rewrite only when every marker line is an exact whole line and begin/end pair up one-to-one: the
  # rewrite below drops everything between a begin marker and the next exact end marker, so a closing
  # line with a trailing space/comment (or a stray or nested marker) would otherwise swallow the rest of the file.
  if ! awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { if (inside) bad = 1; inside = 1; next }
    $0 == e { if (!inside) bad = 1; inside = 0; next }
    index($0, b) || index($0, e) { bad = 1 }
    END { if (inside) bad = 1; exit bad }
  ' "$profile"; then
    printf 'Bỏ qua %s: dòng đánh dấu không khớp cặp hoặc không đúng nguyên văn; file giữ nguyên. Hãy tự xóa các dòng từ "%s" đến "%s". / Skipped %s: marker lines are unbalanced or not exact; file left untouched. Delete the lines from "%s" to "%s" by hand.\n' \
      "$profile" "$MARK_BEGIN" "$MARK_END" "$profile" "$MARK_BEGIN" "$MARK_END" >&2
    return 0
  fi
  # Atomic replace (see profile_stage): the new content is built beside the real file, which keeps its
  # mode and owner, and renamed over it; a symlinked profile (dotfiles manager) stays a symlink.
  if ! profile_stage "$profile"; then
    printf 'Bỏ qua %s: không ghi được. / Skipped %s: not writable.\n' "$profile" "$profile" >&2
    return 0
  fi
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; havep = 0; next }
    skip { if ($0 == e) skip = 0; next }
    {
      if (havep) { print pending; havep = 0 }
      if ($0 == "") { pending = $0; havep = 1; next }
      print
    }
    END { if (havep) print pending }
  ' "$PROFILE_TARGET" > "$PROFILE_TMP" || { profile_discard; return 0; }
  if profile_commit; then
    printf 'Đã gỡ khối PATH khỏi / Removed PATH block from %s\n' "$profile"
  else
    printf 'Bỏ qua %s: không ghi được. / Skipped %s: not writable.\n' "$profile" "$profile" >&2
  fi
}

# JSON.parse semantics (escaped keys, last duplicate wins, BOM) are exactly what src/config.ts uses,
# so the answer cannot disagree with the CLI. Prints N (no top-level dataDir), S<value> (a plain,
# control-free string) or X (anything else: not an object, invalid JSON, a non-string, an empty or
# control-character value). Run by the bundled Node, or by the system's JavaScriptCore via osascript.
CONFIG_PROBE_JS='function probe(text) {
  var o;
  try { o = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { return "X"; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return "X";
  if (!Object.prototype.hasOwnProperty.call(o, "dataDir")) return "N";
  var v = o.dataDir;
  if (typeof v !== "string" || v.trim() === "" || /[\u0000-\u001f\u007f]/.test(v)) return "X";
  return "S" + v;
}
'
# Stock macOS, no developer tools needed (never /usr/bin/python3: it may open the Xcode CLT installer).
JSON_OSASCRIPT=/usr/bin/osascript

# Where checker.config.json in data home $1 says dataDir is, for the case that the installed CLI
# cannot answer. Prints the absolute path (a relative value is anchored at the data home, as
# src/config.ts does) and returns 0; returns 1 when the file is absent or, as read by a real JSON
# parser, sets no dataDir; returns 2 when a dataDir is set but cannot be read with certainty, and
# also whenever no trusted parser is available or the file cannot be parsed: absence is NEVER
# inferred from a text search (a key may be written as "\u0064ataDir"), so the caller fails closed.
config_data_dir() {
  local cfg="$1/checker.config.json" node_bin="${script_dir:+$script_dir/runtime/bin/node}" answer text value
  [ -f "$cfg" ] || return 1
  if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
    answer="$(env -u NODE_OPTIONS -u NODE_PATH "$node_bin" -e "$CONFIG_PROBE_JS"'process.stdout.write(probe(require("node:fs").readFileSync(process.argv[1], "utf8")));' "$cfg" 2>/dev/null </dev/null)" || return 2
  elif [ -x "$JSON_OSASCRIPT" ]; then
    text="$(cat "$cfg" 2>/dev/null)" || return 2
    answer="$("$JSON_OSASCRIPT" -l JavaScript -e "$CONFIG_PROBE_JS"'function run(argv) { return probe(argv[0]); }' -- "$text" 2>/dev/null </dev/null)" || return 2
  else
    return 2
  fi
  case "$answer" in
    N) return 1 ;;
    S?*)
      value="${answer#S}"
      case "$value" in
        *[[:cntrl:]]*) return 2 ;;
        /*) printf '%s\n' "$value" ;;
        *) printf '%s/%s\n' "${1%/}" "$value" ;;
      esac
      ;;
    *) return 2 ;;
  esac
}

# Delete profile $1 when this installer created it (recorded in $base/.created-profiles) and it is now
# empty after the PATH block was removed. A file with any other content, a symlink, or a file the
# installer did not create is never touched.
drop_created_empty_profile() {
  local profile="$1" list="$base/.created-profiles"
  [ -f "$list" ] || return 0
  [ -f "$profile" ] && [ ! -L "$profile" ] && [ ! -s "$profile" ] || return 0
  grep -qxF "$profile" "$list" 2>/dev/null || return 0
  rm -f "$profile" && printf 'Đã xóa file trống / Removed empty file %s (do trình cài đặt tạo / created by the installer)\n' "$profile"
}

purge_unsafe() {
  printf 'Lỗi / Error: đường dẫn dữ liệu không an toàn / unsafe data path "%s": %s\n' "$1" "$2" >&2
  return 1
}

# Validates the data directory named for --purge-data and prints its physical path on stdout.
# Returns 1 (reason on stderr) when unsafe, 3 when the directory does not exist.
# Everything is decided from the physical path (cd -P) and inodes, so "$HOME//", "dir/..", symlinked
# aliases of $HOME or its parents, and letter case cannot slip past a string comparison. A whole
# folder is deleted only when it is a dedicated one: named phone-app-checker AND carrying the app's
# own marker. A marker alone proves nothing (the app also creates its config inside a folder the
# user picked, such as Documents), and neither does a name.
resolve_purge_target() {
  local raw="$1" phys phys_home shared tree lifecycle
  while [ "${raw%/}" != "$raw" ] && [ -n "${raw%/}" ]; do raw="${raw%/}"; done
  [ -n "$raw" ] || { purge_unsafe "$raw" "empty"; return 1; }
  if [ -L "$raw" ]; then purge_unsafe "$raw" "is a symlink / là symlink"; return 1; fi
  [ -e "$raw" ] || return 3
  [ -d "$raw" ] || { purge_unsafe "$raw" "not a directory / không phải thư mục"; return 1; }
  phys="$(cd -P "$raw" 2>/dev/null && pwd)" || { purge_unsafe "$raw" "cannot resolve / không phân giải được"; return 1; }
  phys_home="$(cd -P "$HOME" 2>/dev/null && pwd)" || { purge_unsafe "$raw" "cannot resolve HOME"; return 1; }
  if [ "$phys" = "/" ] || [ "$phys" = "$phys_home" ] || [ "$raw" -ef "$HOME" ]; then
    purge_unsafe "$raw" "is / or your home directory / là thư mục gốc hoặc thư mục home"
    return 1
  fi
  case "$phys_home/" in
    "$phys"/*) purge_unsafe "$raw" "contains your home directory / chứa thư mục home của bạn"; return 1 ;;
  esac
  if [ "$(stat -f '%u' "$phys" 2>/dev/null || echo x)" != "$(id -u)" ]; then
    purge_unsafe "$raw" "not owned by you / không thuộc về bạn"
    return 1
  fi
  if shared="$(shared_folder_name "$phys")"; then
    purge_unsafe "$raw" "is your own folder ($shared), not a dedicated phone-app-checker folder / là thư mục riêng của bạn ($shared), không phải thư mục riêng của phone-app-checker"
    return 1
  fi
  if shared="$(synced_folder_name "$phys")"; then
    purge_unsafe "$raw" "is a synced cloud folder ($shared); the folder itself is never deleted / là thư mục đồng bộ đám mây ($shared); không bao giờ xóa cả thư mục này"
    return 1
  fi
  tree="$(canon_path "$HOME/Applications/phone-app-checker")" || tree="$HOME/Applications/phone-app-checker"
  lifecycle="$(canon_path "$HOME/Library/Application Support/phone-app-checker-lifecycle")" || lifecycle="$HOME/Library/Application Support/phone-app-checker-lifecycle"
  if paths_overlap "$phys" "$tree" || paths_overlap "$phys" "$lifecycle"; then
    purge_unsafe "$raw" "overlaps the installation folder / trùng hoặc chứa thư mục cài đặt"
    return 1
  fi
  if [ "$(basename "$phys")" != "phone-app-checker" ]; then
    purge_unsafe "$raw" "whole-folder deletion is only done for a dedicated folder named phone-app-checker; this is a custom or shared folder, so it is kept: delete what you created there by hand (checker.config.json and the data folder) / chỉ xóa nguyên thư mục khi đó là thư mục riêng tên phone-app-checker; đây là thư mục tùy chọn hoặc dùng chung nên được giữ lại: hãy tự xóa những gì bạn đã tạo ở đó (checker.config.json và thư mục data)"
    return 1
  fi
  if { [ ! -f "$phys/checker.config.json" ] || [ -L "$phys/checker.config.json" ]; } && { [ ! -f "$phys/data/checker.db" ] || [ -L "$phys/data/checker.db" ]; }; then
    purge_unsafe "$raw" "no phone-app-checker marker (checker.config.json or data/checker.db) inside, so it is not recognised as this app's data folder / không có file đánh dấu của phone-app-checker (checker.config.json hoặc data/checker.db) nên không nhận ra là thư mục dữ liệu của ứng dụng"
    return 1
  fi
  printf '%s\n' "$phys"
}

on_exit() {
  local rc=$?
  lifecycle_release
  return "$rc"
}

PURGE_NOTE='Lưu ý / Note: chỉ xóa file trên máy này. KHÔNG đăng xuất từ xa các tài khoản (hãy gỡ thiết bị liên kết trong từng ứng dụng trước) và KHÔNG phải xóa an toàn: bản sao lưu, snapshot Time Machine có thể còn dữ liệu. / This removes local files only. It does NOT log the accounts out remotely (unlink the devices in each app first) and is NOT a secure erase: backups and Time Machine snapshots may still hold copies.'

main() {
  script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || script_dir=""
  purge=0
  assume_yes=0
  for arg in "$@"; do
    case "$arg" in
      --purge-data) purge=1 ;;
      --yes) assume_yes=1 ;;
      *) usage; exit 2 ;;
    esac
  done

  if [ -z "${HOME:-}" ]; then
    printf 'Lỗi / Error: HOME chưa được đặt / HOME is not set.\n' >&2
    exit 1
  fi
  base="$HOME/Applications/phone-app-checker"
  link="$HOME/.local/bin/phone-app-checker"
  data_home="${PHONE_APP_CHECKER_HOME:-$HOME/Library/Application Support/phone-app-checker}"

  # Exclusion first: held until the end, across the confirmation prompt and every deletion.
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  lifecycle_acquire

  # The installation tree is deleted below: data that lives inside it would go with it.
  base_phys="$(canon_path "$base")" || lc_fail "không phân giải được $base. / cannot resolve $base."
  home_phys="$(canon_path "$data_home")" || lc_fail "đường dẫn dữ liệu không hợp lệ / invalid data path: $data_home"
  # Ask the installed copy (quarantine already cleared); the scan in find_run_lock works without it.
  launcher="$base/current/phone-app-checker"
  ext_data_dir="$(query_data_dir "$data_home" "$launcher")"
  ext_phys=""
  cfg_unresolved=0
  if [ -z "$ext_data_dir" ]; then
    # The installed copy is gone (an earlier plain uninstall) or cannot answer: read the config here,
    # BEFORE anything is deleted. The result only decides what is reported or refused; deletion is
    # always limited to the validated data folder itself, never to a path read from this file.
    cfg_rc=0
    ext_data_dir="$(config_data_dir "$data_home")" || cfg_rc=$?
    if [ "$cfg_rc" -eq 2 ]; then cfg_unresolved=1; fi
    if [ -n "$ext_data_dir" ]; then
      if ext_phys="$(canon_path "$ext_data_dir")"; then
        ext_data_dir="$ext_phys" # shown as the normalised physical path (the text in the config may contain ..)
      else
        ext_phys=""
        ext_data_dir=""
        cfg_unresolved=1
      fi
    fi
  elif ext_phys="$(canon_path "$ext_data_dir")"; then
    :
  else
    lc_fail "dataDir không hợp lệ / invalid dataDir: $ext_data_dir"
  fi
  if path_inside "$home_phys" "$base_phys"; then
    lc_fail "thư mục dữ liệu $data_home nằm trong thư mục cài đặt $base_phys; gỡ cài đặt sẽ xóa luôn dữ liệu. Chưa xóa gì. Hãy chép dữ liệu ra ngoài (và đặt PHONE_APP_CHECKER_HOME ở đó) rồi chạy lại. / the data folder $data_home lies inside the installation folder $base_phys; uninstalling would delete the data too. Nothing was removed. Copy the data outside (and point PHONE_APP_CHECKER_HOME there), then run again."
  fi
  if [ -n "$ext_phys" ] && path_inside "$ext_phys" "$base_phys"; then
    lc_fail "dataDir $ext_data_dir (trong checker.config.json) nằm trong thư mục cài đặt $base_phys; gỡ cài đặt sẽ xóa luôn dữ liệu. Chưa xóa gì. / dataDir $ext_data_dir (in checker.config.json) lies inside the installation folder $base_phys; uninstalling would delete the data too. Nothing was removed."
  fi

  if lock_file="$(find_run_lock "$data_home" "$launcher")"; then
    printf 'Lỗi / Error: đang có lệnh chạy / a command is running (%s). Hãy chờ xong rồi gỡ cài đặt; nếu không còn lệnh nào chạy, xóa file này. / Wait for it to finish, then uninstall; if nothing is running, delete that file.\n' "$lock_file" >&2
    exit 1
  fi

  # Decide on data purge up front, before anything is removed.
  do_purge=0
  purge_target=""
  if [ "$purge" -eq 1 ]; then
    rc=0
    purge_target="$(resolve_purge_target "$data_home")" || rc=$?
    case "$rc" in
      0) ;;
      3) printf 'Không có dữ liệu để xóa / No data to delete: %s\n' "$data_home" ;;
      *) exit 1 ;;
    esac
    if [ "$rc" -eq 0 ]; then
      # A dataDir that is set in the config but could not be located must never be guessed at, and the
      # config that records where it is must not be deleted: refuse before anything is removed.
      if [ "$cfg_unresolved" -eq 1 ]; then
        printf 'Lỗi / Error: %s có đặt dataDir nhưng không xác định được chắc chắn thư mục đó (bản cài đã gỡ hoặc file cấu hình khác thường). Chưa xóa gì, cấu hình được giữ nguyên. Hãy xem dataDir trong file đó, tự xóa thư mục ấy nếu muốn, rồi chạy lại; hoặc gỡ cài đặt không kèm --purge-data. / %s sets a dataDir but its location could not be determined reliably (the installed copy is gone, or the config is unusual). Nothing was removed and the config was kept. Read dataDir in that file, delete that folder by hand if you want to, then run again; or uninstall without --purge-data.\n' "$data_home/checker.config.json" "$data_home/checker.config.json" >&2
        exit 1
      fi
      if [ "$assume_yes" -eq 1 ]; then
        do_purge=1
      else
        printf 'Sẽ xóa vĩnh viễn / This permanently deletes: %s\n' "$purge_target"
        printf '(phiên đăng nhập, cấu hình, kết quả / logged-in sessions, config, results)\n'
        if [ -n "$ext_phys" ] && ! path_inside "$ext_phys" "$purge_target"; then
          printf 'KHÔNG xóa thư mục dữ liệu ngoài / NOT deleted, external data directory: %s\n' "$ext_data_dir"
        fi
        printf '%s\n' "$PURGE_NOTE"
        printf 'Gõ DELETE để xác nhận / Type DELETE to confirm: '
        line=""
        read -r line || true
        if [ "$line" = "DELETE" ]; then
          do_purge=1
        else
          printf 'Không xác nhận; dữ liệu được giữ lại. / Not confirmed; data kept.\n'
        fi
      fi
    fi
  fi

  # Command link: only if it points into our install tree.
  if [ -L "$link" ]; then
    target="$(readlink "$link")"
    case "$target" in
      "$base"/*)
        rm -f "$link"
        printf 'Đã xóa / Removed %s\n' "$link"
        ;;
      *)
        printf 'Giữ nguyên / Kept %s (không trỏ vào bản cài này / not ours).\n' "$link"
        ;;
    esac
  elif [ -e "$link" ]; then
    printf 'Giữ nguyên / Kept %s (không phải symlink của phone-app-checker / not ours).\n' "$link"
  fi

  strip_block "$HOME/.zprofile"
  strip_block "$HOME/.bash_profile"
  drop_created_empty_profile "$HOME/.zprofile"
  drop_created_empty_profile "$HOME/.bash_profile"

  if [ -e "$base" ] || [ -L "$base" ]; then
    chmod -R u+w "$base" 2>/dev/null || true
    rm -rf "$base"
    printf 'Đã xóa / Removed %s\n' "$base"
  fi

  if [ "$do_purge" -eq 1 ]; then
    chmod -R u+w "$purge_target" 2>/dev/null || true
    rm -rf "$purge_target"
    printf 'Đã xóa dữ liệu / Deleted data: %s\n' "$purge_target"
    if [ -n "$ext_phys" ] && ! path_inside "$ext_phys" "$purge_target"; then
      printf 'Giữ lại, KHÔNG xóa / Kept, NOT deleted: thư mục dữ liệu ngoài / external data directory %s (vẫn chứa phiên đăng nhập và kết quả; hãy tự xóa khi không cần nữa / still holds sessions and results; delete it by hand when you no longer need it)\n' "$ext_data_dir"
    fi
    printf '%s\n' "$PURGE_NOTE"
  elif [ "$purge" -eq 0 ]; then
    printf 'Giữ lại / Kept: %s (phiên đăng nhập, kết quả / sessions = logged-in accounts, results). Xóa bằng / Delete with --purge-data\n' "$data_home"
    if [ -n "$ext_phys" ] && ! path_inside "$ext_phys" "$home_phys"; then
      printf 'Giữ lại / Kept: thư mục dữ liệu ngoài / external data directory %s\n' "$ext_data_dir"
    fi
    if [ "$cfg_unresolved" -eq 1 ]; then
      printf 'Lưu ý / Note: %s có đặt dataDir nhưng không đọc được chắc chắn; thư mục đó (nếu nằm ngoài thư mục dữ liệu) không bị đụng tới. / %s sets a dataDir that could not be read reliably; that folder (if outside the data folder) was not touched.\n' "$data_home/checker.config.json" "$data_home/checker.config.json"
    fi
  else
    printf 'Giữ lại / Kept: %s\n' "$data_home"
    if [ -n "$ext_phys" ] && ! path_inside "$ext_phys" "$home_phys"; then
      printf 'Giữ lại / Kept: thư mục dữ liệu ngoài / external data directory %s\n' "$ext_data_dir"
    fi
    if [ "$cfg_unresolved" -eq 1 ]; then
      printf 'Lưu ý / Note: %s có đặt dataDir nhưng không đọc được chắc chắn; thư mục đó (nếu nằm ngoài thư mục dữ liệu) không bị đụng tới. / %s sets a dataDir that could not be read reliably; that folder (if outside the data folder) was not touched.\n' "$data_home/checker.config.json" "$data_home/checker.config.json"
    fi
  fi

  lifecycle_release
  lifecycle_cleanup
}

main "$@"
exit $?
