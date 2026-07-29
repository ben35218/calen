// Automatic token metering for one-shot AI calls.
//
// Editing every `client.messages.create(...)` call site (there are ~15, several
// behind shared helpers/services) would be brittle. Instead we:
//   1. Establish an AsyncLocalStorage context in the `meter()` middleware,
//      carrying { req, action } for the whole request.
//   2. Patch the Anthropic SDK's `Messages#create` once at startup so any
//      non-streaming call made while a context is active records its
//      `response.usage` against the caller (recordTokens) and accumulates a
//      running total.
//   3. Wrap `res.json` (in meter) to auto-attach `tokensUsed` to AI responses.
//
// Streaming chat uses `messages.stream` (not `create`) and records tokens
// explicitly in chatStream.js, so there's no double counting. If context is
// somehow lost (e.g. through an odd async boundary), recording simply no-ops —
// the budget pre-check in meter() already ran, so enforcement is unaffected.

const { AsyncLocalStorage } = require('async_hooks');
const Anthropic = require('@anthropic-ai/sdk');
const { recordTokens } = require('../middleware/usageMeter');

const store = new AsyncLocalStorage();

// Run `fn` with an active metering context. Used by meter() to wrap next().
function withMeter(req, action, fn) {
  return store.run({ req, action, tokens: 0 }, fn);
}

// Tokens recorded so far in the active request (0 outside a metered request).
function meteredTokens() {
  return store.getStore()?.tokens || 0;
}

let patched = false;
function patchAnthropic() {
  if (patched) return;
  let proto;
  try {
    const probe = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'noop' });
    proto = Object.getPrototypeOf(probe.messages); // shared Messages resource prototype
  } catch (err) {
    console.error('[aiUsage] could not patch Anthropic SDK:', err.message);
    return;
  }
  if (!proto || typeof proto.create !== 'function') return;
  patched = true;

  const origCreate = proto.create;
  proto.create = function meteredCreate(...args) {
    // Streaming (`{ stream: true }`) — used by messages.stream() for chat — returns
    // an APIPromise with helper methods (.withResponse) the SDK relies on. Do NOT
    // wrap it (that strips those methods and breaks streaming); chat records its
    // tokens explicitly in chatStream.js.
    const streaming = args[0] && args[0].stream === true;
    const result = origCreate.apply(this, args);
    if (streaming || !result || typeof result.then !== 'function') return result;
    // Non-streaming create: record before resolving so `meteredTokens()` is
    // accurate right after the handler's `await`.
    return result.then(async (msg) => {
      const ctx = store.getStore();
      if (ctx && msg && msg.usage) {
        try { ctx.tokens += await recordTokens(ctx.req, msg.usage, ctx.action, msg.model); } catch { /* never break AI */ }
      }
      return msg;
    });
  };
}

module.exports = { withMeter, meteredTokens, patchAnthropic, store };
