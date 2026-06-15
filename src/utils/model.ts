import { PROVIDERS as PROVIDER_DEFS } from '@/providers';

export interface Model {
  id: string;
  displayName: string;
}

interface Provider {
  displayName: string;
  providerId: string;
  models: Model[];
}

const PROVIDER_MODELS: Record<string, Model[]> = {
  openai: [
    { id: 'gpt-5.5', displayName: 'GPT 5.5' },
    { id: 'gpt-5.4', displayName: 'GPT 5.4' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    { id: 'claude-fable-5', displayName: 'Fable 5' },
  ],
  google: [
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro' },
  ],
  xai: [
    { id: 'grok-4-0709', displayName: 'Grok 4' },
    { id: 'grok-4-1-fast-reasoning', displayName: 'Grok 4.1 Fast Reasoning' },
  ],
  moonshot: [{ id: 'kimi-k2-5', displayName: 'Kimi K2.5' }],
  deepseek: [
    { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
  ],
  // NVIDIA build platform — all free tier. IDs carry the 'nvidia:' routing prefix
  // (stripped in the model factory before the API call). Order = sweep ranking
  // (2026-06-14): best main first, then alternatives, fast model, baseline, flagship.
  nvidia: [
    { id: 'nvidia:nvidia/llama-3.3-nemotron-super-49b-v1.5', displayName: 'Nemotron Super 49B (free, reasoning)' },
    { id: 'nvidia:nvidia/nemotron-3-super-120b-a12b', displayName: 'Nemotron Super 120B (free, reasoning, slow)' },
    { id: 'nvidia:mistralai/mistral-large-3-675b-instruct-2512', displayName: 'Mistral Large 3 (free, fast)' },
    { id: 'nvidia:qwen/qwen3.5-122b-a10b', displayName: 'Qwen 3.5 122B (free)' },
    { id: 'nvidia:z-ai/glm-5.1', displayName: 'GLM 5.1 (free)' },
    { id: 'nvidia:openai/gpt-oss-120b', displayName: 'GPT-OSS 120B (free)' },
    { id: 'nvidia:openai/gpt-oss-20b', displayName: 'GPT-OSS 20B (free, fast)' },
    { id: 'nvidia:meta/llama-3.3-70b-instruct', displayName: 'Llama 3.3 70B (free)' },
    { id: 'nvidia:nvidia/nemotron-3-ultra-550b-a55b', displayName: 'Nemotron-3 Ultra 550B (free, slow)' },
  ],
};

export const PROVIDERS: Provider[] = PROVIDER_DEFS.map((provider) => ({
  displayName: provider.displayName,
  providerId: provider.id,
  models: PROVIDER_MODELS[provider.id] ?? [],
}));

export function getModelsForProvider(providerId: string): Model[] {
  const provider = PROVIDERS.find((entry) => entry.providerId === providerId);
  return provider?.models ?? [];
}

export function getModelIdsForProvider(providerId: string): string[] {
  return getModelsForProvider(providerId).map((model) => model.id);
}

export function getDefaultModelForProvider(providerId: string): string | undefined {
  const models = getModelsForProvider(providerId);
  return models[0]?.id;
}

export function getModelDisplayName(modelId: string): string {
  const normalizedId = modelId.replace(/^(ollama|openrouter|nvidia):/, '');

  for (const provider of PROVIDERS) {
    const model = provider.models.find((entry) => entry.id === normalizedId || entry.id === modelId);
    if (model) {
      return model.displayName;
    }
  }

  return normalizedId;
}
