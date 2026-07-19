# Quality-Screen v2 — Design (Phases 03–04)

**Date:** 2026-07-18 · **Status:** approved (brainstormed with the user).
**Builds on:** the shipped observability + universe project (Phases 01–02).

## Motivation

A full S&P 500 scan (503 names, `Errors: 0`) surfaced two weaknesses:
1. **NVDA and GOOGL fail on ROIC only** (12.6% / 14.3% vs the 15% floor) — a *measurement*
   artifact. The gate uses **book invested capital** (`equity + debt`), so idle cash inflates
   the denominator and penalizes cash-rich compounders. GOOGL misses by 0.7 points.
2. A rejected name is currently indistinguishable from a name that failed everything — no
   "who almost passed" signal, and the aggregate `gate_tally` still routes non-canonical
   gates (Mscore, GrossMargin, …) into a lossy `Other` bucket.

## Decisions (locked with the user)

- **Milestone = Phase 03 (screen accuracy & explainability) + Phase 04 (validation & scale).**
- **ROIC: additive, non-breaking.** Compute `roic_operating = NOPAT / (equity + debt − cash −
  short-term-investments)` ALONGSIDE the book ROIC. The gate passes if `max(book, operating)
  ≥ 15%`; both are reported. Deterministic (subtract-all-cash rule) — no judgment call about
  "excess" cash. NVDA/GOOGL expected to flip.
- **Near-miss = ranked, not thresholded.** Rank every rejected name by (number of gates
  failed, then total distance-to-threshold). GOOGL-class (1 gate, tiny margin) tops the list.
- **Architecture = Plan A (in-place augmentation of `passes_screen`).** Each gate site emits
  a structured `GateResult{gate, value, threshold, passed}` ALONGSIDE its existing failure
  string (string untouched → byte-identical, guaranteed). Single source of truth: the tally,
  near-miss ranking, gate-sensitivity, and Other→named all derive from these records, and the
  01-01 head-token string parser is retired. A pinned test asserts every existing failure
  string is byte-identical, and each string matches its struct (no within-function drift).
  A third `passed=None` (skipped/data-unavailable) state replaces today's silent skip.

## Phases & plans

**Phase 03 — Screen accuracy & explainability**
- **03-01 ROIC accuracy** — operating (cash-adjusted) ROIC + tighter inputs (EDGAR effective
  tax rate instead of flat 21%; real total-debt concept where present). Gate = `max(book,
  operating) ≥ 15%`; both surfaced in `picks`. **Acceptance: NVDA + GOOGL pass.**
- **03-02 Structured gates → near-miss + Other→named** — the Plan-A augmentation; a ranked
  `near_miss` list on the tool result; `gate_tally` keys become real gate names. Supersedes
  01-01's head-token map. (Depends on nothing, but shares `scoring.py` with 03-01 → sequential.)
- **03-03 Calibration & `--top`** — a `sensitivity` "what-if" report (loosen gate X → +N
  passers) derived from the structured results; fix `--top` to truncate single-profile picks
  by composite. (Depends on 03-02's structured results.)

**Phase 04 — Validation & scale** (light-specced now; detailed when reached)
- **04-01 Backtest** — do `quality_moat` passers beat the index over a historical window?
- **04-02 Universe performance** — cache resolved index membership + a cheap market-cap/price
  pre-filter before the expensive per-name fetches, so `sp500`/`russell` finish inside the
  tool's 300s cap.

## Guardrails (every plan)

- Deterministic checks first (pytest / bun test / typecheck), then a Workflow review panel +
  independent finish-judge (the loop that shipped 01–02).
- **Hard invariants:** the 962 scanner tests stay green; `save_json` array contract unchanged;
  failure strings byte-identical after the 03-02 augmentation; the tool never throws.
- Each plan has a concrete live-smoke acceptance (03-01 → NVDA/GOOGL flip; 03-02 → near_miss
  ranks GOOGL first; 03-03 → sensitivity reports the ROIC headroom).

## Non-goals

- No change to the gate *thresholds* (15% ROIC, D/E<0.5, …) — only how ROIC is *measured*.
- No new universes beyond `quality_growth` (shipped) in this milestone.
- Phase 04 backtest methodology is designed when we reach it, not now.
