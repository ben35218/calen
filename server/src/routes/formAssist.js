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

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { format } = require('date-fns');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter, getConfig } = require('../middleware/usageMeter');

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

router.post('/', meter('chat', 'formAssist'), async (req, res) => {
  try {
    const { formType, fields, current, prompt, includeContacts, contacts } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ error: 'fields array is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

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
      return res.status(400).json({ error: 'no usable fields provided' });
    }

    const fillForm = {
      name: 'fill_form',
      description: `Fill in the "${formType || 'form'}" based on the user's request. Only include the fields the request implies should change; omit everything else.`,
      input_schema: { type: 'object', properties },
    };

    const contactsContext = includeContacts ? buildContactsContext(contacts) : '';

    const now = new Date();
    const today = format(now, 'yyyy-MM-dd (EEEE)');
    const currentYear = now.getFullYear();
    const system = `You help a user fill in a "${formType || 'form'}" from a plain-language description.

Today's date is ${today}. The current year is ${currentYear}. Resolve every date against today's date — do NOT rely on your training data for the current date or year.

Rules:
- Call the fill_form tool exactly once.
- Only set fields the user's request clearly implies. Leave everything else unset — do NOT restate unchanged current values.
- For select/multiselect fields, only use values from the allowed list.
- Dates use YYYY-MM-DD; times use HH:MM 24-hour.
- Resolve relative dates ("next Tuesday", "tomorrow", "in 3 weeks") against today's date.
- When the user gives a date with no year (e.g. "March 15", "the 20th"), use ${currentYear}; if that date has already passed this year, use the next year instead. Never output a year earlier than ${currentYear}.
- Keep text fields concise and natural.${contactsContext ? `\n\n${contactsContext}` : ''}`;

    const userContent = `Current form values (JSON):
${JSON.stringify(current ?? {}, null, 2)}

User request:
${prompt.trim()}`;

    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      tools: [fillForm],
      tool_choice: { type: 'tool', name: 'fill_form' },
      messages: [{ role: 'user', content: userContent }],
    });

    const toolUse = resp.content.find((b) => b.type === 'tool_use' && b.name === 'fill_form');
    const note = resp.content.find((b) => b.type === 'text')?.text?.trim() || undefined;

    // Filter to known field names in case the model invents keys.
    const patch = {};
    if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
      for (const [key, value] of Object.entries(toolUse.input)) {
        if (fieldNames.has(key) && value !== undefined && value !== null) patch[key] = value;
      }
    }

    return res.json({ patch, note });
  } catch (err) {
    console.error('Form assist error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
