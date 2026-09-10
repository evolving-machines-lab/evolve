#!/bin/bash
# The reward file is the verdict, never the exit code — so this script must reach
# the grader even when something upstream of it went wrong.
set -uo pipefail

logs="${LOGS_DIR:-/logs}/verifier"
mkdir -p "$logs"

python3 "$(dirname "$0")/grader.py"
status=$?

# A grader that never ran is a zero, not a missing file: an absent reward would
# settle as a scoring error and hide a broken verifier.
if [ ! -f "$logs/reward.json" ]; then
    echo '{"reward": 0}' > "$logs/reward.json"
    echo "grader did not produce a reward (exit $status)" >&2
fi
