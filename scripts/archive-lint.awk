# Lints a verbose tar listing (tar -tzvf) of the release archive. Usage: awk -v root=<top-level-dir> -f archive-lint.awk listing.txt
# Fails on: absolute or ".." paths, entries outside root, non-regular/dir/symlink types (hardlinks, devices, fifos),
# setuid/setgid/sticky bits, world-writable entries, symlinks that are absolute or leave the bundle.
function bad(msg) { print msg ": " name; failed = 1 }
{
  perms = $1
  rest = $0
  for (i = 0; i < 8; i++) { sub(/^[^ ]+ +/, "", rest) }
  name = rest
  target = ""
  idx = index(rest, " -> ")
  if (substr(perms, 1, 1) == "l" && idx > 0) { name = substr(rest, 1, idx - 1); target = substr(rest, idx + 4) }
  if (substr(name, 1, 1) == "/") bad("absolute path")
  if (("/" name "/") ~ /\/\.\.\//) bad("parent component in path")
  if (substr(name, 1, length(root) + 1) != root "/" && name != root) bad("outside bundle root")
  type = substr(perms, 1, 1)
  if (type != "-" && type != "d" && type != "l") bad("special entry type " type)
  if (substr(perms, 4, 1) ~ /[sS]/ || substr(perms, 7, 1) ~ /[sS]/ || substr(perms, 10, 1) ~ /[tT]/) bad("setuid/setgid/sticky")
  if (substr(perms, 9, 1) == "w") bad("world-writable")
  if (type == "l") {
    if (target == "" || substr(target, 1, 1) == "/") bad("absolute or empty symlink target")
    else {
      n = split(name, parts, "/")
      depth = 0
      for (i = 1; i < n; i++) stack[++depth] = parts[i]
      m = split(target, tparts, "/")
      for (i = 1; i <= m; i++) {
        if (tparts[i] == "" || tparts[i] == ".") continue
        if (tparts[i] == "..") { if (depth <= 1) { bad("symlink escapes the bundle (-> " target ")"); break } depth-- }
        else stack[++depth] = tparts[i]
      }
      for (i = 1; i <= depth; i++) delete stack[i]
    }
  }
  count++
}
END { if (count == 0) { print "empty listing"; failed = 1 } exit failed ? 1 : 0 }
