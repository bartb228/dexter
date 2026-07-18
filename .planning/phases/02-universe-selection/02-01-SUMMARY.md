# 02-01 SUMMARY — Universe Selection

**Status:** ✅ Shipped & verified. Executed via `/task-loop` on 2026-07-14.
**Repos:** Stock scanner (`feat/quality-screen-rejections`) + Dexter (`nvidia-edgar-integration`).

## What shipped

`run_quality_screen` can now target the *right* universe instead of only the mature
default 40-name list.

1. **`universes.quality_growth()`** (scanner) — a STATIC curated seed of 39 net-cash /
   high-ROIC compounder CANDIDATES (sorted + de-duped, no network / no cache), wired into
   the scanner's `--universe` argparse choices and resolve elif chain.
2. **`universe` param** on `run_quality_screen` — `z.enum(['default','sp500','russell_1000',
   'russell_3000','dow_30','quality_growth'])`, the injection guard (no arbitrary string
   reaches argv). `symbols` always wins; the tool never sends both.
3. **`buildScanArgs()`** (exported pure helper) — the arg wiring, extracted so precedence +
   flag ordering are unit-testable without spawning Python. Also picks up the deferred
   01-02 order guard (`--rejections-json` before the variadic `--symbols`).
4. **`describeScreened()`** (exported pure helper, review-driven) — the result's `screened`
   label, extracted from `func()` so its branches are unit-tested.

## The curated `quality_growth` list (39 names)

```
ACN ADBE ALGN AMAT ANET AVGO CDNS CTAS DECK DXCM ELF FAST FICO GOOGL IDXX INTU
ISRG KLAC LRCX LULU MCHP META MNST MPWR MSCI MSFT NKE NOW ODFL PAYX POOL RMD ROL
SNPS TSCO TXN VEEV VRSK WST
```
These are CANDIDATES the `quality_moat` screen then filters — not pre-vetted passers.
Seeded with the four names that cleared the identical gates live (LRCX / MNST / DECK / RMD).

## Precedence rule (matches the scanner exactly)

`buildScanArgs`: always emits `--json` + `--rejections-json`; `--symbols` (variadic) is
ALWAYS last; `--universe` is sent ONLY when there are no symbols AND the universe is a
non-`'default'` value. `--symbols` beats `--universe` — never both. Mirrors the scanner's
resolve order (`scanner.py`: `if args.symbols → symbols win`, else the `--universe` elif
chain). Tool enum = scanner choices minus `'custom'`, plus `'default'` (= send no flag).

## Verification

- Scanner suite: **962 passed, 3 skipped**; `test_universes.py`: **14 passed** (the new
  `quality_growth` test proves no-network via a `requests.get`-raises monkeypatch +
  determinism + seed membership).
- Dexter: `bun test quality-screen.test.ts` → **17 pass** (7 `normalizeFailureSummary` +
  6 `buildScanArgs` + 4 `describeScreened`); `bun run typecheck` → **exit 0**.
- **Live smoke** `run_quality_screen({ universe: 'quality_growth', top: 10 })`:
  `passed: 4` — **DECK, MNST, RMD, LRCX** — WITH a `failure_summary` for the 35 rejected:
  `gate_tally {ROIC:21, PEG:19, CurrentRatio:15, Debt/Eq:14, RevGrowth:13, IntCoverage:11,
  ROE:6, MarketCap:2, Other:1}`. Both phases compose end-to-end.

## Review (Workflow: 4 lenses + adversarial verify, then a finish-judge — both PASS)

spec / code-quality+security / silent-failure all PASS (enum injection guard + precedence
confirmed). test-thoroughness FAILed on **4 pure coverage gaps (no bugs)**, all fixed:
extracted `describeScreened` + 4 tests; `buildScanArgs` tests now assert `--profile`/`--top`
and `--json`/`--rejections-json` on the default path; added a `universe: undefined`
default-shape test. Finish-judge (Sonnet): PASS — DoD met, fixes sound, no new defect.

## Out-of-scope observation (documented, not fixed — predates 02-01)

The scanner's single-profile `run()` path appears not to apply `--top` truncation to the
picks before `save_json` (its `--top` help says "Ignored for single-profile mode"). So
`run_quality_screen`'s `top` input may be **inert** for `quality_moat` scans where more
names pass than `top` requests. Not introduced by 02-01 (`buildScanArgs` is a pure
extraction of pre-existing inline `--top` wiring) and not part of any plan's DoD. Flagged
for a possible future follow-up.

## Project status

**PHASE 02 COMPLETE → whole project Definition of Done met:** `run_quality_screen` returns
a `failure_summary` whenever names are rejected (Phase 01), AND accepts a validated
`universe` argument incl. the fast curated `quality_growth` (Phase 02). The live
misdiagnosis that started this — "0 passers → backend limitations" + a hallucinated KO
Debt/Equity — is now structurally impossible: the tool points at a universe that can pass
and explains every rejection from the scanner's own data.
