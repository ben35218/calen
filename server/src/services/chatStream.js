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

const { recordTokens } = require('../middleware/usageMeter');

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
function toApiContent(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) return message.content;

  const blocks = [];
  for (const a of attachments) {
    if (a.kind === 'image' && a.data && SUPPORTED_IMAGE_TYPES.has(a.type)) {
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
    // and report the total to the client so it can show "tokens used".
    req,
    action = 'chat',
    // Optional hook to force a fixed set of follow-up chips based on the side
    // effects of this turn (e.g. show "Save this to my calendar" / "Edit in
    // form" after the assistant drafts an event) instead of the generated ones.
    // Return an array to override, or a falsy value to fall back to generation.
    followupsOverride,
  } = opts;
  let tokensUsed = 0;

  // Prompt caching: the system prompt + tool definitions are identical on every
  // turn, so cache them as one prefix (render order is tools → system, so a
  // breakpoint on the last system block caches both). Cache reads cost ~0.1×
  // input — this roughly halves the effective per-message cost of the agentic
  // loop. Converting the system string into a single cached text block is all
  // that's needed for the tools+system prefix.
  const cachedSystem =
    typeof system === 'string' && system.length
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const apiMessages = capHistory(messages).map((m) => ({ role: m.role, content: toApiContent(m) }));
  const sideEffects = {};
  let accumulated = '';
  let suggestedFollowups = [];

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: cachedSystem,
        tools: [...tools, FOLLOWUPS_TOOL],
        messages: apiMessages,
      });
      stream.on('text', (delta) => {
        accumulated += delta;
        send('text', { delta });
      });

      const final = await stream.finalMessage();
      // Record this call's tokens (analytics + credit debit; best-effort).
      if (req) { try { tokensUsed += await recordTokens(req, final.usage, action, model); } catch { /* never break chat */ } }

      if (final.stop_reason === 'end_turn') break;

      if (final.stop_reason !== 'tool_use') {
        send('error', { message: `Unexpected stop reason: ${final.stop_reason}` });
        return res.end();
      }

      apiMessages.push({ role: 'assistant', content: final.content });

      const toolResults = [];
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        // Follow-up chips are harvested here, not delegated to the caller —
        // every chat surface gets them for free.
        if (block.name === FOLLOWUPS_TOOL_NAME) {
          suggestedFollowups = (Array.isArray(block.input?.suggestions) ? block.input.suggestions : [])
            .filter((s) => typeof s === 'string' && s.trim())
            .map((s) => s.trim())
            .slice(0, 3);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: '{"ok":true}' });
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

    const override = typeof followupsOverride === 'function' ? followupsOverride(sideEffects) : null;
    const followups = Array.isArray(override) && override.length ? override : suggestedFollowups;
    send('done', { reply: accumulated, followups, tokensUsed, ...sideEffects });
    res.end();
  } catch (err) {
    console.error('streamChat error:', err);
    // If headers/body already started, surface the error over the stream.
    send('error', { message: err.message || 'Something went wrong' });
    res.end();
  }
}

module.exports = { streamChat };
