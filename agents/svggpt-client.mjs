/**
 * SVGGPT client — thin HTTP wrapper around the local FastAPI shim.
 *
 * Starts the service with:
 *   bash /home/ara/Documents/Programming/SVGGPT/service/start.sh
 *
 * Gated on env var SVGGPT_ENABLED. When unset or "0", `renderFor()` returns
 * null and callers should treat the feature as disabled.
 */

const BASE = process.env.SVGGPT_URL || 'http://127.0.0.1:8003';
const ENABLED = process.env.SVGGPT_ENABLED === '1';
const TIMEOUT_MS = Number(process.env.SVGGPT_TIMEOUT_MS || 3000);

export function svggptEnabled() {
  return ENABLED;
}

async function _post(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      throw new Error(`svggpt ${r.status}: ${await r.text()}`);
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Render a diagram for a free-text question. Returns
 *   { svg, ir, trace }
 * or null when the feature is disabled, the service is down, or the
 * pipeline could not extract any triple from the text.
 */
export async function renderFor(text, { sessionId = null } = {}) {
  if (!ENABLED) return null;
  if (!text || !text.trim()) return null;
  const path = sessionId
    ? `/render/session/${encodeURIComponent(sessionId)}`
    : '/render';
  try {
    const out = await _post(path, { text });
    if (!out?.ir?.edges?.length) return null;  // no diagram to draw
    return out;
  } catch (err) {
    console.warn(`[svggpt] render failed: ${err.message}`);
    return null;
  }
}

export async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function clearSession(sessionId) {
  try {
    await fetch(`${BASE}/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}
