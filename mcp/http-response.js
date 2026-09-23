'use strict';

/**
 * Safe response reading for the AI BUILDS MCP client.
 *
 * The AI BUILDS API sits behind Cloudflare. A Cloudflare Free rate-limit or challenge response is
 * HTML or plain text, not JSON — calling `response.json()` on it throws a raw "Unexpected token <"
 * SyntaxError that hides the actual cause (a 429) from the agent. `readJsonResponse` always checks
 * the HTTP status and Content-Type *before* attempting to parse a body, so every caller gets either
 * the parsed JSON payload or a clear, safe `ApiResponseError` — never a body-parsing crash.
 *
 * The thrown message is built only from: the caller-supplied `operation` label, the HTTP status,
 * a parsed `Retry-After` value, and — for a JSON error body only — the server's own `error` string
 * (truncated to 300 characters). It never includes request bodies, request headers, nonces,
 * challenge ids or tokens: those never flow into this module in the first place.
 */

const RETRY_AFTER_MAX_ERROR_LENGTH = 300;

class ApiResponseError extends Error {
  constructor(message, { status, retryAfterSeconds = null, code } = {}) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    if (code !== undefined) this.code = code;
  }
}

// `application/json` and any `*+json` suffix (e.g. `application/vnd.api+json`) count as JSON;
// everything else — including a missing header — does not, so an HTML/text body is never parsed.
function isJsonContentType(contentTypeHeader) {
  if (typeof contentTypeHeader !== 'string') return false;
  const mediaType = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

// Retry-After is either delta-seconds ("120") or an HTTP-date. An invalid or missing value yields
// `null`, which readJsonResponse treats as "omit the retry sentence" rather than guessing.
function parseRetryAfterSeconds(headerValue, now = Date.now()) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaSeconds = Math.round((dateMs - now) / 1000);
  return deltaSeconds > 0 ? deltaSeconds : 0;
}

/**
 * @param {Response} response - a global `fetch` Response.
 * @param {string} operation - short present-participle phrase, e.g. "contributing", used only in
 *   the generated error message.
 * @returns {Promise<any>} the parsed JSON body for a 2xx JSON response.
 * @throws {ApiResponseError} for any other status/content-type combination.
 */
async function readJsonResponse(response, operation) {
  const status = response.status;
  const contentTypeHeader = response.headers.get('content-type');
  const jsonBody = isJsonContentType(contentTypeHeader);
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));

  if (response.ok && jsonBody) {
    return await response.json();
  }

  if (jsonBody) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const serverError = body && typeof body.error === 'string'
      ? body.error.slice(0, RETRY_AFTER_MAX_ERROR_LENGTH)
      : null;
    const code = body && typeof body.code === 'string' ? body.code : undefined;
    const message = serverError || `AI BUILDS error while ${operation} (HTTP ${status}).`;
    throw new ApiResponseError(message, { status, retryAfterSeconds, code });
  }

  if (status === 429) {
    const message = retryAfterSeconds != null
      ? `AI BUILDS rate limit reached while ${operation}. Retry after ${retryAfterSeconds} seconds.`
      : `AI BUILDS rate limit reached while ${operation}.`;
    throw new ApiResponseError(message, { status, retryAfterSeconds });
  }

  throw new ApiResponseError(`AI BUILDS error while ${operation}: HTTP ${status}`, { status, retryAfterSeconds });
}

module.exports = { readJsonResponse, ApiResponseError };
