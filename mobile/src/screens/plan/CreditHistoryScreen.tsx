import React, { useMemo } from 'react';
import { View, Text, SectionList, StyleSheet, RefreshControl } from 'react-native';
import type { CreditLedgerEntry } from '../../api';
import { CenteredLoader, EmptyState, SectionHeader } from '../../components/ui';
import { colors, spacing } from '../../theme';
import { useCreditLedger, shortDate, ledgerAmount, LEDGER_LABEL } from './shared';

// The full credit-history screen: the complete purchases & grants ledger the
// Credits screen's History card previews. Same `useCreditLedger` query, so it
// opens from the already-warm cache; grouped by month and pull-to-refresh. Usage
// debits never appear here (the server returns grants only) — they're summarized
// on the Credits screen's "Where your credits go" card.

// Month bucket a ledger row falls in — "August" this year, "August 2025" prior
// years. Entries arrive newest-first, so contiguous runs form each section.
function monthLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export default function CreditHistoryScreen() {
  const ledger = useCreditLedger();

  const sections = useMemo(() => {
    const out: { title: string; data: CreditLedgerEntry[] }[] = [];
    for (const e of ledger.data ?? []) {
      const title = monthLabel(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.title === title) last.data.push(e);
      else out.push({ title, data: [e] });
    }
    return out;
  }, [ledger.data]);

  if (ledger.isLoading && !ledger.data) {
    return <CenteredLoader />;
  }

  return (
    <View style={styles.container}>
      <SectionList
        sections={sections}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={ledger.isRefetching} onRefresh={ledger.refetch} />
        }
        renderSectionHeader={({ section }) => (
          <SectionHeader style={styles.sectionHeader}>{section.title}</SectionHeader>
        )}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.label}>{LEDGER_LABEL[item.kind] ?? item.kind}</Text>
              <Text style={styles.date}>{shortDate(item.createdAt)}</Text>
            </View>
            <Text style={[styles.amount, item.credits < 0 && { color: colors.error }]}>
              {item.credits > 0 ? '+' : ''}{ledgerAmount(item.credits)}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            icon="receipt-outline"
            title="No history yet"
            message="Credit packs, plan credits, welcome credits, and adjustments will show up here."
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl, flexGrow: 1 },
  sectionHeader: { marginTop: spacing.md, marginBottom: 2 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, marginRight: spacing.sm },
  label: { fontSize: 15, color: colors.text },
  date: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
});
