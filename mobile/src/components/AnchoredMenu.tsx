import React, { useEffect, useRef } from 'react';
import { Pressable, View, StyleSheet, Animated } from 'react-native';
import { Text } from './Text';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../theme';

// One row in an AnchoredMenu. `icon` is a render node so callers can mix icon
// families (Ionicons / MaterialCommunityIcons); `active` shows a leading
// checkmark; `dividerBefore` draws a hairline separator above the row.
export interface AnchoredMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  dividerBefore?: boolean;
  onPress: () => void;
}

// An iOS-style dropdown popover anchored under a button (top-right by default).
// Rendered as an in-tree absolute overlay (not a native <Modal>, which presents a
// separate view controller and lags on open); a full-screen backdrop closes it on
// any outside tap. The card animates in with a quick scale+fade so it feels
// instant. Mirrors Apple Calendar's view-mode menu: a leading checkmark column,
// an icon, then the label.
export default function AnchoredMenu({
  visible,
  onClose,
  top,
  right = spacing.md,
  items,
}: {
  visible: boolean;
  onClose: () => void;
  top: number;
  right?: number;
  items: AnchoredMenuItem[];
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    }
  }, [visible, anim]);

  if (!visible) return null;

  return (
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View
        style={[
          styles.card,
          {
            top,
            right,
            opacity: anim,
            transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
          },
        ]}
      >
        {items.map((item) => (
          <View key={item.key}>
            {item.dividerBefore ? <View style={styles.divider} /> : null}
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => {
                item.onPress();
                onClose();
              }}
            >
              <View style={styles.checkSlot}>
                {item.active ? <Ionicons name="checkmark" size={18} color={colors.text} /> : null}
              </View>
              <View style={styles.iconSlot}>{item.icon}</View>
              <Text style={styles.label}>{item.label}</Text>
            </Pressable>
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 },
  card: {
    position: 'absolute',
    minWidth: 240,
    // iOS-menu dark grey (slightly lighter than the app surface so it reads as a
    // floating popover, not part of the screen).
    backgroundColor: '#2C2C2E',
    borderRadius: radius.lg,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: spacing.md },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  checkSlot: { width: 26, alignItems: 'flex-start' },
  iconSlot: { width: 30, alignItems: 'center' },
  label: { color: colors.text, fontSize: 17, fontWeight: '500' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.15)', marginVertical: spacing.xs },
});
