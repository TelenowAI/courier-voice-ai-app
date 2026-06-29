// ─────────────────────────────────────────────────────────────────────────────
// test/roundtrip.mjs — local end-to-end round-trip harness for the courier app.
//
// Proves the FULL integration chain works locally with NO real courier, NO real
// Telenow backend, and NO hosting. It drives the service's REAL modules:
//
//   Shiprocket NDR webhook  (token-authenticated via x-api-key, verified for real)
//        → handleNdrRetry → placeCall → TelenowClient.initiateCall
//        → MOCK Telenow records the call + returns a sessionId
//        → MOCK Telenow fires a call.analyzed result webhook (HEX HMAC, the
//          service's verifier accepts it)
//        → telenow webhook receiver writes back to the NDR record store
//
// Run:  npm run roundtrip      (exits 0 with all PASS, non-zero on any FAIL)
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startMockTelenow, httpPost } from './mock-telenow.mjs';

// ── Test config ────────────────────────────────────────────────────────────────
const TEST_PORT = 4021;
const HOST = `http://127.0.0.1:${TEST_PORT}`;
const SHIPROCKET_TOKEN = 'sr_webhook_token_roundtrip';
const AWB = 'SR1234567890';
const PHONE_LOCAL = '9876543210'; // IN local → +919876543210
const EXPECTED_E164 = '+919876543210';

// Track assertions for a single PASS/FAIL summary + exit code.
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Poll a synchronous predicate until true or timeout (handlers run async). */
async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  // 1) Fresh temp DATA_DIR + dummy env. MUST be set before importing any service
  //    module (store.js loads the DB at import time, server.js reads HOST/PORT).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-telenow-rt-'));
  const mock = await startMockTelenow();

  process.env.DATA_DIR = dataDir;
  process.env.TELENOW_API_BASE = mock.base;
  process.env.HOST = HOST;
  process.env.PORT = String(TEST_PORT);
  process.env.DEFAULT_PHONE_COUNTRY = 'IN';
  process.env.SHIPROCKET_WEBHOOK_TOKEN = SHIPROCKET_TOKEN;
  // No courier API creds → re-attempt is recorded but not actually called.

  // Capture the http.Server the service's server.js creates so we can close it.
  const origListen = http.Server.prototype.listen;
  let appServer = null;
  http.Server.prototype.listen = function patched(...args) {
    appServer = this;
    return origListen.apply(this, args);
  };

  // 2) Import the REAL service modules + its wired Express app (auto-listens).
  const store = await import('../src/store.js');
  const settings = await import('../src/settings.js');
  await import('../src/server.js'); // starts the real app on TEST_PORT
  http.Server.prototype.listen = origListen;

  // Wait for the app to actually be listening.
  await waitFor(() => appServer && appServer.listening, { timeoutMs: 4000 });

  try {
    // 3) Seed Telenow connection + the hook secret + enable the automation
    //    directly via the service's store/settings.
    store.saveHook({ id: 'hook_test', secret: mock.createdHooks[0]?.secret || 'whsec_test_123' });
    settings.updateSettings({
      telenowApiKey: 'vai_live_testkey_roundtrip',
      storeName: 'Acme Store',
      automations: {
        ndrRetry: { enabled: true, agentId: 'agent-uuid-test', delayMinutes: 0 },
      },
    });
    check(
      'seed: hook + settings persisted',
      store.getHook()?.secret === 'whsec_test_123' && settings.getAutomation('ndrRetry').enabled,
    );

    // 4) Simulate Shiprocket's NDR webhook, authenticated with the x-api-key token
    //    so the service's own verifier passes. current_status = "Undelivered" → NDR.
    const ndrPayload = {
      awb: AWB,
      order_id: 'ORD-555',
      current_status: 'Undelivered',
      customer_name: 'Asha Rao',
      customer_phone: PHONE_LOCAL,
      ndr_reason: 'Customer not available',
      attempt: 1,
      tracking_url: 'https://shiprocket.co/tracking/' + AWB,
    };
    const rawBody = JSON.stringify(ndrPayload);
    const webhookRes = await httpPost(`${HOST}/webhooks/shiprocket`, rawBody, {
      'Content-Type': 'application/json',
      'x-api-key': SHIPROCKET_TOKEN,
    });
    check(
      'shiprocket NDR webhook accepted (token verified, 200, ndr:true)',
      webhookRes.status === 200 && /"ndr":true/.test(webhookRes.body),
      `status=${webhookRes.status} body=${webhookRes.body}`,
    );

    // 5) The handler runs async (the receiver ACKs immediately). Wait for the call.
    await waitFor(() => mock.initiateCalls.length >= 1);
    const call = mock.initiateCalls[0];
    check('mock Telenow received an initiate-call', Boolean(call));
    check(
      'initiate-call has expected E.164 phone',
      call?.mobileNumber === EXPECTED_E164,
      `mobileNumber=${call?.mobileNumber}`,
    );
    check(
      'initiate-call identifier is "ndr:<awb>"',
      call?.identifier === `ndr:${AWB}`,
      `identifier=${call?.identifier}`,
    );
    check(
      'initiate-call carries the configured agentId',
      call?.agentId === 'agent-uuid-test',
      `agentId=${call?.agentId}`,
    );
    check(
      'initiate-call variables include awb + courier + store_name',
      call?.variables?.awb === AWB &&
        call?.variables?.courier === 'shiprocket' &&
        call?.variables?.store_name === 'Acme Store',
      `variables=${JSON.stringify(call?.variables)}`,
    );

    // 6) An NDR record was stored, in "placed" state, with a sessionId.
    await waitFor(() => {
      const rows = store.listNdr(10);
      return rows.length >= 1 && rows[0].status === 'placed';
    });
    const rows = store.listNdr(10);
    const rec = rows[0];
    check('an NDR record was stored', Boolean(rec) && rows.length === 1);
    check('NDR record captured the AWB', rec?.awb === AWB, `awb=${rec?.awb}`);
    check('NDR record captured the phone (E.164)', rec?.phone === EXPECTED_E164, `phone=${rec?.phone}`);
    check('NDR record moved to status "placed"', rec?.status === 'placed', `status=${rec?.status}`);
    const sessionId = rec?.sessionId;
    check('NDR record has the Telenow sessionId', Boolean(sessionId), `sessionId=${sessionId}`);

    // 7) Fire the result webhook (correct HEX signature) → 200 + record → completed.
    const goodRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, { sessionId });
    check('result webhook (valid signature) → 200', goodRes.status === 200, `status=${goodRes.status}`);
    await waitFor(() => store.getNdr(rec.id)?.status === 'completed');
    const completed = store.getNdr(rec.id);
    check('NDR record updated to "completed"', completed?.status === 'completed', `status=${completed?.status}`);
    check(
      'NDR disposition is "reattempt"',
      completed?.disposition === 'reattempt',
      `disposition=${completed?.disposition}`,
    );
    check('NDR recorded duration from result', completed?.duration === 42, `duration=${completed?.duration}`);
    check(
      're-attempt recorded as requested (auto-reattempt off)',
      typeof completed?.reattempt === 'string' && /requested/.test(completed.reattempt),
      `reattempt=${completed?.reattempt}`,
    );

    // 8) Negative test: a WRONG signature → 401 and NO further record change.
    const before = JSON.stringify(store.getNdr(rec.id));
    const badRes = await mock.fireResultWebhook(`${HOST}/telenow/webhook`, {
      sessionId,
      signature: 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      bodyOverride: {
        event_type: 'call.analyzed',
        session_id: sessionId,
        status: 'completed',
        duration: 999,
        analysis: { disposition: 'cancelled', summary: 'should not be applied' },
      },
    });
    check('result webhook (wrong signature) → 401', badRes.status === 401, `status=${badRes.status}`);
    // Give any (incorrect) async write-back a chance to NOT happen.
    await new Promise((r) => setTimeout(r, 150));
    const after = JSON.stringify(store.getNdr(rec.id));
    check('NDR record unchanged after bad-signature webhook', before === after);

    // 9) Dedupe: the SAME webhook redelivered (same awb+attempt) → no 2nd call.
    const dupRes = await httpPost(`${HOST}/webhooks/shiprocket`, rawBody, {
      'Content-Type': 'application/json',
      'x-api-key': SHIPROCKET_TOKEN,
    });
    check('redelivered NDR webhook still ACKed 200', dupRes.status === 200, `status=${dupRes.status}`);
    await new Promise((r) => setTimeout(r, 200));
    check(
      'duplicate webhook did NOT place a second call (dedupe on awb+attempt)',
      mock.initiateCalls.length === 1,
      `initiateCalls=${mock.initiateCalls.length}`,
    );

    // 10) A NEW attempt (attempt=2) for the same AWB → a real re-call.
    const ndr2 = JSON.stringify({ ...ndrPayload, attempt: 2 });
    await httpPost(`${HOST}/webhooks/shiprocket`, ndr2, {
      'Content-Type': 'application/json',
      'x-api-key': SHIPROCKET_TOKEN,
    });
    await waitFor(() => mock.initiateCalls.length >= 2);
    check(
      'a NEW attempt number re-calls (dedupe key includes attempt)',
      mock.initiateCalls.length === 2,
      `initiateCalls=${mock.initiateCalls.length}`,
    );

    // 11) Negative: a webhook with a WRONG token → 401, no record/call.
    const callsBefore = mock.initiateCalls.length;
    const badTokenRes = await httpPost(`${HOST}/webhooks/shiprocket`, rawBody, {
      'Content-Type': 'application/json',
      'x-api-key': 'totally-wrong-token',
    });
    check('shiprocket webhook (wrong token) → 401', badTokenRes.status === 401, `status=${badTokenRes.status}`);
    await new Promise((r) => setTimeout(r, 120));
    check('wrong-token webhook placed no call', mock.initiateCalls.length === callsBefore);

    // 12) Delayed call → the NDR record lands as "scheduled" (not "skipped").
    //     Enable a delay, fire a fresh AWB, and assert placeCall returned a
    //     scheduled (placed:false) result that ndrRetry surfaced as 'scheduled'.
    settings.updateSettings({
      automations: { ndrRetry: { enabled: true, agentId: 'agent-uuid-test', delayMinutes: 5 } },
    });
    const callsBeforeDelay = mock.initiateCalls.length;
    const DELAYED_AWB = 'SR-DELAYED-001';
    const delayedBody = JSON.stringify({
      ...ndrPayload,
      awb: DELAYED_AWB,
      order_id: 'ORD-DELAY',
      attempt: 1,
    });
    await httpPost(`${HOST}/webhooks/shiprocket`, delayedBody, {
      'Content-Type': 'application/json',
      'x-api-key': SHIPROCKET_TOKEN,
    });
    await waitFor(() => {
      const r = store.findNdrByAwb(DELAYED_AWB);
      return r && r.status === 'scheduled';
    });
    const delayedRec = store.findNdrByAwb(DELAYED_AWB);
    check(
      'delayed NDR record status is "scheduled" (not "skipped")',
      delayedRec?.status === 'scheduled',
      `status=${delayedRec?.status} disposition=${delayedRec?.disposition}`,
    );
    check(
      'delayed NDR disposition mentions schedule',
      /^scheduled/i.test(String(delayedRec?.disposition || '')),
      `disposition=${delayedRec?.disposition}`,
    );
    check(
      'delayed call was NOT placed immediately (deferred)',
      mock.initiateCalls.length === callsBeforeDelay,
      `initiateCalls=${mock.initiateCalls.length}`,
    );
    // Restore zero-delay for any later use.
    settings.updateSettings({
      automations: { ndrRetry: { enabled: true, agentId: 'agent-uuid-test', delayMinutes: 0 } },
    });

    // 13) Disconnect & purge: POST /api/disconnect removes the hook and wipes ALL
    //     local data (settings incl. API key, callMap, attempts, NDR records).
    check(
      'before disconnect: hook + settings + NDR records present',
      Boolean(store.getHook()) &&
        Boolean(settings.getSettings().telenowApiKey) &&
        store.listNdr(10).length > 0,
    );
    const discRes = await httpPost(`${HOST}/api/disconnect`, JSON.stringify({}), {
      'Content-Type': 'application/json',
    });
    check('POST /api/disconnect → 200', discRes.status === 200, `status=${discRes.status}`);
    check('disconnect response says ok', /"ok":true/.test(discRes.body), `body=${discRes.body}`);
    check('disconnect purged the Telenow hook', store.getHook() == null);
    check('disconnect purged the API key/settings', !settings.getSettings().telenowApiKey);
    check('disconnect purged all NDR records', store.listNdr(10).length === 0);
  } finally {
    // 12) Clean up: stop both servers + remove the temp DATA_DIR.
    if (appServer) await new Promise((resolve) => appServer.close(() => resolve()));
    await mock.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length) {
    console.log('Failed checks:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('roundtrip harness crashed:', err);
  process.exitCode = 1;
});
