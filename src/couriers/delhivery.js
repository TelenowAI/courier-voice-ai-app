// ─────────────────────────────────────────────────────────────────────────────
// couriers/delhivery.js — Delhivery NDR webhook verify + parse + (optional) API.
//
// INBOUND WEBHOOK (Delhivery → this app, POST /webhooks/delhivery):
//   Delhivery pushes status JSON. The push is wrapped as a "Shipment" object. We
//   authenticate with a shared token the merchant configures when registering the
//   push, accepted either as `?token=<...>` on the URL OR an `x-delhivery-token`
//   header (constant-time compared to DELHIVERY_WEBHOOK_TOKEN).
//
//   Payload shape (Delhivery status push), ASSUMED FIELD PATHS (override with a
//   `courier_telenow_extract` function — see extract()). Delhivery wraps the
//   shipment as { Shipment: {...} } (sometimes an array of such):
//     waybill        ← Shipment.AWB | Shipment.Waybill | Waybill | waybill
//     order_id       ← Shipment.ReferenceNo | Shipment.OrderId | Shipment.Order | order_id
//     status         ← Shipment.Status.Status | Shipment.Status | Status
//     status_type    ← Shipment.Status.StatusType | StatusType  (UD = undelivered)
//     nsl_code       ← Shipment.Status.NSLCode | Shipment.NSLCode | NSLCode
//     instructions   ← Shipment.Status.Instructions | Shipment.Instructions | Instructions
//     customer_name  ← Shipment.Consignee.Name | Shipment.ConsigneeName | name
//     customer_phone ← Shipment.Consignee.Telephone[0] | Shipment.Consignee.Telephone |
//                      Shipment.ConsigneePhone | phone
//
// OPTIONAL RE-ATTEMPT API (this app → Delhivery), gated by a setting + creds:
//   Delhivery exposes an NDR / edit endpoint to defer/re-attempt a shipment. It
//   needs a Bearer API token (DELHIVERY_API_TOKEN). We POST a best-effort
//   re-attempt action. TODO: confirm the exact endpoint/params for your Delhivery
//   account (NDR action APIs differ by integration tier). If the token is absent,
//   the caller just records the requested action (no API call).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

const DELHIVERY_API_BASE = (process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com')
  .replace(/\/$/, '');

/**
 * Constant-time verify the Delhivery shared token from `?token=` or the
 * `x-delhivery-token` header.
 * @param {import('express').Request} req
 * @param {string} expectedToken  DELHIVERY_WEBHOOK_TOKEN
 * @returns {boolean}
 */
export function verifyDelhivery(req, expectedToken) {
  if (!expectedToken) return false; // fail closed
  const provided =
    req.query?.token ||
    req.get('x-delhivery-token') ||
    req.get('X-Delhivery-Token') ||
    req.get('token') ||
    '';
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

/** Telephone can be a string, comma-list, or array — return the first number. */
function firstPhone(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.find((x) => x != null && String(x).trim()) || '';
  return String(v).split(',')[0] || '';
}

/**
 * Parse a Delhivery status-push body into a normalized NDR object. Best-effort.
 * Override the mapping with a global `courier_telenow_extract(payload, courier)`
 * or pass `extractOverride`.
 *
 * @param {object} payload  parsed JSON body
 * @param {(payload: object, courier: string) => object} [extractOverride]
 * @returns {{ courier: 'delhivery', awb: string, orderId: string,
 *             currentStatus: string, statusType: string, nslCode: string,
 *             customerName: string, customerPhone: string, ndrReason: string,
 *             attempt: number|null, trackingUrl: string, raw: object }}
 */
export function parseDelhivery(payload = {}, extractOverride) {
  // Delhivery wraps as { Shipment: {...} } — sometimes an array. Normalize.
  let s = payload?.Shipment ?? payload?.shipment ?? payload;
  if (Array.isArray(s)) s = s[0] || {};
  if (Array.isArray(s?.Shipment)) s = s.Shipment[0] || s;

  const statusType = str(pick(s, ['Status.StatusType', 'StatusType', 'status_type']));
  const nslCode = str(pick(s, ['Status.NSLCode', 'NSLCode', 'nsl_code']));
  const instructions = str(pick(s, ['Status.Instructions', 'Instructions', 'instructions']));

  const base = {
    courier: 'delhivery',
    awb: str(pick(s, ['AWB', 'Waybill', 'waybill', 'WaybillNo'])),
    orderId: str(pick(s, ['ReferenceNo', 'OrderId', 'Order', 'order_id'])),
    currentStatus: str(pick(s, ['Status.Status', 'Status', 'status'])),
    statusType,
    nslCode,
    customerName: str(pick(s, ['Consignee.Name', 'ConsigneeName', 'name'])),
    customerPhone: str(
      firstPhone(
        pick(s, [
          'Consignee.Telephone',
          'Consignee.Telephone1',
          'Consignee.Phone',
          'ConsigneePhone',
          'phone',
        ]),
      ),
    ),
    // NDR reason is usually carried in the NSL instructions / code.
    ndrReason: instructions || nslCode,
    attempt: num(pick(s, ['Status.Attempt', 'Attempt', 'attempt', 'NumberOfAttempts'])),
    trackingUrl: str(pick(s, ['TrackingUrl', 'tracking_url'])),
    raw: payload,
  };

  const override =
    extractOverride ||
    (typeof globalThis.courier_telenow_extract === 'function'
      ? globalThis.courier_telenow_extract
      : null);
  if (override) {
    try {
      const extra = override(payload, 'delhivery') || {};
      return { ...base, ...extra };
    } catch (err) {
      console.error('[delhivery] courier_telenow_extract override threw:', err.message);
    }
  }
  return base;
}

/**
 * Decide whether a parsed Delhivery payload is a failed delivery (NDR). NDR ≈
 * StatusType "UD" (undelivered), or an NSL code that matches a configured
 * substring. Configurable via settings.couriers.delhivery.{ndrStatusTypes,ndrNslCodes}.
 * @param {{ statusType: string, nslCode: string, ndrReason: string }} parsed
 * @param {{ ndrStatusTypes?: string[], ndrNslCodes?: string[] }} matcher
 * @returns {boolean}
 */
export function isDelhiveryNdr(parsed, matcher = {}) {
  const st = String(parsed?.statusType || '').toUpperCase();
  const types = (matcher.ndrStatusTypes || []).map((t) => String(t).toUpperCase());
  if (st && types.includes(st)) return true;

  const hay = `${parsed?.nslCode || ''} ${parsed?.ndrReason || ''}`.toLowerCase();
  return (matcher.ndrNslCodes || []).some((c) => c && hay.includes(String(c).toLowerCase()));
}

// ── Optional re-attempt API client ────────────────────────────────────────────

/** True if the Delhivery re-attempt API token is configured. */
export function delhiveryApiConfigured() {
  return Boolean(process.env.DELHIVERY_API_TOKEN);
}

/**
 * Ask Delhivery to re-attempt / defer delivery for a waybill. Needs a token.
 * NOTE: Delhivery's NDR action endpoint varies by account tier — confirm the
 * exact path/params for yours. This is a best-effort call against the documented
 * UCR/NDR edit shape.
 * @param {string} awb
 * @param {{ action?: string, comments?: string }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, body?: any }>}
 */
export async function delhiveryReattempt(awb, opts = {}) {
  if (!awb) throw new Error('delhiveryReattempt: awb required');
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { ok: false, body: 'no Delhivery API token configured' };

  // TODO(production): confirm the exact NDR/edit endpoint + payload for your
  // Delhivery integration tier. Below is the common UCR/NDR-action shape.
  const res = await fetch(`${DELHIVERY_API_BASE}/api/p/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify({
      waybill: awb,
      act: opts.action || 'RE-ATTEMPT',
      remarks: opts.comments || 'Customer reachable via Telenow voice — please re-attempt.',
    }),
  });
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
