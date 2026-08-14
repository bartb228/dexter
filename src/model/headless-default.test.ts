import { describe, test, expect } from 'bun:test';
import {
  resolveHeadlessDefault,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  FALLBACK_PROVIDER,
  FALLBACK_MODEL,
} from './llm.js';

// The headless (WhatsApp gateway / cron) default when no model setting is persisted:
// NVIDIA Nemotron when keyed, gpt-5.5 otherwise — never a provider it can't authenticate.
// The key-check is injected so both branches are deterministic regardless of ambient
// .env state (the real predicate reads process.env AND the .env file on disk).
describe('resolveHeadlessDefault', () => {
  test('defaults to NVIDIA Nemotron when an NVIDIA key is present', () => {
    const seen: string[] = [];
    const result = resolveHeadlessDefault((id) => {
      seen.push(id);
      return true;
    });
    expect(result).toEqual({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
    expect(seen).toEqual([DEFAULT_PROVIDER]); // it checks the NVIDIA provider, nothing else
    expect(DEFAULT_PROVIDER).toBe('nvidia');
    expect(DEFAULT_MODEL).toContain('nemotron');
  });

  test('falls back to gpt-5.5 / openai when the NVIDIA key is absent', () => {
    const result = resolveHeadlessDefault(() => false);
    expect(result).toEqual({ provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL });
    expect(FALLBACK_PROVIDER).toBe('openai');
    expect(FALLBACK_MODEL).toBe('gpt-5.5');
  });

  test('the default predicate reflects the real environment without throwing', () => {
    // Whatever the ambient key state, the no-arg call returns one of the two valid pairs.
    const result = resolveHeadlessDefault();
    expect([
      JSON.stringify({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }),
      JSON.stringify({ provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL }),
    ]).toContain(JSON.stringify(result));
  });
});
