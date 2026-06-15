import { describe, test, expect } from 'bun:test';
import {
  PROVIDERS,
  getModelsForProvider,
  getModelIdsForProvider,
  getDefaultModelForProvider,
  getModelDisplayName,
} from './model.js';

// Pick a provider that actually has models, so assertions don't depend on the
// exact PROVIDER_DEFS contents (which can change as providers are added).
const populated = PROVIDERS.find((p) => p.models.length > 0);

describe('provider/model lookups', () => {
  test('getModelIdsForProvider matches the provider\'s model ids', () => {
    expect(populated).toBeDefined();
    const ids = getModelsForProvider(populated!.providerId).map((m) => m.id);
    expect(getModelIdsForProvider(populated!.providerId)).toEqual(ids);
  });

  test('getDefaultModelForProvider returns the first model id', () => {
    expect(getDefaultModelForProvider(populated!.providerId)).toBe(populated!.models[0].id);
  });

  test('getModelDisplayName resolves a known model id to its display name', () => {
    const first = populated!.models[0];
    expect(getModelDisplayName(first.id)).toBe(first.displayName);
  });
});

describe('unknown / edge inputs', () => {
  test('unknown provider yields empty list and undefined default', () => {
    expect(getModelsForProvider('does-not-exist')).toEqual([]);
    expect(getModelIdsForProvider('does-not-exist')).toEqual([]);
    expect(getDefaultModelForProvider('does-not-exist')).toBeUndefined();
  });

  test('getModelDisplayName echoes an unknown id back (prefix stripped)', () => {
    expect(getModelDisplayName('ollama:some-unknown-model')).toBe('some-unknown-model');
    expect(getModelDisplayName('totally-unknown')).toBe('totally-unknown');
  });
});
