import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { radius } from '../../../theme';
import { tintedChip, withAlpha } from '../../../lib/color';
import { DayNav } from './dayNav';
import {
  LaidBlock, DAY_MIN, PX_PER_MIN, timeRangeLabel, blockDetail, blockTitleLines,
  travelBandLabel, travelAccessibilityLabel,
} from './dayViewLayout';

// The tint alpha the block fill has always used (18%), fed to the shared
// palette so the text on it is contrast-corrected against the real fill.
const FILL_ALPHA = 0.18;
// The travel band sits at a third of that, so it reads as lead-in to the block
// rather than as part of it.
const TRAVEL_ALPHA = 0.06;
const META_ICON = 11;

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
  return (
    <View style={{ width, height: DAY_MIN * PX_PER_MIN }}>
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
                  <Text style={[styles.travelText, { color: tint.time }]} numberOfLines={1}>
                    {travelLabel}
                  </Text>
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
              <Text
                style={[styles.title, { color: tint.label }, b.strike && styles.strike]}
                numberOfLines={blockTitleLines(bodyHeight)}
              >
                {b.title}
              </Text>

              {showLocation ? (
                <View style={styles.metaRow}>
                  <MaterialCommunityIcons name="map-marker-outline" size={META_ICON} color={tint.time} />
                  <Text style={[styles.meta, { color: tint.time }]} numberOfLines={1}>
                    {b.location}
                  </Text>
                </View>
              ) : null}

              {showTime ? (
                <View style={styles.metaRow}>
                  <MaterialCommunityIcons name="clock-outline" size={META_ICON} color={tint.time} />
                  <Text style={[styles.meta, { color: tint.time }]} numberOfLines={1}>
                    {timeRangeLabel(b.startMin, b.endMin)}
                  </Text>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
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
