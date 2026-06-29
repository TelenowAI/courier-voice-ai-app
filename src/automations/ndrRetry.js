// ─────────────────────────────────────────────────────────────────────────────
// automations/ndrRetry.js — NDR failed-delivery retry by voice.
//
// Trigger: a verified courier NDR webhook (Shiprocket or Delhivery). When a
// courier reports a failed delivery attempt we:
//   1) store the NDR record FIRST (so it shows in the dashboard even if we don't
//      call — no phone, disabled, quiet hours),
//   2) place an instant Telenow AI call to reschedule / fix the address,
//   3) patch the record with the placement result.
//
// The *result* of the call comes back on the Telenow webhook and is handled in
// src/webhooks/telenow.js, which resolves the record via the callMap entry's
// ndrId (or by parsing the "ndr:<awb>" identifier) and marks it completed.
//
// DEDUPE KEY: "ndr:awb:<awb>:<attempt>". Couriers redeliver the same NDR webhook
// (timeouts/retries) — those collapse to one call. But a GENUINELY NEW failed
// attempt arrives with a higher `attempt` number → a different key → a real
// re-call. We release the mark if placement fails so a redelivery can retry.
// ─────────────────────────────────────────────────────────────────────────────

import { placeCall } from './_base.js';
import { getSettings } from '../settings.js';
import { insertNdr, updateNdr, clearAttempt } from '../store.js';
import { toE164 } from '../util/phone.js';

/** Default country used for E.164 normalization when a number has no country code. */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

/**
 * Build the stable dedupe key for an NDR event. Same webhook redelivered →
 * same key (deduped); a new attempt number → new key (re-calls).
 * @param {string} awb
 * @param {number|null} attempt
 */
export function ndrDedupeKey(awb, attempt) {
  const a = attempt == null || attempt === '' ? '1' : String(attempt);
  return awb ? `ndr:awb:${awb}:${a}` : '';
}

/**
 * Handle a normalized NDR event: capture it and place a voice retry call.
 * @param {object} ndr  normalized NDR object from couriers/*.js parse()
 * @returns {Promise<{ placed: boolean, reason?: string, ndrId: number }>}
 */
export async function handleNdrRetry(ndr) {
  ndr = ndr || {};
  const settings = getSettings();

  const awb = String(ndr.awb || '');
  const phone = toE164(ndr.customerPhone, DEFAULT_COUNTRY);
  const storeName = settings.storeName || '';

  // Context strings for the agent. All values are strings (Telenow variables).
  const variables = {
    customer_name: ndr.customerName || 'there',
    awb,
    order_id: String(ndr.orderId || ''),
    courier: ndr.courier || '',
    ndr_reason: ndr.ndrReason || '',
    attempt: String(ndr.attempt ?? ''),
    tracking_url: ndr.trackingUrl || '',
    store_name: storeName,
  };

  // Always store the NDR record FIRST so it lands in the dashboard regardless of
  // whether the call is placed (no phone, disabled, quiet hours, etc.).
  const ndrId = insertNdr({
    courier: ndr.courier || '',
    awb,
    orderId: ndr.orderId || '',
    customerName: ndr.customerName || '',
    phone: phone || '',
    ndrReason: ndr.ndrReason || '',
    attempt: ndr.attempt ?? null,
    currentStatus: ndr.currentStatus || '',
    trackingUrl: ndr.trackingUrl || '',
    variables,
    status: 'queued',
  });

  // No usable phone → nothing to call. Record and bail.
  if (!phone) {
    updateNdr(ndrId, { status: 'skipped', disposition: 'no phone' });
    return { placed: false, reason: 'no phone', ndrId };
  }

  const dedupeKey = ndrDedupeKey(awb, ndr.attempt);

  try {
    // placeCall extracts a phone from `entity` OR uses `phoneOverride`; we already
    // normalized one, so pass it explicitly. mapExtra is persisted on the callMap
    // entry so the result webhook can resolve this record fast.
    const result = await placeCall({
      automation: 'ndrRetry',
      entity: ndr,
      variables,
      identifier: `ndr:${awb}`,
      dedupeKey,
      mapExtra: { ndrId, awb, courier: ndr.courier || '' },
      phoneOverride: phone,
    });

    if (result?.placed) {
      updateNdr(ndrId, { status: 'placed', sessionId: result.sessionId || null });
    } else {
      // A delayed call returns placed:false with reason "scheduled in Nm" — the
      // call WILL fire later (and the result webhook will complete the record), so
      // surface it as 'scheduled' rather than 'skipped'. Genuine skips
      // (disabled/quiet/no-phone/duplicate) stay 'skipped'.
      const reason = result?.reason || 'skipped';
      const status = /^scheduled/i.test(reason) ? 'scheduled' : 'skipped';
      updateNdr(ndrId, { status, disposition: reason });
    }
    return { ...result, ndrId };
  } catch (err) {
    // Telenow placement threw (network/4xx). Release the dedupe mark so a genuine
    // redelivery can retry, and record the failure on the record.
    if (dedupeKey) clearAttempt(dedupeKey);
    updateNdr(ndrId, { status: 'failed', disposition: err.message });
    throw err;
  }
}
