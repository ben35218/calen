// Cooking mode's voice-scroll paging (specs/features/kitchen.md): partial
// pages that stack, clamped to the scrollable range. Pinned as a pure function
// because driving the ScrollView's layout events in a component test corrupts
// the test renderer's later event dispatch.

import { pagedScrollTarget } from '../scrollPage';

describe('pagedScrollTarget', () => {
  // 400pt viewport, 1000pt content → 600pt of scrollable range, 240pt pages.
  const down = (current: number) => pagedScrollTarget(current, 1, 400, 1000);
  const up = (current: number) => pagedScrollTarget(current, -1, 400, 1000);

  it('moves by a partial page (60% of the viewport), not a full one', () => {
    expect(down(0)).toBe(240);
  });

  it('stacks: repeated downs walk through the content', () => {
    expect(down(240)).toBe(480);
  });

  it('clamps at the bottom instead of overshooting', () => {
    expect(down(480)).toBe(600); // 1000 - 400
    expect(down(600)).toBe(600);
  });

  it('scrolls up by the same partial page, clamped at the top', () => {
    expect(up(600)).toBe(360);
    expect(up(100)).toBe(0);
    expect(up(0)).toBe(0);
  });

  it('content shorter than the viewport never scrolls', () => {
    expect(pagedScrollTarget(0, 1, 400, 300)).toBe(0);
  });

  it('returns null before the viewport is measured', () => {
    expect(pagedScrollTarget(0, 1, 0, 1000)).toBeNull();
  });
});
