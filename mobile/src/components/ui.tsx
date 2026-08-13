import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import {
  TextInputProps,
  TouchableOpacity,
  ActivityIndicator,
  View,
  StyleSheet,
  ViewStyle,
  TextStyle,
  StyleProp,
  Modal,
  ScrollView,
  Pressable,
  Switch as RNSwitch,
  Platform,
  KeyboardAvoidingView,
  Keyboard,
  Dimensions,
  useWindowDimensions,
  LayoutChangeEvent,
  // RN's own Animated (aliased so it doesn't collide with Reanimated's default
  // export below). BottomSheet's slide + drag runs on it because pan-to-dismiss
  // needs PanResponder, and gesture-handler isn't a dependency of this app.
  Animated as RNAnimated,
  PanResponder,
  PanResponderGestureState,
} from 'react-native';
import { Text, TextInput } from './Text';
import { KeyboardAwareScrollView, KeyboardController } from 'react-native-keyboard-controller';
import type { KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence } from 'react-native-reanimated';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Read through the *context* rather than `useNavigation()`: SwipeableRow has to
// work when it's rendered outside a navigator (tests, previews), and the hook
// throws there while the context just reads back undefined.
import { NavigationContext } from '@react-navigation/native';
import { colors, radius, spacing } from '../theme';
import {
  COUNTRIES,
  deviceCountry,
  flagEmoji,
  formatAsYouType,
  formatAsTyped,
  parseStored,
  seedTyped,
  toE164,
  toE164FromTyped,
  type CountryCode,
} from '../lib/phone';

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
  color,
  compact,
  style,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  color?: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isGhost = variant === 'ghost';
  const isDanger = variant === 'danger';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      style={[
        styles.btn,
        compact && styles.btnCompact,
        isGhost && styles.btnGhost,
        isDanger && styles.btnDanger,
        // Solid-variant colour override (e.g. section/calendar accent).
        color && !isGhost && !isDanger ? { backgroundColor: color } : null,
        // Ghost-variant colour override tints the outline instead of the fill.
        color && isGhost ? { borderColor: color } : null,
        (disabled || loading) && styles.btnDisabled,
        // Caller layout override (e.g. margin to space it from card copy).
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isGhost ? color || colors.primary : '#fff'} />
      ) : (
        <Text style={[styles.btnText, compact && styles.btnTextCompact, isGhost && styles.btnTextGhost, isGhost && color ? { color } : null]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

// A uniform solid-fill circular icon button. The circle is derived entirely
// from `size` (borderRadius = size/2 guarantees a true circle) and the icon is
// sized proportionally (~55%) so the fill always reads as a filled disc rather
// than a thin ring. Use size 36 for header buttons, 56 for FABs.
export function RoundIconButton({
  icon,
  onPress,
  size = 36,
  bg = colors.primary,
  color = '#fff',
  disabled,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  size?: number;
  bg?: string;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.55)} color={color} />
    </TouchableOpacity>
  );
}

// The checkmark that replaces a form's Save/Create button, living in the
// header's top-right (`headerRight`). While the save mutation runs it shows a
// spinner; `disabled` dims it. Two looks, driven by `color`: pass the view's
// feature accent to get a solid-fill accent disc (accented feature areas); omit
// it and the check is a plain transparent white glyph — matching the header
// close X and the app's other non-accented header actions.
export function HeaderCheckButton({
  onPress,
  loading,
  color,
  disabled,
}: {
  onPress: () => void;
  loading?: boolean;
  color?: string;
  disabled?: boolean;
}) {
  const tinted = !!color;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel="Save"
      style={[
        tinted ? [styles.headerCheck, { backgroundColor: color }] : styles.headerClose,
        (disabled || loading) && styles.btnDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <Ionicons name="checkmark-sharp" size={tinted ? 22 : 28} color="#fff" />
      )}
    </TouchableOpacity>
  );
}

// A header-bar icon action (edit pencil, share, print…). Lives in `headerRight`
// on detail screens — the general-purpose counterpart to the form-only
// HeaderCheckButton/HeaderCloseButton. White by default to sit on the tinted
// nav bar. Takes an Ionicons `icon` or a MaterialCommunity `mdiIcon`.
export function HeaderIconButton({
  icon,
  mdiIcon,
  onPress,
  color = '#fff',
  size = 22,
  accessibilityLabel,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  mdiIcon?: string;
  onPress: () => void;
  color?: string;
  size?: number;
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.headerIconBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      {mdiIcon ? (
        <MaterialCommunityIcons name={mdiIcon.replace(/^mdi-/, '') as any} size={size} color={color} />
      ) : icon ? (
        <Ionicons name={icon} size={size} color={color} />
      ) : null}
    </TouchableOpacity>
  );
}

// The floating action button: a 56px accent disc pinned to the bottom-right with
// a shadow. Use on detail screens to add a sub-item (a list screen's add lives in
// the header via RoundIconButton instead).
export function Fab({
  icon,
  onPress,
  bg = colors.primary,
  color = '#fff',
  style,
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  bg?: string;
  color?: string;
  style?: StyleProp<ViewStyle>;
  // Custom glyph in place of `icon` (e.g. the AI assistant icon).
  children?: React.ReactNode;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.fab, { backgroundColor: bg }, style]}>
      {children ?? (icon ? <Ionicons name={icon} size={28} color={color} /> : null)}
    </TouchableOpacity>
  );
}

// The plain white X that dismisses a form. Replaces the native back chevron in
// the header's top-left (`headerLeft`); tapping it goes back like the chevron.
export function HeaderCloseButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel="Close"
      style={styles.headerClose}
    >
      <Ionicons name="close" size={28} color="#fff" />
    </TouchableOpacity>
  );
}

// Installs a form's header chrome: a white X close button on the left (in place
// of the native back chevron) and the tinted checkmark save button on the right.
// `onPress` is called via a ref so the check always sees the latest form state
// (no stale closure), while the header only re-renders when its visuals change.
export function useHeaderCheckButton(
  navigation: {
    setOptions: (o: { headerLeft: () => React.ReactNode; headerRight: () => React.ReactNode }) => void;
    goBack: () => void;
  },
  {
    onPress,
    loading,
    color,
    disabled,
    // Set false to hide the checkmark entirely (e.g. a multi-step form's first
    // step where there is nothing to save yet). The X close button always shows.
    enabled = true,
  }: { onPress: () => void; loading?: boolean; color?: string; disabled?: boolean; enabled?: boolean }
) {
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  useEffect(() => {
    navigation.setOptions({
      headerLeft: () => <HeaderCloseButton onPress={() => navigation.goBack()} />,
      headerRight: enabled
        ? () => <HeaderCheckButton onPress={() => onPressRef.current()} loading={loading} color={color} disabled={disabled} />
        : () => null,
    });
  }, [navigation, loading, color, disabled, enabled]);
}

export function Input(
  props: TextInputProps & {
    label?: string;
    highlight?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
    labelStyle?: StyleProp<TextStyle>;
    clearable?: boolean;
    clearColor?: string;
  },
) {
  const { label, style, highlight, containerStyle, labelStyle, clearable = true, clearColor, ...rest } = props;
  const [focused, setFocused] = useState(false);
  // Apple-style clear affordance: while the field is being edited and holds
  // text, an ✕ at its right end clears it (cross-platform stand-in for iOS's
  // clearButtonMode="while-editing"). Only for single-line, editable,
  // non-secure controlled fields; `clearable={false}` opts a field out (e.g.
  // when something else already occupies the field's right edge).
  const showClear =
    clearable &&
    focused &&
    !!rest.value &&
    !rest.multiline &&
    !rest.secureTextEntry &&
    rest.editable !== false &&
    !!rest.onChangeText;
  return (
    <View style={[styles.inputWrap, containerStyle]}>
      {label ? <Text style={[styles.label, labelStyle]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={[styles.input, highlight && styles.inputHighlight, style, showClear && styles.inputClearPad]}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
      />
      {showClear ? <ClearButton onPress={() => rest.onChangeText!('')} color={clearColor} /> : null}
    </View>
  );
}

// The ✕-in-a-disc that clears a text field, bottom-anchored over the standard
// 46px input row (so the label above doesn't offset it). Kept as its own
// component so PhoneField's row layout can reuse the glyph inline. `color`
// overrides the muted grey for fields on a non-surface background (the blue
// pre-auth screens tint it translucent white to match their placeholders).
function ClearButton({ onPress, inline, color }: { onPress: () => void; inline?: boolean; color?: string }) {
  return (
    <Pressable
      style={inline ? styles.clearBtnInline : styles.clearBtn}
      hitSlop={8}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Clear text"
    >
      <Ionicons name="close-circle" size={18} color={color ?? colors.textMuted} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// A Card whose padding is handed to its rows — the detail-screen info block that
// wraps a group of ListRows (hairline-divided settings-style rows). Pass margin
// via `style`.
export function InfoCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, styles.infoCard, style]}>{children}</View>;
}

// The keyboard-aware scroll only keeps the focused *input* above the keyboard,
// so anything rendered below it (an autocomplete dropdown) opens exactly behind
// the keyboard. Screen exposes `reveal`: scroll a view (input + its dropdown)
// fully into the visible area above the keyboard, capped so the input's top
// never leaves the viewport.
const ScreenScrollContext = React.createContext<{ reveal: (view: View) => void; scrollToY: (y: number, animated?: boolean) => void } | null>(null);

// Access the enclosing <Screen>'s scroll helpers (null outside a scrolling
// Screen). `scrollToY(layoutY)` jumps a section to the top — e.g. opening a form
// focused on one section (pass the section's onLayout layout.y).
export function useScreenScroll() {
  return React.useContext(ScreenScrollContext);
}

// The imperative half of the reveal: a ref for the wrapping view plus a
// `reveal()` to call at any moment worth re-checking — the dropdown opened, the
// field took focus, the keyboard finished coming up. No-op outside a scrolling
// <Screen>.
export function useReveal() {
  const screenScroll = React.useContext(ScreenScrollContext);
  const ref = useRef<View>(null);
  const frame = useRef<number | null>(null);
  const reveal = useCallback(() => {
    if (!screenScroll) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    // Wait a frame so the just-rendered dropdown — or the viewport the keyboard
    // just shrank — is in the measured layout.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (ref.current) screenScroll.reveal(ref.current);
    });
  }, [screenScroll]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return { ref, reveal };
}

// Attach the returned ref to the view wrapping an input and its inline
// dropdown; whenever the dropdown opens or grows, the wrap is scrolled clear
// of the keyboard. No-op outside a scrolling <Screen>.
export function useRevealOnOpen(open: boolean, itemCount: number) {
  const { ref, reveal } = useReveal();
  useEffect(() => {
    if (!open || itemCount === 0) return;
    reveal();
    // A keyboard that comes up *after* the dropdown is already open shrinks the
    // viewport out from under it, so re-reveal once it has settled.
    const sub = Keyboard.addListener('keyboardDidShow', reveal);
    return () => sub.remove();
  }, [open, itemCount, reveal]);
  return ref;
}

// Wraps an input + its inline dropdown so the pair is scrolled clear of the
// keyboard when the dropdown opens. The scroll context only exists for
// components rendered INSIDE <Screen> — a screen component that itself renders
// Screen reads a null context, making useRevealOnOpen a silent no-op there.
// Screens therefore use this child component around the input/dropdown pair;
// calling useRevealOnOpen directly is only correct in a component that is
// already rendered inside a Screen (e.g. PlacesAutocomplete).
export function RevealWrap({
  open,
  count,
  style,
  children,
}: {
  open: boolean;
  count: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const ref = useRevealOnOpen(open, count);
  return (
    <View ref={ref} collapsable={false} style={style}>
      {children}
    </View>
  );
}

// Wraps a form section that should sit at the top of the viewport when the
// screen opens focused on it (a `focus` deep-link, e.g. ContactForm's
// `focus: 'dates'` from the Occasions list). Must be a DIRECT child of a
// scrolling <Screen> — the scroll-context provider lives inside Screen, so
// calling useScreenScroll from the screen component itself (which *renders*
// Screen) reads null; this child component is the correct consumer. Direct
// child also makes `layout.y` the section's offset within the scroll content.
// Jumps without animation: the scroll lands during the push transition, so the
// screen simply opens at the section.
export function ScrollToSection({ active, children }: { active: boolean; children: React.ReactNode }) {
  const screenScroll = React.useContext(ScreenScrollContext);
  const done = useRef(false);
  const onLayout = (e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    if (!active || done.current || !screenScroll || !y) return;
    done.current = true;
    // Wait a frame so the scroll view's content size (measured in the same
    // layout pass) is committed before jumping — an early scrollTo gets
    // clamped to the stale, shorter content.
    requestAnimationFrame(() => screenScroll.scrollToY(y, false));
  };
  return (
    <View collapsable={false} onLayout={onLayout}>
      {children}
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const scrollRef = useRef<KeyboardAwareScrollViewRef>(null);
  const offsetY = useRef(0);
  const revealApi = React.useMemo(() => ({
    reveal: (view: View) => {
      const scrollView = scrollRef.current;
      const native: any = scrollView?.getNativeScrollRef?.() ?? scrollView;
      if (!scrollView || typeof native?.measureInWindow !== 'function') return;
      view.measureInWindow((vx, vy, vw, vh) => {
        native.measureInWindow((sx: number, sy: number, sw: number, sh: number) => {
          const kb = KeyboardController.isVisible() ? KeyboardController.state()?.height ?? 0 : 0;
          const visibleBottom = Math.min(sy + sh, Dimensions.get('window').height - kb) - spacing.sm;
          const overflow = vy + vh - visibleBottom;
          // Cap the scroll so the input's top stays inside the viewport even
          // when the dropdown is taller than the space above the keyboard.
          const delta = Math.min(overflow, Math.max(0, vy - sy - spacing.sm));
          if (delta > 0) scrollView.scrollTo({ y: offsetY.current + delta, animated: true });
        });
      });
    },
    // Scroll to a content offset so a section's top sits near the viewport top
    // (used to jump a form to a section on open). `y` is the section's
    // `onLayout` layout.y — reliable because Screen's children render directly
    // into the scroll content container.
    scrollToY: (y: number, animated = true) => {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated });
    },
  }), []);
  if (!scroll) return <View style={[styles.screen, style]}>{children}</View>;
  return (
    <ScreenScrollContext.Provider value={revealApi}>
      <KeyboardAwareScrollView
        ref={scrollRef}
        style={styles.screen}
        contentContainerStyle={[styles.screenContent, style]}
        bottomOffset={spacing.lg}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => { offsetY.current = e.nativeEvent.contentOffset.y; }}
      >
        {children}
      </KeyboardAwareScrollView>
    </ScreenScrollContext.Provider>
  );
}

// The bold in-form heading (add/edit forms). Carries a top margin so it
// separates from the field above it; pass `style` (e.g. `{ marginTop: 0 }`) when
// it's the FIRST child of a Card, where the card's own padding already spaces it.
export function SectionTitle({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.sectionTitle, style]}>{children}</Text>;
}

// The quiet uppercase "eyebrow" that labels a group of rows/cards in a list or
// detail screen — the iOS grouped-list convention (Settings/Reminders). Sits
// ABOVE a card and deliberately recedes so the row content is the hierarchy.
// Distinct from SectionTitle, which is the bold in-form heading used by the
// add/edit forms; keep the two roles separate rather than merging them.
export function SectionHeader({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.sectionHeader, style]}>{children}</Text>;
}

// The bold in-body header title for a detail screen (the item/chore/recipe name
// shown at the top of its page). 24/700. Distinct from SectionTitle (in-form
// heading) and SectionHeader (list eyebrow). Pass `style` for layout tweaks
// (e.g. `flex: 1` beside an avatar, or a bottom margin).
export function ScreenTitle({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.screenTitle, style]}>{children}</Text>;
}

// Slide + scrim-fade timings. Short enough that the sheet feels instant; the
// same curve plays in reverse on dismiss.
const SHEET_IN_MS = 260;
const SHEET_OUT_MS = 200;
// A release dismisses (rather than springing back) once the drag has covered
// this fraction of the sheet's own height, or was flicked at least this fast.
const SHEET_DISMISS_RATIO = 0.3;
const SHEET_DISMISS_VELOCITY = 0.6;

// Who asked for the sheet to go away decides whether it slides out:
//
//   - The USER dismissed it (scrim tap, grabber drag, Android back) → animate
//     the slide-down, then report `onClose` to the caller. Nothing else is
//     competing for the screen, and watching it leave is the point.
//   - The CALLER dropped `visible` → tear down THIS COMMIT, no animation. A
//     caller closes a sheet because it is doing something else — the alert
//     picker's "Custom…" row closes the option list and opens the dual-wheel
//     sheet from one `onChange`; the Repeat picker's closes it and pushes a
//     screen. A lingering exit animation is fatal there: iOS presents a Modal
//     as its own view controller, so a second Modal mounted while the first is
//     still dismissing never appears, and the first's window stays up
//     swallowing every touch — the sheet "does nothing" and the form behind it
//     freezes. Even against a navigation push, the dying Modal would eat the
//     first 200ms of taps on the new screen.
//
// Which is also how the sheet behaved before it animated at all: a commit-time
// swap. Committing a value should feel instant; only leaving should glide.

// A slide-up modal sheet anchored to the bottom of the screen, dimming the
// backdrop behind it. The canonical chrome for custom pickers/actions (option
// lists, wheel pickers, confirm sheets). `style` merges into the sheet (e.g. a
// `gap` between stacked children).
//
// Three ways out, matching a native iOS sheet: tap the scrim, drag the grabber
// down, or Android back. The drag lives on the grabber/title strip only — a
// pan responder over the whole sheet would swallow the scroll gesture of the
// lists these sheets usually hold (options, countries).
export function BottomSheet({
  visible,
  onClose,
  title,
  children,
  style,
  // Wrap the sheet so the keyboard pushes it up instead of covering its inputs.
  // Use for sheets containing text fields.
  avoidKeyboard,
  // Fired once the sheet has mounted and begun its entrance — the hook for
  // content that must position itself on open (Select's initial scroll).
  onShow,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  avoidKeyboard?: boolean;
  onShow?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  // The home-indicator inset is dead space once the keyboard covers it — on a
  // keyboard-adjacent sheet it reads as a gap between the content and the
  // keys, which is exactly the room a search sheet needs for one more result.
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    if (!avoidKeyboard) return;
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardUp(false));
    return () => { show.remove(); hide.remove(); };
  }, [avoidKeyboard]);
  // Stay mounted through the exit animation: `visible` flips false the instant
  // the caller closes, but the slide-down still needs its frames.
  const [mounted, setMounted] = useState(visible);
  const translateY = useRef(new RNAnimated.Value(winH)).current;
  const scrim = useRef(new RNAnimated.Value(0)).current;
  // The sheet's measured height — scores a drag against the sheet's own size
  // and gives the exit an exact distance to travel. Seeded with the window
  // height so a pre-layout dismiss still ends up off-screen.
  const sheetH = useRef(winH);
  const closing = useRef(false);

  // Mount on open. On a CALLER-driven close, unmount immediately (see the note
  // above the component) — `mounted` is a dependency so a caller that leaves
  // `visible` true after onClose (i.e. never took the hint) gets the sheet back
  // rather than an empty screen.
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    closing.current = false;
    setMounted(false);
  }, [visible, mounted]);

  // The entrance, once the sheet is actually in the tree.
  useEffect(() => {
    if (!mounted || !visible) return;
    closing.current = false;
    translateY.setValue(winH);
    RNAnimated.parallel([
      RNAnimated.timing(translateY, { toValue: 0, duration: SHEET_IN_MS, useNativeDriver: true }),
      RNAnimated.timing(scrim, { toValue: 1, duration: SHEET_IN_MS, useNativeDriver: true }),
    ]).start();
    onShow?.();
    // Re-running on `winH` alone would replay the entrance on rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, visible]);

  // Dismissal that starts inside the sheet: slide it out, then hand control back
  // to the caller so its `visible` state catches up. The unmount happens here
  // rather than waiting for that round-trip, so the Modal is released the frame
  // the animation ends.
  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    RNAnimated.parallel([
      RNAnimated.timing(translateY, { toValue: sheetH.current, duration: SHEET_OUT_MS, useNativeDriver: true }),
      RNAnimated.timing(scrim, { toValue: 0, duration: SHEET_OUT_MS, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (!finished) return;
      closing.current = false;
      setMounted(false);
      onClose();
    });
  }, [onClose, scrim, translateY]);

  // The pan responder is built once, so it reads the live close handler through
  // a ref rather than capturing the first render's.
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  const pan = useRef(
    PanResponder.create({
      // Claim only a deliberate downward drag, so a tap on the title still
      // falls through and an upward pull does nothing.
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 4,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > sheetH.current * SHEET_DISMISS_RATIO || g.vy > SHEET_DISMISS_VELOCITY) {
          closeRef.current();
        } else {
          RNAnimated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => {
        RNAnimated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
    }),
  ).current;

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={requestClose} statusBarTranslucent>
      {/* The KeyboardAvoidingView must be the full-screen flex container (not a
          wrapper hugging the sheet) or `behavior:'padding'` mis-measures and the
          sheet floats detached from the keyboard with the scrim showing through.
          It docks the sheet to the bottom; when the keyboard opens it lifts the
          sheet to sit flush on top of it. */}
      <KeyboardAvoidingView
        style={styles.sheetRoot}
        behavior={avoidKeyboard && Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Tap-outside-to-close scrim, fading in step with the slide. */}
        <RNAnimated.View style={[StyleSheet.absoluteFill, styles.sheetScrim, { opacity: scrim }]}>
          <Pressable testID="sheet-scrim" style={StyleSheet.absoluteFill} onPress={requestClose} />
        </RNAnimated.View>
        <RNAnimated.View
          accessibilityViewIsModal
          onLayout={(e) => {
            sheetH.current = e.nativeEvent.layout.height;
          }}
          // Pad the bottom past the home indicator so the last row (e.g. the
          // label picker's "Add Custom Label…") clears the safe-area inset.
          style={[
            styles.modalSheet,
            { paddingBottom: spacing.md + (keyboardUp ? 0 : insets.bottom), transform: [{ translateY }] },
            style,
          ]}
        >
          {/* The drag strip: grabber + title. Everything below it scrolls. */}
          <View {...pan.panHandlers} style={styles.sheetHandleArea}>
            <View style={styles.sheetGrabber} />
            {title ? <Text style={styles.modalTitle}>{title}</Text> : null}
          </View>
          {children}
        </RNAnimated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

// The canonical full-screen loading fallback: a centered spinner tinted with the
// screen's section accent (falls back to the app primary). Replaces the ~15
// hand-rolled `center`/`loading` container styles scattered across screens.
export function CenteredLoader({ color = colors.primary }: { color?: string }) {
  return (
    <View style={styles.centeredLoader}>
      <ActivityIndicator size="large" color={color} />
    </View>
  );
}

// One shared empty-state layout so every list reads the same: optional icon,
// a bold title, a muted one-liner, and an optional accent-tinted CTA button.
// `variant="screen"` fills and centers (the only content on screen); `inline`
// sits at the top of an otherwise-populated scroll view.
export function EmptyState({
  icon,
  mdiIcon,
  title,
  message,
  actionLabel,
  onAction,
  accent = colors.primary,
  variant = 'screen',
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  mdiIcon?: string;
  title?: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  accent?: string;
  variant?: 'screen' | 'inline';
  // Extra affordances rendered below the CTA (e.g. a "Browse templates" link).
  children?: React.ReactNode;
}) {
  return (
    <View style={variant === 'screen' ? styles.emptyScreen : styles.emptyInline}>
      {mdiIcon ? (
        <MaterialCommunityIcons name={mdiIcon.replace(/^mdi-/, '') as any} size={52} color={accent} />
      ) : icon ? (
        <Ionicons name={icon} size={52} color={accent} />
      ) : null}
      {title ? <Text style={styles.emptyStateTitle}>{title}</Text> : null}
      {message ? <Text style={styles.emptyStateMessage}>{message}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity
          style={[styles.emptyStateAction, { backgroundColor: accent }]}
          onPress={onAction}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.emptyStateActionText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
      {children}
    </View>
  );
}

// A shimmering placeholder block. Pulses opacity via Reanimated (already a dep)
// so we avoid a shimmer library. Compose these into row/card shapes below.
export function Skeleton({ width, height = 14, radius: r = radius.sm, style }: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useSharedValue(0.5);
  useEffect(() => {
    opacity.value = withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(0.5, { duration: 700 })), -1, false);
  }, []);
  const anim = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width: width as any, height, borderRadius: r, backgroundColor: colors.border }, anim, style]} />;
}

// A skeleton in the shape of the standard list card: a leading avatar disc and
// two text lines. `count` renders a full list of them as the loading fallback.
export function SkeletonList({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.skeletonList}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton width={44} height={44} radius={22} />
          <View style={styles.skeletonRowText}>
            <Skeleton width={'60%'} height={15} />
            <Skeleton width={'40%'} height={12} style={{ marginTop: 8 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

// Bare shimmering text lines for content that loads inside an already-rendered
// card or section (grocery rows, outlook rows, picker rows) — SkeletonList's
// full-bleed avatar rows would overpower a card interior. Widths stagger so the
// block reads as settling text, not stripes.
export function SkeletonRows({ count = 3, height = 14, style }: {
  count?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const widths: Array<`${number}%`> = ['90%', '72%', '82%', '64%', '86%', '70%'];
  return (
    <View style={[styles.skeletonRows, style]}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width={widths[i % widths.length]} height={height} />
      ))}
    </View>
  );
}

// A skeleton in the shape of a detail screen: bold title block, a wide
// hero/info card, then a few icon+label field rows. The loading fallback for
// detail screens whose fetch is genuinely visible (deep links, push-notification
// entries, uncached pulls) — replica-fast edit-form seeds keep CenteredLoader
// (see mobile/CLAUDE.md's loading table).
export function SkeletonDetail() {
  return (
    <View style={styles.skeletonDetail}>
      <Skeleton width={'60%'} height={24} />
      <Skeleton width={'40%'} height={14} style={{ marginTop: 10 }} />
      <Skeleton width={'100%'} height={96} radius={radius.md} style={{ marginTop: spacing.lg }} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skeletonDetailRow}>
          <Skeleton width={28} height={28} radius={14} />
          <Skeleton width={i === 1 ? '52%' : '68%'} height={14} style={{ marginLeft: spacing.md }} />
        </View>
      ))}
    </View>
  );
}

// The standard inline form/validation error line. Renders nothing when empty so
// call sites can drop the `{error ? … : null}` conditional. Replaces the ~18
// hand-rolled `styles.error` definitions.
export function FormError({ children, style }: { children?: React.ReactNode; style?: StyleProp<TextStyle> }) {
  if (!children) return null;
  return <Text style={[styles.formError, style]}>{children}</Text>;
}

// The muted explainer line that sits above a field/section to describe it.
// One size (13 / lineHeight 18); replaces the drifting `hint`/`intro` locals.
export function Hint({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.hint, style]}>{children}</Text>;
}

// A label with its explanation folded away behind an ⓘ toggle (the pattern
// ContactImportScreen introduced for its import options). Use it when the
// explanation is genuinely optional — background a curious or stuck user wants,
// not something everyone must read to act. Keeping prose off the first screen
// is what makes the ACTIONS legible; a wall of caveats above two buttons reads
// as a problem rather than a choice.
//
// `label` is always visible. `hint` appears only once the user asks for it, and
// the icon fills in while open so the toggle's state is visible at a glance.
// The glyph is the ⓘ pair app-wide (never an eye — see mobile/CLAUDE.md): this
// discloses an explanation, not a masked value.
export function HintDisclosure({
  label,
  hint,
  labelStyle,
  hintStyle,
  accessibilityLabel,
  style,
}: {
  label: React.ReactNode;
  hint: React.ReactNode;
  labelStyle?: StyleProp<TextStyle>;
  hintStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={style}>
      {/* The whole label row toggles, not just the glyph: an 18px icon is well
          under the 44pt touch target, and a question printed next to an
          untappable question mark is a trap for exactly the user who needs the
          answer. */}
      <TouchableOpacity
        style={styles.hintDisclosureRow}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel || 'More information'}
        accessibilityState={{ expanded: open }}
      >
        {typeof label === 'string'
          ? <Text style={[styles.hintDisclosureLabel, labelStyle]}>{label}</Text>
          : label}
        <Ionicons
          name={open ? 'information-circle' : 'information-circle-outline'}
          size={18}
          color={colors.textMuted}
        />
      </TouchableOpacity>
      {open ? (
        typeof hint === 'string'
          ? <Text style={[styles.hint, styles.hintDisclosureHint, hintStyle]}>{hint}</Text>
          : hint
      ) : null}
    </View>
  );
}

// A prominent tinted-banner callout (louder than a muted Hint) shown at the top
// of a settings screen when the user arrived from a Calen "setup" deep-link — it
// states why they're here and what to fill in. Mirrors the app's tinted-banner
// convention (CreditsBanner, EventLocation's phone callout). Defaults to the
// app-primary tint; pass `accent` for a feature-area colour (e.g. a calendar
// colour). Pair it with `highlight` on the target field to draw the eye there.
export function SetupCallout({
  children,
  icon = 'information-circle',
  accent = colors.primary,
  style,
}: {
  children: React.ReactNode;
  icon?: keyof typeof Ionicons.glyphMap;
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.setupCallout, { backgroundColor: accent + '1A', borderColor: accent + '55' }, style]}>
      <View style={[styles.setupCalloutIcon, { backgroundColor: accent }]}>
        <Ionicons name={icon} size={16} color="#fff" />
      </View>
      <Text style={styles.setupCalloutText}>{children}</Text>
    </View>
  );
}

// The standard leading disc for list rows: a solid-fill circle (borderRadius =
// size/2) holding a white glyph. Takes an Ionicons `icon` or a MaterialCommunity
// `mdiIcon`. Default size 44 is the list-row standard; pass 40 for denser rows.
export function IconAvatar({
  icon,
  mdiIcon,
  bg = colors.primary,
  color = '#fff',
  size = 44,
  radius: r,
  style,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  mdiIcon?: string;
  bg?: string;
  color?: string;
  size?: number;
  // Corner radius; defaults to size/2 (a circle). Pass a smaller value for a
  // rounded-square disc (e.g. detail-header avatars).
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: r ?? size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      {mdiIcon ? (
        <MaterialCommunityIcons name={mdiIcon.replace(/^mdi-/, '') as any} size={Math.round(size * 0.5)} color={color} />
      ) : icon ? (
        <Ionicons name={icon} size={Math.round(size * 0.5)} color={color} />
      ) : null}
    </View>
  );
}

// A standalone tappable list card: a Card holding a leading element (IconAvatar /
// thumbnail / icon), a title (+ optional inline `titleRight` like a status chip),
// a subtitle (a string, or a node for icon-studded meta rows), and trailing
// content (`right` — a Switch/Badge…; falls back to a chevron when `onPress` is
// set). The richer sibling of ListRow (which is a bare row inside a card). For
// bespoke cards (expandable, flush colour-bar) keep a raw Card; for swipe-to-
// delete wrap whatever the row is in SwipeableRow.
export function CardRow({
  leading,
  title,
  titleStyle,
  titleRight,
  subtitle,
  right,
  onPress,
  style,
}: {
  leading?: React.ReactNode;
  title: string;
  // Optional override for the title text (e.g. strike-through on a cancelled row).
  titleStyle?: StyleProp<TextStyle>;
  titleRight?: React.ReactNode;
  subtitle?: string | React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <Card style={[styles.cardRow, style]}>
      {leading}
      <View style={styles.cardRowText}>
        <View style={styles.cardRowTitleLine}>
          <Text style={[styles.cardRowTitle, titleStyle]} numberOfLines={1}>{title}</Text>
          {titleRight}
        </View>
        {subtitle != null ? (
          typeof subtitle === 'string' ? (
            <Text style={styles.cardRowSubtitle} numberOfLines={1}>{subtitle}</Text>
          ) : (
            <View style={styles.cardRowSubtitleRow}>{subtitle}</View>
          )
        ) : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null)}
    </Card>
  );
  return onPress ? (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress}>{body}</TouchableOpacity>
  ) : (
    body
  );
}

// Width of the destructive action revealed behind a swiped row.
const SWIPE_ACTION_WIDTH = 88;
// Below this the action is the word alone: a glyph stacked over a label needs
// ~40pt of its own, and a short interior row (a planner meal is ~28pt) crushes
// the pair rather than dropping one — the same call UIKit makes when a swipe
// action can't fit its image.
const SWIPE_ICON_MIN_HEIGHT = 56;

// The iOS swipe-to-delete row: dragging left slides a red Delete action in from
// the right edge; tapping it fires `onDelete` (which must put up the native
// confirm — see the destructive-actions rule in mobile/CLAUDE.md) and springs
// the row closed. Built on RN's own PanResponder/Animated, like BottomSheet's
// drag, because gesture-handler isn't a dependency of this app.
//
// The action parks *outside* the wrap and travels with the content rather than
// sitting behind it, so it stays clipped until it's dragged in. That's what lets
// this wrap transparent content — a bare row inside a card, not just an opaque
// Card — without the red bleeding through at rest.
//
// `actionStyle` carries the geometry, since the action has to look like it
// belongs to whatever it slid out of: a standalone card passes its corner radius
// and bottom margin; a row inside a card passes the row's own radius.
//
// The action's own contents follow the row's measured height: a tall card gets
// the trash glyph over the word, a short interior row gets the word alone.
// Swiping back the other way — or tapping the open row — puts it away.
export function SwipeableRow({
  children,
  onDelete,
  label = 'Delete',
  actionStyle,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  label?: string;
  actionStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const translateX = useRef(new RNAnimated.Value(0)).current;
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [rowHeight, setRowHeight] = useState(0);
  // While a row is open, its own swipe-right has to beat the screen's
  // interactive pop: a meal row sits ~28pt in from the left edge, well inside
  // iOS's back-gesture zone, so closing the row would instead pop the screen —
  // the user swipes right to undo and lands back out of the view. UIKit
  // suppresses the pop the same way while a swipe action is revealed. Held for
  // as long as any row here is open, and released on close/unmount.
  const nav = useContext(NavigationContext);
  const navRef = useRef(nav);
  navRef.current = nav;
  const setBackGesture = (enabled: boolean) => navRef.current?.setOptions?.({ gestureEnabled: enabled });
  useEffect(() => () => { if (openRef.current) setBackGesture(true); }, []);

  const snap = (next: boolean) => {
    if (next !== openRef.current) setBackGesture(!next);
    openRef.current = next;
    setOpen(next);
    RNAnimated.spring(translateX, {
      toValue: next ? -SWIPE_ACTION_WIDTH : 0,
      useNativeDriver: true,
      bounciness: 0,
    }).start();
  };

  // Claim the gesture only for a deliberate horizontal drag, so vertical
  // scrolling and taps still pass through to the list / row. An open row claims
  // sooner: the swipe that closes it is the one competing with the screen's
  // back gesture, and losing that race navigates away.
  const isSwipe = (g: PanResponderGestureState) =>
    Math.abs(g.dx) > (openRef.current ? 4 : 12) && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => isSwipe(g),
      // …and take it *from* a child that already holds the touch: the row's own
      // Touchable, or the close overlay below, which would otherwise swallow
      // the very drag that puts the action away.
      onMoveShouldSetPanResponderCapture: (_, g) => isSwipe(g),
      // Once the drag is ours, a parent scroll view doesn't get to take it back
      // mid-swipe and strand the row half-open.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        const base = openRef.current ? -SWIPE_ACTION_WIDTH : 0;
        translateX.setValue(Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, base + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        if (openRef.current && Math.abs(g.dx) < 8) return snap(false); // a tap
        // A flick settles by direction; a slow drag by how far it got. Without
        // the velocity test a quick right-flick that travels less than half the
        // action's width springs back open, which reads as "it won't let me".
        if (Math.abs(g.vx) > 0.3) return snap(g.vx < 0);
        const base = openRef.current ? -SWIPE_ACTION_WIDTH : 0;
        snap(base + g.dx < -SWIPE_ACTION_WIDTH / 2);
      },
      onPanResponderTerminate: () => snap(openRef.current),
    })
  ).current;

  return (
    <View style={styles.swipeWrap} onLayout={(e) => setRowHeight(e.nativeEvent.layout.height)}>
      <RNAnimated.View style={[styles.swipeAction, actionStyle, { transform: [{ translateX }] }]}>
        <TouchableOpacity
          style={styles.swipeActionBtn}
          onPress={() => {
            snap(false);
            onDelete();
          }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
        >
          {rowHeight >= SWIPE_ICON_MIN_HEIGHT ? (
            <>
              <Ionicons name="trash-outline" size={22} color="#fff" />
              <Text style={styles.swipeActionText}>{label}</Text>
            </>
          ) : (
            <Text style={[styles.swipeActionText, styles.swipeActionTextAlone]}>{label}</Text>
          )}
        </TouchableOpacity>
      </RNAnimated.View>
      <RNAnimated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
        {children}
        {/* An open row is inert: tapping it closes the action rather than
            opening whatever the row points at (UIKit does the same). A
            Pressable rather than a responder-capture, so a vertical drag still
            hands off to the list's scroll. */}
        {open ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => snap(false)}
            accessibilityLabel="Close"
            accessibilityRole="button"
          />
        ) : null}
      </RNAnimated.View>
    </View>
  );
}

// A palette grid for picking an accent colour. Each option is a solid disc; the
// selected one shows a white checkmark (no layout shift). Replaces the four
// near-identical swatch grids (calendar colour, subscribe, trip colour…).
export function ColorPicker({
  value,
  onChange,
  options,
  disabled,
  size = 36,
  style,
}: {
  value: string;
  onChange: (c: string) => void;
  options: string[];
  disabled?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.colorPicker, style]}>
      {options.map((c) => {
        const selected = c.toLowerCase() === value?.toLowerCase();
        return (
          <TouchableOpacity
            key={c}
            style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c, alignItems: 'center', justifyContent: 'center' }}
            disabled={disabled}
            activeOpacity={0.8}
            onPress={() => onChange(c)}
          >
            {selected ? <Ionicons name="checkmark" size={Math.round(size * 0.45)} color="#fff" /> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  color = colors.primary,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  color?: string;
}) {
  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.7 : 1}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: color },
        selected && { backgroundColor: color },
      ]}
    >
      <Text style={[styles.chipText, { color: selected ? '#fff' : color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// A small status pill (non-interactive), e.g. "Overdue" / "Paused".
export function Badge({ label, color = colors.textMuted }: { label: string; color?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segmentBtn, active && styles.segmentBtnActive]}
            onPress={() => onChange(opt.value)}
            activeOpacity={0.8}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function SwitchRow({
  label,
  value,
  onValueChange,
  highlight,
  boxed,
  color,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  highlight?: boolean;
  // Render like the other form fields: a small label above a bordered box.
  boxed?: boolean;
  // On-state track tint (e.g. a calendar's colour); defaults to the app primary.
  color?: string;
}) {
  const trackColor = { true: color ?? colors.primary };
  if (boxed) {
    return (
      <View style={styles.inputWrap}>
        <View style={[styles.input, styles.selectField, highlight && styles.inputHighlight]}>
          <Text style={styles.selectValue}>{label}</Text>
          <RNSwitch value={value} onValueChange={onValueChange} trackColor={trackColor} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.switchRow, highlight && styles.switchRowHighlight]}>
      <Text style={styles.switchLabel}>{label}</Text>
      <RNSwitch value={value} onValueChange={onValueChange} trackColor={trackColor} />
    </View>
  );
}

// A tappable detail/list row with optional leading icon and trailing content.
export function ListRow({
  icon,
  mdiIcon,
  title,
  subtitle,
  onPress,
  right,
  iconColor = colors.textMuted,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  // A Material Design Icons name (with or without the `mdi-` prefix), rendered
  // instead of `icon` when provided — e.g. item type/category icons.
  mdiIcon?: string;
  title: string;
  subtitle?: string | null;
  onPress?: () => void;
  right?: React.ReactNode;
  iconColor?: string;
}) {
  const Wrapper: any = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.listRow} onPress={onPress} activeOpacity={0.7}>
      {mdiIcon ? (
        <MaterialCommunityIcons name={mdiIcon.replace(/^mdi-/, '') as any} size={20} color={iconColor} style={styles.listRowIcon} />
      ) : icon ? <Ionicons name={icon} size={20} color={iconColor} style={styles.listRowIcon} /> : null}
      <View style={styles.listRowText}>
        <Text style={styles.listRowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listRowSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress && !right ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      ) : null}
    </Wrapper>
  );
}

// A tappable section header that reveals/collapses its children — an iOS-style
// accordion menu row. The header is a rounded card; the body renders its own
// chrome (GroupCard/Card), so nothing is nested inside another card.
export function AccordionSection({
  icon,
  title,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.accordion}>
      <TouchableOpacity
        style={styles.accordionHeader}
        onPress={onToggle}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
      >
        {icon ? <Ionicons name={icon} size={20} color={colors.primary} style={styles.accordionIcon} /> : null}
        <View style={styles.accordionTitleWrap}>
          <Text style={styles.accordionTitle}>{title}</Text>
          {subtitle ? <Text style={styles.accordionSubtitle}>{subtitle}</Text> : null}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {expanded ? <View style={styles.accordionBody}>{children}</View> : null}
    </View>
  );
}

export interface Option<T> {
  label: string;
  value: T;
}

// A labeled field that opens a modal option list. Supports single or multi
// select; replaces Vuetify's <v-select>.
export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  clearable,
  disabled,
  multiple,
  values,
  onChangeMultiple,
  highlight,
  containerStyle,
  fieldStyle,
  valueStyle,
  chevronIcon,
  inlineLabel,
  initialScrollValue,
}: {
  label?: string;
  value?: T | null;
  options: Option<T>[];
  onChange?: (v: T | null) => void;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  values?: T[];
  onChangeMultiple?: (v: T[]) => void;
  highlight?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
  valueStyle?: StyleProp<TextStyle>;
  // Override the trailing glyph (e.g. 'chevron-expand' for iOS-style menu rows).
  chevronIcon?: keyof typeof Ionicons.glyphMap;
  // Label rendered inside the touchable, left of the value — makes the whole
  // row (label included) open the picker. Also titles the option modal.
  inlineLabel?: string;
  // Open the option list scrolled so this option sits at the top (the user can
  // still scroll up to earlier options). E.g. the e-card hour picker opens at
  // noon so PM times are the visible default.
  initialScrollValue?: T;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<ScrollView>(null);
  // The initial-scroll option's y within the list content, captured on layout.
  const initialScrollY = useRef(0);
  const scrollToInitial = () => {
    if (initialScrollValue == null) return;
    listRef.current?.scrollTo({ y: initialScrollY.current, animated: false });
  };
  const selectedLabel = multiple
    ? options.filter((o) => values?.includes(o.value)).map((o) => o.label).join(', ')
    : options.find((o) => o.value === value)?.label;

  const toggleMulti = (v: T) => {
    const set = new Set(values || []);
    if (set.has(v)) set.delete(v);
    else set.add(v);
    onChangeMultiple?.(Array.from(set));
  };

  return (
    <View style={[styles.inputWrap, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TouchableOpacity
        style={[styles.input, styles.selectField, fieldStyle, highlight && styles.inputHighlight, disabled && styles.btnDisabled]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={0.7}
        disabled={disabled}
      >
        {inlineLabel ? <Text style={styles.inlineLabel}>{inlineLabel}</Text> : null}
        <Text style={[styles.selectValue, !selectedLabel && styles.selectPlaceholder, valueStyle]} numberOfLines={1}>
          {selectedLabel || placeholder}
        </Text>
        <Ionicons name={chevronIcon ?? 'chevron-down'} size={18} color={colors.textMuted} style={styles.selectChevron} />
      </TouchableOpacity>

      {/* The option list rides the shared BottomSheet (slide-up, grabber,
          drag-to-dismiss, home-indicator inset) rather than re-rolling one. */}
      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        title={label || inlineLabel || placeholder}
        onShow={scrollToInitial}
      >
        <ScrollView ref={listRef} style={styles.modalList}>
          {clearable && !multiple ? (
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => {
                onChange?.(null);
                setOpen(false);
              }}
            >
              <Text style={[styles.optionText, styles.selectPlaceholder]}>{placeholder}</Text>
              {value == null ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
            </TouchableOpacity>
          ) : null}
          {options.map((opt) => {
            const isSel = multiple ? values?.includes(opt.value) : opt.value === value;
            return (
              <TouchableOpacity
                key={String(opt.value)}
                style={styles.optionRow}
                // Capture the target option's position and scroll it to the
                // top — onLayout covers the first open (it fires after
                // onShow); onShow covers re-opens (layout doesn't re-fire).
                onLayout={
                  initialScrollValue === opt.value
                    ? (e) => {
                        initialScrollY.current = e.nativeEvent.layout.y;
                        scrollToInitial();
                      }
                    : undefined
                }
                onPress={() => {
                  if (multiple) {
                    toggleMulti(opt.value);
                  } else {
                    onChange?.(opt.value);
                    setOpen(false);
                  }
                }}
              >
                <Text style={styles.optionText}>{opt.label}</Text>
                {isSel ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {multiple ? <Button title="Done" onPress={() => setOpen(false)} /> : null}
      </BottomSheet>
    </View>
  );
}

// A Select-shaped row that navigates (or opens a screen) on tap instead of
// showing an option picker — same inline-label + value + chevron chrome, so it
// sits flush in a grouped form card next to real Select/DateField rows.
export function NavField({
  inlineLabel,
  value,
  placeholder,
  onPress,
  highlight,
  disabled,
  containerStyle,
  fieldStyle,
  valueStyle,
  chevronIcon = 'chevron-forward',
}: {
  inlineLabel?: string;
  value?: string | null;
  placeholder?: string;
  onPress: () => void;
  highlight?: boolean;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
  valueStyle?: StyleProp<TextStyle>;
  chevronIcon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={[styles.inputWrap, containerStyle]}>
      <TouchableOpacity
        style={[styles.input, styles.selectField, fieldStyle, highlight && styles.inputHighlight, disabled && styles.btnDisabled]}
        onPress={onPress}
        activeOpacity={0.7}
        disabled={disabled}
      >
        {inlineLabel ? <Text style={styles.inlineLabel}>{inlineLabel}</Text> : null}
        <Text style={[styles.selectValue, !value && styles.selectPlaceholder, valueStyle]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <Ionicons name={chevronIcon} size={18} color={colors.textMuted} style={styles.selectChevron} />
      </TouchableOpacity>
    </View>
  );
}

// ---- Date / Time pickers --------------------------------------------------
// Drop-in replacements for the plain YYYY-MM-DD / HH:MM text inputs. They keep
// the same value contract (emit `YYYY-MM-DD` for dates, `HH:MM` for times) so
// call sites only swap the component. iOS shows a spinner in a modal sheet
// (Done commits the shown value); Android uses the native dialog.

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

// Parse a `YYYY-MM-DD` string at local noon to avoid TZ day-rollover.
function parseDateValue(value?: string): Date {
  if (value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

function formatDateValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseTimeValue(value?: string): Date {
  const d = new Date();
  if (value) {
    const m = /^(\d{1,2}):(\d{2})/.exec(value);
    if (m) d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  }
  return d;
}

function formatTimeValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function friendlyDate(value: string): string {
  return parseDateValue(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// The stored value is 24-hour `HH:MM`; always show it as 12-hour with AM/PM.
function friendlyTime(value: string): string {
  return parseTimeValue(value).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function DateTimeField({
  mode,
  label,
  value,
  onChange,
  placeholder,
  clearable,
  minimumDate,
  maximumDate,
  defaultValue,
  highlight,
  containerStyle,
  fieldStyle,
  hideIcon,
  valueStyle,
  inlineLabel,
}: {
  mode: 'date' | 'time';
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clearable?: boolean;
  minimumDate?: Date;
  maximumDate?: Date;
  defaultValue?: string;
  highlight?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
  // Drop the trailing calendar/clock glyph (compact rows show the value only).
  hideIcon?: boolean;
  // Override the value text (compact pills need `flex: 0` — the default
  // `flex: 1` collapses to zero width inside a content-sized field).
  valueStyle?: StyleProp<TextStyle>;
  // Label rendered inside the touchable, left of the value — makes the whole
  // row (label included) open the picker. Also titles the iOS modal.
  inlineLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [temp, setTemp] = useState<Date>(new Date());
  const isDate = mode === 'date';

  // The native iOS inline date grid (display="inline") sizes its 7-column grid to
  // a fixed, roughly full-screen intrinsic width and *clips* (rather than shrinks)
  // the right (Saturday) column if given a narrower frame — so it can't simply be
  // inset. We give it the full screen width (cancelling the sheet's horizontal
  // padding with a matching negative margin) so nothing clips, then scale it down
  // a touch so the grid sits inset from both screen edges instead of running flush
  // to the right edge. Time mode keeps the stretched wheel.
  const { width: winWidth } = useWindowDimensions();
  const datePickerStyle = { width: winWidth, marginHorizontal: -spacing.md, transform: [{ scale: 0.92 }] } as const;

  const display = value
    ? isDate
      ? friendlyDate(value)
      : friendlyTime(value)
    : placeholder || (isDate ? 'Select date' : 'Select time');

  const emit = (d: Date) => onChange(isDate ? formatDateValue(d) : formatTimeValue(d));

  const openPicker = () => {
    setTemp(isDate ? parseDateValue(value || defaultValue) : parseTimeValue(value || defaultValue));
    setOpen(true);
  };

  const onAndroidChange = (e: DateTimePickerEvent, d?: Date) => {
    setOpen(false);
    if (e.type === 'set' && d) emit(d);
  };

  // iOS: dismissing the sheet (tap the backdrop / swipe / Done) accepts the
  // value the wheel is currently on — no separate confirm tap required.
  const commit = () => {
    emit(temp);
    setOpen(false);
  };

  return (
    <View style={[styles.inputWrap, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TouchableOpacity
        // fieldStyle sits before the highlight so the AI-changed tint stays visible.
        style={[styles.input, styles.selectField, fieldStyle, highlight && styles.inputHighlight]}
        onPress={openPicker}
        activeOpacity={0.7}
      >
        {inlineLabel ? <Text style={styles.inlineLabel}>{inlineLabel}</Text> : null}
        <Text style={[styles.selectValue, !value && styles.selectPlaceholder, valueStyle]} numberOfLines={1}>
          {display}
        </Text>
        <View style={styles.dateFieldIcons}>
          {clearable && value ? (
            <TouchableOpacity onPress={() => onChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} style={{ marginLeft: 8, marginRight: hideIcon ? 0 : 6 }} />
            </TouchableOpacity>
          ) : null}
          {hideIcon ? null : (
            <Ionicons name={isDate ? 'calendar-outline' : 'time-outline'} size={18} color={colors.textMuted} />
          )}
        </View>
      </TouchableOpacity>

      {open && Platform.OS === 'android' ? (
        <DateTimePicker
          value={temp}
          mode={mode}
          display="default"
          onChange={onAndroidChange}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          is24Hour={false}
        />
      ) : null}

      {Platform.OS === 'ios' ? (
        // Same shared sheet as every other picker — dismissing by scrim tap or
        // grabber drag commits the wheel's current value, exactly like "Done".
        <BottomSheet visible={open} onClose={commit} title={label || inlineLabel}>
          <DateTimePicker
            value={temp}
            mode={mode}
            // Apple Calendar-style: a month grid for dates, a wheel for time.
            display={isDate ? 'inline' : 'spinner'}
            onChange={(_, d) => d && setTemp(d)}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            // Force a 12-hour wheel even when the device is set to 24-hour time.
            locale={isDate ? undefined : 'en_US'}
            themeVariant="dark"
            accentColor={colors.primary}
            style={[styles.iosPicker, isDate && datePickerStyle]}
          />
          <Button title="Done" onPress={commit} />
        </BottomSheet>
      ) : null}
    </View>
  );
}

export function DateField(props: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clearable?: boolean;
  minimumDate?: Date;
  maximumDate?: Date;
  defaultValue?: string;
  highlight?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
  hideIcon?: boolean;
  valueStyle?: StyleProp<TextStyle>;
  inlineLabel?: string;
}) {
  return <DateTimeField mode="date" {...props} />;
}

export function TimeField(props: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clearable?: boolean;
  defaultValue?: string;
  highlight?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
  hideIcon?: boolean;
  valueStyle?: StyleProp<TextStyle>;
  inlineLabel?: string;
}) {
  return <DateTimeField mode="time" {...props} />;
}

// A phone-number field with a country selector (flag + dial code) and live
// "as you type" formatting. Emits canonical E.164 via `onChangeText` for
// storage; seeds itself from an existing stored value (E.164 or legacy digits)
// and re-derives when `value` changes externally (FormAssist / Places prefill).
// Same style contract as Input/Select so it drops into a standalone bordered
// layout (pass `label`) or flush inside a GroupCard (pass fs.headField /
// fs.headInput via containerStyle / fieldStyle).
export function PhoneField({
  label,
  value,
  onChangeText,
  placeholder = 'Phone number',
  highlight,
  defaultCountry,
  containerStyle,
  fieldStyle,
  style,
  ...rest
}: Omit<TextInputProps, 'value' | 'onChangeText'> & {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  highlight?: boolean;
  defaultCountry?: CountryCode;
  containerStyle?: StyleProp<ViewStyle>;
  fieldStyle?: StyleProp<ViewStyle>;
}) {
  const fallback = defaultCountry ?? deviceCountry();
  const [country, setCountry] = useState<CountryCode>(fallback);
  const [display, setDisplay] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [focused, setFocused] = useState(false);

  // A ScrollView keeps its scroll offset when its content shrinks, so after any
  // scroll (or a keyboard-driven layout shift) a filtered-down list can leave
  // the surviving rows scrolled out of view. Reset to the top whenever the query
  // changes so the matches are always visible.
  const listRef = useRef<ScrollView>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ y: 0, animated: false });
  }, [search]);

  // The E.164 we last emitted. An external `value` change (initial seed, AI
  // assist, Places prefill) re-derives the field; our own keystrokes already
  // updated `display`, so we skip re-seeding on those (keeps the cursor put).
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const parsed = parseStored(value, fallback);
    setCountry(parsed.country);
    setDisplay(parsed.national);
    lastEmitted.current = value ?? '';
  }, [value, fallback]);

  const emit = (nextDisplay: string, nextCountry: CountryCode) => {
    const e164 = toE164(nextDisplay, nextCountry);
    lastEmitted.current = e164;
    onChangeText(e164);
  };

  const onType = (text: string) => {
    const formatted = formatAsYouType(text, country);
    setDisplay(formatted);
    emit(formatted, country);
  };

  const closePicker = () => {
    setPickerOpen(false);
    setSearch('');
  };

  const pickCountry = (c: CountryCode) => {
    setPickerOpen(false);
    setSearch('');
    setCountry(c);
    const reformatted = formatAsYouType(display, c);
    setDisplay(reformatted);
    emit(reformatted, c);
  };

  const callingCode = COUNTRIES.find((c) => c.code === country)?.callingCode ?? '';
  const q = search.trim().toLowerCase();
  const filtered = q
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.code.toLowerCase().includes(q) ||
          c.callingCode.includes(q.replace('+', '')),
      )
    : COUNTRIES;

  return (
    <View style={[styles.inputWrap, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.input, styles.phoneRow, fieldStyle, highlight && styles.phoneHighlight]}>
        <TouchableOpacity
          style={styles.phoneCountryBtn}
          onPress={() => setPickerOpen(true)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Select country code"
        >
          <Text style={styles.phoneFlag}>{flagEmoji(country)}</Text>
          <Text style={styles.phoneCode}>+{callingCode}</Text>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={styles.phoneDivider} />
        <TextInput
          value={display}
          onChangeText={onType}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          style={[styles.phoneInput, style]}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
        />
        {focused && display.length > 0 && rest.editable !== false ? (
          <ClearButton inline onPress={() => onType('')} />
        ) : null}
      </View>

      {/* The shared sheet, with `avoidKeyboard` so it is *lifted* clear of the
          keyboard rather than squeezed, and a definite height (via
          `phonePickerSheet`) so the title + search stay pinned and the list is
          what scrolls — it can never collapse to a sliver that hides the one
          matching row. */}
      <BottomSheet visible={pickerOpen} onClose={closePicker} title="Country" avoidKeyboard style={styles.phonePickerSheet}>
        <Input placeholder="Search" value={search} onChangeText={setSearch} autoFocus autoCapitalize="none" autoCorrect={false} containerStyle={styles.phoneSearch} />
        <ScrollView ref={listRef} style={styles.phoneCountryList} keyboardShouldPersistTaps="handled">
          {filtered.map((c) => (
            <TouchableOpacity key={c.code} style={styles.optionRow} onPress={() => pickCountry(c.code)}>
              <Text style={styles.phoneCountryName} numberOfLines={1}>
                {flagEmoji(c.code)}  {c.name}
              </Text>
              <Text style={styles.phoneCountryDial}>+{c.callingCode}</Text>
            </TouchableOpacity>
          ))}
          {filtered.length === 0 ? <Text style={styles.phoneNoMatch}>No matches</Text> : null}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

// A picker-free phone input: no country selector, no flag, no dial-code chip — the
// number takes the full width. The user types a local number normally, or a
// leading "+<country code>" for an international one; formatting follows suit
// (national by device region, or international once a "+" is present). Emits
// canonical E.164 for storage, same contract as PhoneField, and seeds itself from
// a stored value. Use where a flush row shares its line with other controls (the
// contact form's multi-value rows) and the picker button would crowd the number.
// Renders like Input, so it drops in beside the sibling email <Input> unchanged.
export function PhoneTextField({
  value,
  onChangeText,
  placeholder = 'Phone',
  ...rest
}: Omit<TextInputProps, 'value' | 'onChangeText'> & {
  value: string;
  onChangeText: (v: string) => void;
  label?: string;
  highlight?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const [display, setDisplay] = useState('');

  // The E.164 we last emitted. An external `value` change (initial seed, AI
  // assist, Places prefill) re-derives the field; our own keystrokes already
  // updated `display`, so we skip re-seeding on those (keeps the cursor put).
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (value === lastEmitted.current) return;
    setDisplay(seedTyped(value));
    lastEmitted.current = value ?? '';
  }, [value]);

  const onType = (text: string) => {
    setDisplay(formatAsTyped(text));
    const e164 = toE164FromTyped(text);
    lastEmitted.current = e164;
    onChangeText(e164);
  };

  return (
    <Input
      value={display}
      onChangeText={onType}
      placeholder={placeholder}
      keyboardType="phone-pad"
      textContentType="telephoneNumber"
      autoComplete="tel"
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCompact: { paddingVertical: 6, paddingHorizontal: spacing.sm },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  btnDanger: { backgroundColor: colors.error },
  btnDisabled: { opacity: 0.6 },
  headerCheck: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headerClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerIconBtn: { paddingHorizontal: 6 },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnTextCompact: { fontSize: 14 },
  btnTextGhost: { color: colors.primary },
  inputWrap: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.textMuted, marginBottom: 6, fontWeight: '500' },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  // Room for the clear ✕ so text never runs under it — applied only while the
  // button is visible, so the text edge slides just like iOS's native clear.
  inputClearPad: { paddingRight: 36 },
  clearBtn: {
    position: 'absolute',
    right: 8,
    bottom: 0,
    height: 46,
    justifyContent: 'center',
  },
  clearBtnInline: { paddingLeft: spacing.sm },
  // Applied to fields the AI form assistant just changed, so the user can spot
  // them at a glance. Accent border + a subtle primary tint over the surface.
  inputHighlight: {
    borderColor: colors.primary,
    borderWidth: 1.5,
    backgroundColor: colors.primary + '22',
  },
  switchRowHighlight: {
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primary + '22',
    paddingHorizontal: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Overrides Card's padding so the ListRows inside own their spacing.
  infoCard: { padding: 0, paddingVertical: spacing.xs },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  cardRowText: { flex: 1, minWidth: 0 },
  cardRowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  cardRowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  cardRowSubtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  cardRowSubtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4, flexWrap: 'wrap' },

  // Swipe-to-delete. The action parks just past the right edge and is clipped by
  // the wrap until the same translate that moves the content drags it into view;
  // callers pass the geometry (radius / insets) via actionStyle.
  swipeWrap: { position: 'relative', overflow: 'hidden' },
  swipeAction: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -SWIPE_ACTION_WIDTH,
    width: SWIPE_ACTION_WIDTH,
    backgroundColor: colors.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeActionBtn: { flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  swipeActionText: { color: '#fff', fontSize: 12, fontWeight: '600', marginTop: 2 },
  // Carrying the action on its own, the word takes the glyph's weight.
  swipeActionTextAlone: { fontSize: 14, marginTop: 0 },

  accordion: { marginBottom: spacing.md },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  accordionIcon: { marginRight: spacing.sm },
  accordionTitleWrap: { flex: 1, minWidth: 0 },
  accordionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  accordionSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  accordionBody: { marginTop: spacing.md },
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: { padding: spacing.md },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  screenTitle: { fontSize: 24, fontWeight: '700', color: colors.text },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  centeredLoader: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  emptyScreen: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background, padding: spacing.lg, gap: spacing.sm,
  },
  emptyInline: { alignItems: 'center', marginTop: spacing.xl, padding: spacing.lg, gap: spacing.sm },
  emptyStateTitle: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyStateMessage: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
  emptyStateAction: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.md,
  },
  emptyStateActionText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  skeletonList: { padding: spacing.md },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, marginBottom: spacing.sm },
  skeletonRowText: { flex: 1, marginLeft: spacing.md },
  skeletonRows: { gap: 12, paddingVertical: spacing.sm },
  skeletonDetail: { padding: spacing.md },
  skeletonDetailRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg },
  formError: { color: colors.error, marginVertical: spacing.sm, fontSize: 14 },
  hint: { fontSize: 13, color: colors.textMuted, lineHeight: 18, marginBottom: spacing.md },
  hintDisclosureRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, // pads the row out toward a comfortable touch target
  },
  hintDisclosureLabel: { fontSize: 15, color: colors.text, fontWeight: '600' },
  hintDisclosureHint: { marginTop: 4, marginBottom: 0 },
  // SetupCallout — a tinted fill + border, filled icon disc, bold text (tint
  // colours applied inline from the `accent` prop). Deliberately louder than Hint.
  setupCallout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  setupCalloutIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  setupCalloutText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text, lineHeight: 19 },
  colorPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
    marginBottom: 6,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
  badge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.border + '66',
    borderRadius: radius.md,
    padding: 3,
  },
  segmentBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: radius.sm },
  segmentBtnActive: { backgroundColor: colors.surface, shadowOpacity: 0.1, shadowRadius: 2, elevation: 1 },
  segmentText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  segmentTextActive: { color: colors.text },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  switchLabel: { flex: 1, fontSize: 15, color: colors.text, marginRight: spacing.md },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  listRowIcon: { marginRight: spacing.md },
  listRowText: { flex: 1 },
  listRowTitle: { fontSize: 15, color: colors.text, fontWeight: '500' },
  listRowSubtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  selectField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  phoneRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 0, minHeight: 46 },
  // Tint-only highlight (no border) to match the grouped-card FormAssist look.
  phoneHighlight: { backgroundColor: colors.primary + '22' },
  phoneCountryBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 12, paddingRight: 8 },
  phoneFlag: { fontSize: 18 },
  phoneCode: { fontSize: 16, color: colors.text },
  phoneDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: colors.border, marginRight: 10, marginVertical: 8 },
  phoneInput: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 12 },
  phoneSearch: { marginBottom: spacing.sm },
  // Full-screen keyboard-avoider root: reduces the usable area to *above* the
  // keyboard so the flex-end sheet is lifted clear, not compressed.
  // A definite-height sheet (percentage of the above-keyboard area) so the title
  // + search stay pinned at the top and the list — not the sheet — is what fills
  // and scrolls. `overflow: hidden` keeps the rounded top corners clipping rows.
  // Merged into BottomSheet's own sheet style, so it only carries the overrides.
  phonePickerSheet: {
    height: '78%',
    maxHeight: '78%',
    overflow: 'hidden',
  },
  // flex:1 inside the definite-height sheet: fills the space beneath the pinned
  // search and scrolls, so a single match sits at the top and can never scroll
  // out of view, while the search field is always visible.
  phoneCountryList: { flex: 1, marginBottom: spacing.sm },
  phoneNoMatch: { fontSize: 15, color: colors.textMuted, paddingVertical: spacing.md, textAlign: 'center' },
  phoneCountryName: { fontSize: 16, color: colors.text, flex: 1, marginRight: spacing.sm },
  phoneCountryDial: { fontSize: 16, color: colors.textMuted },
  selectChevron: { marginLeft: 6 },
  inlineLabel: { flex: 1, fontSize: 16, color: colors.text, marginRight: spacing.sm },
  dateFieldIcons: { flexDirection: 'row', alignItems: 'center' },
  iosPicker: { alignSelf: 'stretch' },
  selectValue: { fontSize: 16, color: colors.text, flex: 1 },
  selectPlaceholder: { color: colors.textMuted },
  // The full-screen flex container that docks the sheet to the bottom. The dim
  // is a sibling layer (sheetScrim) rather than this view's background, so it
  // can fade in step with the slide.
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  // A firmer scrim so a bottom sheet reads as clearly on top of the busy screen
  // behind it (the label picker over the contact form), not blended into it.
  sheetScrim: { backgroundColor: 'rgba(0,0,0,0.6)' },
  // The drag strip at the top of every sheet. Its padding is what gives the
  // grabber a finger-sized target beyond the 4px bar itself.
  sheetHandleArea: { paddingBottom: spacing.xs },
  sheetGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.md,
    // Tall enough that the Alert select's full option list (leave-relative
    // choices + "Custom…") isn't clipped at the bottom.
    maxHeight: '80%',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  modalList: { marginBottom: spacing.sm },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  optionText: { fontSize: 16, color: colors.text, flex: 1 },
});
