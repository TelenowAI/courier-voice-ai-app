// ─────────────────────────────────────────────────────────────────────────────
// automations/_base.js — shared plumbing for all automations (single-tenant).
//
// Each automation builds a `variables` object from a normalized courier NDR
// payload and calls `placeCall(...)`, which centralizes the cross-cutting
// concerns:
//   - load settings + the automation's config
//   - skip if disabled / no agent / no API key
//   - normalize the phone number to E.164 (or use an explicit phoneOverride)
//   - enforce quiet hours
//   - dedupe on a STABLE key (awb+attempt) with release-on-failure
//   - apply a delay (scheduled via setTimeout — see note)
//   - call Telenow and persist sessionId → record for the result webhook
//
// DELAY NOTE: we implement "delay" with an in-process setTimeout for simplicity.
// This is fine for a demo but does NOT survive a restart and won't scale across
// instances. TODO: replace with a durable job queue (BullMQ/Redis, SQS, or a
// DB-backed scheduler) in production.
// ─────────────────────────────────────────────────────────────────────────────

import { getSettings } from '../settings.js';
import { mapCall, markAttempt, clearAttempt } from '../store.js';
import { TelenowClient } from '../telenow.js';
import { extractPhone, redactPhone } from '../util/phone.js';
import { isQuietNow } from '../util/quietHours.js';

/** Default country used for E.164 normalization when a number has no country code. */
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'IN';

/**
 * @typedef {Object} PlaceCallArgs
 * @property {string} automation      Automation key (matches settings.automations).
 * @property {object} [entity]        Payload to pull a phone from (if no phoneOverride).
 * @property {object} variables       Context strings passed to the Telenow agent.
 * @property {string} identifier      Correlation id echoed back by Telenow (e.g. "ndr:<awb>").
 * @property {string} [dedupeKey]     Stable dedupe key; markAttempt/clearAttempt keyed on it.
 * @property {object} [mapExtra]      Extra fields persisted on the callMap entry (e.g. ndrId, awb).
 * @property {string} [phoneOverride] Explicit E.164 to call instead of extracting from `entity`.
 */

/**
 * Place a call for an automation, applying all gating rules.
 * @param {PlaceCallArgs} args
 * @returns {Promise<{ placed: boolean, reason?: string, sessionId?: string }>}
 */
export async function placeCall(args) {
  const { automation, entity, variables, identifier, dedupeKey, mapExtra = {}, phoneOverride } = args;

  const settings = getSettings();
  const cfg = settings.automations[automation];

  if (!cfg) return skip(`unknown automation "${automation}"`);
  if (!cfg.enabled) return skip(`automation "${automation}" disabled`);
  if (!settings.telenowApiKey) return skip('no Telenow API key configured');
  if (!cfg.agentId) return skip(`no agentId configured for "${automation}"`);

  // Resolve + normalize the phone number.
  const mobileNumber = phoneOverride || extractPhone(entity, DEFAULT_COUNTRY);
  if (!mobileNumber) return skip('no valid phone number on payload');

  // Quiet-hours guard.
  if (isQuietNow(cfg.quietHours)) {
    // TODO: instead of skipping, enqueue for nextWindowEnd() with a durable queue.
    return skip('within quiet hours');
  }

  // Dedupe guard: couriers redeliver NDR webhooks, so refuse to place a second
  // call for the same key within the TTL. Atomic check-and-set in the store. We
  // clear the mark if the placement itself fails, so a genuine retry (redelivery
  // or a NEW attempt with a different key) can still go through.
  if (dedupeKey && !markAttempt(dedupeKey)) {
    return skip('duplicate — already attempted for this awb+attempt');
  }

  const delayMs = Math.max(0, Number(cfg.delayMinutes) || 0) * 60 * 1000;

  // The actual call-placing closure (run now or after the delay).
  const fire = async () => {
    try {
      const client = new TelenowClient(settings.telenowApiKey);
      const result = await client.initiateCall({
        agentId: cfg.agentId,
        mobileNumber,
        variables,
        identifier,
        machineDetection: 'hangup',
      });
      if (result?.sessionId) {
        // Persist so the result webhook can find the NDR record. Carry the
        // automation so the webhook knows which write-back behavior to apply.
        mapCall(result.sessionId, { automation, identifier, ...mapExtra });
      }
      console.log(
        `[${automation}] call placed session=${result?.sessionId} → ${redactPhone(mobileNumber)}`,
      );
      return result;
    } catch (err) {
      // Placement failed → release the dedupe mark so a genuine retry can attempt
      // again instead of being blocked.
      if (dedupeKey) clearAttempt(dedupeKey);
      console.error(`[${automation}] call failed:`, err.message);
      throw err;
    }
  };

  if (delayMs > 0) {
    // Fire-and-forget after the delay. We return immediately with placed:false-
    // but-scheduled so the webhook handler can ACK the courier fast.
    setTimeout(() => {
      // Re-check enabled + quiet hours at fire time (config may have changed).
      const fresh = getSettings().automations[automation];
      if (!fresh?.enabled) {
        console.log(`[${automation}] skipped at fire time: disabled`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      if (isQuietNow(fresh.quietHours)) {
        console.log(`[${automation}] skipped at fire time: quiet hours`);
        if (dedupeKey) clearAttempt(dedupeKey);
        return;
      }
      fire().catch(() => {});
    }, delayMs);
    return { placed: false, reason: `scheduled in ${cfg.delayMinutes}m` };
  }

  const result = await fire();
  return { placed: true, sessionId: result?.sessionId };
}

function skip(reason) {
  return { placed: false, reason };
}
