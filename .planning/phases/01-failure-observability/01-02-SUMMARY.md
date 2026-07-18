# 01-02 SUMMARY — Failure Observability (Dexter TS tool)

**Status:** ✅ Shipped & verified. Executed via `/task-loop` on 2026-07-14.
**Repo:** `/Users/Ambartsum/code/Dexter` (branch `nvidia-edgar-integration`).

## What shipped

`run_quality_screen` now requests + reads the scanner's `--rejections-json` file and
attaches a `failure_summary` to its result, so on a 0-passers screen the model receives
the *reason set* (per-gate tally + sample per-name reasons) instead of an empty array it
would rationalize into "backend limitations".

1. **`FailureSummary` type + `normalizeFailureSummary(raw: unknown)`** (exported) —
   defensively coerces the rejections JSON into a clean `FailureSummary` or `undefined`.
   Non-object/array/null → `undefined` (never throws — D6). Counts clamp to `≥ 0`;
   non-number / negative gate-tally values dropped; samples require a real symbol and are
   capped at 8.
2. **Second temp file `rejPath` + `--rejections-json`** in the spawn args, placed BEFORE
   the variadic `--symbols` spread (argparse `nargs='+'` would otherwise swallow the flag).
   Read the SAME defensive way as the picks file (try/catch + `finally` cleanup).
3. **`failure_summary` attached to BOTH returns** (success + hard-error early-return),
   only when defined — a hard failure still shows any partial tally.
4. **Description rewrite** — a new "Interpreting an empty result" section that forbids
   BOTH halves of the original bug: the "backend limitations" misattribution AND inventing
   a metric value (cites the real KO `Debt/Equity ≈ 1.41`, not the hallucinated `0.00`).

## The `FailureSummary` shape

```ts
export interface FailureSummary {
  readonly screened: number;
  readonly passed: number;
  readonly rejected: number;
  readonly gate_tally: Readonly<Record<string, number>>;              // gate → count (>= 0)
  readonly samples: ReadonlyArray<Readonly<{ symbol: string; failures: readonly string[] }>>;
}
```

`normalizeFailureSummary` is the sole sanctioned constructor; `readonly` makes that a
compile-time contract rather than a convention.

## Description-copy diff (added)

- `.description` one-liner, appended: *"On 0 passers, returns a failure_summary (per-gate
  tally + sample reasons) explaining WHY names were rejected — this is not an error and
  not a backend limitation."*
- `RUN_QUALITY_SCREEN_DESCRIPTION`, new section:
  > **## Interpreting an empty result (passed: 0)** — Zero passers is NOT a backend/data
  > failure; read `failure_summary.gate_tally` for WHY and `failure_summary.samples` for
  > the tickers. NEVER attribute 0 passers to "backend limitations", and NEVER invent a
  > metric value (KO's Debt/Equity is ~1.41, not 0.00). To surface passers, screen a
  > broader set of names rather than loosening the gates in your reasoning.

## Files touched

| File | Change |
|------|--------|
| `src/tools/finance/quality-screen.ts` | +`FailureSummary` (readonly) + `normalizeFailureSummary`; `rejPath` + `--rejections-json`; defensive read; `failure_summary` on both returns; `!r.ok` warn; description rewrite |
| `src/tools/finance/quality-screen.test.ts` | new — 7 cases (`bun:test`) |
| `../Stock scanner/scanner/scanner.py` | rejections write in `main()` made soft-failing (try/except, log+continue) — review-driven |

## Verification

- `bun test quality-screen.test.ts`: **7 pass, 0 fail**; `bun run typecheck`: **exit 0**.
- Scanner suite (Python soft-fail change): **961 passed, 3 skipped**.
- Live smoke `run_quality_screen({symbols:['KO','MSFT','NVDA']})`: `passed: 0` WITH
  `failure_summary.gate_tally {ROIC:3, CurrentRatio:2, Debt/Eq:1, RevGrowth:1}` and KO in
  samples — the model now gets KO's real `Debt/Eq` block instead of an empty array.

## Deviations (all review-driven; Workflow panel of 5 lenses + adversarial verify, then a finish-judge — both PASS)

**Fixed beyond the plan text:**
1. **HIGH silent-failure (confirmed):** the scanner's `--rejections-json` write (added in
   01-01) was unguarded, so a write failure after picks were written would non-zero-exit an
   otherwise-successful scan — and the tool's success path never checked `r.ok`, making the
   crash invisible. Fixed both sides: Python write is now soft-failing (log+continue,
   mirroring the RSS-poll pattern); the tool `logger.warn`s on a non-zero exit that still
   returned records.
2. Hardened `normalizeFailureSummary`: clamp counts `≥ 0`, drop negative tallies, drop
   malformed sample rows (non-objects and objects lacking a real symbol), `readonly` type.
   +2 tests (7 total; plan spec'd 5).

**Deferred to 02-01:** a unit test locking the `--rejections-json`-before-`--symbols`
arg ordering. 02-01 Task 3 extracts a pure `buildScanArgs` helper and tests exactly this
ordering — doing it here would pre-empt that refactor. Current ordering is proven correct
by the live smoke.

**Declined:** tightening numeric-string count fields to reject the whole summary — the
failing input (numeric strings) is unreachable from our scanner (it emits JSON numbers)
and the change would conflict with the plan's test-5 (`missing → 0`).

## Next

**Phase 01 is now complete** (01-01 scanner + 01-02 tool). Next milestone: **02-01**
(Universe Selection) — a curated static `quality_growth()` universe in the scanner + a
validated `universe` argument on `run_quality_screen`, which also picks up the deferred
`buildScanArgs` refactor + arg-order test.
