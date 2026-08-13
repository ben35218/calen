import React, { useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Text } from '../../components/Text';
import type { PurchasesPackage } from 'react-native-purchases';
import type { CreditPack } from '../../api';
import { Button } from '../../components/ui';
import { colors, spacing, radius } from '../../theme';
import { humanCredits } from './shared';

// The credit-pack store, shared by CreditsScreen and BuyCreditsSheet so the two
// surfaces can't drift. Select-then-confirm: each pack is a selectable tile
// (radio semantics — tapping is cheap and reversible) and the commitment moment
// is one full-width CTA that restates exactly what's being bought. Tiles carry
// the value framing: the % bonus in credits-per-dollar over the first (Starter)
// pack, with the richest pack badged "Best value" and pre-selected.

type Row = { pack: CreditPack; pkg: PurchasesPackage | null };

const RIBBON_HEIGHT = 18;

// Localized store price when RC has loaded; USD catalog fallback otherwise.
function priceLabel(row: Row): string {
  return row.pkg ? row.pkg.product.priceString : `$${row.pack.price.toFixed(2)}`;
}

// Value framing off the catalog (stable across store currencies): each pack's
// credits-per-dollar vs the first pack's, as a whole-% bonus. The richest pack
// (ties go to the biggest) is "best" — badged and pre-selected.
export function packValueFraming(packs: CreditPack[]): { bestIndex: number; bonuses: number[] } {
  const rates = packs.map((p) => (p.price > 0 ? p.credits / p.price : 0));
  const baseRate = rates[0] || 0;
  const bestIndex = rates.reduce((best, rate, i) => (rate >= rates[best] ? i : best), 0);
  const bonuses = rates.map((rate) => (baseRate > 0 ? Math.round((rate / baseRate - 1) * 100) : 0));
  return { bestIndex, bonuses };
}

export default function PackStore({
  rows,
  busyId,
  buy,
  activating,
}: {
  rows: Row[];
  busyId: string | null;
  buy: (row: Row) => void;
  // Keeps the CTA spinning past the store sheet (BuyCreditsSheet holds it
  // through the activation poll; CreditsScreen shows its own activation card).
  activating?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (rows.length === 0) return null;

  const { bestIndex, bonuses } = packValueFraming(rows.map((r) => r.pack));

  const chosen = rows.findIndex((r) => r.pack.productId === selectedId);
  const selectedIndex = chosen >= 0 ? chosen : bestIndex;
  const selected = rows[selectedIndex];

  return (
    <View>
      <View style={styles.tiles} accessibilityRole="radiogroup">
        {rows.map((row, i) => {
          const isSelected = i === selectedIndex;
          const badge =
            i === bestIndex && rows.length > 1
              ? 'Best value'
              : bonuses[i] > 0
                ? `+${bonuses[i]}%`
                : null;
          return (
            <Pressable
              key={row.pack.productId}
              onPress={() => setSelectedId(row.pack.productId)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${humanCredits(row.pack.credits)} credits for ${priceLabel(row)}`}
              style={[styles.tile, isSelected && styles.tileSelected]}
            >
              {badge ? (
                <View style={[styles.ribbon, i === bestIndex && styles.ribbonBest]}>
                  <Text
                    style={[styles.ribbonText, i === bestIndex && styles.ribbonTextBest]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.1}
                  >
                    {badge.toUpperCase()}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.tileCredits} maxFontSizeMultiplier={1.3}>
                {humanCredits(row.pack.credits)}
              </Text>
              <Text style={styles.tileCaption} maxFontSizeMultiplier={1.3}>credits</Text>
              <Text
                style={[styles.tilePrice, isSelected && styles.tilePriceSelected]}
                maxFontSizeMultiplier={1.3}
              >
                {priceLabel(row)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Button
        title={`Buy ${humanCredits(selected.pack.credits)} credits for ${priceLabel(selected)}`}
        loading={busyId != null || activating}
        disabled={!selected.pkg}
        onPress={() => buy(selected)}
      />
      <Text style={styles.footer}>One-time purchase · credits never expire</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.md },
  // Every tile reserves the ribbon strip (paddingTop) whether or not it has
  // one, so the three tiles stay the same height with aligned content.
  tile: {
    flex: 1,
    alignItems: 'center',
    paddingTop: RIBBON_HEIGHT + spacing.sm,
    paddingBottom: spacing.sm + 4,
    paddingHorizontal: spacing.xs,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  tileSelected: { borderColor: colors.primary, backgroundColor: colors.primary + '14' },
  // A full-width strip across the tile's top — no floating pill, so it can't
  // wrap or collide on narrow screens; overflow:hidden clips it to the corners.
  ribbon: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: RIBBON_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.border,
  },
  ribbonBest: { backgroundColor: colors.primary },
  ribbonText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted },
  ribbonTextBest: { color: '#fff' },
  tileCredits: { fontSize: 20, fontWeight: '700', color: colors.text },
  tileCaption: { fontSize: 11, color: colors.textMuted, marginTop: 1, marginBottom: spacing.sm },
  tilePrice: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  tilePriceSelected: { color: colors.text },
  footer: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
});
