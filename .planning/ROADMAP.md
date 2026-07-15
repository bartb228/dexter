# Roadmap: Quality-Screen Observability & Universe Selection

Depth: quick (2 phases, 3 plans). Derived from actual work, not padded.

## Phase 01 — Failure Observability
**Goal:** A 0-passers screen is never misdiagnosed again. Surface *why* names fail —
per-gate blocking tally + sample reasons — through the scanner and up into the tool result.

- **01-01** (Python scanner): capture per-symbol rejections during the single-profile
  scan; add `summarize_rejections()` (categorize each failure into its blocking gate),
  `save_rejections_json()`, and a `--rejections-json` flag. Research: No.
- **01-02** (Dexter TS tool): have `run_quality_screen` request + read the rejections file,
  attach a `failure_summary` to the result, and rewrite the tool description so the model
  reads the tally instead of confabulating "backend limitations". Research: No.

**Depends on:** nothing (extends existing `run_quality_screen` + scanner, shipped this session).

## Phase 02 — Universe Selection
**Goal:** Let the screen target the *right* universe. The mature default 40-name universe
is unsuitable for a quality-growth screen; expose universe choice + a fast curated list.

- **02-01** (Scanner + Dexter TS tool): add a curated static `quality_growth()` universe to
  `universes.py` (net-cash, high-ROIC compounders) and wire it into the scanner; add a
  validated `universe` argument to `run_quality_screen`. Research: No.

**Depends on:** Phase 01 (a broad universe makes the failure_summary far more valuable —
seeing 400 rejected with a gate tally is the payoff).

## Domain Expertise

None loaded — this is internal work extending established patterns in two known repos
(the `DynamicStructuredTool` + `spawn` pattern in Dexter; the `passes_screen` /
`analyze_symbol` / `save_json` pattern in the scanner).
