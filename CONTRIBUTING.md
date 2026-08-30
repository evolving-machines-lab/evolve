# Contributing

Evolve welcomes contributions. This guide describes how changes land in this
repository and what makes a contribution likely to be accepted.

## Golden rule

You must understand the code you contribute. Use coding agents liberally, but
you are in charge of demonstrating an understanding of your code:

- Write your own PR description
- Be able to explain every change and its tradeoffs
- Disclose which agents were used and to what extent

Docs, PR descriptions, issues, and comments are written by a human with AI
assistance: you own the first draft and the last draft; agents may work in
between.

## Branches

- `project-sable` is the active development trunk. All work branches from it,
  and every change lands through a PR into it. No direct pushes to it, ever;
  no force-pushes anywhere.
- `main` is the released line. Never open PRs against it and never push to
  it: it moves only when maintainers promote the trunk as part of a release,
  plus the automations listed below.
- GitHub's PR dropdown defaults to `main` — always switch the base to
  `project-sable`.

## PRs

- Small and single-purpose. Tests ride in the same PR as the change.
- CI must be green: tests, typecheck, and the spec gates.
- The TypeScript and Python SDKs stay even: a change visible in one lands in
  both, same PR, docs mirrors included (edit `docs/` only — skill mirrors
  self-sync).

## Interfaces

Interface and format changes need a design discussion before code: open an
issue describing the problem and the proposed shape, concise and
human-written, and wait for a maintainer response before building.

## Automations

The only direct pushes to any branch come from these workflows, and only to
`main`: `sync-docs-to-skill` (docs mirror), `image-refresh` (scheduled image
rebuild), and the release publish. Humans never push directly.
