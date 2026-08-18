import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Pressable, Animated } from 'react-native';
// Every label here sits inside an event block whose height comes from the
// event's duration, not its text — so all of it takes the tight cap.
import { FixedText } from '../../../components/Text';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { colors, radius } from '../../../theme';
import { tintedChip, withAlpha } from '../../../lib/color';
import { DayNav } from './dayNav';
import {
  LaidBlock, DAY_MIN, PX_PER_MIN, timeRangeLabel, blockDetail, blockTitleLines,
  travelBandLabel, travelAccessibilityLabel, longPressDraft, snapSlot,
} from './dayViewLayout';

// The tint alpha the block fill has always used (18%), fed to the shared
// palette so the text on it is contrast-corrected against the real fill.
const FILL_ALPHA = 0.18;
// The travel band sits at a third of that, so it reads as lead-in to the block
// rather than as part of it.
const TRAVEL_ALPHA = 0.06;
const META_ICON = 11;

// The long-press ghost wears the app-primary tint (the draft has no calendar
// yet), and holds this long after springing in before the form pushes — enough
// for the eye to register where it landed, short enough to read as one motion.
const GHOST_TINT = tintedChip(colors.primary, FILL_ALPHA);
const GHOST_HOLD_MS = 250;

// One date's absolutely-positioned event blocks inside the hour grid. Apple's
// block look: translucent calendar-colour fill, a solid colour bar on the left
// edge, and title / location / time range set in the calendar colour, each meta
// line led by its own glyph. How many of those lines render is decided by the
// block's height (see `blockDetail`) — a half-hour event gets its title alone
// rather than three clipped rows.
//
// An event with a drive time extends UPWARD from its start: the travel band is
// the top slice of the same container, drawn in a fainter wash with a dashed
// left edge (the solid colour bar starts where the event does), so the time
// spent getting there is visible on the grid as time — not merely flagged.
const DayColumn = React.memo(function DayColumn({
  date,
  blocks,
  width,
}: {
  date: string;
  blocks: LaidBlock[];
  width: number;
}) {
  const navigation = useNavigation<DayNav>();

  // The long-press ghost: a "New Event" placeholder in the pressed slot,
  // springing in with the haptic so the draft's landing spot is visible
  // before the form pushes on top of it.
  const [ghost, setGhost] = useState<{ startMin: number; endMin: number } | null>(null);
  const ghostAnim = useRef(new Animated.Value(0)).current;
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);

  // The ghost outlives the push — behind the form it reads as the event being
  // created. When the day view regains focus it fades away: the saved event
  // takes its place, or nothing does if the form was cancelled.
  useEffect(() => {
    if (!ghost) return;
    return navigation.addListener('focus', () => {
      Animated.timing(ghostAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setGhost(null));
    });
  }, [ghost, navigation, ghostAnim]);

  const startDraft = (y: number) => {
    if (navTimer.current) return; // a push is already mid-flight
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setGhost(snapSlot(y));
    ghostAnim.setValue(0);
    Animated.spring(ghostAnim, { toValue: 1, speed: 24, bounciness: 6, useNativeDriver: true }).start();
    // Hold a beat so the eye registers where the draft landed, then push.
    navTimer.current = setTimeout(() => {
      navTimer.current = null;
      navigation.navigate('EventForm', { date, prefill: longPressDraft(date, y) });
    }, GHOST_HOLD_MS);
  };

  return (
    // Long-pressing empty grid space starts a new event at that spot (the
    // month grid's long-press-a-day, with the time filled in): the press's
    // 15-minute slot becomes a one-hour timed draft in the event form. Event
    // blocks sit on top and claim their own touches, so only the empty canvas
    // triggers it; a scroll or swipe cancels the press like any touchable.
    <Pressable
      style={{ width, height: DAY_MIN * PX_PER_MIN }}
      accessible={false}
      onLongPress={(e) => startDraft(e.nativeEvent.locationY)}
    >
      {blocks.map((b) => {
        const left = b.leftFrac * width + 1;
        const w = Math.max(24, b.widthFrac * width - 3);
        const travelH = b.travelHeight;
        const bodyHeight = Math.max(26, b.height - travelH - 2);
        const detail = blockDetail(bodyHeight);
        const tint = tintedChip(b.color, FILL_ALPHA);
        const showLocation = detail === 'full' && Boolean(b.location);
        const showTime = detail !== 'compact';
        const travelLabel = travelH ? travelBandLabel(b.travelMinutes ?? 0, travelH) : null;

        return (
          <TouchableOpacity
            key={b.key}
            activeOpacity={0.75}
            onPress={() => navigation.navigate('EventDetail', { eventId: b.eventId, date })}
            style={[
              styles.block,
              { top: b.top + 1, height: travelH + bodyHeight, left, width: w },
              b.faded && styles.faded,
            ]}
          >
            {travelH ? (
              <View
                style={[
                  styles.travelBand,
                  {
                    height: travelH,
                    backgroundColor: withAlpha(b.color, TRAVEL_ALPHA),
                    borderLeftColor: withAlpha(b.color, 0.4),
                  },
                ]}
                accessibilityLabel={travelAccessibilityLabel(b.travelMinutes ?? 0, b.startMin)}
              >
                {travelLabel ? (
                  <FixedText style={[styles.travelText, { color: tint.time }]} numberOfLines={1}>
                    {travelLabel}
                  </FixedText>
                ) : null}
              </View>
            ) : null}

            <View
              style={[
                styles.body,
                { backgroundColor: tint.fill, borderLeftColor: b.color },
                // The line where the driving stops and the event starts.
                travelH ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(b.color, 0.55) } : null,
              ]}
            >
              <FixedText
                style={[styles.title, { color: tint.label }, b.strike && styles.strike]}
                numberOfLines={blockTitleLines(bodyHeight)}
              >
                {b.title}
              </FixedText>

              {showLocation ? (
                <View style={styles.metaRow}>
                  <MaterialCommunityIcons name="map-marker-outline" size={META_ICON} color={tint.time} />
                  <FixedText style={[styles.meta, { color: tint.time }]} numberOfLines={1}>
                    {b.location}
                  </FixedText>
                </View>
              ) : null}

              {showTime ? (
                <View style={styles.metaRow}>
                  <MaterialCommunityIcons name="clock-outline" size={META_ICON} color={tint.time} />
                  <FixedText style={[styles.meta, { color: tint.time }]} numberOfLines={1}>
                    {timeRangeLabel(b.startMin, b.endMin)}
                  </FixedText>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}

      {ghost ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.block,
            {
              top: ghost.startMin * PX_PER_MIN + 1,
              // A last-hour ghost clips at the column's end like any block;
              // its range line still names the true midnight-crossing end.
              height: (Math.min(ghost.endMin, DAY_MIN) - ghost.startMin) * PX_PER_MIN - 2,
              left: 1,
              width: Math.max(24, width - 3),
              opacity: ghostAnim,
              transform: [{ scale: ghostAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }],
            },
          ]}
        >
          <View style={[styles.body, { backgroundColor: GHOST_TINT.fill, borderLeftColor: colors.primary }]}>
            <FixedText style={[styles.title, { color: GHOST_TINT.label }]} numberOfLines={1}>
              New Event
            </FixedText>
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="clock-outline" size={META_ICON} color={GHOST_TINT.time} />
              <FixedText style={[styles.meta, { color: GHOST_TINT.time }]} numberOfLines={1}>
                {timeRangeLabel(ghost.startMin, ghost.endMin)}
              </FixedText>
            </View>
          </View>
        </Animated.View>
      ) : null}
    </Pressable>
  );
});

export default DayColumn;

const styles = StyleSheet.create({
  block: {
    position: 'absolute',
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  faded: { opacity: 0.5 },
  // The lead-in: a fainter wash and a faded left bar where the event's is the
  // full-strength calendar colour — the same colour, not yet the event.
  travelBand: {
    justifyContent: 'center',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderLeftWidth: 3,
  },
  travelText: { fontSize: 10, lineHeight: 11, fontWeight: '600' },
  body: {
    flex: 1,
    borderLeftWidth: 3,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  title: { fontSize: 12, lineHeight: 15, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  meta: { flex: 1, fontSize: 11, lineHeight: 13 },
});
