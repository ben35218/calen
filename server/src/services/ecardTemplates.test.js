// Unit tests for the e-card template gallery + renderer (spec:
// features/calendar.md "Scheduled e-cards"). Covers the gallery contract
// (every kind offers multiple styles, stable unique keys), template
// resolution/fallback, the rendered card (heading/signoff/escaping, motion
// CSS as progressive enhancement), and that the mobile picker's mirrored
// metadata (mobile/src/lib/ecardTemplates.ts) lists exactly the same keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GALLERY, FONTS, resolveTemplate, renderECard } = require('./ecardTemplates');

const KINDS = ['birthday', 'anniversary', 'marriage', 'death', 'custom'];

test('every occasion kind offers at least 3 styles with unique, complete variants', () => {
  const allKeys = new Set();
  for (const kind of KINDS) {
    const list = GALLERY[kind];
    assert.ok(Array.isArray(list) && list.length >= 3, `${kind} has a gallery of 3+`);
    for (const v of list) {
      assert.ok(!allKeys.has(v.key), `duplicate template key: ${v.key}`);
      allKeys.add(v.key);
      for (const field of ['key', 'name', 'heading', 'emoji', 'wash', 'g1', 'g2', 'heroText', 'signoff']) {
        assert.ok(v[field], `${v.key} missing ${field}`);
      }
      assert.ok(v.deco && (v.deco.pieces?.length || v.deco.colors?.length), `${v.key} has cover art`);
    }
  }
});

test('resolveTemplate: picked key wins; unknown/legacy keys fall back to the kind default', () => {
  assert.equal(resolveTemplate('birthday', 'birthday-gold').key, 'birthday-gold');
  // Legacy rows stored `template: <kind>` — resolves to the kind's default.
  assert.equal(resolveTemplate('birthday', 'birthday').key, GALLERY.birthday[0].key);
  assert.equal(resolveTemplate('birthday', undefined).key, GALLERY.birthday[0].key);
  assert.equal(resolveTemplate('nope', 'whatever').key, GALLERY.custom[0].key);
});

test('renderECard renders the chosen style as a self-contained animated card', () => {
  const { subject, html, text } = renderECard({
    kind: 'birthday', template: 'birthday-gold', toName: 'Sam', fromName: 'Ben',
    message: 'Have a great one <3 & cheers',
  });
  // Subject carries the style's heading + the recipient (celebration kinds).
  assert.match(subject, /Happy Birthday, Sam — from Ben/);
  assert.ok(html.includes('Happy Birthday'), 'heading in html');
  assert.ok(html.includes('Dear Sam,'), 'greeting in html');
  assert.ok(html.includes('Warm wishes,'), 'style signoff in html');
  // User content is escaped, never raw.
  assert.ok(html.includes('Have a great one &lt;3 &amp; cheers'), 'message escaped');
  assert.ok(!html.includes('one <3'), 'no raw user HTML');
  // Motion is progressive enhancement: keyframes + reduced-motion opt-out.
  assert.ok(html.includes('@keyframes'), 'CSS animation present');
  assert.ok(html.includes('prefers-reduced-motion'), 'reduced-motion opt-out');
  // Gradient cover with a solid bgcolor fallback for Outlook Windows.
  assert.ok(html.includes('linear-gradient'), 'gradient cover');
  assert.match(html, /bgcolor="#2C3345"/, 'solid fallback for the cover');
  // Plaintext alternative mirrors the card copy.
  assert.ok(text.includes('Happy Birthday') && text.includes('Warm wishes,') && text.includes('— Ben'));
});

test('a full contact name greets and subjects by first name only', () => {
  const { subject, html, text } = renderECard({
    kind: 'birthday', template: 'birthday-confetti', toName: 'Sarah Anne Smith', fromName: 'Ben',
  });
  assert.ok(html.includes('Dear Sarah,'), 'greeting uses the first name');
  assert.ok(!html.includes('Sarah Anne Smith'), 'full name never rendered');
  assert.match(subject, /Happy Birthday, Sarah! — from Ben/);
  assert.ok(text.includes('Dear Sarah,'), 'plaintext matches');
});

test('the subject puts the name inside the heading punctuation, never after it', () => {
  // "Congratulations!" + Alan must read "Congratulations, Alan!" —
  // shipped bug: "Congratulations!, Alan".
  const { subject } = renderECard({
    kind: 'anniversary', template: 'anniversary-hearts', toName: 'Alan Polk', fromName: 'Ben',
  });
  assert.match(subject, /Happy Anniversary, Alan! — from Ben/);
  assert.ok(!subject.includes('!,'), 'no punctuation-comma collision');
  // A heading with no trailing punctuation appends the name plainly.
  const gold = renderECard({
    kind: 'anniversary', template: 'anniversary-gold', toName: 'Alan', fromName: 'Ben',
  }).subject;
  assert.match(gold, /Happy Anniversary, Alan — from Ben/);
});

test('condolence cards never put the recipient name in the subject', () => {
  const { subject } = renderECard({ kind: 'death', template: 'condolence-dove', toName: 'Sam', fromName: 'Ben' });
  assert.ok(!subject.includes('Sam'), 'no name in a condolence subject');
  assert.match(subject, /Thinking of You — from Ben/);
});

test('a custom occasion titles the card with its (escaped) label', () => {
  const { subject, html } = renderECard({
    kind: 'custom', template: 'custom-midnight', occasionLabel: 'Graduation <Day>',
    toName: 'Sam', fromName: 'Ben', message: 'Congrats!',
  });
  assert.ok(subject.includes('Graduation <Day>'), 'label headlines the subject');
  assert.ok(!subject.includes(', Sam'), 'custom labels skip the name-in-subject');
  assert.ok(html.includes('Graduation &lt;Day&gt;'), 'label escaped in html');
});

test('author overrides replace the framing lines; fonts and inline photos render', () => {
  const { subject, html, text } = renderECard({
    kind: 'birthday', template: 'birthday-confetti', toName: 'Sam', fromName: 'Ben',
    greeting: 'Hey Sammy!', signoff: 'Big hugs,', signature: 'Uncle Ben & co',
    font: 'elegant', message: 'hi', photoCids: ['p-0@calen', 'p-1@calen'],
  });
  assert.ok(html.includes('Hey Sammy!') && !html.includes('Dear Sam,'), 'greeting override wins');
  assert.ok(html.includes('Big hugs,') && !html.includes('With love,'), 'signoff override wins');
  assert.ok(html.includes('Uncle Ben &amp; co'), 'signature override (escaped) signs the card');
  assert.match(subject, /from Uncle Ben & co/, 'signature signs the subject too');
  assert.ok(html.includes('Palatino'), 'chosen font stack applied');
  assert.ok(html.includes('cid:p-0@calen') && html.includes('cid:p-1@calen'), 'photos embedded inline by cid');
  assert.ok(text.includes('Hey Sammy!') && text.includes('(2 photos attached)'), 'plaintext mirrors overrides');
});

test('the font menu offers the expected email-safe faces; unknown keys keep the template default', () => {
  assert.deepEqual(Object.keys(FONTS).sort(), ['elegant', 'sans', 'script', 'serif']);
  const dflt = renderECard({ kind: 'birthday', template: 'birthday-gold', toName: 'Sam', fromName: 'Ben' }).html;
  const bogus = renderECard({ kind: 'birthday', template: 'birthday-gold', toName: 'Sam', fromName: 'Ben', font: 'comic' }).html;
  assert.ok(dflt.includes('Georgia') && bogus.includes('Georgia'), 'serif template default survives an unknown font key');
});

test('the mobile picker mirrors the gallery keys exactly', () => {
  const mobileSrc = fs.readFileSync(
    path.join(__dirname, '../../../mobile/src/lib/ecardTemplates.ts'), 'utf8',
  );
  const mobileKeys = new Set([...mobileSrc.matchAll(/key: '([a-z-]+)'/g)].map((m) => m[1]));
  const serverKeys = new Set(Object.values(GALLERY).flat().map((v) => v.key));
  assert.deepEqual([...mobileKeys].sort(), [...serverKeys].sort(),
    'mobile/src/lib/ecardTemplates.ts must list the same template keys as the server gallery');
});
