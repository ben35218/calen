import React from 'react';
import { render } from '@testing-library/react-native';
import { Text, FixedText, TextInput, TEXT_MAX_SCALE, FIXED_MAX_SCALE } from '../Text';

// Node built-ins the same way the other source-scanning suites reach for them
// (no @types/node in this project).
declare const __dirname: string;
type Dirent = { name: string; isDirectory(): boolean };
const fs = require('fs') as {
  readFileSync(file: string, enc: string): string;
  readdirSync(dir: string, opts: { withFileTypes: true }): Dirent[];
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('Dynamic Type caps', () => {
  it('caps body text below iOS\' largest accessibility size', () => {
    // AX5 is ~3.1x. The cap is what makes the app survive it; if someone raises
    // these, the fixed-geometry screens are what break first.
    expect(TEXT_MAX_SCALE).toBeLessThan(2);
    expect(FIXED_MAX_SCALE).toBeLessThan(TEXT_MAX_SCALE);
  });

  it('applies the body cap to Text and TextInput', async () => {
    const text = await render(<Text>hi</Text>);
    expect(text.getByText('hi').props.maxFontSizeMultiplier).toBe(TEXT_MAX_SCALE);

    const input = await render(<TextInput testID="f" value="x" />);
    expect(input.getByTestId('f').props.maxFontSizeMultiplier).toBe(TEXT_MAX_SCALE);
  });

  it('applies the tighter cap to FixedText', async () => {
    const view = await render(<FixedText>hi</FixedText>);
    expect(view.getByText('hi').props.maxFontSizeMultiplier).toBe(FIXED_MAX_SCALE);
  });

  it('lets a caller override the cap', async () => {
    // PackStore tightens its tiles; ContactsScreen's A-Z index opts out entirely.
    const tighter = await render(<Text maxFontSizeMultiplier={1.1}>hi</Text>);
    expect(tighter.getByText('hi').props.maxFontSizeMultiplier).toBe(1.1);

    const off = await render(<Text allowFontScaling={false}>no</Text>);
    expect(off.getByText('no').props.allowFontScaling).toBe(false);
  });
});

describe('no screen reaches past the wrapper', () => {
  // The cap only holds if nothing imports the raw primitive. A new screen that
  // pulls Text straight from react-native scales to AX5 and bursts its layout.
  it('imports Text/TextInput from components/Text, never react-native', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === path.join(SRC, 'components', 'Text.tsx')) continue;
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]react-native['"]/);
      if (!m) continue;
      const bad = m[1].split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s === 'Text' || s === 'TextInput');
      if (bad.length) offenders.push(`${path.relative(SRC, file)} [${bad.join(', ')}]`);
    }
    expect(offenders).toEqual([]);
  });
});
