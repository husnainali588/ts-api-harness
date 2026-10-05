#!/usr/bin/env bash
# Extension demo (brief §5.4): drop each example plugin into plugins/, prove that `git diff --stat` touches only that
# plugin's own folder (nothing under core/), show it working, then remove it. Exits non-zero on any violation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export HARNESS_NO_DOTENV=1

if ! git diff --quiet || [ -n "$(git status --porcelain -- core plugins)" ]; then
  echo "the working tree has uncommitted changes to tracked files (or core/plugins); commit or stash them first" >&2
  exit 2
fi

# example name | plugin kind folder | fixture API (or empty)
EXAMPLES=(
  "openapi_diff|tools|"
  "orm-explicit-columns|rules|examples/extensions/orm-explicit-columns/fixtures/api"
  "no-console-in-handlers|rules|examples/extensions/no-console-in-handlers/fixtures/api"
)

current=""
cleanup() {
  if [ -n "$current" ]; then
    git reset -q -- "$current" 2>/dev/null || true
    rm -rf "$current"
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

for entry in "${EXAMPLES[@]}"; do
  IFS='|' read -r name kind fixture <<<"$entry"
  target="plugins/$kind/$name"
  current="$target"
  echo "════ $name → $target"
  mkdir -p "$target"
  cp "examples/extensions/$name/index.ts" "$target/index.ts"
  git add -N "$target"

  echo "── git diff --stat"
  git diff --stat
  changed="$(git diff --name-only)"
  [ -n "$changed" ] || fail "$name: nothing changed?"
  while IFS= read -r path; do
    case "$path" in
      "$target"/*|plugins/registry.json) ;;
      *) fail "$name: unexpected change outside the plugin folder: $path" ;;
    esac
  done <<<"$changed"
  [ -z "$(git status --porcelain -- core)" ] || fail "$name: core/ changed"
  echo "   only $target/ changed; core/ untouched"

  echo "── harness plugins"
  npx --no-install harness plugins | grep -E "^\s+$name\s" || fail "$name: not listed by harness plugins"

  if [ -n "$fixture" ]; then
    [ -e "$fixture/node_modules" ] || ln -s "$ROOT/templates/api/node_modules" "$fixture/node_modules"
    echo "── harness check --api $fixture (lines of $name)"
    out="$(npx --no-install harness check --api "$fixture" || true)"
    echo "$out" | grep -E "^$name\s" || fail "$name: no lines in the standards report"
    echo "$out" | grep -qE "^$name\s+FAIL\s+\S+:[0-9]+" || fail "$name: expected a FAIL line with a location"
    echo "$out" | grep -qE "^$name\s+pass\s" || fail "$name: expected a pass line"
    rm -rf "reports/$(echo "$out" | sed -n 's#^report *reports/\([^/]*\)/.*#\1#p')"
  fi

  git reset -q -- "$target"
  rm -rf "$target"
  current=""
  [ -z "$(git status --porcelain -- core plugins)" ] || fail "$name: tree not clean after removal"
  echo "   removed; tree clean"
done

echo "════ extension demo: all three additions needed no core change"
