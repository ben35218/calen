// Shared calendar range-expansion engine.
//
// Pure, dependency-free (no date-fns, no DB, no network) so the SAME code runs
// on the server (CommonJS require), web (Vite), and mobile (Metro). This is the
// single source of truth for "recurrence -> occurrences in a date range" and the
// assembled CalendarData shape, so the server-expanded path (routes/calendar.js
// + the Calendar Assistant) and the client-expanded path (over the decrypted
// local replica, post-§9-drop) can never diverge.
//
// See docs/E2EE-SYNC-PLAN.md §9.1 P2.

// ── Date helpers (match date-fns semantics used by the former server engine) ──
function getDaysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addWeeks(d, n) { return addDays(d, n * 7); }
// date-fns clamps the day to the last day of the target month (Jan 31 + 1mo → Feb 28).
function addMonths(d, n) {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  r.setDate(Math.min(day, getDaysInMonth(r)));
  return r;
}
function addYears(d, n) { return addMonths(d, n * 12); }
function setMonth(d, month) {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(month);
  r.setDate(Math.min(day, getDaysInMonth(r)));
  return r;
}
function setDate(d, day) {
  const r = new Date(d);
  r.setDate(day);
  return r;
}
function getDay(d) { return d.getDay(); }
function isAfter(a, b) { return a.getTime() > b.getTime(); }
function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

// ── Next-due-date computation (task/chore recurrence) ────────────────────────
function snapToWeekday(date, targetWeekday) {
  const diff = (targetWeekday - getDay(date) + 7) % 7;
  return diff === 0 ? date : addDays(date, diff);
}
function clampDay(date, day) {
  return setDate(date, Math.min(day, getDaysInMonth(date)));
}
// nth occurrence of dayOfWeek within date's month. weekOfMonth: 1..4, -1=last.
function nthWeekdayOfMonth(date, weekOfMonth, dayOfWeek) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (weekOfMonth === -1) {
    let d = new Date(year, month + 1, 0);
    while (getDay(d) !== dayOfWeek) d = addDays(d, -1);
    return d;
  }
  let d = new Date(year, month, 1);
  while (getDay(d) !== dayOfWeek) d = addDays(d, 1);
  return addWeeks(d, weekOfMonth - 1);
}

function computeNextDueDate(task, fromDate) {
  const base = fromDate ? new Date(fromDate) : new Date();
  const r = task.recurrence;

  if (!r || r.type === 'one-time') return task.nextDueDate || null;

  if (r.type === 'interval') {
    const { intervalValue: v, intervalUnit: u, dayOfWeek, dayOfMonth, months } = r;
    if (u === 'days') return addDays(base, v);
    if (u === 'weeks') {
      const next = addWeeks(base, v);
      return dayOfWeek != null ? snapToWeekday(next, dayOfWeek) : next;
    }
    if (u === 'months') {
      const next = addMonths(base, v);
      if (r.weekOfMonth != null && dayOfWeek != null) return nthWeekdayOfMonth(next, r.weekOfMonth, dayOfWeek);
      return dayOfMonth ? clampDay(next, dayOfMonth) : next;
    }
    if (u === 'years') {
      let next = addYears(base, v);
      if (months && months.length) next = setMonth(next, months[0] - 1);
      if (dayOfMonth) next = clampDay(next, dayOfMonth);
      return next;
    }
  }

  if (r.type === 'calendar') {
    const months = r.months && r.months.length ? r.months : null;
    const day = r.dayOfMonth || 1;
    const today = startOfDay(new Date());
    if (months) {
      const candidates = months
        .map(m => {
          let d = clampDay(setMonth(new Date(today.getFullYear(), 0, 1), m - 1), day);
          if (!isAfter(d, base)) d = clampDay(setMonth(new Date(today.getFullYear() + 1, 0, 1), m - 1), day);
          return d;
        })
        .sort((a, b) => a - b);
      return candidates[0];
    }
  }

  return null;
}

// Give a generated recurrence (from a template, a manual, or Ask Calen) a clean
// anchor day so it doesn't land on an arbitrary date:
//   • monthly or longer (months/years intervals, or calendar) → the 1st of the
//     month it occurs in.
//   • weekly → the same weekday it's created on.
//   • daily → left alone (it just fires every N days).
// User-authored recurrences (the Repeat screen) are never routed through here.
function anchorRecurrence(recurrence, fromDate = new Date()) {
  if (!recurrence || !recurrence.type) return recurrence;
  const r = { ...recurrence };

  if (r.type === 'calendar') {
    r.dayOfMonth = 1;
    return r;
  }

  if (r.type === 'interval') {
    if (r.intervalUnit === 'months' || r.intervalUnit === 'years') {
      r.dayOfMonth = 1;
      // Anchor by calendar day, not an nth-weekday rule.
      delete r.weekOfMonth;
      delete r.dayOfWeek;
    } else if (r.intervalUnit === 'weeks') {
      r.dayOfWeek = new Date(fromDate).getDay();
      delete r.weekOfMonth;
      delete r.dayOfMonth;
    }
  }

  return r;
}

// Seed the FIRST due date for a task created from a template. Interval templates
// can carry an ideal `months` anchor (e.g. flush the water heater in September);
// computeNextDueDate only honors that anchor for 'years', so here we start any
// month-anchored interval on the next occurrence of that month. Cadence after
// completion is unchanged — completions run back through computeNextDueDate, so
// a "every 3 months" task still repeats quarterly from when it was last done.
function seedDueDate(recurrence, fromDate = new Date()) {
  const r = recurrence;
  if (r && r.type === 'interval' && Array.isArray(r.months) && r.months.length) {
    const today = startOfDay(new Date(fromDate));
    const day = r.dayOfMonth || 1;
    const m = r.months[0] - 1; // stored 1-based
    let d = new Date(today.getFullYear(), m, day);
    if (d.getTime() <= today.getTime()) d = new Date(today.getFullYear() + 1, m, day);
    return d;
  }
  return computeNextDueDate({ recurrence: r }, fromDate);
}

// ── Mileage-based scheduling (vehicle tasks + odometer logs) ─────────────────

// Average km/day from an array of odometer log entries ({ reading, recordedAt }).
// null when there's not enough history (fewer than 2 logs or zero elapsed days).
function avgKmPerDay(logs) {
  if (!logs || logs.length < 2) return null;
  const sorted = [...logs].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const days = Math.floor(
    (new Date(sorted[sorted.length - 1].recordedAt) - new Date(sorted[0].recordedAt)) / 86400000
  );
  if (days === 0) return null;
  return (sorted[sorted.length - 1].reading - sorted[0].reading) / days;
}

// Estimate the calendar date a task will come due based on remaining km.
function estimateDateFromKm(nextDueKm, currentKm, kmPerDay) {
  if (!kmPerDay || kmPerDay <= 0) return null;
  const remainingKm = nextDueKm - currentKm;
  if (remainingKm <= 0) return new Date();
  return addDays(new Date(), Math.ceil(remainingKm / kmPerDay));
}

// Next due km threshold after completing a mileage task at `serviceKm`.
function computeNextDueKm(task, serviceKm) {
  if (!task.intervalKm || serviceKm == null) return null;
  return serviceKm + task.intervalKm;
}

// ── Recurring-event expansion (calendar events) ──────────────────────────────

const WEEKDAY_KINDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The date matching "the <weekOfMonth> <weekdayKind>" of a month, or null when
// the month has no such day (e.g. no 5th Friday). weekOfMonth: 1..5, -1 = last,
// -2 = next to last. weekdayKind: 'sun'..'sat' | 'day' | 'weekday' | 'weekend'.
function ordinalDayOfMonth(year, month, weekOfMonth, weekdayKind) {
  const dim = getDaysInMonth(new Date(year, month, 1));
  const matches = [];
  for (let day = 1; day <= dim; day++) {
    const d = new Date(year, month, day);
    const dow = getDay(d);
    const ok =
      weekdayKind === 'day'     ? true :
      weekdayKind === 'weekday' ? dow >= 1 && dow <= 5 :
      weekdayKind === 'weekend' ? dow === 0 || dow === 6 :
      dow === WEEKDAY_KINDS.indexOf(weekdayKind);
    if (ok) matches.push(d);
  }
  const idx = weekOfMonth > 0 ? weekOfMonth - 1 : matches.length + weekOfMonth;
  return matches[idx] ?? null;
}

function expandRecurringEvent(event, fromDate, toDate) {
  const r = event.recurrence;
  const { freq, interval = 1, until } = r;

  const endBound = (until && new Date(until) < toDate) ? new Date(until) : new Date(toDate);
  const durationMs = event.endDate ? new Date(event.endDate) - new Date(event.startDate) : null;
  const start = new Date(event.startDate);
  const instances = [];

  const emit = (d) => {
    if (d < start || d < fromDate || d > endBound) return;
    instances.push({
      ...event,
      startDate: new Date(d),
      endDate: durationMs != null ? new Date(d.getTime() + durationMs) : event.endDate,
      _instanceDate: d.toISOString().slice(0, 10),
    });
  };
  // Pattern-generated days carry the original occurrence's time of day.
  const atStartTime = (d) => {
    const t = new Date(d);
    t.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
    return t;
  };

  // Weekly on chosen weekdays: step whole weeks (anchored to the start date's
  // week) by the interval, emitting each selected day within the week.
  if (freq === 'weekly' && r.daysOfWeek && r.daysOfWeek.length) {
    const days = [...r.daysOfWeek].sort((a, b) => a - b);
    let weekStart = addDays(startOfDay(start), -getDay(start));
    while (weekStart <= endBound) {
      for (const dow of days) emit(atStartTime(addDays(weekStart, dow)));
      weekStart = addWeeks(weekStart, interval);
    }
    return instances;
  }

  // Monthly on numbered dates ("each 5th and 20th") or an ordinal rule ("the
  // second Tuesday", "the last weekday"): step months by the interval.
  if (freq === 'monthly' && ((r.daysOfMonth && r.daysOfMonth.length) || r.weekOfMonth != null)) {
    const days = [...(r.daysOfMonth ?? [])].sort((a, b) => a - b);
    let year = start.getFullYear();
    let month = start.getMonth();
    while (new Date(year, month, 1) <= endBound) {
      if (days.length) {
        const dim = getDaysInMonth(new Date(year, month, 1));
        for (const day of days) {
          if (day <= dim) emit(atStartTime(new Date(year, month, day)));
        }
      } else {
        const d = ordinalDayOfMonth(year, month, r.weekOfMonth, r.weekdayKind ?? 'day');
        if (d) emit(atStartTime(d));
      }
      month += interval;
      year += Math.floor(month / 12);
      month %= 12;
    }
    return instances;
  }

  // Yearly in chosen months: step years by the interval, emitting per selected
  // month either the ordinal rule ("second Tuesday of…") or the start date's
  // day of month (skipping months too short for it).
  if (freq === 'yearly' && r.months && r.months.length) {
    const months = [...r.months].sort((a, b) => a - b);
    let year = start.getFullYear();
    while (new Date(year, 0, 1) <= endBound) {
      for (const m of months) {
        if (r.weekOfMonth != null) {
          const d = ordinalDayOfMonth(year, m - 1, r.weekOfMonth, r.weekdayKind ?? 'day');
          if (d) emit(atStartTime(d));
        } else {
          const day = start.getDate();
          if (day <= getDaysInMonth(new Date(year, m - 1, 1))) emit(atStartTime(new Date(year, m - 1, day)));
        }
      }
      year += interval;
    }
    return instances;
  }

  // Plain frequency stepping from the start date.
  const advance = {
    daily:   d => addDays(d, interval),
    weekly:  d => addWeeks(d, interval),
    monthly: d => addMonths(d, interval),
    yearly:  d => addYears(d, interval),
  }[freq];
  if (!advance) return [];

  let cursor = new Date(event.startDate);
  while (cursor < fromDate) cursor = advance(cursor);
  while (cursor <= endBound) {
    emit(new Date(cursor));
    cursor = advance(new Date(cursor));
  }
  return instances;
}

function toLocalNoon(d) {
  const s = new Date(d).toISOString().slice(0, 10);
  const [y, mo, day] = s.split('-').map(Number);
  return new Date(y, mo - 1, day, 12, 0, 0);
}

function expandRecurringTaskChore(item, fromDate, toDate) {
  const r = item.recurrence;

  if (!r || r.type === 'one-time') {
    const d = item.nextDueDate ? new Date(item.nextDueDate) : null;
    if (d && d >= fromDate && d <= toDate) {
      return [{ ...item, _instanceDate: d.toISOString().slice(0, 10) }];
    }
    return [];
  }

  if (r.type === 'calendar') {
    const months = r.months && r.months.length ? r.months : null;
    const day = r.dayOfMonth || 1;
    if (!months) return [];

    const instances = [];
    for (let year = fromDate.getFullYear(); year <= toDate.getFullYear(); year++) {
      for (const m of months) {
        const base = new Date(year, m - 1, 1);
        const d = setDate(base, Math.min(day, getDaysInMonth(base)));
        if (d >= fromDate && d <= toDate) {
          instances.push({ ...item, nextDueDate: d, _instanceDate: d.toISOString().slice(0, 10) });
        }
      }
    }
    return instances.sort((a, b) => new Date(a.nextDueDate) - new Date(b.nextDueDate));
  }

  // interval type: iterate forward from nextDueDate using computeNextDueDate.
  if (!item.nextDueDate) return [];

  const instances = [];
  let cursor = toLocalNoon(item.nextDueDate);

  let safety = 0;
  while (cursor < fromDate && safety < 1000) {
    safety++;
    const next = computeNextDueDate(item, cursor);
    if (!next) break;
    const nextNoon = toLocalNoon(next);
    if (nextNoon <= cursor) break;
    cursor = nextNoon;
  }

  safety = 0;
  while (cursor <= toDate && safety < 500) {
    safety++;
    if (cursor >= fromDate) {
      instances.push({ ...item, nextDueDate: new Date(cursor), _instanceDate: cursor.toISOString().slice(0, 10) });
    }
    const next = computeNextDueDate(item, cursor);
    if (!next) break;
    const nextNoon = toLocalNoon(next);
    if (nextNoon <= cursor) break;
    cursor = nextNoon;
  }

  return instances;
}

// ── Occasions (birthdays + labeled contact dates) ─────────────────────────────
// A contact's dedicated `birthday` field plus any `dates[]` entries surface on
// the Occasions calendar. The date label carries the kind: 'anniversary',
// 'marriage', and 'death' are recognised nouns; any other label is a 'custom'
// occasion whose display name is the raw label. Every kind recurs annually on
// its month/day, exactly like birthdays always have.
const KNOWN_OCCASION_KINDS = ['anniversary', 'marriage', 'death'];

// Map a `dates[]` label to an occasion kind. Known nouns match case-insensitively;
// anything else (including empty) is a free-form 'custom' occasion.
function occasionKindFromLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  return KNOWN_OCCASION_KINDS.includes(key) ? key : 'custom';
}

// Slug for building a stable, collision-free occurrence id from a free-form label.
function occasionSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'date';
}

// Normalise a Date or a YYYY-MM-DD string to a UTC Date (bare dates → UTC
// midnight), so a noon-UTC stored `birthday` and a plain `dates[].value` string
// both read the same month/day.
function toOccasionDate(dateValue) {
  const d = dateValue instanceof Date ? dateValue : new Date(`${String(dateValue).slice(0, 10)}T00:00:00Z`);
  return isNaN(d) ? null : d;
}

// The original year an occasion happened, when plausibly real (some dates are
// stored without a true year). Drives "turns N" / "N years" copy in the UI.
function occasionYear(dateValue) {
  const d = toOccasionDate(dateValue);
  if (!d) return null;
  const y = d.getUTCFullYear();
  return y > 1900 ? y : null;
}

// Expand one occasion date into its yearly occurrences (YYYY-MM-DD) within range.
function occasionOccurrences(dateValue, fromDate, toDate) {
  const d = toOccasionDate(dateValue);
  if (!d) return [];
  const month = d.getUTCMonth();
  const day   = d.getUTCDate();
  const results = [];
  for (let y = fromDate.getFullYear(); y <= toDate.getFullYear(); y++) {
    const occ = new Date(y, month, day);
    if (occ >= fromDate && occ <= toDate) {
      results.push(occ.toISOString().slice(0, 10));
    }
  }
  return results;
}

// ── Assemble the full CalendarData shape from raw records ─────────────────────
//
// Pure: pass already-fetched raw records (server: Mongo + populate; client:
// decrypted replica). Owns ALL date filtering in memory so no server-side index
// on the (soon-encrypted) date fields is needed. Returns the exact shape the
// clients already render: { tasks, chores, events, occasions, recipes,
// groceryShopping, trips }.
function assembleCalendarData({
  events = [], tasks = [], chores = [], people = [],
  recipeSchedules = [], trips = [],
  fromDate, toDate, selfId = null, groceryShoppingDay = null,
  // 'weekly' | 'biweekly'; groceryAnchor (YYYY-MM-DD, a known shopping day)
  // fixes which alternating week is the shopping week.
  groceryFrequency = 'weekly', groceryAnchor = null,
}) {
  const from = new Date(fromDate);
  const to   = new Date(toDate);

  // Overlap test, not a start-only test: a multi-day event that began before
  // `from` still touches the range through its endDate and must be kept (else a
  // tight window — e.g. the day view's ±7 days — drops it once "today" slides
  // past its start). Mirrors the trip `overlaps` helper below.
  const regularEvents = events
    .filter(e => !e.recurrence || !e.recurrence.freq)
    .filter(e => {
      if (!e.startDate) return false;
      const s = new Date(e.startDate);
      const end = e.endDate ? new Date(e.endDate) : s;
      return s <= to && end >= from;
    });
  const recurringEvents = events
    .filter(e => e.recurrence && e.recurrence.freq)
    .filter(e => e.startDate && new Date(e.startDate) <= to);

  const activeTasks  = tasks.filter(t => t.active !== false);
  const activeChores = chores.filter(c => c.active !== false);

  const expandedTasks  = activeTasks.flatMap(t => expandRecurringTaskChore(t, from, to));
  const expandedChores = activeChores.flatMap(c => expandRecurringTaskChore(c, from, to));
  const expandedRecurring = recurringEvents.flatMap(e => expandRecurringEvent(e, from, to));

  const evented = [...regularEvents, ...expandedRecurring]
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  // Occasions come from two per-person sources: the dedicated `birthday` field
  // (kind 'birthday') and each labeled `dates[]` entry (kind from its label).
  const occasionSources = [];
  for (const p of people) {
    // A contact excluded from the Occasions calendar contributes nothing.
    if (p.occasionsHidden) continue;
    const personId = String(p._id);
    const relationship = selfId && String(p.accountId) === selfId ? 'you' : (p.relationship || p.type);
    if (p.birthday != null) {
      occasionSources.push({ personId, name: p.name, relationship, kind: 'birthday', label: 'Birthday', value: p.birthday });
    }
    for (const entry of (p.dates || [])) {
      const value = entry && entry.value;
      if (!value) continue;
      occasionSources.push({
        personId, name: p.name, relationship,
        kind:  occasionKindFromLabel(entry.label),
        label: String(entry.label || '').trim() || 'Date',
        value,
      });
    }
  }
  const occasions = occasionSources.flatMap(src =>
    occasionOccurrences(src.value, from, to).map(date => ({
      id:           src.kind === 'birthday'
        ? `birthday-${src.personId}-${date}`
        : `occasion-${occasionSlug(src.label)}-${src.personId}-${date}`,
      kind:         src.kind,
      name:         src.name,
      relationship: src.relationship,
      label:        src.label,
      date,
      personId:     src.personId,
      year:         occasionYear(src.value),
    }))
  ).sort((a, b) => a.date.localeCompare(b.date));

  const scheduledInRange = recipeSchedules
    .filter(s => s.scheduledDate && new Date(s.scheduledDate) >= from && new Date(s.scheduledDate) <= to)
    .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

  // Grocery shopping day: a recurring marker on the configured weekday — every
  // week, or every other week anchored to `groceryAnchor` — regardless of
  // whether meals are scheduled (mirrors the planner, which always badges the
  // grocery day). Local-midnight dates match the birthday/day-cell convention.
  // Skipped entirely when no shopping day is configured (groceryShoppingDay ==
  // null): a household hasn't set up a schedule, so nothing recurs.
  const groceryShopping = [];
  if (groceryShoppingDay != null) {
    // First grocery weekday on or after `from` (UTC, matching the range bounds
    // and the toISOString date keys used throughout this engine).
    const g = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    g.setUTCDate(g.getUTCDate() + ((groceryShoppingDay - g.getUTCDay() + 7) % 7));
    const biweekly = groceryFrequency === 'biweekly';
    if (biweekly && groceryAnchor) {
      // Shift onto the anchor's parity: shopping happens on weeks an even
      // number of weeks from the anchor's shopping day.
      const a = new Date(`${groceryAnchor}T00:00:00Z`);
      a.setUTCDate(a.getUTCDate() - ((a.getUTCDay() - groceryShoppingDay + 7) % 7));
      const weeks = Math.round((g - a) / 604800000);
      if (((weeks % 2) + 2) % 2 === 1) g.setUTCDate(g.getUTCDate() + 7);
    }
    for (; g <= to; g.setUTCDate(g.getUTCDate() + (biweekly ? 14 : 7))) {
      const weekKey = g.toISOString().slice(0, 10);
      groceryShopping.push({ id: `grocery-${weekKey}`, date: weekKey, weekStart: weekKey });
    }
  }

  // Trip overlays: date ranges only (no itinerary).
  const overlaps = (s, e) => s && e && new Date(s) <= to && new Date(e) >= from;
  const tripOverlays = trips.flatMap(t => {
    let ranges = [];
    if (t.status === 'considering') {
      ranges = (t.candidateRanges ?? [])
        .filter(r => overlaps(r.start, r.end))
        .map(r => ({ start: r.start, end: r.end, label: r.label }));
    } else if (overlaps(t.startDate, t.endDate || t.startDate)) {
      ranges = [{ start: t.startDate, end: t.endDate || t.startDate }];
    }
    if (!ranges.length) return [];
    return [{ id: String(t._id), name: t.name, destination: t.destination, color: t.color, status: t.status, ranges }];
  });

  return {
    tasks: expandedTasks,
    chores: expandedChores,
    events: evented,
    occasions,
    recipes: scheduledInRange,
    groceryShopping,
    trips: tripOverlays,
  };
}

module.exports = {
  computeNextDueDate,
  anchorRecurrence,
  seedDueDate,
  avgKmPerDay,
  estimateDateFromKm,
  computeNextDueKm,
  expandRecurringEvent,
  expandRecurringTaskChore,
  occasionOccurrences,
  occasionKindFromLabel,
  KNOWN_OCCASION_KINDS,
  assembleCalendarData,
};
