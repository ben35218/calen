const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { addDays } = require('date-fns');
// Signal-parity C3b: home inventory (Category/Item/MaintenanceTask) is sealed in
// the opaque store — this assistant reads it only from the client's decrypted
// context, never the DB.
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { computeNextDueDate, anchorRecurrence } = require('../services/recurrence');
const { streamChat, webSearchTool, WEB_SEARCH_SYSTEM_NOTE } = require('../services/chatStream');
const { ASSISTANT_NAME } = require('../config/assistant');
const { meter, getConfig } = require('../middleware/usageMeter');
const { navTool, navPromptSection, collectNav, ensureActionableNav, SUGGEST_NAV_TOOL_NAME } = require('../services/navDestinations');

const router = express.Router();
router.use(requireAuth);
router.use(requireAiEnabled);

// Curated task templates (same seed the template picker uses). Loaded once.
// Vehicle tasks are intentionally withheld from the plan chat: vehicles are added
// as items so their manual can drive the schedule (see the system prompt).
function loadTemplates() {
  try {
    return require(path.resolve(__dirname, '../../../shared/seed/taskTemplates.json'));
  } catch {
    return [];
  }
}
const ALL_TEMPLATES = loadTemplates();
const TEMPLATES_BY_ID = new Map(ALL_TEMPLATES.map(t => [t.id, t]));
const PLAN_TEMPLATES = ALL_TEMPLATES.filter(t => t.defaultCategoryName !== 'Vehicles');

// Unlike maintenanceChat's `create_tasks`, `propose_tasks` never touches the DB:
// it stages tasks the client shows in a live list, and the user links items and
// confirms them later through the same review flow as task templates.
const TOOLS = [
  {
    name: 'get_home_context',
    description:
      "Get the user's home context in one call: the maintenance categories, the items they already track, the maintenance tasks they already have (so you never propose duplicates), and the curated task-template library you should prefer to recommend from. Call this FIRST, before asking questions or proposing anything.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'propose_tasks',
    description:
      "Add one or more maintenance tasks to the user's plan. These are NOT created yet — they appear in a live list the user reviews. Prefer proposing tasks from the template library (pass its templateId); only write a custom task when nothing in the library fits. Never propose a task that duplicates one the user already has. Never propose vehicle-maintenance tasks. Call this as the plan takes shape; you can call it multiple times.",
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Tasks to add to the plan',
          items: {
            type: 'object',
            properties: {
              templateId:             { type: 'string',  description: 'ID of a template from get_home_context to add. When set, its title, category, recurrence, and priority are used — omit the other fields.' },
              title:                  { type: 'string',  description: 'Task title for a custom task, e.g. "Replace air filter" (required when templateId is omitted)' },
              categoryName:           { type: 'string',  description: 'Category name from get_home_context this custom task belongs to' },
              recurrenceType:         { type: 'string',  enum: ['interval', 'one-time'], description: 'Whether the custom task repeats or is done once' },
              intervalValue:          { type: 'number',  description: 'Number of units between occurrences (e.g. 3 for every 3 months). Required when recurrenceType is interval.' },
              intervalUnit:           { type: 'string',  enum: ['days', 'weeks', 'months', 'years'], description: 'Unit for the interval. Required when recurrenceType is interval.' },
              nextDueDateDaysFromNow: { type: 'number',  description: 'Days from today until first due. Defaults to the interval length if omitted.' },
              description:            { type: 'string',  description: 'Optional additional notes for the task' },
              priority:               { type: 'string',  enum: ['low', 'medium', 'high'], description: 'Priority (default: medium)' },
            },
            required: [],
          },
        },
      },
      required: ['tasks'],
    },
  },
  navTool('maintenance'),
];

function computeNextDue(recurrence, nextDueDateDaysFromNow) {
  if (nextDueDateDaysFromNow !== undefined) return addDays(new Date(), nextDueDateDaysFromNow);
  if (recurrence.type !== 'one-time') return computeNextDueDate({ recurrence }, new Date());
  return null;
}

// Turn a proposed-task spec into a ready-to-create payload fragment. The client
// seals the content fields and creates the task once an item is linked; the
// recurrence/nextDueDate/priority/templateId stay plaintext (mirrors TASK_ENC on
// mobile). A spec sourced from a template reuses the template's exact schedule.
function normalizeProposedTask(t) {
  const tpl = t.templateId ? TEMPLATES_BY_ID.get(t.templateId) : null;
  if (tpl) {
    const nextDueDate = computeNextDue(tpl.recurrence || { type: 'one-time' }, t.nextDueDateDaysFromNow);
    return {
      title:               tpl.title,
      defaultCategoryName: tpl.defaultCategoryName || null,
      recurrence:          tpl.recurrence || { type: 'one-time' },
      nextDueDate:         nextDueDate ? nextDueDate.toISOString() : null,
      priority:            tpl.priority || t.priority || 'medium',
      description:         tpl.description || t.description || undefined,
      templateId:          tpl.id,
      diy:                 tpl.diy || undefined,
    };
  }

  const recurrence = t.recurrenceType === 'one-time'
    ? { type: 'one-time' }
    : anchorRecurrence({
        type:          'interval',
        intervalValue: t.intervalValue || 1,
        intervalUnit:  t.intervalUnit  || 'months',
      });
  const nextDueDate = computeNextDue(recurrence, t.nextDueDateDaysFromNow);

  return {
    title:               t.title,
    defaultCategoryName: t.categoryName || null,
    recurrence,
    nextDueDate:         nextDueDate ? nextDueDate.toISOString() : null,
    priority:            t.priority || 'medium',
    description:         t.description || undefined,
  };
}

async function executeTool(name, input, ctx) {
  if (name === SUGGEST_NAV_TOOL_NAME) return { acknowledged: true };
  switch (name) {
    case 'get_home_context': {
      // Signal-parity C3b: home inventory (categories/items/tasks) is sealed in the
      // opaque store — the client supplies its decrypted context with the request.
      const categories = ctx.clientCategories || [];
      const items = ctx.clientItems || [];
      const tasks = (ctx.clientTasks || []).filter(t => t.active !== false);
      return {
        categories: categories.map(c => c.name),
        items: items.map(i => ({
          name:     i.name,
          type:     i.type,
          category: i.categoryName || null,
        })),
        existingTasks: tasks.map(t => ({
          title:      t.title,
          category:   t.categoryName || null,
          templateId: t.templateId || null,
        })),
        // Curated library to recommend from (vehicle tasks excluded on purpose).
        // `diy` tells the user who does the work: 'diy' | 'pro' | 'depends'.
        templates: PLAN_TEMPLATES.map(t => ({
          id:          t.id,
          title:       t.title,
          category:    t.defaultCategoryName,
          description: t.description,
          priority:    t.priority,
          diy:         t.diy,
        })),
      };
    }

    case 'propose_tasks': {
      const proposed = (input.tasks || []).map(normalizeProposedTask).filter(p => p.title);
      // Handed to the client via collectSideEffects; the model just sees success.
      return {
        success:        true,
        proposed:       proposed.length,
        tasks:          proposed.map(p => ({ title: p.title })),
        _proposedTasks: proposed,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt(propertySummary) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are ${ASSISTANT_NAME}, the friendly assistant in the Calen app, with deep home-maintenance knowledge. Today is ${today}.
You are helping a homeowner build a maintenance plan from scratch — a set of recurring tasks across their home, appliances, systems, and vehicles.

${propertySummary}

## Your goal
Have a focused conversation to understand the user's home, then build a maintenance plan.

## Asking questions (style matters)
While you're still gathering information, LEAD WITH THE QUESTION. Do not open with filler, acknowledgements, or preamble like "Great!", "Perfect, let's get started", "That's helpful", or a restatement of what they said. Just ask. Ask one or two short questions at a time — never a long list. Keep each turn to a sentence or two.

Bad: "Great, thanks for sharing that! To build the best plan I'll need to understand your home a little better. First, could you tell me what kind of home you have?"
Good: "What kind of home is it — house, condo, or apartment, and roughly how old?"

Things worth learning before proposing tasks (ask these conversationally, not all at once):
- Home type (house, condo, apartment) and rough age
- Major systems and appliances (HVAC, water heater, furnace, fridge, washer/dryer, etc.)
- Climate/region, since it affects seasonal tasks

## Use what the user already has
get_home_context tells you the user's existing items, their existing maintenance tasks, and the curated template library. Use it:
- NEVER propose a task the user already has (match on the existing tasks list — same task, even if worded differently).
- PREFER proposing tasks from the template library — pass the template's id in propose_tasks and its title/schedule/category are filled in for you. The library is broad (HVAC, water/well/septic, exterior & structure, land & grounds, plumbing, electrical & safety, appliances, pest & seasonal) — draw across ALL of these, not just a couple. Only write a custom task when nothing in the library fits.
- Tailor to what they told you: skip templates for systems they don't have, prioritize ones they do.

## Tell them who does the work (DIY vs pro)
Each template has a "diy" value: "diy" (a homeowner can do it), "pro" (hire a professional), or "depends" (DIY-able but may need a pro depending on setup/comfort/access). When you present tasks, tell the user this — e.g. group your summary into "You can do these yourself" and "Worth hiring out", or add a short "(you can DIY)" / "(call a pro)" note per task. It helps them plan. Never claim a "pro" task is a simple DIY job.

## Vehicles — do NOT propose vehicle tasks
Vehicle maintenance is driven by each vehicle's own manual and mileage, not this plan. If the user mentions vehicles, do NOT add oil-change or other vehicle tasks. Instead tell them to add each vehicle as an item (Add Item → Add a single item), where they can attach the manual and ${ASSISTANT_NAME} will build that vehicle's schedule from it. Acknowledge their vehicles briefly and move on.

## Proposing tasks
Once you know enough, call propose_tasks to add tasks to the user's live list. You can call it multiple times as you learn more. When you propose tasks, a brief lead-in is fine (e.g. "I've added these to your plan:").

IMPORTANT: propose_tasks does NOT create the tasks — it stages them in a list the user is watching. The user will link each task to an item and confirm the whole plan at the end. So say things like "I've added these to your plan" — never say the tasks are "created" or "saved". If the user wants to remove or change something, adjust and propose again.

Workflow:
1. Call get_home_context first (categories, existing items, existing tasks, template library).
2. Ask a few short questions about the home (question-first, no filler).
3. Propose the most important recurring tasks from the library, leading with the 8–12 most critical across all relevant areas, skipping anything already tracked.
4. Offer to keep going (seasonal checks, less-critical items) until the user is satisfied.
5. When the user is done, remind them to tap "Review & add" to link items and create the tasks.

Keep every response concise and friendly.
${navPromptSection('maintenance')}`;
}

function buildContextSummary(itemCount, taskCount) {
  return {
    sees: [
      itemCount
        ? `Your ${itemCount} tracked item${itemCount === 1 ? '' : 's'}${taskCount ? ` and ${taskCount} existing task${taskCount === 1 ? '' : 's'}` : ''}`
        : 'Your household — no items tracked yet',
      'Your maintenance categories and the curated task-template library',
    ],
    can: [
      'Ask about your home and build a maintenance plan',
      'Recommend tasks from the template library, skipping anything you already have',
      'Add tasks to a live list you review before anything is created',
    ],
    note: 'Nothing is saved until you link items and tap “Review & add”. Vehicles are added as items so their manual can drive the schedule.',
  };
}

const SUGGESTED_PROMPTS = [
  'Help me set up maintenance for my house',
  'What should I maintain seasonally?',
  'Build a plan for a new homeowner',
];

async function contextHandler(req, res) {
  try {
    // C3b: item/task content is sealed — counts come from the client's decrypted
    // context (or 0).
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const itemCount = Number(src.itemCount) || 0;
    const taskCount = Number(src.taskCount) || 0;
    res.json({ context: buildContextSummary(itemCount, taskCount), suggestedPrompts: SUGGESTED_PROMPTS });
  } catch (err) {
    console.error('Maintenance plan chat context error:', err);
    res.status(500).json({ error: err.message });
  }
}
router.get('/context', contextHandler);
router.post('/context', contextHandler);

router.post('/', meter('chat', 'maintenance'), async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    // C3b: the item count comes from the client's decrypted context (sealed store).
    const itemCount = Number(req.body.itemCount) || 0;
    const propertySummary = itemCount
      ? `The user already tracks ${itemCount} item${itemCount === 1 ? '' : 's'} in the app.`
      : 'The user has no items tracked yet — this is a fresh start.';

    const systemPrompt = buildSystemPrompt(propertySummary);
    const client = new Anthropic({ apiKey });

    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;

    await streamChat(res, {
      req,
      client,
      model,
      system: systemPrompt + WEB_SEARCH_SYSTEM_NOTE,
      tools: [...TOOLS, webSearchTool(model)],
      messages,
      executeTool: (name, input) => executeTool(name, input, {
        clientCategories: Array.isArray(req.body.categories) ? req.body.categories : null,
        clientItems: Array.isArray(req.body.items) ? req.body.items : null,
        clientTasks: Array.isArray(req.body.tasks) ? req.body.tasks : null,
      }),
      collectSideEffects: (block, result, acc) => {
        if (result && result._proposedTasks) {
          acc.proposedTasks = (acc.proposedTasks || []).concat(result._proposedTasks);
          delete result._proposedTasks; // keep it out of the model-facing tool result
        }
        collectNav(block, acc, 'maintenance');
      },
      // Guarantee an actionable chip. When tasks are staged, the client's
      // "Review & add" footer button is the actionable next step, so skip the nav.
      followupsOverride: (acc) => {
        ensureActionableNav(acc, 'maintenance', !!(acc.proposedTasks && acc.proposedTasks.length));
        return null;
      },
    });
  } catch (err) {
    console.error('Maintenance plan chat error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
