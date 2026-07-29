import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
// expo-contacts 56 deprecated its function API on the package root; the same
// functions (getContactsAsync/requestPermissionsAsync/Fields) live under /legacy.
import * as Contacts from 'expo-contacts/legacy';
import { peopleApi, ImportContact, Person } from '../../api';
import { BottomSheet, Button, Input, SegmentedControl, SwitchRow } from '../../components/ui';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { useBilling } from '../../hooks/useBilling';
import { ASSISTANT_NAME } from '../../config';
import { colors, spacing } from '../../theme';
import type { PersonPrefill } from '../../navigation/types';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type Nav = NativeStackNavigationProp<ProfileStackParamList>;
type Method = 'direct' | 'ai';
type ApplyMode = 'auto' | 'review';

type Labeled = { label: string; value: string };
type Row = {
  key: string; // device contact id
  name: string;
  // Structured names straight from the device (expo-contacts) — carried into
  // the prefill so imported contacts land with First/Last already split.
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  // All device phone numbers / emails with their labels, carried through as
  // multi-value fields (phone/email above stay the primary for the AI classifier
  // and the list sub-line).
  phones?: Labeled[];
  emails?: Labeled[];
  birthday?: string;
  company?: string;
  selected: boolean;
  // Default classification for a Direct import. There's no per-row tag in the
  // picker anymore (the roster has three types — Family / Friends /
  // Professionals — so a two-way switch was misleading); the type is set in the
  // Review-each form's Type field, or left at this default for Import-all.
  type: 'family' | 'friend';
  alreadyImported: boolean;
};

// The mobile-native equivalent of web PeopleView's .vcf import. Reads the device
// address book, then offers two paths — Direct (you tag each) or AI-assisted
// (Calen categorizes + pre-fills, web-searching professionals) — and lets you
// import everything at once or review each in the person form first.
//
// AI-assisted classification necessarily ships contact names/companies to the
// model, so it is consent-gated (spec: ai-assistant.md) on BOTH the AI master
// switch and the "personal & contact info in prompts" toggle. With either off,
// only Direct import is offered — the app never surfaces an AI path the server
// (requireAiEnabled) would reject or that the user has opted out of.
export default function ContactImportScreen() {
  const nav = useNavigation<Nav>();
  const qc = useQueryClient();
  const { prefs } = usePrivacyPrefs();
  const { data: billing } = useBilling();
  // AI classification spends credits, so an empty balance blocks it exactly like
  // a consent opt-out would — treat "out of credits" as another reason AI import
  // is unavailable. (unlimited admins never run out; optimistic until billing
  // loads, matching the app's other credit gates.)
  const outOfCredits = billing?.unlimited === false && (billing?.creditBalance ?? 0) <= 0;
  // AI-assisted import needs the master switch AND permission to put contact
  // details in prompts (that's exactly what classify does) AND available credits.
  const aiImportAllowed = prefs.aiEnabled && prefs.aiUsePersonalInfo && !outOfCredits;

  const [status, setStatus] = useState<'loading' | 'denied' | 'ready'>('loading');
  // iOS lets the user grant *limited* contacts access (a hand-picked subset);
  // getContactsAsync then only ever returns that subset. We surface this so the
  // user can widen the selection instead of being silently stuck with it.
  const [access, setAccess] = useState<'all' | 'limited'>('all');
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [hideImported, setHideImported] = useState(false);
  const [method, setMethod] = useState<Method>('ai');
  // Web-search enrichment of professionals is opt-in (spec: ai-assistant.md).
  const [enrich, setEnrich] = useState(false);
  const [applyMode, setApplyMode] = useState<ApplyMode>('review');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read the device address book and map it into rows, flagging already-imported
  // contacts. Re-callable after the user widens limited access, preserving any
  // in-progress selections/tags across the reload.
  const loadContacts = useCallback(async () => {
    const { data } = await Contacts.getContactsAsync({
      fields: [
        Contacts.Fields.Name,
        Contacts.Fields.FirstName,
        Contacts.Fields.LastName,
        Contacts.Fields.PhoneNumbers,
        Contacts.Fields.Emails,
        Contacts.Fields.Birthday,
        Contacts.Fields.Company,
      ],
    });
    // Device ids of contacts already pulled in, so we can flag re-imports.
    const existing = qc.getQueryData<Person[]>(['people']) || [];
    const imported = new Set(existing.map((p) => p.deviceContactId).filter(Boolean) as string[]);

    const mapped: Row[] = data
      .filter((c) => c.name)
      .map((c) => {
        const bd = c.birthday;
        const birthday =
          bd && bd.year && bd.month != null && bd.day
            ? `${bd.year}-${String(bd.month + 1).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`
            : undefined;
        const key = c.id ?? c.name!;
        const phones = (c.phoneNumbers ?? [])
          .map((p) => ({ label: (p.label || 'mobile').toLowerCase(), value: p.number || '' }))
          .filter((p) => p.value);
        const emails = (c.emails ?? [])
          .map((e) => ({ label: (e.label || 'home').toLowerCase(), value: e.email || '' }))
          .filter((e) => e.value);
        return {
          key,
          name: c.name!,
          firstName: c.firstName || undefined,
          lastName: c.lastName || undefined,
          phone: phones[0]?.value,
          email: emails[0]?.value,
          phones: phones.length ? phones : undefined,
          emails: emails.length ? emails : undefined,
          birthday,
          company: (c as any).company || undefined,
          selected: false,
          type: 'friend' as const,
          alreadyImported: imported.has(key),
        };
      });
    // Carry over selection + manual tag for contacts that were already in the
    // list (so widening access doesn't reset a partly-built selection).
    setRows((prev) => {
      const prior = new Map(prev.map((r) => [r.key, r]));
      return mapped.map((r) => {
        const old = prior.get(r.key);
        return old ? { ...r, selected: old.selected, type: old.type } : r;
      });
    });
  }, [qc]);

  useEffect(() => {
    (async () => {
      const perm = await Contacts.requestPermissionsAsync();
      if (perm.status !== 'granted') {
        setStatus('denied');
        return;
      }
      // accessPrivileges is iOS-only ('all' | 'limited'); Android omits it → 'all'.
      setAccess(perm.accessPrivileges === 'limited' ? 'limited' : 'all');
      await loadContacts();
      setStatus('ready');
    })();
  }, [loadContacts]);

  // iOS 18+: re-present Apple's contact picker so the user can add contacts to
  // the shared set without leaving the app, then re-read. Older iOS / Android
  // have no in-app picker, so fall back to the system Settings deep-link.
  const chooseMore = useCallback(async () => {
    const present = (Contacts as any).presentAccessPickerAsync;
    if (typeof present !== 'function') {
      Linking.openSettings();
      return;
    }
    try {
      await present();
      await loadContacts();
    } catch {
      Linking.openSettings();
    }
  }, [loadContacts]);

  // Fall back to Direct if consent is revoked or credits run out (or either
  // resolves late after mount).
  useEffect(() => {
    if (!aiImportAllowed && method === 'ai') setMethod('direct');
  }, [aiImportAllowed, method]);

  // Out of credits → force the whole import to Direct + Review each: there's no
  // AI to batch-classify, so each contact is confirmed in the form by hand.
  useEffect(() => {
    if (outOfCredits && applyMode !== 'review') setApplyMode('review');
  }, [outOfCredits, applyMode]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) => (!q || r.name.toLowerCase().includes(q)) && (!hideImported || !r.alreadyImported)
    );
  }, [rows, search, hideImported]);

  const importedCount = rows.filter((r) => r.alreadyImported).length;
  const selected = rows.filter((r) => r.selected);
  const selectedCount = selected.length;
  const dupCount = selected.filter((r) => r.alreadyImported).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => r.selected);

  function setRow(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function toggleAll() {
    const next = !allFilteredSelected;
    const keys = new Set(filtered.map((r) => r.key));
    setRows((rs) => rs.map((r) => (keys.has(r.key) ? { ...r, selected: next } : r)));
  }

  // Turn selected rows into prefills — via the AI classifier or a direct 1:1 map.
  async function buildPrefills(): Promise<PersonPrefill[]> {
    if (method === 'direct' || !aiImportAllowed) {
      return selected.map((r) => ({
        type: r.type,
        name: r.name,
        firstName: r.firstName,
        lastName: r.lastName,
        birthday: r.birthday,
        phone: r.phone,
        email: r.email,
        phones: r.phones,
        emails: r.emails,
        company: r.company,
        deviceContactId: r.key,
      }));
    }
    const contacts: ImportContact[] = selected.map((r) => ({
      key: r.key,
      name: r.name,
      phone: r.phone,
      email: r.email,
      birthday: r.birthday,
      company: r.company,
    }));
    const { data } = await peopleApi.classify(contacts, enrich);
    const byKey = new Map(data.results.map((c) => [c.key, c]));
    return selected.map((r) => {
      const c = byKey.get(r.key);
      const name = c?.name || r.name;
      // Keep the device's structured first/last only when the classifier didn't
      // rewrite the name; if it did, let the form split the new name instead.
      const structured = name === r.name ? { firstName: r.firstName, lastName: r.lastName } : {};
      return {
        type: c?.type ?? 'friend',
        name,
        ...structured,
        relationship: c?.relationship,
        businessName: c?.businessName,
        company: c?.businessName || r.company,
        birthday: c?.birthday || r.birthday,
        address: c?.address,
        notes: c?.notes,
        phone: c?.phone || r.phone,
        email: c?.email || r.email,
        // Keep the full device multi-value lists; the classifier only ever
        // returns a single primary phone/email.
        phones: r.phones,
        emails: r.emails,
        deviceContactId: r.key,
      };
    });
  }

  async function proceed() {
    if (!selectedCount) return;
    setBusy(true);
    try {
      const prefills = await buildPrefills();
      if (applyMode === 'review') {
        // Step through the person form for each, starting at the first.
        nav.replace('PersonForm', { prefills, queueIndex: 0 });
        return;
      }
      await peopleApi.bulk(prefills.map((p) => ({ ...p })));
      qc.invalidateQueries({ queryKey: ['people'] });
      nav.goBack();
    } catch (e: any) {
      Alert.alert('Import failed', e?.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onConfirm() {
    if (dupCount > 0) {
      Alert.alert(
        'Possible duplicates',
        `${dupCount} of the selected contact${dupCount !== 1 ? 's were' : ' was'} already imported before. Import ${dupCount !== 1 ? 'them' : 'it'} again anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Import anyway', onPress: proceed },
        ]
      );
      return;
    }
    proceed();
  }

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (status === 'denied') {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={40} color={colors.textMuted} />
        <Text style={styles.deniedText}>
          Contacts access is off. Enable it in Settings to import family and friends.
        </Text>
        <View style={styles.deniedAction}>
          <Button title="Open Settings" variant="ghost" onPress={() => Linking.openSettings()} />
        </View>
      </View>
    );
  }

  const busyLabel =
    method === 'ai' && aiImportAllowed && applyMode !== 'review'
      ? `${ASSISTANT_NAME} is sorting…`
      : applyMode === 'review'
      ? `Review ${selectedCount}`
      : `Import ${selectedCount} contact${selectedCount !== 1 ? 's' : ''}`;

  // One-line summary of the current import configuration for the footer chip
  // that opens the options sheet.
  const usingAi = aiImportAllowed && method === 'ai';
  const optionsSummary = `${usingAi ? 'AI-assisted' : 'Direct'} · ${
    applyMode === 'review' ? 'Review each' : 'Import all'
  }${usingAi && enrich ? ' · Web lookup' : ''}`;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Input value={search} onChangeText={setSearch} placeholder="Search contacts" style={styles.search} />
        <View style={styles.toolbarRow}>
          <TouchableOpacity onPress={toggleAll}>
            <Text style={styles.selectAll}>{allFilteredSelected ? 'Deselect all' : 'Select all'}</Text>
          </TouchableOpacity>
          {importedCount > 0 ? (
            <TouchableOpacity
              onPress={() => setHideImported((v) => !v)}
              style={styles.hideToggle}
              accessibilityRole="switch"
              accessibilityState={{ checked: hideImported }}
            >
              <Ionicons
                name={hideImported ? 'checkbox' : 'square-outline'}
                size={18}
                color={hideImported ? colors.primary : colors.textMuted}
              />
              <Text style={styles.hideToggleLabel}>Hide imported</Text>
            </TouchableOpacity>
          ) : null}
          <Text style={styles.count}>{selectedCount} selected</Text>
        </View>
      </View>

      {access === 'limited' ? (
        <View style={styles.banner}>
          <Ionicons name="information-circle-outline" size={20} color={colors.primary} />
          <View style={styles.bannerBody}>
            <Text style={styles.bannerText}>
              You've shared only some contacts with {ASSISTANT_NAME}. Add more to import them here.
            </Text>
            <View style={styles.bannerActions}>
              <TouchableOpacity onPress={chooseMore}>
                <Text style={styles.bannerLink}>Choose more contacts</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openSettings()}>
                <Text style={styles.bannerLinkMuted}>Full access in Settings</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => setRow(item.key, { selected: !item.selected })}
            activeOpacity={0.6}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.selected }}
          >
            <Ionicons
              name={item.selected ? 'checkbox' : 'square-outline'}
              size={22}
              color={item.selected ? colors.primary : colors.textMuted}
              style={styles.check}
            />
            <View style={styles.rowText}>
              <View style={styles.rowNameLine}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.alreadyImported ? <Text style={styles.importedBadge}>Imported</Text> : null}
              </View>
              <Text style={styles.rowSub} numberOfLines={1}>
                {[item.company, item.phone, item.email, item.birthday ? `🎂 ${item.birthday}` : null]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>No contacts found.</Text>}
      />

      <View style={styles.footer}>
        {dupCount > 0 ? (
          <Text style={styles.dupWarn}>
            {dupCount} selected already imported — importing again may create duplicates.
          </Text>
        ) : null}
        <TouchableOpacity
          style={styles.optionsBar}
          onPress={() => setOptionsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Import options"
        >
          <Ionicons name="options-outline" size={16} color={colors.textMuted} />
          <Text style={styles.optionsBarText} numberOfLines={1}>
            {optionsSummary}
          </Text>
          <Ionicons name="chevron-up" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <Button title={busyLabel} onPress={onConfirm} loading={busy} disabled={selectedCount === 0} />
      </View>

      <BottomSheet visible={optionsOpen} onClose={() => setOptionsOpen(false)} title="Import options">
        {aiImportAllowed ? (
          <>
            <Text style={styles.sheetLabel}>Method</Text>
            <SegmentedControl
              value={method}
              options={[
                { label: 'AI-assisted', value: 'ai' },
                { label: 'Direct', value: 'direct' },
              ]}
              onChange={(v) => setMethod(v as Method)}
            />
            <Text style={styles.sheetHint}>
              {method === 'ai'
                ? `${ASSISTANT_NAME} sorts each into Family / Friends / Professionals from names and companies only — phone numbers, emails, and birthdays stay on your device.`
                : 'Tag each contact yourself; details come straight from your phone.'}
            </Text>
          </>
        ) : (
          <Text style={styles.sheetHint}>
            {outOfCredits
              ? "AI-assisted sorting is off because you're out of AI credits. Tag each contact yourself; details come straight from your phone."
              : `AI-assisted sorting is off because ${
                  prefs.aiEnabled ? '“Use personal & contact info in prompts” is' : '“Use AI features” is'
                } turned off in Privacy & security. Tag each contact yourself; details come straight from your phone.`}
          </Text>
        )}

        {aiImportAllowed && method === 'ai' ? (
          <>
            <SwitchRow
              label="Look up professionals on the web"
              value={enrich}
              onValueChange={setEnrich}
              color={colors.primary}
            />
            <Text style={styles.sheetHint}>
              {enrich
                ? 'Business names, addresses, and phone numbers may be sent to a web search to verify and complete professional contacts.'
                : 'Professionals are sorted without any web lookup — nothing about them leaves the AI request.'}
            </Text>
          </>
        ) : null}

        <Text style={[styles.sheetLabel, styles.sheetLabelSpaced]}>Apply</Text>
        {outOfCredits ? (
          <Text style={styles.sheetHint}>
            Without AI credits, each contact is reviewed in the form before saving.
          </Text>
        ) : (
          <>
            <SegmentedControl
              value={applyMode}
              options={[
                { label: 'Review each', value: 'review' },
                { label: 'Import all', value: 'auto' },
              ]}
              onChange={(v) => setApplyMode(v as ApplyMode)}
            />
            <Text style={styles.sheetHint}>
              {applyMode === 'review'
                ? 'Open each contact in the form to review before saving.'
                : 'Save every selected contact at once, without review.'}
            </Text>
          </>
        )}

        <View style={styles.sheetDone}>
          <Button title="Done" onPress={() => setOptionsOpen(false)} />
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  deniedText: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.md, lineHeight: 20 },
  deniedAction: { marginTop: spacing.lg },
  toolbar: { padding: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  banner: {
    flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: colors.primary + '12',
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  bannerBody: { flex: 1 },
  bannerText: { fontSize: 13, color: colors.text, lineHeight: 18 },
  bannerActions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  bannerLink: { fontSize: 13, fontWeight: '700', color: colors.primary },
  bannerLinkMuted: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  hideToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hideToggleLabel: { fontSize: 13, color: colors.textMuted },
  search: { marginBottom: 0, marginTop: spacing.xs },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  selectAll: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  count: { color: colors.textMuted, fontSize: 13 },
  list: { padding: spacing.md },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 12, padding: spacing.sm, marginBottom: spacing.sm,
  },
  check: { padding: 4 },
  rowText: { flex: 1, minWidth: 0, marginLeft: spacing.sm },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowName: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  importedBadge: {
    fontSize: 10, fontWeight: '700', color: colors.warning,
    backgroundColor: colors.warning + '22', paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: 5, overflow: 'hidden',
  },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl },
  footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  dupWarn: { fontSize: 12, color: colors.warning, marginBottom: spacing.sm, textAlign: 'center' },
  optionsBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm, marginBottom: spacing.sm,
  },
  optionsBarText: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
  sheetLabel: { fontSize: 13, fontWeight: '700', color: colors.textMuted, marginBottom: spacing.xs },
  sheetLabelSpaced: { marginTop: spacing.md },
  sheetHint: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.xs },
  sheetDone: { marginTop: spacing.lg },
});
