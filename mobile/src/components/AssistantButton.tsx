import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import CalenGlyph from './CalenGlyph';
import { colors } from '../theme';
import { useCalenFabIntro } from '../lib/calenFabIntro';

// The standalone Calen FAB — the calendar's one primary floating action, alone
// in the bottom-right corner. Deliberately larger (56pt vs the 44pt pills) so
// the AI entry point reads as the screen's primary action rather than one
// utility icon among peers.
// The calendar canvas is pure black, where a black drop shadow can't separate
// anything — so the disc holds its edge with the elevated fill + light rim
// (colors.surfaceElevated/outline) and keeps the shadow only for the screens
// that aren't. The mark is the shared `CalenGlyph` — the baked primary-blue
// gradient sets the AI entry point apart from the plain white utility icons,
// so it must not be tinted flat.
// Until the first-ever tap (lib/calenFabIntro) a soft primary-blue halo
// radiates from the disc a few times each app open — the feature-discovery
// pulse that says "this one is tappable" without taking any layout room (an
// extended label pill was tried and collided with the Today|Calendars pill on
// small screens). It never runs under iOS Reduce Motion.
// Phone-call outcomes are resolved on the event view (not surfaced here), so
// this stays a plain launcher with no call-status badge.

// A bounded run per mount, not an endless loop: enticement, not nagging. An
// untapped FAB pulses again on the next mount (next app open / screen visit).
const HALO_PULSES = 6;

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduce(!!v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(!!v));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

export default function AssistantButton({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
  const { intro, markSeen } = useCalenFabIntro();
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const halo = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!intro || reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(900),
        Animated.timing(halo, { toValue: 1, duration: 1500, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
      { iterations: HALO_PULSES }
    );
    loop.start();
    return () => loop.stop();
  }, [intro, reduceMotion, halo]);

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      {intro && !reduceMotion ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            {
              opacity: halo.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.4, 0] }),
              transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }],
            },
          ]}
        />
      ) : null}
      <Pressable
        style={styles.fab}
        onPressIn={() =>
          Animated.spring(scale, { toValue: 0.92, speed: 40, bounciness: 0, useNativeDriver: true }).start()
        }
        onPressOut={() =>
          Animated.spring(scale, { toValue: 1, speed: 20, bounciness: 6, useNativeDriver: true }).start()
        }
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          markSeen();
          onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel="Ask Calen"
        accessibilityHint="Opens the Calen assistant"
      >
        <CalenGlyph size={28} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fab: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surfaceElevated,
    borderWidth: 1, borderColor: colors.outline,
    alignItems: 'center', justifyContent: 'center',
    // One step above the pills' shadow so the FAB reads as the topmost layer.
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6,
  },
  // The discovery ripple: the disc's own footprint, scaled up + faded out
  // behind it. Primary blue to match the glyph — this is Calen's colour, and a
  // tint this soft (peaks at 0.4 opacity) reads as a glow, not a second button.
  halo: {
    position: 'absolute', top: 0, left: 0, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary,
  },
});
