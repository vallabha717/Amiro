# Phase NN — <Title>

<!-- Added by the `implement` skill once this phase ships, never before:
> **Shipped YYYY-MM-DD.** See [progress/phase-NN-<slug>.md](../progress/phase-NN-<slug>.md)
> for what was built, what diverged, and the verification log.
-->

**Depends on:** <phase numbers, or —> · **Blocks:** <phase numbers, or —> · **Size:** S | M | L

**Surfaces touched:** <backend · desktop · web · terminal — name them explicitly>

One paragraph: what this phase makes true that was not true before. Written
in the future tense. This is intent, not a status report.

## What already exists

What is in the tree today that this phase builds on, extends, or
deliberately leaves alone — with real paths. Say explicitly what stays and
why, so the next agent does not delete or duplicate it.

## Deliverables

### 1. <Component or package>

- Concrete, file-level bullets. A reader should be able to predict which
  files exist after this phase.
- Name the standards that apply (link to the `ui` / `backend` skill areas)
  where the shape is not obvious.

### 2. <Component or package>

| Item | Covers |
|---|---|
| … | … |

### 3. Test coverage (required — see the `test` skill)

Name the directories this phase creates, per surface it touches. Every
surface listed above gets a row; a behaviour two surfaces must agree on
gets a `cross` row as well.

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/<feature>/` | … |
| terminal | `tests/suites/tui/<feature>/` | … |
| web | `tests/ui/specs/<feature>/` | … + the `data-testid`s `clients/web/src/` must add |
| desktop | `tests/suites/desktop/<feature>/` | … |
| cross | `tests/suites/cross/<feature>/` | what must agree, and between which surfaces |
| meta | `tests/suites/meta/` | the guard enforcing any contract introduced here |

**Deliberately not covered:** <what, and why — an absent toolchain, a
dialect with no server here. Stated now so it lands as a reasoned skip
rather than a silent one.>

### 4. <Docs / contracts / guards this phase must also add>

## Exit criteria

Numbered. Every one verified by running something and reading its output.
No "is implemented", no "is clean", no "works well".

1. `amirotest run --surface <s> --feature <f>` passes in under <budget>.
2. <A specific assertion that a specific test makes>.
3. <A contract that a guard now enforces, and where the guard lives>.
4. <A behaviour asserted on each surface this phase claims to touch>.
5. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **<Risk>.** Why it is likely, and the concrete mitigation — not just the
  worry.

## Open questions

Anything genuinely undecided, with who or what decides it. Delete the
section if there are none; do not pad it with questions you can answer.
