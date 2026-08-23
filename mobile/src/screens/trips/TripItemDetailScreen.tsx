import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert, Linking, ActivityIndicator } from 'react-native';
import { Text } from '../../components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, settingsApi, TripItem, TripItemAttachment } from '../../api';
import { Screen, ScreenTitle, SectionTitle, Card, CardRow, FormError, HeaderTextButton, SkeletonDetail, Select } from '../../components/ui';
import { CardDivider } from '../../components/formStyles';
import LocationCard from '../../components/LocationCard';
import CustomAlertSheet from '../../components/CustomAlertSheet';
import { fetchTripDetail, sealTripItemPayload, tripItemSharingEcho } from '../../lib/tripData';
import { buildBookingAlertItems } from '../../lib/tripAlerts';
import { CUSTOM_ALERT, alertKey, excludeUsedAlertKey } from '../../lib/eventAlertOptions';
import { DEFAULT_DAY_ALERT_TIME, promoteSecondAlert } from '../../lib/calendar';
import { openTripAttachment } from '../../lib/tripAttachments';
import { tripTypeMeta, tripSharingLabel } from '../../lib/tripTypes';
import { formatDisplay } from '../../lib/phone';
import { zonedParts } from '../../lib/tz';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing, radius } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripItemDetail'>;
type Rt = RouteProp<TripsStackParamList, 'TripItemDetail'>;

// A booking's view — what the calendar's event view is to an event (calendar.md
// → Event view), for a trip's itinerary. Tapping a block on the day grid lands
// here to READ the booking; holding it goes straight to the form, which is the
// same pair of gestures the month grid's event chips answer. Opening a booking
// you only wanted to check used to mean landing in a form full of fields.
//
// Everything here is sealed content, so it reads through the shared decrypting
// fetcher on the shared `['trips', id]` key (lib/tripData) rather than fetching
// the booking on its own — see the note there about a per-screen plaintext
// queryFn blanking whichever screen mounted first.
//
// There is no mini hour-grid card as on the event view: a booking is always
// reached FROM the day's hour grid, which just showed it in place.

// "2:00 PM" in a specific zone (the destination's, or a journey leg's own).
function clock(instant: string, zone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', hour12: true, ...(zone ? { timeZone: zone } : null),
  }).format(new Date(instant));
}
// "Fri, Aug 22, 2026" from a yyyy-MM-dd date string (noon, so no zone shifts it).
function dayLabel(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}
// The zone's short name ("EDT") — named only on a journey, whose two ends sit in
// different zones and would otherwise read as one impossible timeline.
function zoneName(instant: string, zone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

const isJourney = (it: TripItem) => it.type === 'flight' || it.type === 'transit';
// Sharing modes where the cost on the booking is this household's own bill.
const PRIVATE_BILL = ['shared_separate', 'shared_one_separate'];

export default function TripItemDetailScreen() {
  const navigation = useNavigation<Nav>();
  const { tripId, itemId, date } = useRoute<Rt>().params;
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  // Whether the location map imagery loaded — the floating Delete pill sits over
  // it (Apple-style) and needs the page to end in something.
  const [mapAvailable, setMapAvailable] = useState(true);

  const tripQ = useQuery({ queryKey: ['trips', tripId], queryFn: () => fetchTripDetail(tripId) });
  const trip = tripQ.data?.trip;
  const item = tripQ.data?.items?.find((x) => x._id === itemId);
  const tz = trip?.destinationTz || '';
  const meta = tripTypeMeta(item?.type);
  const details = (item?.details ?? {}) as Record<string, any>;

  // A booking sealed under a key this device doesn't hold has no title; name it
  // by what it is rather than heading the page with nothing (the day grid's rule).
  const title = item?.title || meta.label;

  const edit = () => navigation.navigate('TripItemForm', { tripId, itemId, date });

  useEffect(() => {
    navigation.setOptions({
      // Named by what it is once it's open; "Booking" until then, rather than
      // flashing the fallback type of a booking that hasn't decrypted yet.
      title: item ? meta.label : 'Booking',
      // The detail-screen edit action is the iOS text button (mobile/CLAUDE.md),
      // same word the trip header above it edits with.
      headerRight: () => <HeaderTextButton title="Edit" onPress={edit} accessibilityLabel="Edit booking" />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, tripId, itemId, date, item, meta.label]);

  // One exit, however it's reached: the booking can vanish under this screen —
  // deleted from the form pushed on top of it, or from another device — and a
  // page about nothing is worse than the day it was opened from. The guard keeps
  // our own delete from popping twice (its onSuccess and this effect both fire).
  const leavingRef = useRef(false);
  const leave = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    navigation.goBack();
  };
  useEffect(() => {
    if (tripQ.data && !item) leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripQ.data, item]);

  // When it happens, in the zone the booking is kept in. A journey's two ends are
  // in different zones and get their own lines with the zone named; a hotel reads
  // as check-in / check-out; everything else is one line in the destination's
  // timezone, the clock the itinerary renders in. An ALL-DAY booking has dates
  // and no clocks — its lines are day labels alone.
  const when = useMemo(() => {
    if (!item) return [];
    const depTz = details.departureTz || tz;
    const arrTz = details.arrivalTz || tz;
    if (isJourney(item) && (details.departureTz || details.arrivalTz)) {
      const dep = zonedParts(item.start, depTz);
      const lines = [
        `Departs ${dayLabel(dep.dateStr)}, ${clock(item.start, depTz)} ${zoneName(item.start, depTz)}`.trim(),
      ];
      if (item.end) {
        const arr = zonedParts(item.end, arrTz);
        lines.push(`Arrives ${dayLabel(arr.dateStr)}, ${clock(item.end, arrTz)} ${zoneName(item.end, arrTz)}`.trim());
      }
      return lines;
    }
    const start = zonedParts(item.start, tz);
    if (item.allDay) {
      if (item.type === 'hotel') {
        const lines = [`Check in ${dayLabel(start.dateStr)}`];
        if (item.end) lines.push(`Check out ${dayLabel(zonedParts(item.end, tz).dateStr)}`);
        return lines;
      }
      const endDay = item.end ? zonedParts(item.end, tz).dateStr : start.dateStr;
      return endDay === start.dateStr
        ? [`All day, ${dayLabel(start.dateStr)}`]
        : [`All day, ${dayLabel(start.dateStr)}`, `to ${dayLabel(endDay)}`];
    }
    if (item.type === 'hotel') {
      const lines = [`Check in ${dayLabel(start.dateStr)}, ${clock(item.start, tz)}`];
      if (item.end) {
        const end = zonedParts(item.end, tz);
        lines.push(`Check out ${dayLabel(end.dateStr)}, ${clock(item.end, tz)}`);
      }
      return lines;
    }
    if (!item.end) return [`${dayLabel(start.dateStr)}, ${clock(item.start, tz)}`];
    const end = zonedParts(item.end, tz);
    return end.dateStr === start.dateStr
      ? [`${dayLabel(start.dateStr)}, ${clock(item.start, tz)} – ${clock(item.end, tz)}`]
      : [`${dayLabel(start.dateStr)}, ${clock(item.start, tz)}`, `to ${dayLabel(end.dateStr)}, ${clock(item.end, tz)}`];
  }, [item, tz, details]);

  // Cost is the household's own on a per-family bill, the booking's otherwise —
  // the same reading the form seeds its Cost field with.
  const cost = item?.myData?.cost ?? item?.cost ?? null;
  const confirmation = item?.myData?.confirmation || item?.confirmation || '';
  const confirmed = item?.sharing === 'shared_separate' ? !!item?.myData?.confirmed : !!item?.confirmed;

  // ── Alerts, managed in place ────────────────────────────────────────────────
  // The event view's pattern (calendar.md → Alerts): the Alert / Second alert
  // rows are live pickers writing straight to the booking, so setting or
  // clearing one doesn't mean a trip through the edit form. Held in local state
  // so a pick lands on the row instantly — the write is a reseal plus a refetch
  // behind it, and a row that only caught up after that round trip read as a
  // tap that did nothing.
  type AlertPair = { reminderMinutes: number | null; alert2Minutes: number | null };
  const [alerts, setAlerts] = useState<AlertPair | null>(null);
  // Which slot the Custom… wheel sheet is editing (null = closed).
  const [customFor, setCustomFor] = useState<'reminderMinutes' | 'alert2Minutes' | null>(null);
  // Set while our own write is in flight, so the re-seed below doesn't stomp
  // the value the user just picked with a concurrent refetch's pre-write copy.
  const writingRef = useRef(false);

  useEffect(() => {
    if (!item || writingRef.current) return;
    // A booking holding only a SECOND alert opens with it in the first slot —
    // the second row renders only while a first exists.
    const p = promoteSecondAlert({
      reminderMinutes: item.reminderMinutes ?? null,
      alert2Minutes: item.alert2Minutes ?? null,
    });
    setAlerts({ reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes });
  }, [item]);

  // The hour an all-day booking's alerts fire at — labels its picker rows,
  // same account-level default the form and the event surfaces read.
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: async () => (await settingsApi.get()).data });
  const dayAlertTime = settingsQ.data?.dayAlertTime || DEFAULT_DAY_ALERT_TIME;

  const alertItems = useMemo(
    () =>
      buildBookingAlertItems({
        type: item?.type,
        allDay: !!item?.allDay,
        dayAlertTime,
        reminderMinutes: alerts?.reminderMinutes ?? null,
        alert2Minutes: alerts?.alert2Minutes ?? null,
      }),
    [item?.type, item?.allDay, dayAlertTime, alerts],
  );

  const tripShared = !!((trip?.sharedWithOutside?.length ?? 0) > 0 || (trip?.collaborators?.length ?? 0) > 0);

  // Reseal the booking's content with the new pair. The alert fields live
  // inside `enc`, so the write re-seals the whole sealed content from the
  // decrypted item — and must echo the sharing branch (tripItemSharingEcho),
  // because the item route rebuilds cost-sharing from every PUT body.
  const saveAlerts = useMutation({
    mutationFn: async (next: AlertPair) => {
      writingRef.current = true;
      const it = item!;
      const payload: Record<string, unknown> = {
        ...tripItemSharingEcho(it),
        title: it.title, location: it.location, placeId: it.placeId, url: it.url, phone: it.phone, notes: it.notes, details: it.details,
        // allDay is sealed content too — a reseal that omitted it would strip
        // the flag off the booking.
        allDay: it.allDay || undefined,
        reminderMinutes: next.reminderMinutes ?? undefined,
        // The form's rule, enforced on this surface too: a second alert without
        // a first is an alert the user can neither see nor edit.
        alert2Minutes: next.reminderMinutes !== null && next.alert2Minutes !== null ? next.alert2Minutes : undefined,
      };
      return tripsApi.updateItem(tripId, itemId, await sealTripItemPayload(tripId, tripShared, itemId, payload, false));
    },
    onSuccess: () => {
      // The reminder scheduler watches ['trips'] invalidations, which is what
      // makes the alert the user just set real (hooks/useReminderScheduler).
      qc.invalidateQueries({ queryKey: ['trips', tripId] });
    },
    onError: (e: any) => {
      // Put the rows back to what the booking still says rather than leaving
      // them showing an alert that was never stored.
      if (item) {
        const p = promoteSecondAlert({
          reminderMinutes: item.reminderMinutes ?? null,
          alert2Minutes: item.alert2Minutes ?? null,
        });
        setAlerts({ reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes });
      }
      Alert.alert('Couldn’t save the alert', e?.response?.data?.error || 'Please try again.');
    },
    onSettled: () => { writingRef.current = false; },
  });

  // Show the pick, then write it.
  const applyAlerts = (next: AlertPair) => {
    setAlerts(next);
    saveAlerts.mutate(next);
  };

  const attachments: TripItemAttachment[] = item?.attachments ?? [];
  const openAttachment = useMutation({
    mutationFn: (att: TripItemAttachment) => openTripAttachment(tripId, itemId, att),
    onError: (e: any) => Alert.alert('Could not open attachment', e?.message || 'Please try again.'),
  });

  const del = useMutation({
    mutationFn: () => tripsApi.removeItem(tripId, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trips', tripId] });
      leave();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not delete this booking'),
  });

  const openInMaps = () => {
    const place = item?.location || details.departureName || '';
    if (!place) return;
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`);
  };

  const confirmDelete = () =>
    Alert.alert('Delete booking?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);

  // The fetch is genuinely visible on an uncached open (a deep link, a cold
  // start), so hold the page's shape rather than spinning.
  if (tripQ.isLoading) return <SkeletonDetail />;
  if (!item) {
    // Either the trip wouldn't load, or the booking is gone and the effect above
    // is already popping this screen.
    return <Screen>{tripQ.isError ? <FormError>Could not load this booking.</FormError> : null}</Screen>;
  }

  // Journey rows name the leg; a standard booking's location is its own line
  // under the title, as on the event view.
  const journey = isJourney(item) && (details.departureTz || details.arrivalTz || details.departureName || details.arrivalName);
  const mapPlace = item.location || details.departureName || '';

  return (
    <View style={styles.root}>
      <Screen style={{ paddingBottom: insets.bottom + 96 }}>
        <ScreenTitle>{title}</ScreenTitle>

        <View style={styles.typeRow}>
          <View style={[styles.typePill, { backgroundColor: `${meta.color}22` }]}>
            <MaterialCommunityIcons name={meta.icon as any} size={14} color={meta.color} />
            <Text style={[styles.typeText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <View style={styles.bookedPill}>
            <Ionicons
              name={confirmed ? 'checkmark-circle' : 'ellipse-outline'}
              size={14}
              color={confirmed ? colors.success : colors.textMuted}
            />
            <Text style={[styles.bookedText, confirmed && { color: colors.success }]}>
              {confirmed ? 'Booked' : 'Not booked yet'}
            </Text>
          </View>
        </View>

        {item.location ? (
          <TouchableOpacity onPress={openInMaps} activeOpacity={0.7}>
            <Text style={[styles.location, { color: meta.color }]}>{item.location}</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.whenBlock}>
          {when.map((line) => (
            <Text key={line} style={styles.when}>{line}</Text>
          ))}
          {tz && !journey && !item.allDay ? <Text style={styles.tzNote}>Times are local to {tz}</Text> : null}
        </View>

        <View style={styles.rows}>
          {journey ? (
            <ValueCard
              entries={[
                { label: item.type === 'flight' ? 'From' : 'Departs from', value: details.departureName },
                { label: item.type === 'flight' ? 'To' : 'Arrives at', value: details.arrivalName },
                { label: 'Airline', value: details.airline },
                { label: 'Flight', value: details.flightNumber },
                { label: 'Seat', value: details.seat },
                { label: 'Mode', value: details.mode },
              ]}
            />
          ) : null}

          <ValueCard
            entries={[
              { label: 'Confirmation', value: confirmation },
              {
                // A per-family bill shows YOUR share, and says so — the same
                // label the form puts on the field that set it.
                label: PRIVATE_BILL.includes(item.sharing || '') ? 'Your cost' : 'Cost',
                value: cost != null ? `${item.currency || ''} ${cost}`.trim() : '',
              },
              { label: 'Sharing', value: item.sharing && item.sharing !== 'private' ? tripSharingLabel(item.sharing) : '' },
            ]}
          />

          {/* Alert + Second alert share one card (divided) — the event view's
              live alert block, offered only on a booking this device could
              decrypt: a reseal over a contentless row would destroy the sealed
              title for everyone who CAN read it. */}
          {item.title ? (
            <Card style={styles.alertCard}>
              <Select
                inlineLabel="Alert"
                value={alertKey(alerts?.reminderMinutes ?? null, 'event')}
                options={excludeUsedAlertKey(alertItems, alerts?.alert2Minutes ?? null, alerts?.reminderMinutes ?? null)}
                placeholder="None"
                onChange={(v) => {
                  if (v === CUSTOM_ALERT) setCustomFor('reminderMinutes');
                  else {
                    const opt = alertItems.find((i) => i.value === v);
                    // Clearing this one hands the slot to the second alert, which
                    // the card would otherwise hide while leaving it set.
                    const p = promoteSecondAlert({
                      reminderMinutes: opt?.minutes ?? null,
                      alert2Minutes: alerts?.alert2Minutes ?? null,
                    });
                    applyAlerts({ reminderMinutes: p.reminderMinutes, alert2Minutes: p.alert2Minutes });
                  }
                }}
                containerStyle={styles.alertField}
                fieldStyle={styles.alertFieldInner}
                inlineLabelStyle={styles.alertTitle}
                valueStyle={styles.alertValue}
                chevronIcon="chevron-expand"
              />
              {alerts?.reminderMinutes != null ? (
                <>
                  <View style={styles.alertDivider} />
                  <Select
                    inlineLabel="Second alert"
                    value={alertKey(alerts?.alert2Minutes ?? null, 'event')}
                    options={excludeUsedAlertKey(alertItems, alerts?.reminderMinutes ?? null, alerts?.alert2Minutes ?? null)}
                    placeholder="None"
                    onChange={(v) => {
                      if (v === CUSTOM_ALERT) setCustomFor('alert2Minutes');
                      else {
                        applyAlerts({
                          reminderMinutes: alerts?.reminderMinutes ?? null,
                          alert2Minutes: alertItems.find((i) => i.value === v)?.minutes ?? null,
                        });
                      }
                    }}
                    containerStyle={styles.alertField}
                    fieldStyle={styles.alertFieldInner}
                    inlineLabelStyle={styles.alertTitle}
                    valueStyle={styles.alertValue}
                    chevronIcon="chevron-expand"
                  />
                </>
              ) : null}
            </Card>
          ) : null}

          {item.url ? (
            <CardRow
              title="URL"
              subtitle={item.url}
              onPress={() => Linking.openURL(/^https?:\/\//i.test(item.url!) ? item.url! : `https://${item.url}`)}
              right={<Ionicons name="open-outline" size={18} color={colors.textMuted} />}
            />
          ) : null}

          {item.phone ? (
            <CardRow
              title="Phone"
              subtitle={formatDisplay(item.phone)}
              onPress={() => Linking.openURL(`tel:${item.phone}`)}
              right={<Ionicons name="call-outline" size={18} color={colors.textMuted} />}
            />
          ) : null}
        </View>

        {attachments.length ? (
          <>
            <SectionTitle>Attachments</SectionTitle>
            <View style={styles.rows}>
              {attachments.map((att) => {
                const busy = openAttachment.isPending && openAttachment.variables?._id === att._id;
                return (
                  <CardRow
                    key={att._id}
                    leading={
                      <Ionicons
                        name={(att.fileType || '').startsWith('image/') ? 'image-outline' : 'document-outline'}
                        size={22}
                        color={colors.textMuted}
                        style={styles.attIcon}
                      />
                    }
                    title={att.filename || 'Attachment'}
                    subtitle="Tap to open"
                    onPress={() => openAttachment.mutate(att)}
                    right={
                      busy ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                      ) : (
                        <Ionicons name="open-outline" size={18} color={colors.textMuted} />
                      )
                    }
                  />
                );
              })}
            </View>
          </>
        ) : null}

        {item.notes ? (
          <>
            <SectionTitle>Notes</SectionTitle>
            <Text style={styles.notes}>{item.notes}</Text>
          </>
        ) : null}

        <FormError>{error}</FormError>

        <CustomAlertSheet
          visible={customFor !== null}
          dayOnly={!!item.allDay}
          travelMinutes={null}
          initialMinutes={customFor ? alerts?.[customFor] ?? null : null}
          initialAnchor="event"
          onSave={(minutes) => {
            if (!customFor) return;
            applyAlerts(
              customFor === 'alert2Minutes'
                ? { reminderMinutes: alerts?.reminderMinutes ?? null, alert2Minutes: minutes }
                : { reminderMinutes: minutes, alert2Minutes: alerts?.alert2Minutes ?? null },
            );
          }}
          onClose={() => setCustomFor(null)}
        />

        {mapPlace && mapAvailable ? (
          <LocationCard location={mapPlace} onOpen={openInMaps} onUnavailable={() => setMapAvailable(false)} />
        ) : null}
      </Screen>

      {/* The event view's floating "Delete" pill — a translucent control pinned
          to the screen (a sibling of the scroll view), fixed while the booking
          scrolls beneath it. */}
      <View style={[styles.floatingDeleteWrap, { bottom: insets.bottom + spacing.lg }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.floatingDelete} activeOpacity={0.85} disabled={del.isPending} onPress={confirmDelete}>
          {del.isPending ? (
            <ActivityIndicator color={colors.error} />
          ) : (
            <Text style={styles.floatingDeleteText}>Delete Booking</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// A grouped card of label/value lines, keeping only the ones the booking
// actually has — a booking view shows what was entered, not a checklist of what
// wasn't. The whole card disappears when nothing in it was filled in.
function ValueCard({ entries }: { entries: { label: string; value?: string | number | null }[] }) {
  const rows = entries.filter((e) => e.value != null && e.value !== '');
  if (!rows.length) return null;
  return (
    <Card style={styles.groupCard}>
      {rows.map((r, i) => (
        <React.Fragment key={r.label}>
          {i > 0 ? <CardDivider /> : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <Text style={styles.rowValue} numberOfLines={2}>{String(r.value)}</Text>
          </View>
        </React.Fragment>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  typePill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  typeText: { fontSize: 13, fontWeight: '700' },
  bookedPill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bookedText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  location: { fontSize: 16, marginTop: 8, lineHeight: 22 },
  whenBlock: { marginTop: spacing.md, marginBottom: spacing.lg },
  when: { fontSize: 15, color: colors.text, lineHeight: 22 },
  tzNote: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  rows: { gap: spacing.md },
  groupCard: { padding: 0, overflow: 'hidden' },
  // The event view's alert block styles, verbatim: picker rows own their
  // padding inside one card, a hairline divides them, the label wears the
  // detail screen's row title and the value hugs its text on the right.
  alertCard: { padding: 0, overflow: 'hidden' },
  alertField: { marginBottom: 0 },
  alertFieldInner: {
    backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0,
    paddingHorizontal: spacing.md, paddingVertical: 14,
  },
  alertTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  alertValue: { flex: 0, color: colors.textMuted },
  alertDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.md },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  rowLabel: { fontSize: 16, fontWeight: '600', color: colors.text },
  rowValue: { flex: 1, fontSize: 16, color: colors.textMuted, textAlign: 'right' },
  attIcon: { marginRight: spacing.sm },
  notes: { fontSize: 15, color: colors.text, lineHeight: 22, marginTop: spacing.xs },
  floatingDeleteWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  floatingDelete: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: 12 },
  floatingDeleteText: { fontSize: 16, fontWeight: '600', color: colors.error },
});
