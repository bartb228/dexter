import { describe, test, expect } from 'bun:test';
import { THINKING_VERBS, getRandomThinkingVerb } from './thinking-verbs.js';

describe('THINKING_VERBS', () => {
  test('is a non-empty list of non-empty strings', () => {
    expect(THINKING_VERBS.length).toBeGreaterThan(0);
    for (const verb of THINKING_VERBS) {
      expect(typeof verb).toBe('string');
      expect(verb.length).toBeGreaterThan(0);
    }
  });
});

describe('getRandomThinkingVerb', () => {
  test('always returns a member of THINKING_VERBS', () => {
    const set = new Set<string>(THINKING_VERBS);
    for (let i = 0; i < 200; i++) {
      expect(set.has(getRandomThinkingVerb())).toBe(true);
    }
  });
});
