import { buildPrintHtml, PrintOptions } from '../printCalendar';

const ACTIVITIES = { id: 'activities', name: 'Activities', color: '#388E3C' };
const APPOINTMENTS = { id: 'appointments', name: 'Appointments', color: '#1976D2' };
const TRIPS = { id: 'trips', name: 'Trips', color: '#5E35B1' };

// Timed events use local-time ISO strings (parsed in the device zone, like the
// app); all-day records are noon-UTC, matching EventFormScreen's storage.
const data: any = {
  events: [
    { _id: '1', calendarType: 'activities', title: 'Soccer <practice>', allDay: false, startDate: '2026-07-15T13:00:00' },
    { _id: '2', calendarType: 'activities', title: 'Morning run', allDay: false, startDate: '2026-07-15T09:00:00' },
    { _id: '3', calendarType: 'appointments', title: 'Dentist', allDay: true, startDate: '2026-07-15T12:00:00Z' },
    { _id: '4', calendarType: 'chores', title: 'Unselected calendar event', allDay: true, startDate: '2026-07-15T12:00:00Z' },
    { _id: '5', calendarType: 'activities', title: 'Camping', allDay: true, startDate: '2026-07-20T12:00:00Z', endDate: '2026-07-22T12:00:00Z' },
  ],
  trips: [{ id: 't1', name: 'Cottage', ranges: [{ start: '2026-06-28T12:00:00Z', end: '2026-07-03T12:00:00Z' }] }],
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

const agendaOpts = (over: Partial<PrintOptions> = {}): PrintOptions => ({
  layout: 'agenda',
  from: '2026-07-15',
  to: '2026-07-21',
  months: [],
  calendars: [ACTIVITIES, APPOINTMENTS],
  useColor: true,
  ...over,
});

describe('buildPrintHtml (agenda)', () => {
  const html = buildPrintHtml(agendaOpts(), data, []);

  it('escapes user titles', () => {
    expect(html).toContain('Soccer &lt;practice&gt;');
    expect(html).not.toContain('<practice>');
  });

  it('omits calendars that are not selected', () => {
    expect(html).not.toContain('Unselected calendar event');
  });

  it('orders a day all-day first, then by start instant (not label text)', () => {
    const dentist = html.indexOf('Dentist');
    const run = html.indexOf('Morning run');
    const soccer = html.indexOf('Soccer');
    expect(dentist).toBeGreaterThan(-1);
    expect(dentist).toBeLessThan(run);
    expect(run).toBeLessThan(soccer); // 9:00 AM before 1:00 PM
  });

  it('lists a multi-day event once, on its start date', () => {
    expect(count(html, 'Camping')).toBe(1);
  });

  it('surfaces an item spanning into the range on the first day', () => {
    const withTrip = buildPrintHtml(
      agendaOpts({ from: '2026-07-01', to: '2026-07-07', calendars: [ACTIVITIES, TRIPS] }),
      data,
      []
    );
    expect(count(withTrip, 'Cottage')).toBe(1);
  });

  it('renders holidays on their per-country holiday calendar', () => {
    const holidayCal = { id: 'holiday-CA', name: 'Canadian Holidays', color: '#D32F2F' };
    const withHoliday = buildPrintHtml(
      agendaOpts({ calendars: [ACTIVITIES, holidayCal] }),
      data,
      [{ calendarId: 'holiday-CA', name: 'Canada Day', date: '2026-07-15' }]
    );
    expect(withHoliday).toContain('Canada Day');
  });

  it('omits holidays whose calendar is not selected', () => {
    const html = buildPrintHtml(
      agendaOpts({ calendars: [ACTIVITIES] }),
      data,
      [{ calendarId: 'holiday-CA', name: 'Canada Day', date: '2026-07-15' }]
    );
    expect(html).not.toContain('Canada Day');
  });
});

describe('buildPrintHtml (month grid)', () => {
  // July 2026 grid: Sun Jun 28 .. Sat Aug 8.
  const monthOpts = (over: Partial<PrintOptions> = {}): PrintOptions => ({
    layout: 'month',
    from: '2026-06-28',
    to: '2026-08-08',
    months: [{ year: 2026, month: 6 }],
    calendars: [ACTIVITIES, APPOINTMENTS],
    useColor: true,
    ...over,
  });

  it('repeats a multi-day event into every cell it spans', () => {
    const html = buildPrintHtml(monthOpts(), data, []);
    expect(count(html, 'Camping')).toBe(3);
  });

  it('renders one landscape page with a legend for 2+ calendars', () => {
    const html = buildPrintHtml(monthOpts(), data, []);
    expect(html).toContain('size: landscape');
    expect(count(html, 'class="page"')).toBe(1);
    expect(html).toContain('class="legend"');
    expect(html).toContain('Activities');
    expect(html).toContain('Appointments');
  });

  it('skips the legend for a single calendar', () => {
    const html = buildPrintHtml(monthOpts({ calendars: [ACTIVITIES] }), data, []);
    expect(html).toContain('<div class="legend"></div>');
  });
});

describe('buildPrintHtml (black & white)', () => {
  it('tags items with calendar codes instead of dots when multiple calendars print', () => {
    const html = buildPrintHtml(agendaOpts({ useColor: false }), data, []);
    expect(html).toContain('class="code"');
    expect(html).not.toContain('class="dot"');
    expect(html).toContain('>AC</span>');
    expect(html).toContain('>AP</span>');
  });

  it('uses colored dots in color mode', () => {
    const html = buildPrintHtml(agendaOpts(), data, []);
    expect(html).toContain('class="dot"');
    expect(html).toContain(ACTIVITIES.color);
  });
});
