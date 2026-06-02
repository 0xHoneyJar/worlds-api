#!/usr/bin/env bash
# fixup-events-bun.sh — Bun-specific companion for the @0xhoneyjar/events
# git-source dependency.
#
# WHY THIS EXISTS:
#   Under bun, a git-URL dep pointing at a monorepo
#   (github:0xHoneyJar/loa-freeside#SHA) resolves to the monorepo ROOT —
#   whose package.json has `name: "loa-freeside"`, NOT
#   `name: "@0xhoneyjar/events"`. The import `@0xhoneyjar/events` therefore
#   fails to resolve. This script re-points the wrong symlink to the
#   `packages/events/` SUBDIR (correct name + exports map + a built dist/).
#
#   Mirrors freeside-characters/scripts/fixup-events-bun.sh verbatim in
#   intent; the cluster's other bun consumer of @0xhoneyjar/events. The
#   pinned SHA (68f5a89…) already ships a built packages/events/dist/, so no
#   dist rebuild is needed for this package — the symlink fixup is sufficient.
#
# IDEMPOTENT: re-running is a no-op when the symlink already points at the
# right subdir.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
TAG="[fixup-events-bun]"

# Find every bun-installed events symlink under this package's node_modules
mapfile -t SYMLINKS < <(find "$ROOT_DIR" -type l -path "*/node_modules/@0xhoneyjar/events" 2>/dev/null || true)

if [[ ${#SYMLINKS[@]} -eq 0 ]]; then
  echo "$TAG No @0xhoneyjar/events symlinks found under $ROOT_DIR/**/node_modules — nothing to fix up"
  exit 0
fi

fixup_count=0
for link in ${SYMLINKS[@]+"${SYMLINKS[@]}"}; do
  current_target=$(readlink "$link")
  abs_target=$(cd "$(dirname "$link")" && cd "$current_target" 2>/dev/null && pwd -P || echo "")
  if [[ -z "$abs_target" ]]; then
    echo "$TAG WARNING: $link points at a missing target — skipping"
    continue
  fi

  # Idempotent: already pointing at the right place?
  if [[ -f "$abs_target/package.json" ]]; then
    name=$(node -e "try { console.log(require('$abs_target/package.json').name || '') } catch { console.log('') }" 2>/dev/null || echo "")
    if [[ "$name" == "@0xhoneyjar/events" ]]; then
      continue
    fi
  fi

  subdir="$abs_target/packages/events"
  if [[ ! -f "$subdir/package.json" ]]; then
    echo "$TAG WARNING: $abs_target/packages/events/package.json not found — cannot fix up $link"
    continue
  fi

  link_dir=$(dirname "$link")
  rel_subdir=$(node -e "console.log(require('path').relative('$link_dir', '$subdir'))" 2>/dev/null || echo "")
  if [[ -z "$rel_subdir" ]]; then
    echo "$TAG WARNING: failed to compute relative path for $link → $subdir"
    continue
  fi

  rm -f "$link"
  ln -s "$rel_subdir" "$link"
  echo "$TAG Fixed up $link → $rel_subdir"
  fixup_count=$((fixup_count + 1))
done

if [[ $fixup_count -gt 0 ]]; then
  echo "$TAG Fixed up $fixup_count @0xhoneyjar/events symlink(s) to point at packages/events/ subdir"
fi
