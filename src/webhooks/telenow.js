// ─────────────────────────────────────────────────────────────────────────────
// webhooks/telenow.js — receive Telenow call-result webhooks + write back.
//
// Inbound from Telenow → this app:
//   headers: X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of raw body>
//            X-VoiceAI-Event:     call.ended | call.analyzed
//            X-VoiceAI-Delivery:  <uuid>
//   body (call.ended / call.analyzed):
//     { event_type, session_id, agent_id, status, duration, from_number,
//       to_number, ended_at, identifier?, transcript?, analysis? }
//
// We verify the HMAC over the RAW body using the signing secret returned when we
// created the hook (persisted in the store). Bad signature → 401.
//
// Write-back: resolve the NDR record (by the persisted sessionId→record map, or
// by parsing the "ndr:<awb>" identifier), then mark it completed + disposition +
// summary + duration. If the disposition asks for a re-attempt AND autoReattempt
// is on AND courier creds exist, ask the courier to re-attempt (else just record
// the requested action).
//
// Also exports ensureTelenowHook()/removeTelenowHook().
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import express from 'express';

import { getSettings } from '../settings.js';
import {
  getHook,
  saveHook,
  deleteHook,
  getCall,
  deleteCall,
  getNdr,
  findNdrByAwb,
  updateNdr,
} from '../store.js';
import { TelenowClient } from '../telenow.js';
import {
  shiprocketReattempt,
  shiprocketApiConfigured,
} from '../couriers/shiprocket.js';
import { delhiveryReattempt, delhiveryApiConfigured } from '../couriers/delhivery.js';

export const telenowWebhookRouter = express.Router();

const WEBHOOK_PATH = '/telenow/webhook';

/** Absolute URL Telenow should POST results to (used when creating the hook). */
export function telenowWebhookUrl() {
  const host = (process.env.HOST || '').replace(/\/$/, '');
  return `${host}${WEBHOOK_PATH}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook lifecycle (subscribe / unsubscribe to Telenow result webhooks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure there is exactly one Telenow webhook subscription pointing at us, and
 * persist its signing secret. Idempotent: reuses an existing matching hook.
 * Call this after the merchant saves their API key.
 */
export async function ensureTelenowHook() {
  const settings = getSettings();
  if (!settings.telenowApiKey) throw new Error('No Telenow API key set');

  const client = new TelenowClient(settings.telenowApiKey);
  const targetUrl = telenowWebhookUrl();
  const existingLocal = getHook();

  // Check Telenow's side for a courier-source hook pointing at our URL.
  let remote = [];
  try {
    remote = await client.listHooks('courier');
  } catch (err) {
    console.error('[telenow] listHooks failed:', err.message);
  }
  const match = (remote || []).find((h) => h.target_url === targetUrl);

  if (match && existingLocal?.id === match.id && existingLocal?.secret) {
    return existingLocal; // already wired and we have the secret
  }

  // If there's a remote match but we lost the secret, recreate it (the secret is
  // only returned at creation time). Delete the stale one first.
  if (match) {
    try {
      await client.deleteHook(match.id);
    } catch (err) {
      console.error(`[telenow] could not delete stale hook ${match.id}:`, err.message);
    }
  }

  const created = await client.createHook({
    targetUrl,
    events: ['call.ended', 'call.analyzed'],
    source: 'courier',
    includeTranscript: true,
  });
  // The signing secret is only returned at creation. Prefer signing_secret; the
  // backend also returns it as `secret` for backward compatibility.
  const signingSecret = created?.signing_secret ?? created?.secret;
  if (!signingSecret) throw new Error('Telenow createHook did not return a signing secret');
  saveHook({ id: created.id, secret: signingSecret });
  console.log(`[telenow] hook created (id=${created.id})`);
  return getHook();
}

/** Remove the Telenow webhook subscription (on key change / teardown). */
export async function removeTelenowHook() {
  const local = getHook();
  const settings = getSettings();
  if (local?.id && settings.telenowApiKey) {
    try {
      const client = new TelenowClient(settings.telenowApiKey);
      await client.deleteHook(local.id);
    } catch (err) {
      console.error('[telenow] deleteHook failed:', err.message);
    }
  }
  deleteHook();
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify X-VoiceAI-Signature ("sha256=<hex>") over the raw body with a secret.
 * Telenow emits HMAC-SHA256 hex-encoded (backend uses hex::encode; the
 * server-node SDK verifies hex). We compare against hex and, defensively,
 * base64 — using a constant-time comparison for each candidate.
 * @param {string} rawBody  exact bytes received
 * @param {string} header   value of X-VoiceAI-Signature
 * @param {string} secret   hook signing secret
 * @returns {boolean}
 */
export function verifyTelenowSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  const mac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  // Canonical is hex; base64 kept as a belt-and-braces fallback.
  return [mac.toString('hex'), mac.toString('base64')].some((expected) => {
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The receiver endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Mounted at WEBHOOK_PATH in server.js, so the inner route is '/'. server.js also
// applies express.text({ type: '*/*' }) for this path so req.body is the raw
// string we must HMAC. Always ACK 2xx once authenticated so Telenow doesn't
// retry; do the write-back asynchronously.

telenowWebhookRouter.post('/', async (req, res) => {
  const rawBody = typeof req.body === 'string' ? req.body : req.body?.toString('utf8') ?? '';
  const sig = req.get('X-VoiceAI-Signature');
  const eventHeader = req.get('X-VoiceAI-Event');

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    res.status(400).send('invalid JSON');
    return;
  }

  const hook = getHook();
  if (!hook?.secret || !verifyTelenowSignature(rawBody, sig, hook.secret)) {
    console.warn(`[telenow] signature verification failed (event=${eventHeader})`);
    res.status(401).send('invalid signature');
    return;
  }

  // ACK immediately; process write-back in the background.
  res.status(200).json({ ok: true });

  handleResult(payload).catch((err) =>
    console.error('[telenow] write-back failed:', err.message),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Outcome → NDR record write-back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the call outcome to the originating NDR record.
 * @param {object} payload  the Telenow webhook body
 */
async function handleResult(payload) {
  const eventType = payload.event_type || '';
  const sessionId = payload.session_id;

  // Resolve the NDR record. Prefer the persisted sessionId→record map; fall back
  // to the "ndr:<awb>" identifier we sent. Resolve BEFORE any other handling.
  const call = sessionId ? getCall(sessionId) : undefined;
  let ndrId = call?.ndrId;
  let awb = call?.awb;
  if (!awb) {
    const id = parseIdentifier(payload.identifier);
    if (id?.type === 'ndr') awb = id.value;
  }
  if (!ndrId && awb) {
    const rec = findNdrByAwb(awb);
    if (rec) ndrId = rec.id;
  }

  if (!ndrId) {
    console.log(
      `[telenow] result for session=${sessionId} identifier=${payload.identifier || '?'} ` +
        `could not resolve an NDR record — logged only`,
    );
    cleanupIfFinal(eventType, sessionId);
    return;
  }

  const disposition = readDisposition(payload);
  const summary = payload.analysis?.summary || '';
  const duration = payload.duration ?? null;

  updateNdr(ndrId, {
    status: 'completed',
    disposition,
    summary,
    duration,
    sessionId: sessionId || null,
  });
  console.log(`[telenow] wrote back ndr=${ndrId} awb=${awb || '?'} disposition=${disposition}`);

  // ── Optional courier re-attempt ─────────────────────────────────────────────
  // If the customer wants the parcel re-attempted, optionally tell the courier.
  // Gated by the autoReattempt setting AND the presence of courier creds.
  if (disposition === 'reattempt') {
    const rec = getNdr(ndrId);
    await maybeReattempt(rec, ndrId);
  }

  cleanupIfFinal(eventType, sessionId);
}

/**
 * Optionally ask the courier to re-attempt delivery. Always records the requested
 * action on the NDR record; only calls the courier API when enabled + creds exist.
 * @param {object} rec   the NDR record (has courier + awb)
 * @param {number} ndrId
 */
async function maybeReattempt(rec, ndrId) {
  const settings = getSettings();
  const courier = rec?.courier || '';
  const awb = rec?.awb || '';

  if (!settings.autoReattempt) {
    updateNdr(ndrId, { reattempt: 'requested (auto-reattempt disabled)' });
    console.log(`[telenow] re-attempt requested for awb=${awb} but autoReattempt is off`);
    return;
  }
  if (!awb) {
    updateNdr(ndrId, { reattempt: 'requested (no awb)' });
    return;
  }

  try {
    let result;
    if (courier === 'shiprocket') {
      if (!shiprocketApiConfigured()) {
        updateNdr(ndrId, { reattempt: 'requested (no Shiprocket creds)' });
        console.log(`[telenow] re-attempt for awb=${awb}: no Shiprocket creds — recorded only`);
        return;
      }
      result = await shiprocketReattempt(awb, { comments: 'Customer reachable via Telenow.' });
    } else if (courier === 'delhivery') {
      if (!delhiveryApiConfigured()) {
        updateNdr(ndrId, { reattempt: 'requested (no Delhivery creds)' });
        console.log(`[telenow] re-attempt for awb=${awb}: no Delhivery creds — recorded only`);
        return;
      }
      result = await delhiveryReattempt(awb, { comments: 'Customer reachable via Telenow.' });
    } else {
      updateNdr(ndrId, { reattempt: `requested (unknown courier "${courier}")` });
      return;
    }
    updateNdr(ndrId, {
      reattempt: result?.ok ? 'requested → courier accepted' : `requested → courier error`,
    });
    console.log(`[telenow] courier re-attempt for awb=${awb} ok=${result?.ok}`);
  } catch (err) {
    updateNdr(ndrId, { reattempt: `requested → error: ${err.message}` });
    console.error(`[telenow] courier re-attempt failed for awb=${awb}:`, err.message);
  }
}

/** Drop the session→record mapping once we've seen a terminal event. */
function cleanupIfFinal(eventType, sessionId) {
  if (eventType === 'call.analyzed' && sessionId) deleteCall(sessionId);
}

/**
 * Map Telenow's analysis to an NDR decision. We look at a few likely fields and
 * keyword-match the summary/transcript as a fallback.
 * @param {object} payload
 * @returns {'reattempt'|'cancelled'|'completed'|'unknown'}
 */
export function readDisposition(payload) {
  const a = payload.analysis || {};
  const raw = String(a.disposition || a.outcome || a.result || a.label || '').toLowerCase();

  if (/(re-?attempt|reschedul|retry|deliver again|try again|new address|tomorrow|will be (home|available)|accept)/.test(raw)) {
    return 'reattempt';
  }
  if (/(cancel|refus|reject|decline|return|rto|do ?n'?t want)/.test(raw)) return 'cancelled';

  // Fallback: scan the summary / transcript text.
  const text = String(a.summary || payload.transcript || '').toLowerCase();
  if (text) {
    if (/(re-?attempt|reschedul|deliver again|try again|will be (home|available)|correct address|new address|please deliver)/.test(text)) {
      return 'reattempt';
    }
    if (/(cancel|does not want|refused|return it|rto)/.test(text)) return 'cancelled';
  }
  return 'unknown';
}

/** Parse identifiers like "ndr:SR12345". */
function parseIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const idx = identifier.indexOf(':');
  if (idx < 0) return null;
  const type = identifier.slice(0, idx);
  const value = identifier.slice(idx + 1);
  if (!type || !value) return null;
  return { type, value };
}
