import React from 'react';
import { TouchableOpacity, Image, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { colors } from '../theme';

// The standalone Calen FAB — the calendar's one primary floating action, alone
// in the bottom-right corner. Deliberately larger (56pt vs the 44pt pills) and
// a shadow step above them so the AI entry point reads as the screen's primary
// action rather than one utility icon among peers.
// The mark is the gradient "C" glyph (assets/calen-ai-glyph.png) — the baked
// primary-blue gradient sets the AI entry point apart from the plain white
// utility icons, so it must not be tinted flat.
// Phone-call outcomes are resolved on the event view (not surfaced here), so
// this stays a plain launcher with no call-status badge.
export default function AssistantButton({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <TouchableOpacity
      style={[styles.fab, style]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityLabel="Ask Calen"
    >
      <Image source={require('../../assets/calen-ai-glyph.png')} style={styles.icon} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    // One step above the pills' shadow so the FAB reads as the topmost layer.
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6,
  },
  icon: { width: 28, height: 28, resizeMode: 'contain' },
});
