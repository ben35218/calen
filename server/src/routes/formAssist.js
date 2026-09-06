// Generic "fill this form from a plain-language request" endpoint.
//
// A mobile add/edit form POSTs its own field schema (names, types, allowed
// options), its current values, and the user's natural-language request. We ask
// Claude — via a single dynamically-built `fill_form` tool — for a JSON patch
// keyed by those field names. The client applies the patch and highlights the
// fields that changed.
//
// This is deliberately form-agnostic: the server knows nothing about any
// specific form, so every add/edit screen can reuse it by describing its fields.
//
// TWO SHAPES, one route. The original single-shot body (`prompt`) is still
// accepted verbatim — app builds already in the wild send it, and will for
// months. The pill + chat sheet sends `messages` instead: the running transcript
// for ONE form, so the user can refine a fill ("no, the 3rd") or answer a
// question Calen asked. The differences are contained to two places — the
// messages array, and `tool_choice` (see the route). Everything else, including
// the tool schema and the output sanitizing, is shared.

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { format } = require('date-fns');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter, getConfig, recordChatCredits } = require('../middleware/usageMeter');
const { usageBreakdown } = require('../services/credits');

const router = express.Router();
router.use(requireAuth);
router.use(requireAiEnabled);

// Build a compact snapshot of the household's saved PROFESSIONAL contacts for
// the assistant to draw on. Professionals-only by spec (ai-assistant.md):
// friends/family are name-only in AI payloads, and a bare name list adds
// nothing to form-filling — so they are omitted entirely (the client doesn't
// send them either). Service providers expose name, service, address, phone;
// nothing else (email, birthday, notes) is ever sent to the model.
// Signal-parity C3b: contacts are sealed in the opaque store, so the CLIENT
// sends its own decrypted roster projection. The server no longer reads Contact.
function buildContactsContext(contacts) {
  const roster = (Array.isArray(contacts) ? contacts : []).slice(0, 200);

  const services = [];
  for (const p of roster) {
    if (!p.name || p.type !== 'service') continue;
    const parts = [p.name];
    if (p.relationship) parts.push(`(${p.relationship})`);
    if (p.address) parts.push(`— ${p.address}`);
    if (p.phone) parts.push(`— ${p.phone}`);
    services.push(`- ${parts.join(' ')}`);
  }

  if (!services.length) return '';

  return [
    'The user has these saved service providers. When their request names one of these businesses, use the matching saved details to fill address/location and phone fields. Do not invent details for anyone not listed.',
    `\nService providers (name (service) — address — phone):\n${services.join('\n')}`,
  ].join('\n');
}

// The transcript is bounded on the way in. The user pays for these tokens now
// (recordChatCredits below), and a form conversation that needs more than a few
// exchanges is a conversation that should have been typing in the form instead.
const MAX_HISTORY_TURNS = 8;
const MAX_TURN_CHARS = 2000;

// Flatten a client transcript into alternating plain-TEXT turns.
//
// The client sends what was SAID, never tool_use/tool_result blocks, so we never
// have to pair a tool call with its result across turns. That's deliberate: the
// live form values ride on the newest turn (see the route), which is a truer
// record of "what actually got filled" than a replayed tool call — the user may
// have hand-edited a field in between, or undone the fill entirely.
//
// A legacy `{ prompt }` body collapses to exactly one user turn, which is what
// keeps the old single-shot path byte-identical.
function normalizeHistory(messages, prompt) {
  const raw = Array.isArray(messages) && messages.length
    ? messages
    : (typeof prompt === 'string' && prompt.trim() ? [{ role: 'user', content: prompt }] : []);

  const out = [];
  for (const m of raw) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof m?.content === 'string' ? m.content.trim().slice(0, MAX_TURN_CHARS) : '';
    if (!content) continue;
    // The API rejects two same-role messages in a row; merge rather than drop,
    // so a client that batches doesn't silently lose what the user typed.
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${content}`;
    else out.push({ role, content });
  }

  // Trim FIRST, then shift to a user turn — trimming can leave an assistant
  // message at the head, which the API refuses.
  const trimmed = out.slice(-MAX_HISTORY_TURNS);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
}

// Appended to the system prompt in chat mode only. The single-shot path forces
// the tool, so none of this can apply there.
//
// The bias is deliberately lopsided toward filling. With `tool_choice: auto` the
// model CAN answer with a question, and models enjoy that — but a wrong value
// the user corrects in the form costs one tap, where a needless question costs a
// round trip. Asking is the exception, not the balanced alternative.
const CHAT_RULES = `
You are in a short back-and-forth with the user about this ONE form. The messages above are earlier turns in it.

- The "Current form values" block is the LIVE state of the form after those turns. Trust it over anything said earlier — the user may have edited fields by hand, or undone one of your fills, in between.
- Whenever you can act on the request: call fill_form AND write exactly ONE short sentence naming what you set ("Set the title to Dentist and the date to Tuesday, March 3."). Plain text only — no markdown, no lists, no preamble, no sign-off.
- ONLY when the request is genuinely ambiguous and you cannot fill anything useful: do NOT call fill_form, and ask ONE short clarifying question instead.
- Prefer filling over asking. A value the user can correct in the form beats a question. Never ask about something you can read from the current values or resolve with a sensible default.`;

// A tool-forced turn usually emits no text block at all. Rather than show the
// user a blank confirmation bubble, name what changed from the patch itself.
function fallbackReply(patch, fields) {
  const keys = Object.keys(patch);
  if (!keys.length) return undefined;
  const labels = new Map(fields.map((f) => [f.name, f.label || f.name]));
  return `Updated ${keys.map((k) => labels.get(k) || k).join(', ')}.`;
}

const FIELD_TYPES = new Set(['text', 'number', 'date', 'time', 'boolean', 'select', 'multiselect']);

// Translate one caller-supplied field spec into a JSON-schema property for the
// fill_form tool. Returns null for unusable specs (skipped defensively).
function propertyForField(field) {
  const { type, label, description, options } = field;
  const desc = [label, description].filter(Boolean).join(' — ') || undefined;
  const enumValues = Array.isArray(options)
    ? options.map((o) => o.value).filter((v) => v !== undefined && v !== null)
    : null;

  switch (type) {
    case 'text':
      return { type: 'string', description: desc };
    case 'number':
      return { type: 'number', description: desc };
    case 'boolean':
      return { type: 'boolean', description: desc };
    case 'date':
      return { type: 'string', description: `${desc ? desc + '. ' : ''}Date in YYYY-MM-DD format.` };
    case 'time':
      return { type: 'string', description: `${desc ? desc + '. ' : ''}Time in HH:MM 24-hour format.` };
    case 'select':
      return enumValues && enumValues.length
        ? { type: enumValues.every((v) => typeof v === 'number') ? 'number' : 'string', enum: enumValues, description: desc }
        : { type: 'string', description: desc };
    case 'multiselect':
      return {
        type: 'array',
        description: desc,
        items: enumValues && enumValues.length ? { enum: enumValues } : { type: 'string' },
      };
    default:
      return null;
  }
}

// Build the whole `messages.create` payload from one request body. Pure (given
// `now`), so the tool_choice gate, the values-on-the-last-turn rule and the
// generated tool schema are all testable without a network call.
//
// Returns `{ error, status }` for a bad body, or `{ params, fieldNames,
// validFields }` — `fieldNames`/`validFields` are what parseResponse needs to
// sanitize the model's output.
function buildRequest({ formType, fields, current, prompt, messages, includeContacts, contacts, model, now }) {
  // Chat mode is the presence of a transcript, not its length — a one-turn
  // `messages` array is still the sheet asking, and still wants to be able to
  // come back with a question instead of a fill.
  const chatMode = Array.isArray(messages) && messages.length > 0;
  const history = normalizeHistory(messages, prompt);

  if (!history.length || history[history.length - 1].role !== 'user') {
    // Same string the shipped card surfaces, so an old build's error path is
    // unchanged.
    return { error: 'prompt is required', status: 400 };
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return { error: 'fields array is required', status: 400 };
  }

  // Build the tool input schema from the caller's field list.
  const validFields = fields.filter((f) => f && typeof f.name === 'string' && FIELD_TYPES.has(f.type));
  const properties = {};
  const fieldNames = new Set();
  for (const field of validFields) {
    const prop = propertyForField(field);
    if (!prop) continue;
    properties[field.name] = prop;
    fieldNames.add(field.name);
  }
  if (fieldNames.size === 0) {
    return { error: 'no usable fields provided', status: 400 };
  }

  const fillForm = {
      name: 'fill_form',
      description: `Fill in the "${formType || 'form'}" based on the user's request. Only include the fields the request implies should change; omit everything else.`,
      input_schema: { type: 'object', properties },
    };

  const contactsContext = includeContacts ? buildContactsContext(contacts) : '';

  const today = format(now, 'yyyy-MM-dd (EEEE)');
  const currentYear = now.getFullYear();
  const system = `You help a user fill in a "${formType || 'form'}" from a plain-language description.

Today's date is ${today}. The current year is ${currentYear}. Resolve every date against today's date — do NOT rely on your training data for the current date or year.

Rules:
- Call the fill_form tool at most once per reply.
- Only set fields the user's request clearly implies. Leave everything else unset — do NOT restate unchanged current values.
- For select/multiselect fields, only use values from the allowed list.
- Dates use YYYY-MM-DD; times use HH:MM 24-hour.
- Resolve relative dates ("next Tuesday", "tomorrow", "in 3 weeks") against today's date.
- When the user gives a date with no year (e.g. "March 15", "the 20th"), use ${currentYear}; if that date has already passed this year, use the next year instead. Never output a year earlier than ${currentYear}.
- Keep text fields concise and natural.${chatMode ? `\n${CHAT_RULES}` : ''}${contactsContext ? `\n\n${contactsContext}` : ''}`;

  // The LIVE form values ride on the newest user turn only — resending them
  // with every historical turn would both waste tokens and let a stale
  // snapshot argue with the current one.
  const apiMessages = history.map((m, i) => (
    i === history.length - 1
      ? {
          role: 'user',
          content: `Current form values (JSON):\n${JSON.stringify(current ?? {}, null, 2)}\n\nUser request:\n${m.content}`,
        }
      : m
  ));

  return {
    fieldNames,
    validFields,
    params: {
      model,
      max_tokens: 1024,
      system,
      tools: [fillForm],
      // Legacy single-shot callers keep the MANDATORY fill: there is no
      // conversation for a clarifying question to land in, so a text-only reply
      // there would just be a dropped request. Chat mode relaxes to `auto` so a
      // turn can come back as a question with no patch — CHAT_RULES above is
      // what stops `auto` from turning every turn into chit-chat.
      tool_choice: chatMode ? { type: 'auto' } : { type: 'tool', name: 'fill_form' },
      messages: apiMessages,
    },
  };
}

// Turn one model response into the client's `{ patch, reply }`. Pure.
function parseResponse(resp, fieldNames, validFields) {
  const content = Array.isArray(resp?.content) ? resp.content : [];
  const toolUse = content.find((b) => b.type === 'tool_use' && b.name === 'fill_form');
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text?.trim())
    .filter(Boolean)
    .join(' ') || undefined;

  // Filter to known field names in case the model invents keys.
  const patch = {};
  if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
    for (const [key, value] of Object.entries(toolUse.input)) {
      if (fieldNames.has(key) && value !== undefined && value !== null) patch[key] = value;
    }
  }

  return { patch, reply: text || fallbackReply(patch, validFields) };
}

router.post('/', meter('chat', 'formAssist'), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;

    const built = buildRequest({ ...(req.body || {}), model, now: new Date() });
    if (built.error) return res.status(built.status).json({ error: built.error });

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create(built.params);

    const { patch, reply } = parseResponse(resp, built.fieldNames, built.validFields);

    // Debit this turn's TOKEN-BASED cost. Form assist meters under the
    // token-priced `chat` action, so meter() deliberately skipped a flat debit —
    // and until now nothing picked it back up, which made every fill free.
    // Best-effort, mirroring chatStream: a metering bug must never break a fill.
    let creditsUsed = 0;
    try {
      creditsUsed = await recordChatCredits(req, usageBreakdown(resp.usage), model);
    } catch { /* never break the fill */ }

    // `note` is kept as an alias of `reply` so an app build still running the
    // old FormAssist card keeps showing its confirmation line. Drop it a release
    // after the pill ships.
    return res.json({ patch, note: reply, reply, creditsUsed });
  } catch (err) {
    console.error('Form assist error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Pure internals, exported for tests only — the route is the public surface.
module.exports.normalizeHistory = normalizeHistory;
module.exports.fallbackReply = fallbackReply;
module.exports.buildRequest = buildRequest;
module.exports.parseResponse = parseResponse;
