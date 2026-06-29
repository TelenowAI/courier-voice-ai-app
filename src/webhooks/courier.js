// ─────────────────────────────────────────────────────────────────────────────
// webhooks/courier.js — inbound courier NDR receivers (Shiprocket + Delhivery).
//
// Two endpoints, one per courier:
//   POST /webhooks/shiprocket  — verify the `x-api-key` token, parse, dispatch.
//   POST /webhooks/delhivery   — verify a `?token=`/header token, parse, dispatch.
//
// Each receiver:
//   1) verifies the merchant-configured shared secret (constant-time),
//   2) parses the (account-specific) payload best-effort into a normalized NDR,
//   3) decides whether it's actually a failed delivery (configurable matcher),
//   4) hands NDR events to handleNdrRetry (which stores the record + calls).
//
// IMPORTANT: these routes receive the RAW body (server.js mounts express.text for
// them) so we control parsing and never depend on a courier's Content-Type. We
// ACK 2xx fast and do the call placement in the background so the courier doesn't
// retry. A non-NDR status is acknowledged with { ok:true, ndr:false } (not an
// error) so the courier stops resending it.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';

import { getSettings } from '../settings.js';
import { handleNdrRetry } from '../automations/ndrRetry.js';
import {
  verifyShiprocket,
  parseShiprocket,
  isShiprocketNdr,
} from '../couriers/shiprocket.js';
import { verifyDelhivery, parseDelhivery, isDelhiveryNdr } from '../couriers/delhivery.js';

export const courierWebhookRouter = express.Router();

/** Parse the raw body to JSON, tolerating an already-parsed object. */
function readJson(req) {
  const raw = typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '';
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

/** Run the NDR handler in the background; never let it turn into a non-200. */
function dispatch(name, ndr) {
  Promise.resolve()
    .then(() => handleNdrRetry(ndr))
    .then((res) => {
      if (res && res.placed === false && res.reason) {
        console.log(`[webhook:${name}] not placed: ${res.reason} (ndrId=${res.ndrId})`);
      }
    })
    .catch((err) => console.error(`[webhook:${name}] error:`, err.message));
}

// ── Shiprocket ─────────────────────────────────────────────────────────────────
courierWebhookRouter.post('/shiprocket', (req, res) => {
  const token = process.env.SHIPROCKET_WEBHOOK_TOKEN || '';
  if (!verifyShiprocket(req, token)) {
    console.warn('[webhook:shiprocket] token verification failed');
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  const payload = readJson(req);
  if (!payload) {
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const parsed = parseShiprocket(payload);
  const matcher = getSettings().couriers.shiprocket?.ndrStatuses || [];
  const ndr = isShiprocketNdr(parsed, matcher);

  // ACK fast either way so Shiprocket stops resending.
  res.status(200).json({ ok: true, ndr, awb: parsed.awb || undefined });

  if (ndr) {
    dispatch('shiprocket', parsed);
  } else {
    console.log(
      `[webhook:shiprocket] status="${parsed.currentStatus}" awb=${parsed.awb || '?'} — not NDR, ignored`,
    );
  }
});

// ── Delhivery ──────────────────────────────────────────────────────────────────
courierWebhookRouter.post('/delhivery', (req, res) => {
  const token = process.env.DELHIVERY_WEBHOOK_TOKEN || '';
  if (!verifyDelhivery(req, token)) {
    console.warn('[webhook:delhivery] token verification failed');
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  const payload = readJson(req);
  if (!payload) {
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const parsed = parseDelhivery(payload);
  const matcher = getSettings().couriers.delhivery || {};
  const ndr = isDelhiveryNdr(parsed, matcher);

  res.status(200).json({ ok: true, ndr, awb: parsed.awb || undefined });

  if (ndr) {
    dispatch('delhivery', parsed);
  } else {
    console.log(
      `[webhook:delhivery] statusType="${parsed.statusType}" awb=${parsed.awb || '?'} — not NDR, ignored`,
    );
  }
});
