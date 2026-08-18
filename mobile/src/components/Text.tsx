import React from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextProps,
  type TextInputProps,
} from 'react-native';

// ── Dynamic Type caps ─────────────────────────────────────────────────────
// iOS' largest accessibility size (AX5) scales text ~3.1x. Nothing in this app
// is laid out to survive that, so every Text goes through a capped wrapper
// instead of reading the system scale raw. See specs/platform/accessibility.md.

/** Body text: lists, forms, detail screens. Reflows, so it can afford to grow. */
export const TEXT_MAX_SCALE = 1.5;

/**
 * Text baked into fixed geometry — calendar cells, avatars, count badges, the
 * 44pt back pill. These overflow their shape rather than reflowing, so they
 * grow just enough to track the rest of the UI without bursting.
 */
export const FIXED_MAX_SCALE = 1.1;

type RNTextRef = React.ComponentRef<typeof RNText>;

/**
 * Drop-in replacement for react-native's Text, capped at TEXT_MAX_SCALE.
 * Import this everywhere instead of the RN primitive — props spread after the
 * cap, so a caller that needs a different ceiling can still pass its own
 * `maxFontSizeMultiplier` or `allowFontScaling={false}`.
 */
export const Text = React.forwardRef<RNTextRef, TextProps>((props, ref) => (
  <RNText maxFontSizeMultiplier={TEXT_MAX_SCALE} {...props} ref={ref} />
));
Text.displayName = 'Text';

/** Text for fixed-geometry chrome. Same contract, tighter ceiling. */
export const FixedText = React.forwardRef<RNTextRef, TextProps>((props, ref) => (
  <RNText maxFontSizeMultiplier={FIXED_MAX_SCALE} {...props} ref={ref} />
));
FixedText.displayName = 'FixedText';

/** Drop-in replacement for react-native's TextInput, capped to match Text. */
export const TextInput = React.forwardRef<RNTextInput, TextInputProps>((props, ref) => (
  <RNTextInput maxFontSizeMultiplier={TEXT_MAX_SCALE} {...props} ref={ref} />
));
TextInput.displayName = 'TextInput';

// Re-exported so `useRef<TextInput>(null)` keeps resolving to the native
// instance type after callers switch their import over to this module.
export type TextInput = RNTextInput;
