import React from 'react';
import { Image, StyleProp, ImageStyle } from 'react-native';

// Calen's brand mark: the gradient "C" (assets/calen-ai-glyph.png). This is the
// glyph that says "this is Calen" — the assistant FAB on the calendar and the
// "Ask Calen" card at the top of a form both wear it, so the AI entry point
// looks the same wherever it appears.
//
// The blue gradient is baked into the artwork and is never tinted: reading as
// brand rather than as one more flat utility icon is the whole point. That does
// mean it needs a dark/neutral surface behind it — on an accent-FILLED disc
// (the chores / maintenance / trips assistant FABs, where the glyph must be
// white to hold contrast) use `CalenChatIcon` instead.
export default function CalenGlyph({
  size = 28,
  style,
}: {
  size?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={require('../../assets/calen-ai-glyph.png')}
      style={[{ width: size, height: size, resizeMode: 'contain' }, style]}
    />
  );
}
