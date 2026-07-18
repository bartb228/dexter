# Dexter — project instructions

Dexter is a LangChain multi-model agent (Anthropic / OpenAI / Gemini / Ollama) with a
WhatsApp gateway, SQLite-backed memory, cron jobs, and a suite of finance tools. Its
deterministic stock-screening tools shell out to a separate Python project.

## Build / test / typecheck

- **Test:** `bun test` (NOT jest — the `jest`/`ts-jest` devDeps are legacy; the live runner is bun).
- **Typecheck:** `bun run typecheck` (= `tsc --noEmit`). Keep it at 0 errors.
- **Run:** `bun run start` (or `bun run dev` for watch); gateway via `bun run gateway`.
- Tests are `*.test.ts` using `bun:test` (`import { describe, test, expect } from 'bun:test'`).

## Hard conventions

- **Tools never throw.** A tool's `func` must ALWAYS return `formatToolResult(...)` — never
  throw. Coerce bad/absent data to a safe shape; degrade, don't crash. (See
  `src/tools/finance/quality-screen.ts` for the canonical read-a-subprocess-file pattern:
  try/catch/finally cleanup, non-array → `[]`, missing summary → `undefined`.)
- **Deterministic screens are pinned in Python, not re-decided by the LLM.** The
  `quality_moat` gates (ROE/ROIC ≥ 15%, D/E < 0.5, …) live in the Stock-scanner engine so the
  screen is fixed and auditable. Don't reimplement or re-threshold them in TS.
- **Never hallucinate a financial metric.** The scanner / SEC EDGAR / Massive tool results are
  the source of truth. Cite only numbers present in a tool result; if a figure isn't there,
  say it's not available — do NOT fill it in from memory. (This project exists partly because an
  LLM once invented KO's Debt/Equity as 0.00; the real value is ~1.41.) When surfacing financial
  claims, prefer verifying via the `financial-data-verifier` subagent.

## The Stock scanner (external repo)

- Lives at `/Users/Ambartsum/code/Stock scanner/scanner` (Python, pytest, ~961 tests).
- `run_quality_screen` / `assess_moat` spawn it with an **args array + no shell** (tickers are
  charset-validated) — never build a shell string from user input.
- On a 0-passers screen the scanner writes a `--rejections-json` file; the tool attaches it as
  `failure_summary` (per-gate tally + sample reasons) so an empty result is self-explaining.

## Git / secrets

- **`origin` is the upstream (virattt) — NEVER push there.** Push only to the fork
  (`bartb228/dexter`). Work on a branch, never commit directly to `main`.
- **Commit/push only when explicitly asked.** End commit messages with the project's
  `Co-Authored-By` trailer.
- **`.env` holds API keys** (Finnhub / Polygon / Anthropic / …). Never edit, commit, or log its
  contents. (A PreToolUse hook blocks `.env` edits; there was a prior secret-leak incident.)

## Layout

`src/{agent,gateway,tools,cron,memory,model,controllers,components,commands,evals,utils}` —
finance tools in `src/tools/finance/`; WhatsApp gateway in `src/gateway/`.
