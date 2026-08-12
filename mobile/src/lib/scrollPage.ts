// Voice-scroll paging for cooking mode (specs/features/kitchen.md, "Cooking
// mode is hands-free"). "Down"/"up" move a long step by a PARTIAL page — a
// fraction of the visible height, so consecutive commands walk through the
// whole instruction with overlap for reading continuity, never a jump straight
// to the bottom — clamped to the scrollable range.

export function pagedScrollTarget(
  current: number,
  dir: 1 | -1,
  viewportH: number,
  contentH: number,
  fraction = 0.6,
): number | null {
  const page = viewportH * fraction;
  if (!page) return null; // not measured yet — nothing sane to do
  const max = Math.max(0, contentH - viewportH);
  return Math.min(max, Math.max(0, current + dir * page));
}
