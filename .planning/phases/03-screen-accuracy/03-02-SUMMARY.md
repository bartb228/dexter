# 03-02 SUMMARY — Structured gates → near-miss + named tally

**Status:** ✅ Shipped & verified (autonomous). Executed 2026-07-18.

## What shipped
- **`GateResult` NamedTuple** + `passes_screen` augmented (Plan A): a `_gf(gate,value,threshold,msg)`
  helper appends the **byte-identical** failure string AND records a structured GateResult at each
  quality_moat/global gate site; `f["gate_failures"]` bubbles out.
- **Threading:** `analyze_symbol` gained an optional `gate_sink` param (2-tuple return preserved →
  zero test blast-radius); `run()`'s `_analyze_one` threads a 5-tuple; rejection capture is a 3-tuple.
- **`summarize_rejections` rebuilt:** per-symbol **union** of structured GateResults (deduped by
  gate) + head-token fallback for any uncovered reason — so no reason is dropped on any profile;
  `gate_tally` keyed by **real gate names** (no `Other` for known gates); ranked **`near_miss`**
  (fewest gates × smallest margin) with per-gate value/threshold. `_gate_margin` helper.
- **Dexter:** `FailureSummary.near_miss` + defensive `normalizeFailureSummary` coercion (cap 15,
  margin ≥ 0, never throws — D6); description instructs the model to cite `near_miss`.

## Verification
- Scanner **970 passed, 3 skipped**; `test_gate_results.py` + `test_summarize_rejections.py` green.
- Dexter `bun test` **20 pass**; `typecheck` exit 0.
- **Live** (quality_growth): `gate_tally` fully named incl. `Mscore`; `near_miss[0] = GOOGL`
  (1 gate, ROIC 0.1428 < 0.15, margin 0.0479), then DXCM, then WST.

## Review (5-lens Workflow + finish-judge)
- spec PASS. Panel found **1 CRITICAL/HIGH (confirmed): all-or-nothing branch silently dropped
  un-instrumented gate reasons on GARP/hyper-growth** → fixed via the union + expanded head-token
  map. P/E-bool **double-emit (MEDIUM)** → dedupe. Dexter **margin clamp (MEDIUM)**.
- Finish-judge caught the fix was **incomplete** (missed `OperatingLeverage`/`NetDilution`) →
  added them (+ gross-margin-quality heads) + a regression test. Re-verified green.

## Deviations / notes
- MVP records **failures only** (pass/skip GateResult states deferred) — sufficient for tally +
  near-miss. GARP/hyper-growth gates named via the head-token fallback (map), not `_gf`.
- Byte-identical failure strings held automatically (the 962→970 suite is the golden test).

Next: 03-03 (gate-sensitivity + `--top`), then data-layer (`edgartools`) + 03-01 (operating ROIC).
