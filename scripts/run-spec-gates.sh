#!/usr/bin/env bash
#
# run-spec-gates.sh — THE list of spec-reading tests. There is exactly one.
#
# Three workflows gate the cross-repo API contract, and all three run this
# script rather than their own copy of the list:
#
#   evolve/.github/workflows/spec-gate.yml               every push/PR
#   evolve/.github/workflows/publish.yml                 the release gate
#   swarm_dashboard/.github/workflows/sdk-spec-gate.yml  the server's half,
#                                                        from its evolve checkout
#
# The list used to be copied into each of them. Three copies means a gate added
# to one of them silently stops gating in the other two, which is the failure a
# contract gate exists to prevent. Add or remove a gate HERE and all three move
# together.
#
# Environment read (never set here — both pass straight through to the tests):
#   EVOLVE_OPENAPI_SPEC_PATH  the contract to gate against. Unset is normal in a
#                             public checkout: every test below prints SKIP and
#                             passes, because the YAML does not live in this repo.
#   EVOLVE_SPEC_GATE_STRICT   "1" removes the toleration for the spec LEADING
#                             the SDK (see packages/sdk-ts/tests/unit/spec-lag.ts).
#                             publish.yml sets it for stable releases only.
#
# Assumes dependencies are installed and `npm run build` has already run — two
# of the TypeScript entrypoints read dist/.
#
# Usage: scripts/run-spec-gates.sh   (from any directory; paths resolve off this
#                                     file, not the caller's cwd)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${EVOLVE_SPEC_GATE_STRICT:-}" = "1" ]; then
    echo "[spec-gates] STRICT: the SDK must answer the contract in full"
else
    echo "[spec-gates] tolerant: the spec may lead the SDK (real drift still fails)"
fi
echo "[spec-gates] contract: ${EVOLVE_OPENAPI_SPEC_PATH:-<unset — tests will SKIP>}"

cd "${REPO_ROOT}/packages/sdk-ts"
npx tsx tests/unit/hosted-spec-gate.test.ts
npx tsx tests/unit/hosted-error-codes.test.ts
npx tsx tests/unit/hosted-client.test.ts
npx tsx tests/unit/cli.test.ts
npx tsx tests/unit/cli-bin.test.ts

cd "${REPO_ROOT}/packages/sdk-py"
set +e
python -m pytest \
    tests/unit/test_hosted_spec_gate.py \
    tests/unit/test_hosted_stats_typing.py \
    tests/unit/test_hosted_retry_typing.py \
    -v
PYTEST_STATUS=$?
set -e

# pytest answers 5 for "no tests collected", which is EXACTLY what a
# contract-less run produces: every gate test skips itself, so nothing is
# collected. That is the normal local run — the spec lives in the private
# server repo — and it made this script exit non-zero on a clean tree, which
# is how a red gate stops meaning anything. Tolerated only when we already
# know the contract is absent; where it is set, 5 stays a failure.
if [ "${PYTEST_STATUS}" -eq 5 ] && [ -z "${EVOLVE_OPENAPI_SPEC_PATH:-}" ]; then
    echo "[spec-gates] python gates all skipped — no contract present, so nothing to gate"
    PYTEST_STATUS=0
fi

exit "${PYTEST_STATUS}"
