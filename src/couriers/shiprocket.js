// ─────────────────────────────────────────────────────────────────────────────
// couriers/shiprocket.js — Shiprocket NDR webhook verify + parse + (optional) API.
//
// INBOUND WEBHOOK (Shiprocket → this app, POST /webhooks/shiprocket):
//   Shiprocket posts status / NDR webhooks. Authentication is a token the
//   merchant sets in Shiprocket → Settings → API → Webhooks; Shiprocket sends it
//   back on every webhook in the `x-api-key` request header. We verify it with a
//   constant-time comparison against SHIPROCKET_WEBHOOK_TOKEN.
//
//   Payload shape varies by account; we extract best-effort. ASSUMED FIELD PATHS
//   (override with a `courier_telenow_extract` function — see extract()):
//     awb            ← awb | awb_code | awbcode | shipment.awb_code
//     order_id       ← order_id | order_number | channel_order_id | shipment.order_id
//     current_status ← current_status | status | shipment_status | shipment.current_status
//     customer_name  ← customer_name | name | shipment.customer_name
//     customer_phone ← customer_phone | phone | customer_mobile | shipment.customer_phone
//     ndr_reason     ← ndr_reason | reason | remark | comments | ndr.reason
//     attempt        ← attempt | attempts | ndr_attempts | delivery_attempts | ndr.attempt
//     tracking_url   ← tracking_url | track_url | shipment.tracking_url
//
// OPTIONAL RE-ATTEMPT API (this app → Shiprocket), gated by a setting + creds:
//   1) POST /v1/external/auth/login { email, password } → { token } (Bearer,
//      ~10-day expiry). We cache it in-process.
//   2) POST /v1/external/ndr/{awb}/action { action: "re-attempt" } to ask the
//      courier to retry delivery.
//   Requires SHIPROCKET_EMAIL + SHIPROCKET_PASSWORD. If absent, the caller just
//   records the requested action (no API call).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

const SHIPROCKET_API_BASE = (process.env.SHIPROCKET_API_BASE || 'https://apiv2.shiprocket.in')
  .replace(/\/$/, '');

/**
 * Constant-time verify the Shiprocket webhook token from the `x-api-key` header.
 * @param {import('express').Request} req
 * @param {string} expectedToken  SHIPROCKET_WEBHOOK_TOKEN
 * @returns {boolean}
 */
export function verifyShiprocket(req, expectedToken) {
  if (!expectedToken) return false; // no token configured → reject (fail closed)
  const provided =
    req.get('x-api-key') || req.get('X-Api-Key') || req.get('apikey') || req.get('token') || '';
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expectedToken));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** First defined/non-empty value among the dotted paths on `obj`. */
function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
    if (v != null && String(v).trim() !== '') return v;
  }
  return undefined;
}

/**
 * Parse a Shiprocket webhook body into a normalized NDR object. Best-effort —
 * guards every field. To override the field mapping for your account, set a
 * global `courier_telenow_extract` function (or pass `extractOverride`); it
 * receives (rawPayload, courier) and may return a partial normalized object that
 * is merged over the defaults.
 *
 * @param {object} payload  parsed JSON body
 * @param {(payload: object, courier: string) => object} [extractOverride]
 * @returns {{ courier: 'shiprocket', awb: string, orderId: string,
 *             currentStatus: string, customerName: string, customerPhone: string,
 *             ndrReason: string, attempt: number|null, trackingUrl: string,
 *             raw: object }}
 */
export function parseShiprocket(payload = {}, extractOverride) {
  // Shiprocket sometimes nests the shipment under `data` or `shipment`.
  const p = payload?.data && typeof payload.data === 'object' ? payload.data : payload;

  const base = {
    courier: 'shiprocket',
    awb: str(pick(p, ['awb', 'awb_code', 'awbcode', 'shipment.awb_code', 'shipment.awb'])),
    orderId: str(
      pick(p, ['order_id', 'order_number', 'channel_order_id', 'shipment.order_id']),
    ),
    currentStatus: str(
      pick(p, ['current_status', 'status', 'shipment_status', 'shipment.current_status']),
    ),
    customerName: str(pick(p, ['customer_name', 'name', 'shipment.customer_name'])),
    customerPhone: str(
      pick(p, ['customer_phone', 'phone', 'customer_mobile', 'shipment.customer_phone']),
    ),
    ndrReason: str(pick(p, ['ndr_reason', 'reason', 'remark', 'comments', 'ndr.reason'])),
    attempt: num(
      pick(p, ['attempt', 'attempts', 'ndr_attempts', 'delivery_attempts', 'ndr.attempt']),
    ),
    trackingUrl: str(pick(p, ['tracking_url', 'track_url', 'shipment.tracking_url'])),
    raw: payload,
  };

  const override =
    extractOverride ||
    (typeof globalThis.courier_telenow_extract === 'function'
      ? globalThis.courier_telenow_extract
      : null);
  if (override) {
    try {
      const extra = override(payload, 'shiprocket') || {};
      return { ...base, ...extra };
    } catch (err) {
      console.error('[shiprocket] courier_telenow_extract override threw:', err.message);
    }
  }
  return base;
}

/**
 * Decide whether a parsed Shiprocket payload represents a failed delivery (NDR).
 * Configurable via settings.couriers.shiprocket.ndrStatuses (substring match on
 * the lower-cased current_status).
 * @param {{ currentStatus: string }} parsed
 * @param {string[]} ndrStatuses
 * @returns {boolean}
 */
export function isShiprocketNdr(parsed, ndrStatuses = []) {
  const status = String(parsed?.currentStatus || '').toLowerCase();
  if (!status) return false;
  return (ndrStatuses || []).some((s) => s && status.includes(String(s).toLowerCase()));
}

// ── Optional re-attempt API client ────────────────────────────────────────────

/** Cached Bearer token (process-lifetime). { token, exp } */
let tokenCache = null;

/**
 * Get a Shiprocket Bearer token, logging in if needed. Cached ~10 days.
 * @returns {Promise<string|null>} token, or null if creds are absent.
 */
async function getToken() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) return null;

  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;

  const res = await fetch(`${SHIPROCKET_API_BASE}/v1/external/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.token) {
    throw new Error(data?.message || `Shiprocket login failed → ${res.status}`);
  }
  // Token is valid ~10 days; cache for 9 to be safe.
  tokenCache = { token: data.token, exp: Date.now() + 9 * 24 * 60 * 60 * 1000 };
  return data.token;
}

/** True if re-attempt API creds are configured. */
export function shiprocketApiConfigured() {
  return Boolean(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD);
}

/**
 * Ask Shiprocket to re-attempt delivery for an AWB. Needs creds.
 * @param {string} awb
 * @param {{ action?: string, comments?: string }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, body?: any }>}
 */
export async function shiprocketReattempt(awb, opts = {}) {
  if (!awb) throw new Error('shiprocketReattempt: awb required');
  const token = await getToken();
  if (!token) return { ok: false, body: 'no Shiprocket credentials configured' };

  const res = await fetch(
    `${SHIPROCKET_API_BASE}/v1/external/ndr/${encodeURIComponent(awb)}/action`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: opts.action || 're-attempt', comments: opts.comments || '' }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function str(v) {
  return v == null ? '' : String(v).trim();
}
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
