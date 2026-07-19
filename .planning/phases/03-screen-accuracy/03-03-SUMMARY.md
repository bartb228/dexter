# 03-03 SUMMARY — Gate-sensitivity + --top fix

**Status:** ✅ Shipped & verified (autonomous). 2026-07-18.

## What shipped
- **`sensitivity`** in `summarize_rejections`: per gate, how many names it **sole-blocks** (fail
  ONLY that gate), the closest sole-blocker's metric value (`would_admit_at`) + `threshold` +
  up to 3 examples, sorted by sole-blocker count. Derived from the existing structured `near`
  list — **no re-scan**.
- **`--top` fixed for single-profile:** `run()` records `context["passed_total"]` BEFORE
  `df.head(top_n)`, and `main()` passes that to `summarize_rejections` — so picks cap to top-N
  by composite while the summary's `screened`/`passed` stay **full-universe**. Closes the
  "`--top` inert for single-profile" issue flagged during the 01-02 finish-judge.
- **Dexter:** `FailureSummary.sensitivity` + defensive `normalizeFailureSummary` coercion
  (never throws — D6); description instructs the model to cite it.

## Verification
- Scanner **975 passed, 3 skipped**; Dexter `bun test` **21 pass**; typecheck exit 0.
- **Live** (quality_growth, `--top 2`): picks capped to `[DECK, MNST]` while summary `passed=4`
  (full-universe); `sensitivity`: `ROIC` sole-blocks 2 (closest GOOGL 0.1428 < 0.15), IntCoverage 1
  (LULU), PEG 1 (WST).

## Review (4-lens Workflow)
- spec / code-quality / silent-failure **PASS** (no correctness issues). test-thoroughness
  flagged 3 coverage gaps (no bugs): fail-closed sole-blocker (value=None) + empty-df+top_n →
  **tests added**; main()-level `--top`+`--rejections-json` → covered by the live smoke.

Next: Phase 03's last plan — **03-01 operating (cash-adjusted) ROIC**, gated on the `edgartools`
data-layer fix (install + `short_term_investments` extraction) so NVDA/GOOGL can flip.
