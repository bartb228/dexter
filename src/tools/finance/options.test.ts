import { describe, test, expect } from 'bun:test';
import { toRow, buildIvSummary, optionsAvailable, type PolyContract, type OptionRow } from './options.js';

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
// optionsAvailable — gating
// ---------------------------------------------------------------------------

describe('optionsAvailable', () => {
  const original = process.env.POLYGON_API_KEY;
  const restore = () => { if (original === undefined) delete process.env.POLYGON_API_KEY; else process.env.POLYGON_API_KEY = original; };

  test('false for a missing or placeholder key', () => {
    delete process.env.POLYGON_API_KEY;
    expect(optionsAvailable()).toBe(false);
    process.env.POLYGON_API_KEY = 'your-polygon-api-key';
    expect(optionsAvailable()).toBe(false);
    restore();
  });

  test('true for a real key', () => {
    process.env.POLYGON_API_KEY = 'abc123realkey';
    expect(optionsAvailable()).toBe(true);
    restore();
  });
});
