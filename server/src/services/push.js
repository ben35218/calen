const webpush = require('web-push');
const axios = require('axios');

// Two push transports:
//   - Web Push (browsers). VAPID keys from the environment; generate once with
//     `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY /
//     VAPID_PRIVATE_KEY (+ VAPID_SUBJECT, a mailto: or url).
//   - Expo push (native iOS/Android app). A single HTTPS endpoint fans out to
//     APNs + FCM; no per-platform certificates. EXPO_ACCESS_TOKEN is optional
//     (raises rate limits / enables enhanced security) — basic sends work
//     without it, so native push is always considered available.
const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:admin@household-calendar.app';
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';

function expoHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
  return headers;
}

const webConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (webConfigured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn('[push] VAPID keys not set — web push disabled');
}

// True if any transport can deliver. Native (Expo) needs no config, so push is
// always "configured" — but publicKey() still reflects web-push availability
// for the browser subscribe handshake.
function isConfigured() {
  return true;
}

function publicKey() {
  return PUBLIC_KEY || null;
}

function isNative(sub) {
  return sub?.platform === 'ios' || sub?.platform === 'android' || Boolean(sub?.expoToken);
}

// Build the Expo push message for a payload. A `silent: true` payload becomes a
// DATA-ONLY message (no title/body, `_contentAvailable` for the iOS background
// wake) — the record-change poke lane: the device syncs its replica without the
// user seeing anything. Exported for tests.
function buildExpoMessage(subscription, payload) {
  if (payload.silent) {
    return { to: subscription.expoToken, data: payload.data || {}, _contentAvailable: true };
  }
  return {
    to: subscription.expoToken,
    title: payload.title,
    body: payload.body,
    data: payload.data || payload,
    // An alerting push should present like one: audible on iOS, and routed to
    // the app's Android channel. `priority: 'high'` wakes a Doze-d Android
    // device for time-sensitive alerts (invites, security); iOS ignores it.
    sound: 'default',
    priority: 'high',
    channelId: 'default',
  };
}

// Deliver to a native device via Expo. Throws an error tagged { statusCode: 410 }
// when Expo reports the token is no longer registered, so callers prune it.
// Returns the accepted ticket ({ status: 'ok', id }) — the immediate ticket is
// only half the story: most DeviceNotRegistered results arrive in the RECEIPT
// (fetchExpoReceipts, run later by jobs/pushReceipts.js), so callers should
// persist the ticket id for the receipt pass.
async function sendToExpo(subscription, payload) {
  const message = buildExpoMessage(subscription, payload);
  // Always post the array form: the response's `data` is then reliably an
  // array of tickets. (The old single-object read left ticket errors — e.g.
  // InvalidCredentials when the APNs key is missing — invisible, so a send
  // that could never deliver still counted as "sent".)
  const { data } = await axios.post(EXPO_PUSH_URL, [message], { headers: expoHeaders() });
  const ticket = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (ticket?.status === 'error') {
    const err = new Error(ticket.message || 'Expo push error');
    if (ticket.details?.error === 'DeviceNotRegistered') err.statusCode = 410;
    throw err;
  }
  return ticket || null;
}

// Batch-fetch delivery receipts for previously issued ticket ids. Returns
// Expo's map of ticketId → { status, message?, details? }; a ticket absent
// from the map has no receipt yet (or Expo already dropped it). Callers cap
// `ids` at 300 per request (the getReceipts batch limit).
async function fetchExpoReceipts(ids) {
  const { data } = await axios.post(EXPO_RECEIPT_URL, { ids }, { headers: expoHeaders() });
  return data?.data || {};
}

// Send to one subscription (web or native). Resolves on success or throws
// { statusCode } so callers can prune subscriptions the platform has expired
// (web: 404/410; Expo: DeviceNotRegistered → 410). A native send resolves with
// its Expo ticket (web sends resolve undefined).
async function sendToSubscription(subscription, payload) {
  if (isNative(subscription)) {
    return sendToExpo(subscription, payload);
  }
  // Silent pokes are a native-app concern (background replica refresh); a
  // browser sub can't act on a notification it never shows — skip quietly.
  if (payload.silent) return;
  if (!webConfigured) throw new Error('Web push not configured');
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

module.exports = { isConfigured, publicKey, sendToSubscription, buildExpoMessage, fetchExpoReceipts };
