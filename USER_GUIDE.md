# Dexter — User Guide

A practical, hands-on guide to installing, configuring, and using **Dexter**, an
autonomous financial-research agent ("Claude Code, but for financial research").
Dexter now runs on a **free, self-hosted-friendly stack** end-to-end: NVIDIA's free
LLM platform, a free **SEC-EDGAR** data backend, free **Brave** web search, plus two
local model integrations — **Kronos** price forecasting and **ai-hedge-fund** quant
signals.

> ⚠️ **Disclaimer:** Dexter is for **educational and informational purposes only**.
> It does **not** place trades and is **not** financial advice. Outputs can be wrong
> or stale. See §13 for the full disclaimer.

---

## 1. What Dexter does

You ask a financial question in plain English. Dexter **plans** the research,
**executes** tools to gather evidence, **self-checks**, and **answers** with source
attribution. It runs as an interactive terminal app (TUI), and every run is logged to
a JSONL "scratchpad" for auditing.

**What's new (the free stack):**
- **LLM → NVIDIA** (free build platform) by default, **OpenRouter** kept as a backup.
- **Data → free SEC EDGAR** (`DATA_BACKEND=edgar`): fundamentals, prices, insider, filings — no paid key needed.
- **Web search → Brave.**
- **Forecasting → Kronos** (`kronos_predict`) and **quant signals → ai-hedge-fund** (`quant_signals`).
- **Memory embeddings → NVIDIA** (free), no extra key.

---

## 2. The complete toolset

Dexter exposes these tools to the agent (it picks them automatically; you just ask in
plain English). Tools marked **(conditional)** only appear when their key/project is present.

### Finance & markets
| Tool | What it does |
|------|--------------|
| `get_financials` | Income statement, balance sheet, cash flow, key ratios (P/E, ROE, ROA, margins, FCF…), earnings, segments. Multi-company/metric in one call. |
| `get_market_data` | Stock/crypto prices (snapshot + historical), company news, insider trades, institutional holdings, "why did X move". |
| `get_key_ratios` *(via get_financials)* | Valuation/profitability/liquidity/leverage/growth ratios, snapshot + historical. |
| `read_filings` | SEC 10-K / 10-Q / 8-K content — fetches and reads filing text. |
| `stock_screener` | Screen by criteria (P/E, growth, margins, sector). *Note: not available on the free EDGAR backend — see §5.* |

### Forecasting & signals
| Tool | What it does |
|------|--------------|
| `kronos_predict` **(conditional)** | Near-term price forecast (predicted OHLCV candles + % change + direction) from the local **Kronos** K-line foundation model. Any US-listed stock/ETF or major crypto pair. |
| `quant_signals` **(conditional)** | Deterministic scorecard from SEC fundamentals (no LLM): **Mohanram G-Score** (financial strength), **Beneish M-Score** (earnings-manipulation risk), **quality factors** (gross profitability, Rule of 40, net dilution, accruals…). Bridges to **ai-hedge-fund**. |

### Research & web
| Tool | What it does |
|------|--------------|
| `web_search` **(conditional)** | Current web info (Brave; or Exa/Perplexity/Tavily/LangSearch if keyed). |
| `x_search` **(conditional)** | X/Twitter tweets, profiles, threads for public sentiment. Needs `X_BEARER_TOKEN` (paid X API). |
| `web_fetch` | Fetch a URL and answer a prompt about its content (HTML→markdown, summarized). |
| `browser` | JavaScript-rendered pages + interactive navigation (Playwright). |

### Files, memory, scheduling, delegation
| Tool | What it does |
|------|--------------|
| `read_file` / `write_file` / `edit_file` | Read/create/edit local files (writes/edits require approval). |
| `memory_search` / `memory_get` / `memory_update` | Persistent memory of facts, preferences, and past conversations. |
| `cron` | Schedule recurring research jobs. |
| `heartbeat` | View/update the periodic heartbeat checklist (`.dexter/HEARTBEAT.md`). |
| `spawn_subagent` | Delegate focused sub-tasks to isolated sub-agents (parallelizable). |
| `edgar_refresh` **(conditional)** | Clear the cached SEC EDGAR data so the next finance call re-fetches fresh (e.g. a brand-new IPO ticker). |
| `skill` **(conditional)** | Invoke a specialized skill workflow (loaded from `.dexter/skills/*/SKILL.md`; e.g. a DCF valuation). |

> **Not a capability:** order execution / real trading. Dexter researches; it does not trade.

---

## 3. Models

Dexter defaults to **NVIDIA's free build platform**. Switch anytime in-app with `/model`.

| Role | Default | Notes |
|------|---------|-------|
| **Main model** | `nvidia:nvidia/llama-3.3-nemotron-super-49b-v1.5` (Nemotron Super 49B, reasoning) | Strong reasoning; ~3s chat / ~16s deep answers. |
| **Faster alternatives** | `nvidia:mistralai/mistral-large-3-675b-instruct-2512`, `nvidia:openai/gpt-oss-20b` | Mistral Large 3 ≈1s and tied-top quality; great if Nemotron feels slow. |
| **Backup provider** | OpenRouter (`openrouter:openrouter/pareto-code`) | Manual fallback via `/model`. |
| **Memory embeddings** | NVIDIA `baai/bge-m3` (free, 1024-dim) | Pinned in `.dexter/settings.json`. OpenAI/Gemini/Ollama also supported. |

Other providers (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, Ollama) work too —
set the matching key and pick the model with `/model`.

---

## 4. Prerequisites

- **[Bun](https://bun.com)** v1.0+ (the runtime). Verify with `bun --version`; install with `curl -fsSL https://bun.com/install | bash`.
- **One LLM key** — an **NVIDIA** key (free, https://build.nvidia.com) is the default. OpenRouter or any other provider works too.
- **`EDGAR_USER_AGENT`** — a descriptive string (e.g. `"YourApp you@email.com"`); SEC requires it for the free data backend.
- **(Recommended)** A **Polygon** and/or **Tiingo** key for reliable prices (free SEC data has no market prices).
- **(Optional)** A **Brave** key for web search; an **X** bearer token for sentiment; **Kronos** and **ai-hedge-fund** projects for forecasting/quant tools.

---

## 5. Data backends (free vs paid)

Set `DATA_BACKEND=edgar` to use the **free SEC EDGAR** backend (recommended). What works on it:

| Capability | Free EDGAR backend |
|------------|--------------------|
| Financial statements + key ratios | ✅ from SEC companyfacts |
| Prices (historical + snapshot) | ✅ via your Polygon/Tiingo key |
| Insider trades | ✅ SEC Form 4 |
| Filings (10-K/10-Q/8-K text) | ✅ SEC EDGAR |
| News | via **Brave** `web_search` (SEC has no news feed) |
| Market-wide screening (`stock_screener`) | ❌ not feasible on free data — use per-ticker tools, or set a Financial Datasets key |

**Freshness:** filings, insider, and prices are always **live**; fundamentals are cached
~24h. Every EDGAR result is **stamped** with its freshness (e.g. "companyfacts cached 3h
ago"). A brand-new ticker (recent IPO) resolves automatically (refresh-on-miss), and you
can force a refresh anytime by asking Dexter to run **`edgar_refresh`**.

Without `DATA_BACKEND=edgar`, Dexter falls back to the paid **Financial Datasets** API
(needs `FINANCIAL_DATASETS_API_KEY`).

---

## 6. Install

```bash
bun install
```
> `postinstall` downloads a Chromium build via Playwright (powers `browser`). Skip with
> `bun install --ignore-scripts` if you don't need browsing.

---

## 7. Configure (`.env`)

```bash
cp env.example .env
```

**Minimum for the free stack:**
```env
NVIDIA_API_KEY=nvapi-...                       # the LLM (free at build.nvidia.com)
DATA_BACKEND=edgar                             # free SEC data
EDGAR_USER_AGENT=YourApp you@email.com         # required by SEC
POLYGON_API_KEY=...                            # prices (or TIINGO_API_KEY)
TIINGO_API_KEY=...
```

**Recommended add-ons:**
```env
BRAVE_SEARCH_API_KEY=BSA-...                   # web search (news/sentiment)
OPENROUTER_API_KEY=sk-or-...                   # backup LLM provider

# LangSmith tracing (see §11) — set the key AND flip tracing on:
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=dexter
LANGSMITH_ENDPOINT=https://api.smith.langchain.com

# Local model integrations (enable kronos_predict / quant_signals)
KRONOS_DIR=/path/to/Kronos                     # defaults to ../Kronos-style absolute path
AHF_DIR=/path/to/ai-hedge-fund

# Optional
X_BEARER_TOKEN=...                             # x_search (paid X API)
OLLAMA_BASE_URL=http://127.0.0.1:11434         # local models / embeddings
OPENAI_API_KEY=...  GOOGLE_API_KEY=...         # alt LLMs + alt embeddings
FINANCIAL_DATASETS_API_KEY=...                 # only if NOT using DATA_BACKEND=edgar
```

`.env` is gitignored — your keys never get committed.

---

## 8. Run it

```bash
bun start        # interactive TUI
bun dev          # auto-restart on file changes
```

Type a question; watch it plan → run tools → self-check → answer.

### Good questions by capability
```
# Fundamentals (EDGAR)
What were Apple's revenue and net income over the last 4 fiscal years?
Compare gross margins of NVDA, AMD, and INTC.

# Quant signals (ai-hedge-fund)
What's NVDA's quant scorecard — G-score, M-score, and quality?
Does AAPL show any earnings-manipulation flags (Beneish M-score)?

# Forecasting (Kronos)
Use Kronos to forecast NVDA's near-term price direction.
What does Kronos predict for TSLA over the next 12 bars?

# Prices / insider / filings
Why did Tesla move last week? Any recent insider sales at AAPL?
Summarize the risk factors in Microsoft's latest 10-K.

# Web / sentiment
What's the latest news on the SPCX (SpaceX) IPO?
What is X/Twitter sentiment on NVDA right now?
```

### Tips
- One focused question at a time; name the time frame ("last 5 years", "YTD").
- Ask it to cite — it returns source URLs and freshness stamps.
- Quant signals and Kronos are **statistical/computed** outputs, **not advice**.

### Switching models / search providers
Use `/model` and `/search` in-app, or set the relevant key in `.env`.

---

## 9. The local integrations (Kronos & ai-hedge-fund)

These two tools bridge to **separate local Python projects** via a subprocess (no
reimplementation). They auto-register only when the project is present.

- **`kronos_predict`** → the **Kronos** K-line foundation model. Forecasts future OHLCV
  candles. Needs the Kronos project at `KRONOS_DIR` (PyTorch + cached weights). ~10–30s
  per call (model load + sampling). Works for any US-listed ticker (auto-fetched).
- **`quant_signals`** → **ai-hedge-fund**'s pure-compute analysts (Mohanram G-Score,
  Beneish M-Score, quality factors). Needs the ai-hedge-fund project at `AHF_DIR`. Fast
  (no LLM); values match ai-hedge-fund's own pipeline.

If a project isn't present, the corresponding tool simply doesn't appear — everything
else keeps working.

---

## 10. Debugging & auditing runs (the scratchpad)

Every query writes a JSONL log at `.dexter/scratchpad/<timestamp>_<id>.jsonl`. Each line
is an event (`init`, `thinking`, `tool_result` with **args, raw result, and summary**).
This is the best way to answer "where did that number come from?" — open the latest file
and read the `tool_result` entries (they include source URLs and freshness stamps).

---

## 11. LangSmith tracing (optional)

Dexter's LLM calls auto-trace to **LangSmith** when the env is set — no code changes
needed. To enable:
1. Get a key at https://smith.langchain.com.
2. In `.env`: `LANGSMITH_API_KEY=lsv2_...`, `LANGSMITH_TRACING=true`, `LANGSMITH_PROJECT=dexter`.
3. Restart Dexter — runs appear in your LangSmith project (full plan/tool/LLM traces).

The eval suite (§12) also uses LangSmith.

---

## 12. Other commands

```bash
bun run gateway:login   # link WhatsApp (scan QR), then `bun run gateway`
bun run src/evals/run.ts [--sample N]   # eval suite (LLM-judge, LangSmith-tracked)
bun test                # test suite
bun run typecheck       # tsc --noEmit
```

WhatsApp gateway: answers questions sent to yourself in WhatsApp (unofficial Web
automation — use at your own risk).

---

## 13. Cost, safety & disclaimer

- **Mostly free now:** NVIDIA LLM (free tier), SEC EDGAR data (free), Brave/Polygon/Tiingo
  free tiers. The only metered surfaces are X search (paid), optional Financial Datasets,
  and LLM rate limits. Kronos/quant_signals run locally (compute only).
- **Latency:** Kronos ~10–30s; the full ai-hedge-fund pipeline (if you run it directly)
  makes many LLM calls. `quant_signals` is fast (no LLM).
- **Guardrails:** loop detection + step limits prevent runaway execution.
- **Verify before acting.** Outputs may be wrong or stale — check the cited sources and
  freshness stamps. **Dexter does not trade.**

> This project is for **educational, entertainment, and informational purposes only**.
> Not for real trading or investment. Not financial, investment, tax, or legal advice.
> No guarantees of accuracy or fitness. Consult a licensed advisor before investing.
> Past performance does not indicate future results.

Licensed under the **MIT License**.
