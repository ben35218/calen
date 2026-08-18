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

// ── Raw-primitive scan ──────────────────────────────────────────────────────
// The cap only holds if nothing renders the raw primitive. The scan covers
// every route to it, not just the plain named import:
//   • every `import … from 'react-native'` in the file (global — a second
//     import statement can't hide one), including the default+named form
//     (`import RN, { Text } from`);
//   • aliased specifiers (`Text as RNText` — flagged on the react-native-side
//     name, left of `as`);
//   • namespace/default module objects later used as `<ns>.Text` /
//     `<ns>.TextInput`;
//   • `require('react-native')` destructures, module-object requires used the
//     same way, and direct `require('react-native').Text` members — app code
//     only (see exemptions);
//   • `Animated.Text` when Animated comes from react-native — an animated Text
//     is still a raw, uncapped Text (`Animated.createAnimatedComponent` of the
//     wrapper is fine: the wrapper still applies its cap underneath).
// Type-only specifiers (`type TextProps`, `import type { … }`) can't render
// and are ignored.
//
// Exemptions, deliberate and exhaustive:
//   • components/Text.tsx — the wrapper itself imports the primitives by
//     design; exempt from the whole scan.
//   • test files (under __tests__/ or __mocks__/, or *.test.*) — exempt from
//     the require-based checks only: jest.mock factories must lazy-require
//     react-native inside the factory, and what a mock renders in a test
//     environment never meets Dynamic Type. Their ESM imports are still
//     scanned, so production-shaped code in a test file doesn't get a pass.
const TARGETS = ['Text', 'TextInput'];

function scanFile(src: string, isTestFile: boolean): string[] {
  const bad = new Set<string>();
  // Module-object names (namespace imports, default imports, module requires)
  // whose `.Text` / `.TextInput` members are the raw primitives.
  const moduleNames = new Set<string>();
  let importedAnimated = false;

  const named = (clause: string) => {
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (!braces) return;
    for (const spec of braces[1].split(',')) {
      const s = spec.trim();
      if (!s || /^type\s/.test(s)) continue; // type-only: can't render
      const left = s.split(/\s+as\s+|\s*:\s*/)[0].trim(); // RN-side name (import alias or require rename)
      if (TARGETS.includes(left)) bad.add(s.replace(/\s+/g, ' '));
      if (left === 'Animated') importedAnimated = true;
    }
  };

  // 1) Every ESM import from react-native: named, aliased, default+named,
  //    namespace. `import type …` statements are skipped wholesale.
  const importRe = /\bimport\s*(?!type\b)([^;'"]+?)\s*from\s*['"]react-native['"]/g;
  for (let m: RegExpExecArray | null; (m = importRe.exec(src)); ) {
    const clause = m[1];
    named(clause);
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) moduleNames.add(ns[1]);
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
    if (def) moduleNames.add(def[1]); // default import = the module object under interop
  }

  // 2) require('react-native') — destructures, module objects, direct members.
  //    jest.mock factories in test files are the legitimate use; skip them there.
  if (!isTestFile) {
    const destructureRe = /(?:const|let|var)\s*(\{[\s\S]*?\})\s*=\s*require\(\s*['"]react-native['"]\s*\)/g;
    for (let m: RegExpExecArray | null; (m = destructureRe.exec(src)); ) named(m[1]);
    const moduleRe = /(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]react-native['"]\s*\)/g;
    for (let m: RegExpExecArray | null; (m = moduleRe.exec(src)); ) moduleNames.add(m[1]);
    const memberRe = /require\(\s*['"]react-native['"]\s*\)\s*\.\s*(Text|TextInput)\b/g;
    for (let m: RegExpExecArray | null; (m = memberRe.exec(src)); ) bad.add(`require().${m[1]}`);
  }

  // 3) A module object is only an offense when its Text/TextInput is used.
  for (const ns of moduleNames) {
    const useRe = new RegExp(`\\b${ns}\\s*\\.\\s*(Text|TextInput)\\b`);
    const m = useRe.exec(src);
    if (m) bad.add(`${ns}.${m[1]}`);
    if (new RegExp(`\\b${ns}\\s*\\.\\s*Animated\\b`).test(src)) importedAnimated = true;
  }

  // 4) Animated.Text renders a raw Text whatever wraps it.
  if (importedAnimated && /\bAnimated\s*\.\s*Text\b/.test(src)) bad.add('Animated.Text');

  return [...bad];
}

describe('no screen reaches past the wrapper', () => {
  // A screen that renders the raw primitive scales to AX5 and bursts its layout.
  it('imports Text/TextInput from components/Text, never react-native', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === path.join(SRC, 'components', 'Text.tsx')) continue;
      // The scanner itself: its unit fixtures below are offender-shaped strings
      // by design, so the file can't be scanned as source.
      if (file === path.join(SRC, 'components', '__tests__', 'textScaling.test.tsx')) continue;
      const rel = path.relative(SRC, file);
      const isTestFile = /(?:^|\/)(?:__tests__|__mocks__)\//.test(rel) || /\.test\.[jt]sx?$/.test(rel);
      const bad = scanFile(fs.readFileSync(file, 'utf8'), isTestFile);
      if (bad.length) offenders.push(`${rel} [${bad.join(', ')}]`);
    }
    expect(offenders).toEqual([]);
  });

  // The scan itself is under test: each evasion form the old single-match regex
  // missed must now be caught, and each legitimate form must still pass.
  describe('the scan catches every route to the raw primitive', () => {
    const catches = (src: string) => scanFile(src, false);

    it('flags the plain named import (the original check)', () => {
      expect(catches(`import { View, Text } from 'react-native';`)).toEqual(['Text']);
      expect(catches(`import { TextInput } from 'react-native';`)).toEqual(['TextInput']);
    });

    it('flags an offender in a SECOND react-native import statement', () => {
      expect(catches(
        `import { View } from 'react-native';\nimport { Text } from 'react-native';`,
      )).toEqual(['Text']);
    });

    it('flags aliased specifiers by their react-native-side name', () => {
      expect(catches(`import { Text as RNText } from 'react-native';`)).toEqual(['Text as RNText']);
      expect(catches(`import {\n  TextInput as Input,\n} from 'react-native';`)).toEqual(['TextInput as Input']);
    });

    it('flags the default+named form the old regex could not parse', () => {
      expect(catches(`import ReactNative, { Text } from 'react-native';`)).toEqual(['Text']);
    });

    it('flags a namespace import whose Text is used', () => {
      expect(catches(`import * as RN from 'react-native';\nconst x = <RN.Text>hi</RN.Text>;`)).toEqual(['RN.Text']);
      expect(catches(`import * as RN from 'react-native';\nconst x = <RN.View />;`)).toEqual([]);
    });

    it('flags a default module-object import whose TextInput is used', () => {
      expect(catches(`import RN from 'react-native';\nconst F = RN.TextInput;`)).toEqual(['RN.TextInput']);
    });

    it('flags require destructures, renamed ones, module requires, and members', () => {
      expect(catches(`const { Text } = require('react-native');`)).toEqual(['Text']);
      expect(catches(`const { Text: RawText } = require('react-native');`)).toEqual(['Text: RawText']);
      expect(catches(`const RN = require('react-native');\nconst T = RN.Text;`)).toEqual(['RN.Text']);
      expect(catches(`const T = require('react-native').Text;`)).toEqual(['require().Text']);
    });

    it('flags Animated.Text (a raw Text in animated clothing)', () => {
      expect(catches(`import { Animated } from 'react-native';\nconst x = <Animated.Text>hi</Animated.Text>;`))
        .toEqual(['Animated.Text']);
      expect(catches(`import * as RN from 'react-native';\nconst x = <RN.Animated.Text>hi</RN.Animated.Text>;`))
        .toContain('Animated.Text');
    });

    it('passes the legitimate forms', () => {
      // Other components, type-only imports, wrapper-based animation.
      expect(catches(`import { View, StyleSheet } from 'react-native';`)).toEqual([]);
      expect(catches(`import { type TextProps, View } from 'react-native';`)).toEqual([]);
      expect(catches(`import type { TextInputProps } from 'react-native';`)).toEqual([]);
      expect(catches(
        `import { Animated } from 'react-native';\nimport { Text } from '../components/Text';\n` +
        `const AT = Animated.createAnimatedComponent(Text);`,
      )).toEqual([]);
    });

    it('exempts require-based jest.mock factories in test files only', () => {
      const mockSrc = `jest.mock('x', () => {\n  const { Text } = require('react-native');\n  return { X: () => <Text /> };\n});`;
      expect(scanFile(mockSrc, true)).toEqual([]);
      expect(scanFile(mockSrc, false)).toEqual(['Text']);
      // ESM imports in a test file still fail.
      expect(scanFile(`import { Text } from 'react-native';`, true)).toEqual(['Text']);
    });
  });
});
