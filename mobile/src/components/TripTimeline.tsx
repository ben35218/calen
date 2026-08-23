import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator, Pressable, Animated } from 'react-native';
// Every label here sits inside a block whose height comes from the booking's
// duration, not its text — so all of it takes the tight cap (mobile/CLAUDE.md).
import { FixedText } from './Text';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { placesApi, TripItem, TravelMode } from '../api';
import { tripTypeMeta } from '../lib/tripTypes';
import { colorOf } from '../lib/calendar';
import { TRAVEL_MODES, travelModeLabel } from '../lib/travelModes';
import { tintedChip, withAlpha } from '../lib/color';
import { zonedParts, zonedTimeLabel } from '../lib/tz';
import { overnightLodging, lodgingCheckins, lodgingCheckouts } from '../lib/tripLodging';
import {
  DAY_MIN, PX_PER_MIN, packLanes, blockDetail, blockTitleLines, travelBandLabel, travelLead,
  hourLabel, timeLabel, timeRangeLabel, longPressDraft, snapSlot,
} from '../screens/calendar/dayview/dayViewLayout';
import { colors } from '../theme';

// A trip day's hour-by-hour itinerary: journey legs placed in their own zone,
// greedy lane-packing for overlaps, hour gridlines, and the travel between
// consecutive bookings computed via /places/route-leg.
//
// The blocks are the calendar day view's blocks (calendar.md → Day view), and
// deliberately so — a booking is an event on an hour grid, and there is no
// reason for a trip's 2 PM museum to read differently from Tuesday's 2 PM
// dentist. That means: title, then location, then the time range, each meta line
// led by its glyph and shown only when the block is tall enough to hold it
// (`blockDetail`), on a contrast-corrected tint of the booking type's color.
// The layout primitives come from the day view's own module rather than a second
// copy here (that module's lane-packing was itself ported out of this file).
//
// Travel is drawn the same way too: a leg extends the destination block UPWARD
// from its start, in a fainter wash with a dashed left edge, so the time spent
// getting there is visible on the grid AS time. Unlike a calendar event — whose
// travel time is a stored field — a trip's legs are computed between whatever
// bookings sit next to each other, so the band is tappable and cycles the mode
// (Drive → Walk → Transit → Bike); a leg that outruns the gap since the previous
// booking turns red, which is the itinerary telling you the plan doesn't fit.
//
// The gestures are the calendar's too: a tap opens the booking's view, a hold
// goes straight to its form. A block is overwhelmingly something you want to
// READ (when is dinner, where is it), and the calendar answers that with the
// event view — so the itinerary answers it the same way rather than dropping the
// reader into an edit form.
//
// The canvas is the day view's canvas: the whole 24 hours, midnight to midnight,
// at the same 1px = 1min scale with the same gutter labels. A grid cropped to
// the hours you had already booked couldn't show a 7 AM breakfast being added to
// a day that starts at 10, and read as a different amount of day depending on
// what was on it. Empty grid space takes a long-press, which drafts a one-hour
// booking in the pressed 15-minute slot — the calendar's gesture, with the trip
// form on the other end of it.

// The shortest a block is drawn. Taller than the calendar's 30-minute floor,
// and deliberately: it's the height at which `blockDetail` says 'full', so even
// a 15-minute booking (and a journey's point-in-time departure marker) carries
// its location. A trip day holds a handful of bookings rather than a working
// day's worth, so the stretch costs nothing that a packed grid couldn't spare.
const MIN_BLOCK = 56;
const GUTTER = 48; // left hour-label gutter
// The block fill's tint alpha, fed to the shared palette so the text on it is
// contrast-corrected against the real fill. Matches the day view.
const FILL_ALPHA = 0.18;
const TRAVEL_ALPHA = 0.06;
const META_ICON = 11;
// The shortest a travel band is drawn, whatever the leg actually takes. At
// 1px = 1min a five-minute hop between two places in the same town is a 5px
// sliver with no room for its own label — the band is there, and says nothing.
// So a short leg is drawn at the height its label needs (and reserves that much
// in the lane packer, so the drawing and the layout agree). The *drawing* rounds
// up; the number never does — the label still reads the true minutes.
const MIN_TRAVEL_BAND = 18;
// Breathing room around the 24h canvas, so midnight's rule and a block ending at
// 11:59 PM aren't flush against the cards above and below.
const TOP_PAD = 8;
const BOTTOM_PAD = 24;
// How long the long-press ghost holds before the form pushes — long enough for
// the eye to register where the draft landed, short enough to read as one
// motion (the day view's number, deliberately the same gesture).
const GHOST_HOLD_MS = 250;

const isJourney = (it: TripItem) => it.type === 'flight' || it.type === 'transit';
const hasZones = (it: TripItem) => {
  const d = it.details as any;
  return isJourney(it) && (d?.departureTz || d?.arrivalTz);
};

type Seg = {
  key: string;
  item: TripItem;
  startMin: number;
  endMin: number;
  title: string;
  subtitle: string;
  // Glyph leading the subtitle line. The default pin fits a place ("163
  // Spadina Ave", "Depart YYZ"); a lodging block's line names an action
  // ("Check in"), so it carries a doorway glyph instead.
  subtitleIcon?: string;
  timeLabel: string;
  journeyId: string | null;
  anchorPlaceId: string;
  anchorAddress: string;
  anchorTz: string;
  startInstant: string;
  endInstant: string;
};

type LegResult = { minutes: number } | null | { error: true };

// One computed hop into a booking: which segment it lands on, the mode it was
// computed for, and how much clock there actually is between the two bookings.
type Leg = {
  segKey: string;
  baseKey: string;   // origin|destination, mode-independent (the cycling key)
  key: string;       // baseKey|mode — one fetched result per mode
  mode: TravelMode;
  origin: { placeId: string; address: string };
  dest: { placeId: string; address: string };
  departAt: string;
  gapMin: number | null;
  // The day's opening hop out of the night's lodging (no booking before it).
  fromLodging?: boolean;
};

function refKey(placeId: string, address: string) {
  return placeId ? `place:${placeId}` : address ? `addr:${address.toLowerCase().trim()}` : null;
}
const modeIcon = (mode: TravelMode) => TRAVEL_MODES.find((m) => m.value === mode)?.icon ?? 'car';

// A long-press draft: the wall-clock the booking form should open on, in the
// trip's destination timezone (`endDate` only when the hour pressed rolls the
// end past midnight).
export type TimelineDraft = { startTime: string; endTime: string; endDate?: string };

export default function TripTimeline({
  items,
  selectedDate,
  tz,
  accent = colorOf('trips'),
  onOpenItem,
  onEditItem,
  onCreateAt,
  onInitialScroll,
}: {
  items: TripItem[];
  selectedDate: string;
  tz: string;
  accent?: string;
  // Tap a block — the booking's view (the calendar's tap-a-chip).
  onOpenItem: (itemId: string) => void;
  // Hold a block — straight into the booking form (the calendar's hold-a-chip).
  onEditItem: (itemId: string) => void;
  // Long-press on empty grid space. Omitted → the grid is read-only.
  onCreateAt?: (draft: TimelineDraft) => void;
  // Where the day should open, in px down the timeline: the first booking (or
  // the now-line on today, or 8 AM on an empty day). The grid is a full 24h
  // tall, so without this a day would open at midnight.
  onInitialScroll?: (offsetY: number) => void;
}) {
  const navigation = useNavigation();
  const [width, setWidth] = useState(0);
  const [legModes, setLegModes] = useState<Record<string, TravelMode>>({});
  const [legResults, setLegResults] = useState<Record<string, LegResult>>({});

  // A booking's own line, in the destination's timezone: the day view's compact
  // range ("2 – 4PM"), because that is all the width a block has. A journey leg
  // is the exception — its two ends are in different zones, so those labels keep
  // the zone name (`zonedTimeLabel`) and say which clock they mean.
  const bookingTimeLabel = (startMin: number, endMin: number | null) =>
    endMin != null && endMin > startMin ? timeRangeLabel(startMin, endMin) : timeLabel(startMin);

  // ── Day segments (journey legs by zone; others in destination tz) ──
  const segs = useMemo(() => {
    const out: Seg[] = [];
    for (const i of items) {
      if (i.type === 'hotel') continue;
      const d = i.details as any;
      if (hasZones(i)) {
        const dep = zonedParts(i.start, d.departureTz);
        if (dep.dateStr === selectedDate) {
          const place = d.departureName || d.from;
          out.push({
            key: `${i._id}-dep`, item: i, startMin: dep.minutes, endMin: dep.minutes + MIN_BLOCK,
            title: i.title, subtitle: place ? `Depart ${place}` : 'Departure',
            timeLabel: zonedTimeLabel(i.start, d.departureTz), journeyId: i._id,
            anchorPlaceId: d.departurePlaceId || '', anchorAddress: d.departureName || '', anchorTz: d.departureTz || '',
            startInstant: i.start, endInstant: i.start,
          });
        }
        if (i.end) {
          const arr = zonedParts(i.end, d.arrivalTz);
          if (arr.dateStr === selectedDate) {
            const place = d.arrivalName || d.to;
            out.push({
              key: `${i._id}-arr`, item: i, startMin: arr.minutes, endMin: arr.minutes + MIN_BLOCK,
              title: i.title, subtitle: place ? `Arrive ${place}` : 'Arrival',
              timeLabel: zonedTimeLabel(i.end, d.arrivalTz), journeyId: i._id,
              anchorPlaceId: d.arrivalPlaceId || '', anchorAddress: d.arrivalName || '', anchorTz: d.arrivalTz || '',
              startInstant: i.end, endInstant: i.end,
            });
          }
        }
      } else {
        // An all-day booking has no hour to sit at — a midnight block would be
        // the grid asserting a time the user never entered. The day view's
        // banner strip (TripDetailScreen) carries it instead.
        if (i.allDay) continue;
        const sp = zonedParts(i.start, tz);
        if (sp.dateStr !== selectedDate) continue;
        const s = sp.minutes;
        const rawEnd = i.end ? zonedParts(i.end, tz).minutes : null;
        const e = rawEnd != null ? Math.max(rawEnd, s + MIN_BLOCK) : s + MIN_BLOCK;
        out.push({
          key: i._id, item: i, startMin: s, endMin: e, title: i.title, subtitle: i.location || '',
          timeLabel: bookingTimeLabel(s, rawEnd), journeyId: null,
          anchorPlaceId: (i as any).placeId || '', anchorAddress: i.location || (i as any).address || '', anchorTz: tz,
          startInstant: i.start, endInstant: i.end || i.start,
        });
      }
    }
    // Check-in and check-out are on the grid as their own blocks: reaching or
    // leaving the hotel is a scheduled thing the day has to fit around, and as
    // segments anchored at the hotel's address they hand the neighbouring
    // bookings their travel legs to/from the hotel through the ordinary
    // consecutive-leg rule — no special-cased origins.
    const lodgeSeg = (h: TripItem, instant: string, label: string, keySuffix: string): Seg => {
      const at = zonedParts(instant, tz);
      return {
        key: `${h._id}-${keySuffix}`, item: h, startMin: at.minutes, endMin: at.minutes + MIN_BLOCK,
        title: h.title, subtitle: label,
        // In through the door / out through the door — the pin would claim
        // this line is a place.
        subtitleIcon: keySuffix === 'checkin' ? 'login-variant' : 'logout-variant',
        timeLabel: bookingTimeLabel(at.minutes, null),
        journeyId: null,
        anchorPlaceId: (h as any).placeId || '', anchorAddress: h.location || '', anchorTz: tz,
        startInstant: instant, endInstant: instant,
      };
    };
    for (const h of lodgingCheckins(items, selectedDate, tz)) out.push(lodgeSeg(h, h.start, 'Check in', 'checkin'));
    for (const h of lodgingCheckouts(items, selectedDate, tz)) out.push(lodgeSeg(h, h.end!, 'Check out', 'checkout'));
    return out.sort((a, b) => a.startMin - b.startMin);
  }, [items, selectedDate, tz]);

  // ── Travel legs ──
  // Between consecutive segments, skipping the two halves of one journey (you
  // don't drive from your departure gate to your arrival gate) and any hop that
  // starts and ends at the same place. The day's first segment gets its leg
  // from the hotel the user woke up at (check-in strictly before this day) —
  // unless the day opens on a journey's ARRIVAL, where the night was spent in
  // transit, not at the lodging.
  const legs = useMemo(() => {
    const out: Leg[] = [];
    const first = segs[0];
    const firstIsArrival = !!first?.journeyId && first.key.endsWith('-arr');
    // Check-in day needs no case of its own: the check-in block is a segment,
    // so a booking after check-in gets its leg out of the hotel from it — and
    // one before check-in correctly gets nothing.
    const hotel = first && !firstIsArrival ? overnightLodging(items, selectedDate, tz) : null;
    if (first && hotel) {
      const oKey = refKey((hotel as any).placeId || '', hotel.location || '');
      const dKey = refKey(first.anchorPlaceId, first.anchorAddress);
      if (oKey && dKey && oKey !== dKey) {
        const baseKey = `${oKey}|${dKey}`;
        const mode = legModes[baseKey] || 'DRIVE';
        out.push({
          segKey: first.key, baseKey, mode, key: `${baseKey}|${mode}`,
          origin: { placeId: (hotel as any).placeId || '', address: hotel.location || '' },
          dest: { placeId: first.anchorPlaceId, address: first.anchorAddress },
          // There is no prior booking whose end anchors the departure; the
          // first booking's start is close enough for a transit schedule.
          departAt: first.startInstant,
          gapMin: null,
          fromLodging: true,
        });
      }
    }
    for (let i = 1; i < segs.length; i++) {
      const A = segs[i - 1];
      const B = segs[i];
      if (A.journeyId && A.journeyId === B.journeyId) continue;
      const oKey = refKey(A.anchorPlaceId, A.anchorAddress);
      const dKey = refKey(B.anchorPlaceId, B.anchorAddress);
      if (!oKey || !dKey || oKey === dKey) continue;
      const baseKey = `${oKey}|${dKey}`;
      const mode = legModes[baseKey] || 'DRIVE';
      out.push({
        segKey: B.key, baseKey, mode, key: `${baseKey}|${mode}`,
        origin: { placeId: A.anchorPlaceId, address: A.anchorAddress },
        dest: { placeId: B.anchorPlaceId, address: B.anchorAddress },
        departAt: A.endInstant,
        gapMin: Math.round((+new Date(B.startInstant) - +new Date(A.endInstant)) / 60000),
      });
    }
    return out;
  }, [segs, legModes, items, selectedDate, tz]);

  // Fetch route legs (server-cached in TravelLeg; one result per mode).
  useEffect(() => {
    legs.forEach((l) => {
      if (l.key in legResults) return;
      setLegResults((r) => ({ ...r, [l.key]: null }));
      placesApi
        .routeLeg({
          originPlaceId: l.origin.placeId || undefined,
          originAddress: l.origin.address || undefined,
          destPlaceId: l.dest.placeId || undefined,
          destAddress: l.dest.address || undefined,
          mode: l.mode,
          departureTime: l.departAt || undefined,
        })
        .then((res) => {
          const min = (res.data as any)?.minutes ?? null;
          setLegResults((r) => ({ ...r, [l.key]: min != null ? { minutes: min } : { error: true } }));
        })
        .catch(() => setLegResults((r) => ({ ...r, [l.key]: { error: true } })));
    });
  }, [legs]);

  // The resolved leg per destination segment — what the block draws as its band.
  // Only a leg with real minutes has a height to draw; one still loading, or
  // with no route for the chosen mode, keeps the compact chip instead so the
  // mode stays switchable (a mode with no coverage must not strand the user
  // with nothing to tap). A zero-minute leg is the same place twice: nothing to
  // show either way.
  const travel = useMemo(() => {
    const map: Record<string, { minutes: number; leg: Leg; tight: boolean }> = {};
    for (const l of legs) {
      const res = legResults[l.key];
      if (!res || !('minutes' in res) || !res.minutes) continue;
      map[l.segKey] = { minutes: res.minutes, leg: l, tight: l.gapMin != null && res.minutes > l.gapMin };
    }
    return map;
  }, [legs, legResults]);

  // The chip's leg for a segment: one that hasn't resolved into a band and
  // didn't resolve to "same place".
  const chipLeg = (segKey: string): Leg | undefined => {
    if (travel[segKey]) return undefined;
    const l = legs.find((x) => x.segKey === segKey);
    if (!l) return undefined;
    const res = legResults[l.key];
    return res && 'minutes' in res && !res.minutes ? undefined : l;
  };

  // ── Layout ──
  // The day view's lane packer: a block's span starts at its DEPARTURE, so a
  // travel band collides with whatever it overlaps like any other occupied time.
  const laid = useMemo(() => {
    const bySeg = new Map(segs.map((s) => [s.key, s]));
    return packLanes(
      segs.map((s) => ({
        key: s.key,
        title: s.title,
        location: s.subtitle,
        color: tripTypeMeta(s.item.type).color,
        startMin: s.startMin,
        endMin: Math.max(s.endMin, s.startMin + MIN_BLOCK),
        eventId: s.item._id,
        // Drawn (and packed) at the label's minimum when the leg is shorter than
        // that — see MIN_TRAVEL_BAND. The booking's body still starts at its
        // true time; it's the lead-in above it that gets the floor.
        ...(travel[s.key] ? { travelMinutes: Math.max(travel[s.key].minutes, MIN_TRAVEL_BAND) } : null),
      })),
    ).map((b) => ({ b, seg: bySeg.get(b.key)! }));
  }, [segs, travel]);

  const height = TOP_PAD + DAY_MIN * PX_PER_MIN + BOTTOM_PAD;

  // Where the day opens. Reported once per date, since it answers "what should
  // be under the reader's eye when this day appears", not "where are they now".
  const reportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!onInitialScroll || reportedFor.current === selectedDate) return;
    reportedFor.current = selectedDate;
    // "Today" and "now" on the destination's clock — the one the grid renders
    // in (the UTC/device clock can sit on a different date entirely).
    const nowParts = zonedParts(new Date(), tz);
    const anchorMin = laid.length
      ? Math.min(...laid.map(({ b }) => b.startMin - travelLead(b)))
      : selectedDate === nowParts.dateStr ? nowParts.minutes : 8 * 60;
    onInitialScroll(Math.max(0, TOP_PAD + (anchorMin - 30) * PX_PER_MIN));
  }, [selectedDate, laid, onInitialScroll, tz]);

  function cycleMode(baseKey: string, current: TravelMode) {
    const idx = TRAVEL_MODES.findIndex((m) => m.value === current);
    setLegModes((m) => ({ ...m, [baseKey]: TRAVEL_MODES[(idx + 1) % TRAVEL_MODES.length].value }));
  }

  // ── Long-press → new booking ──
  // The ghost outlives the push — behind the form it reads as the booking being
  // created — and fades once the itinerary regains focus: the saved booking has
  // taken its place, or nothing has if the form was cancelled.
  const [ghost, setGhost] = useState<{ startMin: number; endMin: number } | null>(null);
  const ghostAnim = useRef(new Animated.Value(0)).current;
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (navTimer.current) clearTimeout(navTimer.current); }, []);
  useEffect(() => {
    if (!ghost) return;
    return navigation.addListener('focus', () => {
      Animated.timing(ghostAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setGhost(null));
    });
  }, [ghost, navigation, ghostAnim]);

  const startDraft = (y: number) => {
    if (!onCreateAt || navTimer.current) return; // a push is already mid-flight
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setGhost(snapSlot(y - TOP_PAD));
    ghostAnim.setValue(0);
    Animated.spring(ghostAnim, { toValue: 1, speed: 24, bounciness: 6, useNativeDriver: true }).start();
    const { allDay, ...draft } = longPressDraft(selectedDate, y - TOP_PAD);
    navTimer.current = setTimeout(() => {
      navTimer.current = null;
      onCreateAt(draft);
    }, GHOST_HOLD_MS);
  };

  const ghostTint = tintedChip(accent, FILL_ALPHA);
  const inner = Math.max(0, width - GUTTER);

  return (
    <View style={[styles.timeline, { height }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {Array.from({ length: 25 }, (_, h) => (
        <View key={h} style={[styles.hourLine, { top: TOP_PAD + h * 60 * PX_PER_MIN - 7 }]}>
          <FixedText style={styles.hourLabel}>{h < 24 ? hourLabel(h) : ''}</FixedText>
          <View style={styles.hourRule} />
        </View>
      ))}

      {/* Empty grid space drafts a booking at the hour pressed. Blocks sit on
          top and claim their own touches, so only bare canvas triggers it; a
          scroll or a swipe cancels the press like any touchable. */}
      <Pressable
        testID="trip-timeline-canvas"
        accessible={false}
        style={[styles.canvas, { top: TOP_PAD, height: DAY_MIN * PX_PER_MIN }]}
        onLongPress={(e) => startDraft(e.nativeEvent.locationY + TOP_PAD)}
      />

      {width > 0 &&
        laid.map(({ b, seg }) => {
          const meta = tripTypeMeta(seg.item.type);
          const tint = tintedChip(meta.color, FILL_ALPHA);
          const left = GUTTER + b.leftFrac * inner;
          const blockW = Math.max(40, b.widthFrac * inner - 6);
          const travelH = b.travelHeight;
          const bodyHeight = Math.max(26, b.height - travelH);
          const detail = blockDetail(bodyHeight);
          const hop = travel[seg.key];
          const bandLabel = travelH ? travelBandLabel(hop?.minutes ?? 0, travelH) : null;
          // A booking sealed under a key this device doesn't hold has no title;
          // name it by what it is rather than rendering an empty block. Blank
          // counts as no title — a block labelled with a space is the same
          // unreadable block, just harder to explain.
          const title = seg.title?.trim() || meta.label;
          const pending = chipLeg(seg.key);

          return (
            <TouchableOpacity
              key={seg.key}
              activeOpacity={0.8}
              // Tap reads the booking, hold edits it — the calendar's own pair of
              // gestures on an event chip. A tap that opened the form meant every
              // glance at a booking landed in a screen full of fields.
              onPress={() => onOpenItem(seg.item._id)}
              onLongPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                onEditItem(seg.item._id);
              }}
              style={[styles.block, {
                top: TOP_PAD + b.top,
                height: travelH + bodyHeight,
                left,
                width: blockW,
              }]}
            >
              {travelH ? (
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => cycleMode(hop!.leg.baseKey, hop!.leg.mode)}
                  accessibilityLabel={`${travelModeLabel(hop!.leg.mode)} ${hop!.minutes} minutes from ${hop!.leg.fromLodging ? 'your hotel' : 'the previous booking'}${hop!.tight ? ' — longer than the time between them' : ''}. Tap to change how you're getting there.`}
                  style={[
                    styles.travelBand,
                    {
                      height: travelH,
                      backgroundColor: hop!.tight ? TIGHT_BG : withAlpha(meta.color, TRAVEL_ALPHA),
                      borderLeftColor: hop!.tight ? TIGHT : withAlpha(meta.color, 0.4),
                    },
                  ]}
                >
                  <View style={styles.travelRow}>
                    <MaterialCommunityIcons
                      name={modeIcon(hop!.leg.mode) as any}
                      size={META_ICON}
                      color={hop!.tight ? TIGHT : tint.time}
                    />
                    {bandLabel ? (
                      <FixedText
                        style={[styles.travelText, { color: hop!.tight ? TIGHT : tint.time }]}
                        numberOfLines={1}
                      >
                        {bandLabel}
                      </FixedText>
                    ) : null}
                    {hop!.tight ? <Ionicons name="alert" size={META_ICON} color={TIGHT} /> : null}
                  </View>
                </TouchableOpacity>
              ) : null}

              <View
                style={[
                  styles.body,
                  { backgroundColor: tint.fill, borderLeftColor: meta.color },
                  // The line where the travelling stops and the booking starts.
                  travelH ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: withAlpha(meta.color, 0.55) } : null,
                ]}
              >
                <View style={styles.blockHead}>
                  <MaterialCommunityIcons name={meta.icon as any} size={META_ICON} color={meta.color} />
                  <FixedText style={[styles.title, { color: tint.label }]} numberOfLines={blockTitleLines(bodyHeight)}>
                    {title}
                  </FixedText>
                  {seg.item.confirmed ? <Ionicons name="checkmark-circle" size={10} color="#2E7D32" /> : null}
                </View>

                {detail === 'full' && seg.subtitle ? (
                  <View style={styles.metaRow}>
                    <MaterialCommunityIcons name={(seg.subtitleIcon ?? 'map-marker-outline') as any} size={META_ICON} color={tint.time} />
                    <FixedText style={[styles.meta, { color: tint.time }]} numberOfLines={1}>{seg.subtitle}</FixedText>
                  </View>
                ) : null}

                {detail !== 'compact' ? (
                  <View style={styles.metaRow}>
                    <MaterialCommunityIcons name="clock-outline" size={META_ICON} color={tint.time} />
                    <FixedText style={[styles.meta, { color: tint.time }]} numberOfLines={1}>{seg.timeLabel}</FixedText>
                  </View>
                ) : null}
              </View>

              {/* Still computing, or no route for the chosen mode: a chip on the
                  block's leading edge, so the mode stays switchable (a mode with
                  no coverage must not strand the user with nothing to tap). */}
              {pending ? (
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => cycleMode(pending.baseKey, pending.mode)}
                  style={styles.pill}
                >
                  {legResults[pending.key] === null || legResults[pending.key] === undefined ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <>
                      <MaterialCommunityIcons name={modeIcon(pending.mode) as any} size={META_ICON} color={colors.textMuted} />
                      <FixedText style={styles.pillText}>—</FixedText>
                    </>
                  )}
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>
          );
        })}

      {ghost && width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.block,
            {
              top: TOP_PAD + ghost.startMin * PX_PER_MIN,
              // A last-hour ghost clips at the grid's end like any block; its
              // range line still names the true midnight-crossing end.
              height: (Math.min(ghost.endMin, DAY_MIN) - ghost.startMin) * PX_PER_MIN,
              left: GUTTER,
              width: Math.max(40, inner - 6),
              opacity: ghostAnim,
              transform: [{ scale: ghostAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }],
            },
          ]}
        >
          <View style={[styles.body, { backgroundColor: ghostTint.fill, borderLeftColor: accent }]}>
            <View style={styles.blockHead}>
              <MaterialCommunityIcons name="plus" size={META_ICON} color={accent} />
              <FixedText style={[styles.title, { color: ghostTint.label }]} numberOfLines={1}>New Booking</FixedText>
            </View>
            <View style={styles.metaRow}>
              <MaterialCommunityIcons name="clock-outline" size={META_ICON} color={ghostTint.time} />
              <FixedText style={[styles.meta, { color: ghostTint.time }]} numberOfLines={1}>
                {timeRangeLabel(ghost.startMin, ghost.endMin)}
              </FixedText>
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

// The "you can't get there in time" red, shared by the band's edge, glyph and
// label (the same alarm color the out-of-range bookings list uses).
const TIGHT = '#C62828';
const TIGHT_BG = withAlpha(TIGHT, 0.1);

const styles = StyleSheet.create({
  timeline: { position: 'relative', marginTop: 8 },
  hourLine: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: GUTTER - 6, textAlign: 'right', fontSize: 11, color: colors.textMuted, marginRight: 6 },
  hourRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  canvas: { position: 'absolute', left: GUTTER, right: 0 },
  block: { position: 'absolute', borderRadius: 6, overflow: 'hidden' },
  travelBand: { justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 1, borderLeftWidth: 3 },
  travelRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  travelText: { flex: 1, fontSize: 10, lineHeight: 11, fontWeight: '600' },
  body: { flex: 1, borderLeftWidth: 3, paddingHorizontal: 4, paddingVertical: 3 },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  title: { flex: 1, fontSize: 12, lineHeight: 15, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  meta: { flex: 1, fontSize: 11, lineHeight: 13 },
  pill: {
    position: 'absolute', top: 2, left: 5, flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, zIndex: 10,
  },
  pillText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
});
