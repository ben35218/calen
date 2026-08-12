// The occasion e-card template gallery + greeting-card HTML renderer.
//
// Design intent: the email should read as a CARD someone chose, not another
// transactional notice. Each occasion kind offers several distinct styles
// (playful / elegant / soft); the chosen `key` is persisted on the ECard row
// and MIRRORED by the mobile picker in mobile/src/lib/ecardTemplates.ts —
// keep the two files in sync (a test greps the mobile file for every key).
//
// Email-client constraints shape the markup:
// - Table-based layout, inline styles, 520px card, bgcolor= solid fallbacks
//   under every CSS gradient (Outlook for Windows renders neither gradients
//   nor border-radius — it gets a square, solid-colour card that still works).
// - Motion is PROGRESSIVE ENHANCEMENT: pure CSS @keyframes in a <style> block
//   animate the cover art (floating balloons/hearts, falling confetti,
//   twinkling sparkles, a slowly drifting dove). Apple Mail, iOS Mail,
//   Outlook macOS and Thunderbird play them; Gmail and Outlook for Windows
//   strip `animation` and show the identical static card. A
//   prefers-reduced-motion media query stills everything for users who ask.
// - Gmail also swaps emoji glyphs for its own small bitmap images, which blur
//   when scaled to the 58px hero — a Gmail-only rule (`u + .body`, matching
//   Gmail's <u></u><div class="body"> rewrite) shrinks the hero there.
// - All user-supplied strings (names, message, custom labels) are escaped.
// - <meta name="color-scheme" content="light"> pins the designed palette so
//   dark-mode clients don't invert the card faces.

const WEB_URL = process.env.WEB_URL || 'https://householdcalendar.com';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// U+FFFC OBJECT REPLACEMENT CHARACTER (and its U+FFF9–B interlinear-annotation
// neighbours): iOS leaves one behind in a text field when dictation or an
// inline placeholder was involved, and mail clients draw it as an "OBJ" box.
// Strip from every author-supplied line (also applied at write time in
// routes/ecards.js; stripping here too covers already-stored cards).
const OBJ_CHARS = /[\uFFF9-\uFFFC]/g;
const stripObj = (s) => String(s ?? '').replace(OBJ_CHARS, '');

// ── The gallery ──────────────────────────────────────────────────────────────
// Per variant: `key` (stable API string), `name` (picker label), heading/emoji,
// palette (wash = page canvas, g1→g2 = cover gradient, heroText = type colour
// on the cover), `serif` switches the heading to display-serif, `signoff` is
// the card's closing phrase, and `deco` drives the animated cover art:
//   { type: 'confetti', colors: [...] }         — falling confetti pieces
//   { type: 'float'|'twinkle'|'drift', pieces } — animated emoji row
// `heroAnim` animates the big cover emoji ('float' | 'pulse' | 'none').
// Condolence styles deliberately use only slow, gentle motion.

const GALLERY = {
  birthday: [
    { key: 'birthday-confetti', name: 'Confetti', heading: 'Happy Birthday!', emoji: '🎂',
      wash: '#FFF3EC', g1: '#FF6B6B', g2: '#FFA94D', heroText: '#FFFFFF', serif: false,
      signoff: 'With love,', heroAnim: 'float',
      deco: { type: 'confetti', colors: ['#FFD166', '#FFFFFF', '#5AD2F4', '#C3F584', '#FF9BD2'] } },
    { key: 'birthday-balloons', name: 'Balloons', heading: 'Happy Birthday!', emoji: '🥳',
      wash: '#EFF8FF', g1: '#4FACFE', g2: '#00D2FE', heroText: '#FFFFFF', serif: false,
      signoff: 'Cheers,', heroAnim: 'float',
      deco: { type: 'float', pieces: ['🎈', '🎈', '🎈', '🎈', '🎈'] } },
    { key: 'birthday-gold', name: 'Golden', heading: 'Happy Birthday', emoji: '🎂',
      wash: '#F7F3EA', g1: '#2C3345', g2: '#151A26', heroText: '#F5D482', serif: true,
      signoff: 'Warm wishes,', heroAnim: 'float',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
  ],
  anniversary: [
    { key: 'anniversary-hearts', name: 'Hearts', heading: 'Happy Anniversary!', emoji: '💞',
      wash: '#FFF0F3', g1: '#FF9A9E', g2: '#FAD0C4', heroText: '#FFFFFF', serif: true,
      signoff: 'With love,', heroAnim: 'pulse',
      deco: { type: 'float', pieces: ['❤️', '💕', '❤️', '💕', '❤️'] } },
    { key: 'anniversary-gold', name: 'Golden Years', heading: 'Happy Anniversary', emoji: '💍',
      wash: '#FBF6EA', g1: '#F3E3BC', g2: '#E3C878', heroText: '#6F5417', serif: true,
      signoff: 'Warmly,', heroAnim: 'float',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
    { key: 'anniversary-bloom', name: 'In Bloom', heading: 'Happy Anniversary!', emoji: '🌹',
      wash: '#F6F1FB', g1: '#FBC2EB', g2: '#A6C1EE', heroText: '#FFFFFF', serif: true,
      signoff: 'With love,', heroAnim: 'float',
      deco: { type: 'drift', pieces: ['🌸', '💮', '🌷', '💮', '🌸'] } },
  ],
  marriage: [
    { key: 'marriage-bouquet', name: 'Bouquet', heading: 'Congratulations!', emoji: '💐',
      wash: '#FCF7F0', g1: '#FDF3E7', g2: '#F5DFC8', heroText: '#8A5A2B', serif: true,
      signoff: 'All our best,', heroAnim: 'float',
      deco: { type: 'drift', pieces: ['🌿', '🌸', '🤍', '🌸', '🌿'] } },
    { key: 'marriage-champagne', name: 'Champagne', heading: 'Cheers to You Both!', emoji: '🥂',
      wash: '#FFF6E9', g1: '#F6D365', g2: '#FDA085', heroText: '#FFFFFF', serif: false,
      signoff: 'With joy,', heroAnim: 'pulse',
      deco: { type: 'twinkle', pieces: ['✨', '🫧', '✨', '🫧', '✨'] } },
    { key: 'marriage-celebration', name: 'Celebration', heading: 'Congratulations!', emoji: '🎊',
      wash: '#F5F1FC', g1: '#A18CD1', g2: '#FBC2EB', heroText: '#FFFFFF', serif: false,
      signoff: 'Cheers,', heroAnim: 'float',
      deco: { type: 'confetti', colors: ['#FFD166', '#FFFFFF', '#8BE8CB', '#FF9BD2', '#B3C7FF'] } },
  ],
  death: [
    { key: 'condolence-dove', name: 'Dove', heading: 'Thinking of You', emoji: '🕊️',
      wash: '#F2F6FB', g1: '#E0EAFC', g2: '#CFDEF3', heroText: '#3D4E63', serif: true,
      signoff: 'With sympathy,', heroAnim: 'none',
      deco: { type: 'drift', pieces: ['☁️', '🕊️', '☁️'] } },
    { key: 'condolence-candle', name: 'Candlelight', heading: 'In Loving Memory', emoji: '🕯️',
      wash: '#F4F1F5', g1: '#E6E1E8', g2: '#CFC7D4', heroText: '#4A3F52', serif: true,
      signoff: 'With deepest sympathy,', heroAnim: 'pulse',
      deco: { type: 'twinkle', pieces: ['✦', '·', '✦', '·', '✦'] } },
    { key: 'condolence-sky', name: 'Evening Sky', heading: 'Forever in Our Hearts', emoji: '🌌',
      wash: '#F0F2F8', g1: '#3E4C6D', g2: '#69739B', heroText: '#EDEFF7', serif: true,
      signoff: 'Thinking of you,', heroAnim: 'none',
      deco: { type: 'twinkle', pieces: ['✦', '⭐', '✦', '⭐', '✦'] } },
  ],
  custom: [
    { key: 'custom-classic', name: 'Classic', heading: 'A Note for You', emoji: '✨',
      wash: '#EFF6FF', g1: '#4F9DF5', g2: '#7CC0FF', heroText: '#FFFFFF', serif: false,
      signoff: 'Warm wishes,', heroAnim: 'float',
      deco: { type: 'twinkle', pieces: ['✨', '✦', '✨', '✦', '✨'] } },
    { key: 'custom-sunshine', name: 'Sunshine', heading: 'A Note for You', emoji: '🌻',
      wash: '#FFFAEC', g1: '#FCE38A', g2: '#F5AF6E', heroText: '#7A4A12', serif: false,
      signoff: 'Warmly,', heroAnim: 'float',
      deco: { type: 'float', pieces: ['🌞', '🌼', '🌻', '🌼', '🌞'] } },
    { key: 'custom-midnight', name: 'Starry Night', heading: 'A Note for You', emoji: '🌙',
      wash: '#EEF0F6', g1: '#1E2A4A', g2: '#3A4B7C', heroText: '#F5D482', serif: true,
      signoff: 'Best wishes,', heroAnim: 'float',
      deco: { type: 'twinkle', pieces: ['⭐', '✨', '⭐', '✨', '⭐'] } },
  ],
};

// The variant a card renders with: the stored key when it exists, else the
// kind's first (default) style. Legacy rows stored `template: <kind>` — the
// lookup misses and falls back to the default, which matches the old design's
// intent.
function resolveTemplate(kind, key) {
  const list = GALLERY[kind] || GALLERY.custom;
  return list.find((v) => v.key === key) || list[0];
}

// ── Rendering ────────────────────────────────────────────────────────────────

// Class-based keyframe motion (Gmail/Outlook-Win strip it; the static card is
// the fallback design, not a degraded one). Delays stagger via .dN classes so
// a row of pieces moves organically instead of in lockstep.
const STYLE_BLOCK = `
  @media (prefers-reduced-motion: reduce) { .ec-anim { animation: none !important; } }
  @keyframes ecFloat   { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
  @keyframes ecPulse   { 0%,100% { transform: scale(1); } 50% { transform: scale(1.09); } }
  @keyframes ecTwinkle { 0%,100% { opacity: .25; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.1); } }
  @keyframes ecDrift   { 0%,100% { transform: translate(0,0); } 33% { transform: translate(7px,-7px); } 66% { transform: translate(-6px,-3px); } }
  @keyframes ecFall    { 0% { transform: translateY(-16px) rotate(-10deg); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(30px) rotate(16deg); opacity: 0; } }
  .ec-hero-float { animation: ecFloat 3.4s ease-in-out infinite; }
  .ec-hero-pulse { animation: ecPulse 2.6s ease-in-out infinite; }
  .ec-float   { animation: ecFloat 3s ease-in-out infinite; }
  .ec-twinkle { animation: ecTwinkle 2.2s ease-in-out infinite; }
  .ec-drift   { animation: ecDrift 6s ease-in-out infinite; }
  .ec-fall    { animation: ecFall 2.8s ease-in infinite; }
  .ec-d0 { animation-delay: 0s; }  .ec-d1 { animation-delay: .45s; }
  .ec-d2 { animation-delay: .9s; } .ec-d3 { animation-delay: 1.35s; }
  .ec-d4 { animation-delay: 1.8s; }
  /* Gmail replaces emoji glyphs with its own small bitmap images, so the 58px
     hero emoji upscales into a blur there (native emoji fonts elsewhere render
     it crisp). \`u + .body\` matches only in Gmail — shrink the hero to the
     bitmap's comfortable size and give the row back the height difference so
     the cover keeps its proportions. */
  u + .body .ec-hero { font-size: 32px !important; line-height: 1.2 !important; padding: 10px 0 !important; }
`;

// The animated cover-art row above the heading. Every piece is a plain
// inline-block span, so a client that strips animation still shows a tidy
// decorative row (emoji, or coloured confetti dots).
function decoRow(deco) {
  if (!deco) return '';
  if (deco.type === 'confetti') {
    const dots = deco.colors.map((c, i) =>
      `<span class="ec-anim ec-fall ec-d${i % 5}" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c};margin:0 7px;vertical-align:middle;"></span>`
    ).join('');
    return `<div style="height:34px;line-height:34px;font-size:0;">${dots}</div>`;
  }
  const anim = { float: 'ec-float', twinkle: 'ec-twinkle', drift: 'ec-drift' }[deco.type] || 'ec-float';
  const pieces = deco.pieces.map((p, i) =>
    `<span class="ec-anim ${anim} ec-d${i % 5}" style="display:inline-block;font-size:20px;margin:0 7px;">${p}</span>`
  ).join('');
  return `<div style="height:34px;line-height:34px;">${pieces}</div>`;
}

const SERIF = `Georgia,'Times New Roman',serif`;
const SANS = `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

// The card typeface menu — email-safe stacks only (web fonts don't survive
// most clients). Key '' / unknown = the template's own default (serif or sans
// per its design). Mirrored by the mobile picker's native font mapping.
const FONTS = {
  sans:    { name: 'Modern',  stack: SANS },
  serif:   { name: 'Serif',   stack: SERIF },
  elegant: { name: 'Elegant', stack: `'Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif` },
  script:  { name: 'Script',  stack: `'Snell Roundhand','Savoye LET','Brush Script MT',cursive` },
};

// Build the full e-card email. Returns { subject, html, text } so the mailer
// stays a thin transport and tests can assert on the rendered output.
// `greeting`/`signoff`/`signature` are author overrides for the card's framing
// lines — blank falls back to the per-recipient "Dear <name>," / the style's
// sign-off phrase / the author's first name. `font` picks from FONTS ('' = the
// template default). `photoCids` are inline-image content ids the caller
// attaches (mailer) — rendered full-width between the message and sign-off.
function renderECard({ kind, template, occasionLabel, toName, toEmail, fromName, message, greeting, signoff, signature, font, photoCids }) {
  const v = resolveTemplate(kind, template);
  const sender = stripObj(signature).trim() || stripObj(fromName) || 'Someone';
  // A custom occasion titles the card with its author-written label.
  const heading = kind === 'custom' && occasionLabel ? stripObj(occasionLabel) : v.heading;
  // Recipients are stored with their full contact name (for the recipient
  // list), but a card addresses contacts familiarly — greet and subject-line by
  // FIRST name only ("Dear Sarah," not "Dear Sarah Smith,").
  const firstName = stripObj(toName).trim().split(/\s+/)[0] || '';
  const greetLine = stripObj(greeting).trim() || (firstName ? `Dear ${firstName},` : 'Hello,');
  const signoffLine = stripObj(signoff).trim() || v.signoff;
  const body = stripObj(message).trim();

  // Personal name in the subject for celebrations; never for condolence
  // (and not for custom labels, where "Graduation, Sam" reads oddly). The name
  // goes INSIDE the heading's closing punctuation — "Happy Birthday, Sam!",
  // never "Happy Birthday!, Sam".
  const withName = ['birthday', 'anniversary', 'marriage'].includes(kind) && firstName;
  const [, headingBase, headingPunct] = heading.match(/^(.*?)([!.]*)$/s);
  const subjectHeading = withName ? `${headingBase}, ${firstName}${headingPunct}` : heading;
  const subject = `${v.emoji} ${subjectHeading} — from ${sender}`;

  const chosen = FONTS[font];
  const headingFont = chosen ? chosen.stack : (v.serif ? SERIF : SANS);
  const bodyFont = chosen ? chosen.stack : SANS;
  // Script faces run small at body size; bump for legibility.
  const bodySize = font === 'script' ? 19 : 16;
  // The greeting's italic flourish: the template's serif look, or any chosen
  // serif face (script is already cursive — don't double up).
  const greetItalic = chosen ? ['serif', 'elegant'].includes(font) : v.serif;
  const heroAnimClass = v.heroAnim === 'float' ? 'ec-anim ec-hero-float' : v.heroAnim === 'pulse' ? 'ec-anim ec-hero-pulse' : '';
  const preheader = body ? body.slice(0, 120) : `${sender} sent you a card.`;

  const photosHtml = (photoCids || []).map((cid) =>
    `<img src="cid:${cid}" width="444" alt="" style="display:block;width:100%;max-width:444px;border-radius:14px;margin:0 0 18px;" />`,
  ).join('\n      ');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>${STYLE_BLOCK}</style>
</head>
<body class="body" style="margin:0;padding:0;background:${v.wash};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${v.wash}" style="background:${v.wash};">
<tr><td align="center" style="padding:36px 12px 44px;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:520px;max-width:100%;">
    <tr><td bgcolor="${v.g1}" style="background:${v.g1};background-image:linear-gradient(135deg,${v.g1},${v.g2});border-radius:24px 24px 0 0;padding:42px 32px 38px;text-align:center;">
      ${decoRow(v.deco)}
      <div class="ec-hero" style="font-size:58px;line-height:1.15;margin-top:10px;"><span class="${heroAnimClass}" style="display:inline-block;">${v.emoji}</span></div>
      <div style="font-family:${headingFont};font-size:34px;line-height:1.2;font-weight:700;color:${v.heroText};margin-top:16px;${v.serif ? 'letter-spacing:.5px;' : ''}">${esc(heading)}</div>
    </td></tr>
    <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:36px 38px 30px;font-family:${bodyFont};">
      <p style="margin:0 0 14px;font-size:${bodySize}px;line-height:1.7;color:#374151;${greetItalic ? 'font-style:italic;' : ''}">${esc(greetLine)}</p>
      ${body ? `<p style="margin:0 0 22px;font-size:${bodySize}px;line-height:1.7;color:#374151;white-space:pre-wrap;">${esc(body)}</p>` : ''}
      ${photosHtml}
      <p style="margin:0;font-size:${bodySize}px;line-height:1.7;color:#374151;">
        <em>${esc(signoffLine)}</em><br>
        <strong>${esc(sender)}</strong>
      </p>
    </td></tr>
    <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 24px 24px;border-top:1px solid #f1f2f4;padding:16px 38px 20px;text-align:center;font-family:${SANS};font-size:12px;color:#9ca3af;">
      Sent with ♥ through <a href="${WEB_URL}" style="color:#9ca3af;">Calen</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `${v.emoji}  ${heading}`,
    '',
    greetLine,
    ...(body ? ['', body] : []),
    ...(photoCids?.length ? ['', `(${photoCids.length} photo${photoCids.length > 1 ? 's' : ''} attached)`] : []),
    '',
    signoffLine,
    `— ${sender}`,
    '',
    'Sent with ♥ through Calen.',
  ].join('\n') + '\n';

  return { subject, html, text };
}

module.exports = { GALLERY, FONTS, resolveTemplate, renderECard, stripObj };
