import { form } from '../formStyles';

// The dtRow label/value contract: the LABEL keeps its natural width and the
// value is the side that yields. `flex: 1` on the label (basis 0) meant it only
// got leftover width — a long value ("6 hr 16 min · Leave by 6:44 AM" after an
// Ask Calen fill enabled travel) crushed it to zero and "Travel Time" wrapped
// one letter per line down a ~250pt-tall row.
describe('dtRow label sizing', () => {
  it('the label grows but never shrinks below its own text', () => {
    expect(form.dtLabel.flexGrow).toBe(1);
    expect(form.dtLabel.flexShrink).toBe(0);
    // flex would reintroduce the basis-0 collapse.
    expect((form.dtLabel as { flex?: number }).flex).toBeUndefined();
  });

  it('the value side yields instead', () => {
    expect(form.groupValue.flexShrink).toBe(1);
  });
});
