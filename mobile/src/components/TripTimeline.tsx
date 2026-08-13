import React, { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Text } from './Text';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { placesApi, TripItem } from '../api';
import { tripTypeMeta } from '../lib/tripTypes';
import { zonedParts, zonedTimeLabel } from '../lib/tz';
import { colors } from '../theme';

// Faithful port of the lane-packed hour-by-hour timeline in
// client/src/views/TripDetailView.vue (day view): journey legs placed in their
// own zone, greedy lane-packing for overlaps, hour gridlines, and tappable
// travel-time pills (mode cycles Drive→Walk→Transit) computed via /places/route-leg.

const PX_PER_MIN = 1;
const MIN_BLOCK = 40;
const GUTTER = 48; // left hour-label gutter

const isJourney = (it: TripItem) => it.type === 'flight' || it.type === 'transit';
const hasZones = (it: TripItem) => {
  const d = it.details as any;
  return isJourney(it) && (d?.departureTz || d?.arrivalTz);
};

const TRAVEL_MODES = [
  { value: 'DRIVE', icon: 'car', label: 'Drive' },
  { value: 'WALK', icon: 'walk', label: 'Walk' },
  { value: 'TRANSIT', icon: 'train', label: 'Transit' },
] as const;
type Mode = (typeof TRAVEL_MODES)[number]['value'];

type Seg = {
  key: string;
  item: TripItem;
  startMin: number;
  endMin: number;
  title: string;
  subtitle: string;
  timeLabel: string;
  journeyId: string | null;
  anchorPlaceId: string;
  anchorAddress: string;
  anchorTz: string;
  startInstant: string;
  endInstant: string;
};

type LegResult = { minutes: number } | null | { error: true };

function refKey(placeId: string, address: string) {
  return placeId ? `place:${placeId}` : address ? `addr:${address.toLowerCase().trim()}` : null;
}
function fmtDuration(min: number) {
  if (min == null) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function TripTimeline({
  items,
  selectedDate,
  tz,
  onEditItem,
}: {
  items: TripItem[];
  selectedDate: string;
  tz: string;
  onEditItem: (itemId: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const [legModes, setLegModes] = useState<Record<string, Mode>>({});
  const [legResults, setLegResults] = useState<Record<string, LegResult>>({});

  const timeRange = (item: TripItem) => {
    const s = zonedTimeLabel(item.start, tz);
    return item.end ? `${s} – ${zonedTimeLabel(item.end, tz)}` : s;
  };

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
        const sp = zonedParts(i.start, tz);
        if (sp.dateStr !== selectedDate) continue;
        const s = sp.minutes;
        const e = i.end ? Math.max(zonedParts(i.end, tz).minutes, s + MIN_BLOCK) : s + MIN_BLOCK;
        out.push({
          key: i._id, item: i, startMin: s, endMin: e, title: i.title, subtitle: i.location || '',
          timeLabel: timeRange(i), journeyId: null,
          anchorPlaceId: (i as any).placeId || '', anchorAddress: i.location || (i as any).address || '', anchorTz: tz,
          startInstant: i.start, endInstant: i.end || i.start,
        });
      }
    }
    return out.sort((a, b) => a.startMin - b.startMin);
  }, [items, selectedDate, tz]);

  const bounds = useMemo(() => {
    if (!segs.length) return { start: 8 * 60, end: 20 * 60 };
    let lo = Math.min(...segs.map((s) => s.startMin));
    let hi = Math.max(...segs.map((s) => s.endMin));
    lo = Math.max(0, Math.floor(lo / 60) * 60);
    hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
    if (hi - lo < 120) hi = Math.min(24 * 60, lo + 120);
    return { start: lo, end: hi };
  }, [segs]);

  const height = (bounds.end - bounds.start) * PX_PER_MIN + 8;

  const hourMarks = useMemo(() => {
    const marks: { hour: number; top: number; label: string }[] = [];
    for (let m = bounds.start; m <= bounds.end; m += 60) {
      const h = (m / 60) % 24;
      const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
      marks.push({ hour: m, top: (m - bounds.start) * PX_PER_MIN, label });
    }
    return marks;
  }, [bounds]);

  // ── Lane-packing ──
  const layout = useMemo(() => {
    if (!segs.length) return [];
    const blocks = segs.map((seg) => ({ seg, s: seg.startMin, e: seg.endMin, lane: 0, lanes: 1 }));
    let cluster: typeof blocks = [];
    let clusterEnd = -1;
    const flush = () => {
      const laneEnds: number[] = [];
      for (const b of cluster) {
        let placed = false;
        for (let l = 0; l < laneEnds.length; l++) {
          if (b.s >= laneEnds[l]) { b.lane = l; laneEnds[l] = b.e; placed = true; break; }
        }
        if (!placed) { b.lane = laneEnds.length; laneEnds.push(b.e); }
      }
      const total = laneEnds.length;
      cluster.forEach((b) => { b.lanes = total; });
      cluster = [];
    };
    for (const b of blocks.slice().sort((a, z) => a.s - z.s)) {
      if (cluster.length && b.s >= clusterEnd) flush();
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.e);
    }
    flush();
    return blocks.map((b) => ({
      seg: b.seg,
      top: (b.s - bounds.start) * PX_PER_MIN,
      height: (b.e - b.s) * PX_PER_MIN,
      leftFrac: b.lane / b.lanes,
      widthFrac: 1 / b.lanes,
    }));
  }, [segs, bounds]);

  // ── Connectors (travel pills) ──
  const connectors = useMemo(() => {
    const out: any[] = [];
    for (let i = 1; i < layout.length; i++) {
      const A = layout[i - 1].seg;
      const B = layout[i].seg;
      if (A.journeyId && A.journeyId === B.journeyId) continue;
      const oKey = refKey(A.anchorPlaceId, A.anchorAddress);
      const dKey = refKey(B.anchorPlaceId, B.anchorAddress);
      if (!oKey || !dKey || oKey === dKey) continue;
      const baseKey = `${oKey}|${dKey}`;
      const mode = legModes[baseKey] || 'DRIVE';
      const gapMin = Math.round((+new Date(B.startInstant) - +new Date(A.endInstant)) / 60000);
      out.push({
        baseKey, mode, key: `${baseKey}|${mode}`,
        top: layout[i].top, leftFrac: layout[i].leftFrac,
        origin: { placeId: A.anchorPlaceId, address: A.anchorAddress },
        dest: { placeId: B.anchorPlaceId, address: B.anchorAddress },
        departAt: A.endInstant, gapMin,
      });
    }
    return out;
  }, [layout, legModes]);

  // Fetch route legs
  useEffect(() => {
    connectors.forEach((c) => {
      if (c.key in legResults) return;
      setLegResults((r) => ({ ...r, [c.key]: null }));
      placesApi
        .routeLeg({
          originPlaceId: c.origin.placeId || undefined,
          originAddress: c.origin.address || undefined,
          destPlaceId: c.dest.placeId || undefined,
          destAddress: c.dest.address || undefined,
          mode: c.mode,
          departureTime: c.departAt || undefined,
        })
        .then((res) => {
          const min = (res.data as any)?.minutes ?? null;
          setLegResults((r) => ({ ...r, [c.key]: min != null ? { minutes: min } : { error: true } }));
        })
        .catch(() => setLegResults((r) => ({ ...r, [c.key]: { error: true } })));
    });
  }, [connectors]);

  function cycleMode(baseKey: string) {
    const cur = legModes[baseKey] || 'DRIVE';
    const idx = TRAVEL_MODES.findIndex((m) => m.value === cur);
    setLegModes((m) => ({ ...m, [baseKey]: TRAVEL_MODES[(idx + 1) % TRAVEL_MODES.length].value }));
  }

  if (!segs.length) return null;

  const inner = Math.max(0, width - GUTTER);

  return (
    <View style={[styles.timeline, { height }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {hourMarks.map((hr) => (
        <View key={hr.hour} style={[styles.hourLine, { top: hr.top }]}>
          <Text style={styles.hourLabel}>{hr.label}</Text>
          <View style={styles.hourRule} />
        </View>
      ))}

      {width > 0 &&
        layout.map((b) => {
          const meta = tripTypeMeta(b.seg.item.type);
          const left = GUTTER + b.leftFrac * inner;
          const blockW = Math.max(40, b.widthFrac * inner - 6);
          return (
            <TouchableOpacity
              key={b.seg.key}
              activeOpacity={0.8}
              onPress={() => onEditItem(b.seg.item._id)}
              style={[styles.block, {
                top: b.top, height: Math.max(MIN_BLOCK, b.height), left, width: blockW,
                borderColor: meta.color, backgroundColor: meta.color + '14',
              }]}
            >
              <View style={styles.blockHead}>
                <MaterialCommunityIcons name={meta.icon as any} size={12} color={meta.color} />
                <Text style={styles.blockTitle} numberOfLines={1}>{b.seg.title}</Text>
                {b.seg.item.confirmed ? <Ionicons name="checkmark-circle" size={10} color="#2E7D32" /> : null}
              </View>
              <Text style={styles.blockTime}>{b.seg.timeLabel}</Text>
              {b.seg.subtitle && b.height >= 56 ? <Text style={styles.blockLoc} numberOfLines={1}>{b.seg.subtitle}</Text> : null}
            </TouchableOpacity>
          );
        })}

      {width > 0 &&
        connectors.map((c) => {
          const res = legResults[c.key];
          const left = GUTTER + 2 + c.leftFrac * inner;
          const tight = res && 'minutes' in res && c.gapMin != null && res.minutes > c.gapMin;
          const modeIcon = TRAVEL_MODES.find((m) => m.value === c.mode)?.icon ?? 'car';
          return (
            <TouchableOpacity
              key={c.key}
              activeOpacity={0.8}
              onPress={() => cycleMode(c.baseKey)}
              style={[styles.pill, { top: Math.max(0, c.top - 20), left }, tight && styles.pillTight]}
            >
              {res === null || res === undefined ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : 'minutes' in res ? (
                <>
                  <MaterialCommunityIcons name={modeIcon as any} size={11} color={tight ? '#C62828' : colors.textMuted} />
                  <Text style={[styles.pillText, tight && styles.pillTextTight]}>{fmtDuration(res.minutes)}</Text>
                  {tight ? <Ionicons name="alert" size={11} color="#C62828" /> : null}
                </>
              ) : (
                <>
                  <MaterialCommunityIcons name={modeIcon as any} size={11} color={colors.textMuted} />
                  <Text style={styles.pillText}>—</Text>
                </>
              )}
            </TouchableOpacity>
          );
        })}
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: { position: 'relative', marginTop: 8 },
  hourLine: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: GUTTER - 6, textAlign: 'right', fontSize: 10, color: colors.textMuted, marginRight: 6 },
  hourRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  block: { position: 'absolute', borderWidth: 1, borderLeftWidth: 3, borderRadius: 6, padding: 4, overflow: 'hidden' },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  blockTitle: { flex: 1, fontSize: 11, fontWeight: '600', color: colors.text },
  blockTime: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  blockLoc: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  pill: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, zIndex: 10,
  },
  pillTight: { borderColor: '#C62828', backgroundColor: '#FDECEA' },
  pillText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  pillTextTight: { color: '#C62828' },
});
