const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
// Signal-parity C3b: calendar/task/contact content lives in the opaque store, so
// this assistant reads it only from the client's decrypted context. PhoneCall +
// WeatherRecord stay their own (non-migrated) collections.
const PhoneCall = require('../models/PhoneCall');
const WeatherRecord = require('../models/WeatherRecord');
const { requireAuth } = require('../middleware/auth');
const { requireAiEnabled } = require('../middleware/aiConsent');
const { streamChat, webSearchTool, WEB_SEARCH_SYSTEM_NOTE } = require('../services/chatStream');
const { meter, getConfig, creditStatus } = require('../middleware/usageMeter');
const { callDebitMc } = require('../services/credits');
const { ASSISTANT_NAME } = require('../config/assistant');
const { assembleCalendarData, deriveAvailability } = require('@household/calendar');
const { navTool, navPromptSection, collectNav, ensureActionableNav, SUGGEST_NAV_TOOL_NAME } = require('../services/navDestinations');
const { fetchVapiCall, applyVapiToRow, placeCall } = require('../services/phoneCalls');

const router = express.Router();
router.use(requireAuth);
router.use(requireAiEnabled);

// Waking window for availability (household-local). Free time is computed inside
// this band; hours outside it aren't offered as "free". Kept here (not a config)
// until there's a reason to make it per-household.
const DAY_WINDOW = { startMinutes: 8 * 60, endMinutes: 22 * 60, label: '08:00–22:00' };
const DEFAULT_TZ = 'America/Toronto'; // matches Household.timezone's default

// Tools that expose or act on individual calendar RECORDS. When the privacy
// toggle "Use personal & contact info in prompts" is off (includePersonalInfo:
// false), these are withheld from the model entirely — the assistant then sees
// the user's free/busy availability only, never event titles or details, and
// can't edit, delete, or place calls about specific events. Availability
// (get_availability), creating brand-new events, weather, and navigation stay.
const RECORD_TOOL_NAMES = new Set([
  'list_events', 'get_event_details',
  'open_edit_event_form', 'delete_event',
  'call_business', 'check_call_status',
]);

const RECORDS_HIDDEN_MESSAGE =
  'Calendar details are hidden because “Use personal & contact info in prompts” is turned off in Privacy & data controls. ' +
  'In this chat you can see the user’s free/busy availability only (get_availability) — not event titles or details — and you can’t open, edit, delete, or place calls about specific events. ' +
  'Tell the user they can turn that setting on to let you see and act on individual events, and offer to help with their availability instead.';

// Only calendar EVENTS (Activities/Appointments) can be edited or deleted from
// this chat; maintenance/chores/meals/grocery/trips are managed elsewhere.
const EDITABLE_CALENDARS = new Set(['activities', 'appointments']);

// Resolve an editable event by id from the focused event or the client's
// decrypted sources (same lookup as call_business — C3b sealed store, no server
// plaintext). Returns the event, or an `{ error }` object the tool passes back
// to the model (not found, or a read-only calendar it may not modify).
function findEditableEvent(ctx, eventId) {
  const event =
    (ctx.focusEvent && String(ctx.focusEvent._id) === String(eventId) ? ctx.focusEvent : null) ||
    (ctx.calendarSources?.events || []).find(e => String(e._id) === String(eventId));
  if (!event) return { error: 'Event not found. Call list_events to get a current event id first.' };
  if (!EDITABLE_CALENDARS.has(event.calendarType)) {
    return { error: `That entry is on the ${event.calendarType || 'read-only'} calendar, which is managed elsewhere — only Activities and Appointments events can be edited or deleted from here.` };
  }
  return event;
}

const TOOLS = [
  {
    name: 'list_events',
    description: `List ALL calendar records in a date range, across every calendar shown on the user's calendar page. Recurring tasks, chores, and events are already expanded into their individual occurrences within the range, so each dated entry returned is a real occurrence (with a "recurrence" summary describing the repeat pattern). Entries are titles + dates only — use get_event_details for one event's description/location. Returns:
- maintenance: home maintenance task occurrences
- chores: household chore occurrences
- activities / appointments: calendar events
- meals: planned recipes (meal calendar)
- groceryDays: grocery shopping days
- trips: trips with their date range(s) and status (DATES ONLY — for the itinerary/details inside a trip, the user should use the Trip Assistant on the Trips page)`,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date in ISO 8601 format' },
        to:   { type: 'string', description: 'End date in ISO 8601 format' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_event_details',
    description: "Get one event's full details (description, location, whether a business phone is on file). Use after list_events when the conversation needs more than the title and date.",
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'ID of the event, from list_events' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'get_availability',
    description: `Get the user's free/busy availability across a date range. Use this for PLANNING questions — "when am I free?", "suggest a day/time for X", "find an open weekend", "when could we fit in Y". It reduces the calendar to what actually OCCUPIES time so you don't have to reason over every event yourself:
- Timed events (appointments & activities) become BUSY blocks (start–end, ${DAY_WINDOW.label} household-local).
- Trips become whole "away" days.
- All-day events surface as an "allDayCommitments" note but do NOT block the day's hours — an all-day entry may be a real commitment or just a label, so mention it and let the user decide.
- Maintenance, chores, meals, and grocery days are NOT counted as busy (they're reminders/plans, not occupied time).
Each day's status is 'free' (nothing committed), 'partial' (some open gaps + the busy/free blocks), 'busy' (no free time in the waking window), or 'away' (on a trip). For a specific event's title or details, or to find an event's id to edit/cancel/call about, use list_events / get_event_details instead.`,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date in ISO 8601 format' },
        to:   { type: 'string', description: 'End date in ISO 8601 format' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_household_members',
    description: "List the household's members and friends (names only) plus the user's saved professionals (with the business details they were saved for — service, business name, address; phone/email appear as 'on file' flags only). Use when the conversation involves who is in the household (e.g. planning who joins an outing) or which professional handles something (e.g. the plumber, the vet).",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_create_event_form',
    description: 'Navigate the user to the event creation form, pre-filled with the provided details. The user reviews and saves the event themselves.',
    input_schema: {
      type: 'object',
      properties: {
        calendarType: { type: 'string', enum: ['activities', 'appointments'], description: 'Calendar type' },
        title:        { type: 'string', description: 'Event title' },
        description:  { type: 'string', description: 'Optional notes about the event. Do NOT put the venue/business name, address, or phone here — those belong in the dedicated location and phone fields.' },
        location:     { type: 'string', description: 'Where the event takes place. When it is at a business, venue, or address, fill this with the place name and full street address, e.g. "Bright Smiles Dental, 123 Main St, Ottawa ON K1A 0B1". Always prefer this over putting the place in description.' },
        date:         { type: 'string', description: 'Event date in YYYY-MM-DD format' },
        endDate:      { type: 'string', description: 'Optional end date in YYYY-MM-DD format for multi-day events (different day than start)' },
        allDay:       { type: 'boolean', description: 'True for all-day events (default). Set to false when a specific start/end time is given.' },
        startTime:    { type: 'string', description: 'Start time in HH:MM 24-hour format, e.g. "14:00". Required when allDay is false.' },
        endTime:      { type: 'string', description: 'End time in HH:MM 24-hour format, e.g. "14:30". Required when allDay is false.' },
        recurrFreq:      { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'Repeat frequency if the event recurs' },
        recurrInterval:  { type: 'number', description: 'For custom repeats like "every 2 weeks": recurrFreq is the unit (weekly) and this is N (2). Omit for simple repeats.' },
        reminderMinutes: { type: 'number', description: 'Alert before the event, in minutes. On a TIMED event (allDay false): 0=at event time, 15, 30, 60, 120, 1440 (1 day). On an ALL-DAY event there is no start time to count back from, so use whole days only — 0 (on the day itself), 1440 (1 day before), 2880 (2 days), 10080 (1 week) — and it is delivered at the user\'s day-alert time. Omit for no alert.' },
        phone:           { type: 'string', description: 'Business phone number for the place in location (for appointments; used to dial for cancel/reschedule). Keep it out of description.' },
      },
      required: ['calendarType', 'title', 'date'],
    },
  },
  {
    name: 'open_edit_event_form',
    description: "Open the event's edit form on the user's device (pre-loaded), so they can change details and save. Use list_events first to find the event ID (an editable Activities/Appointments event). This does NOT change the event itself — the user makes and saves the edits in the form; describe what you're suggesting they change in your reply.",
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'ID of the event to edit' },
        occurrenceDate: { type: 'string', description: 'For a recurring event: the specific occurrence day (YYYY-MM-DD) the user is editing, so the form opens on that day.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description: `Stage the deletion of an editable event (Activities/Appointments) for the user to confirm with a single tap. Call it ONCE PER EVENT to remove — you may stage several in the same turn to clear a range of days ("clear my calendar next week"); the user then confirms them all with one tap. This does NOT delete anything by itself: nothing is removed until the user taps the confirm chip. Use list_events first to find the event ID(s). NEVER claim an event was deleted before the user has confirmed.`,
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'ID of the event to delete (from list_events)' },
        occurrenceDate: { type: 'string', description: 'For a recurring event: the specific occurrence day (YYYY-MM-DD) to remove. Required when scope is "occurrence".' },
        scope: {
          type: 'string',
          enum: ['occurrence', 'series'],
          description: "For a RECURRING event only: 'occurrence' removes just the single day at occurrenceDate (the series keeps repeating); 'series' removes the entire repeating event. Defaults to 'occurrence'. Ask the user which they mean if it's unclear. Ignored for one-off events.",
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'call_business',
    description: `Place an AI phone call to a business to cancel or reschedule an appointment.
The AI voice agent handles the full conversation including IVR menus, hold times, and live receptionists.
The call is asynchronous — use check_call_status to get the outcome once it completes (typically 2–5 minutes).
Requires a phone number on the event. If none is stored, ask the user to add one first.`,
    input_schema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'ID of the appointment event to call about',
        },
        action: {
          type: 'string',
          enum: ['cancel', 'reschedule'],
          description: 'What to request from the business',
        },
        callerName: {
          type: 'string',
          description: 'Name to give the business when asked (e.g. "John Smith")',
        },
        newDateTime: {
          type: 'string',
          description: 'For reschedule: requested new date/time in plain English (e.g. "next Tuesday at 2pm")',
        },
        additionalInstructions: {
          type: 'string',
          description: 'Any extra context for the AI caller (e.g. "mention it is a follow-up visit")',
        },
        shareContactDetails: {
          type: 'boolean',
          description: "Set true ONLY if the user explicitly agreed the business may be given their phone/email for identity verification. Defaults to false — the caller then gives only the user's name.",
        },
      },
      required: ['eventId', 'action'],
    },
  },
  {
    name: 'check_call_status',
    description: 'Check the status and outcome summary of a call placed by call_business. Call IDs are returned by call_business; omit callId to check the most recently placed call (e.g. when the user asks "any update on the call?" in a fresh conversation).',
    input_schema: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: 'The call_id returned by call_business. Omit to check the most recent call.' },
      },
      required: [],
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Get the stored weather forecast for a date range. Returns daily conditions including temperature, precipitation, wind, and whether it is a good weather day.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        to:   { type: 'string', description: 'End date in YYYY-MM-DD format' },
      },
      required: ['from', 'to'],
    },
  },
  navTool('calendar'),
];

// Human-readable summary of a maintenance task / chore recurrence rule.
function describeTaskRecurrence(r) {
  if (!r || r.type === 'one-time') return 'one-time';
  if (r.type === 'calendar') {
    const months = (r.months || []).join(', ');
    return `calendar (months ${months}, day ${r.dayOfMonth || 1})`;
  }
  if (r.type === 'interval') {
    return `every ${r.intervalValue || 1} ${r.intervalUnit || 'months'}`;
  }
  return 'recurring';
}

// Human-readable summary of a calendar-event recurrence rule.
function describeEventRecurrence(rec) {
  if (!rec || !rec.freq) return null;
  const every = rec.interval && rec.interval > 1 ? `every ${rec.interval} ` : '';
  const unit = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' }[rec.freq] || rec.freq;
  const until = rec.until ? `, until ${new Date(rec.until).toISOString().slice(0, 10)}` : '';
  return `${every}${unit}${until}`.trim();
}

async function executeTool(name, input, ctx) {
  const { userId, scopeIds, user, household } = ctx;
  // Navigation suggestions record intent only (surfaced via collectSideEffects).
  if (name === SUGGEST_NAV_TOOL_NAME) return { acknowledged: true };
  // Privacy toggle off: record tools are already withheld from the model, but
  // guard here too so a bypassed client can never read record content this way.
  if (ctx.includePersonalInfo === false && RECORD_TOOL_NAMES.has(name)) {
    return { error: RECORDS_HIDDEN_MESSAGE };
  }
  switch (name) {
    case 'list_events': {
      const fromDate = new Date(input.from);
      const toDate   = new Date(input.to);

      // Signal-parity C3b: calendar content is sealed in the opaque store, so the
      // assistant expands the CLIENT's decrypted sources with the shared engine
      // (the same code the server uses) — there is no server-plaintext fallback.
      const data = assembleCalendarData({
        ...(ctx.calendarSources || { events: [], tasks: [], chores: [], contacts: [], trips: [], recipeSchedules: [] }),
        fromDate, toDate,
        selfId: String(userId),
        groceryShoppingDay: (household || user)?.groceryShoppingDay ?? null,
        groceryFrequency: (household || user)?.groceryFrequency ?? 'weekly',
        groceryAnchor: (household || user)?.groceryAnchor ?? null,
      });

      // Data minimization (spec: friends/family name-only; references not
      // values): titles + dates only — descriptions/locations go via
      // get_event_details, phone numbers never (presence flag only), and no
      // birthdays section (no birthdays reach this chat — family/friends are
      // name-only and professionals share business details only — so there are
      // no birthday occurrences to expand).
      const eventFields = (e) => ({
        id: e._id,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        allDay: e.allDay,
        phoneOnFile: !!e.phone,
        recurrence: describeEventRecurrence(e.recurrence),
      });

      return {
        maintenance: data.tasks.map(t => ({
          id: t._id, title: t.title, date: t.nextDueDate,
          item: t.itemId?.name, recurrence: describeTaskRecurrence(t.recurrence),
        })),
        chores: data.chores.map(c => ({
          id: c._id, title: c.title, date: c.nextDueDate,
          recurrence: describeTaskRecurrence(c.recurrence),
        })),
        activities: data.events.filter(e => e.calendarType === 'activities').map(eventFields),
        appointments: data.events.filter(e => e.calendarType === 'appointments').map(eventFields),
        meals: data.recipes.map(r => ({
          id: r._id, date: r.scheduledDate,
          title: r.recipeId?.title, servings: r.servings,
        })),
        groceryDays: data.groceryShopping.map(g => g.date),
        trips: data.trips.map(t => ({
          name: t.name, destination: t.destination, status: t.status,
          ranges: t.ranges.map(r => ({
            start: new Date(r.start).toISOString().slice(0, 10),
            end: new Date(r.end).toISOString().slice(0, 10),
            label: r.label,
          })),
          note: 'Dates only — use the Trip Assistant for this trip\'s itinerary and details.',
        })),
      };
    }

    case 'get_availability': {
      const fromDate = new Date(input.from);
      const toDate   = new Date(input.to);
      const availTz = household?.timezone || user?.timezone || DEFAULT_TZ;

      // Privacy toggle off: the calendar records never left the device, so there
      // is nothing here to reduce — the client computed availability locally
      // (title-stripped) and sent it. Filter that to the requested day range.
      if (Array.isArray(ctx.availability)) {
        const fromKey = String(input.from).slice(0, 10);
        const toKey   = String(input.to).slice(0, 10);
        const days = ctx.availability.filter(
          (d) => d && typeof d.date === 'string' && d.date >= fromKey && d.date <= toKey,
        );
        return { timezone: availTz, wakingWindow: DAY_WINDOW.label, detailsHidden: true, days };
      }

      // Same assembly as list_events (C3b: the client's decrypted sources,
      // expanded by the shared engine — no server-plaintext fallback), then
      // reduced to free/busy. Only events + trips occupy time; tasks, chores,
      // meals, and grocery days are deliberately NOT passed to deriveAvailability
      // (they're reminders/plans, not commitments — see the shared engine note).
      const data = assembleCalendarData({
        ...(ctx.calendarSources || { events: [], tasks: [], chores: [], contacts: [], trips: [], recipeSchedules: [] }),
        fromDate, toDate,
        selfId: String(userId),
        groceryShoppingDay: (household || user)?.groceryShoppingDay ?? null,
        groceryFrequency: (household || user)?.groceryFrequency ?? 'weekly',
        groceryAnchor: (household || user)?.groceryAnchor ?? null,
      });

      const timezone = household?.timezone || user?.timezone || DEFAULT_TZ;
      return {
        timezone,
        wakingWindow: DAY_WINDOW.label,
        days: deriveAvailability({
          events: data.events, trips: data.trips, fromDate, toDate, timezone,
          dayStartMinutes: DAY_WINDOW.startMinutes, dayEndMinutes: DAY_WINDOW.endMinutes,
        }),
      };
    }

    case 'get_event_details': {
      const ev =
        (ctx.focusEvent && String(ctx.focusEvent._id) === String(input.eventId) ? ctx.focusEvent : null) ||
        (ctx.calendarSources?.events || []).find(e => String(e._id) === String(input.eventId));
      if (!ev) return { error: 'Event not found — use list_events to find the event ID.' };
      return {
        id: ev._id,
        title: ev.title,
        calendarType: ev.calendarType,
        startDate: ev.startDate,
        endDate: ev.endDate,
        allDay: ev.allDay,
        description: ev.description || null,
        location: ev.location || null,
        phoneOnFile: !!ev.phone,
        recurrence: describeEventRecurrence(ev.recurrence),
      };
    }

    case 'get_household_members': {
      // Spec (ai-assistant.md): family/friends are name-only; saved professionals
      // (service contacts) also share the business details the user saved them for
      // (service + business name + address). Phone/email stay "on file" flags — the
      // app dials/emails; the real values never reach you (references, not values).
      const contacts = Array.isArray(ctx.contacts) ? ctx.contacts : [];
      if (!contacts.length) {
        return {
          message: 'No household members are shared with this chat (none added, or personal info is turned off in Privacy).',
          setup_hint: 'If the user needs household members for this request, offer suggest_navigation with setup_household so they can add contacts (or setup_ai_personal_info if it may be off).',
        };
      }
      const nameOf = (p) => (p.isSelf ? `${p.name} (the user you are assisting)` : p.name);
      const proOf = (p) => {
        const parts = [p.name];
        if (p.service) parts.push(`(${p.service})`);
        if (p.businessName) parts.push(`— ${p.businessName}`);
        if (p.address) parts.push(`— ${p.address}`);
        const onFile = [p.phoneOnFile && 'phone', p.emailOnFile && 'email'].filter(Boolean);
        if (onFile.length) parts.push(`[${onFile.join(' & ')} on file]`);
        return parts.join(' ');
      };
      return {
        household: contacts.filter(p => p.type === 'family').map(nameOf),
        friends: contacts.filter(p => p.type === 'friend').map(nameOf),
        professionals: contacts.filter(p => p.type === 'service').map(proOf),
        note: 'Household & friends: names only. Professionals: business details as shown; any "on file" phone/email is used by the app for dialing/emailing and is never shown to you.',
      };
    }

    case 'open_create_event_form': {
      const params = new URLSearchParams();
      if (input.title)                params.set('prefill_title', input.title);
      if (input.calendarType)         params.set('prefill_calendarType', input.calendarType);
      if (input.date)                 params.set('prefill_date', input.date);
      if (input.endDate)              params.set('prefill_endDate', input.endDate);
      if (input.allDay !== undefined)  params.set('prefill_allDay', String(input.allDay));
      if (input.startTime)            params.set('prefill_startTime', input.startTime);
      if (input.endTime)              params.set('prefill_endTime', input.endTime);
      if (input.recurrFreq)                params.set('prefill_recurrFreq', input.recurrFreq);
      if (input.recurrInterval)            params.set('prefill_recurrInterval', String(input.recurrInterval));
      if (input.reminderMinutes !== undefined) params.set('prefill_reminderMinutes', String(input.reminderMinutes));
      if (input.description)               params.set('prefill_description', input.description);
      if (input.location)             params.set('prefill_location', input.location);
      if (input.phone)                params.set('prefill_phone', input.phone);
      return { navigateTo: `/calendar/event/new?${params.toString()}` };
    }

    case 'open_edit_event_form': {
      const event = findEditableEvent(ctx, input.eventId);
      if (event.error) return event;
      // Staged: the client opens the native edit form pre-loaded on this event.
      // The user makes and saves the edits there — nothing changes server-side here.
      return { staged: true, eventId: String(input.eventId), title: event.title || 'Event', occurrenceDate: input.occurrenceDate };
    }

    case 'delete_event': {
      const event = findEditableEvent(ctx, input.eventId);
      if (event.error) return event;
      const recurring = !!(event.recurrence && event.recurrence.freq);
      const scope = recurring && input.scope === 'series' ? 'series' : 'occurrence';
      // Staged ONLY — nothing is deleted here. The client stages this under a
      // single confirm chip and, on tap, runs the delete (recurring events
      // resolve to occurrence-exclude vs whole-series delete via the shared
      // eventDelete logic). Returning here does not remove anything.
      return {
        staged: true,
        eventId: String(input.eventId),
        title: event.title || 'Event',
        recurring,
        scope,
        occurrenceDate: input.occurrenceDate,
      };
    }

    case 'call_business': {
      const vapiKey = process.env.VAPI_API_KEY;
      const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
      if (!vapiKey)       return { error: 'VAPI_API_KEY is not configured on the server' };
      if (!phoneNumberId) return { error: 'VAPI_PHONE_NUMBER_ID is not configured on the server' };

      // Event lookup (C3b: sealed store — no server-plaintext fallback): the
      // focused event (chat opened from an event's Ask Calen), then the client-
      // supplied decrypted sources.
      const event =
        (ctx.focusEvent && String(ctx.focusEvent._id) === String(input.eventId) ? ctx.focusEvent : null) ||
        (ctx.calendarSources?.events || []).find(e => String(e._id) === String(input.eventId));
      if (!event) return { error: 'Event not found' };
      if (!event.phone) {
        return {
          error: 'No phone number stored for this appointment. Please add the business phone number to the event first, then try again.',
          setup_hint: 'Offer suggest_navigation with setup_event_phone so the user can add the business number to this event, then try again.',
        };
      }

      // Credit pre-check (mirrors meterCallSeconds on the direct routes): a call
      // must be affordable up front — the balance has to cover at least one
      // minute at the call rate.
      const callConfig = await getConfig();
      const standing = creditStatus(ctx.user, callConfig);
      if (!standing.unlimited && standing.balanceMc < callDebitMc(60, callConfig)) {
        return { error: 'You’re out of AI credits — buy a credit pack in Profile → Credits to place calls.' };
      }

      // Shared with the event view's "Call to Cancel" card (services/phoneCalls).
      // The user's phone/email ride along only when they explicitly agreed
      // (spec: contact details are per-call opt-in); the name is always given.
      // A do-not-call suppression (the business asked not to be called again on a
      // prior call) surfaces as a plain tool error so the model can explain it.
      let row;
      try {
        row = await placeCall({
          userId: ctx.userId,
          householdId: ctx.household?._id,
          event,
          action: input.action,
          callerName: input.callerName,
          newDateTime: input.newDateTime,
          additionalInstructions: input.additionalInstructions,
          contact: input.shareContactDetails === true
            ? {
                name: [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(' ') || undefined,
                phone: ctx.user.phone || undefined,
                email: ctx.user.email || undefined,
              }
            : undefined,
        });
      } catch (e) {
        if (e.code === 'DNC_SUPPRESSED') return { error: e.message };
        throw e;
      }

      return {
        success: true,
        callId: row.callId,
        phone: row.phone,
        message: `Call queued to ${row.phone}. The AI voice agent will handle the conversation. Use check_call_status with callId "${row.callId}" to get the outcome (usually ready in 2–5 minutes).`,
      };
    }

    case 'check_call_status': {
      const vapiKey = process.env.VAPI_API_KEY;
      if (!vapiKey) return { error: 'VAPI_API_KEY is not configured on the server' };

      // The chat history the client resends is text-only, so a follow-up turn
      // often has no callId — fall back to the household's most recent call.
      let callId = input.callId;
      if (!callId) {
        const latest = await PhoneCall.findOne({ userId: { $in: scopeIds } }).sort({ createdAt: -1 }).lean();
        if (!latest) return { error: 'No calls have been placed yet.' };
        callId = latest.callId;
      }

      const data = await fetchVapiCall(callId);

      // Keep the stored call record in step, and count an in-chat status check
      // as having seen the outcome (no badge for a result the user just read).
      try {
        const row = await PhoneCall.findOne({ callId });
        if (row) {
          await applyVapiToRow(row, data);
          if (PhoneCall.isTerminal(row.status) && !row.seenAt) {
            row.seenAt = new Date();
            await row.save();
          }
        }
      } catch (e) {
        console.error('PhoneCall record update failed:', e.message);
      }

      // Summary only — the full transcript never enters model context (spec).
      // The user can read the transcript on the call detail view in the app.
      return {
        status: data.status,
        endedReason: data.endedReason ?? null,
        durationSeconds: data.callLength ?? null,
        summary: data.summary ?? data.analysis?.summary ?? null,
      };
    }

    case 'get_weather_forecast': {
      // Ephemeral-consent (§9.1 P5): when the client supplied its forecast (it
      // fetched it from open-meteo over the decrypted location), filter that
      // instead of the server WeatherRecord cache. Already in the right shape.
      if (ctx.weather && Array.isArray(ctx.weather.forecast)) {
        const days = ctx.weather.forecast.filter(d =>
          (!input.from || d.date >= input.from) && (!input.to || d.date <= input.to));
        return days.length ? { forecast: days } : { message: 'No weather data for that range.' };
      }

      const records = await WeatherRecord.find({
        userId,
        date: { $gte: input.from, $lte: input.to },
      }).sort({ date: 1 }).lean();

      if (!records.length) {
        return { message: 'No weather data stored for this range. The forecast is populated when the weather widget loads.' };
      }

      return {
        forecast: records.map(r => ({
          date:              r.date,
          description:       r.description,
          tempMax:           r.tempMax,
          tempMin:           r.tempMin,
          precipSum:         r.precipSum,
          precipProbability: r.precipProbability,
          windMax:           r.windMax,
          goodWeather:       r.goodWeather,
          hours:             r.hours ?? [],
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt(req, focusEvent = null, includePersonalInfo = true) {
  const today = new Date().toISOString();
  const userName = req.user.name || 'the user';

  // Coarse home area (city + region/country) so local suggestions match where
  // the household actually is instead of being inferred from the timezone. This
  // is the ONLY geographic value in the prompt — the street address is never
  // sent (ai-assistant.md "Home area is coarse, not the street address").
  const homeCity = (req.household?.homeCity || req.user?.homeCity || '').trim();
  const homeAreaSection = homeCity
    ? `\n## Home area
The household is based in ${homeCity}. When you suggest places, outings, or activities, or run a web search for local options, use this area — do NOT infer their location from the timezone. This is a general area only; you don't know their street address, so don't ask for or assume one.\n`
    : `\n## Home area
No home area is set for this household. If the user asks about the weather, local suggestions, or travel time, you can't tailor it to where they are — briefly say a home address is needed and offer the setup_home_address shortcut (via suggest_navigation) so they can add one. Don't guess their location from the timezone.\n`;

  // Privacy toggle OFF ("Use personal & contact info in prompts"): the calendar
  // records never left the device, so this is a reduced assistant — it sees the
  // user's free/busy availability only and cannot read, edit, or call about
  // specific events, or see household members. Its tools are filtered to match,
  // so this shorter prompt describes exactly what remains available.
  if (!includePersonalInfo) {
    return `You are ${ASSISTANT_NAME}, the friendly assistant in the Calen app, helping ${userName} with their home calendar. Today is ${today}.

## Be concise
Lead with the outcome or answer. Keep replies to a sentence or two whenever you can; drop preamble, acknowledgements, and filler ("Great!", "Sure thing!", "I'd be happy to", or restating the user's request back to them). Don't narrate what you're about to do or add sign-offs. When you recap a drafted event, give just the essential details — date, time, place. Add more only when the user asks for it.
${homeAreaSection}
## Privacy mode: calendar details are hidden
The user has turned OFF "Use personal & contact info in prompts" in Privacy & data controls. In this chat you can therefore see their FREE/BUSY availability ONLY — never event titles, descriptions, locations, who is involved, trip details, their household members, or their saved professionals. You have no tool to list, open, edit, delete, or place calls about specific events.

What you CAN do:
- Call get_availability(from, to) to see when the user is free or busy. It returns each day as 'free', 'partial' (with open gaps + busy hour-blocks), 'busy', or 'away' (on a trip) within a household-local waking window (${DAY_WINDOW.label}). Busy blocks carry times only — no titles. All-day commitments appear as a count for that day (no titles), and 'away' days name no trip. Use this for every "when am I free?", "suggest a day/time", or "find an open slot" question.
- Create a BRAND-NEW event with open_create_event_form (pre-fills the create form for the user to review and save). After drafting one, recap the details and tell the user they can tap "Save this to my calendar" or "Edit in form". Nothing is saved until they do.
- Check the weather with get_weather_forecast, suggest activities and good-weather days, search the web, and offer navigation shortcuts.

If the user asks what's on their calendar, or to change, cancel, move, or call about a specific event, do NOT guess — briefly explain that seeing or acting on individual events needs "Use personal & contact info in prompts" turned on in Privacy & data controls, then offer the setup_ai_personal_info shortcut (via suggest_navigation) so they can turn it on, and offer to help around their availability meanwhile. Always confirm what you've done and ask for clarification when a request is ambiguous.
${navPromptSection('calendar')}`;
  }

  // "Ask Calen" from an event: pin the event so "this appointment" resolves
  // without a list_events round-trip (and despite E2EE-sealed DB rows).
  // Phone number by presence only — the server dials, the model never needs it.
  const focusSection = focusEvent
    ? `\n## Focused event
The user opened this chat from a specific event — when they say "this appointment/event", they mean:
- Title: ${focusEvent.title}
- Event id: ${focusEvent._id}
- When: ${focusEvent.startDate || 'unknown'}${focusEvent.allDay ? ' (all-day)' : ''}
- Calendar: ${focusEvent.calendarType || 'unknown'}${focusEvent.location ? `\n- Location: ${focusEvent.location}` : ''}
- Business phone on file: ${focusEvent.phone ? 'yes' : 'none'}
You may pass this event id directly to call_business / open_edit_event_form / delete_event without calling list_events first.${focusEvent.phone ? '' : '\nThere is no phone number stored, so before placing any call ask the user to add the business number to the event.'}\n`
    : '';

  return `You are ${ASSISTANT_NAME}, the friendly assistant in the Calen app, managing a family's home calendar. Today is ${today}. You are assisting ${userName}.
If asked who you are, say you're ${ASSISTANT_NAME} and that in this chat you can see the household calendar, the names of household members, and the user's saved professionals (each area of the app has its own ${ASSISTANT_NAME} chat with its own context — this one doesn't see trips, maintenance items, or recipes).

## Be concise
Lead with the outcome or answer. Keep replies to a sentence or two whenever you can; drop preamble, acknowledgements, and filler ("Great!", "Sure thing!", "I'd be happy to", or restating the user's request back to them). Don't narrate what you're about to do or add sign-offs. Use a short list only when several items genuinely need their own line. When you recap a drafted event or confirm an action, give just the essential details — date, time, place — not a full description. Add more only when the user asks for it.
${focusSection}${homeAreaSection}
## Household members & professionals
Call get_household_members when the conversation involves who is in the household (e.g. suggesting a family outing, deciding who to invite) or which saved professional handles something (e.g. the plumber, the vet, the dentist). Household members and friends come back as NAMES ONLY — no other personal details (no birthdays, addresses, or notes). Saved professionals also include the business details the user saved them for (service, business name, address); their phone/email are shown only as "on file" flags — the app dials or emails on the user's behalf, so you never see the real values. Don't guess or invent details about contacts; if you need something only the user knows, ask them.

You have access to stored weather forecast data via get_weather_forecast. Use it when the user asks about the weather, wants to plan outdoor activities, or when suggesting good days for outdoor events.

Use list_events to see what's scheduled. It returns EVERY calendar shown on the user's calendar page as titles + dates, and recurring items are already expanded into their individual occurrences in the requested range (each carries a "recurrence" summary of its repeat pattern, so you understand the cadence). Call get_event_details when you need one event's description or location. The calendars are:
- Maintenance: Home maintenance task occurrences (read-only — managed separately)
- Chores: Household chore occurrences (read-only — managed separately)
- Activities: Family activities, events, outings, social plans (editable events)
- Appointments: Doctor visits, meetings, service appointments (editable events)
- Meals: Planned recipes from the meal calendar (read-only here)
- Grocery days: Scheduled grocery shopping days (read-only)
- Trips: Trips with their date range(s) and status — DATES ONLY. You can see WHEN trips are, but not the bookings/itinerary inside them. If the user asks about what's planned within a trip (flights, hotels, activities, costs), tell them to open the Trip Assistant from the Trips page, which has the full itinerary.
(Birthdays are not shared with this chat.)

For PLANNING questions — when the user asks when they're free, wants you to suggest a day or time for something, or find an open slot ("when am I free this weekend?", "find a good afternoon for a picnic", "when can we fit in a dentist visit?") — call get_availability instead of eyeballing list_events yourself. It returns per-day free/busy already worked out: timed events as busy blocks, trips as "away" days, all-day events as a soft note that does NOT block the day (mention them, but treat the hours as open), and chores/meals/maintenance/grocery excluded because they don't occupy time. Reach for list_events (not get_availability) when the user wants to know WHAT is scheduled, or you need an event's id/title to edit, delete, or call about.

You can only create, edit, or delete Activities and Appointments (calendar events). Maintenance, chores, meals, grocery days, and trips are managed elsewhere — surface them for planning, but don't try to modify them.

You never change the calendar silently — every create, edit, and delete is confirmed by the user with a tap on a chip under your reply. NEVER say an event was added, changed, or deleted until the user has actually confirmed it (the tools below only STAGE the action).
- To add an event: call open_create_event_form with the details the user provided. Then briefly recap the event's details and tell the user they can tap "Save this to my calendar" to add it, or "Edit in form" to review and adjust it first. Do NOT say you've already opened a form or already saved the event — nothing is saved until the user taps one of those.
  - When the event happens at a business, venue, or address (an appointment, reservation, class, viewing, etc.), put that place in the dedicated location field — the place/business name plus its full street address — and put its phone number in the phone field. Do NOT stuff the business name, address, or phone into description/notes; description is for extra notes only. If a web search surfaced the venue, carry its name, address, and phone into location/phone.
- To edit an event: call list_events to find the event ID, then call open_edit_event_form. This opens the event's edit form on the user's device — in your reply, name what you're suggesting they change and tell them to tap "Open the event to edit"; they make and save the change themselves.
- To delete event(s): call list_events to find the ID(s), then call delete_event ONCE PER EVENT you want removed — you can stage several in the same turn to clear a range of days ("clear my calendar next week"). This does NOT delete anything yet; it stages the removal(s) behind a single "Delete from my calendar" tap. After staging, list exactly which events will be removed and tell the user to tap to confirm (or "Cancel, keep events"). NEVER claim anything is deleted until they have confirmed — if you're unsure whether a prior turn's deletion went through, check list_events rather than assuming. For a recurring event, pass occurrenceDate (the day to clear) with scope "occurrence" to remove just that one day, or scope "series" to remove the whole repeating event — ask which they mean if it isn't clear.

You can also place AI phone calls (via Vapi) to businesses to cancel or reschedule appointments using call_business. You never see phone numbers — "phoneOnFile" tells you whether one is stored, and the app dials it. Before calling:
1. Confirm the appointment has a phone number on file (phoneOnFile from list_events / get_event_details). If not, ask the user to add one.
2. Use ${userName} as the caller name unless the user specifies otherwise.
3. For reschedules, confirm the desired new date/time before calling.
4. Only set shareContactDetails if the user explicitly agreed the business may verify their phone/email.
After placing a call, tell the user it's in progress and offer to check the status with check_call_status.

Always confirm what you've done. Ask for clarification when dates, names, or intentions are ambiguous.
${navPromptSection('calendar')}`;
}

function buildContextSummary(contacts, includePersonalInfo = true, homeCity = '') {
  // Privacy toggle off: calendar records stay on the device, so the assistant
  // sees free/busy availability ONLY — be honest that titles/details are private.
  const sees = includePersonalInfo
    ? [
        'Every calendar — activities, appointments, maintenance, chores, meals, grocery days & trip dates',
        'When you’re free or busy — availability for planning around your commitments',
      ]
    : [
        'When you’re free or busy — your availability only (event titles & details stay on your device)',
      ];
  // Coarse home area (city), so the panel is honest about the assistant knowing
  // roughly where you are for local suggestions — never the street address.
  const area = (homeCity || '').trim();
  if (area) sees.push(`Your general area — ${area} (for local suggestions; never your street address)`);
  // Only advertise access to household/professional details when the privacy
  // toggle allows it — otherwise the panel would claim to "see" contacts the chat
  // never receives. Household & friends are names only (spec: no birthdays,
  // addresses, or notes); saved professionals additionally share the
  // business details they were saved for, but phone/email stay "on file".
  if (includePersonalInfo) {
    const named = contacts.filter((p) => p.type === 'family' || p.type === 'friend').length;
    const pros = contacts.filter((p) => p.type === 'service').length;
    sees.push(
      named
        ? `Your household & friends — names only (${named} ${named === 1 ? 'contact' : 'contacts'})`
        : 'Your household members & friends — names only',
    );
    sees.push(
      pros
        ? `Your saved professionals — business name, service & address (${pros} ${pros === 1 ? 'contact' : 'contacts'}); phone & email stay "on file"`
        : 'Your saved professionals — business name, service & address; phone & email stay "on file"',
    );
  }
  sees.push('The weather forecast');

  return {
    sees,
    // Acting on a specific event (edit/cancel/call) requires reading the record,
    // so those capabilities drop away when personal info is off — only creating a
    // brand-new event and planning around availability remain.
    can: includePersonalInfo
      ? [
          'Open pre-filled event forms for you to review & save',
          'Place AI phone calls to cancel or reschedule appointments',
          'Suggest activities and good-weather days',
        ]
      : [
          'Open a pre-filled form to create a new event for you to review & save',
          'Suggest activities and good-weather days around when you’re free',
        ],
    note: includePersonalInfo
      ? 'Nothing is saved or called without your confirmation.'
      : 'Personal & contact info is turned off in Privacy, so I can see when you’re free or busy but not your event titles, details, or household. Turn it on to have me read or act on specific events. Nothing is saved without your confirmation.',
  };
}

function buildSuggestedPrompts() {
  return [
    "What's on my calendar this week?",
    'When am I free this weekend?',
    'Suggest a family activity this weekend',
    'Find a good-weather day for an outdoor outing',
  ];
}

// Context + starter prompts shown when the assistant first opens. C3b: the roster
// is sealed, so the client sends its decrypted `contacts` (POST) for the "what I can
// see" panel + starter prompts; there is no server read.
async function contextHandler(req, res) {
  try {
    const src = req.method === 'GET' ? req.query : (req.body || {});
    // Privacy toggle: when off, don't surface household contacts.
    const includePersonalInfo = String(src.includePersonalInfo) !== 'false' && src.includePersonalInfo !== false;
    // `contacts` is the current field name; a pre-rename app build still sends
    // `people` (see the POST / handler) — accept either.
    const sent = src.contacts ?? src.people;
    const contacts = includePersonalInfo && Array.isArray(sent) ? sent : [];
    const homeCity = req.household?.homeCity || req.user?.homeCity || '';
    res.json({
      context: buildContextSummary(contacts, includePersonalInfo, homeCity),
      suggestedPrompts: buildSuggestedPrompts(),
    });
  } catch (err) {
    console.error('Calendar chat context error:', err);
    res.status(500).json({ error: err.message });
  }
}
router.get('/context', contextHandler);
router.post('/context', contextHandler);

router.post('/', meter('chat', 'calendar'), async (req, res) => {
  try {
    const { messages, calendarSources, weather, availability, includePersonalInfo = true } = req.body;
    // The client's decrypted roster. `contacts` is the current field name; an app
    // build from before the Person→Contact rename still sends `people`, so accept
    // either rather than silently handing the model an empty roster.
    const clientContacts = req.body.contacts ?? req.body.people;
    // "Ask Calen" opened from an event's detail screen: the client sends the
    // (decrypted) event so "cancel this appointment" needs no lookup — and works
    // on E2EE households where the server can't read the stored event. Keep only
    // the fields the prompt and call_business need. With the privacy toggle off,
    // record content stays private, so the focused event is ignored too.
    const fe = includePersonalInfo ? req.body.focusEvent : null;
    const focusEvent = fe && typeof fe === 'object' && fe._id
      ? {
          _id: String(fe._id),
          title: typeof fe.title === 'string' ? fe.title : '',
          startDate: typeof fe.startDate === 'string' ? fe.startDate : undefined,
          allDay: fe.allDay !== false,
          calendarType: typeof fe.calendarType === 'string' ? fe.calendarType : undefined,
          location: typeof fe.location === 'string' ? fe.location : undefined,
          phone: typeof fe.phone === 'string' ? fe.phone : undefined,
        }
      : null;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const userId = req.user._id;
    // Ephemeral-consent (§9.1 P4c): the client supplies decrypted contacts (system
    // prompt) and calendar sources (list_events / call_business, expanded by the
    // shared engine) so the server needn't read stored plaintext. Dual-write: with
    // neither present it reads the DB exactly as before.
    //
    // Privacy toggle ("Use personal & contact info in prompts"): when the client
    // sends includePersonalInfo:false, withhold the household contact list from the
    // prompt entirely — including the DB fallback — so no names/addresses/birthdays
    // reach the model. The assistant still works on the calendar itself.
    // Signal-parity C3b: the roster is sealed in the opaque store, so the client
    // supplies its decrypted contacts; there is no server-plaintext fallback.
    // Spec (name-only): the client sends {name, type, isSelf} projections; they
    // reach the model only when it calls get_household_members — never the
    // system prompt.
    const contacts = includePersonalInfo && Array.isArray(clientContacts) ? clientContacts : [];
    const systemPrompt = buildSystemPrompt(req, focusEvent, includePersonalInfo);
    const client = new Anthropic({ apiKey });

    // Free tier gets the fast Haiku model; paid tiers get the smarter Sonnet.
    const config = await getConfig();
    // Sonnet on all tiers: every plan uses the paid chat model.
    const model = config.models.paidChat;

    // Privacy toggle off: withdraw the record/edit/call tools entirely so the
    // model can't even attempt to read or act on a specific event — only the
    // availability lens (+ create/weather/nav/search) is offered.
    const activeTools = includePersonalInfo ? TOOLS : TOOLS.filter((t) => !RECORD_TOOL_NAMES.has(t.name));

    await streamChat(res, {
      req,
      client,
      model,
      system: systemPrompt + WEB_SEARCH_SYSTEM_NOTE,
      tools: [...activeTools, webSearchTool(model)],
      messages,
      executeTool: (name, input) => executeTool(name, input, {
        userId, scopeIds: req.scopeIds, user: req.user, household: req.household,
        contacts,
        includePersonalInfo,
        calendarSources: (calendarSources && typeof calendarSources === 'object') ? calendarSources : null,
        availability: Array.isArray(availability) ? availability : null,
        weather: (weather && typeof weather === 'object') ? weather : null,
        focusEvent,
      }),
      collectSideEffects: (block, result, acc) => {
        if (result && result.navigateTo) acc.navigateTo = result.navigateTo;
        // When the assistant drafts a new event, surface the structured fields so
        // the client can offer "Save this to my calendar" (create it directly) or
        // "Edit in form" (open the create form pre-filled). Keep the last one.
        if (block.name === 'open_create_event_form') acc.pendingEvent = block.input;
        // Edit: stage the target so the client can open the native edit form on it.
        if (block.name === 'open_edit_event_form' && result && result.staged) {
          acc.pendingEdit = { eventId: result.eventId, title: result.title, occurrenceDate: result.occurrenceDate };
        }
        // Delete: accumulate every staged event this turn under ONE confirm chip,
        // so "clear my calendar next week" (several delete_event calls) removes
        // them all in a single tap. Nothing is deleted until the user confirms.
        if (block.name === 'delete_event' && result && result.staged) {
          (acc.pendingDeletes || (acc.pendingDeletes = [])).push({
            eventId: result.eventId,
            title: result.title,
            recurring: result.recurring,
            scope: result.scope,
            occurrenceDate: result.occurrenceDate,
          });
        }
        if (block.name === 'call_business' && result && result.success) acc.callPlaced = true;
        collectNav(block, acc, 'calendar');
      },
      // After drafting an event, the only two sensible next actions are to save it
      // or tweak it in the form — pin those instead of generated free-text chips.
      // Staged deletes pin one confirm chip (+ a keep-them out); a staged edit pins
      // an open-the-form chip. After placing a call, pin a status-check chip (the
      // result takes a few minutes; free-text chips would just guess at phrasing).
      // Otherwise guarantee an actionable navigate chip is present.
      followupsOverride: (acc) => {
        const hasPending = !!(acc.pendingEvent || acc.pendingEdit || (acc.pendingDeletes && acc.pendingDeletes.length));
        ensureActionableNav(acc, 'calendar', hasPending);
        if (acc.pendingEvent) return ['Save this to my calendar', 'Edit in form'];
        if (acc.pendingDeletes && acc.pendingDeletes.length) return ['Delete from my calendar', 'Cancel, keep events'];
        if (acc.pendingEdit) return ['Open the event to edit'];
        if (acc.callPlaced) return ['Any update on the call?'];
        return null;
      },
    });
  } catch (err) {
    console.error('Calendar chat error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = router;
