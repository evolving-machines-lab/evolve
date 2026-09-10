#!/usr/bin/env python3
"""Grade one SMDD-Bench Fragment Assembly submission.

Implements the thirteen gates from the source instance's `hard_constraints` that
are computable from the SMILES alone with RDKit. The three remaining published
gates need a structure-prediction stack and are recorded here as not-run rather
than quietly dropped — see the note at the bottom of this file.

Writes reward.json to $LOGS_DIR/verifier (default /logs/verifier).
"""

from __future__ import annotations

import json
import os
import sys

from rdkit import Chem, RDLogger
from rdkit.Chem import Crippen, Descriptors, RDConfig, rdMolDescriptors
from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams

RDLogger.DisableLog("rdApp.*")
sys.path.append(os.path.join(RDConfig.RDContribDir, "SA_Score"))
import sascorer  # noqa: E402  (only importable after the path append above)

# The fragment the molecule must incorporate, as published with the instance.
FRAGMENT_SMARTS = "[#6]1-[#6@H]-[#6]-[#6]-[#6]-[#6]-[#6]-[#6]-1"

GATES = (
    "smiles_validity",
    "molecular_weight",
    "logp",
    "tpsa",
    "hbd",
    "hba",
    "rotatable_bonds",
    "formal_charge",
    "synthetic_accessibility",
    "pains_filter",
    "structural_alerts",
    "fragment_incorporation",
    "fragment_linking",
)


def catalog(which) -> FilterCatalog:
    params = FilterCatalogParams()
    params.AddCatalog(which)
    return FilterCatalog(params)


def grade(smiles: str) -> dict[str, int]:
    scores = {name: 0 for name in GATES}

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return scores
    mol = Chem.RemoveHs(mol)
    scores["smiles_validity"] = 1

    scores["molecular_weight"] = int(Descriptors.MolWt(mol) < 600)
    scores["logp"] = int(-1 <= Crippen.MolLogP(mol) <= 5)
    scores["tpsa"] = int(rdMolDescriptors.CalcTPSA(mol) < 140)
    scores["hbd"] = int(rdMolDescriptors.CalcNumHBD(mol) <= 5)
    scores["hba"] = int(rdMolDescriptors.CalcNumHBA(mol) <= 10)
    scores["rotatable_bonds"] = int(rdMolDescriptors.CalcNumRotatableBonds(mol) <= 10)
    scores["formal_charge"] = int(-2 <= Chem.GetFormalCharge(mol) <= 2)
    scores["synthetic_accessibility"] = int(sascorer.calculateScore(mol) < 4.5)

    pains = catalog(FilterCatalogParams.FilterCatalogs.PAINS)
    brenk = catalog(FilterCatalogParams.FilterCatalogs.BRENK)
    nih = catalog(FilterCatalogParams.FilterCatalogs.NIH)
    scores["pains_filter"] = int(not pains.HasMatch(mol))
    scores["structural_alerts"] = int(not (brenk.HasMatch(mol) or nih.HasMatch(mol)))

    pattern = Chem.MolFromSmarts(FRAGMENT_SMARTS)
    scores["fragment_incorporation"] = int(mol.HasSubstructMatch(pattern))
    scores["fragment_linking"] = int(len(Chem.GetMolFrags(mol)) == 1)
    return scores


def read_submission(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                token = line.strip().split()
                if token:
                    return token[0]
    except OSError:
        return None
    return None


def main() -> int:
    workdir = os.environ.get("TASK_WORKDIR", "/app")
    logs = os.path.join(os.environ.get("LOGS_DIR", "/logs"), "verifier")
    os.makedirs(logs, exist_ok=True)

    smiles = read_submission(os.path.join(workdir, "solution.smi"))
    scores = grade(smiles) if smiles else {name: 0 for name in GATES}

    # Every hard constraint is a gate: upstream terminal-bench-science requires a
    # BINARY reward, so the primary score is all-or-nothing and the per-gate
    # results ride along as metrics to make a failure diagnosable.
    payload = dict(scores)
    payload["reward"] = 1 if all(scores.values()) else 0

    with open(os.path.join(logs, "reward.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)

    failed = sorted(name for name, ok in scores.items() if not ok)
    print(f"submission: {smiles!r}")
    print(f"reward: {payload['reward']}")
    if failed:
        print("failed gates: " + ", ".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())

# NOT RUN HERE — the three remaining published gates:
#
#   boltz_binding    affinity_probability_binary > 0.7
#   boltz_affinity   affinity_pred_value < -1.5780
#   fragment_rmsd    docked pose vs input fragment pose, < 2.0 A per fragment
#
# All three need Boltz2 (and a GPU) in the verifier image. That is supported —
# declare `gpus` in [environment] and the trial runs on Modal whichever provider
# the job picked — so adding them is a tests/Dockerfile change, a gpus
# declaration, and three more entries in GATES. The task structure does not
# change, which is the point. A task that ships without them is easier than the
# published benchmark; say so rather than implying parity.
