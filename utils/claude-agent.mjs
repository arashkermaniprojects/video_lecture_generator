/**
 * LLM wrapper for the lecture pipeline.
 *
 * Routes all text and vision calls through an OpenAI-compatible API.
 * Backend selection is controlled by the LECTURE_LLM_BACKEND env var:
 *
 *   api    (default) — text + vision via api.openai.com  (gpt-4.1)
 *   local             — text + vision via local vLLM     (Qwen2.5)
 *   hybrid            — text local, vision via API
 *
 * Switch with no code changes:
 *   LECTURE_LLM_BACKEND=local node pipeline.mjs ...
 *
 * Local model defaults can be overridden:
 *   LOCAL_LLM_BASE_URL_TEXT    (default http://127.0.0.1:8000/v1)
 *   LOCAL_LLM_BASE_URL_VISION  (default http://127.0.0.1:8001/v1)
 *   LOCAL_TEXT_MODEL           (default Qwen/Qwen2.5-32B-Instruct-AWQ)
 *   LOCAL_VISION_MODEL         (default Qwen/Qwen2.5-VL-7B-Instruct)
 */

import OpenAI from 'openai';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const DEFAULT_VISION_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';

const LOCAL_TEXT_MODEL = process.env.LOCAL_TEXT_MODEL || 'Qwen/Qwen2.5-14B-Instruct-AWQ';
const LOCAL_VISION_MODEL = process.env.LOCAL_VISION_MODEL || 'Qwen/Qwen2.5-VL-7B-Instruct-AWQ';
const LOCAL_BASE_URL_TEXT = process.env.LOCAL_LLM_BASE_URL_TEXT || 'http://127.0.0.1:8000/v1';
const LOCAL_BASE_URL_VISION = process.env.LOCAL_LLM_BASE_URL_VISION || 'http://127.0.0.1:8001/v1';

function getBackend() {
  const raw = (process.env.LECTURE_LLM_BACKEND || 'api').toLowerCase().trim();
  if (raw !== 'api' && raw !== 'local' && raw !== 'hybrid') {
    console.warn(`[llm] Unknown LECTURE_LLM_BACKEND="${raw}", falling back to "api"`);
    return 'api';
  }
  return raw;
}

function isLocalKind(kind) {
  const backend = getBackend();
  if (backend === 'local') return true;
  if (backend === 'hybrid' && kind === 'text') return true;
  return false;
}

function loadDotEnvIfNeeded() {
  if (process.env.OPENAI_API_KEY) return;

  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // Best effort only.
  }
}

// Cache clients so we don't recreate them on every call.
const _clientCache = new Map();
function getClient(kind = 'text') {
  loadDotEnvIfNeeded();
  const local = isLocalKind(kind);
  const cacheKey = local ? `local:${kind}` : 'api';
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  let client;
  if (local) {
    // vLLM ignores the API key but the OpenAI SDK requires a non-empty string.
    const baseURL = kind === 'vision' ? LOCAL_BASE_URL_VISION : LOCAL_BASE_URL_TEXT;
    client = new OpenAI({ apiKey: 'local-vllm', baseURL });
  } else {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set (and LECTURE_LLM_BACKEND is not "local")');
    }
    client = new OpenAI({ apiKey });
  }
  _clientCache.set(cacheKey, client);
  return client;
}

function normalizeModel(requestedModel, { vision = false } = {}) {
  // When the local backend is active, IGNORE whatever model the agent
  // requested (e.g. "claude-sonnet-4", "gpt-4.1") and use the local model.
  // The agent's model preference is meaningless to vLLM.
  if (isLocalKind(vision ? 'vision' : 'text')) {
    return vision ? LOCAL_VISION_MODEL : LOCAL_TEXT_MODEL;
  }

  if (!requestedModel) return vision ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL;

  const lower = requestedModel.toLowerCase();
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return requestedModel;
  }

  // Legacy Anthropic model names are mapped to OpenAI defaults.
  return vision ? DEFAULT_VISION_MODEL : DEFAULT_TEXT_MODEL;
}

/**
 * Describe the backend and models that calls will actually be routed to.
 * Recorded in each run's state.json so every lecture has model provenance.
 */
export function describeLLMConfig() {
  return {
    backend: getBackend(),
    textModel: normalizeModel(null),
    visionModel: normalizeModel(null, { vision: true }),
    textEndpoint: isLocalKind('text') ? LOCAL_BASE_URL_TEXT : 'https://api.openai.com/v1',
    visionEndpoint: isLocalKind('vision') ? LOCAL_BASE_URL_VISION : 'https://api.openai.com/v1',
  };
}

function extractText(response) {
  return response.choices?.[0]?.message?.content?.trim() || '';
}

function getMimeType(imagePath) {
  const lower = imagePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Run a text prompt through the OpenAI API.
 */
export async function runAgent({
  systemPrompt,
  userMessage,
  tools = [],
  model = DEFAULT_TEXT_MODEL,
  maxTokens = 4096,
}) {
  void tools;

  const client = getClient('text');
  const resolvedModel = normalizeModel(model);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });

  // PERMANENT FIX (2026-04-10): when running on local vLLM, clamp max_tokens
  // to fit within the served model's context window. tool-evolver.mjs hardcodes
  // 32768 but local Qwen2.5-14B is served with 8k context.
  //
  // We reserve `inputBudget` tokens for the prompt and use the rest for output.
  // 2800 was chosen empirically: tool-evolver prompts run ~1500-2500 tokens
  // including the system prompt + the change list, and we need a safety margin.
  let effectiveMaxTokens = maxTokens;
  if (isLocalKind('text')) {
    const localCtx = parseInt(process.env.LOCAL_TEXT_MAX_LEN || '8192', 10);
    const inputBudget = 2800;
    const cap = Math.max(512, localCtx - inputBudget);
    if (effectiveMaxTokens > cap) {
      effectiveMaxTokens = cap;
    }
  }

  const response = await client.chat.completions.create({
    model: resolvedModel,
    messages,
    temperature: 0.2,
    max_tokens: effectiveMaxTokens,
  });

  return {
    text: extractText(response),
    usage: response.usage || null,
    stopReason: response.choices?.[0]?.finish_reason || 'stop',
  };
}

/**
 * Run a vision prompt against a local image file using OpenAI.
 */
export async function claudeVision({
  imagePath,
  textPrompt,
  model = DEFAULT_VISION_MODEL,
  maxTokens = null,  // override default — set explicitly when callers need long output
}) {
  const client = getClient('vision');
  const resolvedModel = normalizeModel(model, { vision: true });
  const imageBytes = await readFile(imagePath);
  const mimeType = getMimeType(imagePath);
  const imageUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;

  // PERMANENT FIX (2026-04-10): default max_tokens to 1024, not 4096.
  // Vision QA agents return short structured JSON (a checklist or one
  // sentence) — they never need 4k output tokens. Local Qwen2.5-VL has
  // an 8k context budget that includes ~1.5k image tokens, so requesting
  // 4k output left no room for the input prompt and blew the budget.
  const effectiveMax = maxTokens ?? 1024;

  const response = await client.chat.completions.create({
    model: resolvedModel,
    temperature: 0.1,
    max_tokens: effectiveMax,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: textPrompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  return extractText(response);
}

/**
 * Parse a structured JSON verdict from agent text output.
 * Agents are prompted to output JSON in ```json blocks.
 */
export function parseVerdict(text) {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      // Fall through.
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}
