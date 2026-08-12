// Geometry and lookup for the Contacts roster's right-edge A–Z scrubber (see
// screens/profile/ContactsScreen). Kept out of the screen so it can be unit
// tested without dragging in the whole contacts stack.
import { StyleSheet } from 'react-native';
import { spacing } from '../theme';

// The scrubber's letters, iOS Contacts style: the full alphabet plus a trailing
// "#" bucket for names that don't start with a letter.
export const INDEX_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

// Fixed cell geometry, so the roster can hand `SectionList` a `getItemLayout`.
// Without one, `scrollToLocation` silently no-ops for any section that hasn't
// been rendered yet (VirtualizedList has no way to know where it is) — which is
// exactly the jump the scrubber exists to make. Keep these in step with
// ContactsScreen's `row` / `sectionHeader` / `separator` styles.
export const CONTACT_AVATAR = 40;
export const CONTACT_ROW_H = CONTACT_AVATAR + spacing.sm * 2;
export const CONTACT_HEADER_H = spacing.md + spacing.xs + 16; // paddingTop + paddingBottom + lineHeight
const SEP_H = StyleSheet.hairlineWidth;

export type IndexedSection = { letter: string; data: unknown[] };
export type CellLayout = { length: number; offset: number };

// Which letter a touch at `ratio` (0–1 down the letter column) selects.
export function letterAtRatio(ratio: number): string {
  const i = Math.floor(ratio * INDEX_LETTERS.length);
  return INDEX_LETTERS[Math.max(0, Math.min(INDEX_LETTERS.length - 1, i))];
}

// The section a scrubbed letter jumps to: its own if it has contacts, else the
// nearest *following* letter section. "#" sorts last, so it snaps backwards to
// the final section instead of wrapping around to the top. -1 when empty.
export function sectionIndexForLetter(sections: IndexedSection[], letter: string): number {
  if (!sections.length) return -1;
  const exact = sections.findIndex((s) => s.letter === letter);
  if (exact >= 0) return exact;
  if (letter === '#') return sections.length - 1;
  const next = sections.findIndex((s) => s.letter !== '#' && s.letter > letter);
  return next >= 0 ? next : sections.length - 1;
}

// Flat cell geometry for the whole list, in the order VirtualizedSectionList
// flattens sections into: section header, each item, then a zero-height section
// footer slot. The trailing separator is drawn inside the item's own cell, so
// it belongs to every item but the last in its section.
export function buildCellLayouts(sections: IndexedSection[]): CellLayout[] {
  const out: CellLayout[] = [];
  let offset = 0;
  for (const s of sections) {
    out.push({ length: CONTACT_HEADER_H, offset });
    offset += CONTACT_HEADER_H;
    s.data.forEach((_, k) => {
      const length = CONTACT_ROW_H + (k < s.data.length - 1 ? SEP_H : 0);
      out.push({ length, offset });
      offset += length;
    });
    out.push({ length: 0, offset });
  }
  return out;
}
