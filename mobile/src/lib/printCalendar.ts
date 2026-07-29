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
import { DOWNLOAD_QR_SVG } from './printAssets';

// "Scan to download" QR, printed in the header of every layout so a paper
// calendar can point someone back to the app. Static asset (see printAssets.ts)
// — the QR encodes a fixed URL, so it is generated once, not per print.
const BRAND_HTML =
  `<div class="brand">` +
  `<div class="brand-copy"><div class="brand-name">Calen</div><div class="brand-cta">Scan to download</div></div>` +
  `<div class="brand-qr">${DOWNLOAD_QR_SVG}</div>` +
  `</div>`;

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
  return `<div class="footer"><div class="legend">${legend}</div><div class="printed">Printed ${esc(printedOn)} · Calen</div></div>`;
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
  /* Force the print engine to honour our fills — WebKit/expo-print otherwise
     drops background colours (weekend wash, today pill, coloured dots) and the
     sheet prints washed-out. */
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', 'Segoe UI', Roboto, sans-serif;
    color: #1f2430;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'tnum' 1, 'kern' 1;
    line-height: 1.4;
  }
  .header {
    display: flex; justify-content: space-between; align-items: flex-end; gap: 16px;
    margin-bottom: 16px; padding-bottom: 10px;
    border-bottom: 2px solid #1f2430;
  }
  .head-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .header .title { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; line-height: 1.05; }
  .header .sub { font-size: 10px; font-weight: 600; color: #9aa0ac; text-transform: uppercase; letter-spacing: 1.4px; }
  /* Download QR (top-right of every layout). */
  .brand { display: flex; align-items: center; gap: 9px; flex-shrink: 0; }
  .brand-copy { text-align: right; line-height: 1.2; }
  .brand-name { font-size: 12px; font-weight: 800; letter-spacing: -0.2px; color: #1f2430; }
  .brand-cta { font-size: 7.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.7px; color: #9aa0ac; }
  .brand-qr { width: 42px; height: 42px; }
  .brand-qr svg { width: 100%; height: 100%; display: block; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .code { display: inline-block; font-size: 7px; font-weight: 700; letter-spacing: 0.3px; color: #4b5160; border: 0.75px solid #c2c7d0; border-radius: 3px; padding: 0 2px; margin-right: 4px; vertical-align: middle; line-height: 1.5; }
  .footer {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 16px; padding-top: 8px; border-top: 1px solid #e6e8ee;
    font-size: 9px; color: #6b7280;
  }
  .legend { display: flex; flex-wrap: wrap; gap: 5px 16px; align-items: center; }
  .leg { display: inline-flex; align-items: center; white-space: nowrap; font-weight: 500; color: #4b5160; }
  .printed { color: #aeb3bd; white-space: nowrap; margin-left: 16px; text-transform: uppercase; letter-spacing: 0.6px; font-size: 8px; }
`;

// ── Month grid layout ───────────────────────────────────────────────────────

const MONTH_CSS = `
  /* Margins come from .page PADDING, not @page — iOS expo-print ignores @page
     margins, so relying on them printed edge-to-edge. Padding is honoured by
     every renderer; @page margin is zeroed so nothing double-applies. */
  @page { size: landscape; margin: 0; }
  /* The whole month must fit on ONE landscape sheet — landscape Letter/A4 give
     ~182–188mm of printable height, and only weeks containing a day of the
     month are rendered (no all-next-month trailing row), so the header, weekday
     row, five–six 24mm cell rows, and footer stay well under that. Keep the
     chrome tight when editing or the footer spills to a second page. */
  .page { page-break-after: always; padding: 13mm 14mm; }
  .page:last-child { page-break-after: auto; }
  .page .header { margin-bottom: 9px; padding-bottom: 6px; }
  .page .header .title { font-size: 24px; letter-spacing: -0.6px; }
  .page .footer { margin-top: 10px; padding-top: 6px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th {
    font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1.2px;
    text-align: center; padding: 5px 0 7px; border-bottom: 1.5px solid #1f2430;
  }
  td {
    border: 0.75px solid #e6e8ee; vertical-align: top; height: 23mm; padding: 4px 6px 3px;
    overflow: hidden; background: #fff;
  }
  td.weekend { background: #fafbfc; }
  td.out { background: #f6f7f9; }
  td.out .daynum { color: #c8ccd4; }
  .daynum { font-size: 11px; font-weight: 700; color: #3a4150; line-height: 1; margin-bottom: 4px; }
  .item {
    font-size: 8px; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: #2b3140; padding: 0.5px 0;
  }
  .item .dot { width: 6px; height: 6px; margin-right: 4px; }
  .item .time { color: #7a8090; font-weight: 600; margin-right: 2px; }
  .more { font-size: 7.5px; font-weight: 600; color: #aeb3bd; margin-top: 1px; }
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
    // Only weeks that hold at least one day of this month — drops a leading or
    // trailing row that is entirely the adjacent month (e.g. the all-August row
    // under July), so the page shows the month, not a fixed 6-week block.
    .filter((week) => week.some((cell) => cell.currentMonth))
    .map((week) => {
      const cells = week
        .map((cell, idx) => {
          const items = byDate.get(cell.date) ?? [];
          const shown = items.slice(0, MAX_CELL_ITEMS);
          const lines = shown
            .map((i) => {
              const time = i.timeLabel ? `<span class="time">${esc(i.timeLabel)}</span> ` : '';
              return `<div class="item">${itemMarker(i.calendarId, o, codes)}${time}${esc(i.title)}</div>`;
            })
            .join('');
          const more = items.length > shown.length ? `<div class="more">+${items.length - shown.length} more</div>` : '';
          // Today is deliberately not marked — a printed month is a reference
          // sheet, not a live view, so "today" would be stale the next day.
          const cls = [cell.currentMonth ? '' : 'out', idx === 0 || idx === 6 ? 'weekend' : '']
            .filter(Boolean)
            .join(' ');
          return `<td class="${cls}"><div class="daynum"><span>${cell.day}</span></div>${lines}${more}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<div class="page">
    <div class="header"><div class="head-main"><span class="title">${esc(grid.label)}</span></div>${BRAND_HTML}</div>
    <table><thead><tr>${WEEKDAYS.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    ${footerHtml(o, codes)}
  </div>`;
}

// ── Agenda layout ───────────────────────────────────────────────────────────

const AGENDA_CSS = `
  /* Margins are body PADDING, not @page (iOS expo-print ignores @page margins). */
  @page { size: portrait; margin: 0; }
  body { padding: 15mm 16mm; }
  .day { margin-bottom: 16px; page-break-inside: avoid; }
  .day h2 {
    font-size: 12px; font-weight: 700; color: #1f2430; letter-spacing: -0.1px;
    padding-bottom: 5px; margin-bottom: 7px; border-bottom: 1px solid #e6e8ee;
  }
  .row { display: flex; align-items: baseline; font-size: 10.5px; line-height: 1.5; padding: 2.5px 0; }
  .row .when {
    width: 66px; flex-shrink: 0; color: #7a8090; font-size: 8.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.4px; padding-top: 1px;
  }
  .row .what { flex: 1; color: #2b3140; }
  .row .sec { color: #9aa0ac; margin-left: 8px; font-size: 9px; }
  .empty { font-size: 12px; color: #9aa0ac; margin-top: 24px; text-align: center; }
`;

function agendaHtml(byDate: Map<string, PrintItem[]>, o: PrintOptions, codes: Record<string, string>): string {
  const dates = [...byDate.keys()].sort();
  const days = dates
    .map((date) => {
      const rows = byDate
        .get(date)!
        .map((i) => {
          const when = i.timeLabel ?? 'All day';
          const sec = i.secondary ? `<span class="sec">${esc(i.secondary)}</span>` : '';
          return `<div class="row"><span class="when">${esc(when)}</span><span class="what">${itemMarker(i.calendarId, o, codes)}${esc(i.title)}${sec}</span></div>`;
        })
        .join('');
      return `<div class="day"><h2>${esc(dayHeading(date))}</h2>${rows}</div>`;
    })
    .join('');

  const range = `${dayHeading(o.from)} – ${dayHeading(o.to)}`;
  return `<div class="header"><div class="head-main"><span class="title">Agenda</span><span class="sub">${esc(range)}</span></div>${BRAND_HTML}</div>
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
