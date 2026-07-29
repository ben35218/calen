import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import WeatherIcon from '../../../components/WeatherIcon';
import { colors } from '../../../theme';
import { HOUR_H, PX_PER_MIN, RailMark } from './dayViewLayout';

const MARK_H = 32;

// The hourly forecast woven into a timeline column: a slim ambient rail down
// the column's right edge, one condition icon + temperature per forecast
// hour, each centred in its hour band. Non-interactive and rendered UNDER the
// event blocks — weather is context, events own the canvas. Shown only while
// the Weather calendar is toggled visible (the gate lives in TimelineView).
export default function WeatherRail({ marks }: { marks: RailMark[] }) {
  if (!marks.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {marks.map((m) => (
        <View key={m.minutes} style={[styles.mark, { top: m.minutes * PX_PER_MIN + (HOUR_H - MARK_H) / 2 }]}>
          <WeatherIcon code={m.code} size={14} />
          <Text style={styles.temp}>{m.temp}°</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { position: 'absolute', right: 3, height: MARK_H, alignItems: 'center', opacity: 0.75 },
  temp: { fontSize: 9, fontWeight: '600', color: colors.textMuted },
});
