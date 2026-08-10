import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Alert, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, householdApi, invitationsApi, peopleApi, EventInvitation, HouseholdMember, Person } from '../../api';
import {
  Badge, HintDisclosure, Input, RevealWrap, Screen, SectionHeader, SwitchRow,
  useHeaderCheckButton,
} from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import {
  getQueuedInvitees, setQueuedInvitees, useDraftGuestListVisible, setDraftGuestListVisible,
  getQueuedHouseholdInvitees, setQueuedHouseholdInvitees,
} from '../../lib/inviteeDraft';
import { notifyHouseholdInvitees, rsvpsForEvent } from '../../lib/householdRsvp';
import { useCalendarColors, useCustomCalendars } from '../../lib/calendarPrefs';
import {
  InviteeEntry, inviteeKey, normalizePhone, composeSmsInvite, sendInvitations, eventInviteEmailContent,
} from '../../lib/invitees';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { normalizePerson, NormalizedPerson } from '../../lib/personFields';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { openRecord } from '../../lib/e2ee';
import { useAuth } from '../../store/auth';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Rt = RouteProp<CalendarStackParamList, 'EventInvitees'>;

// Manage who is invited to one event, reached from the Invitees card on the
// event form. ONE input takes both channels: each return keystroke parses the
// text — pieces with an @ are emails, anything else must read as a phone
// number — and stages it in the New section. Nothing sends until the header ✓:
//   - saved event (eventId set): ✓ sends everything at once (emails server-
//     side; texts open the Messages composer one per number, prefilled with
//     the event and its public .ics link);
//   - new-event draft (no eventId): ✓ commits the list to lib/inviteeDraft and
//     EventFormScreen sends it the same way once the event is saved.
// The X close button discards whatever was staged this visit. The "Guests can
// see guest list" switch lives here too: a draft commits it with the event's
// save, a saved event applies it immediately on toggle. The list is
// grouped by where each invitee stands: New (not sent yet), Received (sent,
// awaiting reply — SMS invites live here for good, replies to a text never
// come back through the app), Accepted, Declined (incl. accepted-then-left).
// The event snapshot rides in as a route param — it's the decrypted form
// content, which the server can't derive from an E2EE event.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Row icons are ~20px; pad the touch target out to Apple's 44px guideline.
const HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

// Parse the field: split on commas/semicolons/newlines; a piece containing an
// @ is an email (a space-separated run of them is fine), anything else must
// normalize as a phone number. Pieces that are neither come back as invalid.
function parseInvitees(text: string): { entries: InviteeEntry[]; invalid: string[] } {
  const entries: InviteeEntry[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    if (piece.includes('@')) {
      for (const token of piece.split(/\s+/)) {
        const email = token.toLowerCase();
        if (EMAIL_RE.test(email)) entries.push({ email });
        else invalid.push(token);
      }
    } else {
      const phone = normalizePhone(piece);
      if (phone) entries.push({ phone });
      else invalid.push(piece);
    }
  }
  return { entries, invalid };
}

export default function EventInviteesScreen() {
  const { eventId, snapshot } = useRoute<Rt>().params;
  const navigation = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const qc = useQueryClient();
  const isDraft = !eventId;

  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Mail composer for non-account email invitees (and the per-row Remind) —
  // the mail-app chooser sheet renders at the bottom of this screen.
  const { composeEmail, emailSheet } = useEmailComposer();
  // Entries added this visit, committed/sent only on ✓. A draft starts from
  // the queue so previously added entries can still be removed.
  const [staged, setStaged] = useState<InviteeEntry[]>(() => (isDraft ? getQueuedInvitees() : []));
  // Clean baseline for the unsaved-changes guard: the staged list this visit
  // opened with (a draft starts from the queued invitees; a saved event starts
  // empty). Anything added/removed since — or half-typed in the field — is
  // unsaved and prompts before leaving.
  const initialStaged = useRef(JSON.stringify(isDraft ? getQueuedInvitees() : []));
  const { user } = useAuth();

  // The event's calendar colour tints the inline ✓, same as the event form's
  // header ✓ (calendarPrefs override → custom calendar → theme fallback).
  const cal = useCalendarColors().colors;
  const { calendars: customCalendars } = useCustomCalendars();
  const calColor =
    (snapshot.calendarType && cal[snapshot.calendarType]) ||
    customCalendars.find((c) => c.id === snapshot.calendarType)?.color ||
    colors.primary;

  const inviteesQ = useQuery({
    queryKey: ['invitations', 'sent', eventId],
    queryFn: async () => (await invitationsApi.sentForEvent(eventId!)).data,
    enabled: !isDraft,
  });

  // ── "Your household" section — members asked to accept/decline ────────────
  // Housemates already see every event; selecting one here stamps them into the
  // sealed householdInvitees list, notifies them right away (saved event) or on
  // save (draft), and tracks their accept/decline (per-member EventRsvp records).
  const householdQ = useQuery({
    queryKey: ['household'],
    queryFn: async () => (await householdApi.get()).data,
  });
  const hhMembers = useMemo(
    () => (householdQ.data?.members ?? []).filter((m) => m._id !== user?._id),
    [householdQ.data, user?._id],
  );
  // Their current responses (saved events only — a draft has nothing to answer).
  const rsvpQ = useQuery({
    queryKey: ['calendar', 'rsvps', eventId],
    queryFn: () => rsvpsForEvent(eventId!),
    enabled: !isDraft,
  });
  // Selection: a draft starts from the queued list; a saved event seeds from the
  // decrypted event once it loads (replica rows are already decrypted).
  const [hhSelected, setHhSelected] = useState<string[]>(() => (isDraft ? getQueuedHouseholdInvitees() : []));
  const hhInitial = useRef<string[] | null>(isDraft ? getQueuedHouseholdInvitees() : null);
  const eventQ = useQuery({
    queryKey: ['calendar', 'event', eventId, 'invitees'],
    queryFn: async () => (await calendarApi.getEvent(eventId!)).data,
    enabled: !isDraft,
  });
  useEffect(() => {
    if (isDraft || hhInitial.current !== null || !eventQ.data) return;
    const ids = eventQ.data.householdInvitees ?? [];
    hhInitial.current = ids;
    setHhSelected(ids);
  }, [isDraft, eventQ.data]);
  const toggleMember = (id: string) =>
    setHhSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Contacts (decrypted on-device) back the field's autocomplete.
  const peopleQ = useQuery({
    queryKey: ['people', 'decrypted'],
    queryFn: async () => {
      const rows = (await peopleApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Person', p)));
    },
  });

  // Everyone already staged or sent (plus the user's own email — the server
  // rejects self-invites), so suggestions and adds can skip them.
  const taken = useMemo(() => {
    const set = new Set(
      [...staged.map(inviteeKey), ...(inviteesQ.data ?? []).map((i) => i.toEmail ?? i.toPhone ?? '')].map(
        (e) => e.toLowerCase(),
      ),
    );
    if (user?.email) set.add(user.email.toLowerCase());
    return set;
  }, [staged, inviteesQ.data, user?.email]);

  // What a contact suggestion would stage: their primary email, unless the typed
  // text is digit-y and they have a number (or email is all they're missing).
  // Reads the multi-value fields (via normalizePerson) so contacts stored as
  // emails[]/phones[] arrays — not just the legacy single scalars — resolve.
  const entryFor = (n: NormalizedPerson, queryIsDigits: boolean): InviteeEntry | null => {
    const email = n.emails[0]?.value.trim().toLowerCase();
    const phone = n.phones[0]?.value ? normalizePhone(n.phones[0].value) : null;
    const emailOk = !!email && EMAIL_RE.test(email) && !taken.has(email);
    const phoneOk = !!phone && !taken.has(phone);
    if (queryIsDigits && phoneOk) return { phone: phone! };
    if (emailOk) return { email: email! };
    if (phoneOk) return { phone: phone! };
    return null;
  };

  // Contacts matching the piece being typed (the text after the last comma),
  // by name, or any of their emails/phones.
  const suggestions = useMemo(() => {
    const q = (input.split(/[,;\n]+/).pop() ?? '').trim().toLowerCase();
    if (!q) return [];
    const qDigits = q.replace(/[^\d]/g, '');
    const queryIsDigits = qDigits.length > 0 && qDigits.length >= q.replace(/[\s()+.-]/g, '').length;
    return (peopleQ.data ?? [])
      .map((p: Person) => ({ person: p, n: normalizePerson(p) }))
      .filter(({ person: p, n }) => {
        if (!entryFor(n, queryIsDigits)) return false;
        if ((p.name ?? '').toLowerCase().includes(q)) return true;
        if (n.emails.some((e) => e.value.toLowerCase().includes(q))) return true;
        if (qDigits && n.phones.some((ph) => ph.value.replace(/[^\d]/g, '').includes(qDigits))) return true;
        return false;
      })
      .slice(0, 5)
      .map(({ person, n }) => ({ person, entry: entryFor(n, queryIsDigits)! }));
  }, [peopleQ.data, input, taken]);

  // The inline ✓ inside the field shows once the text parses cleanly — a
  // tap-friendly stand-in for the return key.
  const inputCommittable = useMemo(() => {
    const text = input.trim();
    if (!text) return false;
    const { entries, invalid } = parseInvitees(text);
    return entries.length > 0 && invalid.length === 0;
  }, [input]);

  // Fold the field's current text into the staged list; unparseable pieces
  // stay behind in the field with an error. Returns what ✓ should send.
  const commitInput = (): { ok: boolean; entries: InviteeEntry[] } => {
    const text = input.trim();
    if (!text) return { ok: true, entries: staged };
    const { entries, invalid } = parseInvitees(text);
    const fresh = entries.filter((e) => !taken.has(inviteeKey(e).toLowerCase()));
    const seen = new Set<string>();
    const next = [
      ...staged,
      ...fresh.filter((e) => !seen.has(inviteeKey(e)) && seen.add(inviteeKey(e))),
    ];
    setStaged(next);
    setInput(invalid.join(', '));
    setError(invalid.length ? `Enter an email address or phone number: ${invalid.join(', ')}` : '');
    setSuggestOpen(false);
    return { ok: !invalid.length, entries: next };
  };

  // ✓ — commit the field, then queue (draft) or send (saved event). Entries
  // that fail to send stay staged with the reason, so ✓ can retry just those.
  // Household selection: a draft queues it beside the outside entries; a saved
  // event re-seals householdInvitees now and instantly notifies newly added
  // members (best-effort — the durable channel is their Invitations inbox).
  const onConfirm = async () => {
    const { ok, entries } = commitInput();
    if (!ok) return;
    if (isDraft) {
      setQueuedHouseholdInvitees(hhSelected);
      setQueuedInvitees(entries);
      allowLeave();
      navigation.goBack();
      return;
    }
    const hhBaseline = hhInitial.current ?? [];
    const hhChanged = JSON.stringify(hhSelected) !== JSON.stringify(hhBaseline);
    if (!entries.length && !hhChanged) {
      allowLeave();
      navigation.goBack();
      return;
    }
    setBusy(true);
    try {
      if (hhChanged) {
        await calendarApi.setHouseholdInvitees(eventId!, hhSelected);
        const added = hhSelected.filter((id) => !hhBaseline.includes(id));
        if (added.length) {
          const myName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'A housemate';
          notifyHouseholdInvitees(
            eventId!, added, 'Event invitation',
            `${myName} invited you to “${snapshot.title}” — accept or decline`,
          ).catch(() => {});
        }
        hhInitial.current = hhSelected;
        // Keep the draft store in step: an edit form open beneath this screen
        // re-seals householdInvitees from the store on save (the same
        // guest-list seed-through), so a stale seed would undo this write.
        setQueuedHouseholdInvitees(hhSelected);
      }
      if (!entries.length) {
        allowLeave();
        navigation.goBack();
        return;
      }
      const failures = await sendInvitations(eventId!, entries, snapshot, guestListVisible, composeEmail);
      await qc.invalidateQueries({ queryKey: ['invitations', 'sent', eventId] });
      if (failures.length) {
        setStaged(failures.map((f) => f.entry));
        setError(failures.map((f) => `${inviteeKey(f.entry)}: ${f.error}`).join('\n'));
      } else {
        allowLeave();
        navigation.goBack();
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Could not update household invitees');
    } finally {
      setBusy(false);
    }
  };

  useHeaderCheckButton(navigation, { onPress: onConfirm, loading: busy, color: calColor });

  // Guard the ✕ / back / swipe-back against dropping staged invitees or
  // half-typed text; `allowLeave` above lets ✓ exit without the prompt.
  const dirty =
    JSON.stringify(staged) !== initialStaged.current ||
    !!input.trim() ||
    (hhInitial.current !== null && JSON.stringify(hhSelected) !== JSON.stringify(hhInitial.current));
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  const revoke = useMutation({
    mutationFn: (invitationId: string) => invitationsApi.revoke(invitationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations', 'sent', eventId] }),
    onError: (e: any) => setError(e.response?.data?.error || 'Could not remove the invitee'),
  });

  // Whether invitees can see who else is invited. The live value rides the
  // invitee draft store (EventFormScreen seeds it from the fetched event and
  // sends it with a draft's create payload). On a saved event a toggle saves
  // right away — `guestListVisible` is sealed event content (C3b), so the
  // client re-seals the event rather than PUTting the field plaintext — with
  // no event query invalidation, so the form underneath keeps its unsaved
  // edits.
  const guestListVisible = useDraftGuestListVisible();
  const saveGuestList = useMutation({
    mutationFn: (v: boolean) => calendarApi.setGuestListVisible(eventId!, v),
    onError: (e: any, v) => {
      setDraftGuestListVisible(!v);
      setError(e.response?.data?.error || 'Could not update the guest list setting');
    },
  });
  const toggleGuestList = (v: boolean) => {
    setDraftGuestListVisible(v);
    if (!isDraft) saveGuestList.mutate(v);
  };

  const removeStaged = (entry: InviteeEntry) =>
    setStaged((s) => s.filter((e) => inviteeKey(e) !== inviteeKey(entry)));

  const confirmRevoke = (inv: EventInvitation) => {
    const to = inv.toEmail ?? inv.toPhone;
    Alert.alert(
      'Remove invitee?',
      inv.status === 'accepted'
        ? `The event will be removed from ${to}'s calendar.`
        : `${to} will no longer be able to accept this invitation.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => revoke.mutate(inv._id) },
      ],
    );
  };

  const channelIcon = (isPhone: boolean) => (
    <Ionicons name={isPhone ? 'chatbubble-outline' : 'mail-outline'} size={14} color={colors.textMuted} />
  );

  const memberName = (m: HouseholdMember) =>
    [m.firstName, m.lastName].filter(Boolean).join(' ').trim() || m.email || 'Member';

  const memberRow = (m: HouseholdMember) => {
    const selected = hhSelected.includes(m._id);
    const rsvp = selected ? rsvpQ.data?.[m._id] : undefined;
    return (
      <TouchableOpacity
        key={m._id}
        style={styles.row}
        activeOpacity={0.7}
        disabled={busy}
        onPress={() => toggleMember(m._id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={memberName(m)}
      >
        <View style={styles.memberAvatar}>
          <Text style={styles.memberInitial}>{memberName(m).charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.email} numberOfLines={1}>{memberName(m)}</Text>
        {rsvp ? (
          <Badge
            label={rsvp.status === 'accepted' ? 'Accepted' : 'Declined'}
            color={rsvp.status === 'accepted' ? colors.success : colors.error}
          />
        ) : null}
        <Ionicons
          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={22}
          color={selected ? calColor : colors.textMuted}
        />
      </TouchableOpacity>
    );
  };

  const stagedRow = (entry: InviteeEntry) => (
    <View key={inviteeKey(entry)} style={styles.row}>
      {channelIcon(!!entry.phone)}
      <Text style={styles.email} numberOfLines={1}>{inviteeKey(entry)}</Text>
      {busy ? (
        <ActivityIndicator size="small" color={calColor} style={styles.remove} />
      ) : (
        <TouchableOpacity style={styles.remove} hitSlop={HIT_SLOP} onPress={() => removeStaged(entry)}>
          <Ionicons name="close-circle" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  );

  const sentRow = (inv: EventInvitation) => (
    <View key={inv._id} style={styles.row}>
      {channelIcon(!!inv.toPhone)}
      <Text style={styles.email} numberOfLines={1}>{inv.toEmail ?? inv.toPhone}</Text>
      {/* The section says where things stand; badges only add channel/nuance. */}
      {inv.toPhone && inv.status === 'pending' ? <Badge label="Sent by text" color={colors.textMuted} /> : null}
      {inv.status === 'left' ? <Badge label="Left" color={colors.textMuted} /> : null}
      {inv.toPhone ? (
        <TouchableOpacity
          style={styles.remove}
          hitSlop={HIT_SLOP}
          onPress={() => composeSmsInvite(inv.toPhone!, inv, snapshot).catch((e) => setError(e.message))}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={18} color={calColor} />
        </TouchableOpacity>
      ) : null}
      {/* Remind — re-send a pending email invite from the organizer's own mail
          app (the SMS twin of the resend-text button above). Works for account
          holders too: it's the escape hatch when the push/inbox path wasn't
          noticed (a sealed invite's email is notice-only — no .ics link). */}
      {inv.toEmail && inv.status === 'pending' ? (
        <TouchableOpacity
          style={styles.remove}
          hitSlop={HIT_SLOP}
          onPress={() => composeEmail(inv.toEmail!, eventInviteEmailContent(snapshot, inv)).catch((e) => setError(e.message))}
        >
          <Ionicons name="paper-plane-outline" size={18} color={calColor} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity style={styles.remove} hitSlop={HIT_SLOP} onPress={() => confirmRevoke(inv)}>
        <Ionicons name="close-circle" size={20} color={colors.textMuted} />
      </TouchableOpacity>
    </View>
  );

  const sent = inviteesQ.data ?? [];
  // The guest list is a cross-household concern only — housemates aren't part
  // of it, and it governs nothing until at least one outside person is staged
  // or already invited. Staged counts: the switch must be settable BEFORE the
  // ✓/save that actually sends, since each invitation is stamped with the flag
  // as it goes out.
  const hasOutsideInvitees = staged.length > 0 || sent.length > 0;
  const sections = [
    { title: 'New',      rows: staged.map(stagedRow) },
    { title: 'Received', rows: sent.filter((i) => i.status === 'pending').map(sentRow) },
    { title: 'Accepted', rows: sent.filter((i) => i.status === 'accepted').map(sentRow) },
    { title: 'Declined', rows: sent.filter((i) => i.status === 'declined' || i.status === 'left').map(sentRow) },
  ].filter((s) => s.rows.length);

  return (
    <Screen>
      {/* Two zones, each titled for what it DOES and each carrying its
          explanation behind the ⓘ (mobile/CLAUDE.md: hints are disclosed,
          always — a screen that stacks prose above its controls reads as
          broken). Notifying a housemate and inviting an outsider are different
          acts on different people, so they get separate headings rather than
          one "Invitees" wall. */}
      {hhMembers.length > 0 ? (
        <View style={styles.section}>
          <HintDisclosure
            label="Notify household members"
            labelStyle={styles.sectionHeading}
            hintStyle={styles.zoneHint}
            hint="Housemates already see this event. Selecting someone asks them to accept or decline and notifies them right away — declining doesn’t remove the event from their calendar."
            accessibilityLabel="About notifying household members"
          />
          <GroupCard>
            {hhMembers.map((m, i) => (
              <React.Fragment key={m._id}>
                {i > 0 ? <CardDivider /> : null}
                {memberRow(m)}
              </React.Fragment>
            ))}
          </GroupCard>
        </View>
      ) : null}

      <View style={styles.section}>
        <HintDisclosure
          label="Invite others"
          labelStyle={styles.sectionHeading}
          hintStyle={styles.zoneHint}
          hint={
            isDraft
              ? 'Add someone outside your household by email address or phone number — press return after each. Invitations go out when you save the event.'
              : 'Add someone outside your household by email address or phone number — press return after each. Invitations go out when you tap the check mark.'
          }
          accessibilityLabel="About inviting people outside your household"
        />

        {/* The dropdown renders below the input, which the keyboard-aware
            scroll keeps just above the keyboard — RevealWrap scrolls the pair
            clear when it opens (a direct useRevealOnOpen call here would read a
            null scroll context, since this component renders Screen itself). */}
        <RevealWrap open={suggestOpen} count={suggestions.length} style={styles.inputWrap}>
          <GroupCard>
            <View style={styles.inputRow}>
              <Input
                placeholder="Email or phone number"
                value={input}
                onChangeText={(v) => { setInput(v); setError(''); setSuggestOpen(true); }}
                onSubmitEditing={commitInput}
                blurOnSubmit={false}
                returnKeyType="done"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                containerStyle={[fs.headField, styles.inputGrow]}
                style={fs.headInput}
              />
              {inputCommittable ? (
                <TouchableOpacity
                  style={[styles.commitBtn, { backgroundColor: calColor }]}
                  hitSlop={HIT_SLOP}
                  onPress={commitInput}
                >
                  <Ionicons name="checkmark-sharp" size={16} color="#fff" />
                </TouchableOpacity>
              ) : null}
            </View>
          </GroupCard>
          {suggestOpen && suggestions.length > 0 ? (
            <View style={styles.dropdown}>
              {suggestions.map(({ person: p, entry }) => (
                <TouchableOpacity
                  key={p._id}
                  style={styles.suggestRow}
                  onPress={() => {
                    setStaged((s) => [...s, entry]);
                    // Keep the pieces before the one just completed.
                    setInput(input.split(/[,;\n]+/).slice(0, -1).map((s) => s.trim()).filter(Boolean).join(', '));
                    setSuggestOpen(false);
                  }}
                >
                  <Ionicons
                    name={entry.phone ? 'chatbubble-outline' : 'mail-outline'}
                    size={16}
                    color={colors.textMuted}
                  />
                  <View style={styles.suggestText}>
                    <Text style={styles.suggestName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.suggestEmail} numberOfLines={1}>{inviteeKey(entry)}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </RevealWrap>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Where each outside invitee stands. These are the quiet uppercase
            eyebrows (SectionHeader) NESTED under the zone heading above — the
            two levels must stay visually distinct or the screen reads flat. */}
        {sections.map((s) => (
          <View key={s.title} style={styles.statusGroup}>
            <SectionHeader>{s.title}</SectionHeader>
            <GroupCard>
              {s.rows.map((r, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <CardDivider /> : null}
                  {r}
                </React.Fragment>
              ))}
            </GroupCard>
          </View>
        ))}
        {/* A quiet status line, NOT the shared EmptyState: this is a sub-zone
            inside a form, not a list screen, and EmptyState's 52px icon block
            stands ~158px tall against the ~80px the first invitee row occupies
            — so the zone visibly SHRANK on adding someone, which reads as the
            layout breaking rather than as progress. One muted line holds the
            space the row will take. */}
        {sections.length === 0 ? (
          <Text style={styles.emptyLine}>No one outside your household yet.</Text>
        ) : null}
      </View>

      {/* A setting, not a people list — its own zone so it isn't mistaken for
          another row of invitees. The switch says what it does; the ⓘ says what
          turning it off costs, so the heading and label don't repeat. Shown
          only once there IS an outside invitee to govern: on a household-only
          event it decides nothing, and a dead control at the end of the screen
          invites the user to reason about a guest list that will never exist. */}
      {hasOutsideInvitees ? (
        <View style={styles.section}>
          <HintDisclosure
            label="Guest list"
            labelStyle={styles.sectionHeading}
            hintStyle={styles.zoneHint}
            hint="When off, invitees can’t see who else is invited — only you can."
            accessibilityLabel="About the guest list"
          />
          <GroupCard>
            <View style={fs.groupPad}>
              <SwitchRow label="Guests can see who’s invited" value={guestListVisible} onValueChange={toggleGuestList} color={calColor} />
            </View>
          </GroupCard>
        </View>
      ) : null}
      {emailSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // A titled zone: its heading + ⓘ, then the cards it governs.
  section: { marginBottom: spacing.lg },
  // The zone heading — the bold in-form heading role (SectionTitle's weight),
  // one step above the uppercase SectionHeader eyebrows nested inside it. Its
  // own margins are zero: HintDisclosure pads the row, and the zone owns the
  // spacing below.
  sectionHeading: { fontSize: 15, fontWeight: '700', color: colors.text },
  // The revealed hint's spacing, stated HERE rather than left to the shared
  // default: `Hint`'s base style carries a 16pt bottom margin sized for a
  // standalone helper line, which left the explanation floating mid-air
  // between its heading and the card it describes. `hintStyle` is the last
  // entry in HintDisclosure's style array, so this is the value that wins.
  // Tight to the card below (8) so heading + hint + card read as one group.
  zoneHint: { marginTop: spacing.xs, marginBottom: spacing.sm },
  statusGroup: { marginTop: spacing.sm },
  // Sits where the first status group would, at the same top offset, so adding
  // someone swaps a line for a card instead of collapsing the zone's height.
  emptyLine: { fontSize: 13, color: colors.textMuted, marginTop: spacing.sm, paddingHorizontal: spacing.xs },
  memberAvatar: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  memberInitial: { fontSize: 13, fontWeight: '600', color: colors.text },
  // Contact autocomplete under the input (mirrors PlacesAutocomplete)
  inputWrap: { position: 'relative' },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  inputGrow: { flex: 1 },
  commitBtn: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    marginRight: 14, marginLeft: 2,
  },
  dropdown: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface,
    marginTop: -spacing.sm, marginBottom: spacing.sm, overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  suggestText: { flex: 1 },
  suggestName: { fontSize: 14, color: colors.text },
  suggestEmail: { fontSize: 12, color: colors.textMuted },
  error: { color: colors.error, marginTop: spacing.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: 14, paddingVertical: spacing.sm, minHeight: 46,
  },
  email: { flex: 1, fontSize: 14, color: colors.text },
  remove: { padding: 2 },
});
