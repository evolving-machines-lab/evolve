#!/bin/bash
# Reference solution — cyclooctanecarboxamide on a benzenesulfonamide.
#
# The sulfonamide is the canonical warhead for this target class and the
# cyclooctane ring is the required fragment, so this is a chemically motivated
# answer rather than a string that happens to satisfy the checker.
#
# NOTE: this is NOT the instance's `witness_smiles`. That molecule is the known
# reference binder, and it FAILS two of the task's own hard constraints
# (LogP 5.31 > 5, and a `halogenated_ring_1` Brenk alert from its trifluorinated
# ring). A source benchmark's reference answer is not automatically a gold
# solution — run it through the gates before trusting it.
set -euo pipefail

workdir="${TASK_WORKDIR:-/app}"
mkdir -p "$workdir"
echo 'O=C(Nc1ccc(S(N)(=O)=O)cc1)C1CCCCCCC1' > "$workdir/solution.smi"
