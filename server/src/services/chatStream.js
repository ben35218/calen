// Shared Server-Sent-Events runner for the AI chat assistants.
//
// Runs the same agentic tool loop the chat routes used before, but streams the
// result to the browser instead of buffering it. Events emitted:
//   event: text   data: { delta }      — incremental assistant text
//   event: tool   data: { name }       — a tool call started (for an activity hint)
//   event: done   data: { reply, followups, ...sideEffects }
//   event: error  data: { message }
//
// Side effects (e.g. navigateTo, tasksCreated) are collected via the caller's
// `collectSideEffects(block, result, acc)` callback, which may also mutate the
// tool result in place to strip private fields before it's sent back to the model.

const { recordTokens, recordWebSearches, recordChatCredits } = require('../middleware/usageMeter');
const { usageBreakdown } = require('./credits');
const { verifyPlaceStatus } = require('./geo');

// Anthropic's server-side web-search tool, offered to every chat assistant so
// Calen can look things up (businesses, hours, ideas, current facts) when the
// household's own data can't answer. Versioned per model family: the
// dynamic-filtering variant needs Opus 4.6+ / Sonnet 4.6; Haiku only supports
// the basic one. Searches execute on Anthropic's side inside the same API call
// — no executeTool handler. Their result TOKENS are already billed by the
// token-priced chat debit, so streamChat tallies
// `usage.server_tool_use.web_search_requests` only to RECORD the small
// per-search API fee for reconciliation (recordWebSearches) — it is not a
// separate credit charge.
const WEB_SEARCH_MAX_USES = 3;
function webSearchTool(model = '') {
  return {
    type: String(model).includes('haiku') ? 'web_search_20250305' : 'web_search_20260209',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES,
  };
}

// System nudge appended by the chat routes: the 4.6-family models are
// conservative about reaching for tools, and a prescriptive when-to-use line
// measurably lifts should-search rate. The link-markup rules make places and
// search suggestions tappable in the app (mobile lib/chatLinks parses them:
// places open an in-app Google Maps preview, searches launch in the browser);
// the client builds the URLs, so the model must never emit raw URLs.
const WEB_SEARCH_SYSTEM_NOTE =
  '\n\nYou can search the web (web_search) for current, real-world information — ' +
  'local businesses and venues, hours, prices, ideas, recommendations — when the ' +
  "household's own data can't answer. Never search for the household's private data." +
  '\nWhen your reply mentions a specific business, venue, or public place, wrap its ' +
  'name as [Name](place:Name, City) — e.g. [Saunders Farm](place:Saunders Farm, Munster ON) — ' +
  'so the app links it to its map listing. When you suggest a web search the user could ' +
  'run themselves, write it as [search "query"](search:query). Use only these two link ' +
  'forms; never write raw URLs.' +
  '\nBefore you recommend a specific business or venue, call verify_place on it to confirm ' +
  "it's real and still operating. Silently drop any whose status is closed_permanently or " +
  'not_found and offer a different one instead — never present a permanently closed place. ' +
  'A status of operational, closed_temporarily, or unknown is fine to suggest. Use the name, ' +
  'address, and phone verify_place returns when you name the place or pre-fill a form.';

// The mobile app renders replies as plain text (lib/markdown flattens bold,
// bullets, and links; there is no markdown-table support), so a "| … |" table
// arrives as unreadable raw pipes and dashes. Steer the model away from tables
// toward line-oriented formatting the flattener handles. Appended to every
// assistant's system prompt centrally in streamChat.
const RESPONSE_FORMAT_NOTE =
  '\n\nThe app shows your reply as plain text and does NOT render markdown ' +
  'tables — never use them. Present availability, options, or any tabular data ' +
  'as short labeled lines ("Label: value") or a simple bulleted list, one item ' +
  'per line, rather than a "| … |" table.';

// Compose the cached system block every chat turn sends: append the shared
// RESPONSE_FORMAT_NOTE to the route's system string and wrap it as one
// cache_control'd text block. Non-string / empty system passes through
// unchanged (callers may supply pre-built blocks). Pure + exported so the
// note-injection is unit-testable without driving the SSE stream.
function buildCachedSystem(system) {
  if (typeof system !== 'string' || !system.length) return system;
  return [
    {
      type: 'text',
      text: system + RESPONSE_FORMAT_NOTE,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Image types Claude accepts inline. HEIC and other formats can't be sent as an
// image block, so they fall through to the filename-note path below.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Data minimization (spec: ai-assistant.md): cap how much of the resent chat
// history reaches the model each turn.
const MAX_HISTORY_MESSAGES = 20;

// Follow-up chips come from the SAME conversation via this tool — the model
// calls it at the end of its turn. This replaced a second model call that
// re-sent the transcript to a separate (uncached) context.
const FOLLOWUPS_TOOL_NAME = 'suggest_followups';
const FOLLOWUPS_TOOL = {
  name: FOLLOWUPS_TOOL_NAME,
  description:
    'Call this exactly once at the END of your turn, alongside or after your final reply text: suggest 2-3 short things the user might tap to say next. First person, max ~6 words each, concrete next actions (confirmations, refinements, follow-up questions) — no generic chit-chat. Do not mention or repeat the suggestions in your reply text, and do not add reply text after calling this.',
  input_schema: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: { type: 'string' },
        description: '2-3 short follow-up chips, phrased as the user',
      },
    },
    required: ['suggestions'],
  },
};

// Place verification: a server-executed tool every chat assistant gets (like
// FOLLOWUPS_TOOL, it's auto-appended in the loop, not declared per-route) so
// Calen can confirm a business is real and still operating before recommending
// it, and drop permanently-closed ones (spec: ai-assistant.md). It runs a Google
// Places text search (services/geo.verifyPlaceStatus) biased to the household's
// area. Maps is un-metered ("unlimited on every tier"), so like the other
// internal Places calls this isn't credit-charged; the per-turn cap below just
// bounds runaway volume within a single turn.
const PLACE_VERIFY_MAX_USES = 6;
const PLACE_VERIFY_TOOL_NAME = 'verify_place';
const PLACE_VERIFY_TOOL = {
  name: PLACE_VERIFY_TOOL_NAME,
  description:
    'Confirm a specific real-world business or venue exists and is still operating BEFORE you recommend it. Pass the place name plus its city/area, e.g. "Republica Café, Ottawa ON". Returns { status, name, address, phone } where status is "operational", "closed_temporarily", "closed_permanently", "unknown" (Google publishes no status — treat as OK to suggest), or "not_found" (no match). Never recommend a place whose status is "closed_permanently" or "not_found" — choose another and verify that one. Use the returned name/address/phone when you name the place or pre-fill a form. You can call this a few times per turn to vet a shortlist.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Business/venue name plus its city or area, e.g. "Saunders Farm, Munster ON"',
      },
    },
    required: ['query'],
  },
};

// Moving conversation cache breakpoint: mark the last content block of the
// LAST USER MESSAGE with cache_control, copy-on-write (the stored messages are
// never mutated, so markers can't accumulate across loop iterations). With the
// system+tools prefix already cached (buildCachedSystem), this extends the
// cached prefix over the conversation itself: round trip N reads round trip
// N−1's history + tool results at ~0.1× input, and a follow-up turn within
// the 5-minute TTL reads the whole prior turn. The marker goes on the last
// USER message (not the last message outright) because after a `pause_turn`
// the tail is an assistant message holding server_tool_use / web-search
// blocks, which don't accept cache_control — a user message's last block is
// always text/image/document/tool_result, all cacheable. Budget: 1 system +
// 1 moving = 2 of the 4 allowed breakpoints.
function withMessageCacheMarker(messages) {
  const idx = messages.map((m) => m.role).lastIndexOf('user');
  if (idx < 0) return messages;
  const m = messages[idx];
  const blocks = typeof m.content === 'string'
    ? [{ type: 'text', text: m.content }]
    : (Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : null);
  if (!blocks || !blocks.length) return messages;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
  const out = messages.slice();
  out[idx] = { ...m, content: blocks };
  return out;
}

// Sanitized chips from a suggest_followups tool_use block: strings only,
// trimmed, max 3.
function followupsFromBlock(block) {
  return (Array.isArray(block.input?.suggestions) ? block.input.suggestions : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .slice(0, 3);
}

// Last MAX_HISTORY_MESSAGES entries, trimmed so the window starts on a user
// message (the API requires the first message to be from the user).
function capHistory(messages) {
  let recent = messages.slice(-MAX_HISTORY_MESSAGES);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  return recent.length ? recent : messages.slice(-1);
}

// Turn a client chat message into the Anthropic `content` field. Plain messages
// stay a string; a message with attachments becomes an array of content blocks:
// each image/PDF attachment as its own block, then the user's text last. Files
// Claude can't read (e.g. HEIC, .eml) are announced as a short text note so the
// model at least knows something was attached.
//
// Only the LATEST user message carries raw attachment bytes
// (isLatestUserMessage): older attachments were already seen when their turn
// ran, and re-uploading them re-tokenizes ~1.5k tokens per image on EVERY
// turn × every round trip. Historical attachments become a short text note;
// if the model genuinely needs to re-inspect one, it can ask the user to
// re-attach.
function toApiContent(message, isLatestUserMessage = true) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) return message.content;

  const blocks = [];
  for (const a of attachments) {
    if (!isLatestUserMessage) {
      blocks.push({ type: 'text', text: `[Attachment "${a.name || 'file'}" (${a.type || 'unknown type'}) was sent earlier in this conversation — ask the user to re-attach it if you need to look at it again.]` });
    } else if (a.kind === 'image' && a.data && SUPPORTED_IMAGE_TYPES.has(a.type)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } });
    } else if (a.kind === 'document' && a.data && a.type === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    } else {
      blocks.push({ type: 'text', text: `[Attached file "${a.name || 'file'}" (${a.type || 'unknown type'}) — I can't view this file type.]` });
    }
  }
  if (message.content) blocks.push({ type: 'text', text: message.content });
  // A message must have some content; if the text was empty and nothing usable
  // attached, fall back to a placeholder so the API call doesn't reject.
  return blocks.length ? blocks : message.content || '(no content)';
}

async function streamChat(res, opts) {
  const {
    client,
    // Default to Sonnet 4.6 (paid-tier model). Free-tier callers pass the
    // cheaper Haiku model explicitly. The old Opus 4.8 default was the single
    // biggest cost driver and has been retired here.
    model = 'claude-sonnet-4-6',
    system,
    tools,
    messages,
    executeTool,
    collectSideEffects,
    maxTokens = 2048,
    // req + action let us meter token usage. One chat = several Claude calls
    // (initial + one per tool round-trip); we sum tokens across the whole loop
    // PER TOKEN TYPE (cache reads cost ~0.1× input — pricing them separately
    // is what keeps chat cheap), debit the turn's token-based credit cost once
    // (recordChatCredits), and report the whole-credit charge to the client so
    // it can show "N credits".
    req,
    action = 'chat',
    // Optional hook to force a fixed set of follow-up chips based on the side
    // effects of this turn (e.g. show "Save this to my calendar" / "Edit in
    // form" after the assistant drafts an event) instead of the generated ones.
    // Return an array to override, or a falsy value to fall back to generation.
    followupsOverride,
  } = opts;
  let tokensUsed = 0; // display sum (echoed in the done event)
  const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // priced per type

  // Prompt caching: the system prompt + tool definitions are identical on every
  // turn, so cache them as one prefix (render order is tools → system, so a
  // breakpoint on the last system block caches both). Cache reads cost ~0.1×
  // input. A second, MOVING breakpoint rides the conversation itself
  // (withMessageCacheMarker, applied per request in the loop) so history and
  // accumulated tool results are read from cache too instead of re-sent as
  // fresh input on every round trip.
  const cachedSystem = buildCachedSystem(system);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const capped = capHistory(messages);
  const lastUserIdx = capped.map((m) => m.role).lastIndexOf('user');
  const apiMessages = capped.map((m, i) => ({ role: m.role, content: toApiContent(m, i === lastUserIdx) }));
  const sideEffects = {};
  let accumulated = '';
  let suggestedFollowups = [];
  let webSearches = 0;
  // Bias verify_place to the household's area (same coords source as
  // routes/places.js — the plaintext lat/lon the weather geocoder caches).
  const homeHh = req?.household || req?.user;
  const placeBias = { lat: homeHh?.lat, lon: homeHh?.lon };
  let placeVerifyUses = 0;
  // The dynamic-filtering `web_search_20260209` variant runs each search inside a
  // code-execution container (the model writes Python that calls web_search()).
  // When a turn ALSO ends on a client tool_use (e.g. verify_place) we resend the
  // history to return the tool result — and the API then requires the SAME
  // container id, or it 400s ("container_id is required when there are pending
  // tool uses generated by code execution"). The id is only surfaced on a raw
  // stream event (message_delta.container) — `finalMessage()` drops it — so
  // capture it live and thread it onto every follow-up request.
  let containerId = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = {
        model,
        max_tokens: maxTokens,
        system: cachedSystem,
        tools: [...tools, FOLLOWUPS_TOOL, PLACE_VERIFY_TOOL],
        messages: withMessageCacheMarker(apiMessages),
      };
      if (containerId) params.container = containerId;
      const stream = client.messages.stream(params);
      stream.on('text', (delta) => {
        accumulated += delta;
        send('text', { delta });
      });
      // Server tools (web search) execute inside the API call — no tool_use
      // stop — so surface their activity hint from the raw stream events, and
      // capture the code-execution container id wherever it appears (it rides
      // message_delta, but check the known paths defensively).
      stream.on('streamEvent', (e) => {
        if (e?.type === 'content_block_start' && e.content_block?.type === 'server_tool_use') {
          send('tool', { name: e.content_block.name });
        }
        const cid = e?.container?.id || e?.message?.container?.id || e?.delta?.container?.id;
        if (cid) containerId = cid;
      });

      const final = await stream.finalMessage();
      // Record this call's tokens (analytics; best-effort) and accumulate the
      // per-type counts the turn debit is priced from.
      if (req) { try { tokensUsed += await recordTokens(req, final.usage, action, model); } catch { /* never break chat */ } }
      const callUsage = usageBreakdown(final.usage);
      for (const type of Object.keys(turnUsage)) turnUsage[type] += callUsage[type];
      webSearches += final.usage?.server_tool_use?.web_search_requests || 0;

      if (final.stop_reason === 'end_turn') break;

      // A server-side tool loop (web search) hit its iteration cap mid-turn.
      // Append the partial assistant turn and re-send — the API detects the
      // trailing server_tool_use block and resumes where it left off.
      if (final.stop_reason === 'pause_turn') {
        apiMessages.push({ role: 'assistant', content: final.content });
        continue;
      }

      if (final.stop_reason !== 'tool_use') {
        send('error', { message: `Unexpected stop reason: ${final.stop_reason}` });
        return res.end();
      }

      // Follow-up chips are fire-and-forget: when the model ends its turn with
      // ONLY suggest_followups (its reply text already streamed), harvest the
      // chips and stop — the extra API call that would just acknowledge
      // `{"ok":true}` and return end_turn re-reads the whole context for no
      // new output. If the model called followups BEFORE writing any reply
      // text, fall through so it gets the result and continues to the reply;
      // same when real tools ran alongside (their results matter).
      const clientToolUses = final.content.filter((b) => b.type === 'tool_use');
      const onlyFollowups = clientToolUses.length > 0 &&
        clientToolUses.every((b) => b.name === FOLLOWUPS_TOOL_NAME);
      if (onlyFollowups && accumulated.trim()) {
        for (const block of clientToolUses) suggestedFollowups = followupsFromBlock(block);
        break;
      }

      apiMessages.push({ role: 'assistant', content: final.content });

      const toolResults = [];
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        // Follow-up chips are harvested here, not delegated to the caller —
        // every chat surface gets them for free. (This path only runs when
        // followups rode along with REAL tool calls or preceded the reply
        // text; a followups-only ending short-circuits above.)
        if (block.name === FOLLOWUPS_TOOL_NAME) {
          suggestedFollowups = followupsFromBlock(block);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: '{"ok":true}' });
          continue;
        }
        // Place verification is handled here for every assistant (not delegated
        // to the caller's executeTool), like the follow-ups tool. Google Places
        // text search via services/geo; fail open to 'unknown' on any error or
        // once the per-turn cap is hit so an outage never suppresses good
        // suggestions.
        if (block.name === PLACE_VERIFY_TOOL_NAME) {
          send('tool', { name: block.name });
          let result;
          if (placeVerifyUses >= PLACE_VERIFY_MAX_USES) {
            result = { status: 'unknown', note: 'verification limit reached this turn' };
          } else {
            placeVerifyUses += 1;
            result = (await verifyPlaceStatus(block.input?.query, placeBias)) || { status: 'unknown' };
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          continue;
        }
        send('tool', { name: block.name });
        let result;
        try {
          result = await executeTool(block.name, block.input);
        } catch (err) {
          result = { error: err.message };
        }
        if (collectSideEffects) collectSideEffects(block, result, sideEffects);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      apiMessages.push({ role: 'user', content: toolResults });
    }

    // Debit this turn's TOKEN-BASED chat cost once (chat is token-priced, so
    // meter() skipped its flat debit) and get the whole-credit charge to show
    // the user. Priced from the per-type sums, NOT the blended tokensUsed —
    // cache reads are ~0.1× input, so the distinction is most of the price.
    // Best-effort — a metering bug must never break the reply.
    let creditsUsed = 0;
    if (req) { try { creditsUsed = await recordChatCredits(req, turnUsage, model); } catch { /* never break chat */ } }

    // Record executed web searches for reconciliation only (their result tokens
    // are already in the chat debit above; the per-search API fee is not charged
    // separately). Best-effort, mirrors recordTokens.
    if (webSearches > 0 && req) { try { recordWebSearches(req, webSearches); } catch { /* never break chat */ } }

    const override = typeof followupsOverride === 'function' ? followupsOverride(sideEffects) : null;
    const followups = Array.isArray(override) && override.length ? override : suggestedFollowups;
    send('done', { reply: accumulated, followups, tokensUsed, creditsUsed, ...sideEffects });
    res.end();
  } catch (err) {
    console.error('streamChat error:', err);
    // If headers/body already started, surface the error over the stream.
    send('error', { message: err.message || 'Something went wrong' });
    res.end();
  }
}

module.exports = {
  streamChat,
  webSearchTool,
  WEB_SEARCH_SYSTEM_NOTE,
  RESPONSE_FORMAT_NOTE,
  buildCachedSystem,
  toApiContent,
};
