import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  toRow,
  buildIvSummary,
  optionsAvailable,
  cboeEnabled,
  parseOccSymbol,
  cboeRowFromContract,
  getOptionsChain,
  type PolyContract,
  type OptionRow,
} from './options.js';

// ---------------------------------------------------------------------------
// toRow — Polygon snapshot contract → normalised row
// ---------------------------------------------------------------------------

const fullContract: PolyContract = {
  details: { contract_type: 'call', expiration_date: '2026-07-17', strike_price: 275, ticker: 'O:AAPL260717C00275000' },
  greeks: { delta: 0.554, gamma: 0.0232, theta: -0.1715, vega: 0.2653 },
  implied_volatility: 0.25557,
  open_interest: 1234,
  day: { volume: 56, close: 8.4 },
};

describe('toRow', () => {
  test('maps a complete contract and rounds IV/greeks', () => {
    const row = toRow(fullContract);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      expiration: '2026-07-17',
      type: 'call',
      strike: 275,
      iv: 0.2556, // rounded to 4dp
      delta: 0.554,
      vega: 0.2653,
      open_interest: 1234,
      volume: 56,
      last: 8.4,
    });
  });

  test('represents missing IV/greeks/oi/volume as null (not 0 or undefined)', () => {
    const row = toRow({ details: { contract_type: 'put', expiration_date: '2026-07-17', strike_price: 270 } });
    expect(row).toMatchObject({ type: 'put', strike: 270, iv: null, delta: null, open_interest: null, volume: null, last: null });
  });

  test('drops rows lacking a usable expiration / strike / type', () => {
    expect(toRow({ details: { contract_type: 'call', strike_price: 275 } })).toBeNull(); // no expiration
    expect(toRow({ details: { contract_type: 'call', expiration_date: '2026-07-17' } })).toBeNull(); // no strike
    expect(toRow({ details: { contract_type: 'future', expiration_date: '2026-07-17', strike_price: 275 } })).toBeNull(); // bad type
  });
});

// ---------------------------------------------------------------------------
// buildIvSummary — ATM IV term structure
// ---------------------------------------------------------------------------

function row(partial: Partial<OptionRow> & Pick<OptionRow, 'expiration' | 'type' | 'strike'>): OptionRow {
  return { iv: null, delta: null, gamma: null, theta: null, vega: null, open_interest: null, volume: null, last: null, dte: 30, ...partial };
}

describe('buildIvSummary', () => {
  test('picks the strike nearest spot as ATM and pairs call/put IV', () => {
    const spot = 276;
    const rows: OptionRow[] = [
      row({ expiration: '2026-07-17', type: 'call', strike: 270, iv: 0.30, dte: 22 }),
      row({ expiration: '2026-07-17', type: 'call', strike: 275, iv: 0.25, dte: 22 }), // nearest to 276
      row({ expiration: '2026-07-17', type: 'put', strike: 275, iv: 0.27, dte: 22 }),
      row({ expiration: '2026-07-17', type: 'call', strike: 290, iv: 0.22, dte: 22 }),
    ];
    const summary = buildIvSummary(rows, spot);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ expiration: '2026-07-17', atm_strike: 275, atm_call_iv: 0.25, atm_put_iv: 0.27 });
  });

  test('orders expirations by days-to-expiry (term structure)', () => {
    const rows: OptionRow[] = [
      row({ expiration: '2026-09-18', type: 'call', strike: 275, iv: 0.28, dte: 85 }),
      row({ expiration: '2026-07-17', type: 'call', strike: 275, iv: 0.25, dte: 22 }),
    ];
    const summary = buildIvSummary(rows, 275);
    expect(summary.map((s) => s.expiration)).toEqual(['2026-07-17', '2026-09-18']);
  });

  test('returns an empty term structure when spot is unknown', () => {
    expect(buildIvSummary([row({ expiration: '2026-07-17', type: 'call', strike: 275, iv: 0.25 })], null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOccSymbol — OCC option symbol → { expiration, type, strike }
// ---------------------------------------------------------------------------

describe('parseOccSymbol', () => {
  test('parses an equity call (root varies in length; parsed from the right)', () => {
    expect(parseOccSymbol('AAPL260803C00205000')).toEqual({ expiration: '2026-08-03', type: 'call', strike: 205 });
  });

  test('parses a put and a fractional strike', () => {
    expect(parseOccSymbol('SPY260919P00450500')).toEqual({ expiration: '2026-09-19', type: 'put', strike: 450.5 });
  });

  test('handles long roots (weeklies / index) and large strikes', () => {
    expect(parseOccSymbol('SPXW260320C05000000')).toEqual({ expiration: '2026-03-20', type: 'call', strike: 5000 });
  });

  test('rejects malformed symbols', () => {
    expect(parseOccSymbol('AAPL260803X00205000')).toBeNull(); // bad call/put letter
    expect(parseOccSymbol('AAPL2608C00205000')).toBeNull(); // date too short
    expect(parseOccSymbol('AAPL260899C00205000')).toBeNull(); // impossible month
    expect(parseOccSymbol('AAPL260803C0020500X')).toBeNull(); // non-numeric strike
    expect(parseOccSymbol('SHORT')).toBeNull();
    expect(parseOccSymbol('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cboeRowFromContract — CBOE delayed-quote contract → normalised row
// ---------------------------------------------------------------------------

describe('cboeRowFromContract', () => {
  test('maps a full contract; IV stays a decimal fraction (not percent)', () => {
    const row = cboeRowFromContract({
      option: 'AAPL260803C00307500',
      iv: 0.297,
      delta: 0.5706,
      gamma: 0.0231,
      theta: -0.5907,
      vega: 0.301,
      open_interest: 129,
      volume: 12,
      last_trade_price: 5.4,
    });
    expect(row).toMatchObject({
      expiration: '2026-08-03',
      type: 'call',
      strike: 307.5,
      iv: 0.297,
      delta: 0.5706,
      vega: 0.301,
      open_interest: 129,
      volume: 12,
      last: 5.4,
    });
  });

  test('represents missing IV/greeks/oi/volume as null, and a zero last trade as null', () => {
    const row = cboeRowFromContract({ option: 'AAPL260803P00300000', last_trade_price: 0 });
    expect(row).toMatchObject({
      type: 'put',
      strike: 300,
      iv: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      open_interest: null,
      volume: null,
      last: null, // 0.0 = no trade today → null, not 0
    });
  });

  test('drops a contract with a missing or unparseable OCC symbol', () => {
    expect(cboeRowFromContract({ iv: 0.3 })).toBeNull();
    expect(cboeRowFromContract({ option: 'NOT-AN-OCC-SYMBOL', iv: 0.3 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gating — optionsAvailable / cboeEnabled
// ---------------------------------------------------------------------------

describe('optionsAvailable / cboeEnabled', () => {
  const origKey = process.env.POLYGON_API_KEY;
  const origCboe = process.env.OPTIONS_CBOE_FALLBACK;
  const setEnv = (name: string, val: string | undefined) => {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  };
  const restore = () => {
    setEnv('POLYGON_API_KEY', origKey);
    setEnv('OPTIONS_CBOE_FALLBACK', origCboe);
  };

  test('cboeEnabled defaults on and is disabled only by explicit off-values', () => {
    delete process.env.OPTIONS_CBOE_FALLBACK;
    expect(cboeEnabled()).toBe(true);
    for (const off of ['false', '0', 'off', 'no', 'FALSE', 'Off']) {
      process.env.OPTIONS_CBOE_FALLBACK = off;
      expect(cboeEnabled()).toBe(false);
    }
    process.env.OPTIONS_CBOE_FALLBACK = 'true';
    expect(cboeEnabled()).toBe(true);
    restore();
  });

  test('options are available without any key when the free CBOE fallback is on', () => {
    delete process.env.POLYGON_API_KEY;
    delete process.env.OPTIONS_CBOE_FALLBACK;
    expect(optionsAvailable()).toBe(true);
    process.env.POLYGON_API_KEY = 'your-polygon-api-key'; // placeholder still has CBOE
    expect(optionsAvailable()).toBe(true);
    restore();
  });

  test('with the CBOE fallback disabled, availability requires a real key', () => {
    process.env.OPTIONS_CBOE_FALLBACK = 'false';
    delete process.env.POLYGON_API_KEY;
    expect(optionsAvailable()).toBe(false);
    process.env.POLYGON_API_KEY = 'your-polygon-api-key';
    expect(optionsAvailable()).toBe(false);
    process.env.POLYGON_API_KEY = 'abc123realkey';
    expect(optionsAvailable()).toBe(true);
    restore();
  });
});

// ---------------------------------------------------------------------------
// get_options_chain — fallback orchestration (fetch-mocked, no network)
// Drives the actual tool through every Polygon⇄CBOE branch and asserts which
// provider answered and which endpoints were (not) called.
// ---------------------------------------------------------------------------

describe('get_options_chain orchestration', () => {
  const origFetch = global.fetch;
  const origKey = process.env.POLYGON_API_KEY;
  const origCboe = process.env.OPTIONS_CBOE_FALLBACK;
  let calls: string[] = [];

  const resp = (data: unknown, ok = true, status = 200): Response =>
    ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => data }) as unknown as Response;

  const polyContracts: PolyContract[] = [
    { details: { contract_type: 'call', expiration_date: '2026-08-03', strike_price: 100, ticker: 'O:X260803C00100000' }, greeks: { delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2 }, implied_volatility: 0.31, open_interest: 11, day: { volume: 7, close: 2.5 } },
    { details: { contract_type: 'put', expiration_date: '2026-08-03', strike_price: 100, ticker: 'O:X260803P00100000' }, greeks: { delta: -0.5, gamma: 0.02, theta: -0.1, vega: 0.2 }, implied_volatility: 0.33, open_interest: 9, day: { volume: 4, close: 2.1 } },
  ];
  const cboeJson = {
    data: {
      current_price: 100,
      options: [
        { option: 'X260803C00100000', iv: 0.29, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2, open_interest: 11, volume: 7, last_trade_price: 2.5 },
        { option: 'X260803P00100000', iv: 0.30, delta: -0.5, gamma: 0.02, theta: -0.1, vega: 0.2, open_interest: 9, volume: 4, last_trade_price: 2.1 },
      ],
    },
  };

  // Route by host; `polygon` controls the chain-snapshot outcome.
  function installFetch(polygon: 'ok' | 'empty' | '403') {
    global.fetch = (async (url: string | URL): Promise<Response> => {
      const u = String(url);
      calls.push(u);
      if (u.includes('polygon.io')) {
        if (u.includes('/prev')) return resp({ results: [{ c: 100 }] }); // spot
        if (polygon === '403') return resp({}, false, 403);
        if (polygon === 'empty') return resp({ results: [] });
        return resp({ results: polyContracts });
      }
      if (u.includes('cboe.com')) return resp(cboeJson);
      return resp({}, false, 404);
    }) as typeof global.fetch;
  }

  const setEnv = (name: string, val: string | undefined) => {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  };
  const run = async (input: Record<string, unknown>) =>
    JSON.parse(await (getOptionsChain as unknown as { invoke: (i: unknown) => Promise<string> }).invoke(input)).data;
  const hit = (host: string) => calls.some((u) => u.includes(host));

  beforeEach(() => { calls = []; });
  afterEach(() => {
    global.fetch = origFetch;
    setEnv('POLYGON_API_KEY', origKey);
    setEnv('OPTIONS_CBOE_FALLBACK', origCboe);
  });

  test('no key + CBOE enabled → serves CBOE, never touches Polygon', async () => {
    delete process.env.POLYGON_API_KEY;
    delete process.env.OPTIONS_CBOE_FALLBACK;
    installFetch('ok');
    const res = await run({ ticker: 'X' });
    expect(res.source).toContain('CBOE');
    expect(res.iv_summary[0]).toMatchObject({ atm_strike: 100, atm_call_iv: 0.29 });
    expect(hit('cboe.com')).toBe(true);
    expect(hit('polygon.io')).toBe(false);
  });

  test('no key + CBOE disabled → guidance error, no network call at all', async () => {
    delete process.env.POLYGON_API_KEY;
    process.env.OPTIONS_CBOE_FALLBACK = 'false';
    installFetch('ok');
    const res = await run({ ticker: 'X' });
    expect(typeof res.error).toBe('string');
    expect(res.source).toBeUndefined();
    // No provider network call at all (ignore unrelated LangSmith tracing fetches).
    expect(hit('polygon.io')).toBe(false);
    expect(hit('cboe.com')).toBe(false);
  });

  test('key present + Polygon succeeds → serves Polygon, never calls CBOE', async () => {
    process.env.POLYGON_API_KEY = 'realpolykey';
    delete process.env.OPTIONS_CBOE_FALLBACK;
    installFetch('ok');
    const res = await run({ ticker: 'X' });
    expect(res.source).toContain('Polygon');
    expect(hit('polygon.io')).toBe(true);
    expect(hit('cboe.com')).toBe(false);
  });

  test('key present + Polygon 403 + CBOE enabled → falls through to CBOE', async () => {
    process.env.POLYGON_API_KEY = 'realpolykey';
    delete process.env.OPTIONS_CBOE_FALLBACK;
    installFetch('403');
    const res = await run({ ticker: 'X' });
    expect(res.source).toContain('CBOE');
    expect(hit('polygon.io')).toBe(true); // Polygon was attempted…
    expect(hit('cboe.com')).toBe(true); // …then CBOE served
  });

  test('key present + Polygon 403 + CBOE disabled → returns Polygon error, no CBOE', async () => {
    process.env.POLYGON_API_KEY = 'realpolykey';
    process.env.OPTIONS_CBOE_FALLBACK = 'off';
    installFetch('403');
    const res = await run({ ticker: 'X' });
    expect(typeof res.error).toBe('string');
    expect(res.source).toBeUndefined();
    expect(hit('cboe.com')).toBe(false);
  });

  test('Polygon succeeds but empty → its own message, does NOT fall through to CBOE', async () => {
    process.env.POLYGON_API_KEY = 'realpolykey';
    delete process.env.OPTIONS_CBOE_FALLBACK;
    installFetch('empty');
    const res = await run({ ticker: 'X' });
    expect(res.error).toContain('No options found');
    expect(hit('cboe.com')).toBe(false); // a successful-but-empty vendor answer is final
  });
});
