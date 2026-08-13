const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Chore = require('../models/Chore');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { streamChat, webSearchTool, WEB_SEARCH_SYSTEM_NOTE } = require('../services/chatStream');
const { ASSISTANT_NAME } = require('../config/assistant');
const { meter, getConfig } = require('../middleware/usageMeter');
const { navTool, navPromptSection, collectNav, ensureActionableNav, SUGGEST_NAV_TOOL_NAME } = require('../services/navDestinations');

const router = express.Router();
router.use(requireAuth);
router.use(requireAiEnabled);

// The Chores assistant helps the user plan recurring household chores. Like the
// Calendar assistant, it never writes the DB itself: `open_create_chore_form`
// drafts a chore the client opens in the prefilled chore form for the user to
// review and save (which handles E2EE sealing). `list_chores` is read-only
// awareness of what's already set up.
// Mirror of ChoreFormScreen's CHORE_ICONS (bare names; the device adds the
// mdi- prefix and drops anything it doesn't recognize). Living in the cached
// system+tools prefix, this enum costs cache-reads, not fresh input, per turn.
const CHORE_ICON_NAMES = [
  'broom', 'vacuum', 'spray-bottle', 'bucket', 'washing-machine', 'tumble-dryer',
  'dishwasher', 'trash-can', 'recycle', 'shower', 'toilet', 'bed', 'sofa',
  'window-closed', 'iron',
  'fridge', 'stove', 'microwave', 'coffee-maker', 'kettle', 'food-fork-drink',
  'flower', 'leaf', 'grass', 'pine-tree', 'shovel', 'mower', 'sprinkler-variant',
  'fence', 'saw-blade', 'grill', 'pool', 'hot-tub', 'snowflake',
  'wrench', 'hammer', 'screwdriver', 'tools', 'ladder', 'format-paint',
  'lightbulb', 'water', 'fire', 'garage', 'home-roof', 'air-filter',
  'smoke-detector', 'fire-extinguisher', 'solar-panel',
  'car', 'oil', 'car-battery', 'tire', 'ev-station', 'fuel',
  'cart', 'dog', 'mailbox-outline', 'pill',
];

// Days-before values the chore form's Alert pickers offer (0 = on the due date).
const ALERT_DAY_VALUES = [0, 1, 2, 3, 7];

const TOOLS = [
  {
    name: 'list_chores',
    description: "List the household's existing chores so you can avoid duplicates and reference what's already set up. Returns each chore's title, how often it repeats, who it's assigned to, and whether it's active.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_create_chore_form',
    description:
      'Draft a new chore and open it in the chore form for the user to review and save. Nothing is saved until the user does so. After calling this, briefly recap the chore and tell the user they can tap "Review & add chore" to open the form.',
    input_schema: {
      type: 'object',
      properties: {
        title:        { type: 'string', description: 'Chore title, e.g. "Take out the trash"' },
        instructions: { type: 'string', description: 'Optional notes / how to do it' },
        icon:         { type: 'string', enum: CHORE_ICON_NAMES, description: 'The best-fitting icon for the chore — always pick one' },
        frequency:    { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'How often the chore repeats' },
        interval:     { type: 'number', description: 'Repeat every N of the frequency unit (default 1), e.g. 2 with weekly = every 2 weeks' },
        firstDueDate: { type: 'string', description: 'Date of the FIRST occurrence in YYYY-MM-DD, resolved against today, never in the past. Include whenever the user implies a start day or weekday ("starting this Sunday", "every other Saturday") — the repeat counts from this date, so it must land on the named day.' },
        assignedToName: { type: 'string', description: 'Name of the household member to assign it to, exactly as the user said it (the app matches it to a member on-device); use "me" when they mean themselves. Only when the user says who.' },
        reminderDaysBefore: { type: 'number', enum: ALERT_DAY_VALUES, description: 'Alert this many days before the due date (0 = on the due date). Only when the user asks for a reminder.' },
        alert2DaysBefore:   { type: 'number', enum: ALERT_DAY_VALUES, description: 'An optional second alert, when the user asks for two' },
        reminderTime:  { type: 'string', description: 'Time of day for the alert(s) in HH:MM 24-hour, when the user gives one' },
        alertAudience: { type: 'string', enum: ['everyone', 'owner'], description: 'Who gets the alerts: everyone in the household, or only the user (owner)' },
      },
      required: ['title', 'frequency'],
    },
  },
  navTool('chores'),
];

function describeRecurrence(r) {
  if (!r || r.type === 'one-time') return 'one-time';
  if (r.type === 'interval') return `every ${r.intervalValue || 1} ${r.intervalUnit || 'weeks'}`;
  if (r.type === 'calendar') return 'on a calendar schedule';
  return 'recurring';
}

async function executeTool(name, input, ctx) {
  if (name === SUGGEST_NAV_TOOL_NAME) return { acknowledged: true };
  switch (name) {
    case 'list_chores': {
      // Signal-parity C3b: chores are sealed in the opaque store — the assistant
      // sees them only via the client's decrypted context sent with the request.
      return {
        chores: (ctx.clientChores || []).map((c) => ({
          title: c.title,
          repeats: describeRecurrence(c.recurrence),
          assignedTo: c.assignedToName || null,
          active: c.active !== false,
        })),
      };
    }

    // The client reads the drafted chore from the `pendingChore` side effect
    // (collectSideEffects below); the model just sees success.
    case 'open_create_chore_form':
      return { success: true };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are ${ASSISTANT_NAME}, the friendly assistant in the Calen app. Today is ${today}.
You help the user set up and manage recurring household chores (things like taking out the trash, watering plants, cleaning routines).

## What you can do
- Call list_chores to see what chores already exist (avoid duplicates; reference them).
- To add a chore, call open_create_chore_form with the details the user gave. Always pick the best-fitting icon; set the assignee and alert fields only when the user asked for them — never invent them. Then briefly recap the chore and tell the user they can tap "Review & add chore" to open the prefilled form, or keep chatting to adjust it.

IMPORTANT: open_create_chore_form does NOT save the chore — it opens a form the user reviews and saves themselves. Never say you've already added or saved a chore; say you've drafted it for them to review. If they want changes, call open_create_chore_form again with the updated details.

Keep replies concise and friendly.
${navPromptSection('chores')}`;
}

function buildContextSummary(choreCount) {
  return {
    sees: [
      choreCount
        ? `Your household chores (${choreCount} set up)`
        : 'Your household chores — none set up yet',
    ],
    can: [
      'Suggest chores and how often to do them',
      'Draft a chore and open it in the form for you to review and save',
    ],
    note: 'Nothing is saved until you review and save the chore in the form.',
  };
}

const SUGGESTED_PROMPTS = [
  'Set up a weekly trash chore',
  'Suggest chores for a family of four',
  'What chores am I forgetting?',
];

async function contextHandler(req, res) {
  try {
    // C3b: chore content is sealed — the count comes from the client's decrypted
    // context (or 0), not a server read.
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const choreCount = Number(src.choreCount) || 0;
    res.json({ context: buildContextSummary(choreCount), suggestedPrompts: SUGGESTED_PROMPTS });
  } catch (err) {
    console.error('Chores chat context error:', err);
    res.status(500).json({ error: err.message });
  }
}
router.get('/context', contextHandler);
router.post('/context', contextHandler);

router.post('/', meter('chat', 'chores'), async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const client = new Anthropic({ apiKey });
    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;

    await streamChat(res, {
      req,
      client,
      model,
      system: buildSystemPrompt() + WEB_SEARCH_SYSTEM_NOTE,
      tools: [...TOOLS, webSearchTool(model)],
      messages,
      executeTool: (name, input) => executeTool(name, input, {
        clientChores: Array.isArray(req.body.chores) ? req.body.chores : null,
      }),
      // The drafted chore rides back to the client as `pendingChore` (mirrors the
      // calendar assistant's pendingEvent); the model-facing result stays clean.
      collectSideEffects: (block, result, acc) => {
        if (block.name === 'open_create_chore_form') acc.pendingChore = block.input;
        collectNav(block, acc, 'chores');
      },
      followupsOverride: (acc) => {
        ensureActionableNav(acc, 'chores', !!acc.pendingChore);
        return acc.pendingChore ? ['Review & add chore'] : null;
      },
    });
  } catch (err) {
    console.error('Chores chat error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
