# Worked examples

Two real benchmarks converted into the task layout, chosen because they fail
differently. Both pass the acceptance bar:

```bash
python3 ../scripts/validate_task.py tasks/*
python3 ../scripts/goldnull.py tasks/*
```

```
== tasks/made-convex-hull        null 0.0   gold 1.0   ok
== tasks/smdd-fragment-assembly  null 0.0   gold 1.0   ok
```

Together they are also a publishable corpus — `tasks/` is the corpus root:

```bash
evolve dataset publish --dir . --name harbor-task-examples --version 0.1 --watch
```

---

## `smdd-fragment-assembly` — the source that fits

**From:** SMDD-Bench, *Can LLMs Solve Real-World Small Molecule Drug Design
Tasks?* ([arXiv:2605.21740](https://arxiv.org/abs/2605.21740)), Apache-2.0.
Data: [`extremelyconfused/smdd-bench`](https://huggingface.co/datasets/extremelyconfused/smdd-bench).
Source instance: a Fragment Assembly task, one fragment, one protein target.

SMDD-Bench was designed for almost exactly this shape, which is why the
conversion is nearly mechanical:

| Source | Task layout |
|---|---|
| input files given to the agent | `environment/data/` |
| the instance's `description` | `instruction.md` |
| `output_config.file_path: solution.smi` | `artifacts = ["/app/solution.smi"]` |
| `hard_constraints` list | the gates in `tests/grader.py` |
| "isolated filesystem, no internet access" | `network_mode = "no-network"` |
| answers held out of the agent's reach | `environment_mode = "separate"` |

### Two things the conversion had to decide

**The source's reference answer is not a gold solution.** The instance ships a
`witness_smiles` — the known reference binder. Run through the instance's own hard
constraints it **fails two of them**: LogP 5.31 against a stated range of -1 to 5,
and a `halogenated_ring_1` Brenk alert from its trifluorinated ring. It is the
molecule the affinity thresholds were *derived from*, not a valid submission. The
gold solution here is a chemically motivated answer that passes every implemented
gate — a cyclooctanecarboxamide benzenesulfonamide, pairing the required fragment
with the canonical warhead for this target class.

Check the source's reference answer against the source's own criteria before
adopting it. If it fails, that is a finding about the benchmark, not a licence to
relax the gates.

**Three published gates are not implemented.** `boltz_binding`, `boltz_affinity`
and `fragment_rmsd` need Boltz2 and a GPU in the verifier image. They are named at
the bottom of `tests/grader.py` as not-run, because a task that silently drops a
third of its criteria is easier than the benchmark it claims to reproduce.

This is a size decision, not a platform limit: the format takes `gpus` in
`[environment]`, and a GPU trial runs on Modal whichever provider the job picks
(see [task-format § Where your task can run](../references/task-format.md#where-your-task-can-run)).
Adding the gates is a `tests/Dockerfile` change, a `gpus` declaration, and three
more entries in `GATES` — the task structure does not change. What keeps them out
of a *committed example* is the image weight and the model checkpoints, which
would make this directory unusable as a quick reference.

### Why the pocket file is not committed

`environment/fetch_inputs.sh` pulls `pocket.pdb` from the upstream release at image
build time instead of vendoring it. Re-publishing benchmark instances into a public
repository is precisely what the canary header at the top of every `task.toml` asks
contributors not to do. The fragment SDF is committed — it is a bare cyclooctane
and identifies nothing.

`instruction.md` and `environment/` carry no UniProt accession, PDB code or ligand
code, matching upstream's own obfuscation.

---

## `made-convex-hull` — the source that fights back

**From:** MADE, *Benchmark Environments for Closed-Loop Materials Discovery*
([arXiv:2601.20996](https://arxiv.org/abs/2601.20996)),
[github.com/diffractivelabs/MADE](https://github.com/diffractivelabs/MADE), MIT.

MADE is a *simulator*, not a list of instances, and it conflicts with the task
format in all three of the ways the
[playbook](../references/conversion-playbook.md) names. Each conflict is resolved
by an explicit decision rather than papered over:

**1. Continuous metrics, no natural verdict.** MADE reports AF, EF, AUDC and mSUN.
Nothing in the paper says which value counts as success. `tests/grader.py` reports
`discovery_rate`, `precision`, `n_stable_found` and `oracle_calls_used` as named
metrics, and derives a **binary** primary reward from a threshold this conversion
chose: at least 3 of the 4 stable compounds, zero incorrect claims, within budget.
The threshold is a benchmark-design decision made here, not a MADE result.

The `precision` requirement is what makes the task real. Without it the winning
move is to claim all 45 candidate formulas; with it, that submission scores 0.

**2. Network and API keys against a sealed box.** MADE's oracles pull from the
Materials Project API and its ML potentials (ORB, MACE) want GPU-scale
checkpoints. This conversion pins MADE's **Analytic** oracle — one of its three
supported options — so the campaign is deterministic, offline, CPU-only, and
standard-library-only. A GPU oracle would be runnable (declare `gpus` and the
trial routes to Modal), but it would trade a reference example anyone can run in
a second for one that needs a fleet GPU slot. `environment/made_model.py` documents the surrogate in full.
It is this task's ground truth and nothing more: not a physical potential, and not
Materials Project data.

**3. A stateful closed loop against a one-shot container.** MADE's point is a
multi-turn agent/oracle exchange under a fixed budget; a task hands the agent a
container. The loop is reconstructed as a local CLI, `environment/oracle.py`, whose
15-call budget is enforced on disk and written to `campaign.jsonl` — which is
declared as an artifact so the verifier can audit the budget rather than trust it.

### The verifier keeps its own copy of the model

`tests/made_model.py` duplicates `environment/made_model.py` deliberately. The
agent can edit anything in its own container, so a verifier that imported the
agent's copy would let a submission rewrite its own ground truth. Duplication is
the price of a `separate` verifier, and it is the right price.
