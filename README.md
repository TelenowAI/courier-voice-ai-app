# Courier Voice AI — Failed-Delivery (NDR) Recovery & RTO Reduction by AI Voice | Telenow

**Turn every failed delivery attempt (NDR) into an instant AI voice call — reschedule the drop, fix the address, and cut Return-To-Origin (RTO) losses within minutes.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#-license)
[![Couriers](https://img.shields.io/badge/Couriers-Shiprocket_|_Delhivery-orange.svg)](#courier-webhook-setup)
[![Node](https://img.shields.io/badge/Node->=18-brightgreen.svg)](#-installation)
[![Powered by Telenow](https://img.shields.io/badge/Powered_by-Telenow-blue.svg)](https://telenow.ai)

**Courier Voice AI** is a free, open-source **logistics voice AI** service that connects your courier — **Shiprocket** or **Delhivery** — to the [Telenow](https://telenow.ai) voice-AI platform and turns **non-delivery reports (NDRs)** into **instant AI phone calls**. The moment a courier reports a **failed delivery** (customer not available, wrong or incomplete address, refused parcel, etc.), Telenow phones the customer with a natural **multilingual / Hindi voice agent** to **reschedule or confirm the address**, writes the outcome back onto the NDR record, and can **request a re-attempt** from the courier — no glue code to write. You bring your own Telenow account and `vai_live_…` API key (Telenow bills call usage on its own platform); the app itself is free to self-host. The result: faster **NDR recovery**, fewer **Return to Origin** parcels, and measurable **RTO reduction** for D2C and e-commerce sellers and logistics teams.

> **Free app — requires a Telenow account.** This service is free to run and open source. Telenow is a separate third-party **voice AI** platform that bills for call usage on its own pricing; you connect it with your own `vai_live_…` API key (Telenow → Developers → API Keys). No charges go through your courier.

## Table of Contents

- [✨ Features](#-features)
- [🚀 Installation](#-installation)
- [⚙️ Configuration](#️-configuration)
- [🧩 How it works](#-how-it-works)
- [🔌 Connect Telenow](#-connect-telenow)
- [📦 Courier webhook setup](#courier-webhook-setup)
- [📲 The call + the data passed to the agent](#the-call--the-data-passed-to-the-agent)
- [↩️ Optional re-attempt](#optional-re-attempt)
- [🪝 Telenow result webhooks (inbound)](#telenow-result-webhooks-inbound)
- [🔒 Security notes](#-security-notes)
- [✅ Production checklist](#-production-checklist)
- [🧪 Local round-trip test](#-local-round-trip-test)
- [🗂️ Project layout](#️-project-layout)
- [📞 About Telenow](#-about-telenow)
- [📄 License](#-license)

## ✨ Features

- **NDR → instant AI call.** A verified courier NDR webhook triggers an outbound Telenow **delivery confirmation call** in seconds — speed is the whole point, so the default delay is zero.
- **Shiprocket + Delhivery intake.** Dedicated, token-verified webhook endpoints for both couriers (`/webhooks/shiprocket`, `/webhooks/delhivery`), each parsing its own payload shape best-effort.
- **Reschedule & address confirmation by voice.** A natural **multilingual / Hindi voice agent** (and other Indian + global languages, via your Telenow agent) asks the customer to **reattempt delivery**, pick a better time, or fix an incomplete address.
- **Automatic write-back onto the NDR record.** The call's disposition, summary, and duration are written straight back onto the originating NDR row, so every outcome is visible in the dashboard.
- **Optional courier re-attempt.** When the customer wants the parcel re-attempted, the app can call the courier's re-attempt API (Shiprocket NDR action / Delhivery NDR-edit) automatically — or simply record the requested action if you'd rather keep a human in the loop.
- **Configurable NDR matchers.** Tune exactly which courier statuses count as a failed delivery (Shiprocket `current_status` substrings; Delhivery `StatusType=UD` + NSL codes) right from the settings page.
- **Per-account field-mapping override.** Courier payloads differ by account — drop in a `courier_telenow_extract(payload, courier)` function to remap any field without forking the parsers.
- **Smart dedupe (no double-dialing).** Calls are deduped on a stable `ndr:awb:<awb>:<attempt>` key, so a redelivered webhook collapses to one call while a genuinely new failed attempt re-calls. The mark is released on placement failure so a real retry still goes through.
- **Quiet hours.** Suppress calls inside a timezone-aware local window (re-checked at fire time for delayed calls) so customers aren't dialed at night.
- **E.164 phone normalization.** Customer numbers from couriers are normalized to E.164 before dialing; un-normalizable numbers are skipped, never dialed.
- **One-paste setup, no DB to stand up.** A single settings page validates your Telenow key, subscribes the result webhook, and runs on a file-based store you swap for a real database in production.
- **"Recent NDR calls" dashboard.** Every NDR — placed, scheduled, skipped, or completed — lands in a built-in table with masked phone numbers and the call outcome.
- **Secure by default.** Constant-time token checks on inbound courier webhooks, HMAC-SHA256 verification on inbound Telenow results, the API key never logged or sent to the browser, and a one-click **Disconnect & purge** that wipes all PII.
- **End-to-end local test harness.** `npm run roundtrip` exercises the entire integration chain on your machine with an in-process mock Telenow — no real courier, no real backend, no hosting required.

## 🚀 Installation

This is a standalone Node.js 18+ (Express) service. Clone it, install, configure, and run:

```bash
git clone https://github.com/TelenowAI/courier-voice-ai-app.git
cd courier-voice-ai-app

npm install
cp .env.example .env      # fill in the values below
npm start                 # or: npm run dev  (node --watch)
```

You need a public HTTPS URL (the couriers and Telenow both call you). In dev, use a tunnel:

```bash
ngrok http 3000           # then set HOST=https://<id>.ngrok-free.app in .env
```

Then open `HOST/app`, paste your Telenow API key, and follow [Connect Telenow](#-connect-telenow).

## ⚙️ Configuration

Settings live in two places: **infrastructure secrets** in `.env`, and your **Telenow API key + automation config** in the in-app settings page (`/app`).

| Var | Required | Description |
| --- | --- | --- |
| `HOST` | ✅ | Public HTTPS base URL of this service (no trailing slash). Builds the Telenow webhook target + the courier webhook URLs you paste into the dashboards. |
| `PORT` | | Listen port (default `3000`). |
| `TELENOW_API_BASE` | | Telenow API base (default `https://api.telenow.ai`). |
| `DATA_DIR` | | Where the file store persists (default `./data`). |
| `DEFAULT_PHONE_COUNTRY` | | ISO-2 country for E.164 normalization of local numbers (default `IN`). |
| `SHIPROCKET_WEBHOOK_TOKEN` | ✅ (for Shiprocket) | Token you set in Shiprocket → Settings → API → Webhooks; Shiprocket echoes it in the `x-api-key` header. |
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | | Optional. Only for the **optional** re-attempt API (login → Bearer token, cached ~10 days). Leave blank to just record the requested action. |
| `DELHIVERY_WEBHOOK_TOKEN` | ✅ (for Delhivery) | Shared token; accepted as `?token=…` on the URL or an `x-delhivery-token` header. |
| `DELHIVERY_API_TOKEN` | | Optional. Bearer token for the **optional** Delhivery re-attempt/NDR-edit API. |

> The **Telenow API key is not an env var** — you paste your `vai_live_…` key in the settings page (`/app`), where it is validated and stored on disk.

## 🧩 How it works

```
Shiprocket / Delhivery ──NDR webhook(token)──▶  this service  ──POST /api/sessions/initiate-call──▶  Telenow
        ▲                                          │   ▲                                               │
        └──(optional) re-attempt API───────────────┘   └──────POST /telenow/webhook (HMAC) ◀───────────┘
                                                              (call.ended / call.analyzed)
```

1. A courier posts a status/NDR webhook. We **verify the shared token**, parse the payload best-effort, and decide whether it's a failed delivery (configurable matcher).
2. We **store an NDR record** (so it always shows in the dashboard), normalize the phone to E.164, and **place a Telenow AI call** with the order/AWB context.
3. On the **call result webhook** we resolve the record (by `ndr:<awb>` identifier / session map), mark it **completed** with the disposition + summary + duration, and — if the customer asked to re-attempt and you enabled it — optionally call the **courier's re-attempt API**.

- **Tech**: Node 18+ (global `fetch`), Express, `dotenv`. No DB — a file-based store stub you swap in production.
- **Auth**: a per-service Telenow **API key** (`X-API-Key`) you paste in the settings page, validated via `GET /api/v1/me`; a **shared token** per courier webhook you verify constant-time.

## 🔌 Connect Telenow

1. Open `HOST/app`.
2. Paste your Telenow API key (validated via `GET /api/v1/me`), set the **store name**, pick the **agent ID** for the NDR-retry automation, toggle it **enabled**, and set quiet hours if needed.
3. Saving a new key **subscribes the Telenow result webhook** via `POST /api/v1/hooks` (events `call.ended`, `call.analyzed`, source `courier`) and stores the returned **signing secret** used to verify inbound results.

## Courier webhook setup

### Shiprocket

1. In Shiprocket go to **Settings → API → Webhooks** (Configure Webhooks).
2. Set the webhook URL to **`HOST/webhooks/shiprocket`**.
3. Set a **token / API key** in that page and put the SAME value in `SHIPROCKET_WEBHOOK_TOKEN`. Shiprocket sends it back on every webhook in the **`x-api-key`** header; we verify it constant-time (bad token → `401`).
4. Enable the status/NDR events. We treat a delivery as an NDR when `current_status` contains any of the configured matchers (default: `ndr`, `undelivered`, `undeliverable`, `delivery attempt failed`) — tune these in the settings page.

**Assumed Shiprocket field paths** (override with a `courier_telenow_extract(payload, courier)` function — see `src/couriers/shiprocket.js`):

| Normalized | Shiprocket source (first match wins) |
| --- | --- |
| `awb` | `awb` / `awb_code` / `awbcode` / `shipment.awb_code` |
| `orderId` | `order_id` / `order_number` / `channel_order_id` / `shipment.order_id` |
| `currentStatus` | `current_status` / `status` / `shipment_status` / `shipment.current_status` |
| `customerName` | `customer_name` / `name` / `shipment.customer_name` |
| `customerPhone` | `customer_phone` / `phone` / `customer_mobile` / `shipment.customer_phone` |
| `ndrReason` | `ndr_reason` / `reason` / `remark` / `comments` / `ndr.reason` |
| `attempt` | `attempt` / `attempts` / `ndr_attempts` / `delivery_attempts` / `ndr.attempt` |
| `trackingUrl` | `tracking_url` / `track_url` / `shipment.tracking_url` |

### Delhivery

1. Ask Delhivery to register a **status push** to **`HOST/webhooks/delhivery?token=YOUR_TOKEN`** (or configure the `x-delhivery-token` header). Put the same value in `DELHIVERY_WEBHOOK_TOKEN`.
2. Delhivery pushes a `Shipment` object. We treat a shipment as an NDR when `Status.StatusType` is `UD` (undelivered) or the NSL code/reason matches a configured substring (default: `ndr`, `consignee`, `not available`, `refused`, `address`). Tune these in the settings page.

**Assumed Delhivery field paths** (same override hook):

| Normalized | Delhivery source (first match wins; under `Shipment`) |
| --- | --- |
| `awb` | `AWB` / `Waybill` / `WaybillNo` |
| `orderId` | `ReferenceNo` / `OrderId` / `Order` |
| `currentStatus` | `Status.Status` / `Status` |
| `statusType` | `Status.StatusType` / `StatusType` (`UD` = undelivered) |
| `nslCode` | `Status.NSLCode` / `NSLCode` |
| `customerName` | `Consignee.Name` / `ConsigneeName` |
| `customerPhone` | `Consignee.Telephone[0]` / `Consignee.Phone` / `ConsigneePhone` |
| `ndrReason` | `Status.Instructions` (falls back to the NSL code) |
| `attempt` | `Status.Attempt` / `Attempt` / `NumberOfAttempts` |

## The call + the data passed to the agent

Each NDR builds a `variables` object and calls `POST /api/sessions/initiate-call` with the agent, the E.164 number, `identifier: "ndr:<awb>"`, and `machineDetection: "hangup"`. We persist `sessionId → record` so the result webhook can find the NDR row.

Variables: `customer_name, awb, order_id, courier, ndr_reason, attempt, tracking_url, store_name`.

### Dedupe key

`ndr:awb:<awb>:<attempt>` (attempt number from the payload). The **same webhook redelivered** is deduped (couriers retry on timeout); a **genuinely new failed attempt** arrives with a higher `attempt` number → a different key → a real re-call. The dedupe mark is **released on placement failure** so a redelivery can retry.

## Optional re-attempt

If the call disposition indicates the customer wants the parcel re-attempted **and** `autoReattempt` is enabled **and** courier credentials exist, we ask the courier to retry:

- **Shiprocket**: `POST /v1/external/ndr/{awb}/action` with `action: "re-attempt"`, using a Bearer token from `POST /v1/external/auth/login` (cached ~10 days). Needs `SHIPROCKET_EMAIL` + `SHIPROCKET_PASSWORD`.
- **Delhivery**: an NDR/edit action (endpoint varies by integration tier — see the `TODO` in `src/couriers/delhivery.js`). Needs `DELHIVERY_API_TOKEN`.

If credentials are absent (or `autoReattempt` is off), we **just record the requested action** on the NDR record — no courier call.

## Telenow result webhooks (inbound)

We subscribe with `POST /api/v1/hooks` (`events: ["call.ended","call.analyzed"]`, `source: "courier"`, `includeTranscript: true`) and store the returned signing **secret**. Telenow then POSTs results to `HOST/telenow/webhook` with:

```
X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of the raw body>
X-VoiceAI-Event:     call.ended | call.analyzed
X-VoiceAI-Delivery:  <uuid>
```

We verify by recomputing the HMAC over the **raw body** with that secret (**HEX**, constant-time, base64 fallback), resolve the NDR record via the persisted `sessionId` (falling back to the `ndr:<awb>` identifier), and decide the disposition from `analysis.disposition` (with a summary/transcript keyword fallback). Bad signature → `401`.

## 🔒 Security notes

- **HMAC / token in both directions.** Inbound courier webhooks are verified against the merchant-configured shared token (constant-time, fail-closed when unset); inbound Telenow webhooks are verified against the per-hook signing secret. Bad signatures get `401`. Webhook routes receive the **raw body** (mounted before the JSON parser) so the bytes match exactly.
- **E.164 normalization.** Phone numbers from couriers are normalized to E.164 before dialing (`src/util/phone.js`); un-normalizable numbers are skipped, never dialed.
- **Never log the API key.** The Telenow `X-API-Key` is never logged or sent to the browser — the settings page only ever sees a masked hint. Phone numbers are masked in logs and in the dashboard.
- **Quiet hours.** Calls are suppressed inside the automation's local quiet-hours window (and re-checked at fire time for delayed calls).
- **Data purge.** NDR records hold customer PII (name + phone). To wipe everything (settings incl. the API key, the call map, the hook, dedupe marks, and all NDR records), use **Disconnect & purge data** in `/app` (`POST /api/disconnect`, which also unsubscribes the Telenow result webhook). For an ops-level purge, deleting the `DATA_DIR` directory (default `./data`) removes the entire on-disk store; restart the app afterwards.

## ✅ Production checklist

- [ ] **Swap the file store for a real DB.** `src/store.js` is an in-memory + JSON-file stub (no locking, last-write-wins, single-process). Move settings/callMap/hook/attempts/ndrRecords to Postgres/MySQL/DynamoDB.
- [ ] **Durable scheduling for delays.** Delayed calls use `setTimeout` — it doesn't survive a restart or scale across instances. Use a job queue (BullMQ/Redis, SQS).
- [ ] **Host on HTTPS** with a stable `HOST`. Re-subscribe the Telenow webhook if the URL changes.
- [ ] **Confirm courier payload shapes for your account** and adjust the field maps / NDR matchers (the parsers guard everything, but accounts differ). Use the `courier_telenow_extract` override.
- [ ] **Confirm the courier re-attempt endpoints** for your integration tier (esp. Delhivery's NDR action API) before enabling `autoReattempt`.
- [ ] **Per-customer call frequency caps / suppression list** (don't call the same customer repeatedly across attempts).

## 🧪 Local round-trip test

A self-contained harness proves the **entire integration chain** end-to-end on your machine — **no real courier, no real Telenow backend, and no hosting required**. It drives the service's real modules (the wired Express app, the Shiprocket token verifier, `placeCall`, the Telenow client, the result-webhook receiver and the NDR store), with an in-process mock Telenow API.

```bash
npm run roundtrip
```

What it exercises:

1. Seeds the Telenow hook + settings directly via `store.js`/`settings.js`, enabling the `ndrRetry` automation with an agent id and a Telenow API key.
2. POSTs a **token-authenticated** Shiprocket NDR webhook to `/webhooks/shiprocket` (`x-api-key: <token>`, `current_status: "Undelivered"`), which the verifier accepts.
3. Asserts the mock Telenow received an `initiate-call` with the expected **E.164** number, an **`ndr:<awb>`** identifier, the agent id, and the `awb`/`courier`/`store_name` variables; and that an NDR record was stored and moved to `placed`.
4. Fires a `call.analyzed` **result webhook** back at `/telenow/webhook`, signed with the mock's hook secret (`X-VoiceAI-Signature: sha256=<hex>`), and asserts the record is updated to `completed` / disposition `reattempt` / duration recorded, with the re-attempt logged as requested.
5. Asserts a result webhook with a **wrong signature** is rejected with `401` and leaves the record unchanged.
6. Asserts **dedupe**: the same webhook redelivered places **no** second call, but a **new attempt number** does; and a **wrong courier token** → `401` with no call.

It prints `PASS`/`FAIL` per check and exits non-zero on any failure. It uses a throwaway temp `DATA_DIR` (removed on exit) and dummy credentials, so it needs no real keys and touches no network. Test files live in `test/` (`test/mock-telenow.mjs`, `test/roundtrip.mjs`).

## 🗂️ Project layout

```
src/
  server.js              Express app: routers, body parsers, settings API
  telenow.js             Telenow API client (me, initiateCall, createHook, listHooks, deleteHook)
  settings.js            Single-tenant settings model + defaults + redaction
  store.js               Persistence STUB (file JSON) — swap for a DB
  webhooks/
    courier.js           Shiprocket + Delhivery NDR receivers (token verify) → dispatch
    telenow.js           Telenow result receiver (HMAC) + write-back + hook lifecycle + re-attempt
  couriers/
    shiprocket.js        verify + parse + isNdr + optional login/re-attempt API
    delhivery.js         verify + parse + isNdr + optional re-attempt API
  automations/
    _base.js             placeCall(): gating (enabled/key/agent/quiet/dedupe) + dial + map
    ndrRetry.js          build variables, store NDR record, place the call
  util/
    phone.js             E.164 normalization
    quietHours.js        timezone-aware quiet-hours check
  public/app.html        settings UI + "Recent NDR calls" table
test/
  mock-telenow.mjs       in-process mock Telenow API
  roundtrip.mjs          end-to-end local harness
```

## 📞 About Telenow

[Telenow](https://telenow.ai) is a voice-AI platform for building natural, multilingual (English, Hindi, and more) AI phone agents that make and take real calls — for delivery confirmation, NDR recovery, lead follow-up, support, and more. This courier app is one of several open-source connectors that plug everyday logistics and commerce events into Telenow agents. Get started with the [docs](https://telenow.ai/docs) and [pricing](https://telenow.ai/#pricing), and grab your `vai_live_…` API key from Telenow → Developers → API Keys.

## 📄 License

Released under the **MIT License**.

---

Support: [support@telenow.ai](mailto:support@telenow.ai) · [Privacy](https://telenow.ai/privacy) · [Terms](https://telenow.ai/terms) · [Pricing](https://telenow.ai/#pricing)
