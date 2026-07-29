// Print/PDF rendering for the calendar (Calendars → Print). Builds a
// self-contained HTML document from already-decrypted CalendarData — rendering
// must stay client-side because synced households may be E2EE (the server
// never sees plaintext post-§9). expo-print turns the HTML into the OS print
// dialog / a shareable PDF.
//
// Two layouts:
//   month  — landscape month grid, one page per month, mirrors what the
//            CalendarHome grid shows per day (itemsForDate semantics: multi-day
//            items appear in every cell they span).
//   agenda — portrait day-grouped list, mirrors AgendaView (events appear on
//            their start date; trips/meals included so the calendar checklist
//            stays honest in both layouts).

import { CalendarData } from '../api';
import { buildMonth, colorOf, ymd } from './calendar';
import { occasionTitle } from './occasions';

export type PrintLayout = 'month' | 'agenda';

// A holiday to print, tagged with the holiday calendar it came from so the
// legend colours it like that calendar (per-country holiday calendars).
export interface PrintHoliday {
  calendarId: string;
  name: string;
  date: string;
}

// A calendar row the user could include (id + display bits for the legend).
export interface PrintCalendar {
  id: string;
  name: string;
  color: string;
}

export interface PrintOptions {
  layout: PrintLayout;
  // Inclusive yyyy-MM-dd range. For the month layout this should be the
  // grid range (Sunday on/before the 1st .. Saturday after month end).
  from: string;
  to: string;
  // Month layout: which months to render (one page each).
  months: { year: number; month: number }[];
  calendars: PrintCalendar[];
  useColor: boolean;
}

// One printable line: a calendar record normalized to a date + label.
interface PrintItem {
  calendarId: string;
  title: string;
  date: string; // yyyy-MM-dd it displays on (agenda) / first display date
  endDate?: string; // last spanned date (month layout repeats across the span)
  allDay: boolean;
  timeLabel?: string;
  // Epoch millis of the start instant for timed items — the within-day sort
  // key (timeLabel is display-only; "1:00 PM" sorts before "9:00 AM").
  startMs?: number;
  secondary?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }) as Record<string, string>)[c]);

// Date portion of a stored date-only record (noon UTC — read in UTC, matching
// lib/calendar's localDate).
const storedDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// Date an item lands on: all-day records are timezone-stable, timed events are
// real instants read in the device zone (mirrors AgendaView).
const itemDate = (iso: string, allDay: boolean) => (allDay ? storedDate(iso) : ymd(new Date(iso)));

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// "Friday, July 17" from a yyyy-MM-dd, built from parts so the date never
// shifts across the UTC boundary.
function dayHeading(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// ── Item assembly ───────────────────────────────────────────────────────────

// Flatten CalendarData + holidays into PrintItems, keeping only the selected
// calendars. Trips map to `trips`, tasks to `maintenance`, meal schedules
// to `recipes` — the same ids the Calendars checklist toggles.
export function collectPrintItems(
  data: CalendarData,
  holidays: PrintHoliday[],
  selectedIds: Set<string>
): PrintItem[] {
  const items: PrintItem[] = [];

  for (const e of data.events ?? []) {
    if (!selectedIds.has(e.calendarType)) continue;
    const allDay = !!e.allDay;
    items.push({
      calendarId: e.calendarType,
      title: e.title,
      date: itemDate(e.startDate, allDay),
      endDate: e.endDate ? itemDate(e.endDate, allDay) : undefined,
      allDay,
      timeLabel: allDay ? undefined : fmtTime(e.startDate),
      startMs: allDay ? undefined : +new Date(e.startDate),
      secondary: e.location ?? undefined,
    });
  }
  if (selectedIds.has('maintenance')) {
    for (const t of data.tasks ?? []) {
      if (!t.nextDueDate) continue;
      items.push({ calendarId: 'maintenance', title: t.title, date: storedDate(t.nextDueDate), allDay: true });
    }
  }
  if (selectedIds.has('chores')) {
    for (const c of data.chores ?? []) {
      if (!c.nextDueDate) continue;
      items.push({ calendarId: 'chores', title: c.title, date: storedDate(c.nextDueDate), allDay: true });
    }
  }
  if (selectedIds.has('recipes')) {
    for (const r of data.recipes ?? []) {
      const title = typeof r.recipeId === 'object' ? r.recipeId?.title || 'Recipe' : 'Recipe';
      items.push({ calendarId: 'recipes', title, date: storedDate(r.scheduledDate), allDay: true });
    }
  }
  if (selectedIds.has('trips')) {
    for (const t of data.trips ?? []) {
      for (const r of t.ranges ?? []) {
        items.push({
          calendarId: 'trips', title: t.name,
          date: storedDate(r.start), endDate: storedDate(r.end), allDay: true,
        });
      }
    }
  }
  if (selectedIds.has('birthdays')) {
    for (const o of data.occasions ?? []) {
      items.push({ calendarId: 'birthdays', title: occasionTitle(o), date: storedDate(o.date), allDay: true });
    }
  }
  for (const h of holidays) {
    if (!selectedIds.has(h.calendarId)) continue;
    items.push({ calendarId: h.calendarId, title: h.name, date: h.date, allDay: true });
  }

  return items;
}

// ── Shared HTML chrome ──────────────────────────────────────────────────────

// In B&W mode a colored dot is useless; with 2+ calendars each item instead
// gets a short code (AC, AP, …) resolved by the legend.
function calendarCodes(calendars: PrintCalendar[]): Record<string, string> {
  const used = new Set<string>();
  const codes: Record<string, string> = {};
  for (const c of calendars) {
    let code = c.name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '??';
    let n = 2;
    while (used.has(code)) code = `${code[0]}${n++}`;
    used.add(code);
    codes[c.id] = code;
  }
  return codes;
}

// Legend (only when 2+ calendars) + printed-on date. Paper goes stale; say when
// it was printed.
function footerHtml(o: PrintOptions, codes: Record<string, string>): string {
  const printedOn = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const legend =
    o.calendars.length < 2
      ? ''
      : o.calendars
          .map((c) =>
            o.useColor
              ? `<span class="leg"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`
              : `<span class="leg"><span class="code">${codes[c.id]}</span>${esc(c.name)}</span>`
          )
          .join('');
  return `<div class="footer"><div class="legend">${legend}</div><div class="printed">Printed ${esc(printedOn)}</div></div>`;
}

function itemMarker(calendarId: string, o: PrintOptions, codes: Record<string, string>): string {
  if (o.useColor) {
    const cal = o.calendars.find((c) => c.id === calendarId);
    return `<span class="dot" style="background:${esc(cal?.color ?? colorOf(calendarId))}"></span>`;
  }
  return o.calendars.length > 1 ? `<span class="code">${codes[calendarId] ?? '?'}</span>` : '';
}

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Helvetica Neue', Roboto, sans-serif; color: #111; }
  .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .header .title { font-size: 18px; font-weight: 700; }
  .header .sub { font-size: 11px; color: #666; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 4px; margin-right: 4px; vertical-align: middle; }
  .code { display: inline-block; font-size: 7px; font-weight: 700; border: 0.5px solid #444; border-radius: 2px; padding: 0 2px; margin-right: 3px; vertical-align: middle; }
  .footer { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 9px; color: #444; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; }
  .leg { white-space: nowrap; }
  .printed { color: #999; white-space: nowrap; margin-left: 12px; }
`;

// ── Month grid layout ───────────────────────────────────────────────────────

const MONTH_CSS = `
  @page { size: landscape; margin: 12mm; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { font-size: 9px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px; padding: 3px 0; border: 0.5px solid #bbb; }
  td { border: 0.5px solid #bbb; vertical-align: top; height: 25mm; padding: 2px 3px; overflow: hidden; }
  td.out { background: #f4f4f4; }
  td.out .daynum { color: #bbb; }
  .daynum { font-size: 10px; font-weight: 600; text-align: right; color: #333; }
  td.today .daynum { color: #fff; }
  td.today .daynum span { background: #111; border-radius: 8px; padding: 0 4px; }
  .item { font-size: 7.5px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item .time { color: #555; }
  .more { font-size: 7px; color: #888; }
`;

const MAX_CELL_ITEMS = 6;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function monthPageHtml(
  year: number,
  month: number,
  byDate: Map<string, PrintItem[]>,
  o: PrintOptions,
  codes: Record<string, string>
): string {
  const grid = buildMonth(year, month);
  const rows = grid.weeks
    .map((week) => {
      const cells = week
        .map((cell) => {
          const items = byDate.get(cell.date) ?? [];
          const shown = items.slice(0, MAX_CELL_ITEMS);
          const lines = shown
            .map((i) => {
              const time = i.timeLabel ? `<span class="time">${esc(i.timeLabel)}</span> ` : '';
              return `<div class="item">${itemMarker(i.calendarId, o, codes)}${time}${esc(i.title)}</div>`;
            })
            .join('');
          const more = items.length > shown.length ? `<div class="more">+${items.length - shown.length} more</div>` : '';
          const cls = [cell.currentMonth ? '' : 'out', cell.isToday ? 'today' : ''].filter(Boolean).join(' ');
          return `<td class="${cls}"><div class="daynum"><span>${cell.day}</span></div>${lines}${more}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<div class="page">
    <div class="header"><span class="title">${esc(grid.label)}</span></div>
    <table><thead><tr>${WEEKDAYS.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    ${footerHtml(o, codes)}
  </div>`;
}

// ── Agenda layout ───────────────────────────────────────────────────────────

const AGENDA_CSS = `
  @page { margin: 15mm; }
  .day { margin-bottom: 10px; page-break-inside: avoid; }
  .day h2 { font-size: 12px; font-weight: 700; border-bottom: 1px solid #999; padding-bottom: 2px; margin-bottom: 4px; }
  .row { display: flex; align-items: baseline; font-size: 10px; line-height: 1.6; }
  .row .when { width: 64px; flex-shrink: 0; color: #555; font-size: 9px; }
  .row .sec { color: #777; margin-left: 6px; font-size: 9px; }
  .empty { font-size: 11px; color: #777; margin-top: 12px; }
`;

function agendaHtml(byDate: Map<string, PrintItem[]>, o: PrintOptions, codes: Record<string, string>): string {
  const dates = [...byDate.keys()].sort();
  const days = dates
    .map((date) => {
      const rows = byDate
        .get(date)!
        .map((i) => {
          const when = i.timeLabel ?? 'all-day';
          const sec = i.secondary ? `<span class="sec">${esc(i.secondary)}</span>` : '';
          return `<div class="row"><span class="when">${esc(when)}</span><span>${itemMarker(i.calendarId, o, codes)}${esc(i.title)}${sec}</span></div>`;
        })
        .join('');
      return `<div class="day"><h2>${esc(dayHeading(date))}</h2>${rows}</div>`;
    })
    .join('');

  const heading = `${dayHeading(o.from)} – ${dayHeading(o.to)}`;
  return `<div class="header"><span class="title">${esc(heading)}</span></div>
    ${days || '<div class="empty">No events in this range.</div>'}
    ${footerHtml(o, codes)}`;
}

// ── Entry point ─────────────────────────────────────────────────────────────

// Group items by display date. The month grid repeats a spanning item into
// every cell it covers (itemsForDate semantics); the agenda lists it once on
// its start date (AgendaView semantics).
function groupByDate(items: PrintItem[], o: PrintOptions): Map<string, PrintItem[]> {
  const byDate = new Map<string, PrintItem[]>();
  const push = (date: string, item: PrintItem) => {
    if (date < o.from || date > o.to) return;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(item);
  };

  for (const item of items) {
    if (o.layout === 'month' && item.endDate && item.endDate > item.date) {
      const [y, m, d] = item.date.split('-').map(Number);
      const cursor = new Date(y, m - 1, d);
      for (let ds = item.date; ds <= item.endDate; ) {
        push(ds, item);
        cursor.setDate(cursor.getDate() + 1);
        ds = ymd(cursor);
      }
    } else {
      // Agenda lists once — but an item spanning into the range from before it
      // (a trip mid-flight) surfaces on the range's first day, not never.
      let date = item.date;
      if (item.endDate && date < o.from && item.endDate >= o.from) date = o.from;
      push(date, item);
    }
  }

  // All-day items first, then by start time — the order a paper day reads in.
  for (const list of byDate.values()) {
    list.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (a.startMs ?? 0) - (b.startMs ?? 0);
    });
  }
  return byDate;
}

export function buildPrintHtml(o: PrintOptions, data: CalendarData, holidays: PrintHoliday[]): string {
  const selectedIds = new Set(o.calendars.map((c) => c.id));
  const byDate = groupByDate(collectPrintItems(data, holidays, selectedIds), o);
  const codes = calendarCodes(o.calendars);

  const body =
    o.layout === 'month'
      ? o.months.map((m) => monthPageHtml(m.year, m.month, byDate, o, codes)).join('')
      : agendaHtml(byDate, o, codes);

  const css = BASE_CSS + (o.layout === 'month' ? MONTH_CSS : AGENDA_CSS);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
