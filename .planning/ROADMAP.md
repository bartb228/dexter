# Roadmap: Quality-Screen Observability & Universe Selection

Depth: Phases 01–02 shipped (3 plans). Milestone v2 = Phases 03–04 (design:
docs/plans/2026-07-18-quality-screen-v2-design.md).

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

## Phase 03 — Screen Accuracy & Explainability (v2)
**Goal:** Fix the measurement artifacts and make the screen self-explaining beyond a tally.

- **03-01** (scanner + Dexter): operating (cash-adjusted) ROIC alongside book ROIC — gate
  passes if `max(book, operating) ≥ 15%`; both reported; tighter tax/debt inputs. Acceptance:
  NVDA + GOOGL flip to passing.
- **03-02** (scanner + Dexter): Plan-A augmentation of `passes_screen` to emit structured
  `GateResult`s alongside the (byte-identical) failure strings; a ranked `near_miss` list on
  the tool result; `gate_tally` keys become real gate names (retires the 01-01 head-token map).
- **03-03** (scanner + Dexter): gate-sensitivity "what-if" report (loosen gate X → +N passers)
  + fix `--top` truncation for single-profile scans.

**Depends on:** Phases 01–02. 03-02 shares `scoring.py` with 03-01 (sequential); 03-03 uses
03-02's structured results.

## Phase 04 — Validation & Scale (v2, light-specced)
**Goal:** Prove the screen earns its strictness, and make broad universes fast.

- **04-01** (scanner, research): backtest `quality_moat` passers vs the index over a historical
  window; report hit-rate / excess return. Methodology designed when reached.
- **04-02** (scanner): cache resolved index membership + a cheap market-cap/price pre-filter so
  `sp500`/`russell` finish inside the tool's 300s cap.

**Depends on:** Phase 03 (a trustworthy screen is worth backtesting).

## Domain Expertise

None loaded — this is internal work extending established patterns in two known repos
(the `DynamicStructuredTool` + `spawn` pattern in Dexter; the `passes_screen` /
`analyze_symbol` / `save_json` pattern in the scanner).
