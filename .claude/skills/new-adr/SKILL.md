---
name: new-adr
description: Scaffold a new Architecture Decision Record in docs/adr/, following the existing numbering and section format, and update the index. Use when a real decision was made (a technology/config choice, a tradeoff, something worth explaining to a future reader) — not for routine changes.
---

# new-adr

## When to Apply

When making a design or technical decision worth remembering the reasoning for: routing
logic, the call-log's capture/retention rules, storage/persistence choices, deployment
topology, or anything where a future reader (human or agent) would otherwise have to
re-derive "why is it built this way?" from scratch.

## Expected Behavior

### Step 1 — Determine the next ADR number

```bash
ls docs/adr/[0-9][0-9][0-9][0-9]-*.md | sort
```

Take the highest number and increment by one. Four digits, zero-padded (e.g. `0002`). Only
two ADRs exist as of this writing (`0001-mongodb-call-log.md`, `0002-structured-ollama-stats.md`) — always check the current
count rather than assuming a number.

### Step 2 — Create the ADR file

`docs/adr/<NNNN>-<kebab-case-title>.md`:

```markdown
# ADR-<NNNN>: <Title>

- **Date:** <YYYY-MM-DD>
- **Status:** Accepted

## Context

[What problem or situation prompted this decision?]

## Decision

[What was decided, and how does it work? Be specific — name the actual files/functions
involved, not just the concept.]

## Alternatives Considered

[What else was considered, and why was it rejected? "Rejected: <reason>" per alternative.]

## Consequences

[Trade-offs. Good/Neutral/Negative, with ⚠️ for drawbacks/caveats — including ones that only
bite later.]
```

Read `docs/adr/0001-mongodb-call-log.md` first to match tone and level of detail.

### Step 3 — Add to the index

Append a line to `docs/adr/README.md`'s `## Records` list:

```markdown
- [ADR-<NNNN>: <Title>](./<NNNN>-<kebab-case-title>.md)
```

An un-indexed ADR is effectively invisible — don't skip this.

### Step 4 — Cross-link from the source and docs

If the decision changes something a reader would hit while reading code, add a one-line
comment pointing at the ADR — see the Origin-rewrite comment in `server/index.js`'s
`ollamaProxy` for the pattern. Also check whether `docs/architecture.md`, `docs/routing.md`,
or `docs/deployment.md` need a matching update (a new diagram, an updated explanation) —
these are the three docs pages that describe how this repo actually works.

## Constraints

- ADR numbers must be sequential with no gaps.
- Status must be `Accepted` (or `Proposed` if genuinely still under discussion).
- Don't write an ADR for something reversible and inconsequential. If in doubt, ask: "would
  someone be confused in 6 months without this written down?"
- Ask before pushing — this is a public repo, and a push here can also trigger a rebuild/
  deploy if it touches anything outside `docs/**`/`**.md` (an ADR-only change won't).

## References

- `docs/adr/README.md` — the index to update
- `docs/adr/0001-mongodb-call-log.md` — length/tone reference, and the pattern for citing
  alternatives with concrete reasons instead of hand-waving
- `docs/architecture.md`, `docs/routing.md`, `docs/deployment.md` — diagrams/narrative that
  may need a matching update alongside a new ADR
