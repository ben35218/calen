import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Alert, ActivityIndicator, TouchableOpacity, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { householdApi, peopleApi, Person, HouseholdMember, HouseholdInvitation, JoinRequestForApprover, JoinRequestMine } from '../../api';
import { Button, Card, Input, Screen, SectionTitle, useRevealOnOpen } from '../../components/ui';
import { ensureHouseholdKey, activateBornEncryptedHousehold, getHDK, wrapHDKForJoiner, publicKeyFingerprint, openRecord, sealUpdate } from '../../lib/e2ee';
import { HOUSEHOLD_ENC } from '../../lib/encSubsets';
import { loadSafetyNumbers, markVerified, MemberSafety } from '../../lib/safetyNumbers';
import { maintainKeyHygiene } from '../../lib/dropMigration';
import { useAuth } from '../../store/auth';
import { classifyRecipient, composeShareSms, composeShareEmail, Recipient } from '../../lib/shareInvite';
import { normalizePhone } from '../../lib/invitees';
import { normalizePerson } from '../../lib/personFields';
import { colors, spacing } from '../../theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Wraps the invite input + its suggestion dropdown so the keyboard-aware scroll
// lifts the pair clear of the keyboard when suggestions open. `useRevealOnOpen`
// reads Screen's scroll context, which only exists for components rendered
// INSIDE <Screen> — so it must live in this child, not in HouseholdScreen (which
// renders Screen and would read a null context, leaving the dropdown occluded).
function RevealWrap({
  open,
  count,
  style,
  children,
}: {
  open: boolean;
  count: number;
  style?: object;
  children: React.ReactNode;
}) {
  const ref = useRevealOnOpen(open, count);
  return (
    <View ref={ref} collapsable={false} style={style}>
      {children}
    </View>
  );
}

// Household hub: rename, invite members by email, approve-on-device joins
// (request → a member verifies a fingerprint and approves → membership + HDK
// envelope are granted), and member management. Joining another household is by
// accepting an emailed invitation from the Invitations inbox.
export default function HouseholdScreen() {
  const qc = useQueryClient();
  const { user } = useAuth();
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

  const { data: sentInvites, refetch: refetchInvites } = useQuery({
    queryKey: ['householdInvitations', 'sent'],
    queryFn: async () => (await householdApi.sentInvitations()).data,
  });

  // The in-app contacts roster (decrypted on-device) backs the invite field's
  // autocomplete — invite someone you already have on file by name, without
  // retyping their email or number. Same source as the event-invitee picker.
  const peopleQ = useQuery({
    queryKey: ['people', 'decrypted'],
    queryFn: async () => {
      const rows = (await peopleApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Person', p) as Promise<Person>));
    },
  });

  // Everyone already in the household, already invited, or yourself — hidden from
  // suggestions (the server rejects re-inviting these anyway).
  const taken = useMemo(() => {
    const set = new Set<string>();
    for (const m of household?.members ?? []) if (m.email) set.add(m.email.toLowerCase());
    for (const inv of sentInvites ?? []) {
      if (inv.status === 'declined') continue;
      if (inv.toEmail) set.add(inv.toEmail.toLowerCase());
      if (inv.toPhone) set.add(inv.toPhone.toLowerCase());
    }
    if (user?.email) set.add(user.email.toLowerCase());
    return set;
  }, [household?.members, sentInvites, user?.email]);

  // Roster contacts matching what's typed (by name, email, or phone), each
  // resolved to the recipient a tap would invite — their primary email, else a
  // normalized phone. Contacts with neither, or already covered, are dropped.
  const suggestions = useMemo(() => {
    const q = inviteEmail.trim().toLowerCase();
    if (!q) return [];
    const qDigits = q.replace(/\D/g, '');
    const recipientFor = (n: ReturnType<typeof normalizePerson>): Recipient | null => {
      const email = n.emails[0]?.value.trim().toLowerCase();
      const phone = n.phones[0]?.value ? normalizePhone(n.phones[0].value) : null;
      if (email && EMAIL_RE.test(email) && !taken.has(email)) return { email };
      if (phone && !taken.has(phone.toLowerCase())) return { phone };
      return null;
    };
    return (peopleQ.data ?? [])
      .map((p) => ({ p, n: normalizePerson(p), entry: null as Recipient | null }))
      .map((row) => ({ ...row, entry: recipientFor(row.n) }))
      .filter(({ p, n, entry }) => {
        if (!entry) return false;
        if ((p.name ?? '').toLowerCase().includes(q)) return true;
        if (n.emails.some((e) => e.value.toLowerCase().includes(q))) return true;
        if (qDigits && n.phones.some((ph) => ph.value.replace(/\D/g, '').includes(qDigits))) return true;
        return false;
      })
      .slice(0, 5)
      .map(({ p, entry }) => ({ p, entry: entry! }));
  }, [peopleQ.data, inviteEmail, taken]);

  const [myRequest, setMyRequest] = useState<JoinRequestMine | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [pending, setPending] = useState<JoinRequestForApprover[]>([]);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [approveError, setApproveError] = useState('');
  const [keyVersion, setKeyVersion] = useState(0);
  const [hdkReady, setHdkReady] = useState(false);

  useEffect(() => {
    if (household) setName(household.name);
  }, [household]);

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
        ? `${who}'s security code is different from the one you verified. This can mean they re-installed or re-enrolled — or that someone else holds their account. Compare the new code with them in person or over a call before trusting it:\n\n`
        : 'Compare this security code with the one on their device (in person or over a call). If they match, you know your encrypted data is shared with the right person:\n\n')
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
      if ('phone' in recipient) {
        // The server sends no text — compose it from this device.
        try {
          await composeShareSms(recipient.phone, what);
        } catch (e: any) {
          setInviteError(e?.message || 'Saved, but the text couldn’t be started.');
        }
        setInviteNote(
          data.userExists
            ? 'Invitation sent — it’s in their Invitations inbox.'
            : 'Invitation saved. Send the text so they can join once they get the app.',
        );
      } else {
        // The server sends no email either — compose it from this device, so it
        // comes from the inviter's own account and the server never handles the
        // address. (Existing accounts also get a push + in-app invite.)
        try {
          await composeShareEmail(recipient.email, what);
        } catch (e: any) {
          setInviteError(e?.message || 'Saved, but the email couldn’t be started.');
        }
        setInviteNote(
          data.userExists
            ? 'Invitation sent — it’s now in their Invitations inbox.'
            : 'Invitation saved. Send the email so they can join once they get the app.',
        );
      }
      await refetchInvites();
    } catch (e: any) {
      setInviteError(e?.response?.data?.error || 'Could not send the invitation');
    } finally {
      setInviting(false);
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
    Alert.alert('Reject request?', 'This person will not be able to join.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: async () => {
          setActing(r._id);
          try {
            await householdApi.rejectJoin(r._id);
            setPending((cur) => cur.filter((x) => x._id !== r._id));
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
      'They’ll move to their own household with their own data. Your household’s encryption key rotates so they can’t see anything you add afterward — but they keep access to what they could already see.',
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
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <Screen>
      <Card style={styles.card}>
        <Input
          label="Household name"
          value={name}
          onChangeText={setName}
          onBlur={saveName}
          returnKeyType="done"
          onSubmitEditing={saveName}
        />
        <Text style={styles.caption}>Shared with everyone in your household.</Text>
      </Card>

      {/* Requests to join THIS household — an existing member approves. */}
      {pending.length > 0 ? (
        <Card style={styles.card}>
          <SectionTitle>Requests to join</SectionTitle>
          <Text style={styles.caption}>
            Before approving, confirm the security code below matches what the person sees on their
            device — this proves you're granting access to the right person.
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
                <Text style={styles.fingerprint}>{fingerprints[r._id] || '…'}</Text>
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
              {suggestions.map(({ p, entry }) => (
                <TouchableOpacity key={p._id} style={styles.suggestRow} onPress={() => invite(entry)}>
                  <View style={styles.suggestAvatar}>
                    <Text style={styles.memberInitial}>{(p.name || '?').charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.memberText}>
                    <Text style={styles.memberName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.memberEmail} numberOfLines={1}>
                      {'email' in entry ? entry.email : entry.phone}
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
          <Button title="Cancel request" variant="ghost" onPress={cancelRequest} loading={canceling} />
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  card: { marginBottom: spacing.md },
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
