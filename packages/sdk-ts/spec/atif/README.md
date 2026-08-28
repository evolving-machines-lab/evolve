# ATIF trajectory schema

`trajectory.schema.json` is the language-neutral JSON Schema for the ATIF
trajectory documents this platform emits (`agent/trajectory.json` inside a
job download, and the `?stream=trajectory` trial artifact).

## Provenance

The schema is GENERATED, never hand-edited. It is emitted by pydantic's
`model_json_schema()` from Harbor's own trajectory models — the same models
Harbor's tooling validates trajectories with — rooted at `Trajectory`:

- Source: `src/harbor/models/trajectories/` in the Harbor repository
- Pinned Harbor commit: `4698544ea9d5ee95d01b05aeaa9ccbd161d5a7f6`
- Draft: JSON Schema 2020-12 (pydantic's output dialect)

To regenerate against a newer Harbor, from a checkout of that commit's
repository with its own venv:

```
python - <<'EOF'
import json
from harbor.models.trajectories import Trajectory

document = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$comment": "GENERATED — do not hand-edit. ... Harbor commit <commit>. ...",
    "title": "ATIF Trajectory",
}
document.update(Trajectory.model_json_schema())
with open("spec/atif/trajectory.schema.json", "w") as f:
    json.dump(document, f, indent=2, sort_keys=True)
    f.write("\n")
EOF
```

Update the pinned commit in the `$comment` and in this file in the same
change — the two must always agree.

## The mirror

The server repository keeps a byte-identical copy at its own `spec/atif/`,
held by a drift gate exactly like the `spec/openapi.yaml` mirror: the server's
ATIF tests validate every emitted document against this schema, so the emitter
and the schema cannot disagree silently.
