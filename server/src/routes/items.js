const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter } = require('../middleware/usageMeter');

// Signal-parity C3b: item content CRUD (GET/POST/GET:id/PUT:id/DELETE:id) moved to
// the unified opaque store — the client reads items from its replica and writes
// through /records, and fetches an item's manuals/receipts (which stay their own
// collections) separately. What stays here is the AI photo-scan helper, which
// returns extracted item JSON the client seals + creates; it touches no DB row.
const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

const ITEM_SCHEMA = `{
  "name": "descriptive name e.g. '2019 Honda CR-V' or 'Samsung Refrigerator Model RF28R7351SR'",
  "type": "vehicle | appliance | system | structure | equipment | other",
  "manufacturer": "brand/manufacturer name or null",
  "modelNumber": "model number or model name or null",
  "serialNumber": "VIN, serial number, or null",
  "location": "where the item is located or null",
  "notes": "any other relevant details or null",
  "customFields": [{ "key": "string", "value": "string" }]
}

Type definitions:
- vehicle: cars, trucks, tractors, ATVs, snowblowers, motorcycles, riding mowers
- appliance: fridge, washer, dryer, oven, dishwasher, microwave, water heater
- system: furnace, heat pump, A/C, septic, well, electrical panel, generator, boiler
- structure: roof, deck, barn, shed, fence, foundation, driveway, retaining wall
- equipment: chainsaw, pump, welder, pressure washer, power tools, hand tools
- other: anything else

For vehicles include relevant customFields: Year, Vehicle Type, Color, Fuel Type, Transmission, Drive Type.
For appliances/equipment include any specs visible on labels (capacity, voltage, wattage, etc.).
Only include fields that are clearly visible or identifiable from the photo. Always provide a name.`;

router.post('/from-photo', meter('scan'), requireAiEnabled, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'photo is required' });
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const client = new Anthropic({ apiKey });
    const base64 = req.file.buffer.toString('base64');

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: base64 } },
          {
            type: 'text',
            text: `Look at this photo and extract item details for a home maintenance tracking app.\nReturn ONLY valid JSON matching this schema (no markdown, no explanation):\n${ITEM_SCHEMA}`,
          },
        ],
      }],
    });

    const raw = response.content[0].text.trim()
      .replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: 'Could not extract item details from that photo. Try adding the item manually.' });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
