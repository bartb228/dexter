# 01-01 SUMMARY — Failure Observability (Python scanner)

**Status:** ✅ Shipped & verified. Executed via `/task-loop` on 2026-07-14.
**Repo:** `/Users/Ambartsum/code/Stock scanner/scanner/` (external to Dexter).

## What shipped

The Stock scanner now emits *why* symbols were rejected during a single-profile
scan, so a 0-passers `run_quality_screen` result is self-explaining instead of
misdiagnosed as a "backend limitation".

1. **`scoring.summarize_rejections(rejections, *, screened, passed, max_samples=8)`**
   — categorizes per-symbol screen failures into a blocking-gate tally + capped
   samples. Deterministic (`(-count, key)` ordering), JSON-serializable, no
   wall-clock/randomness. Helpers: `_rejection_gate_for` (head-token → gate),
   `_rejection_is_operational` (infra-skip predicate), `_REJECTION_GATE_BY_HEAD`,
   `_REJECTION_INFRA_SKIP_REASONS`.
2. **`report.save_rejections_json(summary, path)`** — writes the summary as a JSON
   object; `None`/`{}` → `{}` (never crashes, never `null`). Sibling to
   `save_json`'s picks array — the picks-array contract (D1) is untouched.
3. **`--rejections-json [PATH]` CLI flag** (`scanner.py` argparse) — off by default.
4. **Scan-loop capture** in `run()` — accumulates genuine quality-gate rejections
   (excluding infra skips) and bubbles them via `context["rejections"]` (no change
   to `run()`'s `(df, errors, context)` arity — D3). `main()` writes the summary
   after the `--json` handling.

## Files touched

| File | Change |
|------|--------|
| `scoring.py` | +`summarize_rejections` + 3 helpers + 2 module constants (after `passes_screen`) |
| `report.py` | +`save_rejections_json` (after `save_json`) |
| `scanner.py` | +imports; +`--rejections-json` argparse; `rejections[]` init + capture in `run()`; `context["rejections"]`; guarded write in `main()` |
| `tests/test_summarize_rejections.py` | new — 11 cases |
| `tests/test_report_tier_rendering.py` | +`test_save_rejections_json_roundtrip` |

## The exact prefix→gate map used (grepped from `passes_screen`, not memory)

Bucketing key = each failure's **head token** = substring before the first
delimiter in `= <>()`. `/` is deliberately NOT a delimiter, so `Debt/Eq`, `P/E`,
`P/B` survive as whole heads. Every fail-closed variant of a gate shares one head
(`ROIC=unavailable…`, `ROIC=non-finite…`, `ROIC=0.10 < 15%…` → `ROIC`).

```
Head token   → canonical gate
ROIC         → ROIC
IntCoverage  → IntCoverage
RevGrowth    → RevGrowth
PEG          → PEG
Debt/Eq      → Debt/Eq
P/E          → P/E
P/B          → P/B
ROE          → ROE
MarketCap    → MarketCap
CurrentRatio → CurrentRatio
(anything else) → Other      # e.g. Mscore, GrossMargin, RuleOfXUpside, EPSGrowth, AvgDailyVol, Upside
```

**Excluded from the tally (infra / data-availability skips, NOT quality gates):**
`rate_starved:*`, `*sector_excluded=*`, `"no fundamentals data"`,
`"insufficient price history"`.

## Verification

- `test_summarize_rejections.py`: **11 passed**; `test_report_tier_rendering.py`:
  **10 passed** (incl. the pinned `save_json` D1 test); full suite:
  **961 passed, 3 skipped** (no regressions).
- Live smoke `--profile quality_moat --symbols KO MSFT NVDA`: `Errors: 0`,
  rejected 3, real gate tally incl. **KO `Debt/Eq=1.4142`** — the exact value the
  Dexter LLM had hallucinated as 0.00. Misdiagnosis closed at the data layer.
- Live smoke `--symbols KO FAKETICKERXYZ`: the data-skipped ticker is excluded —
  no false `Other`.
- Live smoke `--profile all --rejections-json`: warns, writes nothing.

## Deviations from the plan (all review-driven, verified)

An independent 3-reviewer panel (Sonnet) + a finish-judge (Sonnet, PASS) ran at
close-out. Two **confirmed** defects were fixed beyond the plan's original text:

1. **Data-availability skips miscounted (CRITICAL, fixed).** `analyze_symbol`
   returns `"no fundamentals data"` / `"insufficient price history"` *before*
   `passes_screen`. The plan's capture filter only excluded `rate_starved:` /
   `sector_excluded=`, so these landed in `gate_tally["Other"]` — reintroducing
   the very misdiagnosis this feature prevents (a data outage looking like a
   quality failure). Fix: added both to `_REJECTION_INFRA_SKIP_REASONS`, and the
   scanner capture site now uses the shared `_rejection_is_operational` predicate
   (also removing a duplicated `any(...)` recompute). Proven live.
2. **Tier-mode false summary (CRITICAL, fixed).** `--profile all` (tier path,
   out of scope per D2) + `--rejections-json` wrote a false `{"rejected":0,…}`.
   Fix: `main()` guards on `context.get("tier_output")` → logs a warning and
   writes nothing (does NOT implement tier capture — D2 keeps that out of scope).
   Proven live.

Two extra tests were added for the above (`test_operational_and_data_skips_…`,
`test_samples_default_cap_is_eight_when_omitted`) → 11 cases total (plan spec'd 9).

**Considered and rejected:** expanding the canonical map to the ~6 non-canonical
gate heads (`Mscore`, `GrossMargin`, `RuleOfXUpside`, `EPSGrowth`, `AvgDailyVol`,
`Upside`). The plan deliberately defines exactly 10 canonical keys + `Other`;
`→ Other` for the rest is spec-compliant (confirmed by the code-quality reviewer).
`Mscore` is the one active-for-quality_moat gate among them — surfacing it as its
own key (rather than `Other`) is noted as a **possible future enhancement** for the
user to decide, not a defect.

## Known, accepted coverage gap (skipped loudly)

`main()`'s tier-mode guard is verified by live smoke (c) but not by a pytest —
codifying it would need a subprocess `--profile all` live-network scan,
disproportionate to a 3-line `if context.get("tier_output")` branch. Recorded as a
follow-up candidate, not a blocker (finish-judge concurred, <50% confidence,
informational).

## Next

**01-02** (Dexter TS tool): have `run_quality_screen` request + read the
`--rejections-json` output and attach a `failure_summary` to its result, and
rewrite the tool description so the model reads the gate tally instead of
confabulating "backend limitations".
