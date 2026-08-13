import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, StyleSheet, Alert, ActivityIndicator, TouchableOpacity, Keyboard } from 'react-native';
import { Text } from '../../components/Text';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, RouteProp } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { householdApi, settingsApi, HouseholdMember, HouseholdInvitation, JoinRequestForApprover, JoinRequestMine } from '../../api';
import { Button, Card, Input, RevealWrap, Screen, SectionTitle, SetupCallout, SkeletonList } from '../../components/ui';
import { ensureHouseholdKey, activateBornEncryptedHousehold, getHDK, wrapHDKForJoiner, publicKeyFingerprint, myIdentityPublicKey, openRecord, sealUpdate } from '../../lib/e2ee';
import { HOUSEHOLD_ENC } from '../../lib/encSubsets';
import { loadSafetyNumbers, markVerified, MemberSafety } from '../../lib/safetyNumbers';
import { maintainKeyHygiene } from '../../lib/dropMigration';
import { useAuth } from '../../store/auth';
import { classifyRecipient, composeShareSms, Recipient } from '../../lib/shareInvite';
import { useEmailComposer } from '../../components/EmailAppSheet';
import { SecurityCode } from '../../components/SecurityCode';
import { useRosterSuggestions } from '../../hooks/useRosterSuggestions';
import { colors, spacing } from '../../theme';

// Household hub: rename, invite members by email, approve-on-device joins
// (request → a member verifies a fingerprint and approves → membership + HDK
// envelope are granted), and member management. Joining another household is by
// accepting an emailed invitation from the Invitations inbox.
export default function HouseholdScreen() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // A Calen "Set up your household" chip lands here when the user wanted to
  // share/assign but has no one to share with yet.
  const promptInvite = useRoute<RouteProp<{ Household: { promptInvite?: boolean } | undefined }, 'Household'>>().params?.promptInvite;
  const { data: household, isLoading, refetch } = useQuery({
    queryKey: ['household'],
    // Decrypt the sealed settings blob over the plaintext (C2): post-drop the
    // household NAME only exists inside `enc`.
    queryFn: async () => {
      const hh = (await householdApi.get()).data;
      const dec = await openRecord('Household', hh);
      return { ...hh, name: dec.name ?? hh.name };
    },
  });

  const [name, setName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteNote, setInviteNote] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { composeEmail, emailSheet } = useEmailComposer();

  const { data: sentInvites, refetch: refetchInvites } = useQuery({
    queryKey: ['householdInvitations', 'sent'],
    queryFn: async () => (await householdApi.sentInvitations()).data,
  });

  // Invitations addressed to ME — surfaced here too (not just the Invitations
  // inbox) so an outstanding invite to join someone else's household is visible
  // from the place you manage household membership.
  const { data: myInvites, refetch: refetchMyInvites } = useQuery({
    queryKey: ['householdInvitations', 'mine'],
    queryFn: async () => (await householdApi.myInvitations()).data,
  });
  const pendingInvites = useMemo(
    () => (myInvites ?? []).filter((i) => i.status === 'pending'),
    [myInvites],
  );
  const [respondingInvite, setRespondingInvite] = useState<string | null>(null);

  // My own saved phone, so the self contact card ("You" in Contacts) can't be
  // offered by number the way a member's card could — the account `user` carries
  // only the email. Shares the Account screen's cache.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await settingsApi.get()).data,
  });

  // Everyone already in the household, already invited, or yourself — hidden from
  // suggestions (the server rejects re-inviting these anyway). One hit anywhere on
  // a contact card removes that CONTACT from the dropdown, not just the address
  // that matched (see matchRoster) — a member's other numbers reach the same
  // contact and can't be invited either.
  const taken = useMemo(() => {
    const set = new Set<string>();
    for (const m of household?.members ?? []) if (m.email) set.add(m.email.toLowerCase());
    for (const inv of sentInvites ?? []) {
      if (inv.status === 'declined') continue;
      if (inv.toEmail) set.add(inv.toEmail.toLowerCase());
      if (inv.toPhone) set.add(inv.toPhone.toLowerCase());
    }
    if (user?.email) set.add(user.email.toLowerCase());
    if (settings?.phone) set.add(settings.phone.toLowerCase());
    return set;
  }, [household?.members, sentInvites, user?.email, settings?.phone]);

  // Roster contacts matching what's typed, resolved to the recipient a tap
  // would invite — the shared autocomplete behind every share/invite field.
  const suggestions = useRosterSuggestions(inviteEmail, taken);

  const [myRequest, setMyRequest] = useState<JoinRequestMine | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [pending, setPending] = useState<JoinRequestForApprover[]>([]);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [approveError, setApproveError] = useState('');
  const [keyVersion, setKeyVersion] = useState(0);
  const [hdkReady, setHdkReady] = useState(false);
  // My own safety code (fingerprint of my identity key) — read out to the member
  // approving me so they can confirm it matches what they see before approving.
  const [myCode, setMyCode] = useState<string | null>(null);

  useEffect(() => {
    if (household) setName(household.name);
  }, [household]);

  useEffect(() => {
    if (myRequest?.status !== 'pending') return;
    (async () => {
      const pub = await myIdentityPublicKey();
      setMyCode(pub ? await publicKeyFingerprint(pub) : null);
    })();
  }, [myRequest?.status]);

  const loadPending = useCallback(async () => {
    try {
      const { data } = await householdApi.joinRequests();
      setPending(data);
      // Compute any fingerprints we don't have yet and merge them in.
      await Promise.all(data.map(async (r) => {
        const fp = await publicKeyFingerprint(r.requesterPublicKey);
        setFingerprints((cur) => (cur[r._id] === fp ? cur : { ...cur, [r._id]: fp }));
      }));
    } catch { /* not a member / transient */ }
  }, []);

  const loadMine = useCallback(async () => {
    try {
      const { data } = await householdApi.myJoinRequest();
      setMyRequest((prevMine) => {
        if (data.status === 'approved' && prevMine?.status === 'pending') {
          // Our envelope now exists — unwrap the HDK and refresh membership.
          ensureHouseholdKey().then(() => { refetch(); qc.invalidateQueries(); });
          return null;
        }
        return data.status === 'none' ? null : data;
      });
    } catch { /* ignore */ }
  }, [qc, refetch]);

  const loadKeyState = useCallback(async () => {
    try {
      await ensureHouseholdKey();
      const { data } = await householdApi.getKey();
      setKeyVersion(data.currentKeyVersion || 0);
      setHdkReady(getHDK() != null);
    } catch { /* ignore */ }
  }, []);

  // Safety numbers (A2): fingerprint + verified state per member, keyed by
  // userId. 'changed' means a member's key differs from the one this device
  // verified — surfaced as a warning until re-verified.
  const [safety, setSafety] = useState<Record<string, MemberSafety>>({});
  const loadSafety = useCallback(async () => {
    try {
      const rows = await loadSafetyNumbers(user?._id);
      setSafety(Object.fromEntries(rows.map((r) => [r.userId, r])));
    } catch { /* not enrolled yet / transient */ }
  }, [user?._id]);
  useEffect(() => { loadSafety(); }, [loadSafety]);

  function showSafetyNumber(m: HouseholdMember) {
    const s = safety[m._id];
    if (!s) return;
    const who = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'This member';
    const changed = s.status === 'changed';
    Alert.alert(
      changed ? 'Safety number changed!' : `Verify ${who}`,
      (changed
        ? `${who}'s security code is different from the one you verified. This can mean they re-installed or re-enrolled — or that someone else holds their account. Compare the new code with them in contact or over a call before trusting it:\n\n`
        : 'Compare this security code with the one on their device (in contact or over a call). If they match, you know your encrypted data is shared with the right contact:\n\n')
        + s.fingerprint,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: s.status === 'verified' ? 'Verified ✓ (re-confirm)' : 'They match — mark verified',
          onPress: async () => { await markVerified(m._id, s.fingerprint); await loadSafety(); },
        },
      ],
    );
  }

  useEffect(() => {
    loadKeyState();
    loadMine();
    loadPending();
    const timer = setInterval(() => { loadMine(); loadPending(); }, 5000);
    return () => clearInterval(timer);
  }, [loadKeyState, loadMine, loadPending]);

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === household?.name) return;
    // Seal the new name into the settings blob (C2); the decrypted homeAddress
    // rides along so the re-seal never drops it. No-op without an HDK.
    let body: Record<string, unknown> = { name: trimmed };
    if (getHDK() && household?._id) {
      const dec = (await openRecord('Household', (await householdApi.get()).data)) as unknown as Record<string, unknown>;
      body = await sealUpdate('Household', String(household._id), body, HOUSEHOLD_ENC({
        name: trimmed,
        homeAddress: dec.homeAddress,
      }));
    }
    await householdApi.rename(body);
    qc.invalidateQueries({ queryKey: ['household'] });
  }

  // Send an invite either to an explicitly picked roster contact (tapped
  // suggestion) or, when none is passed, to whatever's typed in the field. Both
  // paths share the same send + device-compose + note/error handling below.
  async function invite(picked?: Recipient) {
    const recipient = picked ?? classifyRecipient(inviteEmail);
    if (!recipient) { setInviteError('Enter a valid email or phone number'); return; }
    setInviting(true);
    setInviteError('');
    setInviteNote('');
    setSuggestOpen(false);
    Keyboard.dismiss();
    try {
      const { data } = await householdApi.invite(recipient);
      setInviteEmail('');
      const what = `the ${household?.name || 'family'} household`;
      // A recipient who's already on Calen needs no outreach from this device:
      // the server pushed their registered devices and the invite is in their
      // in-app Invitations inbox — the composer only opens when the contact
      // isn't on Calen yet (they can't be reached any other way). The Remind
      // button on the pending row re-opens the composer on demand (the escape
      // hatch for an account holder who never sees the push).
      if (data.userExists) {
        setInviteNote('Invitation sent — it’s in their Invitations inbox and their devices were notified.');
      } else if ('phone' in recipient) {
        // The server sends no text — compose it from this device.
        try {
          await composeShareSms(recipient.phone, what);
        } catch (e: any) {
          setInviteError(e?.message || 'Saved, but the text couldn’t be started.');
        }
        setInviteNote('Invitation saved. Send the text so they can join once they get the app.');
      } else {
        // The server sends no email either — compose it from this device, so it
        // comes from the inviter's own account and the server never handles the
        // address. Routed through the mail-app chooser so non-Apple-Mail users
        // land in their own client.
        try {
          await composeEmail(recipient.email, what);
        } catch (e: any) {
          setInviteError(e?.message || 'Saved, but the email couldn’t be started.');
        }
        setInviteNote('Invitation saved. Send the email so they can join once they get the app.');
      }
      await refetchInvites();
    } catch (e: any) {
      setInviteError(e?.response?.data?.error || 'Could not send the invitation');
    } finally {
      setInviting(false);
    }
  }

  // Re-send the outreach for a pending invite from this device (email via the
  // mail-app chooser, phone via Messages) — regardless of whether the recipient
  // has an account, since Remind exists precisely for when the push/inbox path
  // wasn't noticed.
  async function remindInvite(inv: HouseholdInvitation) {
    const what = `the ${household?.name || 'family'} household`;
    setInviteError('');
    try {
      if (inv.toEmail) await composeEmail(inv.toEmail, what);
      else if (inv.toPhone) await composeShareSms(inv.toPhone, what);
    } catch (e: any) {
      setInviteError(e?.message || 'The reminder couldn’t be started.');
    }
  }

  function revokeInvite(inv: HouseholdInvitation) {
    Alert.alert('Revoke invitation?', `${inv.toEmail} will no longer be able to join with this invite.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          try {
            await householdApi.revokeInvitation(inv._id);
            await refetchInvites();
          } catch (e: any) {
            Alert.alert('Could not revoke', e?.response?.data?.error || 'Please try again.');
          }
        },
      },
    ]);
  }

  async function cancelRequest() {
    setCanceling(true);
    try {
      await householdApi.cancelJoinRequest();
      setMyRequest(null);
    } finally {
      setCanceling(false);
    }
  }

  // Respond to an invitation to join another household, from this screen (the
  // same accept/decline the Invitations inbox offers). Accepting opens a join
  // request; loadMine then surfaces the "Waiting for approval" card below.
  async function respondInvite(inv: HouseholdInvitation, action: 'accept' | 'decline') {
    setRespondingInvite(inv._id);
    try {
      if (action === 'accept') await householdApi.acceptInvitation(inv._id);
      else await householdApi.declineInvitation(inv._id);
      await refetchMyInvites();
      await loadMine();
      qc.invalidateQueries({ queryKey: ['household'] });
    } catch (e: any) {
      Alert.alert('Could not respond', e?.response?.data?.error || 'Please try again.');
    } finally {
      setRespondingInvite(null);
    }
  }

  async function approve(r: JoinRequestForApprover) {
    setApproveError('');
    setActing(r._id);
    try {
      const envelope = await wrapHDKForJoiner(r.requesterPublicKey, keyVersion);
      if (!envelope) { setApproveError('Your household key is not ready — reopen this screen and try again.'); return; }
      await householdApi.approveJoin(r._id, envelope);
      await refetch();
      qc.invalidateQueries();
      await loadPending();
    } catch (e: any) {
      setApproveError(e?.response?.data?.error || 'Could not approve');
    } finally {
      setActing(null);
    }
  }

  function reject(r: JoinRequestForApprover) {
    Alert.alert('Reject request?', 'This contact will not be able to join.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: async () => {
          setActing(r._id);
          try {
            await householdApi.rejectJoin(r._id);
            setPending((cur) => cur.filter((x) => x._id !== r._id));
            // Rejecting retires the invitation this request answered (server
            // marks it declined). Refresh the sent list so the invite drops off
            // the member's card immediately instead of lingering as "Accepted —
            // approve them below".
            await refetchInvites();
          } finally {
            setActing(null);
          }
        },
      },
    ]);
  }

  function removeMember(m: HouseholdMember) {
    const who = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'this member';
    Alert.alert(
      `Remove ${who}?`,
      'They’ll move to their own household with their own data. They won’t see anything you add afterward, but they keep access to what they could already see.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setActing(m._id);
            try {
              await householdApi.removeMember(m._id);
              await refetch();
              qc.invalidateQueries();
              // Drive the rotation now (the server flagged it) while we're unlocked,
              // then re-seal historical records under the new version and retire the
              // old envelopes (B1/B3) so the removed member's key opens nothing.
              await ensureHouseholdKey();
              void maintainKeyHygiene();
            } catch (e: any) {
              Alert.alert('Could not remove member', e?.response?.data?.error || 'Please try again.');
            } finally {
              setActing(null);
            }
          },
        },
      ]
    );
  }

  // Leaving a SHARED household moves you into a fresh solo one. Shared data stays
  // with the other members; you start clean. (Only surfaced when the household
  // has other members — a sole member has nothing to leave.)
  function leave() {
    Alert.alert(
      'Leave this household?',
      'You’ll leave the shared household and start fresh in your own. Anything shared here stays with the other members.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            setLeaving(true);
            try {
              await householdApi.leave();
              // The fresh solo household is born unencrypted — mint its key and
              // finish born-encrypted activation now so it never sits in a
              // plaintext state the user has to fix by hand. (ensureHouseholdKey
              // also re-arms the once-per-session activation latch on the
              // household change.) Best-effort: if the key is locked, the normal
              // on-unlock path still activates it.
              if ((await ensureHouseholdKey()) === 'ready') {
                await activateBornEncryptedHousehold().catch(() => {});
              }
              await refetch();
              qc.invalidateQueries();
            } finally {
              setLeaving(false);
            }
          },
        },
      ]
    );
  }

  if (isLoading || !household) {
    return <SkeletonList />;
  }

  return (
    <Screen>
      {/* Arrived from a Calen "Set up your household" setup chip with no one to
          share with yet — say why, then let the invite section below do the work. */}
      {promptInvite && (household?.members?.length ?? 0) <= 1 ? (
        <SetupCallout icon="people">Invite someone to your household so Calen can help you share and assign to them.</SetupCallout>
      ) : null}
      <Card style={styles.card}>
        <Input
          label="Household name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          onBlur={saveName}
          returnKeyType="done"
          onSubmitEditing={saveName}
        />
        <Text style={styles.caption}>Shared with everyone in your household.</Text>
      </Card>

      {/* Invitations to join ANOTHER household addressed to me — accept/decline
          right here (mirrors the Invitations inbox) so an outstanding invite is
          visible from where you manage membership. */}
      {pendingInvites.map((inv) => {
        const who = inv.fromName || inv.fromEmail || 'Someone';
        const where = inv.householdName ? `“${inv.householdName}”` : 'their household';
        const busy = respondingInvite === inv._id;
        return (
          <Card key={inv._id} style={styles.card}>
            <SectionTitle>You’ve been invited</SectionTitle>
            <Text style={styles.caption}>
              {who} invited you to join {where}. Accepting shares the family calendar, tasks, trips,
              and more — a member then confirms you on their device.
            </Text>
            <View style={styles.requestActions}>
              <View style={styles.actionBtn}>
                <Button title="Accept" onPress={() => respondInvite(inv, 'accept')} loading={busy} />
              </View>
              <View style={styles.actionBtn}>
                <Button title="Decline" variant="ghost" color={colors.error} onPress={() => respondInvite(inv, 'decline')} disabled={busy} />
              </View>
            </View>
          </Card>
        );
      })}

      {/* Requests to join THIS household — an existing member approves. */}
      {pending.length > 0 ? (
        <Card style={styles.card}>
          <SectionTitle>Requests to join</SectionTitle>
          <Text style={styles.caption}>
            Before approving, confirm the security code below matches the one the contact sees on
            their own Household screen while they wait — this proves you're granting access to the
            right contact.
          </Text>
          {!hdkReady ? (
            <Text style={styles.warn}>Your device is still unlocking the household key — reopen this screen if this persists.</Text>
          ) : null}
          {pending.map((r) => {
            const display = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || 'Someone';
            return (
              <View key={r._id} style={styles.requestRow}>
                <Text style={styles.memberName}>{display}</Text>
                {r.email ? <Text style={styles.memberEmail}>{r.email}</Text> : null}
                {fingerprints[r._id] ? (
                  <SecurityCode code={fingerprints[r._id]} copyable={false} />
                ) : (
                  <Text style={styles.fingerprint}>…</Text>
                )}
                <View style={styles.requestActions}>
                  <View style={styles.actionBtn}>
                    <Button title="Approve" onPress={() => approve(r)} loading={acting === r._id} disabled={!hdkReady} />
                  </View>
                  <View style={styles.actionBtn}>
                    <Button title="Reject" variant="ghost" onPress={() => reject(r)} disabled={acting === r._id} />
                  </View>
                </View>
              </View>
            );
          })}
          {approveError ? <Text style={styles.error}>{approveError}</Text> : null}
        </Card>
      ) : null}

      <Card style={styles.card}>
        <SectionTitle>Members ({household.members.length})</SectionTitle>
        {Object.values(safety).some((s) => s.status === 'changed') ? (
          <Text style={styles.safetyChanged}>
            A member's safety number changed since you verified it. Tap them to compare the new
            code before trusting this household with anything sensitive.
          </Text>
        ) : null}
        {household.members.map((m: HouseholdMember) => {
          const display = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || '?';
          const isMemberOwner = String(m._id) === String(household.ownerId);
          const canRemove = !!household.isOwner && !isMemberOwner;
          const s = safety[m._id];
          return (
            <TouchableOpacity
              key={m._id}
              style={styles.memberRow}
              activeOpacity={s ? 0.7 : 1}
              onPress={s ? () => showSafetyNumber(m) : undefined}
            >
              <View style={styles.memberAvatar}>
                <Text style={styles.memberInitial}>
                  {(m.firstName || m.email || '?').charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.memberText}>
                <Text style={styles.memberName} numberOfLines={1}>{display}</Text>
                {m.email ? <Text style={styles.memberEmail} numberOfLines={1}>{m.email}</Text> : null}
              </View>
              {s ? (
                <Ionicons
                  name={s.status === 'verified' ? 'shield-checkmark' : s.status === 'changed' ? 'alert-circle' : 'shield-outline'}
                  size={18}
                  color={s.status === 'verified' ? colors.success : s.status === 'changed' ? colors.error : colors.textMuted}
                  style={styles.safetyIcon}
                />
              ) : null}
              {isMemberOwner ? <Text style={styles.ownerChip}>Owner</Text> : null}
              {canRemove ? (
                <TouchableOpacity
                  onPress={() => removeMember(m)}
                  disabled={acting === m._id}
                  style={styles.removeBtn}
                  activeOpacity={0.7}
                >
                  {acting === m._id
                    ? <ActivityIndicator size="small" color={colors.error} />
                    : <Ionicons name="person-remove-outline" size={18} color={colors.error} />}
                </TouchableOpacity>
              ) : null}
            </TouchableOpacity>
          );
        })}

        <SectionTitle>Invite a member</SectionTitle>
        <Text style={styles.caption}>Search your contacts by name, or type an email or phone.</Text>
        <RevealWrap open={suggestOpen} count={suggestions.length} style={styles.inviteWrap}>
          <View style={styles.emailAddRow}>
            <Input
              value={inviteEmail}
              onChangeText={(t) => { setInviteEmail(t); setInviteError(''); setInviteNote(''); setSuggestOpen(true); }}
              placeholder="Add name, email, or phone…"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="send"
              onSubmitEditing={() => invite()}
              clearable={false}
              containerStyle={styles.emailInput}
              style={styles.emailInputField}
            />
            {inviting ? (
              <ActivityIndicator size="small" color={colors.primary} style={styles.emailAddIcon} />
            ) : (
              <TouchableOpacity
                onPress={() => invite()}
                disabled={!inviteEmail.trim()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.emailAddIcon}
              >
                <Ionicons name="add-circle" size={28} color={inviteEmail.trim() ? colors.primary : colors.border} />
              </TouchableOpacity>
            )}
          </View>
          {suggestOpen && suggestions.length > 0 ? (
            <View style={styles.dropdown}>
              {suggestions.map(({ key, p, entry, label, display }) => (
                <TouchableOpacity key={key} style={styles.suggestRow} onPress={() => invite(entry)}>
                  <View style={styles.suggestAvatar}>
                    <Text style={styles.memberInitial}>{(p.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.memberText}>
                    <Text style={styles.memberName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.memberEmail} numberOfLines={1}>
                      {label ? `${label} · ${display}` : display}
                    </Text>
                  </View>
                  <Ionicons
                    name={'phone' in entry ? 'chatbubble-outline' : 'mail-outline'}
                    size={16}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </RevealWrap>
        {inviteError ? <Text style={styles.error}>{inviteError}</Text> : null}
        {inviteNote ? <Text style={styles.note}>{inviteNote}</Text> : null}

        {(sentInvites ?? []).filter((i) => i.status !== 'declined').length > 0 ? (
          <View style={styles.invitesList}>
            {(sentInvites ?? []).filter((i) => i.status !== 'declined').map((inv) => (
              <View key={inv._id} style={styles.inviteRow}>
                <View style={styles.memberText}>
                  <Text style={styles.memberName} numberOfLines={1}>{inv.toEmail || inv.toPhone}</Text>
                  <Text style={styles.memberEmail}>
                    {inv.status === 'accepted' ? 'Accepted — approve them below' : 'Invited'}
                  </Text>
                </View>
                {/* Remind — re-open the composer for a still-pending invite. The
                    escape hatch for the no-composer path above: an account
                    holder whose push never landed (denied/stale) can still be
                    nudged from the inviter's own mail/Messages app. */}
                {inv.status !== 'accepted' ? (
                  <TouchableOpacity onPress={() => remindInvite(inv)} style={styles.removeBtn} activeOpacity={0.7}>
                    <Ionicons name="paper-plane-outline" size={19} color={colors.primary} />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => revokeInvite(inv)} style={styles.removeBtn} activeOpacity={0.7}>
                  <Ionicons name="close-circle-outline" size={20} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      {myRequest && myRequest.status === 'pending' ? (
        <Card style={styles.card}>
          <View style={styles.waitingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.waitingTitle}>Waiting for approval</Text>
          </View>
          <Text style={styles.caption}>
            A family member{myRequest.name ? ` in “${myRequest.name}”` : ''} needs to approve you on
            their device. This stays pending until they're online.
          </Text>
          <Text style={[styles.caption, styles.codeLabel]}>
            Read this security code to the member approving you — it must match the one on their
            screen before they approve, proving it's really you:
          </Text>
          {myCode ? (
            <SecurityCode code={myCode} />
          ) : (
            <Text style={[styles.caption, styles.codeLabel]}>Generating your security code…</Text>
          )}
          <View style={styles.cancelRow}>
            <Button title="Cancel request" variant="ghost" onPress={cancelRequest} loading={canceling} />
          </View>
        </Card>
      ) : null}

      {/* Only offered when the household is SHARED: leaving hands the shared data
          to the others and drops you into a fresh solo space. A sole member has
          nothing to leave (their household is their own data), so the action is
          hidden — the server no-ops it too. Constructively framed (you can't be
          in no household), a low-emphasis secondary action, not a red delete; the
          destructive weight lives in the confirm dialog `leave()` opens. */}
      {(household?.members.length ?? 0) > 1 ? (
        <Button title="Leave household" variant="ghost" onPress={leave} loading={leaving} />
      ) : null}

      {/* Quiet metadata footer: the encryption trust signal + the support
          handle. The household NAME is end-to-end encrypted (C2), so support
          can only look an account up by this id. The badge reflects the ACTUAL
          activation state (`e2eeActive`) — activation is automatic on unlock but
          can stall (e.g. a straggler that can't seal), and a badge hard-coded to
          "encrypted" would hide that. When still finishing, say so instead of
          claiming a state the household hasn't reached. */}
      <View style={styles.footer}>
        <View style={styles.encBadge}>
          <Ionicons
            name={household?.e2eeActive ? 'lock-closed' : 'time-outline'}
            size={13}
            color={household?.e2eeActive ? colors.textMuted : colors.warning}
          />
          <Text style={[styles.encBadgeText, household?.e2eeActive ? null : styles.encBadgePending]}>
            {household?.e2eeActive ? 'End-to-end encrypted' : 'Finishing encryption setup…'}
          </Text>
        </View>
        {!household?.e2eeActive ? (
          <Text style={styles.encPendingHint}>
            Your data is already encrypted; this finishes automatically the next time your key unlocks.
          </Text>
        ) : null}
        {household?._id ? (
          <Text style={styles.householdId} selectable>
            Household ID: {String(household._id)}
          </Text>
        ) : null}
      </View>
      {emailSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: spacing.md },
  cancelRow: { marginTop: spacing.sm },
  caption: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 17 },
  footer: { alignItems: 'center', marginTop: spacing.lg, gap: 6 },
  encBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  encBadgeText: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  encBadgePending: { color: colors.warning },
  encPendingHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', maxWidth: 300, lineHeight: 15 },
  householdId: { fontSize: 11, color: colors.textMuted, textAlign: 'center' },
  warn: { fontSize: 12, color: colors.warning ?? '#b26a00', marginBottom: spacing.sm },
  note: { fontSize: 12, color: colors.success, marginBottom: spacing.sm },
  inviteWrap: { position: 'relative', marginTop: spacing.sm },
  emailAddRow: { position: 'relative', justifyContent: 'center' },
  emailInput: { marginBottom: 0 },
  emailInputField: { paddingRight: 46 },
  emailAddIcon: { position: 'absolute', right: 10, alignItems: 'center', justifyContent: 'center' },
  dropdown: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface,
    marginTop: spacing.sm, overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  suggestAvatar: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  invitesList: { marginTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  inviteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  requestRow: { paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  requestActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  actionBtn: { flex: 1 },
  fingerprint: { fontSize: 13, letterSpacing: 1, color: colors.primary, marginTop: 4, fontVariant: ['tabular-nums'] },
  codeLabel: { marginTop: spacing.sm },
  safetyIcon: { marginRight: spacing.sm },
  safetyChanged: { fontSize: 12, color: colors.error, marginBottom: spacing.sm, lineHeight: 17 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 4 },
  waitingTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  memberAvatar: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
  },
  memberInitial: { color: '#fff', fontSize: 12, fontWeight: '700' },
  memberText: { flex: 1, minWidth: 0 },
  memberName: { fontSize: 14, fontWeight: '600', color: colors.text },
  memberEmail: { fontSize: 12, color: colors.textMuted },
  ownerChip: {
    fontSize: 11, fontWeight: '600', color: colors.primary, backgroundColor: colors.primary + '18',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden',
  },
  removeBtn: { padding: 6, marginLeft: spacing.sm },
  error: { color: colors.error, fontSize: 13, marginBottom: spacing.sm, marginTop: spacing.sm },
});
