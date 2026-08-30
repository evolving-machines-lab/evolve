#!/bin/bash
# Reference solution: query the four hull compositions, then claim them.
#
# It spends 4 of the 15 oracle calls. A real campaign has to find these by
# probing the composition axis and reasoning about which points can lie on the
# lower hull; the reference simply proves the task is solvable within budget.
set -euo pipefail

workdir="${TASK_WORKDIR:-/app}"
cd "$workdir"

python3 "$workdir/oracle.py" Li4Sn Li3Sn2 LiSn LiSn3

cat > "$workdir/answer.json" <<'JSON'
{
  "stable_compounds": ["Li4Sn", "Li3Sn2", "LiSn", "LiSn3"]
}
JSON
