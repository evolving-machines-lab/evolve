---
title: "Agent skills"
description: "Give evaluated agents reusable instructions and supporting files."
---

An agent skill is a folder containing `SKILL.md` and optional supporting files. Attach it to a job with `--skills`; every arm receives it.

```text
my-skill/
├── SKILL.md
├── references/
│   └── conventions.md
└── scripts/
    └── validate.py
```

## Attach a skill

```bash
evolve run -d harbor-examples@1.0 -i hello-world \
  -a codex -m gpt-5.6-luna \
  --skills ./my-skill \
  --max-trial-spend 1 --max-retries 0 --watch
```

Repeat `--skills` to attach several. `--skill` is an alias.

| Source | Example |
| --- | --- |
| Local directory | `./my-skill` |
| Uploaded skill | `upload:SKILL_ID` |
| Your named upload | `name:my-skill` |
| Git repository | `org/repo@ref` |
| Git URL | `https://github.com/org/repo.git` |
| skills.sh source | `skills.sh/owner/repo/skill` |

A local directory is uploaded first. When the job is created, named uploads resolve to their current version and Git references resolve to exact commits.

## Upload once, use again

```bash
evolve skill upload ./my-skill
evolve skill list
evolve skill show name:my-skill
```

The directory name becomes its moving name pointer. Uploading another version under that name changes future resolutions; past jobs keep their pinned skill version.

After its first trial resolves the content, each arm records `skill_locks`: the skill names, sources, digests, and Git provenance. Until then, this field is `null`.

An unresolved reference rejects job creation. A later content-fetch failure is an infrastructure error, not a reward of zero.

## Package skills with a task

Use `environment.skills_dir` when every run of a task needs the same skills. It names an absolute directory inside the environment.

```text
my-task/
├── task.toml
└── environment/
    ├── Dockerfile
    └── skills/
        └── project-guide/
            └── SKILL.md
```

```toml task.toml
[environment]
skills_dir = "/skills"
```

```dockerfile environment/Dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY skills/ /skills/
```

The importer captures the skills from the build context. Use a simple final-stage `COPY` as above. Skills generated during a build, or available only inside a prebuilt image, cannot be resolved this way and are rejected.

For a prebuilt-image task that uploads its `environment/` files, place the skill folders there and point `skills_dir` to their location under the task's working directory. A job-attached skill overrides a task skill with the same name.

## Remove an upload

```bash
evolve skill delete SKILL_ID
```

An upload referenced by a queued, running, or cancelling job cannot be deleted.

**Note:**

`evolve skill` manages skills mounted into evaluated agents. `evolve skills` reads the bundled documentation for the coding agent helping you use Evolve.

**[Uploaded skill commands](/cli-reference/skill)**

Upload, list, inspect, and delete.

**[Bundled documentation](/cli-reference/skills)**

Load the evals guide or an authoring skill.
