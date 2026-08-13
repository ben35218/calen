import React, { useEffect, useLayoutEffect, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Text } from '../../components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, SettlementBalance, SettlementLine } from '../../api';
import { Button, Card, Input, Select, SectionHeader, SkeletonList } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { tripTypeMeta } from '../../lib/tripTypes';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { colors, spacing } from '../../theme';

type Rt = RouteProp<TripsStackParamList, 'TripSettle'>;
type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripSettle'>;

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF', 'CNY', 'MXN', 'INR'];

function money(amount: number | null | undefined, cur: string) {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${cur} ${Math.round(amount)}`;
  }
}

function lineMeta(line: SettlementLine) {
  if (line.kind === 'payment') return { icon: 'cash-check', color: '#2E7D32', label: 'Payment recorded' };
  const m = tripTypeMeta(line.type || 'other');
  return { icon: m.icon, color: m.color, label: line.title || '' };
}

// Mirrors client/src/views/TripSettleView.vue — balances with breakdown lines,
// a record-payment form, and deletable payment history.
export default function TripSettleScreen() {
  const { id } = useRoute<Rt>().params;
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.trips;

  const settleQ = useQuery({
    queryKey: ['trips', id, 'settlement'],
    queryFn: async () => (await tripsApi.settlement(id)).data,
  });

  const [form, setForm] = useState({ from: '', to: '', amount: '', currency: 'CAD', note: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const base = settleQ.data?.baseCurrency || 'CAD';

  useEffect(() => {
    if (settleQ.data) {
      setForm((f) => ({
        ...f,
        from: f.from || settleQ.data!.myHouseholdId || '',
        currency: f.currency === 'CAD' ? base : f.currency,
      }));
    }
  }, [settleQ.data, base]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Settle Up' });
  }, [navigation]);

  if (settleQ.isLoading || !settleQ.data) {
    return (
      <SkeletonList />
    );
  }

  const { balances, payments, households, ratesAvailable } = settleQ.data;
  const householdOptions = (households ?? []).map((h) => ({ label: h.name, value: h.householdId }));

  function prefill(b: SettlementBalance) {
    setForm({ from: b.from || '', to: b.to || '', amount: String(b.amount), currency: base, note: '' });
    setError('');
  }

  async function savePayment() {
    setError('');
    if (!form.from || !form.to) return setError('Pick who paid and who they paid.');
    if (form.from === form.to) return setError('Pick two different families.');
    if (!(Number(form.amount) > 0)) return setError('Enter an amount greater than zero.');
    setSaving(true);
    try {
      await tripsApi.addPayment(id, {
        from: form.from,
        to: form.to,
        amount: Number(form.amount),
        currency: form.currency,
        note: form.note,
      });
      setForm((f) => ({ ...f, amount: '', note: '' }));
      qc.invalidateQueries({ queryKey: ['trips', id] });
      settleQ.refetch();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not record that payment.');
    } finally {
      setSaving(false);
    }
  }

  function removePayment(payId: string) {
    Alert.alert('Delete payment?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeletingId(payId);
          try {
            await tripsApi.removePayment(id, payId);
            qc.invalidateQueries({ queryKey: ['trips', id] });
            settleQ.refetch();
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }

  return (
    <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.content}>
      {/* Balances */}
      <Card style={styles.card}>
        <SectionHeader style={{ color: accent }}>Balances</SectionHeader>
        {balances.length === 0 ? (
          <View style={styles.allSettled}>
            <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            <Text style={styles.settledText}>Everyone is settled up.</Text>
          </View>
        ) : (
          balances.map((b, i) => (
            <View key={i} style={[styles.balanceGroup, i > 0 && styles.balanceGroupSep]}>
              <View style={styles.balanceHead}>
                <Ionicons name="arrow-forward-circle-outline" size={18} color={accent} />
                <Text style={styles.balanceText}>
                  <Text style={styles.bold}>{b.fromName}</Text> owes <Text style={styles.bold}>{b.toName}</Text>
                </Text>
                <Text style={styles.balanceAmt}>{money(b.amount, base)}</Text>
                <TouchableOpacity style={styles.payBtn} onPress={() => prefill(b)}>
                  <Text style={styles.payBtnText}>Pay</Text>
                </TouchableOpacity>
              </View>
              {(b.lines ?? []).map((line, li) => {
                const m = lineMeta(line);
                const Row: any = line.itemId ? TouchableOpacity : View;
                return (
                  <Row
                    key={li}
                    style={styles.breakdownRow}
                    onPress={line.itemId ? () => navigation.navigate('TripItemForm', { tripId: id, itemId: line.itemId }) : undefined}
                  >
                    <MaterialCommunityIcons name={m.icon as any} size={14} color={m.color} />
                    <Text style={styles.breakdownLabel} numberOfLines={1}>{m.label}</Text>
                    <Text style={[styles.breakdownAmt, line.amount < 0 && styles.creditAmt]}>
                      {line.amount < 0 ? '−' : '+'}{money(Math.abs(line.amount), base)}
                    </Text>
                    {line.itemId ? <Ionicons name="chevron-forward" size={13} color={colors.textMuted} /> : null}
                  </Row>
                );
              })}
            </View>
          ))
        )}
        {ratesAvailable === false ? (
          <Text style={styles.warn}>⚠ Exchange rates unavailable — only same-currency costs are totalled.</Text>
        ) : null}
      </Card>

      {/* Record a payment */}
      <SectionHeader style={{ color: '#2E7D32' }}>Record a payment</SectionHeader>
      <GroupCard>
        <Select
          inlineLabel="From"
          placeholder="Who paid?"
          value={form.from}
          options={householdOptions}
          onChange={(v) => setForm((f) => ({ ...f, from: (v as string) || '' }))}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        <Select
          inlineLabel="To"
          placeholder="Who did they pay?"
          value={form.to}
          options={householdOptions}
          onChange={(v) => setForm((f) => ({ ...f, to: (v as string) || '' }))}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Amount</Text>
          <Input
            value={form.amount}
            onChangeText={(v) => setForm((f) => ({ ...f, amount: v }))}
            keyboardType="decimal-pad"
            placeholder="0"
            clearable={false}
            containerStyle={[fs.headField, fs.rowInputWrap]}
            style={[fs.headInput, fs.rowInput]}
          />
        </View>
        <CardDivider />
        <Select
          inlineLabel="Currency"
          value={form.currency}
          options={CURRENCIES.map((c) => ({ label: c, value: c }))}
          onChange={(v) => setForm((f) => ({ ...f, currency: (v as string) || 'CAD' }))}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        <Input
          value={form.note}
          onChangeText={(v) => setForm((f) => ({ ...f, note: v }))}
          placeholder="Note (optional)"
          containerStyle={fs.headField}
          style={fs.headInput}
        />
      </GroupCard>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.recordBtn}>
        <Button title="Record payment" onPress={savePayment} loading={saving} />
      </View>

      {/* History */}
      {payments && payments.length > 0 ? (
        <Card style={styles.card}>
          <SectionHeader style={{ color: accent }}>Recorded payments</SectionHeader>
          {payments.map((p) => (
            <View key={p._id} style={styles.payRow}>
              <View style={styles.flex1}>
                <Text style={styles.balanceText}>
                  <Text style={styles.bold}>{p.fromName}</Text> paid <Text style={styles.bold}>{p.toName}</Text>
                </Text>
                {p.note ? <Text style={styles.payNote}>{p.note}</Text> : null}
              </View>
              <Text style={styles.payAmt}>{money(p.amount, p.currency || base)}</Text>
              <TouchableOpacity onPress={() => removePayment(p._id)} disabled={deletingId === p._id}>
                <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </Card>
      ) : null}
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  card: { marginBottom: spacing.md },
  allSettled: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  settledText: { fontSize: 14, color: colors.textMuted },
  balanceGroup: { marginBottom: spacing.sm },
  balanceGroupSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  balanceHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  balanceText: { flex: 1, fontSize: 14, color: colors.text },
  bold: { fontWeight: '700' },
  balanceAmt: { fontSize: 14, fontWeight: '700', color: colors.text },
  payBtn: { backgroundColor: '#2E7D3222', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6 },
  payBtnText: { color: '#2E7D32', fontWeight: '700', fontSize: 12 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3, marginLeft: 26 },
  breakdownLabel: { flex: 1, fontSize: 12, color: colors.textMuted },
  breakdownAmt: { fontSize: 12, color: colors.textMuted },
  creditAmt: { color: colors.success },
  warn: { fontSize: 12, color: colors.warning, marginTop: spacing.sm },
  flex1: { flex: 1 },
  recordBtn: { marginBottom: spacing.md },
  error: { color: colors.warning, fontSize: 13, marginBottom: spacing.sm },
  payRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  payNote: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  payAmt: { fontSize: 14, fontWeight: '600', color: colors.text },
});
