import { describe, test, expect } from 'bun:test';
import {
  SUBAGENT_TYPES,
  SUBAGENT_TYPE_NAMES,
  SUBAGENT_DISALLOWED_TOOLS,
  DEFAULT_SUBAGENT_TYPE,
  resolveSubagentTools,
} from './types.js';

// Tools that must never reach any subagent — they mutate state or side-effect,
// and subagents run in parallel with no approval plumbing.
const MUTATING_TOOLS = ['write_file', 'edit_file', 'memory_update', 'cron', 'heartbeat', 'spawn_subagent'];

describe('financial-data-verifier subagent type', () => {
  test('is registered and reachable via the tool enum', () => {
    expect(SUBAGENT_TYPES['financial-data-verifier']).toBeDefined();
    expect(SUBAGENT_TYPE_NAMES).toContain('financial-data-verifier');
  });

  test('is allow-listed to authoritative data tools only — no web/x search, no memory', () => {
    const tools = resolveSubagentTools('financial-data-verifier');
    // must be able to independently re-fetch a figure from the source-of-truth vendors
    expect(tools).toContain('get_financials');
    expect(tools).toContain('get_market_data');
    expect(tools).toContain('read_filings');
    // and the specialised authoritative sources (guards against a silent drop of either)
    expect(tools).toContain('get_options_chain');
    expect(tools).toContain('run_quality_screen');
    // must NOT verify against the open web, X, or a previously-remembered value
    expect(tools).not.toContain('web_search');
    expect(tools).not.toContain('x_search');
    expect(tools).not.toContain('memory_search');
    expect(tools).not.toContain('memory_get');
  });

  test('receives no mutating/side-effecting tools', () => {
    const tools = resolveSubagentTools('financial-data-verifier');
    for (const banned of MUTATING_TOOLS) {
      expect(tools).not.toContain(banned);
    }
  });

  test('its system prompt instructs verify-don\'t-invent with an explicit verdict set', () => {
    const p = SUBAGENT_TYPES['financial-data-verifier'].systemPrompt;
    expect(p).toContain('VERIFIED');
    expect(p).toContain('MISMATCH');
    expect(p).toContain('UNAVAILABLE');
    expect(p.toLowerCase()).toContain('never');
  });
});

describe('subagent type registry invariants (hold for every type)', () => {
  test('no type can spawn a subagent (delegation stays one level deep)', () => {
    for (const key of SUBAGENT_TYPE_NAMES) {
      expect(resolveSubagentTools(key)).not.toContain('spawn_subagent');
    }
    expect(SUBAGENT_DISALLOWED_TOOLS.has('spawn_subagent')).toBe(true);
  });

  test('every type has a non-empty tool allow-list, prompt, and iteration budget', () => {
    for (const key of SUBAGENT_TYPE_NAMES) {
      const cfg = SUBAGENT_TYPES[key];
      expect(cfg.tools.length).toBeGreaterThan(0);
      expect(cfg.systemPrompt.length).toBeGreaterThan(0);
      expect(cfg.whenToUse.length).toBeGreaterThan(0);
      expect(cfg.maxIterations).toBeGreaterThan(0);
    }
  });

  test('an unknown type falls back to the default (never throws)', () => {
    expect(resolveSubagentTools('no-such-type')).toEqual(resolveSubagentTools(DEFAULT_SUBAGENT_TYPE));
  });
});
