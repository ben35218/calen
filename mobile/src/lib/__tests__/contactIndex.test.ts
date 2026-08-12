import {
  letterAtRatio,
  sectionIndexForLetter,
  buildCellLayouts,
  CONTACT_ROW_H as ROW_H,
  CONTACT_HEADER_H as HEADER_H,
  type IndexedSection,
} from '../contactIndex';

const sec = (letter: string, n: number): IndexedSection => ({
  letter,
  data: Array.from({ length: n }, (_, i) => ({ _id: `${letter}${i}` })),
});

describe('letterAtRatio', () => {
  it('maps the column top to A and the bottom to #', () => {
    expect(letterAtRatio(0)).toBe('A');
    expect(letterAtRatio(0.999)).toBe('#');
  });

  it('clamps out-of-range touches instead of returning undefined', () => {
    expect(letterAtRatio(-0.4)).toBe('A');
    expect(letterAtRatio(1.4)).toBe('#');
  });

  it('splits the column evenly across all 27 letters', () => {
    // 27 letters: the Nth band starts at N/27.
    expect(letterAtRatio(13 / 27 + 0.001)).toBe('N');
    expect(letterAtRatio(25 / 27 + 0.001)).toBe('Z');
  });
});

describe('sectionIndexForLetter', () => {
  const sections = [sec('A', 2), sec('D', 1), sec('M', 3), sec('#', 1)];

  it('finds an exact letter section', () => {
    expect(sectionIndexForLetter(sections, 'D')).toBe(1);
    expect(sectionIndexForLetter(sections, '#')).toBe(3);
  });

  it('snaps an empty letter forward to the next populated section', () => {
    expect(sectionIndexForLetter(sections, 'B')).toBe(1); // B → D
    expect(sectionIndexForLetter(sections, 'E')).toBe(2); // E → M
  });

  it('snaps past the last letter section to the end of the list', () => {
    expect(sectionIndexForLetter(sections, 'Z')).toBe(3);
  });

  it('snaps # backwards to the final section rather than wrapping to the top', () => {
    // '#' sorts below 'A' in code-point order, so a naive "next section" search
    // returns index 0 and the scrubber jumps to the top of the list.
    const noHash = [sec('A', 1), sec('S', 1)];
    expect(sectionIndexForLetter(noHash, '#')).toBe(1);
  });

  it('reports -1 for an empty roster', () => {
    expect(sectionIndexForLetter([], 'A')).toBe(-1);
  });
});

describe('buildCellLayouts', () => {
  it('emits header + items + a footer slot per section, in flat order', () => {
    const layouts = buildCellLayouts([sec('A', 2), sec('B', 1)]);
    // 2 sections: (header + 2 items + footer) + (header + 1 item + footer)
    expect(layouts).toHaveLength(4 + 3);
    expect(layouts[0].length).toBe(HEADER_H);
    expect(layouts[3].length).toBe(0); // section A's footer slot
    expect(layouts[4].length).toBe(HEADER_H); // section B's header
  });

  it('includes the trailing separator on every item but the last in a section', () => {
    const layouts = buildCellLayouts([sec('A', 2)]);
    expect(layouts[1].length).toBeGreaterThan(ROW_H); // first item carries a separator
    expect(layouts[2].length).toBe(ROW_H); // last in section does not
  });

  it('accumulates offsets so a later section is reachable without measurement', () => {
    const layouts = buildCellLayouts([sec('A', 3), sec('B', 1)]);
    const sectionBHeader = layouts[5];
    expect(sectionBHeader.offset).toBeCloseTo(layouts[4].offset, 5);
    expect(sectionBHeader.offset).toBeGreaterThan(HEADER_H + ROW_H * 3);
    // Offsets are monotonically non-decreasing.
    for (let i = 1; i < layouts.length; i++) {
      expect(layouts[i].offset).toBeGreaterThanOrEqual(layouts[i - 1].offset);
    }
  });
});
