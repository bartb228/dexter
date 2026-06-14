import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { EmbeddingProviderId, MemoryEmbeddingClient } from './types.js';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_GEMINI_MODEL = 'gemini-embedding-001';
const DEFAULT_NVIDIA_MODEL = 'baai/bge-m3';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
// NVIDIA's build platform exposes an OpenAI-compatible /embeddings endpoint. bge-m3 (1024-dim)
// is used because it needs no input_type parameter, unlike the nv-embedqa-* models.
const NVIDIA_EMBED_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_TIMEOUT_MS = 15_000;

type ResolvedProvider = Exclude<EmbeddingProviderId, 'auto' | 'none'>;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// A key counts only if it is set, non-empty, and not a `your-...` placeholder from
// env.example (mirrors checkApiKeyExists in utils/env.ts). Without this, the default
// .env's placeholder keys make `auto` resolve to a dead provider that 401s at embed time.
function hasKey(envVar: string): boolean {
  const v = process.env[envVar];
  return !!v && v.trim() !== '' && !v.trim().startsWith('your-');
}

function resolveProvider(preferred: EmbeddingProviderId): ResolvedProvider | null {
  if (preferred === 'openai' && hasKey('OPENAI_API_KEY')) {
    return 'openai';
  }
  if (preferred === 'gemini' && hasKey('GOOGLE_API_KEY')) {
    return 'gemini';
  }
  if (preferred === 'nvidia' && hasKey('NVIDIA_API_KEY')) {
    return 'nvidia';
  }
  if (preferred === 'ollama') {
    return 'ollama';
  }

  if (preferred === 'auto') {
    if (hasKey('OPENAI_API_KEY')) {
      return 'openai';
    }
    if (hasKey('GOOGLE_API_KEY')) {
      return 'gemini';
    }
    // NVIDIA before Ollama: a configured cloud key beats a maybe-running local daemon.
    if (hasKey('NVIDIA_API_KEY')) {
      return 'nvidia';
    }
    if (process.env.OLLAMA_BASE_URL) {
      return 'ollama';
    }
  }

  return null;
}

async function embedInBatches(
  texts: string[],
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await withTimeout(embedBatch(batch), EMBEDDING_TIMEOUT_MS, 'Embedding API timed out');
    vectors.push(...result);
  }
  return vectors;
}

export function createEmbeddingClient(params: {
  provider: EmbeddingProviderId;
  model?: string;
}): MemoryEmbeddingClient | null {
  const resolved = resolveProvider(params.provider);
  if (!resolved) {
    return null;
  }

  if (resolved === 'openai') {
    const model = params.model || DEFAULT_OPENAI_MODEL;
    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
      model,
    });
    return {
      provider: 'openai',
      model,
      embed: async (texts: string[]) =>
        embedInBatches(texts, async (batch) => embeddings.embedDocuments(batch)),
    };
  }

  if (resolved === 'gemini') {
    const model = params.model || DEFAULT_GEMINI_MODEL;
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GOOGLE_API_KEY,
      model,
    });
    return {
      provider: 'gemini',
      model,
      embed: async (texts: string[]) =>
        embedInBatches(texts, async (batch) => embeddings.embedDocuments(batch)),
    };
  }

  if (resolved === 'nvidia') {
    const model = params.model || DEFAULT_NVIDIA_MODEL;
    // OpenAI-compatible endpoint → reuse OpenAIEmbeddings with NVIDIA's base URL + key.
    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.NVIDIA_API_KEY,
      model,
      configuration: { baseURL: process.env.NVIDIA_BASE_URL || NVIDIA_EMBED_BASE_URL },
    });
    return {
      provider: 'nvidia',
      model,
      embed: async (texts: string[]) =>
        embedInBatches(texts, async (batch) => embeddings.embedDocuments(batch)),
    };
  }

  const model = params.model || DEFAULT_OLLAMA_MODEL;
  const embeddings = new OllamaEmbeddings({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model,
  });
  return {
    provider: 'ollama',
    model,
    embed: async (texts: string[]) =>
      embedInBatches(texts, async (batch) => embeddings.embedDocuments(batch)),
  };
}

export async function embedSingleQuery(
  client: MemoryEmbeddingClient | null,
  query: string,
): Promise<number[] | null> {
  if (!client) {
    return null;
  }
  const vectors = await withTimeout(client.embed([query]), EMBEDDING_TIMEOUT_MS, 'Embedding query timed out');
  return vectors[0] ?? null;
}
