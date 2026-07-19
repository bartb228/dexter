# 03-01 SUMMARY — Cash-adjusted (operating) ROIC + SEC cross-source cash verification

**Status:** ✅ Shipped & verified (autonomous). 2026-07-19.

## What shipped
- **Operating (cash-adjusted) ROIC** (`scoring.compute_roic_operating`): `NOPAT / (equity + debt
  − cash − short_term_investments)`, NOPAT = op_income × 0.79. The ROIC gate now passes on
  **`max(book, operating) ≥ 15%`** — cash-rich compounders aren't penalized for holding cash.
  Byte-identical to book ROIC when no cash is present; if netting drives invested capital ≤ 0 it
  falls back to book IC. `f["roic_operating"]` is surfaced on every row.
- **edgartools 5.x cash extraction** (`edgar_source.fetch_cash_and_investments`): cash +
  short-term (marketable) investments from `balance_sheet().to_dataframe()`, with `_bs_toplevel`
  dropping dimensional/breakdown/abstract rows and a sanity guard rejecting the netting if
  `cash+mkt > current/total-assets × 1.02`. Additive-only — **never overrides equity/debt**.
- **`_bs_extract` exact-match-first** (bug fix): an exact prefix-stripped concept match is tried
  across all rows *before* any `endswith`/substring fallback. Fixes a real defect where
  `OtherAssetsCurrent` (~$3B subset) shadowed `AssetsCurrent` (~$80B total) via `endswith`,
  making the sanity guard reject valid cash (NVDA/GOOGL were silently blocked by it).
- **SEC cross-source verification** (the ask): the extracted netting is checked against the
  **independent** SEC `companyconcept` XBRL endpoint (`_sec_companyconcept_latest` →
  `_sec_independent_liquidity` → `_cash_verify_verdict`) — a different extraction path from
  edgartools' statement rendering, so the two fail independently. The check is **period-aligned**:
  it pulls the SEC fact *for the same balance-sheet period-end*, so `verified` means a genuine
  same-period reconciliation (not a coincidental magnitude match). Agreement within
  `CASH_VERIFY_TOLERANCE` (0.30) → `cash_verified=True`. Material disagreement → **fail-safe:
  the netting is DROPPED** (operating ROIC falls back to book) with `cash_verified=False` +
  `cash_verification="mismatch:…"`. When a component can't be confirmed at that period (second
  source unavailable, or marketable securities tagged under a **custom taxonomy** the us-gaap
  endpoint can't see, e.g. NVDA) → netting kept, honestly flagged `unverified`. Config:
  `CASH_VERIFY_ENABLED` (True), `CASH_VERIFY_TOLERANCE` (0.30).
- **Decoupled netting input:** the verified liquidity is written under a **dedicated
  `operating_liquidity` key**, never the shared `total_cash` (which the broader EDGAR override
  also writes). `compute_roic_operating` nets *only* `operating_liquidity`, so a mismatch that
  omits it is a hard guarantee of `operating == book` — the fail-safe can't be silently undone
  by the `total_cash` override running later in the same enrichment.
- **data_sources**: additive merge in `_enrich_via_edgar` (`if v is not None`); no `total_cash`
  collision.
- **Dexter** (`quality-screen.ts`): `SELECT += roic_operating, cash_verified, cash_verification`;
  the tool description explains the `max(book, operating)` gate + the SEC cross-check;
  `SCANNER_PYTHON` **auto-resolves to `.venv/bin/python`** when present (edgartools needs
  Python ≥ 3.10) else `python3` — so the flip is live in production, degrading gracefully.

## Data-layer unblock
Operating ROIC needs `short_term_investments`, which the Python-3.9 scanner env could not source
(max `edgartools` there is 4.6.3, broken/old API). Resolved by a **Python 3.11 venv** at
`scanner/.venv` (`edgartools 5.42.0`); the scanner suite is green under both 3.9 and the venv.

## Verification
- Scanner **1010 passed** (py3.9) / **1026 passed** (py3.11 venv); **35 new tests**
  (`tests/test_cash_verification.py`: verdict boundaries, SEC helpers w/ mocked `requests` incl.
  period-end filtering, `_bs_extract` exact-vs-subset shadowing, `_bs_toplevel` dimensional drop,
  operating-ROIC fallbacks, and **`fetch_cash_and_investments` end-to-end** integration —
  verified / mismatch-drops-netting / unverified / disabled / no-cash / sanity-guard). Dexter
  `bun test` **21 pass**; `tsc` exit 0.
- **Live end-to-end (venv, `--no-cache`):** GOOGL **flips to PASSED** — book ROIC 0.152 →
  **operating 0.208** via `operating_liquidity` $126.8B, **`cash_verified: True`** (period-aligned).
  NVDA's ROIC gate now **passes** (was `ROIC 0.126 < 15%`) and it's blocked instead by the Beneish
  M-score — a separate, legitimate earnings-quality gate.

## Review (5-lens Workflow + adversarial verify)
Panel (correctness / financial-data / security / silent-failure / test-coverage), each finding
adversarially re-verified. Security: clean. **3 CONFIRMED findings — all fixed:**
1. **Fail-safe defeat (HIGH):** the mismatch path withheld `total_cash`, but the pre-existing
   `fetch_balance_sheet` override (whose `override_keys` include `total_cash`) re-wrote it →
   `compute_roic_operating` would net the rejected figure. **Fix:** decoupled the netting onto a
   dedicated `operating_liquidity` key that only the verified path writes; `compute_roic_operating`
   nets only that → mismatch (key omitted) guarantees `operating == book`.
2. **Verification compared different fiscal periods (HIGH):** the annual balance sheet was checked
   against SEC *latest-per-concept across all forms* (10-Q + 10-K), and missed NVDA's custom-tag
   marketable securities → "verified" was coincidental. **Fix:** period-aligned the SEC lookup to
   the balance-sheet period-end; when a component can't be resolved at that period (custom tag),
   return `unverified` instead of a false `verified`.
3. **`fetch_cash_and_investments` untested (HIGH):** only pure helpers were covered. **Fix:** added
   7 end-to-end integration tests (mock edgartools + stubbed SEC verifier).

**Independent finish-judge (fresh Sonnet agent) → GO.** Confirmed all 3 fixes real + complete,
re-ran both suites green, verified the byte-identical invariant holds. Flagged 2 minor items: one
**fixed now** — the loose STI matcher could pick a *noncurrent* marketable-securities row, so
extraction now prefers exact us-gaap **Current** concepts with a noncurrent-guarded fallback
(+2 tests); one **deferred** (follow-up) — the Dexter surfacing of the new fields
(`roic_operating`/`cash_verified`/`cash_verification`) has no unit test (the picks-mapping isn't
easily testable without spawning Python; the fields are proven to flow via the live scan).

Phase 03 complete (03-01 + 03-02 + 03-03). Next: **Phase 04** (backtest + universe perf).
