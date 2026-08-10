import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BottomSheet, Button, SegmentedControl } from './ui';
import WheelPicker, { WHEEL_ITEM_H, WHEEL_VISIBLE } from './WheelPicker';
import { AlertAnchor, canLeaveAnchor, leaveAlertBuffer, leaveAlertMinutes } from '../lib/calendar';
import { colors, radius, spacing } from '../theme';

// Custom-alert unit: a string key so it drives the SegmentedControl directly.
type AlertUnit = 'min' | 'hr' | 'day';
const UNIT_MINUTES: Record<AlertUnit, number> = { min: 1, hr: 60, day: 1440 };
// Word shown beside the amount wheel (the live "[30] minutes" spinner readout).
const UNIT_LABEL: Record<AlertUnit, string> = { min: 'minutes', hr: 'hours', day: 'days' };
// Amount wheel range per unit (iOS timer-style: finer units, shorter ranges).
// Minutes run past the hour on purpose: the hours wheel is whole hours only, so
// a 59-minute cap left every in-between lead time — 90 minutes, 2½ hours —
// unreachable from either unit.
const AMOUNT_MAX: Record<AlertUnit, number> = { min: 180, hr: 23, day: 31 };
// Where the wheel lands when the user TAPS a unit — a sensible lead time in that
// unit, not the old unit's number carried across. Carrying it over (clamped to
// the new range) meant tapping Hours from the default 30 minutes landed on 23
// hours, the far end of the wheel, because 30 is past the hours range.
const UNIT_DEFAULT: Record<AlertUnit, number> = { min: 30, hr: 2, day: 2 };
const CUSTOM_UNITS: { label: string; value: AlertUnit }[] = [
  { label: 'Minutes', value: 'min' },
  { label: 'Hours', value: 'hr' },
  { label: 'Days', value: 'day' },
];

// What the custom lead time counts back from. Only offered on a timed event with
// a known drive time (`canLeaveAnchor`); see the anchor note in lib/calendar.
// Departure leads, and is the default on a fresh alert: once a drive time is
// attached, when to LEAVE is the thing the user came here to be told.
const ANCHOR_OPTIONS: { label: string; value: AlertAnchor }[] = [
  { label: 'Before leaving', value: 'leave' },
  { label: 'Before event', value: 'event' },
];

// Decompose stored "minutes before the event" into the largest clean unit, to
// seed the wheel from the field's current value. No usable value → 30 minutes.
function decomposeAlert(minutes: number | null): { amount: number; unit: AlertUnit } {
  if (!minutes || minutes <= 0) return { amount: 30, unit: 'min' };
  const unit: AlertUnit = minutes % 1440 === 0 ? 'day' : minutes % 60 === 0 ? 'hr' : 'min';
  return { amount: Math.min(minutes / UNIT_MINUTES[unit], AMOUNT_MAX[unit]), unit };
}

// The alert picker's "Custom…" choice. A single amount wheel + the unit word
// beside it (the classic "[30] minutes" spinner readout), with the unit chosen
// via a SegmentedControl below. This mirrors the Repeat screen's "Every" sheet —
// one scroll wheel inside the modal, which scrolls reliably; the earlier
// two-adjacent-wheels layout did not. The unit has only 3 values, so a tap
// control is both more robust and more discoverable than a second wheel.
//
// A second SegmentedControl picks the ANCHOR — whether the lead time counts back
// from the event or from departure — whenever the event has a drive time. The
// canned rows offer both framings ("1 hour before", "15 min before leaving"), so
// the custom row has to as well; without it, a custom lead time was always
// event-relative and the picker then re-worded it against the drive time, which
// is what made "2 hours" read back as "1 hr 37 min before leaving". The sheet
// emits minutes-before-the-EVENT either way (the stored form) plus the anchor.
//
// `dayOnly` is the all-day event's sheet: minutes and hours would be counting
// back from a start time the event doesn't have, so the unit is fixed to days
// and the control that offers the other two is not rendered at all. Departure is
// meaningless there too, so the anchor control is absent with it.
export default function CustomAlertSheet({
  visible,
  initialMinutes,
  initialAnchor,
  travelMinutes,
  dayOnly,
  onSave,
  onClose,
}: {
  visible: boolean;
  initialMinutes: number | null;
  initialAnchor: AlertAnchor;
  travelMinutes: number | null;
  dayOnly?: boolean;
  onSave: (minutes: number, anchor: AlertAnchor) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(30);
  const [unit, setUnit] = useState<AlertUnit>('min');
  const [anchor, setAnchor] = useState<AlertAnchor>('event');
  const canLeave = canLeaveAnchor(dayOnly, travelMinutes);
  // Whether the user moved anything this open. Dismissing the sheet keeps the
  // selection (see `commit`), but only on a slot the user actually dialled — an
  // accidental open, closed untouched, must not write the seeded default in.
  const touched = useRef(false);
  // The live selection, read by the dismissal path: a scrim tap or drag closes
  // through the exit animation, whose callback runs frames later, so the commit
  // must read current state rather than the closure that started the animation.
  // Mirrored AS THE USER PICKS rather than during render, so a dismissal that
  // lands before React has re-rendered still saves the value they just chose.
  const sel = useRef({ amount, unit, anchor });
  const choose = (patch: Partial<typeof sel.current>) => {
    sel.current = { ...sel.current, ...patch };
    if (patch.amount !== undefined) setAmount(patch.amount);
    if (patch.unit !== undefined) setUnit(patch.unit);
    if (patch.anchor !== undefined) setAnchor(patch.anchor);
  };

  // Hand the shown selection back to the form. The wheel holds a lead time; a
  // departure-anchored one is stored as minutes before the EVENT (drive time +
  // buffer), so both framings save the same shape.
  const commit = () => {
    const lead = sel.current.amount * UNIT_MINUTES[sel.current.unit];
    const leave = canLeave && sel.current.anchor === 'leave';
    onSave(leave ? leaveAlertMinutes(lead, travelMinutes!) : lead, leave ? 'leave' : 'event');
  };

  // Reseed from the field's current value each time the sheet opens. A
  // leave-anchored value is stored as minutes before the EVENT, so the wheel is
  // seeded with its buffer — the number the user actually chose.
  useEffect(() => {
    if (!visible) return;
    touched.current = false;
    if (dayOnly) {
      const days = Math.round((initialMinutes ?? UNIT_MINUTES.day) / UNIT_MINUTES.day);
      choose({ amount: Math.min(Math.max(days, 1), AMOUNT_MAX.day), unit: 'day', anchor: 'event' });
      return;
    }
    // With a drive time attached, a slot that holds NO alert yet opens on
    // "Before leaving" — that's the setting the drive time exists for. A slot
    // that already holds one opens in ITS framing, so re-opening the sheet on a
    // "2 hours before" alert and leaving can't quietly turn it into two hours
    // before leaving.
    const startAnchor: AlertAnchor = !canLeave ? 'event' : initialMinutes == null ? 'leave' : initialAnchor;
    const seed =
      startAnchor === 'leave' && initialMinutes != null && travelMinutes
        ? leaveAlertBuffer(initialMinutes, travelMinutes) || null
        : initialMinutes;
    const d = decomposeAlert(seed);
    choose({ amount: d.amount, unit: d.unit, anchor: startAnchor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Tapping a unit starts that unit fresh at its own default (30 minutes /
  // 2 hours / 2 days) — the wheel remounts per unit, so it opens on that number.
  // Only an explicit unit tap resets; the seed above still shows a saved value.
  const pickUnit = (u: AlertUnit) => {
    touched.current = true;
    choose({ unit: u, amount: UNIT_DEFAULT[u] });
  };

  return (
    <BottomSheet
      visible={visible}
      // Dismissing the sheet KEEPS the selection — a scrim tap, a drag down, or
      // Android back commit what the wheel is showing, exactly as Done does.
      // With only Done saving, "dial 45 minutes, tap away" silently threw the
      // alert away, which reads as the picker losing a setting already made.
      onClose={() => {
        if (touched.current) commit();
        onClose();
      }}
      style={styles.alertSheet}
    >
      <View style={styles.wheelRow}>
        {/* Selection band sits behind the centered row, like the native spinner's. */}
        <View pointerEvents="none" style={styles.wheelBand} />
        <WheelPicker
          // Remount per open (fresh position) and per unit (clamped range).
          key={`amount-${String(visible)}-${unit}`}
          width={96}
          items={Array.from({ length: AMOUNT_MAX[unit] }, (_, i) => ({ label: String(i + 1), value: i + 1 }))}
          value={amount}
          onChange={(v) => {
            touched.current = true;
            choose({ amount: v });
          }}
        />
        <Text style={styles.wheelUnit}>{UNIT_LABEL[unit]}</Text>
      </View>
      {dayOnly ? null : <SegmentedControl<AlertUnit> value={unit} options={CUSTOM_UNITS} onChange={pickUnit} />}
      {canLeave ? (
        <SegmentedControl<AlertAnchor>
          value={anchor}
          options={ANCHOR_OPTIONS}
          onChange={(a) => {
            touched.current = true;
            choose({ anchor: a });
          }}
        />
      ) : null}
      <Button
        title="Done"
        onPress={() => {
          commit();
          onClose();
        }}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  // Custom alert wheel content inside the shared BottomSheet.
  alertSheet: { gap: spacing.sm },
  wheelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.md, height: WHEEL_ITEM_H * WHEEL_VISIBLE,
  },
  wheelBand: {
    position: 'absolute', left: 0, right: 0,
    top: ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H, height: WHEEL_ITEM_H,
    borderRadius: radius.sm, backgroundColor: colors.border + '55',
  },
  // The unit word beside the amount wheel ("30 minutes").
  wheelUnit: { fontSize: 23, color: colors.text },
});
