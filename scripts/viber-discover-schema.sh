#!/usr/bin/env bash
# List candidate tables/columns in the Viber databases on an Android emulator/device so you
# can write the `registeredQuery` / `syncedQuery` / `authQuery` options of the Viber adapter.
#
# Read-only: copies each database into a private temp dir, inspects the copy with the local
# sqlite3 CLI, then deletes the copy. Prints schema, row counts and value distributions of
# small integer-only flag columns. It never prints row values of text columns, so the
# output holds no phone numbers or names.
#
# Usage: scripts/viber-discover-schema.sh [adb-serial]
#   env: ADB (adb binary, default adb), ANDROID_SERIAL, VIBER_PACKAGE (default com.viber.voip)
# Needs: adb, local sqlite3, and root on the device (AVD "Google APIs" image, or rooted phone).
set -euo pipefail

PKG="${VIBER_PACKAGE:-com.viber.voip}"
ADB_BIN="${ADB:-adb}"
SERIAL="${1:-${ANDROID_SERIAL:-}}"

# The package name ends up inside device shell commands: accept only a plain Android package id.
if [[ ! "$PKG" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]]; then
  echo "VIBER_PACKAGE must be a plain Android package name such as com.viber.voip." >&2
  exit 1
fi

command -v "$ADB_BIN" >/dev/null || { echo "adb not found (set ADB=/path/to/adb)" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "local sqlite3 CLI not found" >&2; exit 1; }

ADB_CMD=("$ADB_BIN")
if [[ -n "$SERIAL" ]]; then ADB_CMD+=(-s "$SERIAL"); fi

if ! "${ADB_CMD[@]}" get-state >/dev/null 2>&1; then
  echo "No usable adb device. 'adb devices' shows:" >&2
  "$ADB_BIN" devices >&2
  echo "Pass a serial as the first argument when several devices are attached." >&2
  exit 1
fi

if [[ -z "$("${ADB_CMD[@]}" shell "pm path $PKG" | tr -d '\r')" ]]; then
  echo "$PKG is not installed on the device." >&2
  exit 1
fi
VERSION="$("${ADB_CMD[@]}" shell "dumpsys package $PKG | grep -m1 versionName=" | tr -d '\r' | xargs || true)"
echo "== Viber package: $PKG ${VERSION:-(version unknown)}"

# --- root access: adbd root, `adb root`, or su -c ------------------------------------------
ROOT_MODE=""
uid() { "${ADB_CMD[@]}" shell id -u 2>/dev/null | tr -d '\r' || true; }
if [[ "$(uid)" == "0" ]]; then
  ROOT_MODE="adbd"
else
  "${ADB_CMD[@]}" root >/dev/null 2>&1 || true
  "${ADB_CMD[@]}" wait-for-device
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ "$(uid)" == "0" ]]; then ROOT_MODE="adbd"; break; fi
    sleep 1
  done
  if [[ -z "$ROOT_MODE" ]] && [[ "$("${ADB_CMD[@]}" shell "su -c 'id -u'" 2>/dev/null | tr -d '\r' || true)" == "0" ]]; then
    ROOT_MODE="su"
  fi
fi
if [[ -z "$ROOT_MODE" ]]; then
  echo "No root access (neither adb root nor su). Viber's private DB cannot be read." >&2
  echo "Use an AVD with a 'Google APIs' image (not 'Google Play') or a rooted phone: docs/viber-setup.md" >&2
  exit 1
fi

# Quote a value for a POSIX shell on the device: 'it'\''s' form, safe for any content.
sq() {
  local quote="'" value="$1"
  printf "'%s'" "${value//$quote/$quote\\$quote$quote}"
}
root_sh() { # run a command string as root on the device
  if [[ "$ROOT_MODE" == "su" ]]; then
    "${ADB_CMD[@]}" shell "su -c $(sq "$1")"
  else
    "${ADB_CMD[@]}" shell "$1"
  fi
}
root_cat() { # root_cat <remote path> <local file>; false when the file is absent
  local remote="$1" local_file="$2"
  if [[ "$(root_sh "test -f $(sq "$remote") && echo yes || echo no" | tr -d '\r')" != "yes" ]]; then return 1; fi
  if [[ "$ROOT_MODE" == "su" ]]; then
    "${ADB_CMD[@]}" exec-out "su -c $(sq "cat $(sq "$remote")")" >"$local_file"
  else
    "${ADB_CMD[@]}" exec-out "cat $(sq "$remote")" >"$local_file"
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DB_DIR="/data/data/$PKG/databases"
SAFE_NAME='^[A-Za-z0-9_][A-Za-z0-9._-]*$'
FILES=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # File names are chosen by the app being inspected: only plain names are ever put into a
  # root shell command or a local path.
  if [[ "$line" =~ $SAFE_NAME ]]; then
    FILES+=("$line")
  else
    echo "skipping a database entry with an unsafe name: $(printf '%q' "$line")" >&2
  fi
done < <(root_sh "ls -1 $(sq "$DB_DIR") 2>/dev/null || true" | tr -d '\r' | grep -Ev -- '-(journal|wal|shm)$' || true)
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No databases in $DB_DIR. Open Viber and finish activation first." >&2
  exit 1
fi
echo "== Databases in $DB_DIR: ${FILES[*]}"

q() { sqlite3 -batch "$1" "$2"; }

for name in "${FILES[@]}"; do
  db="$WORK/$name"
  echo
  echo "################################################################"
  echo "# $DB_DIR/$name"
  echo "################################################################"
  root_cat "$DB_DIR/$name" "$db" || { echo "(cannot read file)"; continue; }
  root_cat "$DB_DIR/$name-wal" "$db-wal" 2>/dev/null || rm -f "$db-wal"

  if [[ "$(head -c 15 "$db")" != "SQLite format 3" ]]; then
    echo "(not a plain SQLite file: encrypted or other format, skipped)"
    continue
  fi

  echo "-- tables / views, row counts, columns"
  while IFS= read -r table; do
    [[ -z "$table" ]] && continue
    esc="${table//\"/\"\"}"
    rows="$(q "$db" "SELECT COUNT(*) FROM \"$esc\"" 2>/dev/null || echo '?')"
    sq="'"
    cols="$(q "$db" "SELECT group_concat(name || ':' || type, ', ') FROM pragma_table_info('${table//$sq/$sq$sq}')" 2>/dev/null || true)"
    echo "  $table  [rows=$rows]"
    echo "      $cols"
  done < <(q "$db" "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")

  echo
  echo "-- candidate columns (name suggests phone number / registration / account)"
  q "$db" "
    SELECT '  ' || m.name || '.' || p.name || ' (' || p.type || ')'
    FROM sqlite_master m JOIN pragma_table_info(m.name) p
    WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
      AND ( lower(p.name) GLOB '*phone*' OR lower(p.name) GLOB '*number*' OR lower(p.name) GLOB '*msisdn*'
         OR lower(p.name) GLOB '*canon*' OR lower(p.name) GLOB '*viber*' OR lower(p.name) GLOB '*regist*'
         OR lower(p.name) GLOB '*member*' OR lower(p.name) GLOB '*account*' OR lower(p.name) GLOB '*user*' )
    ORDER BY m.name, p.cid" || true

  echo
  echo "-- value distribution of small integer-only flag-like columns (counts only)"
  while IFS='|' read -r table col; do
    [[ -z "$table" ]] && continue
    t="${table//\"/\"\"}"
    c="${col//\"/\"\"}"
    # integer-only, few distinct values, small magnitude: safe to print (cannot be phone numbers)
    ok="$(q "$db" "SELECT CASE WHEN COUNT(*)>0
                     AND SUM(typeof(\"$c\") NOT IN ('integer','null'))=0
                     AND COUNT(DISTINCT \"$c\")<=8
                     AND MAX(ABS(COALESCE(\"$c\",0)))<=1000000 THEN 1 ELSE 0 END FROM \"$t\"" 2>/dev/null || echo 0)"
    [[ "$ok" == "1" ]] || continue
    echo "  $table.$col:"
    q "$db" "SELECT '      ' || COALESCE(\"$c\",'NULL') || ' -> ' || COUNT(*) || ' rows' FROM \"$t\" GROUP BY \"$c\" ORDER BY \"$c\"" || true
  done < <(q "$db" "
    SELECT m.name || '|' || p.name
    FROM sqlite_master m JOIN pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
      AND ( lower(p.name) GLOB '*viber*' OR lower(p.name) GLOB '*regist*' OR lower(p.name) GLOB '*is_*'
         OR lower(p.name) GLOB '*has_*' OR lower(p.name) GLOB '*flag*' OR lower(p.name) GLOB '*status*'
         OR lower(p.name) GLOB '*state*' OR lower(p.name) GLOB '*type*' )
    ORDER BY m.name, p.cid")
done

cat <<'EOF'

== Next steps
1. Pick the table/column that lists numbers Viber has ingested from the phonebook (-> syncedQuery)
   and the flag that marks a number as a Viber user (-> registeredQuery).
2. Verify on a spike: inject ~10 numbers you KNOW are on Viber / not on Viber, and compare.
3. Put the three queries under apps.viber.options in checker.config.json (docs/viber-setup.md):
     registeredQuery  SELECT <number col> AS number FROM <table> WHERE <viber flag condition>
     syncedQuery      SELECT <number col> AS number FROM <table>
     authQuery        SELECT 1 FROM <table> WHERE <row that exists only when activated> LIMIT 1
   Numbers must come out as digits (any +/space/dash is stripped) in full international form
   (e.g. 84901234567): rewrite them in SQL if Viber stores a national or partial form.
EOF
