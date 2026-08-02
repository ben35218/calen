// Navigable app views each Calen assistant can suggest as a one-tap shortcut.
//
// Model-driven: every mode's system prompt lists its destinations (id + when to
// offer it) and the model calls the `suggest_navigation` tool when a view is
// clearly relevant to the conversation. The tool doesn't navigate — it records a
// suggestion the client renders as a "navigate" chip (arrow icon). The mobile app
// maps each `id` to a screen in mobile/src/screens/chat/navDestinations.ts, so the
// ids here and there must stay in sync.

const SUGGEST_NAV_TOOL_NAME = 'suggest_navigation';

// Regular "go look at / act on this" view shortcuts (kind: 'nav', arrow chip).
const NAV_DESTINATIONS = {
  calendar: [
    { id: 'view_calendar', label: 'View your calendar', when: 'the user just wants to look at their calendar / what is coming up' },
    { id: 'calendar_search', label: 'Search your calendar', when: 'the user is looking for a specific event or wants to find something on their calendar' },
    { id: 'manage_calendars', label: 'Manage calendars', when: 'the user wants to add, hide, subscribe to, or recolour a calendar' },
    { id: 'birthdays', label: 'View birthdays', when: 'the conversation is about birthdays' },
    { id: 'weather', label: 'Check the weather', when: 'the user asks about the weather or forecast to plan around it' },
  ],
  chores: [
    { id: 'chores_list', label: 'View all chores', when: 'the user wants to see, edit, or check off their existing chores' },
    { id: 'chore_templates', label: 'Browse chore templates', when: 'the user wants ready-made ideas for common chores' },
  ],
  maintenance: [
    { id: 'maintenance_home', label: 'View maintenance', when: 'the user wants to see the items and tasks they already track' },
    { id: 'task_templates', label: 'Browse task templates', when: 'the user wants common maintenance tasks to add' },
  ],
  trips: [
    { id: 'open_trip', label: 'Open this trip', when: 'the user wants to see the full trip page and its itinerary' },
    { id: 'add_booking', label: 'Add a booking', when: 'the user wants to add a flight, hotel, or activity to this trip' },
    { id: 'trips_list', label: 'View all trips', when: 'the user wants to see or switch between their trips' },
  ],
};

// "Go set this up" shortcuts (kind: 'setup', gear chip) — surfaced REACTIVELY,
// only when a task hits a value the user hasn't configured. Each id maps to the
// exact settings screen + field in mobile/src/screens/chat/navDestinations.ts,
// which arrives with a callout + highlight explaining what to set. The `all`
// group applies to every surface; per-surface groups add mode-specific gaps.
// These are DELIBERATELY separate from NAV_DESTINATIONS so the "offer one
// next-step every turn" fallback (DEFAULT_NAV / ensureActionableNav) never picks
// a setup screen — setup chips only appear when the model detects a real gap.
const CONFIG_DESTINATIONS = {
  all: [
    { id: 'setup_ai_personal_info', label: 'Turn on personal info', when: 'the user asks for something that needs their events, household members, or saved contacts but "Use personal & contact info" is turned off (you were told personal info is off, or a roster came back empty because of it)' },
    { id: 'setup_household', label: 'Set up your household', when: 'the user wants to share, assign, or invite someone but no household members are set up yet' },
  ],
  calendar: [
    { id: 'setup_home_address', label: 'Add your home address', when: 'the user asks about weather, local suggestions, or travel time but no home area/address is set' },
    { id: 'setup_event_phone', label: 'Add business phone', when: 'the user wants Calen to phone a business about an event but the event has no phone number on file' },
    { id: 'setup_contact', label: 'Add this contact', when: 'the user wants to call or email a professional who is not saved yet, or has no phone/email on file' },
    { id: 'setup_reminders', label: 'Set up reminders', when: 'the user wants reminders or alerts but reminders are turned off or no reminder time is set' },
  ],
  trips: [
    { id: 'setup_home_address', label: 'Add your home address', when: 'the user asks about travel time, packing for the weather, or getting to the airport but no home area/address is set' },
  ],
};

// Every setup destination for a surface = shared `all` gaps + that surface's own.
function configDests(surface) {
  return [...(CONFIG_DESTINATIONS.all || []), ...(CONFIG_DESTINATIONS[surface] || [])];
}

// The tool definition for a given surface — its `view` enum is that surface's
// view ids PLUS its setup ids (the model picks a setup id to guide the user to
// configure a missing value; see navPromptSection).
function navTool(surface) {
  const dests = [...(NAV_DESTINATIONS[surface] || []), ...configDests(surface)];
  return {
    name: SUGGEST_NAV_TOOL_NAME,
    description:
      'Offer the user a one-tap shortcut to a relevant screen in the app. Call this when opening a particular screen would help the user act on what you just discussed, OR to send the user to set up a value they haven\'t configured yet that your task needs. The shortcut appears as a suggestion chip; it does NOT navigate on its own, so still answer normally. Only suggest a screen when it is clearly relevant.',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: dests.map((d) => d.id), description: 'Which screen to offer a shortcut to.' },
      },
      required: ['view'],
    },
  };
}

// The fallback destination per surface — used to guarantee an actionable chip
// when the model didn't call suggest_navigation and nothing is pending review.
const DEFAULT_NAV = {
  calendar: 'view_calendar',
  chores: 'chores_list',
  maintenance: 'maintenance_home',
  trips: 'open_trip',
};

// A system-prompt section listing the surface's destinations and when to offer
// them. We want an actionable next step on EVERY turn, so the model is told to
// always offer the single most helpful screen (unless a review/save action is
// already the user's next step — see ensureActionableNav for the safety net).
function navPromptSection(surface) {
  const dests = NAV_DESTINATIONS[surface] || [];
  if (!dests.length) return '';
  const lines = dests.map((d) => `- ${d.id} ("${d.label}") — best when ${d.when}`).join('\n');
  const setup = configDests(surface);
  const setupLines = setup.map((d) => `- ${d.id} ("${d.label}") — offer when ${d.when}`).join('\n');
  const setupSection = setup.length
    ? `\n## Setup shortcuts (offer only when a needed value isn't set)\nWhen the user's request needs a value they haven't configured yet, don't just tell them to go find it — briefly name what's missing and call ${SUGGEST_NAV_TOOL_NAME} ONCE with the matching setup screen below. It deep-links them straight to the field to fill. Offer a setup screen ONLY when its "offer when" condition genuinely applies; when it does, it REPLACES the usual next-step screen that turn (still just one chip).\nSetup screens:\n${setupLines}\n`
    : '';
  return `\n## Offer a next step (every reply)\nEnd every reply by calling ${SUGGEST_NAV_TOOL_NAME} ONCE with the single screen that would most help the user act on what they're doing right now. Pick the most relevant one; never offer more than one. The ONLY exception: if you've just drafted something for the user to review and save (an event, chore, or task plan), that review action is their next step, so skip ${SUGGEST_NAV_TOOL_NAME} that turn.\nScreens:\n${lines}\n${setupSection}`;
}

// Record a suggest_navigation tool call as a client-facing side effect. Dedupes,
// preserving order, and ignores unknown view ids. Stamps `kind` so the client
// can render setup shortcuts (gear) differently from view shortcuts (arrow).
function collectNav(block, acc, surface) {
  if (!block || block.name !== SUGGEST_NAV_TOOL_NAME) return;
  const navDest = (NAV_DESTINATIONS[surface] || []).find((d) => d.id === block.input?.view);
  const setupDest = navDest ? null : configDests(surface).find((d) => d.id === block.input?.view);
  const dest = navDest || setupDest;
  if (!dest) return;
  acc.navSuggestions = acc.navSuggestions || [];
  if (!acc.navSuggestions.some((n) => n.view === dest.id)) {
    acc.navSuggestions.push({ view: dest.id, label: dest.label, kind: setupDest ? 'setup' : 'nav' });
  }
}

// Safety net: guarantee at least one actionable (navigate) chip. Call from a
// route's followupsOverride (which runs after the tool loop, before the response
// is sent). Skips when `hasPending` — the pending review/save chip is already the
// actionable next step — or when the model already offered a screen.
function ensureActionableNav(acc, surface, hasPending) {
  if (hasPending) return;
  if (acc.navSuggestions && acc.navSuggestions.length) return;
  const dest = (NAV_DESTINATIONS[surface] || []).find((d) => d.id === DEFAULT_NAV[surface]);
  if (dest) acc.navSuggestions = [{ view: dest.id, label: dest.label, kind: 'nav' }];
}

module.exports = {
  SUGGEST_NAV_TOOL_NAME,
  NAV_DESTINATIONS,
  CONFIG_DESTINATIONS,
  configDests,
  navTool,
  navPromptSection,
  collectNav,
  ensureActionableNav,
};
