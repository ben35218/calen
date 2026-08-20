import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, FlatList, StyleSheet, TouchableOpacity, Alert, AppState, Linking, Switch } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
// expo-contacts 56 deprecated its function API on the package root; the same
// functions (getContactsAsync/requestPermissionsAsync/Fields) live under /legacy.
import * as Contacts from 'expo-contacts/legacy';
import { contactsApi, ImportContact, Contact } from '../../api';
import { openRecord } from '../../lib/e2ee';
import { buildImportedMatcher } from '../../lib/contactFields';
import { canonicalizePhoneForStorage } from '../../lib/phone';
import { BottomSheet, Button, EmptyState, HeaderIconButton, Input, SkeletonList } from '../../components/ui';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { useBilling } from '../../hooks/useBilling';
import { ASSISTANT_NAME } from '../../config';
import { colors, radius, spacing } from '../../theme';
import type { ContactPrefill } from '../../navigation/types';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type Nav = NativeStackNavigationProp<ProfileStackParamList>;
type Rt = RouteProp<ProfileStackParamList, 'ContactImport'>;
type Method = 'direct' | 'ai';
type ApplyMode = 'auto' | 'review';

// Below this many device contacts the list is scannable at a glance, so the
// search field is dropped rather than sitting there as dead chrome.
const SEARCH_MIN_ROWS = 10;

// expo-contacts 56.0.9's in-app access picker (`presentAccessPickerAsync`) is
// unusable on device, so "Choose more contacts" deep-links to Settings instead.
// Two native defects, neither of which has a JS-side workaround:
//
//  1. `ContactAccessPicker.present` mounts a `UIHostingController` and adds its
//     view as a full-screen subview of the current view controller. That view's
//     background is opaque, and it is only hidden because Apple's picker sheet
//     sits on top of it — so the moment the sheet stops covering it (the
//     keyboard animating in when you type in the picker's search field) the app
//     is replaced by a black rectangle.
//  2. The hosting controller is tracked in a **static** that is cleared only by
//     the picker's completion handler. Abandon that black screen and the static
//     stays set for the life of the process, so every later call rejects with
//     `AccessPickerAlreadyPresentedException` — the in-app picker is dead until
//     the app is force-quit, and the catch below silently redirects to Settings.
//
// The Settings route is reliable and, with the foreground re-read below, now
// picks up the widened selection on return. Flip this back on once upstream
// fixes both (expo/expo — no fix as of 56.0.9).
const IN_APP_ACCESS_PICKER = false;

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
  // Professionals — so a two-way switch was misleading); the default is seeded
  // from the roster tab the import was launched from, and the type is set per
  // contact in the Review-each form's Type field, or left at this default for
  // Import-all.
  type: 'family' | 'friend' | 'service';
  alreadyImported: boolean;
};

// The mobile-native equivalent of the retired web client's .vcf import. Reads the device
// address book, then offers two paths — Direct (you tag each) or AI-assisted
// (Calen categorizes + pre-fills, web-searching professionals) — and lets you
// import everything at once or review each in the contact form first.
//
// AI-assisted classification necessarily ships contact names/companies to the
// model, so it is consent-gated (spec: ai-assistant.md) on BOTH the AI master
// switch and the "personal & contact info in prompts" toggle. With either off,
// only Direct import is offered — the app never surfaces an AI path the server
// (requireAiEnabled) would reject or that the user has opted out of.
export default function ContactImportScreen() {
  const nav = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  // Default classification for imported contacts, seeded from the roster tab the
  // user launched import from (Family / Friends / Professionals).
  const defaultType: Row['type'] = params?.type ?? 'friend';
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
  // Default to hiding already-imported contacts so the list opens focused on
  // what's left to add. The toggle is always shown so the user can reveal them.
  const [hideImported, setHideImported] = useState(true);
  // Default to Direct — the plain "you pick, details come straight from the
  // phone" path — rather than opening on AI-assisted.
  const [method, setMethod] = useState<Method>('direct');
  const [applyMode, setApplyMode] = useState<ApplyMode>('review');
  const [optionsOpen, setOptionsOpen] = useState(false);
  // "How importing works" lives behind the header ⓘ rather than as standing
  // prose above the list — the list is the screen, and two stacked explainer
  // bands were pushing it off the bottom of a small phone.
  const [aboutOpen, setAboutOpen] = useState(false);
  // Each option switch's explanation stays hidden behind an info button until
  // the user asks to see it (progressive disclosure).
  const [reviewHintShown, setReviewHintShown] = useState(false);
  const [aiHintShown, setAiHintShown] = useState(false);
  const [busy, setBusy] = useState(false);
  // Guards the one-shot auto-select for limited access below.
  const autoSelectedRef = useRef(false);

  // With the in-app picker disabled, "choose more" and "full access" both just
  // open Settings — so the limited-access UI collapses to a single action.
  // Offering two links that do exactly the same thing reads as a bug.
  const canPickInApp =
    IN_APP_ACCESS_PICKER && typeof (Contacts as any).presentAccessPickerAsync === 'function';

  // Non-accented area, so the header action is a transparent white icon rather
  // than a primary-coloured disc (mobile/CLAUDE.md's header-action rule).
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <HeaderIconButton
          icon="information-circle-outline"
          size={24}
          accessibilityLabel="About importing"
          onPress={() => setAboutOpen(true)}
        />
      ),
    });
  }, [nav]);

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
    // The decrypted roster, for flagging re-imports. Ensure it's actually
    // loaded (same queryFn as the Contacts list) rather than trusting the shared
    // cache — this screen can be reached before the roster has ever fetched, and
    // an empty cache read would silently flag nothing. A failed fetch (offline)
    // degrades to whatever is cached.
    const existing = await qc
      .ensureQueryData<Contact[]>({
        queryKey: ['contacts'],
        queryFn: async () => {
          const contacts = (await contactsApi.list()).data;
          return Promise.all(contacts.map((p) => openRecord('Contact', p)));
        },
      })
      .catch(() => qc.getQueryData<Contact[]>(['contacts']) || []);
    // Matches by the stored deviceContactId link, falling back to phone/email/
    // name identity — roster contacts imported before the link existed (or added
    // by hand) carry no deviceContactId and would otherwise never be flagged.
    const isImported = buildImportedMatcher(existing);

    const mapped: Row[] = data
      .filter((c) => c.name)
      .map((c) => {
        const bd = c.birthday;
        const birthday =
          bd && bd.year && bd.month != null && bd.day
            ? `${bd.year}-${String(bd.month + 1).padStart(2, '0')}-${String(bd.day).padStart(2, '0')}`
            : undefined;
        const key = c.id ?? c.name!;
        // Canonicalize to the E.164 storage form (same as the account phone) at
        // import so a contact's number can later resolve an invite by exact
        // match — the device address book hands us free-form national numbers.
        const phones = (c.phoneNumbers ?? [])
          .map((p) => ({ label: (p.label || 'mobile').toLowerCase(), value: canonicalizePhoneForStorage(p.number || '') }))
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
          type: defaultType,
          alreadyImported: isImported({ key, name: c.name!, phones, emails }),
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
  }, [qc, defaultType]);

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

  // Widen the shared set. The in-app picker is disabled (see
  // IN_APP_ACCESS_PICKER above), so this deep-links to Settings → Calen →
  // Contacts; the foreground listener below is what brings the result back.
  const chooseMore = useCallback(async () => {
    const present = (Contacts as any).presentAccessPickerAsync;
    if (!IN_APP_ACCESS_PICKER || typeof present !== 'function') {
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

  // Access is widened *outside* the app — in Settings, or via the system
  // picker — so returning to the foreground is the only signal we get that the
  // shared set may have changed. Without this the newly shared contacts don't
  // show up until the screen is popped and pushed again, and `access` stays
  // 'limited' even after the user switches to full access. Re-read the
  // privileges too, not just the contacts: the limited-access footnote and
  // empty-state CTA both key off it.
  const refreshAccess = useCallback(async () => {
    // getPermissionsAsync, never request — this fires on every foreground and
    // must not re-prompt.
    const perm = await Contacts.getPermissionsAsync();
    if (perm.status !== 'granted') {
      setStatus('denied');
      return;
    }
    setAccess(perm.accessPrivileges === 'limited' ? 'limited' : 'all');
    await loadContacts();
    setStatus('ready');
  }, [loadContacts]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshAccess();
    });
    return () => sub.remove();
  }, [refreshAccess]);

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

  // First import with only LIMITED contacts access (iOS: a hand-picked subset):
  // the user already chose exactly whom to share, so pre-select all of them to
  // save a "select all" tap. One-shot (a later manual deselect must stick) and
  // only when nothing has been imported yet.
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (status !== 'ready' || access !== 'limited' || !rows.length) return;
    if (rows.some((r) => r.alreadyImported)) return;
    autoSelectedRef.current = true;
    setRows((rs) => rs.map((r) => ({ ...r, selected: true })));
  }, [status, access, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) => (!q || r.name.toLowerCase().includes(q)) && (!hideImported || !r.alreadyImported)
    );
  }, [rows, search, hideImported]);

  // A search field over three contacts is pure chrome, and under iOS limited
  // access a shared subset that small is the norm. Gate on the raw row count,
  // never the filtered one — filtering on a typed query would pull the field
  // out from under the user mid-search.
  const showSearch = rows.length >= SEARCH_MIN_ROWS;

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

  // An empty list has three distinct causes and a different fix for each, so a
  // single "No contacts found." pointed the user at the wrong thing — most
  // often under limited access, where the fix (Choose Contacts) was stranded in
  // a banner above the message. Each state names its own way out.
  function renderEmpty() {
    if (search.trim()) {
      return (
        <EmptyState
          icon="search-outline"
          title="No matches"
          message={`No contacts match “${search.trim()}”.`}
        />
      );
    }
    // Nothing left to show while rows exist means Hide imported swallowed them.
    const allImported = rows.length > 0;
    if (access === 'limited') {
      return (
        <EmptyState
          icon="people-outline"
          title={allImported ? 'Nothing left to import' : 'Only some contacts shared'}
          message={
            allImported
              ? `Every contact you've shared with ${ASSISTANT_NAME} is already in your roster. Share more to import them.`
              : canPickInApp
                ? `${ASSISTANT_NAME} can only see the contacts you picked in iOS. Choose more to import them here.`
                : `${ASSISTANT_NAME} can only see the contacts you picked in iOS. In Settings you can share more of them, or switch to full access.`
          }
          actionLabel={canPickInApp ? 'Choose Contacts' : 'Open Settings'}
          onAction={chooseMore}
        >
          {canPickInApp ? (
            <TouchableOpacity
              onPress={() => Linking.openSettings()}
              accessibilityRole="button"
              style={styles.emptyLink}
            >
              <Text style={styles.mutedLink}>Full access in Settings</Text>
            </TouchableOpacity>
          ) : null}
        </EmptyState>
      );
    }
    if (allImported) {
      return (
        <EmptyState
          icon="checkmark-circle-outline"
          title="Nothing left to import"
          message="Every contact on this device is already in your roster. Turn off Hide imported to see them."
        />
      );
    }
    return (
      <EmptyState
        icon="people-outline"
        title="No contacts found"
        message="There are no contacts in this device's address book."
      />
    );
  }

  // Turn selected rows into prefills — via the AI classifier or a direct 1:1 map.
  async function buildPrefills(): Promise<ContactPrefill[]> {
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
    // Choosing AI-assisted cleanup implies the professional web lookup — no
    // separate opt-in toggle (spec: ai-assistant.md); the sheet hint discloses it.
    const { data } = await contactsApi.classify(contacts, true);
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
        // The classifier / web lookup may return a differently-formatted primary
        // number — canonicalize it too (device phones in r.phones are already
        // canonical from the mapping step above).
        phone: c?.phone ? canonicalizePhoneForStorage(c.phone) : r.phone,
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
        // Step through the contact form for each, starting at the first. Flag an
        // AI-assisted review so the form keeps the "Ask Calen" panel; a Direct
        // import hides it (nothing to re-derive — details came from the phone).
        nav.replace('ContactForm', { prefills, queueIndex: 0, aiReview: method === 'ai' && aiImportAllowed });
        return;
      }
      await contactsApi.bulk(prefills.map((p) => ({ ...p })));
      qc.invalidateQueries({ queryKey: ['contacts'] });
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
    return <SkeletonList />;
  }

  if (status === 'denied') {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={40} color={colors.textMuted} />
        <Text style={styles.deniedText}>
          Contacts access is off. Turning it on just lets you pick which contacts to
          import — nothing is added automatically. Enable it in Settings to choose
          family and friends.
        </Text>
        <View style={styles.deniedAction}>
          <Button title="Open Settings" variant="ghost" onPress={() => Linking.openSettings()} />
        </View>
      </View>
    );
  }

  const busyLabel =
    applyMode === 'review'
      ? `Review ${selectedCount}`
      : `Import ${selectedCount} contact${selectedCount !== 1 ? 's' : ''}`;

  return (
    <View style={styles.container}>
      {/* With no rows at all, both controls are no-ops — the empty state below
          is the whole screen. It stays up when rows merely *filter* to nothing,
          though: Hide imported is what the user needs to reach to undo that. */}
      {rows.length > 0 ? (
      <View style={styles.toolbar}>
        {showSearch ? (
          <Input value={search} onChangeText={setSearch} placeholder="Search contacts" autoCapitalize="none" autoCorrect={false} style={styles.search} />
        ) : null}
        {/* Two controls, not three — the selected count was a duplicate of the
            footer button's own "Review N" label. */}
        <View style={[styles.toolbarRow, !showSearch && styles.toolbarRowBare]}>
          <TouchableOpacity onPress={toggleAll} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
            <Text style={styles.selectAll}>{allFilteredSelected ? 'Deselect all' : 'Select all'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setHideImported((v) => !v)}
            style={styles.hideToggle}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
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
        ListEmptyComponent={renderEmpty()}
        // Limited access is a statement about *which rows exist*, so it travels
        // with the list rather than floating in a pinned banner above it. With
        // rows on screen it heads the list — the user reads why the list is
        // short before scanning it, not after; with none, the empty state
        // carries it instead and the way out becomes the primary CTA.
        ListHeaderComponent={
          access === 'limited' && filtered.length > 0 ? (
            <View style={styles.limitedNote}>
              <Text style={styles.limitedNoteText}>
                {`${ASSISTANT_NAME} can only see the ${rows.length} contact${rows.length !== 1 ? 's' : ''} you shared.`}
              </Text>
              <View style={styles.limitedActions}>
                <TouchableOpacity onPress={chooseMore} accessibilityRole="button" style={styles.limitedAction}>
                  <Ionicons
                    name={canPickInApp ? 'person-add-outline' : 'settings-outline'}
                    size={16}
                    color={colors.primary}
                  />
                  <Text style={styles.limitedLink}>
                    {canPickInApp ? 'Choose more contacts' : 'Manage in Settings'}
                  </Text>
                </TouchableOpacity>
                {canPickInApp ? (
                  <TouchableOpacity
                    onPress={() => Linking.openSettings()}
                    accessibilityRole="button"
                    style={styles.limitedAction}
                  >
                    <Ionicons name="settings-outline" size={16} color={colors.textMuted} />
                    <Text style={styles.mutedLink}>Full access in Settings</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ) : null
        }
      />

      <View style={styles.footer}>
        {dupCount > 0 ? (
          <Text style={styles.dupWarn}>
            {dupCount} selected already imported — importing again may create duplicates.
          </Text>
        ) : null}
        {/* One line, not two stacked bars: the commit action takes the width it
            needs and the set-once options sit beside it as an icon. */}
        <View style={styles.footerRow}>
          <View style={styles.footerPrimary}>
            <Button title={busyLabel} onPress={onConfirm} loading={busy} disabled={selectedCount === 0} />
          </View>
          <TouchableOpacity
            style={styles.optionsBtn}
            onPress={() => setOptionsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Import options"
          >
            <Ionicons name="options-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      <BottomSheet visible={aboutOpen} onClose={() => setAboutOpen(false)} title="About importing">
        <Text style={styles.sheetHint}>
          {`Nothing is imported automatically — pick the contacts you want, then tap the button at the bottom to add just those to ${ASSISTANT_NAME}.`}
        </Text>
        {access === 'limited' ? (
          <Text style={styles.sheetHint}>
            {canPickInApp
              ? `You've shared only some of your contacts with ${ASSISTANT_NAME}, so only those can appear in this list. Choose more, or switch to full access in Settings, to import anyone else.`
              : `You've shared only some of your contacts with ${ASSISTANT_NAME}, so only those can appear in this list. To import anyone else, open Settings → ${ASSISTANT_NAME} → Contacts, where you can share more of them or switch to full access. The list updates as soon as you come back.`}
          </Text>
        ) : null}
        <View style={styles.sheetDone}>
          <Button title="Done" onPress={() => setAboutOpen(false)} />
        </View>
      </BottomSheet>

      <BottomSheet visible={optionsOpen} onClose={() => setOptionsOpen(false)} title="Import options">
        {outOfCredits ? (
          <Text style={styles.sheetHint}>
            Without AI credits, each contact is reviewed in the form before saving.
          </Text>
        ) : (
          <>
            <View style={styles.switchInfoRow}>
              <View style={styles.switchInfoLabelWrap}>
                <Text style={styles.switchInfoLabel}>Review contact info</Text>
                <TouchableOpacity
                  onPress={() => setReviewHintShown((s) => !s)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="About reviewing contact info"
                  accessibilityState={{ expanded: reviewHintShown }}
                >
                  <Ionicons
                    name={reviewHintShown ? 'information-circle' : 'information-circle-outline'}
                    size={18}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
              <Switch
                value={applyMode === 'review'}
                onValueChange={(v) => setApplyMode(v ? 'review' : 'auto')}
                trackColor={{ true: colors.primary }}
              />
            </View>
            {reviewHintShown ? (
              <Text style={styles.sheetHint}>
                Open each contact in the form to review before saving. Turn off to save every selected contact at once, without review.
              </Text>
            ) : null}
          </>
        )}

        {aiImportAllowed ? (
          <>
            <View style={styles.switchInfoRow}>
              <View style={styles.switchInfoLabelWrap}>
                <Text style={styles.switchInfoLabel}>AI Assistant</Text>
                <TouchableOpacity
                  onPress={() => setAiHintShown((s) => !s)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="About the AI Assistant"
                  accessibilityState={{ expanded: aiHintShown }}
                >
                  <Ionicons
                    name={aiHintShown ? 'information-circle' : 'information-circle-outline'}
                    size={18}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
              <Switch
                value={method === 'ai'}
                onValueChange={(v) => setMethod(v ? 'ai' : 'direct')}
                trackColor={{ true: colors.primary }}
              />
            </View>
            {aiHintShown ? (
              <Text style={styles.sheetHint}>
                {`${ASSISTANT_NAME} cleans up and sorts each contact into Family / Friends / Professionals from names and companies only — phone numbers, emails, and birthdays stay on your device. Business names, addresses, and phone numbers may be sent to a web search to verify and complete professional contacts.`}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.sheetHint}>
            {outOfCredits
              ? "AI assistant is off because you're out of AI credits."
              : `AI assistant is off because ${
                  prefs.aiEnabled ? '“Use personal & contact info in prompts” is' : '“Use AI features” is'
                } turned off in Privacy & Security.`}
          </Text>
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
  // Tight: the toolbar is chrome above the real content, so it takes the least
  // height that still leaves both controls comfortably tappable (hitSlop makes
  // up the touch target the padding no longer provides).
  toolbar: {
    paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  hideToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hideToggleLabel: { fontSize: 13, color: colors.textMuted },
  search: { marginBottom: 0, marginTop: 0 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  // No search field above it → no gap to close.
  toolbarRowBare: { marginTop: 0 },
  selectAll: { color: colors.primary, fontWeight: '600', fontSize: 14 },
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
  emptyLink: { marginTop: spacing.md, paddingVertical: spacing.xs },
  mutedLink: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  // The limited-access note, heading the list above the first contact row.
  limitedNote: { paddingBottom: spacing.md },
  limitedNoteText: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  // Stacked, not side by side: "Full access in Settings" ran off the edge of a
  // narrow screen when both links shared a row.
  limitedActions: { gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start' },
  limitedAction: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  limitedLink: { fontSize: 13, fontWeight: '700', color: colors.primary },
  footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  dupWarn: { fontSize: 12, color: colors.warning, marginBottom: spacing.sm, textAlign: 'center' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  footerPrimary: { flex: 1 },
  // Square, matching the primary button's height so the footer reads as one row.
  optionsBtn: {
    width: 48, height: 48, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background,
  },
  sheetHint: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: spacing.xs },
  switchInfoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  switchInfoLabelWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: spacing.md },
  switchInfoLabel: { fontSize: 15, color: colors.text },
  sheetDone: { marginTop: spacing.lg },
});
