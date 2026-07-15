# Project: Quality-Screen Observability & Universe Selection

**A two-repo improvement to Dexter's `run_quality_screen` tool so a 0-passers result is
explained (not misdiagnosed) and so the screen can target the right universe.**

## Why this exists

A live Dexter session ran `run_quality_screen`, got zero passers, and the LLM:
1. Misattributed the empty result to "backend limitations" (false — the scanner ran fine,
   `Errors: 0`, ~11s, all data keys populated), and
2. Fell back to manual per-ticker analysis and **hallucinated KO's Debt/Equity as 0.00**
   (real ≈ 1.41, confirmed against SEC 10-Q).

Root cause: the tool returns **only the passing shortlist**. On 0 passers it hands the model
an empty array with no reason, so the model confabulates a cause. The per-name failure
reasons already exist inside the scanner — they're logged, not surfaced.

## The two repos

- **Dexter** (this repo, TypeScript) — owns `src/tools/finance/quality-screen.ts`
  (`run_quality_screen`), which shells out to the scanner.
- **Stock scanner** (`/Users/Ambartsum/code/Stock scanner/scanner`, Python) — owns the
  deterministic `quality_moat` gates, the scan loop, and JSON output.

## Definition of done (whole project)

- `run_quality_screen` returns a `failure_summary` (screened / passed / rejected counts +
  a per-gate blocking tally + a few sample per-name reasons) whenever names are rejected,
  so 0-passers is self-explaining.
- `run_quality_screen` accepts a `universe` argument (incl. a fast curated `quality_growth`
  list) so it can screen the right names instead of only the mature default 40.
- All new logic is unit-tested; existing scanner tests (949) stay green; existing
  `save_json` array contract is unchanged.

## Non-goals

- Changing any gate threshold or the moat verdict (`assess_moat`) — out of scope.
- Wiring the tier-output scan path (`analyze_symbol_for_tier`) — `run_quality_screen` uses
  the single-profile path only.
- Option B (MCP-server data sources) — deferred, tracked elsewhere.
