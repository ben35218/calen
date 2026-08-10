import React, { useRef } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';
import { colors } from '../theme';

export const WHEEL_ITEM_H = 40;
export const WHEEL_VISIBLE = 5; // odd, so one row sits centered under the selection band

// One row of the wheel. Its own animated style is derived from the shared scroll
// offset, so the tilt/shrink/fade update on the UI thread as the wheel turns.
// (A component per row is required — useAnimatedStyle is a hook, so it can't be
// called inside the items.map.)
function WheelRow({ label, index, scrollY, onSelect }: { label: string; index: number; scrollY: SharedValue<number>; onSelect: () => void }) {
  const style = useAnimatedStyle(() => {
    // How far this row is from the center line, in item-heights either side.
    const range = [
      (index - 2) * WHEEL_ITEM_H,
      (index - 1) * WHEEL_ITEM_H,
      index * WHEEL_ITEM_H,
      (index + 1) * WHEEL_ITEM_H,
      (index + 2) * WHEEL_ITEM_H,
    ];
    const opacity = interpolate(scrollY.value, range, [0.2, 0.45, 1, 0.45, 0.2], Extrapolation.CLAMP);
    const scale = interpolate(scrollY.value, range, [0.78, 0.9, 1, 0.9, 0.78], Extrapolation.CLAMP);
    const rotateX = interpolate(scrollY.value, range, [52, 28, 0, -28, -52], Extrapolation.CLAMP);
    return { opacity, transform: [{ perspective: 600 }, { rotateX: `${rotateX}deg` }, { scale }] };
  });
  // Tapping a row snaps to it — a scroll-free way to pick (dragging still scrolls;
  // ScrollView wins the pan, so the tap doesn't block flinging).
  return (
    <Pressable onPress={onSelect}>
      <Animated.View style={[styles.item, style]}>
        <Text style={styles.itemText}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

// Pure-JS scrolling wheel that mimics the native spinner: a snap-to-row
// ScrollView whose rows tilt (rotateX), shrink, and fade as they move away from
// the center line, driven by the scroll position on the UI thread via
// Reanimated. (Reanimated's scroll handler — not the legacy Animated.event with
// useNativeDriver, which does not drive scrolling on the New Architecture.)
// The selection band is drawn by the caller (it may span several wheels).
export default function WheelPicker<T extends string | number>({
  items,
  value,
  onChange,
  width = 88,
}: {
  items: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  width?: number;
}) {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  // Position on the starting row exactly once — re-applying it on re-renders
  // (as a contentOffset prop would) kills in-flight momentum dead.
  const positioned = useRef(false);
  const pad = ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H;

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const settle = (y: number) => {
    const i = Math.min(items.length - 1, Math.max(0, Math.round(y / WHEEL_ITEM_H)));
    onChange(items[i].value);
  };

  // Tap-to-select: scroll the tapped row to center and commit it.
  const selectIndex = (i: number) => {
    ref.current?.scrollTo({ y: i * WHEEL_ITEM_H, animated: true });
    scrollY.value = i * WHEEL_ITEM_H;
    onChange(items[i].value);
  };

  return (
    <View style={{ height: WHEEL_ITEM_H * WHEEL_VISIBLE, width }}>
      <Animated.ScrollView
        ref={ref}
        // Named so a test can settle the wheel the way a real scroll does
        // (the same role `sheet-scrim` plays for the bottom sheet).
        testID="wheel"
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM_H}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={onScroll}
        onLayout={() => {
          if (positioned.current) return;
          positioned.current = true;
          const y = Math.max(0, items.findIndex((it) => it.value === value)) * WHEEL_ITEM_H;
          ref.current?.scrollTo({ y, animated: false });
          scrollY.value = y;
        }}
        contentContainerStyle={{ paddingVertical: pad }}
        // Momentum-end fires after the snap; drag-end covers releases without a fling.
        onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
        onScrollEndDrag={(e) => settle(e.nativeEvent.contentOffset.y)}
      >
        {items.map((it, i) => (
          <WheelRow key={String(it.value)} label={it.label} index={i} scrollY={scrollY} onSelect={() => selectIndex(i)} />
        ))}
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  item: { height: WHEEL_ITEM_H, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: 23, color: colors.text },
});
