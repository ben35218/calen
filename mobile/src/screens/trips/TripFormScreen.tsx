import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp, StackActions } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { tripsApi, placesApi, invitationsApi, TripStatus, Trip, TripItem, FormAssistField } from '../../api';
import { sealNew, sealUpdate, openRecord, getHDK, loadResourceKeys, currentResourceKeyVersion, sealForResource } from '../../lib/e2ee';

// Encrypted trip content (dates/color stay plaintext).
const TRIP_ENC = (p: Record<string, unknown>) => ({ name: p.name, destination: p.destination, notes: p.notes });
import { Button, Input, Select, Screen, SectionTitle, DateField, useHeaderCheckButton, FormError, ColorPicker, CenteredLoader } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { TRIP_PURPLE } from '../../lib/tripTypes';
import { startKeepingDuration, endKeepingDuration } from '../../lib/datetime';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { TripsStackParamList } from '../../navigation/TripsNavigator';
import { classifyRecipient, composeShareSms } from '../../lib/shareInvite';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<TripsStackParamList, 'TripForm'>;
type Rt = RouteProp<TripsStackParamList, 'TripForm'>;

// An outside-share recipient, addressed by email or phone.
type ShareRecipient = { email?: string; phone?: string };
const shareKey = (r: ShareRecipient) => r.email || r.phone || '';
const shareLabel = (r: ShareRecipient) => r.email || r.phone || '';

const STATUS_OPTIONS = [
  { label: 'Considering', value: 'considering' },
  { label: 'Booked', value: 'booked' },
  { label: 'Past', value: 'completed' },
];

const COLORS = ['#5E35B1', '#1565C0', '#2E7D32', '#C62828', '#EF6C00', '#00838F', '#6A1B9A'];

// Schema the AI form assistant fills. Names match the form-state keys.
const ASSIST_FIELDS: FormAssistField[] = [
  { name: 'name', type: 'text', label: 'Trip name' },
  { name: 'destination', type: 'text', label: 'Destination (city)' },
  { name: 'status', type: 'select', label: 'Status', options: STATUS_OPTIONS },
  { name: 'startDate', type: 'date', label: 'Start date' },
  { name: 'endDate', type: 'date', label: 'End date' },
  { name: 'notes', type: 'text', label: 'Notes' },
];

export default function TripFormScreen() {
  const navigation = useNavigation<Nav>();
  const { id } = useRoute<Rt>().params || {};
  const isEdit = !!id;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.trips;

  const [form, setForm] = useState({
    name: '',
    destination: '',
    destinationTz: '',
    status: 'considering' as TripStatus,
    startDate: '',
    endDate: '',
    color: TRIP_PURPLE,
    notes: '',
  });
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteNote, setInviteNote] = useState('');
  // Invites entered while creating a new trip (no id yet); applied on save.
  const [pendingEmails, setPendingEmails] = useState<ShareRecipient[]>([]);
  const { composeEmail, emailSheet } = useEmailComposer();
  // A new trip is ready immediately; an edit waits for the trip to load and
  // populate below before the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };

  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<typeof form> = {};
    const changedKeys: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in form)) continue;
      const val = v == null ? '' : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(changedKeys);
  };

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Trip' : 'New Trip' });
  }, [navigation, isEdit]);

  const tripQ = useQuery({
    queryKey: ['trips', id],
    queryFn: async () => (await tripsApi.get(id!)).data,
    enabled: isEdit,
  });
  // Populate the form once from the first successful load. Sharing edits below
  // refetch this same query, and we must not clobber unsaved field edits.
  const populatedRef = useRef(false);
  useEffect(() => {
    if (!tripQ.data || populatedRef.current) return;
    let cancelled = false;
    (async () => {
    // GET /trips/:id returns { trip, items, isOwner }; older callers expect a flat trip.
    const data = tripQ.data as unknown as { trip?: Trip };
    const t = await openRecord('Trip', data.trip ?? (tripQ.data as Trip)); // decrypt content over plaintext
    if (cancelled || !t || !t.name) return;
    populatedRef.current = true;
    setForm({
      name: t.name ?? '',
      destination: t.destination ?? '',
      destinationTz: t.destinationTz ?? '',
      status: t.status,
      startDate: t.startDate ? t.startDate.slice(0, 10) : '',
      endDate: t.endDate ? t.endDate.slice(0, 10) : '',
      color: t.color || TRIP_PURPLE,
      notes: t.notes ?? '',
    });
    setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [tripQ.data]);

  // Seal a Trip update under its TripKey when the trip is outside-shared and this
  // device holds the key (§D2), else the HDK dual-write. Falls back to the HDK
  // seal when the TripKey isn't held yet (the owner's reconcile migrates later).
  async function sealTripPayload(tripId: string, payload: Record<string, unknown>) {
    const d = tripQ.data as unknown as { trip?: Trip } | undefined;
    const shared = ((d?.trip?.sharedWithOutside?.length ?? 0) > 0) || ((d?.trip?.collaborators?.length ?? 0) > 0);
    if (shared && getHDK()) {
      await loadResourceKeys('trip', tripId).catch(() => {});
      if (currentResourceKeyVersion(tripId) > 0) {
        const sealed = await sealForResource('trip', 'Trip', tripId, tripId, TRIP_ENC(payload));
        if (sealed) return { ...payload, ...sealed };
      }
    }
    return sealUpdate('Trip', tripId, payload, TRIP_ENC(payload));
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        destination: form.destination || undefined,
        destinationTz: form.destinationTz || undefined,
        status: form.status,
        color: form.color,
        notes: form.notes,
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
      };
      if (isEdit) {
        // Signal-parity D2: a shared trip seals under its TripKey; a private trip
        // under the HDK. (A brand-new trip below is never shared yet.)
        const res = await tripsApi.update(id!, await sealTripPayload(id!, payload));
        return { id: res.data?._id as string | undefined, shareFailed: false };
      }
      const res = await tripsApi.create(await sealNew('Trip', payload, TRIP_ENC(payload)));
      // Apply any invites collected before the trip existed. The trip itself is
      // already saved, so we don't abort on failure (that would risk a duplicate
      // create on retry) — instead we flag it and surface it after navigating.
      // The trip stays sealed (no decrypt-on-share); we pass a plaintext snapshot
      // for the invitation display rows, and the owner's reconcile migrates the
      // trip onto a TripKey on the next unlock (§D2).
      const newId = res.data?._id as string | undefined;
      let shareFailed = false;
      if (newId && pendingEmails.length) {
        try {
          await tripsApi.setShareRecipients(newId, pendingEmails, {
            tripName: payload.name as string, destination: payload.destination as string | undefined,
          });
        } catch {
          shareFailed = true;
        }
      }
      return { id: newId, shareFailed };
    },
    onSuccess: ({ id: newId, shareFailed }) => {
      qc.invalidateQueries({ queryKey: ['trips'] });
      allowLeave();
      if (!isEdit && newId) {
        navigation.replace('TripDetail', { id: newId });
        // The trip saved fine; only the invitations didn't go out. Say so
        // accurately and point the user to where they can resend them.
        if (shareFailed) {
          Alert.alert(
            'Trip saved — invitations not sent',
            "Your trip was created, but we couldn't send the invitations. Open “Share this trip” on the trip to try again.",
          );
        }
      } else {
        navigation.goBack();
      }
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const del = useMutation({
    mutationFn: () => tripsApi.remove(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trips'] });
      // popTo (not navigate) so the deleted trip's TripDetail + this Edit form are
      // removed from the back stack — otherwise closing Trips lands back on
      // the now-deleted trip's form.
      allowLeave();
      navigation.dispatch(StackActions.popTo('Trips'));
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Delete failed'),
  });

  const onDelete = () => {
    Alert.alert('Delete trip?', `Delete "${form.name || 'this trip'}"? This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);
  };

  // GET /trips/:id reports whether the caller's household owns the trip. Only the
  // owner may delete it; a guest collaborator removes themselves via leave-share
  // instead (mirrors the web TripDetailView). Default true so a brand-new trip or
  // an older API response shows the owner path — the server enforces either way.
  const detail = tripQ.data as unknown as { trip?: Trip; items?: TripItem[]; isOwner?: boolean } | undefined;
  const isOwner = detail?.isOwner ?? true;

  // ── Sharing (owner-only) ──
  // Editing an existing trip shares live against the server; a new trip collects
  // invites locally (pendingRecipients) and applies them once it's created on
  // save. Each recipient is addressed by email or phone.
  const serverRecipients = (detail?.trip?.sharedWithOutside || []) as ShareRecipient[];
  const shareRecipients = isEdit ? serverRecipients : pendingEmails;
  const isShared = shareRecipients.length > 0 || (detail?.trip?.collaborators?.length ?? 0) > 0;

  // Set the full outside-share list. Signal-parity D2: sharing no longer flips the
  // trip to plaintext — the trip stays sealed and migrates onto a TripKey on the
  // owner's next unlock (maintainKeyHygiene → reconcileTripKeys). We pass a
  // plaintext { tripName, destination } snapshot (from the decrypted trip) for the
  // invitation display rows only.
  const setEmails = useMutation({
    mutationFn: async (recipients: ShareRecipient[]) => {
      const dec = detail?.trip ? await openRecord('Trip', detail.trip as any) : undefined;
      const snapshot = dec ? { tripName: (dec as any).name, destination: (dec as any).destination } : undefined;
      return (await tripsApi.setShareRecipients(id!, recipients, snapshot)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips', id] }),
    onError: (e: any) => setInviteError(e?.message || e?.response?.data?.error || 'Please try again.'),
  });

  // Compose the invite from this device — the server sends no invite mail/text.
  const inviteWhat = () => (form.name ? `the trip “${form.name}”` : 'our trip');
  const textPhoneInvite = async (phone: string) => {
    try {
      await composeShareSms(phone, inviteWhat());
    } catch (e: any) {
      setInviteError(e?.message || 'Saved, but the text couldn’t be started.');
    }
  };
  const emailInvite = async (email: string) => {
    try {
      await composeEmail(email, inviteWhat());
    } catch (e: any) {
      setInviteError(e?.message || 'Saved, but the email couldn’t be started.');
    }
  };
  // Raw outreach — always opens the composer. Used by the Remind row action.
  const composeInvite = (recipient: ShareRecipient) => {
    if (recipient.phone) return textPhoneInvite(recipient.phone);
    if (recipient.email) return emailInvite(recipient.email);
    return Promise.resolve();
  };
  // Outreach on ADD: a recipient who's already on Calen needs none from this
  // device — the server pushes their registered devices and the invite lands in
  // their in-app inbox (households-sharing.md). The composer only opens for
  // someone not on Calen yet. Lookup failures fail open (compose anyway): a
  // pointless email beats a silently unreachable invitee.
  const inviteOutreach = async (recipient: ShareRecipient) => {
    let exists = false;
    try {
      exists = (await invitationsApi.lookup(recipient)).data.userExists;
    } catch { /* fail open */ }
    if (exists) {
      setInviteNote('They’re on Calen — the invite is in their Invitations inbox and their devices were notified.');
      return;
    }
    await composeInvite(recipient);
  };

  const addRecipient = async () => {
    const recipient = classifyRecipient(inviteEmail);
    if (!recipient) { setInviteError('Enter a valid email or phone number'); return; }
    if (shareRecipients.some((r) => shareKey(r) === shareKey(recipient))) {
      setInviteError('Already shared with that contact');
      return;
    }
    setInviteError('');
    setInviteNote('');
    setInviteEmail('');
    if (isEdit) {
      await setEmails.mutateAsync([...serverRecipients, recipient]);
      await inviteOutreach(recipient);
    } else {
      setPendingEmails((es) => [...es, recipient]);
      // Pending invites are created on save; reach out now (the invite is a
      // generic app nudge, so it's valid regardless of when the invite lands).
      await inviteOutreach(recipient);
    }
  };

  const removeEmail = (r: ShareRecipient) => {
    const key = shareKey(r);
    if (isEdit) setEmails.mutate(serverRecipients.filter((e) => shareKey(e) !== key));
    else setPendingEmails((es) => es.filter((e) => shareKey(e) !== key));
  };

  const stopSharing = () => {
    Alert.alert('Stop sharing?', 'Everyone you invited will lose access to this trip.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop sharing',
        style: 'destructive',
        onPress: () => { tripsApi.unshare(id!).then(() => qc.invalidateQueries({ queryKey: ['trips', id] })); },
      },
    ]);
  };

  const leave = useMutation({
    mutationFn: () => tripsApi.leaveShare(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trips'] });
      // popTo so the left trip's detail + this form don't linger in the back stack.
      allowLeave();
      navigation.dispatch(StackActions.popTo('Trips'));
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Could not leave trip'),
  });

  const onLeave = () => {
    Alert.alert(
      'Leave this trip?',
      'You’ll be removed as a collaborator. The trip stays with its owner, and you can rejoin later with the invite code.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: () => leave.mutate() },
      ],
    );
  };

  const onSave = () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');
    save.mutate();
  };

  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent });

  // Discard guard: prompt before leaving with unsaved edits to the trip fields
  // (or, on a new trip, pending share invites — edits to an existing trip's
  // sharing persist to the server immediately, so they don't count). Sharing/
  // delete/leave exits call allowLeave() above to skip the prompt.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ form, pendingEmails });
  useEffect(() => {
    if (seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seeded, snapshot]);
  const dirty = seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  if (isEdit && tripQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  return (
    <Screen>
      <FormAssist
        accent={accent}
        formType="trip"
        placeholder={'Describe the trip, e.g. "10-day trip to Rome in May, booked"'}
        fields={ASSIST_FIELDS}
        current={{ ...form }}
        onApply={applyPatch}
      />

      <GroupCard>
        <Input
          value={form.name}
          onChangeText={(v) => set({ name: v })}
          placeholder="Trip Name"
          autoCapitalize="words"
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('name') && fs.headInputHighlight]}
        />
        <CardDivider />
        <PlacesAutocomplete
          type="city"
          value={form.destination}
          onChangeText={(v) => set({ destination: v })}
          onSelect={(p) => placesApi.getTimezone(p.place_id).then((r) => r.data.timeZoneId && set({ destinationTz: r.data.timeZoneId })).catch(() => {})}
          placeholder="Destination"
          containerStyle={fs.headField}
          inputStyle={[fs.headInput, assist.changed.has('destination') && fs.headInputHighlight]}
        />
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Starts</Text>
          <View style={fs.dtFields}>
            <DateField
              clearable
              placeholder="None"
              value={form.startDate}
              onChange={(v) => {
                // A trip is date-only; treat both ends as midnight. Moving the
                // start slides the end by the same number of days so the trip
                // keeps its length — the end date is what changes it.
                if (form.startDate && form.endDate) {
                  const shifted = endKeepingDuration(
                    { date: form.startDate, time: '00:00' },
                    { date: form.endDate, time: '00:00' },
                    { date: v, time: '00:00' }
                  );
                  if (shifted) { set({ startDate: v, endDate: shifted.date }); return; }
                }
                set({ startDate: v });
              }}
              highlight={assist.changed.has('startDate')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.dtField}
              valueStyle={fs.dtValue}
              hideIcon
            />
          </View>
        </View>
        <CardDivider />
        <View style={fs.dtRow}>
          <Text style={fs.dtLabel}>Ends</Text>
          <View style={fs.dtFields}>
            <DateField
              clearable
              placeholder="None"
              value={form.endDate}
              onChange={(v) => {
                // A trip is date-only; treat both ends as midnight. Moving the end
                // before the start slides the start back to keep the trip's length.
                if (form.startDate && form.endDate) {
                  const shifted = startKeepingDuration(
                    { date: form.startDate, time: '00:00' },
                    { date: form.endDate, time: '00:00' },
                    { date: v, time: '00:00' }
                  );
                  if (shifted) { set({ endDate: v, startDate: shifted.date }); return; }
                }
                set({ endDate: v });
              }}
              highlight={assist.changed.has('endDate')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.dtField}
              valueStyle={fs.dtValue}
              hideIcon
            />
          </View>
        </View>
      </GroupCard>

      <GroupCard>
        <Select
          inlineLabel="Status"
          value={form.status}
          options={STATUS_OPTIONS}
          onChange={(v) => set({ status: (v as TripStatus) ?? 'considering' })}
          highlight={assist.changed.has('status')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
      </GroupCard>

      {isOwner ? (
        <>
          <SectionTitle>Share this trip</SectionTitle>
          <GroupCard style={styles.shareCard}>
            <View style={styles.emailAddRow}>
              <Input
                placeholder="Add email or phone…"
                value={inviteEmail}
                onChangeText={(v) => { setInviteEmail(v); setInviteError(''); }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={addRecipient}
                containerStyle={styles.emailInput}
                style={styles.emailInputField}
              />
              {setEmails.isPending ? (
                <ActivityIndicator size="small" color={accent} style={styles.emailAddIcon} />
              ) : (
                <TouchableOpacity
                  onPress={addRecipient}
                  disabled={!inviteEmail.trim()}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.emailAddIcon}
                >
                  <Ionicons name="add-circle" size={28} color={inviteEmail.trim() ? accent : colors.border} />
                </TouchableOpacity>
              )}
            </View>
            {inviteError ? <Text style={styles.inviteErr}>{inviteError}</Text> : null}
            {inviteNote ? <Text style={styles.inviteNote}>{inviteNote}</Text> : null}
            {shareRecipients.length > 0 ? (
              <View style={styles.shareList}>
                {shareRecipients.map((r) => {
                  const label = shareLabel(r);
                  const collab = r.email
                    ? (detail?.trip?.collaborators || []).find((c) => c.email?.toLowerCase() === r.email)
                    : undefined;
                  const who = collab ? ([collab.firstName, collab.lastName].filter(Boolean).join(' ') || label) : label;
                  return (
                    <View key={shareKey(r)} style={styles.shareRow}>
                      <View style={styles.shareRowInfo}>
                        <Text style={styles.shareRowName} numberOfLines={1}>{who}</Text>
                        <Text style={styles.shareRowStatus}>{collab ? 'Joined' : 'Invited'}</Text>
                      </View>
                      {/* Remind — re-open the composer for a not-yet-joined
                          invitee (works for account holders too; it's the
                          escape hatch when the push wasn't noticed). */}
                      {!collab ? (
                        <TouchableOpacity onPress={() => composeInvite(r)} hitSlop={8} style={styles.shareRemindBtn}>
                          <Ionicons name="paper-plane-outline" size={20} color={accent} />
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity onPress={() => removeEmail(r)} hitSlop={8}>
                        <Ionicons name="close-circle-outline" size={22} color={colors.error} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </GroupCard>
          {isEdit && isShared ? (
            <TouchableOpacity style={styles.shareStopBtn} onPress={stopSharing}>
              <Text style={styles.shareStopText}>Stop sharing</Text>
            </TouchableOpacity>
          ) : null}
        </>
      ) : null}

      <SectionTitle>Color</SectionTitle>
      <GroupCard style={styles.swatchCard}>
        <ColorPicker value={form.color} onChange={(c) => set({ color: c })} options={COLORS} />
      </GroupCard>

      <SectionTitle>Notes</SectionTitle>
      <Input
        value={form.notes}
        onChangeText={(v) => set({ notes: v })}
        multiline
        placeholder="Add any notes…"
        style={fs.notes}
        highlight={assist.changed.has('notes')}
      />

      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={fs.footer}>
          {isOwner ? (
            <Button title="Delete Trip" variant="danger" loading={del.isPending} onPress={onDelete} />
          ) : (
            <Button title="Leave this shared trip" variant="danger" loading={leave.isPending} onPress={onLeave} />
          )}
        </View>
      ) : null}
      {emailSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  swatchCard: { padding: 14 },
  shareCard: { padding: 14, gap: spacing.sm },
  emailAddRow: { position: 'relative', justifyContent: 'center' },
  emailInput: { marginBottom: 0 },
  emailInputField: { paddingRight: 46 },
  emailAddIcon: { position: 'absolute', right: 10, alignItems: 'center', justifyContent: 'center' },
  inviteErr: { color: colors.error, fontSize: 13, marginTop: 4 },
  inviteNote: { color: colors.success, fontSize: 13, marginTop: 4 },
  shareRemindBtn: { marginRight: 2 },
  shareList: { marginTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  shareRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: spacing.sm },
  shareRowInfo: { flex: 1 },
  shareRowName: { fontSize: 15, fontWeight: '600', color: colors.text },
  shareRowStatus: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  shareStopBtn: { alignItems: 'center', paddingVertical: spacing.md, marginTop: 4 },
  shareStopText: { color: '#C62828', fontSize: 15, fontWeight: '600' },
});
