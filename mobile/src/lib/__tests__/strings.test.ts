// The recipe title's enforced first capital (specs/features/kitchen.md,
// "Recipes"): the keyboard's `sentences` hint is only a suggestion, so the
// field uppercases the first character of the value itself.

import { capFirst } from '../strings';

describe('capFirst', () => {
  it('uppercases a lowercase first letter', () => {
    expect(capFirst('chicken parm')).toBe('Chicken parm');
  });

  it('leaves an already-capitalized title alone', () => {
    expect(capFirst('Chicken Parm')).toBe('Chicken Parm');
  });

  it('leaves the rest of the string untouched', () => {
    expect(capFirst('pasta alla Norma')).toBe('Pasta alla Norma');
  });

  it('passes through the empty string', () => {
    expect(capFirst('')).toBe('');
  });

  it('leaves a non-letter first character unchanged', () => {
    expect(capFirst('3-bean chili')).toBe('3-bean chili');
  });
});
