// ─────────────────────────────────────────────────────────────────────────────
// server.js — Express app entrypoint (single-tenant NDR voice-retry service).
//
// Wiring order matters because of body parsers:
//   - Webhook routes (courier + Telenow) need the RAW body for HMAC/token checks,
//     so they get express.text({ type: '*/*' }) and are mounted BEFORE the global
//     JSON parser.
//   - The settings API gets express.json().
//   - /app serves the static settings page.
//
// Run with: `npm start` (needs env from .env — see .env.example).
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';

import { courierWebhookRouter } from './webhooks/courier.js';
import { telenowWebhookRouter, ensureTelenowHook, removeTelenowHook } from './webhooks/telenow.js';
import { getRedactedSettings, updateSettings, getSettings, AUTOMATIONS } from './settings.js';
import { listNdr, deleteAll } from './store.js';
import { TelenowClient } from './telenow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = (process.env.HOST || `http://localhost:${PORT}`).replace(/\/$/, '');

const app = express();
app.disable('x-powered-by');

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'courier-telenow' }));

// ── Webhook receivers (RAW body — must come before express.json) ──────────────
// Courier token checks and Telenow X-VoiceAI-Signature verify over raw bytes.
app.use('/webhooks', express.text({ type: '*/*', limit: '2mb' }), courierWebhookRouter);
app.use('/telenow/webhook', express.text({ type: '*/*', limit: '2mb' }), telenowWebhookRouter);

// ── Everything else can use JSON ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Landing → settings UI ───────────────────────────────────────────────────────
app.get('/', (_req, res) => res.redirect('/app'));

// ── Settings UI ────────────────────────────────────────────────────────────────
app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings API (consumed by /app)
// ─────────────────────────────────────────────────────────────────────────────

// GET current settings (redacted key) + the automation catalog for the UI.
app.get('/api/settings', (_req, res) => {
  res.json({
    settings: getRedactedSettings(),
    catalog: AUTOMATIONS.map(({ key, label, triggers }) => ({ key, label, triggers })),
  });
});

// GET recent NDR call records (newest first) for the dashboard.
app.get('/api/ndr', (_req, res) => {
  res.json({ ndr: listNdr(100) });
});

// POST settings update. If the API key changed, (re)subscribe the Telenow hook.
app.post('/api/settings', async (req, res) => {
  const before = getSettings().telenowApiKey;
  const patch = sanitizeSettingsPatch(req.body);
  const saved = updateSettings(patch);

  let hookStatus = '';
  if (patch.telenowApiKey && patch.telenowApiKey !== before) {
    try {
      const client = new TelenowClient(saved.telenowApiKey);
      await client.me(); // throws if invalid
      await ensureTelenowHook();
      hookStatus = 'Telenow connected and result webhook subscribed.';
    } catch (err) {
      hookStatus = `Saved, but Telenow setup failed: ${err.message}`;
    }
  }

  res.json({ settings: getRedactedSettings(), hookStatus });
});

// POST disconnect: unsubscribe the Telenow result webhook, then purge ALL local
// data (settings incl. the API key, callMap, hook, attempts, and the NDR records
// which hold customer PII). This is the in-app "delete my data" control for this
// single-tenant service; the /api routes here are unguarded by design (local,
// one-merchant), so this route stays consistent with the others.
app.post('/api/disconnect', async (_req, res) => {
  try {
    await removeTelenowHook();
  } catch (err) {
    // Best-effort: even if the remote unsubscribe fails, still purge locally.
    console.error('[server] removeTelenowHook during disconnect failed:', err.message);
  }
  deleteAll();
  res.json({ ok: true, disconnected: true });
});

// POST validate-key: optionally save a new key, then call Telenow /me.
app.post('/api/validate-key', async (req, res) => {
  if (req.body?.telenowApiKey) {
    updateSettings({ telenowApiKey: String(req.body.telenowApiKey) });
  }
  const key = getSettings().telenowApiKey;
  if (!key) {
    res.status(400).json({ error: 'no API key set' });
    return;
  }
  try {
    const me = await new TelenowClient(key).me();
    res.json(me);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Whitelist + coerce the settings patch coming from the browser so we never
 * persist arbitrary fields. Mirrors the shape settings.js understands.
 */
function sanitizeSettingsPatch(body = {}) {
  const out = {};
  if (typeof body.telenowApiKey === 'string' && body.telenowApiKey.trim()) {
    out.telenowApiKey = body.telenowApiKey.trim();
  }
  if (typeof body.storeName === 'string') out.storeName = body.storeName.trim();
  if (body.autoReattempt != null) out.autoReattempt = Boolean(body.autoReattempt);

  if (body.automations && typeof body.automations === 'object') {
    out.automations = {};
    for (const def of AUTOMATIONS) {
      const a = body.automations[def.key];
      if (!a) continue;
      out.automations[def.key] = {
        enabled: Boolean(a.enabled),
        agentId: typeof a.agentId === 'string' ? a.agentId.trim() : '',
        delayMinutes: Math.max(0, Number(a.delayMinutes) || 0),
        quietHours: a.quietHours
          ? {
              enabled: Boolean(a.quietHours.enabled),
              start: String(a.quietHours.start || '21:00'),
              end: String(a.quietHours.end || '09:00'),
              timezone: String(a.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      };
      if (out.automations[def.key].quietHours === undefined) {
        delete out.automations[def.key].quietHours;
      }
    }
  }

  // Courier NDR matchers (arrays of strings).
  if (body.couriers && typeof body.couriers === 'object') {
    out.couriers = {};
    if (body.couriers.shiprocket) {
      out.couriers.shiprocket = {
        ndrStatuses: toStringArray(body.couriers.shiprocket.ndrStatuses),
      };
    }
    if (body.couriers.delhivery) {
      out.couriers.delhivery = {
        ndrStatusTypes: toStringArray(body.couriers.delhivery.ndrStatusTypes),
        ndrNslCodes: toStringArray(body.couriers.delhivery.ndrNslCodes),
      };
    }
  }
  return out;
}

/** Coerce a value into a clean array of non-empty strings (accepts CSV too). */
function toStringArray(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nTelenow Courier NDR app listening on :${PORT}`);
  console.log(`  Public HOST:          ${HOST}`);
  console.log(`  Settings UI:          ${HOST}/app`);
  console.log(`  Shiprocket webhook →  ${HOST}/webhooks/shiprocket`);
  console.log(`  Delhivery webhook  →  ${HOST}/webhooks/delhivery`);
  console.log(`  Telenow webhooks   →  ${HOST}/telenow/webhook`);
  console.log(`  Telenow API base:     ${process.env.TELENOW_API_BASE || 'https://api.telenow.ai'}\n`);
});

export { app };
