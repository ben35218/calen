const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { addDays } = require('date-fns');
const Record = require('../models/Record');
const Manual = require('../models/Manual');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { computeNextDueDate, anchorRecurrence } = require('../services/recurrence');
const { extractTextFromPdf } = require('../services/manualParser');
const { streamChat, webSearchTool, WEB_SEARCH_SYSTEM_NOTE } = require('../services/chatStream');
const { ASSISTANT_NAME } = require('../config/assistant');
const { meter, getConfig } = require('../middleware/usageMeter');

const router = express.Router();
router.use(requireAuth);
router.use(requireAiEnabled);

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_CHARS_PER_MANUAL = 60000;

const TOOLS = [
  {
    name: 'get_item_tasks',
    description: 'Get the existing maintenance tasks already tracked for this item, so you avoid suggesting duplicates.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_categories',
    description: 'Get available maintenance categories. Call this before suggesting tasks so you can assign the correct categoryId.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_tasks',
    description: 'Create one or more maintenance tasks for this item. Only call this after the user has confirmed they want to add the tasks.',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Tasks to create',
          items: {
            type: 'object',
            properties: {
              title:                  { type: 'string',  description: 'Task title, e.g. "Replace air filter"' },
              categoryId:             { type: 'string',  description: 'MongoDB ObjectId of the category from get_categories' },
              recurrenceType:         { type: 'string',  enum: ['interval', 'one-time'], description: 'Whether the task repeats or is done once' },
              intervalValue:          { type: 'number',  description: 'Number of units between occurrences (e.g. 3 for every 3 months). Required when recurrenceType is interval.' },
              intervalUnit:           { type: 'string',  enum: ['days', 'weeks', 'months', 'years'], description: 'Unit for the interval. Required when recurrenceType is interval.' },
              nextDueDateDaysFromNow: { type: 'number',  description: 'Days from today until first due. Defaults to the interval length if omitted.' },
              description:            { type: 'string',  description: 'Optional additional notes for the task' },
              priority:               { type: 'string',  enum: ['low', 'medium', 'high'], description: 'Priority (default: medium)' },
            },
            required: ['title', 'recurrenceType'],
          },
        },
      },
      required: ['tasks'],
    },
  },
];

async function extractManualText(manual) {
  try {
    const filePath = path.join(UPLOAD_DIR, manual.storageKey);
    const text = await extractTextFromPdf(filePath);
    if (!text || text.trim().length < 50) return null;
    return text.length <= MAX_CHARS_PER_MANUAL
      ? text
      : text.slice(0, 4000) + '\n...\n' + text.slice(-(MAX_CHARS_PER_MANUAL - 4000));
  } catch {
    return null;
  }
}

async function executeTool(name, input, ctx) {
  const { userId, itemId, clientTasks, clientCategories } = ctx;
  switch (name) {
    case 'get_item_tasks': {
      // Signal-parity C3b: content lives in the opaque store, so the assistant
      // sees the household's tasks only via the client's decrypted context (sent
      // with the request). No server DB read is possible.
      return {
        tasks: (clientTasks || []).map(t => ({
          id:           t._id,
          title:        t.title,
          category:     t.categoryName || null,
          recurrence:   t.recurrence,
          nextDueDate:  t.nextDueDate ? new Date(t.nextDueDate).toISOString().slice(0, 10) : null,
        })),
      };
    }

    case 'get_categories': {
      // C3b: category names are sealed — the client supplies its decrypted
      // top-level categories.
      return {
        categories: (clientCategories || []).map(cat => ({ id: cat._id, name: cat.name })),
      };
    }

    case 'create_tasks': {
      // C3b: the server can't create readable content — compute the task payloads
      // and hand them back for the client to seal + create through /records. The
      // model still sees success.
      const payloads = input.tasks.map(t => {
        const recurrence = t.recurrenceType === 'one-time'
          ? { type: 'one-time' }
          : anchorRecurrence({
              type:          'interval',
              intervalValue: t.intervalValue  || 1,
              intervalUnit:  t.intervalUnit   || 'months',
            });

        let nextDueDate;
        if (t.nextDueDateDaysFromNow !== undefined) {
          nextDueDate = addDays(new Date(), t.nextDueDateDaysFromNow);
        } else if (recurrence.type !== 'one-time') {
          nextDueDate = computeNextDueDate({ recurrence }, new Date());
        }

        const taskData = {
          userId,
          itemId,
          title:      t.title,
          recurrence,
          nextDueDate,
          priority:   t.priority || 'medium',
        };
        if (t.categoryId)    taskData.categoryId    = t.categoryId;
        if (t.description)   taskData.description   = t.description;
        return taskData;
      });

      return {
        success:           true,
        tasksCreated:      payloads.length,
        tasks:             payloads.map(p => ({ title: p.title })),
        _clientCreateTasks: payloads,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildItemLines(item) {
  const itemLines = [`Name: ${item.name}`, `Type: ${item.type}`];
  if (item.manufacturer)   itemLines.push(`Manufacturer: ${item.manufacturer}`);
  if (item.modelNumber)    itemLines.push(`Model: ${item.modelNumber}`);
  if (item.serialNumber)   itemLines.push(`Serial Number: ${item.serialNumber}`);
  if (item.location)       itemLines.push(`Location: ${item.location}`);
  if (item.notes)          itemLines.push(`Notes: ${item.notes}`);
  if (item.customFields?.length) {
    for (const f of item.customFields) {
      if (f.key && f.value) itemLines.push(`${f.key}: ${f.value}`);
    }
  }
  return itemLines;
}

async function buildSystemPrompt(item, manuals) {
  const today = new Date().toISOString().slice(0, 10);
  const itemLines = buildItemLines(item);

  // Extract manual text for each attached manual
  const manualSections = [];
  for (const manual of manuals) {
    if (!manual.storageKey) continue;
    const text = await extractManualText(manual);
    if (text) manualSections.push({ title: manual.title, text });
  }

  let manualsBlock = '';
  if (manualSections.length) {
    manualsBlock = `\n\n## Attached Manuals\nThe full text of this item's manual(s) is provided below. Use it to suggest accurate, manufacturer-specific maintenance tasks with correct intervals.\n`;
    for (const m of manualSections) {
      manualsBlock += `\n### ${m.title}\n${m.text}\n`;
    }
  }

  return `You are ${ASSISTANT_NAME}, the friendly assistant in the Calen app, with deep home-maintenance knowledge, helping a homeowner set up maintenance tasks. Today is ${today}.
If asked who you are, say you're ${ASSISTANT_NAME} and that in this chat you can see this maintenance item and its tasks (each area of the app has its own ${ASSISTANT_NAME} chat with its own context).

## Item Details
${itemLines.join('\n')}${manualsBlock}

## Your goal
Have a focused conversation to identify the most important recurring maintenance tasks for this item. If a manual is provided above, base your suggestions directly on its maintenance schedule — don't invent tasks not covered there. If no manual is attached, use your knowledge of this item type and manufacturer.

For each suggested task include:
- A clear title (e.g. "Replace air filter", not just "filter")
- How often it should recur (use the manual's schedule when available)
- Which category it fits under (call get_categories first)

Workflow:
1. At the start of the conversation, call get_categories and get_item_tasks so you know what categories are available and what's already tracked.
2. Suggest the most important tasks with frequency and category. If a manual is attached, lead with tasks from it.
3. Once the user confirms (e.g. "yes", "add them", "looks good"), call create_tasks to add them.
4. After creating, tell the user which tasks were added.

Keep responses concise. Don't overwhelm — lead with the 3–6 most critical tasks first, then offer to continue with more.`;
}

function buildContextSummary(item, manuals, existingTaskCount) {
  const idParts = [item.name];
  if (item.manufacturer) idParts.push(item.manufacturer);
  if (item.modelNumber)  idParts.push(item.modelNumber);
  const manualCount = manuals.filter(m => m.storageKey).length;
  return {
    sees: [
      `This item — ${idParts.join(' · ')}`,
      manualCount
        ? `${manualCount} attached manual${manualCount === 1 ? '' : 's'} (full text)`
        : "No manual attached — I'll use general knowledge of this item",
      existingTaskCount
        ? `${existingTaskCount} maintenance task${existingTaskCount === 1 ? '' : 's'} already tracked`
        : 'No maintenance tasks tracked yet',
    ],
    can: [
      'Suggest recurring maintenance tasks with the right intervals',
      'Create tasks for you — only after you confirm',
    ],
    note: 'Tasks are only added once you say so.',
  };
}

function buildSuggestedPrompts(item, manuals) {
  const manualCount = manuals.filter(m => m.storageKey).length;
  const prompts = [`What maintenance does my ${item.name} need?`];
  prompts.push(manualCount ? 'Set up tasks from the manual' : `Recommended schedule for a ${item.type}?`);
  prompts.push('What should I check seasonally?');
  return prompts;
}

// Context + starter prompts shown when the assistant first opens.
// GET = dual-write DB read; POST additionally accepts the client's decrypted
// `item` (§9.1 P4 polish) so the summary stays accurate post-drop — access is
// still verified against the DB via plaintext metadata. Manuals keep plaintext
// titles (upload metadata), so their DB read works in both modes.
async function contextHandler(req, res) {
  try {
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const { itemId } = src;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    // C3b: item content is sealed — the client supplies its decrypted item; the
    // server only verifies the id is in the caller's scope (opaque Record row).
    const clientItem = src.item && typeof src.item === 'object' ? src.item : null;
    if (!clientItem) return res.status(400).json({ error: 'item is required' });
    if (!(await Record.exists({ _id: itemId, ...req.scopeFilter }))) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const manuals = await Manual.find({ itemId, ...req.scopeFilter }).lean();
    // Existing-task count comes from the client's decrypted context (sealed).
    const existingTaskCount = Number(src.taskCount) || 0;
    const item = clientItem;

    res.json({
      context: buildContextSummary(item, manuals, existingTaskCount),
      suggestedPrompts: buildSuggestedPrompts(item, manuals),
    });
  } catch (err) {
    console.error('Maintenance chat context error:', err);
    res.status(500).json({ error: err.message });
  }
}
router.get('/context', contextHandler);
router.post('/context', contextHandler);

router.post('/', meter('chat', 'maintenance'), async (req, res) => {
  try {
    const { itemId, messages } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages array is required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const userId = req.user._id;

    // Signal-parity C3b: item + task/category content is sealed in the opaque
    // store, so the client supplies its decrypted item (and, via the tools, its
    // tasks/categories). The server verifies the itemId is in the caller's scope
    // by the opaque Record row, and never reads content. Manuals stay their own
    // (plaintext-metadata) collection.
    const { item: clientItem } = req.body;
    if (!clientItem) return res.status(400).json({ error: 'item is required' });
    if (!(await Record.exists({ _id: itemId, ...req.scopeFilter }))) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const item = clientItem;
    const manuals = await Manual.find({ itemId, ...req.scopeFilter }).lean();

    const systemPrompt = await buildSystemPrompt(item, manuals);
    const client = new Anthropic({ apiKey });

    // Free tier gets the fast Haiku model; paid tiers get the smarter Sonnet.
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
        userId, itemId,
        clientTasks: Array.isArray(req.body.tasks) ? req.body.tasks : null,
        clientCategories: Array.isArray(req.body.categories) ? req.body.categories : null,
      }),
      collectSideEffects: (block, result, acc) => {
        if (result && result._tasksCreated) {
          acc.tasksCreated = (acc.tasksCreated || []).concat(result._tasksCreated);
          delete result._tasksCreated; // keep it out of the model-facing tool result
        }
        if (result && result._clientCreateTasks) {
          // Tasks the client must create encrypted (§9.1 P4d).
          acc.clientCreateTasks = (acc.clientCreateTasks || []).concat(result._clientCreateTasks);
          delete result._clientCreateTasks;
        }
      },
    });
  } catch (err) {
    console.error('Maintenance chat error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
