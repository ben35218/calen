import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Alert, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { calendarApi, householdApi, invitationsApi, settingsApi, EventInvitation, HouseholdMember } from '../../api';
import {
  Badge, HintDisclosure, Input, RevealWrap, Screen, SectionHeader, SwitchRow,
  useHeaderCheckButton,
} from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import {
  getQueuedInvitees, setQueuedInvitees, useDraftGuestListVisible, setDraftGuestListVisible,
  getQueuedHouseholdInvitees, setQueuedHouseholdInvitees,
  getQueuedRevokes, setQueuedRevokes,
} from '../../lib/inviteeDraft';
import { notifyHouseholdInvitees, rsvpsForEvent } from '../../lib/householdRsvp';
import { eventInvitationExpired } from '../../lib/inviteAlerts';
import { useCalendarColors, useCustomCalendars } from '../../lib/calendarPrefs';
import {
  InviteeEntry, inviteeKey, normalizePhone, composeSmsInvite, sendInvitations, eventInviteEmailContent,
} from '../../lib/invitees';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { useRosterSuggestions } from '../../hooks/useRosterSuggestions';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { useAuth } from '../../store/auth';
import { CalendarStackParamList } from '../../navigation/CalendarNavigator';
import { colors, spacing } from '../../theme';

type Rt = RouteProp<CalendarStackParamList, 'EventInvitees'>;

// Manage who is invited to one event. ONE input takes both channels: each
// return keystroke parses the text — pieces with an @ are emails, anything else
// must read as a phone number — and stages it in the New section. Nothing sends
// until a ✓, and WHICH ✓ depends on how this screen was reached:
//   - from the EVENT FORM (`stageOnly`, new or saved event): this screen's ✓
//     only commits the session's staging — added invitees, removed ones, the
//     household selection, the guest-list flag — to lib/inviteeDraft, and the
//     FORM's ✓ does the sending/revoking/notifying after the event saves.
//     Nothing the user can still discard is allowed to have gone out already:
//     an outsider invited on an edit the user then backs out of would be holding
//     an invitation to changes that were never saved.
//   - from the EVENT DETAIL screen (no `stageOnly`): there is no pending save
//     behind this screen, so its ✓ IS the commit — it sends everything at once
//     (emails server-side; texts open the Messages composer one per number,
//     prefilled with the event and its public .ics link) and applies the
//     household selection immediately.
// The X close button discards whatever was staged this visit. The "Guests can
// see guest list" switch lives here too, following the same rule. The list is
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
  const { eventId, snapshot, stageOnly: stageParam } = useRoute<Rt>().params;
  const navigation = useNavigation<NativeStackNavigationProp<CalendarStackParamList>>();
  const qc = useQueryClient();
  const isDraft = !eventId;
  // Stage instead of commit. A draft has no choice (there is no event to invite
  // to yet); a saved event stages whenever the event form is what pushed us.
  const stageOnly = isDraft || !!stageParam;

  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Mail composer for non-account email invitees (and the per-row Remind) —
  // the mail-app chooser sheet renders at the bottom of this screen.
  const { composeEmail, emailSheet } = useEmailComposer();
  // Entries added this visit, committed/sent only on ✓. A staging session starts
  // from the queue so entries added on an earlier visit can still be removed.
  const [staged, setStaged] = useState<InviteeEntry[]>(() => (stageOnly ? getQueuedInvitees() : []));
  // Already-sent invitations the user removed. In a staging session the revoke
  // waits for the event's save (so backing out of the edit leaves the invitee
  // in place); otherwise the row's confirm revokes on the spot and this stays
  // empty.
  const [revoked, setRevoked] = useState<string[]>(() => (stageOnly ? getQueuedRevokes() : []));
  // Clean baseline for the unsaved-changes guard: what this visit opened with (a
  // staging session starts from the queue; a committing one starts empty).
  // Anything added/removed since — or half-typed in the field — is unsaved and
  // prompts before leaving.
  const initialStaged = useRef(JSON.stringify(stageOnly ? getQueuedInvitees() : []));
  const initialRevoked = useRef(JSON.stringify(stageOnly ? getQueuedRevokes() : []));
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
  // sealed householdInvitees list, notifies them when the change actually lands
  // (the event's save in a staging session, this screen's ✓ from the detail
  // screen), and tracks their accept/decline (per-member EventRsvp records).
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
  // Selection: a staging session starts from the queued list — which the event
  // form seeds from the fetched event before this screen can be opened, so it
  // holds the saved event's members plus anything picked earlier this session.
  // The detail-screen entry has no form behind it and seeds from the decrypted
  // event once it loads (replica rows are already decrypted).
  const [hhSelected, setHhSelected] = useState<string[]>(() => (stageOnly ? getQueuedHouseholdInvitees() : []));
  const hhInitial = useRef<string[] | null>(stageOnly ? getQueuedHouseholdInvitees() : null);
  const eventQ = useQuery({
    queryKey: ['calendar', 'event', eventId, 'invitees'],
    queryFn: async () => (await calendarApi.getEvent(eventId!)).data,
    enabled: !isDraft && !stageOnly,
  });
  useEffect(() => {
    if (stageOnly || hhInitial.current !== null || !eventQ.data) return;
    const ids = eventQ.data.householdInvitees ?? [];
    hhInitial.current = ids;
    setHhSelected(ids);
  }, [stageOnly, eventQ.data]);
  const toggleMember = (id: string) =>
    setHhSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // The account's own phone number, for the self-exclusion below (`user` carries
  // only the email). Shares the Account screen's cache.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await settingsApi.get()).data,
  });

  // Everyone already staged or sent (plus the user's own email and phone — the
  // server rejects self-invites), so suggestions and adds can skip them. One hit
  // anywhere on a contact card removes that CONTACT from the dropdown, not just
  // the address that matched (see matchRoster): the card's other addresses reach
  // the same person, who is already invited.
  const taken = useMemo(() => {
    const set = new Set(
      [...staged.map(inviteeKey), ...(inviteesQ.data ?? []).map((i) => i.toEmail ?? i.toPhone ?? '')].map(
        (e) => e.toLowerCase(),
      ),
    );
    if (user?.email) set.add(user.email.toLowerCase());
    if (settings?.phone) set.add(settings.phone.toLowerCase());
    return set;
  }, [staged, inviteesQ.data, user?.email, settings?.phone]);

  // The piece being typed — the text after the last comma — is what the roster
  // matches against.
  const query = useMemo(() => (input.split(/[,;\n]+/).pop() ?? '').trim(), [input]);
  // The same shared autocomplete every share/invite field uses: contacts matched
  // by name, email, or phone digits, expanded to ONE ROW PER REACHABLE ADDRESS
  // (each email, then each canonical-E.164 phone), so the sender picks which
  // address gets the invite instead of accepting whichever one happened to be
  // first on the card.
  const suggestions = useRosterSuggestions(query, taken);

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

  // ✓ — commit the field, then stage everything for the event's save (a form
  // session) or send it now (the detail-screen entry). Staging writes the whole
  // session state: added invitees, removed invitations, the household selection.
  // Sending: entries that fail stay staged with the reason, so ✓ can retry just
  // those; the household selection re-seals householdInvitees and instantly
  // notifies newly added members (best-effort — the durable channel is their
  // Invitations inbox).
  const onConfirm = async () => {
    const { ok, entries } = commitInput();
    if (!ok) return;
    if (stageOnly) {
      setQueuedHouseholdInvitees(hhSelected);
      setQueuedInvitees(entries);
      setQueuedRevokes(revoked);
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
    JSON.stringify(revoked) !== initialRevoked.current ||
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
  // seals it into every save payload), so in a form session the toggle lands
  // with the event like everything else here. From the detail screen it saves
  // right away — `guestListVisible` is sealed event content (C3b), so the
  // client re-seals the event rather than PUTting the field plaintext.
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
    if (!stageOnly) saveGuestList.mutate(v);
  };

  const removeStaged = (entry: InviteeEntry) =>
    setStaged((s) => s.filter((e) => inviteeKey(e) !== inviteeKey(entry)));

  // Removing someone already invited. In a form session the removal is staged
  // like everything else — the row leaves the list now, the revoke happens when
  // the event saves — so the confirm has to say WHEN it takes effect, or "the
  // event will be removed from their calendar" reads as already done.
  const confirmRevoke = (inv: EventInvitation) => {
    const to = inv.toEmail ?? inv.toPhone;
    const effect = inv.status === 'accepted'
      ? `The event will be removed from ${to}'s calendar`
      : `${to} will no longer be able to accept this invitation`;
    Alert.alert(
      'Remove invitee?',
      stageOnly ? `${effect} when you save the event.` : `${effect}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => (stageOnly ? setRevoked((r) => [...r, inv._id]) : revoke.mutate(inv._id)),
        },
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
        <TouchableOpacity
          style={styles.remove}
          hitSlop={HIT_SLOP}
          onPress={() => removeStaged(entry)}
          accessibilityLabel={`Remove ${inviteeKey(entry)}`}
        >
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
      <TouchableOpacity
        style={styles.remove}
        hitSlop={HIT_SLOP}
        onPress={() => confirmRevoke(inv)}
        accessibilityLabel={`Remove ${inv.toEmail ?? inv.toPhone}`}
      >
        <Ionicons name="close-circle" size={20} color={colors.textMuted} />
      </TouchableOpacity>
    </View>
  );

  // Invitations staged for removal leave the list the moment they're confirmed —
  // the user said remove, so the screen must show them gone even though the
  // revoke itself waits for the event's save.
  const sent = (inviteesQ.data ?? []).filter((i) => !revoked.includes(i._id));
  // The guest list is a cross-household concern only — housemates aren't part
  // of it, and it governs nothing until at least one outside contact is staged
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
          acts on different contacts, so they get separate headings rather than
          one "Invitees" wall. */}
      {/* The household zone is pure RSVP — housemates already see the event —
          so it disappears once the event has ended: asking someone to accept
          or decline history is noise. Outside invites stay available (the
          record-share lane: the recipient gets Add to Calendar). */}
      {hhMembers.length > 0 && !eventInvitationExpired(snapshot) ? (
        <View style={styles.section}>
          <HintDisclosure
            label="Notify household members"
            labelStyle={styles.sectionHeading}
            hintStyle={styles.zoneHint}
            hint={
              stageOnly
                ? 'Housemates already see this event. Selecting someone asks them to accept or decline and notifies them when you save the event — declining doesn’t remove the event from their calendar.'
                : 'Housemates already see this event. Selecting someone asks them to accept or decline and notifies them right away — declining doesn’t remove the event from their calendar.'
            }
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
            stageOnly
              ? 'Add someone outside your household by email address or phone number — press return after each. Invitations go out when you save the event.'
              : 'Add someone outside your household by email address or phone number — press return after each. Invitations go out when you tap the check mark.'
          }
          accessibilityLabel="About inviting contacts outside your household"
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
              {suggestions.map(({ key, p, entry, label, display }) => (
                <TouchableOpacity
                  key={key}
                  style={styles.suggestRow}
                  onPress={() => {
                    setStaged((s) => [...s, entry]);
                    // Keep the pieces before the one just completed.
                    setInput(input.split(/[,;\n]+/).slice(0, -1).map((s) => s.trim()).filter(Boolean).join(', '));
                    setSuggestOpen(false);
                  }}
                >
                  <Ionicons
                    name={'phone' in entry ? 'chatbubble-outline' : 'mail-outline'}
                    size={16}
                    color={colors.textMuted}
                  />
                  <View style={styles.suggestText}>
                    <Text style={styles.suggestName} numberOfLines={1}>{p.name}</Text>
                    {/* The address, with its card label ("work · dee@work.com") —
                        the same card can list several, so which one this row
                        would invite has to be readable at a glance. */}
                    <Text style={styles.suggestEmail} numberOfLines={1}>
                      {label ? `${label} · ${display}` : display}
                    </Text>
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

      {/* A setting, not a contacts list — its own zone so it isn't mistaken for
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
