#!/bin/bash
# phone-app-checker installer (per user, no sudo). Run: bash install.sh
# Works from the extracted bundle or from an installed version directory (rollback).
#
# It holds the exclusive lifecycle lock from the first change until the new version is active, so no
# phone-app-checker command runs (or starts) while the installation is replaced. The previous copy of
# the same version is kept until the new one passed its self-check, so an interruption never leaves
# the machine without a recoverable installation (see "interrupted install" in the install guide).
set -euo pipefail

MARK_BEGIN='# >>> phone-app-checker >>>'
MARK_END='# <<< phone-app-checker <<<'

die() {
  printf 'Lỗi / Error: %s\n' "$1" >&2
  exit 1
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

# --- activation state (for the EXIT trap) ------------------------------------------------------------
incoming=""      # copy being prepared next to the installed versions
old_dir=""       # previous copy of this version, kept until the new one is active
created_dest=0   # 1 once the new copy sits at $dest
activation=idle  # idle -> pending (something to undo on failure) -> done
prev_current=""  # target of the "current" link before this run ("" = none)
had_current=0
had_cmd_link=0

# Atomically point link $2 at $1: build the new link beside it, then rename it over the old one
# (mv -h: do not follow the old link into its target directory).
switch_link() {
  local tmp
  tmp="$(dirname "$2")/.$(basename "$2").new.$$"
  rm -f "$tmp"
  ln -s "$1" "$tmp" && /bin/mv -fh "$tmp" "$2"
}

# Undo a failed or interrupted activation: drop the new copy and put the previous one back.
rollback_activation() {
  if [ "$created_dest" = "1" ] && [ -e "$dest" ]; then
    chmod -R u+w "$dest" 2>/dev/null || true
    rm -rf "$dest"
  fi
  if [ -n "$old_dir" ] && [ -d "$old_dir" ] && [ ! -e "$dest" ]; then
    mv "$old_dir" "$dest" || true
  fi
  if [ "$had_current" = "1" ]; then
    switch_link "$prev_current" "$base/current" || true
  elif [ "$had_current" = "0" ] && [ -L "$base/current" ]; then
    rm -f "$base/current"
  fi
  if [ "$had_cmd_link" = "0" ] && [ -L "$cmd_link" ] && [ ! -e "$cmd_link" ]; then
    rm -f "$cmd_link"
  fi
}

on_exit() {
  local rc=$?
  if [ -n "$incoming" ] && [ -e "$incoming" ]; then
    chmod -R u+w "$incoming" 2>/dev/null || true
    rm -rf "$incoming"
  fi
  if [ "$rc" -ne 0 ] && [ "$activation" = "pending" ]; then
    rollback_activation
  fi
  lifecycle_release
  return "$rc"
}

# A previous run killed between "move the old copy aside" and "move the new copy in" leaves
# $base/.replaced.<version>.* and no $base/<version>: put it back (the bundle that is being installed
# right now is never moved, it is copied from).
recover_interrupted_activation() {
  local leftover name ver
  for leftover in "$base"/.replaced.*; do
    [ -d "$leftover" ] || continue
    if [ "$leftover" -ef "$src_root" ]; then continue; fi
    name="${leftover##*/}"
    ver="${name#.replaced.}"
    ver="${ver%.*.*}"
    [ -n "$ver" ] || continue
    if [ ! -e "$base/$ver" ] && [ ! -L "$base/$ver" ]; then
      mv "$leftover" "$base/$ver" && printf 'Đã khôi phục bản cài bị gián đoạn / Restored an interrupted installation: %s\n' "$base/$ver"
    fi
  done
}

main() {
  # --- 1. guards -------------------------------------------------------------
  [ -n "${HOME:-}" ] || die "HOME chưa được đặt / HOME is not set."
  [ "$(uname -s)" = "Darwin" ] || die "Chỉ hỗ trợ macOS / macOS only."
  if [ "$(uname -m)" != "arm64" ]; then
    die "Cần Mac Apple Silicon (arm64); Terminal đang chạy dưới Rosetta hoặc đây là Mac Intel. / Apple Silicon (arm64) required; this Terminal runs under Rosetta or the Mac is Intel."
  fi
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    die "Terminal đang chạy dưới Rosetta; hãy tắt 'Open using Rosetta' trong Get Info của Terminal. / Terminal runs under Rosetta; disable 'Open using Rosetta' in Terminal's Get Info."
  fi
  os_version="$(sw_vers -productVersion 2>/dev/null || true)"
  os_major="${os_version%%.*}"
  os_rest="${os_version#*.}"
  if [ "$os_rest" = "$os_version" ]; then os_rest=0; fi
  os_minor="${os_rest%%.*}"
  case "$os_major" in
    '' | *[!0-9]*) os_major="" ;;
  esac
  case "$os_minor" in
    '' | *[!0-9]*) os_minor="" ;;
  esac
  if [ -z "$os_major" ] || [ -z "$os_minor" ]; then
    die "Không đọc được phiên bản macOS ('$os_version'). / Cannot read the macOS version ('$os_version')."
  fi
  if [ "$os_major" -lt 13 ] || { [ "$os_major" -eq 13 ] && [ "$os_minor" -lt 5 ]; }; then
    die "Cần macOS 13.5 trở lên (hiện là $os_version). / macOS 13.5 or newer required (found $os_version)."
  fi

  # --- 2. locate bundle ------------------------------------------------------
  src_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$src_root/VERSION" ] || die "Thiếu VERSION trong $src_root. / Missing VERSION in $src_root."
  version="$(cat "$src_root/VERSION")"
  case "$version" in
    ''|*[!0-9A-Za-z._-]*) die "VERSION không hợp lệ / invalid VERSION: '$version'." ;;
  esac
  [ -x "$src_root/runtime/bin/node" ] || die "Thiếu runtime/bin/node trong $src_root. / Missing runtime/bin/node in $src_root."
  [ -f "$src_root/app/bin/phone-app-checker.js" ] || die "Thiếu app/bin/phone-app-checker.js trong $src_root. / Missing app/bin/phone-app-checker.js in $src_root."

  # --- 3. paths --------------------------------------------------------------
  base="$HOME/Applications/phone-app-checker"
  dest="$base/$version"
  data_home="${PHONE_APP_CHECKER_HOME:-$HOME/Library/Application Support/phone-app-checker}"
  cmd_link="$HOME/.local/bin/phone-app-checker"

  # Never replace someone else's command: only our own link (into $base) may be overwritten.
  if [ -L "$cmd_link" ]; then
    cmd_target="$(readlink "$cmd_link")"
    case "$cmd_target" in
      "$base"/*) had_cmd_link=1 ;;
      *) die "$cmd_link đã tồn tại và không thuộc phone-app-checker (trỏ tới $cmd_target); hãy đổi tên hoặc xóa nó rồi chạy lại. / $cmd_link already exists and is not ours (points to $cmd_target); rename or remove it, then rerun." ;;
    esac
  elif [ -e "$cmd_link" ]; then
    die "$cmd_link đã tồn tại và không phải symlink của phone-app-checker; hãy đổi tên hoặc xóa nó rồi chạy lại. / $cmd_link already exists and is not a phone-app-checker symlink; rename or remove it, then rerun."
  fi

  # --- 4. exclusion: from here on no phone-app-checker command can run or start ----------
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  lifecycle_acquire

  # The installation tree is replaced on every install and deleted on uninstall: user data must not live in it.
  base_phys="$(canon_path "$base")" || die "Không phân giải được $base. / Cannot resolve $base."
  home_phys="$(canon_path "$data_home")" || die "Đường dẫn dữ liệu không hợp lệ / invalid data path: $data_home"
  if path_inside "$home_phys" "$base_phys"; then
    die "thư mục dữ liệu $data_home nằm trong thư mục cài đặt $base_phys (bị thay thế khi cài và xóa khi gỡ). Đặt PHONE_APP_CHECKER_HOME ra ngoài rồi chạy lại. / the data folder $data_home lies inside the installation folder $base_phys (replaced on install, deleted on uninstall). Point PHONE_APP_CHECKER_HOME outside it and run again."
  fi
  ext_data_dir=""
  if [ -d "$base_phys" ]; then
    ext_data_dir="$(query_data_dir "$data_home" "$dest/phone-app-checker")"
    if [ -z "$ext_data_dir" ]; then
      ext_data_dir="$(query_data_dir "$data_home" "$base/current/phone-app-checker")"
    fi
  fi
  if [ -n "$ext_data_dir" ]; then
    ext_phys="$(canon_path "$ext_data_dir")" || die "dataDir không hợp lệ / invalid dataDir: $ext_data_dir"
    if path_inside "$ext_phys" "$base_phys"; then
      die "dataDir $ext_data_dir (trong checker.config.json) nằm trong thư mục cài đặt $base_phys. Đổi dataDir ra ngoài rồi chạy lại. / dataDir $ext_data_dir (in checker.config.json) lies inside the installation folder $base_phys. Move dataDir outside it and run again."
    fi
  fi

  # --- 5. copy, then activate with the old copy retained -----------------------
  if [ -d "$base" ]; then
    recover_interrupted_activation
    rm -rf "$base"/.incoming.* 2>/dev/null || true
  fi
  # What "current" points at now, recorded BEFORE anything is marked for rollback: a failure or Ctrl-C at
  # any later point must put this link back, and must only delete a link this run created itself.
  if [ -L "$base/current" ]; then
    prev_current="$(readlink "$base/current")"
    had_current=1
  fi
  dest_phys=""
  if [ -d "$dest" ]; then
    dest_phys="$(cd -P "$dest" && pwd)"
  fi
  if [ "$src_root" != "$dest_phys" ]; then
    # Ask the installed copy (quarantine already cleared), never the freshly downloaded bundle: running a
    # quarantined binary can stop on a Gatekeeper prompt.
    if { [ -e "$dest" ] || [ -L "$dest" ]; } && lock_file="$(find_run_lock "$data_home" "$dest/phone-app-checker")"; then
      die "Đang có lệnh chạy ($lock_file); hãy chờ xong rồi cài lại. Nếu không còn lệnh nào chạy, xóa $lock_file rồi cài lại. / A command is running ($lock_file); wait for it to finish, then reinstall. If nothing is running, delete $lock_file, then reinstall."
    fi
    mkdir -p "$base"
    # copy first, swap after: a failed copy (disk full) leaves the existing install untouched
    incoming="$base/.incoming.$version.$$"
    rm -rf "$incoming"
    if ! cp -R "$src_root" "$incoming"; then
      die "Không chép được vào $base (hết dung lượng?). / Cannot copy into $base (disk full?)."
    fi
    activation=pending
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      # Kept (not deleted) until the new copy passed its self-check; an interruption at any point
      # leaves it recoverable as $base/.replaced.<version>.*
      old_dir="$base/.replaced.$version.$$.$RANDOM"
      chmod -R u+w "$dest" 2>/dev/null || true
      mv "$dest" "$old_dir"
    fi
    mv "$incoming" "$dest"
    created_dest=1
    incoming=""
  fi

  # --- 6. quarantine ---------------------------------------------------------
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  left="$(xattr -lr "$dest" 2>/dev/null || true)"
  case "$left" in
    *com.apple.quarantine*)
      die "Vẫn còn cờ quarantine. Chạy: xattr -dr com.apple.quarantine \"$dest\" / Quarantine flag remains. Run: xattr -dr com.apple.quarantine \"$dest\""
      ;;
  esac

  # --- 7. links (each switched atomically) -----------------------------------
  activation=pending
  mkdir -p "$HOME/.local/bin"
  switch_link "$version" "$base/current"
  switch_link "$base/current/phone-app-checker" "$cmd_link"

  # --- 8. PATH ---------------------------------------------------------------
  path_note=""
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      profile=""
      case "$(basename "${SHELL:-/bin/zsh}")" in
        zsh) profile="$HOME/.zprofile" ;;
        bash) profile="$HOME/.bash_profile" ;;
      esac
      manual_path_note="Thêm dòng sau vào file khởi động shell của bạn / Add this line to your shell startup file: export PATH=\"\$HOME/.local/bin:\$PATH\""
      profile_absent=0
      if [ -n "$profile" ] && [ ! -e "$profile" ] && [ ! -L "$profile" ]; then profile_absent=1; fi
      if [ -z "$profile" ]; then
        path_note="$manual_path_note"
      elif [ -f "$profile" ] && grep -qF "$MARK_BEGIN" "$profile"; then
        path_note="PATH đã được cấu hình trong $profile / PATH already configured in $profile"
      elif profile_stage "$profile"; then
        {
          if [ -s "$PROFILE_TARGET" ]; then
            cat "$PROFILE_TARGET"
            # make sure the block starts on its own line, separated by one blank line
            if [ -n "$(tail -c 1 "$PROFILE_TARGET")" ]; then
              printf '\n'
            fi
            printf '\n'
          fi
          printf '%s\n' "$MARK_BEGIN"
          printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
          printf '%s\n' "$MARK_END"
        } >"$PROFILE_TMP" || { profile_discard; die "Không ghi được $profile. / Cannot write $profile."; }
        if profile_commit; then
          # Remember that this run created the file (it did not exist), so uninstall may delete it again if
          # nothing but our block was ever in it.
          if [ "$profile_absent" = "1" ]; then printf '%s\n' "$profile" >>"$base/.created-profiles" || true; fi
          path_note="Đã thêm PATH vào $profile / Added PATH to $profile"
        else
          path_note="Không sửa được $profile. $manual_path_note / Could not update $profile. $manual_path_note"
        fi
      else
        path_note="Không sửa được $profile (không ghi được). $manual_path_note / Could not update $profile (not writable). $manual_path_note"
      fi
      ;;
  esac

  # --- 9. self-check, then the old copy is no longer needed -------------------
  if ! "$dest/phone-app-checker" --version >/dev/null; then
    die "'phone-app-checker --version' thất bại. / 'phone-app-checker --version' failed."
  fi
  activation="done"
  if [ -n "$old_dir" ] && [ -d "$old_dir" ]; then
    chmod -R u+w "$old_dir" 2>/dev/null || true
    rm -rf "$old_dir"
  fi
  for leftover in "$base"/.replaced."$version".*; do
    [ -d "$leftover" ] || continue
    chmod -R u+w "$leftover" 2>/dev/null || true
    rm -rf "$leftover"
  done
  # Installing is finished: commands may run again (doctor below registers like any other command).
  lifecycle_release

  printf '\n--- phone-app-checker doctor ---\n'
  # Installing succeeded either way (files are in place and --version ran), so this does not change the
  # exit status; but a FAIL must never be followed by an unqualified success line.
  doctor_status=0
  "$dest/phone-app-checker" doctor --deep || doctor_status=$?
  printf -- '--------------------------------\n\n'

  # --- 10. summary -----------------------------------------------------------
  if [ "$doctor_status" -eq 0 ]; then
    printf 'Đã chép file / Files installed: phone-app-checker %s (doctor: không có FAIL / no FAIL)\n' "$version"
    printf '  CHƯA đủ để tin kết quả: doctor chỉ kiểm tra offline. Hãy đăng nhập (login) rồi chạy thử một lô nhỏ có đáp án đã biết.\n'
    printf '  NOT yet trustworthy: doctor checks offline readiness only. Run login, then a small trial with known-truth numbers.\n'
  else
    printf 'CHƯA SẴN SÀNG / NOT READY: phone-app-checker %s đã được chép vào máy nhưng doctor báo FAIL (mã / exit %s).\n' "$version" "$doctor_status"
    printf '  Sửa mọi dòng FAIL ở trên rồi chạy lại / Fix every FAIL above, then run: phone-app-checker doctor --deep\n'
  fi
  printf '  Thư mục / Location : %s\n' "$dest"
  printf '  Lệnh / Command     : %s\n' "$HOME/.local/bin/phone-app-checker"
  [ -z "$path_note" ] || printf '  %s\n' "$path_note"
  printf '  Mở cửa sổ Terminal mới, hoặc chạy / Open a new Terminal window, or run:\n'
  printf '    export PATH="$HOME/.local/bin:$PATH"\n'
  printf '  Bước tiếp theo / Next step: gõ  phone-app-checker  (không thêm gì khác) rồi Enter để mở menu; chọn số trong menu.\n'
  printf '    Type  phone-app-checker  alone and press Enter to open the menu (no commands to remember).\n'
  printf '    Menu mặc định tiếng Anh; gõ L rồi Enter để đổi sang tiếng Việt / The menu is in English by default; type L then Enter to change the language.\n'
  printf '  Cấu hình / Config  : %s\n' "$data_home/checker.config.json"
  others=""
  for d in "$base"/*; do
    [ -d "$d" ] || continue
    [ -L "$d" ] && continue
    name="$(basename "$d")"
    [ "$name" = "$version" ] && continue
    others="$others $name"
  done
  if [ -n "$others" ]; then
    printf '  Phiên bản cũ còn lại / Other installed versions:%s\n' "$others"
    for name in $others; do
      printf '    xóa / delete: rm -rf "%s"\n' "$base/$name"
    done
    printf '  Quay lại / Rollback: bash "%s/<phiên-bản>/install.sh"\n' "$base"
  fi
}

main "$@"
exit $?
