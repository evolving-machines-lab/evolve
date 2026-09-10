#!/bin/bash
# Fetch the benchmark inputs this task does not vendor.
#
# Deliberately NOT committed to this repository: re-publishing benchmark instances
# is exactly what the canary header at the top of task.toml asks contributors not
# to do. The upstream release is the single source.
set -euo pipefail

dest="${1:-/app/data}"
instance="${SMDD_INSTANCE:-smdd_005_Q16790_0}"
archive="https://huggingface.co/datasets/extremelyconfused/smdd-bench/resolve/main/tasks_4_4_final.tar.gz"

mkdir -p "$dest"

if [ -f "$dest/pocket.pdb" ]; then
    echo "pocket.pdb already present; nothing to fetch"
    exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Streamed and stopped early: the full archive is ~3.4 GB and this task needs one
# file from it.
curl -sL "$archive" \
    | tar -xzf - -C "$tmp" --wildcards "tasks/$instance/pocket.pdb" || true

if [ ! -f "$tmp/tasks/$instance/pocket.pdb" ]; then
    echo "could not fetch pocket.pdb for $instance from $archive" >&2
    exit 1
fi

cp "$tmp/tasks/$instance/pocket.pdb" "$dest/pocket.pdb"
echo "fetched pocket.pdb -> $dest/pocket.pdb"
