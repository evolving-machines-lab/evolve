#!/bin/bash
# The reward file is the verdict, never the exit code.
set -uo pipefail

logs="${LOGS_DIR:-/logs}/verifier"
mkdir -p "$logs"

python3 "$(dirname "$0")/grader.py"
status=$?

if [ ! -f "$logs/reward.json" ]; then
    echo '{"reward": 0}' > "$logs/reward.json"
    echo "grader did not produce a reward (exit $status)" >&2
fi
