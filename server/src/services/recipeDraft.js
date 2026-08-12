// Turning a model's answer into a recipe draft (spec: features/kitchen.md).
//
// Every AI recipe path — import from a URL, scan photos, generate from a
// description, edit with an instruction — hands back JSON the client reviews and
// then SEALS. The server never sees a recipe again after that, so whatever these
// routes return is what the household lives with: the parse and the cleanup both
// belong here, in one door, rather than repeated per route.

const { titleCase } = require('./groceryNames');

// Pull an explicit timed-wait duration out of each instruction step so the
// planner/cooking view can show a timer chip. Deterministic (no AI, no tokens):
// reads the times the steps already state, e.g. "simmer for 20 minutes",
// "bake 25 min", "chill 1 hour". Returns minutes per step (null when none), or
// null overall when no step states a time.
function deriveInstructionTimers(instructions) {
  if (!Array.isArray(instructions) || !instructions.length) return null;
  // A duration, optionally a range ("20 to 25 minutes") whose upper bound wins.
  const DUR = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|to|and)\s*(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|minutes?|mins?)\b/gi;
  let any = false;
  const timers = instructions.map((step) => {
    if (typeof step !== 'string') return null;
    let best = null;
    DUR.lastIndex = 0;
    let m;
    while ((m = DUR.exec(step))) {
      const isHour = m[3].toLowerCase().startsWith('h');
      const val = Number(m[2] ?? m[1]); // upper bound of a range, else the value
      const mins = Math.round(isHour ? val * 60 : val);
      // A step often mentions several times ("sauté 2 min, then simmer 20 min");
      // the longest is the meaningful unattended wait to count down.
      if (mins > 0 && (best == null || mins > best)) best = mins;
    }
    if (best != null) any = true;
    return best;
  });
  return any ? timers : null;
}

// Models fence their JSON about half the time, and they write ingredient names
// however the source did — a scanned card or a webpage comes back all-lowercase
// as often as not, which reads as broken next to a hand-typed row. Casing is the
// same pass the grocery list uses, so a recipe and its shopping row agree.
// Timers ride the same door: any draft that arrives with instruction steps
// leaves with their stated wait times surfaced as instructionTimers.
function parseRecipeDraft(raw) {
  const parsed = JSON.parse(
    String(raw).trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '')
  );
  if (Array.isArray(parsed?.ingredients)) {
    parsed.ingredients = parsed.ingredients.map((ing) => (
      typeof ing?.name === 'string' ? { ...ing, name: titleCase(ing.name) } : ing
    ));
  }
  if (!parsed?.instructionTimers) {
    const timers = deriveInstructionTimers(parsed?.instructions);
    if (timers) parsed.instructionTimers = timers;
  }
  return parsed;
}

module.exports = { parseRecipeDraft, deriveInstructionTimers };
