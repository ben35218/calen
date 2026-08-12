const express = require('express');
const multer  = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const Contact  = require('../models/Contact');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { meter, getConfig } = require('../middleware/usageMeter');
const { isObjectId, pickRecordEnc } = require('../services/householdKey');
const { plaintextCreateBlocked, E2EE_REQUIRED_MESSAGE, stripSealedContent } = require('../services/e2eePolicy');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── vCard parser ───────────────────────────────────────────────────────────────
function parseVCards(raw) {
  // Unfold RFC 6350 folded lines (CRLF or LF + whitespace continuation)
  const content = raw.replace(/\r?\n[ \t]/g, '');

  const cardBlocks = content.split(/BEGIN:VCARD/i).slice(1);

  return cardBlocks.map(block => {
    function first(field) {
      const re = new RegExp(`^${field}(?:;[^:\\r\\n]*)?:([^\\r\\n]*)`, 'im');
      const m  = block.match(re);
      return m ? m[1].trim() : '';
    }
    function all(field) {
      const re = new RegExp(`^${field}(?:;[^:\\r\\n]*)?:([^\\r\\n]*)`, 'gim');
      const results = [];
      let m;
      while ((m = re.exec(block)) !== null) results.push(m[1].trim());
      return results;
    }
    // Labeled multi-value extraction (TEL/EMAIL/URL): capture each entry's TYPE
    // param and normalize it into our label vocabulary, defaulting per field.
    function allLabeled(field, typeMap, fallback) {
      const re = new RegExp(`^${field}((?:;[^:\\r\\n]*)?):([^\\r\\n]*)`, 'gim');
      const results = [];
      let m;
      while ((m = re.exec(block)) !== null) {
        const value = m[2].trim();
        if (!value) continue;
        const t = /TYPE=([^;:]*)/i.exec(m[1] || '');
        const raw = t ? t[1].split(',')[0].trim().toLowerCase() : '';
        results.push({ label: typeMap[raw] || raw || fallback, value });
      }
      return results;
    }

    // Name: prefer FN, fall back to assembling from N (family;given;additional;prefix;suffix)
    const fn = first('FN');
    const n  = first('N');
    let name = fn;
    // Structured components (Apple-Contacts First / Last), taken from N when the
    // vCard supplies it: first = given (+ additional/middle), last = family.
    // Left blank when only FN is present — the client splits the display name.
    let firstName = '';
    let lastName = '';
    if (n) {
      const p = n.split(';').map(s => s.trim());
      firstName = [p[1], p[2]].filter(Boolean).join(' ').trim();
      lastName = p[0] || '';
      if (!name) name = [p[1], p[2], p[0]].filter(Boolean).join(' ').trim();
    }

    // Phones / emails / URLs — all values, labeled from their TYPE param. The
    // first of each is also surfaced as a legacy single for back-compat.
    const phones = allLabeled('TEL', { cell: 'mobile', iphone: 'mobile', home: 'home', work: 'work', main: 'main' }, 'mobile');
    const emails = allLabeled('EMAIL', { home: 'home', work: 'work', internet: 'home' }, 'home');
    const urls = allLabeled('URL', { home: 'home', work: 'work' }, 'homepage');
    const phone = phones[0]?.value ?? '';
    const email = emails[0]?.value ?? '';

    // Birthday — handle YYYYMMDD, YYYY-MM-DD, and --MMDD (no year)
    const bdayRaw = first('BDAY');
    let birthday = '';
    if (bdayRaw) {
      const digits = bdayRaw.replace(/\D/g, '');
      if (digits.length === 8) {
        birthday = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      } else if (/^\d{4}-\d{2}-\d{2}/.test(bdayRaw)) {
        birthday = bdayRaw.slice(0, 10);
      }
    }

    // Address — first ADR value, structured as pobox;ext;street;city;region;zip;country
    const adrRaw = first('ADR');
    let address = '';
    if (adrRaw) {
      const p = adrRaw.split(';').map(s => s.trim());
      address = [p[2], p[3], p[4], p[5], p[6]].filter(Boolean).join(', ');
    }

    // Notes
    const notes = first('NOTE');

    return { name, firstName: firstName || undefined, lastName: lastName || undefined, phone, email, phones, emails, urls, birthday, address, notes };
  }).filter(c => c.name);
}

// ── CRUD ───────────────────────────────────────────────────────────────────────
// Signal-parity C3b: contact content CRUD (list/create/self/update/delete/bulk)
// moved to the unified opaque store — the client reads its roster from the replica
// and writes through /records. The self-Contact seed + its accountId/type live
// inside the sealed record now (the server can't stamp or read them), and the
// "can't delete your own card" + roster-sort rules are enforced client-side. What
// stays here is contact IMPORT + AI CLASSIFY, which return candidate data the
// client seals + creates; neither writes a Contact row.

// ── Import ─────────────────────────────────────────────────────────────────────
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const content  = req.file.buffer.toString('utf-8');
    const contacts = parseVCards(content);
    if (!contacts.length) return res.status(422).json({ error: 'No contacts found in file' });
    res.json({ contacts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /bulk was retired (Signal-parity C3b): bulk import seals + creates each
// contact client-side through /records (contactsApi.bulk).

// ── AI-assisted import ─────────────────────────────────────────────────────────
// Given raw device contacts, categorize each (family / friend / service) and
// pre-populate the contact form. Professionals additionally get a web-search
// lookup to fill business name / address / phone. Returns results aligned to the
// caller-supplied `key` so the client can map them back onto its rows.

const CLASSIFY_TOOL = {
  name: 'classify_contacts',
  description:
    'Categorize each contact and pre-fill its details from what is known. ' +
    'type: "family" for relatives, "friend" for personal acquaintances, ' +
    '"service" for businesses / professionals (plumber, dentist, salon, etc.). ' +
    'For "service" contacts set businessName (the company) and leave name as the ' +
    'point-of-contact if one is implied, otherwise reuse the business name.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Echo back the contact key unchanged.' },
            type: { type: 'string', enum: ['family', 'friend', 'service'] },
            name: { type: 'string' },
            relationship: { type: 'string', description: 'e.g. "sister", "neighbor", or the service (plumber, dentist).' },
            businessName: { type: 'string', description: 'Company name — service contacts only.' },
            address: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            notes: { type: 'string', description: 'Short helpful context, if any.' },
          },
          required: ['key', 'type', 'name'],
        },
      },
    },
    required: ['results'],
  },
};

const BUSINESS_DETAILS_TOOL = {
  name: 'business_details',
  description: 'Report the verified details found for the business.',
  input_schema: {
    type: 'object',
    properties: {
      businessName: { type: 'string' },
      address: { type: 'string', description: 'Full street address.' },
      phone: { type: 'string' },
      relationship: { type: 'string', description: 'What the business does (e.g. plumber, dentist).' },
      notes: { type: 'string', description: 'One short line, e.g. hours or website.' },
    },
  },
};

// Best-effort web lookup for one professional. Returns a patch object (may be
// empty). Never throws — enrichment is optional.
async function enrichProfessional(client, model, r) {
  try {
    const hint = [r.businessName || r.name, r.address, r.phone].filter(Boolean).join(', ');
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }, BUSINESS_DETAILS_TOOL],
      system:
        'Look up this local business on the web and report verified contact details. ' +
        'Only report facts you find; do not guess. Call business_details once when done.',
      messages: [{ role: 'user', content: `Find contact details for this business: ${hint}` }],
    });
    const tu = resp.content.find((b) => b.type === 'tool_use' && b.name === 'business_details');
    if (!tu || !tu.input || typeof tu.input !== 'object') return {};
    const patch = {};
    for (const k of ['businessName', 'address', 'phone', 'relationship', 'notes']) {
      const v = tu.input[k];
      if (typeof v === 'string' && v.trim()) patch[k] = v.trim();
    }
    return patch;
  } catch {
    return {};
  }
}

router.post('/classify', meter('chat', 'contactImport'), requireAiEnabled, async (req, res) => {
  try {
    const { contacts, enrich } = req.body || {};
    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({ error: 'contacts array is required' });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    // Two projections (spec: ai-assistant.md). The MODEL sees name + company
    // only — that's what drives family/friend/service classification. The full
    // contact (phone/email/birthday) stays server-side in `src` and merges back
    // into the results below, unseen by the model.
    const src = contacts.slice(0, 100).map((c, i) => ({
      key: String(c.key ?? i),
      name: String(c.name ?? '').slice(0, 200),
      phone: c.phone ? String(c.phone).slice(0, 60) : undefined,
      email: c.email ? String(c.email).slice(0, 120) : undefined,
      birthday: c.birthday ? String(c.birthday).slice(0, 10) : undefined,
      company: c.company ? String(c.company).slice(0, 200) : undefined,
    }));
    const clean = src.map(({ key, name, company }) => ({ key, name, company }));

    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;
    const client = new Anthropic({ apiKey });

    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_contacts' },
      system:
        'You help a household sort imported phone contacts into Family, Friends, and ' +
        'Professionals (services/businesses), and pre-fill each contact form from the ' +
        'known details. Infer type from the name and company. Echo every contact back ' +
        'exactly once using its key. Do not invent details you were not given.',
      messages: [{ role: 'user', content: `Contacts (JSON):\n${JSON.stringify(clean, null, 2)}` }],
    });

    const toolUse = resp.content.find((b) => b.type === 'tool_use' && b.name === 'classify_contacts');
    const raw = Array.isArray(toolUse?.input?.results) ? toolUse.input.results : [];
    const byKey = new Map(src.map((c) => [c.key, c]));
    const results = raw
      .filter((r) => r && byKey.has(String(r.key)))
      .map((r) => {
        const src = byKey.get(String(r.key));
        const type = ['family', 'friend', 'service'].includes(r.type) ? r.type : 'friend';
        return {
          key: String(r.key),
          type,
          name: (r.name || src.name || '').trim(),
          relationship: r.relationship?.trim() || undefined,
          businessName: type === 'service' ? r.businessName?.trim() || undefined : undefined,
          address: r.address?.trim() || undefined,
          phone: r.phone?.trim() || src.phone || undefined,
          email: r.email?.trim() || src.email || undefined,
          birthday: src.birthday || undefined,
          notes: r.notes?.trim() || undefined,
        };
      });

    // Web-search enrichment for professionals (best-effort, bounded + parallel).
    // OPT-IN (spec): business details go into live web searches only when the
    // user enabled the lookup for this import.
    if (enrich === true) {
      const pros = results.filter((r) => r.type === 'service').slice(0, 8);
      const patches = await Promise.all(pros.map((r) => enrichProfessional(client, model, r)));
      pros.forEach((r, i) => {
        const p = patches[i];
        if (p.businessName) r.businessName = p.businessName;
        if (p.address) r.address = p.address;
        if (p.phone) r.phone = p.phone;
        if (p.relationship && !r.relationship) r.relationship = p.relationship;
        if (p.notes && !r.notes) r.notes = p.notes;
      });
    }

    res.json({ results });
  } catch (err) {
    console.error('Contact classify error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
