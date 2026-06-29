// ─────────────────────────────────────────────────────────────────────────────
// store.js — persistence stub (file-based JSON) for a SINGLE-TENANT service.
//
// !!! REPLACE WITH A REAL DATABASE IN PRODUCTION !!!
// This module keeps everything in a single JSON file under DATA_DIR plus an
// in-memory cache. It is fine for local development and a single-process demo,
// but it is NOT safe for multi-instance/concurrent production deployments
// (no locking, last-write-wins, whole-file rewrites). Swap the logical stores
// below for tables in Postgres/MySQL/DynamoDB/etc.:
//
//   1. settings    — the merchant's config (see settings.js). Single object.
//   2. callMap     — sessionId → { automation, identifier, awb, courier } for
//                    the Telenow result write-back.
//   3. hook        — the single Telenow webhook subscription { id, secret }.
//   4. attempts    — per-key dedupe marks (awb+attempt) with TTL.
//   5. ndrRecords  — one row per failed-delivery (NDR) event + the call outcome.
//
// The Telenow API key lives inside `settings`. It is a secret — see the security
// note in README.md. Never log it.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

const DB_FILE = path.join(DATA_DIR, 'store.json');

/**
 * @typedef {{ settings: object|null, callMap: object, hook: object|null,
 *             attempts: object, ndrRecords: object, ndrSeq: number }} DB
 */

/** In-memory cache of the whole DB. Loaded once at startup. */
let db = load();

function emptyDb() {
  return {
    settings: null,
    callMap: {},
    hook: null,
    attempts: {},
    ndrRecords: {},
    ndrSeq: 0,
  };
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return { ...emptyDb(), ...parsed };
  } catch (err) {
    // Corrupt file shouldn't crash the app — start fresh.
    console.error('[store] failed to load DB, starting empty:', err.message);
    return emptyDb();
  }
}

/** Atomically-ish persist the in-memory DB to disk (write tmp + rename). */
function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[store] failed to persist DB:', err.message);
  }
}

// ── Settings (single object) ─────────────────────────────────────────────────
// Raw get/set — the typed model + defaults live in settings.js.

export function getSettingsRaw() {
  return db.settings;
}

export function setSettingsRaw(settings) {
  db.settings = settings;
  persist();
  return settings;
}

// ── Call map (sessionId → NDR record / automation) ───────────────────────────
// Persisted so the Telenow result webhook can find the originating NDR record.

/**
 * @param {string} sessionId  Telenow sessionId returned by initiate-call.
 * @param {{ automation: string, identifier?: string, ndrId?: number,
 *           awb?: string, courier?: string }} entry
 */
export function mapCall(sessionId, entry) {
  db.callMap[sessionId] = { ...entry, createdAt: new Date().toISOString() };
  persist();
}

export function getCall(sessionId) {
  return db.callMap[sessionId];
}

export function deleteCall(sessionId) {
  delete db.callMap[sessionId];
  persist();
}

// ── Per-key attempt dedupe ───────────────────────────────────────────────────
// Couriers redeliver NDR webhooks (on timeout/retry), so we record an attempt
// per stable key and refuse to place a second call for the same key within a TTL.
// The key is "ndr:awb:<awb>:<attempt>" (see automations/ndrRetry.js): the same
// webhook redelivered is deduped, but a GENUINELY NEW failed attempt (higher
// attempt number) gets a fresh key and re-calls. Atomic check-and-set so two
// near-simultaneous deliveries can't both pass the guard.

/**
 * Record an attempt for `key` IF one isn't already live. Returns true if this
 * caller "won" (should proceed to place the call), false if a live attempt
 * already exists (skip — duplicate).
 * @param {string} key   stable key, e.g. "ndr:awb:SR12345:2"
 * @param {number} ttlMs how long the attempt blocks re-attempts (default 7 days)
 */
export function markAttempt(key, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  if (!key) return true;
  const now = Date.now();
  const prev = db.attempts[key];
  if (prev && now - prev.at < (prev.ttlMs ?? ttlMs)) {
    return false; // a live attempt already exists → caller should skip
  }
  db.attempts[key] = { at: now, ttlMs };
  // Opportunistically GC expired entries so the map doesn't grow unbounded.
  for (const [k, v] of Object.entries(db.attempts)) {
    if (now - v.at >= (v.ttlMs ?? ttlMs)) delete db.attempts[k];
  }
  persist();
  return true;
}

/** Forget an attempt (e.g. to allow a retry after a failed placement). */
export function clearAttempt(key) {
  if (db.attempts[key]) {
    delete db.attempts[key];
    persist();
  }
}

// ── Telenow hook subscription (single) ───────────────────────────────────────
// We store the hook id + signing secret returned by POST /api/v1/hooks so we
// can verify inbound X-VoiceAI-Signature and clean up later.

/** @param {{ id: string, secret: string }} hook */
export function saveHook(hook) {
  db.hook = { ...hook, savedAt: new Date().toISOString() };
  persist();
}

export function getHook() {
  return db.hook;
}

export function deleteHook() {
  db.hook = null;
  persist();
}

// ── NDR records ──────────────────────────────────────────────────────────────
// One row per failed-delivery (NDR) event. We store it FIRST (so it appears in
// the dashboard even if the call is skipped — no phone / disabled / quiet hours),
// then place the voice retry and patch the row with the result. These rows hold
// PII (name/phone) — the purge helper below covers them.
//
// File-stub caveat (same as the rest of this module): swap for a DB table in
// production. We cap the collection to the most recent ~2000 rows so the JSON
// file doesn't grow without bound.

const MAX_NDR_RECORDS = 2000;

/**
 * Insert a new NDR record and return its auto-increment id.
 * @param {object} data  { courier, awb, orderId, customerName, phone, ndrReason,
 *                         attempt, status, currentStatus, trackingUrl, variables,
 *                         sessionId, agentId, disposition, summary, duration }
 * @returns {number} the new record id
 */
export function insertNdr(data = {}) {
  const id = (db.ndrSeq = (db.ndrSeq || 0) + 1);
  db.ndrRecords[id] = {
    id,
    createdAt: new Date().toISOString(),
    courier: data.courier ?? '',
    awb: data.awb ?? '',
    orderId: data.orderId ?? '',
    customerName: data.customerName ?? '',
    phone: data.phone ?? '',
    ndrReason: data.ndrReason ?? '',
    attempt: data.attempt ?? null,
    currentStatus: data.currentStatus ?? '',
    trackingUrl: data.trackingUrl ?? '',
    variables: data.variables ?? {},
    status: data.status ?? 'queued',
    sessionId: data.sessionId ?? null,
    agentId: data.agentId ?? null,
    disposition: data.disposition ?? '',
    summary: data.summary ?? '',
    duration: data.duration ?? null,
    reattempt: data.reattempt ?? '',
  };
  pruneNdr();
  persist();
  return id;
}

/** Patch an existing NDR record (shallow merge). No-op if it doesn't exist. */
export function updateNdr(id, patch = {}) {
  const rec = db.ndrRecords[id];
  if (!rec) return undefined;
  db.ndrRecords[id] = { ...rec, ...patch, updatedAt: new Date().toISOString() };
  persist();
  return db.ndrRecords[id];
}

/** @returns {object|undefined} the NDR record, or undefined. */
export function getNdr(id) {
  return db.ndrRecords[id];
}

/**
 * Find the most recent NDR record for an AWB (used by the result webhook to
 * resolve via the `ndr:<awb>` identifier when the sessionId map is missing).
 * @param {string} awb
 * @returns {object|undefined}
 */
export function findNdrByAwb(awb) {
  if (!awb) return undefined;
  const key = String(awb);
  return Object.values(db.ndrRecords)
    .filter((r) => String(r.awb) === key)
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
}

/** List NDR records, newest first, capped to `limit`. */
export function listNdr(limit = 100) {
  return Object.values(db.ndrRecords)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, limit);
}

/** Keep only the most recent MAX_NDR_RECORDS rows (file-stub bound). */
function pruneNdr() {
  const ids = Object.values(db.ndrRecords)
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(MAX_NDR_RECORDS)
    .map((r) => r.id);
  for (const id of ids) delete db.ndrRecords[id];
}

// ── Purge ────────────────────────────────────────────────────────────────────

/** Wipe everything (settings, callMap, hook, attempts, NDR records). */
export function deleteAll() {
  db = emptyDb();
  persist();
}
