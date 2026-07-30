const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFParse } = require('pdf-parse');

const SYSTEM_PROMPT = `You are an expert at reading owner's manuals and maintenance guides.
Extract every maintenance task from the provided manual text.
Return ONLY a JSON object matching this exact schema — no markdown, no explanation:

{
  "tasks": [
    {
      "title": "string (concise, e.g. 'Engine Oil & Filter Change')",
      "description": "string (what to do and why, 1–2 sentences)",
      "priority": "low | medium | high",
      "recurrence": {
        "type": "interval | calendar | one-time",
        "intervalValue": number | null,
        "intervalUnit": "days | weeks | months | years | null",
        "months": [1-12 array for calendar type] | null,
        "dayOfMonth": number | null
      },
      "intervalKm": number | null,
      "estimatedDurationMins": number | null,
      "estimatedCost": number | null,
      "notes": "string | null"
    }
  ]
}

Rules:
- For time-based intervals (e.g. 'every 6 months'), use type: 'interval'.
- For annual tasks tied to a season (e.g. 'every spring'), use type: 'calendar' with the appropriate months array.
- For one-time tasks (e.g. 'at 100,000 km break-in'), use type: 'one-time'.
- If both a distance AND time interval are given (e.g. 'every 8,000 km or 6 months'), set BOTH: use the time interval for recurrence AND set intervalKm to the distance value.
- If only a distance interval is given with no time equivalent, set intervalKm and use a reasonable time estimate for recurrence (e.g. 8,000 km → 6 months).
- intervalKm must always be in kilometres. Convert miles to km if necessary (1 mile = 1.609 km), round to nearest 500.
- Priority: high = safety/engine critical, medium = performance/longevity, low = cosmetic/convenience.
- Only include tasks explicitly stated in the manual. Do not invent tasks.
- If the text is too short or contains no maintenance schedule, return { "tasks": [] }.`;

async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });
  await parser.load();
  const result = await parser.getText();
  await parser.destroy();
  return result.text; // plain string of all page text joined
}

async function extractTextFromPdf(filePath) {
  return extractTextFromPdfBuffer(fs.readFileSync(filePath));
}

// Parse maintenance tasks from a manual given as raw bytes (never touches disk).
// Used for the ephemeral-consent path (§9.1 P4b): the client decrypts an
// encrypted manual and posts the plaintext bytes per-request.
async function parseManualBufferForTasks(buffer) {
  let text;
  try {
    text = await extractTextFromPdfBuffer(buffer);
  } catch (err) {
    throw new Error('Could not read PDF: ' + err.message);
  }
  return tasksFromManualText(text);
}

async function parseManualForTasks(filePath) {
  let text;
  try {
    text = await extractTextFromPdf(filePath);
  } catch (err) {
    throw new Error('Could not read PDF: ' + err.message);
  }
  return tasksFromManualText(text);
}

async function tasksFromManualText(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  if (!text || text.trim().length < 100) {
    throw new Error('PDF appears to be scanned/image-based — no extractable text found');
  }

  // Claude's context window is large but PDFs can be huge; take the most useful slice.
  // Maintenance schedules are usually in the middle/end, so we take the last 60k chars
  // plus the first 4k (table of contents / intro often names sections).
  const MAX_CHARS = 60000;
  const snippet =
    text.length <= MAX_CHARS
      ? text
      : text.slice(0, 4000) + '\n...\n' + text.slice(-56000);

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    // Sonnet, deliberately: manuals are long (~16k tokens of input) and the
    // extracted maintenance schedule must be right — the flat manualParse
    // credit price (credits.actionCosts) is set against Sonnet-class cost.
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract all maintenance tasks from this manual text:\n\n${snippet}`,
      },
    ],
  });

  const raw = message.content[0]?.text || '';

  // Strip any accidental markdown fences
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Claude returned invalid JSON: ' + raw.slice(0, 200));
  }

  if (!Array.isArray(parsed.tasks)) throw new Error('Unexpected response shape from Claude');

  return parsed.tasks;
}

module.exports = { parseManualForTasks, parseManualBufferForTasks, extractTextFromPdf };
