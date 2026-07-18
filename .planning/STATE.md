# Project State

## Current position
**PHASE 01 COMPLETE & verified 2026-07-14** (via /task-loop):
- **01-01 SHIPPED**: scanner emits per-gate rejection tally + samples via
  `--rejections-json`; 961 tests green; panel + finish-judge PASS; 2 review-driven fixes
  (data-skip exclusion, tier-mode guard). See `phases/01-failure-observability/01-01-SUMMARY.md`.
- **01-02 SHIPPED**: `run_quality_screen` reads the file + attaches `failure_summary`;
  description forbids "backend limitations" + metric hallucination; 7 TS tests + typecheck 0;
  Workflow review panel + finish-judge PASS; 4 review-driven fixes (soft-fail scanner write,
  r.ok warn, normalizeFailureSummary clamp/filter, readonly type). See `01-02-SUMMARY.md`.

The live misdiagnosis is now closed end-to-end: a 0-passers screen returns a real gate
tally (incl. KO Debt/Eq) instead of "backend limitations".
Next: execute `02-01` (universe selection) — also picks up the deferred `buildScanArgs`
refactor + arg-order test flagged during 01-02 review.

## Accumulated decisions (constrain execution)
- **D1 — separate rejections file.** Emit rejections via a NEW `--rejections-json <path>`,
  NOT by changing `save_json`'s shape. `save_json` writes a plain array of passers and is
  pinned by `test_save_json_emits_records_preserving_lists`; keep that contract intact.
- **D2 — single-profile path only.** `run_quality_screen` calls `scanner.py --profile
  quality_moat`, i.e. the `run_scan` single-profile path (~scanner.py:804-1120). Wire
  rejection capture there. The tier-output path (`analyze_symbol_for_tier`) is out of scope.
- **D3 — bubble rejections via `context`.** `run_scan` already returns
  `(df, errors, context)`. Add `context["rejections"]`; `main()` writes the file only when
  `--rejections-json` is set. Do not change `run_scan`'s return arity.
- **D4 — fail-closed already in place.** ROIC / interest-coverage gates REJECT on missing
  data (shipped this session). Rejection reasons must preserve those exact strings.
- **D5 — curated universe is static.** `quality_growth()` returns a hardcoded list (no
  network), unlike sp500()/russell_*() which scrape Wikipedia — keeps the tool fast + offline.
- **D6 — tool never throws.** `run_quality_screen` must keep its "always return
  formatToolResult, never throw" property when reading the new rejections file (guard
  missing/non-object JSON → empty summary).

## Deferred issues
- Option B: MCP-server data backends for the screen — deferred by user.
- Setting a real `EDGAR_USER_AGENT` in Dexter's `.env` (assess_moat placeholder).

## Blockers / concerns
- None. Both repos build + test locally; scanner data keys populated; 949 scanner tests green.

## Alignment
Roadmap description still matches the goal: the live misdiagnosis (0-passers →
"backend limitations", KO D/E=0.00 hallucination) is exactly what Phase 01 prevents.
