You are given one molecular fragment with a 3D pose inside a protein binding
pocket. Design a single drug-like molecule that incorporates the fragment and
binds the target.

Input files, in `/app/data`:

- `fragment_0.sdf` — the fragment, with its 3D pose in the pocket
- `pocket.pdb` — the binding pocket

Write a single SMILES string to `/app/solution.smi` and nothing else.

Your molecule must satisfy **all** of the following:

| Constraint | Requirement |
|---|---|
| SMILES validity | parseable and sanitizable by RDKit — no radicals, no disconnected fragments, no unreasonable valences |
| Molecular weight | < 600 Da |
| LogP | between -1 and 5 |
| TPSA | < 140 Å² |
| H-bond donors | ≤ 5 |
| H-bond acceptors | ≤ 10 |
| Rotatable bonds | ≤ 10 |
| Net formal charge | between -2 and +2 |
| Synthetic accessibility | SA score < 4.5 |
| PAINS filter | must pass |
| Structural alerts | must pass Brenk and NIH reactive-group filters |
| Fragment incorporation | the fragment must be present as a substructure |
| Fragment linking | the molecule must be a single covalently connected species |

RDKit is installed. The pocket is defined by these residues (chain, 1-indexed
SEQRES position): A:62, A:64, A:66, A:67, A:69, A:89, A:90, A:92, A:94, A:104,
A:117, A:119, A:128, A:132, A:138, A:140, A:196, A:197, A:198, A:199, A:200,
A:201, A:208, A:240, C:127.
