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

- **02-01 SHIPPED**: curated static `quality_growth()` universe in the scanner + a validated
  `universe` enum arg on run_quality_screen (injection guard); `buildScanArgs`/`describeScreened`
  pure helpers; 17 TS tests + typecheck 0; scanner suite 962; Workflow panel + finish-judge PASS.
  Picked up the deferred 01-02 arg-order guard. See `phases/02-universe-selection/02-01-SUMMARY.md`.

## ✅ PROJECT COMPLETE (2026-07-14)
Whole Definition of Done met: run_quality_screen returns a failure_summary on rejections
(Phase 01) AND accepts a validated `universe` incl. quality_growth (Phase 02). Live smoke:
universe:quality_growth → passed 4 (DECK/MNST/RMD/LRCX) + failure_summary explaining 35 misses.
The original misdiagnosis ("0 passers → backend limitations" + hallucinated KO Debt/Eq) is
structurally impossible now.

## Milestone v2 — PLANNED 2026-07-18 (executing autonomously)
Design: docs/plans/2026-07-18-quality-screen-v2-design.md. Phase 03 (screen accuracy &
explainability): 03-01 operating cash-adjusted ROIC (max(book,operating)≥15%; NVDA/GOOGL flip),
03-02 Plan-A structured GateResults → near_miss + named tally, 03-03 gate-sensitivity + fix
--top. Phase 04 (light): 04-01 backtest, 04-02 universe perf (caching + pre-filter; also fixes
the --top-adjacent scale issue). Executing Phase 03 via task-loop + Workflow review panels.

## ✅ PHASE 03 COMPLETE (2026-07-19, autonomous)
- **03-02 SHIPPED** (b2cccd4 / 6e159a6): structured `GateResult`s → named `gate_tally` + ranked
  `near_miss`. **03-03 SHIPPED** (3d00436 / a2a417a): gate `sensitivity` (sole-blockers) + `--top`
  single-profile fix.
- **03-01 SHIPPED**: cash-adjusted (operating) ROIC — ROIC gate passes on `max(book, operating)≥15%`;
  cash + short-term investments extracted from edgartools 5.x (dimensional-filtered + sanity guard);
  **SEC `companyconcept` cross-source verification, period-aligned**, fail-safe drop-on-mismatch via
  a decoupled `operating_liquidity` key. Data-layer unblocked with a Python-3.11 venv
  (`scanner/.venv`, edgartools 5.42). Live: GOOGL flips to PASSED (op ROIC 0.208, `verified`); NVDA's
  ROIC gate passes (then M-score blocks). Scanner 1010 (py3.9)/1026 (venv); Dexter 21 + tsc 0.
  5-lens Workflow review → 3 CONFIRMED findings all fixed (fail-safe defeat, period-mismatch,
  integration coverage). See `phases/03-screen-accuracy/03-01-SUMMARY.md`.
- **Production wiring:** Dexter `run_quality_screen` auto-resolves `SCANNER_PYTHON` to the venv when
  present (edgartools needs py≥3.10), else `python3` (screen still works, no operating-ROIC rescue).
- Next: **Phase 04** (backtest + universe perf).

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
