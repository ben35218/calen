// The day view's hold-to-edit routing (calendar.md → Day view): a long-press
// on an item answers with the month grid's gesture vocabulary — the item's
// edit form — while kinds with no edit form from this surface fall back to
// their tap action, so a hold is never a dead press.

import { editAllDayItem, openAllDayItem } from '../dayNav';
import type { AllDayItem } from '../dayViewLayout';

const nav = () => ({ navigate: jest.fn() }) as any;
const item = (over: Partial<AllDayItem>): AllDayItem => ({
  key: 'k', title: 'X', color: '#1976D2', kind: 'event', ...over,
});

describe('editAllDayItem — hold routes to the edit form', () => {
  it.each([
    ['event', { kind: 'event', id: 'e1' }, 'EventForm', { eventId: 'e1', date: '2026-08-12' }],
    ['trip', { kind: 'trip', id: 't1' }, 'TripForm', { id: 't1' }],
    // Tasks and chores carry the held day, scoping the edit to this occurrence.
    ['task', { kind: 'task', id: 'ta1' }, 'TaskForm', { id: 'ta1', date: '2026-08-12' }],
    ['chore', { kind: 'chore', id: 'c1' }, 'ChoreForm', { id: 'c1', date: '2026-08-12' }],
    ['recipe', { kind: 'recipe', id: 'r1' }, 'RecipeForm', { id: 'r1' }],
  ] as const)('%s → its form', (_kind, over, screen, params) => {
    const n = nav();
    editAllDayItem(n, item(over as Partial<AllDayItem>), '2026-08-12');
    expect(n.navigate).toHaveBeenCalledWith(screen, params);
  });

  it('falls back to the tap action for a kind with no edit form', () => {
    const n = nav();
    const holiday = item({ kind: 'holiday' });
    editAllDayItem(n, holiday, '2026-08-12');
    // A holiday has no detail target either, so nothing navigates — but the
    // routing went through the tap path, not a dead switch arm.
    const nTap = nav();
    openAllDayItem(nTap, holiday, '2026-08-12');
    expect(n.navigate.mock.calls).toEqual(nTap.navigate.mock.calls);

    const nGrocery = nav();
    editAllDayItem(nGrocery, item({ kind: 'grocery' }), '2026-08-12');
    expect(nGrocery.navigate).toHaveBeenCalledWith('KitchenHome', {
      pane: 'grocery', weekStart: '2026-08-12', scrollToDate: '2026-08-12',
    });
  });

  it('a recipe without a linked record falls back to its tap action too', () => {
    const n = nav();
    editAllDayItem(n, item({ kind: 'recipe' }), '2026-08-12');
    expect(n.navigate).toHaveBeenCalledWith('KitchenHome');
  });
});
