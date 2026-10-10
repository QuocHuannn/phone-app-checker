#!/bin/bash
# Builds the macOS arm64 portable release: dist/phone-app-checker-<version>-macos-arm64.tar.gz (+ .sha256).
# Inputs are pinned: Node version + sha256 below, package-lock.json. Needs network (Node tarball, npm, JSR, audit).
# Usage: npm run release:build
set -euo pipefail

# --- pinned runtime (the only place to bump Node) ----------------------------
NODE_VERSION=24.21.0
NODE_DIST="node-v${NODE_VERSION}-darwin-arm64"
NODE_SHA256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 # verified 2026-10-08 vs https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_TEAM_ID=HX7739G8FX # Node.js Foundation Developer ID
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin
# Documented minimum macOS (release/install.sh, docs/install-macos.md, README.md, plan.md). Every shipped
# Mach-O must declare a minimum OS <= this value (minos gate below); compiled addons target it.
MACOS_FLOOR=13.5

step() { printf '\n==> %s\n' "$1"; }
die() {
  printf 'BUILD FAILED: %s\n' "$1" >&2
  exit 1
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

main() {
  root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$root"

  # --- 1. guards -------------------------------------------------------------
  step "Guards"
  [ "$(uname -s)" = "Darwin" ] || die "must run on macOS."
  [ "$(uname -m)" = "arm64" ] || die "must run on Apple Silicon (uname -m = $(uname -m)); native addons would be built for the wrong CPU."
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    die "this shell runs under Rosetta; native addons would be built for x86_64."
  fi
  for tool in curl tar shasum codesign file ditto xattr awk find vtool; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
  done
  [ -f package.json ] && [ -f package-lock.json ] || die "package.json / package-lock.json missing in $root."
  for f in release/phone-app-checker release/install.sh release/uninstall.sh docs/install-macos.md docs/install-macos.vi.md \
    LICENSE THIRD_PARTY_LICENSES.md checker.config.example.json .npmrc README.md scripts/viber-discover-schema.sh bin/phone-app-checker.js tsconfig.build.json; do
    [ -f "$f" ] || die "required source file missing: $f"
  done

  # --- 2. pinned Node runtime ------------------------------------------------
  step "Node ${NODE_VERSION} (darwin-arm64)"
  cache="$root/dist/.cache"
  mkdir -p "$cache"
  tarball="$cache/${NODE_DIST}.tar.gz"
  if [ ! -f "$tarball" ]; then
    printf 'Downloading %s\n' "$NODE_URL"
    rm -f "$tarball.part"
    curl -fL --retry 3 --retry-delay 2 -o "$tarball.part" "$NODE_URL" || die "download failed: $NODE_URL"
    mv "$tarball.part" "$tarball"
  else
    printf 'Using cached %s\n' "$tarball"
  fi
  actual_sha="$(sha256_of "$tarball")"
  if [ "$actual_sha" != "$NODE_SHA256" ]; then
    rm -f "$tarball"
    die "Node tarball sha256 mismatch (expected $NODE_SHA256, got $actual_sha); cached file deleted."
  fi
  printf 'sha256 OK  %s\n' "$actual_sha"
  rm -rf "${cache:?}/${NODE_DIST}"
  tar -xzf "$tarball" -C "$cache" || die "cannot extract $tarball"
  node_home="$cache/$NODE_DIST"
  [ -x "$node_home/bin/node" ] || die "extracted Node has no bin/node."
  codesign --verify --strict "$node_home/bin/node" || die "codesign verification of the Node binary failed."
  sign_info="$(codesign -dv "$node_home/bin/node" 2>&1 || true)"
  case "$sign_info" in
    *"TeamIdentifier=$NODE_TEAM_ID"*) printf 'codesign OK TeamIdentifier=%s\n' "$NODE_TEAM_ID" ;;
    *) die "Node binary TeamIdentifier is not $NODE_TEAM_ID." ;;
  esac
  [ "$("$node_home/bin/node" -p 'process.versions.node + " " + process.platform + "/" + process.arch')" = "$NODE_VERSION darwin/arm64" ] \
    || die "downloaded Node does not report $NODE_VERSION darwin/arm64."
  build_path="$node_home/bin:$SYSTEM_PATH"
  "$node_home/bin/node" scripts/generate-third-party-licenses.mjs --check \
    || die "THIRD_PARTY_LICENSES.md does not match package-lock.json: run npm run licenses."

  version="$(cd "$root" && "$node_home/bin/node" -p "require('./package.json').version")"
  case "$version" in
    ''|*[!0-9A-Za-z._-]*) die "invalid package.json version: '$version'" ;;
  esac
  name="phone-app-checker-${version}-macos-arm64"
  printf 'Building %s\n' "$name"

  # --- 2b. compile TypeScript (the bundle ships JS, not sources) ----------------
  # Built with the pinned Node so the compiler toolchain matches the shipped runtime; tsc itself
  # comes from the repo's dev dependencies (npm ci must have run, as in CI).
  step "Compile TypeScript (tsc -p tsconfig.build.json)"
  [ -f node_modules/typescript/bin/tsc ] || die "typescript is not installed in $root (run npm ci first)."
  rm -rf "$root/build"
  "$node_home/bin/node" node_modules/typescript/bin/tsc -p tsconfig.build.json || die "tsc -p tsconfig.build.json failed."
  [ -f build/js/bin/phone-app-checker.js ] && [ -f build/js/src/cli.js ] || die "compiled layout missing build/js/bin or build/js/src."
  ts_left="$(find build/js -name '*.ts' -print | head -n 1)"
  [ -z "$ts_left" ] || die "a TypeScript file leaked into build/js: $ts_left"

  # --- 3. stage allowlisted files --------------------------------------------
  step "Stage dist/stage/$name"
  stage_parent="$root/dist/stage"
  stage="$stage_parent/$name"
  if [ -e "$stage_parent" ]; then
    chmod -R u+w "$stage_parent" 2>/dev/null || true
    rm -rf "$stage_parent"
  fi
  mkdir -p "$stage/app/scripts" "$stage/runtime/bin"
  copy() { ditto --norsrc --noextattr --noqtn "$1" "$2"; }
  copy "$root/docs" "$stage/app/docs"
  # app/bin and app/src ship compiled JavaScript (build/js); TypeScript sources stay in the repo.
  copy "$root/build/js/bin" "$stage/app/bin"
  copy "$root/build/js/src" "$stage/app/src"
  for entry in package.json package-lock.json .npmrc README.md LICENSE THIRD_PARTY_LICENSES.md checker.config.example.json scripts/viber-discover-schema.sh; do
    copy "$root/$entry" "$stage/app/$entry"
  done
  copy "$root/release/phone-app-checker" "$stage/phone-app-checker"
  copy "$root/release/install.sh" "$stage/install.sh"
  copy "$root/release/uninstall.sh" "$stage/uninstall.sh"
  copy "$root/docs/install-macos.md" "$stage/INSTALL.md"
  copy "$root/docs/install-macos.vi.md" "$stage/INSTALL.vi.md"
  copy "$root/LICENSE" "$stage/LICENSE"
  copy "$root/THIRD_PARTY_LICENSES.md" "$stage/THIRD_PARTY_LICENSES.md"
  copy "$node_home/bin/node" "$stage/runtime/bin/node"
  copy "$node_home/LICENSE" "$stage/runtime/LICENSE"
  printf '%s\n' "$version" > "$stage/VERSION"
  chmod 755 "$stage/phone-app-checker" "$stage/install.sh" "$stage/uninstall.sh" "$stage/runtime/bin/node"

  # --- 4. dependencies built by the bundled Node ------------------------------
  step "npm ci --omit=dev (bundled Node ABI)"
  (
    cd "$stage/app"
    PATH="$build_path" MACOSX_DEPLOYMENT_TARGET="$MACOS_FLOOR" npm_config_update_notifier=false npm ci --omit=dev --no-audit --no-fund
  ) || die "npm ci failed."
  # copy of the pinned Node must still verify after staging
  codesign --verify --strict "$stage/runtime/bin/node" || die "staged Node binary no longer verifies."
  cmp -s "$node_home/bin/node" "$stage/runtime/bin/node" || die "staged Node binary differs from the pinned one."
  # Source maps are debugging aids only (Node ignores them without --enable-source-maps): drop them
  # before the load gate so the gate proves the bundle works without them.
  maps_before="$(find "$stage/app/node_modules" -type f -name '*.map' | wc -l | tr -d ' ')"
  find "$stage/app/node_modules" -type f -name '*.map' -delete
  printf 'Removed %s source map files\n' "$maps_before"

  # --- 5. load gate with the bundled runtime ---------------------------------
  step "Load gate (runtime/bin/node)"
  gate='
import { DatabaseSync } from "node:sqlite";
const mem = new DatabaseSync(":memory:");
mem.exec("create table t (x integer)");
mem.close();
const { default: Database } = await import("better-sqlite3");
const db = new Database(":memory:");
db.exec("create table t (x integer)");
db.close();
await import("sharp");
const { APPS } = await import("./src/types.js");
const { loadAdapter } = await import("./src/adapters/index.js");
if (!Array.isArray(APPS) || APPS.length === 0) throw new Error("APPS is missing or empty");
for (const app of APPS) {
  await loadAdapter(app);
  console.log("loaded adapter " + app);
}
process.exit(0);
'
  (
    cd "$stage/app"
    env -u NODE_OPTIONS -u NODE_PATH "$stage/runtime/bin/node" --input-type=module -e "$gate"
  ) || die "load gate failed (sqlite / better-sqlite3 / sharp / adapters)."
  built_version="$(cd "$stage/app" && env -u NODE_OPTIONS -u NODE_PATH "$stage/runtime/bin/node" bin/phone-app-checker.js --version)" \
    || die "bin/phone-app-checker.js --version failed."
  [ "$built_version" = "$version" ] || die "--version printed '$built_version', expected '$version'."
  printf -- '--version OK %s\n' "$built_version"

  # --- 6. architecture gate ---------------------------------------------------
  step "Architecture gate (.node / .dylib must be arm64)"
  native_count=0
  while IFS= read -r -d '' lib; do
    native_count=$((native_count + 1))
    kind="$(file -b "$lib")"
    case "$kind" in
      *Mach-O*arm64*) ;;
      *) die "not an arm64 Mach-O: ${lib#"$stage"/}: $kind" ;;
    esac
  done < <(find "$stage/app/node_modules" -type f \( -name '*.node' -o -name '*.dylib' \) -print0)
  [ "$native_count" -gt 0 ] || die "no native addons found under app/node_modules (expected better-sqlite3 and sharp)."
  [ -f "$stage/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ] || die "better_sqlite3.node missing."
  printf '%s native files, all arm64\n' "$native_count"

  # --- 6b. minimum-OS gate ----------------------------------------------------
  # Architecture is not compatibility: a Mach-O built with a newer deployment target fails to load on
  # an older macOS. Inspect EVERY Mach-O in the stage (found by content, not by extension; includes the
  # Node binary), read LC_BUILD_VERSION minos / LC_VERSION_MIN_MACOSX, and fail above the documented floor.
  # This is a necessary check, not a substitute for running the archive on a Mac at the floor version.
  step "Minimum-OS gate (every Mach-O minos <= macOS ${MACOS_FLOOR})"
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
      }')" || die "vtool failed on ${lib#"$stage"/}."
    printf '  %-5s %s  (%s)\n' "${verdict%% *}" "${lib#"$stage"/}" "${verdict#* }"
    case "$verdict" in
      OK\ *) ;;
      *) die "minimum-OS gate: ${lib#"$stage"/}: ${verdict#FAIL }. The documented floor is macOS ${MACOS_FLOOR}: rebuild the addon with MACOSX_DEPLOYMENT_TARGET<=${MACOS_FLOOR}, or raise the floor in release/install.sh, docs/install-macos.md, README.md and MACOS_FLOOR here." ;;
    esac
  done < <(find "$stage" -type f -print0 | xargs -0 file -h -0 | tr '\0' '\t' | awk -F'\t: ' '$2 ~ /Mach-O/ { print $1 }')
  [ "$macho_count" -ge 4 ] || die "minimum-OS gate inspected only $macho_count Mach-O files (expected node, better_sqlite3.node, sharp .node, libvips dylib)."
  printf '%s Mach-O files, all minos <= %s (load commands only; not a run on macOS %s)\n' "$macho_count" "$MACOS_FLOOR" "$MACOS_FLOOR"

  # --- 7. audit gate ----------------------------------------------------------
  step "npm audit --omit=dev"
  (
    cd "$stage/app"
    PATH="$build_path" npm_config_update_notifier=false npm audit --omit=dev --audit-level=low
  ) || die "npm audit reported vulnerabilities in production dependencies."

  # --- 8. hygiene gate --------------------------------------------------------
  step "Hygiene gate"
  bad="$(find "$stage" \( -name 'checker.config.json' -o -name '*.csv' -o -name '.env' -o -name '.env.*' -o -name '.DS_Store' \
    -o -name '*.map' -o -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name 'login-qr*.png' \) -print)"
  [ -z "$bad" ] || die "forbidden files in the bundle:
$bad"
  for forbidden in "$stage/data" "$stage/app/data" "$stage/app/tests" "$stage/app/node_modules/vitest" "$stage/app/node_modules/typescript"; do
    [ ! -e "$forbidden" ] || die "forbidden path in the bundle: ${forbidden#"$stage"/}"
  done
  # The bundle runs compiled JavaScript: no TypeScript source may reach app/bin or app/src.
  ts_shipped="$(find "$stage/app/bin" "$stage/app/src" -name '*.ts' -print | head -n 1)"
  [ -z "$ts_shipped" ] || die "TypeScript source shipped in the bundle: ${ts_shipped#"$stage"/}"
  printf 'clean\n'

  # --- 9. metadata ------------------------------------------------------------
  step "Metadata"
  lock_sha="$(sha256_of "$stage/app/package-lock.json")"
  built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  builder="$(sw_vers -productVersion)"
  printf '{\n  "version": "%s",\n  "platform": "darwin-arm64",\n  "node": "%s",\n  "nodeSha256": "%s",\n  "lockSha256": "%s",\n  "builtAt": "%s",\n  "builder": "%s"\n}\n' \
    "$version" "$NODE_VERSION" "$NODE_SHA256" "$lock_sha" "$built_at" "$builder" > "$stage/app/BUILD-INFO.json"
  # the file must parse and the CLI must accept it
  (cd "$stage/app" && env -u NODE_OPTIONS -u NODE_PATH "$stage/runtime/bin/node" -e "JSON.parse(require('node:fs').readFileSync('BUILD-INFO.json','utf8'))") \
    || die "BUILD-INFO.json is not valid JSON."

  # --- 10. modes --------------------------------------------------------------
  chmod -R go-w "$stage"
  chmod -R a+rX "$stage"
  chmod 755 "$stage/phone-app-checker" "$stage/install.sh" "$stage/uninstall.sh" "$stage/runtime/bin/node"

  # --- 11. archive ------------------------------------------------------------
  step "Archive"
  out_tar="$root/dist/$name.tar.gz"
  rm -f "$out_tar" "$out_tar.sha256"
  (cd "$stage_parent" && COPYFILE_DISABLE=1 tar --no-mac-metadata --uid 0 --gid 0 -czf "$out_tar" "$name") || die "tar failed."
  (cd "$root/dist" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256") || die "shasum failed."
  size="$(stat -f %z "$out_tar")"
  printf '\nArchive : %s\n' "$out_tar"
  printf 'Checksum: %s\n' "$out_tar.sha256"
  printf 'Size    : %s bytes\n' "$size"
  printf 'SHA-256 : %s\n' "$(sha256_of "$out_tar")"
}

main "$@"
exit $?
