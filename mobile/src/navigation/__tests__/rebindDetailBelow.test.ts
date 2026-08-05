// "Save for This Event Only" doesn't write the record the form was opened on —
// it creates a new one. The detail screen underneath is still bound to the
// ORIGINAL id, so a plain goBack() lands the user on the unedited event and
// they conclude the save failed (it didn't; the month grid shows it, because the
// grid reads the store rather than a route param). This is the fix for that,
// and these pin the stack rewrite it performs.
import { rebindDetailBelow, popPastDetail } from '../rebindDetailBelow';

// Capture the state-updater the helper dispatches and run it against a stack.
function dispatchAgainst(stack: { name: string; key: string; params?: object }[], detail: string, params: Record<string, unknown>) {
  let action: any;
  rebindDetailBelow({ dispatch: (a: any) => { action = a; } }, detail, params);
  expect(typeof action).toBe('function');
  const next = action({ routes: stack, index: stack.length - 1, stale: false });
  return next.payload;
}

const CALENDAR = { name: 'CalendarHome', key: 'CalendarHome-1' };
const DETAIL = { name: 'EventDetail', key: 'EventDetail-1', params: { eventId: 'series-1', date: '2026-08-20' } };
const FORM = { name: 'EventForm', key: 'EventForm-1', params: { eventId: 'series-1', date: '2026-08-20' } };

describe('rebindDetailBelow', () => {
  it('drops the form and re-points the detail below it at the new record', () => {
    const { routes, index } = dispatchAgainst([CALENDAR, DETAIL, FORM], 'EventDetail', {
      eventId: 'override-9',
      date: '2026-08-20',
    });
    expect(routes.map((r: any) => r.name)).toEqual(['CalendarHome', 'EventDetail']);
    expect(routes[1].params).toMatchObject({ eventId: 'override-9', date: '2026-08-20' });
    expect(index).toBe(1);
  });

  // Reusing the key would leave the mounted screen's queries and occurrence
  // state in place, which is the same staleness this exists to fix.
  it('gives the rebound detail a fresh key so it remounts', () => {
    const { routes } = dispatchAgainst([CALENDAR, DETAIL, FORM], 'EventDetail', { eventId: 'override-9' });
    expect(routes[1].key).not.toBe(DETAIL.key);
    expect(routes[1].key).toContain('override-9');
  });

  it('carries the new day through when the occurrence was moved', () => {
    const { routes } = dispatchAgainst([CALENDAR, DETAIL, FORM], 'EventDetail', {
      eventId: 'fork-2',
      date: '2026-08-21',
    });
    expect(routes[1].params).toMatchObject({ eventId: 'fork-2', date: '2026-08-21' });
  });

  // The form is reachable without a detail beneath it (a month-cell long-press,
  // the assistant). There is nothing to rebind there — but the form must still
  // close, so this is a plain pop, not a no-op.
  it('just pops the form when the screen below is not the detail', () => {
    const { routes, index } = dispatchAgainst([CALENDAR, FORM], 'EventDetail', { eventId: 'override-9' });
    expect(routes.map((r: any) => r.name)).toEqual(['CalendarHome']);
    expect(routes[0]).toBe(CALENDAR);
    expect(index).toBe(0);
  });

  it('serves the chore/task stacks, which key their detail on `id`', () => {
    const choreDetail = { name: 'ChoreDetail', key: 'ChoreDetail-1', params: { id: 'chore-1', date: '2026-03-01' } };
    const choreForm = { name: 'ChoreForm', key: 'ChoreForm-1' };
    const { routes } = dispatchAgainst([CALENDAR, choreDetail, choreForm], 'ChoreDetail', {
      id: 'chore-override',
      date: '2026-03-01',
    });
    expect(routes[1].params).toMatchObject({ id: 'chore-override' });
    expect(routes[1].key).toContain('chore-override');
  });

  // Params already on the detail that the caller didn't override must survive —
  // the rewrite is a merge, not a replacement.
  it('preserves untouched params on the rebound route', () => {
    const withExtra = { ...DETAIL, params: { ...DETAIL.params, focusEvent: true } };
    const { routes } = dispatchAgainst([CALENDAR, withExtra, FORM], 'EventDetail', { eventId: 'override-9' });
    expect(routes[1].params).toMatchObject({ focusEvent: true, eventId: 'override-9' });
  });
});

// Deleting from a form's bottom Delete button destroys what the detail below it
// describes, so that page has to go too — otherwise Back lands on a record (or
// an occurrence) that no longer exists.
describe('popPastDetail', () => {
  function popAgainst(stack: { name: string; key: string; params?: object }[], detail: string) {
    let action: any;
    popPastDetail({ dispatch: (a: any) => { action = a; } }, detail);
    expect(typeof action).toBe('function');
    return action({ routes: stack, index: stack.length - 1, stale: false }).payload;
  }

  const CHORE_LIST = { name: 'ChoresHome', key: 'ChoresHome-1' };
  const CHORE_DETAIL = { name: 'ChoreDetail', key: 'ChoreDetail-1', params: { id: 'chore-1' } };
  const CHORE_FORM = { name: 'ChoreForm', key: 'ChoreForm-1', params: { id: 'chore-1' } };

  it('drops the form and the detail it was opened from', () => {
    const { routes, index } = popAgainst([CHORE_LIST, CHORE_DETAIL, CHORE_FORM], 'ChoreDetail');
    expect(routes.map((r: any) => r.name)).toEqual(['ChoresHome']);
    expect(index).toBe(0);
  });

  // Reached from a calendar cell or the assistant there is no detail underneath;
  // the form must still close.
  it('pops only the form when the screen below is something else', () => {
    const { routes, index } = popAgainst([CHORE_LIST, CHORE_FORM], 'ChoreDetail');
    expect(routes.map((r: any) => r.name)).toEqual(['ChoresHome']);
    expect(routes[0]).toBe(CHORE_LIST);
    expect(index).toBe(0);
  });

  // A stack always keeps a root: popping both would leave nothing to show.
  it('keeps the detail when it is the only thing under the form', () => {
    const { routes, index } = popAgainst([CHORE_DETAIL, CHORE_FORM], 'ChoreDetail');
    expect(routes.map((r: any) => r.name)).toEqual(['ChoreDetail']);
    expect(index).toBe(0);
  });
});
