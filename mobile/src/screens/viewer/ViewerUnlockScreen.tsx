import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import {
  Screen, ScreenTitle, SectionHeader, Button, Input, Hint, HintDisclosure,
  FormError, Card, BottomSheet, Divider, IconAvatar,
} from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useCustomCalendars, refreshCustomCalendars } from '../../lib/calendarPrefs';
import { useSessionLocked } from '../../hooks/useSessionLocked';
import { useUnlocked } from '../../lib/unlock';
import { customCalendarsApi } from '../../api';
import {
  unlockWithPasskey, unlockWithPassword, unlockWithRecoveryCode, rekeyIdentity,
  hasSessionPassword,
} from '../../lib/e2ee';
import { passkeysSupported } from '../../lib/passkeys';
import { ensureSharedCalendarKeys } from '../../lib/calendarKeys';
import ViewerUpgradeBanner, { BANNER_H } from './ViewerUpgradeBanner';
import type { RootStackParamList } from '../../navigation/types';
import { colors, spacing, radius } from '../../theme';

// Free viewer mode's way back in (billing-plans.md "Free viewer mode",
// crypto-e2ee.md "Re-key"). A viewer's shared events are sealed to their
// identity key; `POST /auth/reset` changes only the LOGIN password, so after a
// forgotten-password reset the key no longer opens anything. This is where a
// locked viewer LANDS — ViewerNavigator makes it the whole shell while locked,
// because a calendar that can't decrypt a single event is not a calendar, it's
// a wall of empty cells with a note on it.
//
// Written for someone who has never heard the word "key". The page reads top to
// bottom in the order of the user's questions, one block per question:
//   1. WHAT'S WRONG — a lock disc and a plain-language headline, with the one
//      sentence of what-to-do-next under it. The state is legible before a
//      single word is read.
//   2. WHAT IT AFFECTS — the calendars shared with them, by name.
//   3. WHAT TO DO — the actions, most-likely-to-work first.
// Every explanation beyond that is folded behind an ⓘ toggle (HintDisclosure)
// and kept to a sentence or two, so the actions stay the loudest thing here. A
// nontechnical user confronted with three paragraphs about encryption concludes
// the app is broken; the same user shown two buttons taps one.
//
// Typing happens in bottom sheets, not inline: tapping "Unlock with password" /
// "I have a recovery code" opens a focused sheet with one field and one button,
// instead of unfolding a form mid-page and shoving the rest of the screen down.
// The page itself stays a short, stable list of choices.
//
// The actions, in the order they're offered:
//   - PASSKEY — instant, involves nobody. Labelled "Unlock with passkey", not
//     "with Face ID": the same credential is Touch ID on a home-button device,
//     and the OS sheet names the right one anyway. Absent on TestFlight/beta
//     builds (no associated-domains entitlement), so it can never be the only
//     path offered.
//   - PASSWORD — shown ONLY when the password factor still works
//     (`e2eePasswordStale === false`), which is the ordinary relaunch lock, not
//     the post-reset one. After a reset the password provably cannot unwrap the
//     envelope, so offering it would be the exact dead-end loop this screen
//     exists to end.
//   - REQUEST ACCESS — always available, always works, but waits on the owner.
//   - RECOVERY CODE — a quiet link. Every viewer was made to save one at signup,
//     so it's worth offering; most won't have it to hand, so leading with it
//     would make the screen read as a dead end.
// Exactly one action renders as the filled primary button — the best path that
// can actually work — and everything under it is a ghost or a link, so the
// screen always has a single obvious next tap.

// How often the confirmation re-checks whether the owner has approved. The
// answer arrives on someone else's schedule — minutes to days — so this is a
// courtesy refresh for a user watching the screen, not a race worth winning.
const APPROVAL_POLL_MS = 15000;

type Nav = NativeStackNavigationProp<RootStackParamList, 'ViewerUnlock'>;

export default function ViewerUnlockScreen() {
  const navigation = useNavigation<Nav>();
  const qc = useQueryClient();
  const { user, logout } = useAuth();
  const { calendars } = useCustomCalendars();
  const { unlocked } = useUnlocked();
  const locked = useSessionLocked();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const [askPassword, setAskPassword] = useState('');
  const [asked, setAsked] = useState(false);

  // Only the calendars shared TO this viewer. Their names are plaintext on the
  // calendar record, so they render fine while the events inside don't — which
  // is what lets this screen name what the user is trying to get back into.
  const shared = useMemo(
    () => calendars.filter((c) => !c.mine && !c.feedUrl && !c.holiday),
    [calendars],
  );
  const one = shared.length === 1;
  // The request outlives this component. `asked` covers the moment it's sent;
  // the seat's `accessRequestedAt` — set by the server when the owner was
  // nudged, cleared when they approve — covers every launch after, so signing
  // out and back in returns here instead of to a blank calendar that gives no
  // sign the request was ever made.
  const requestPending = shared.some((c) => c.accessRequestedAt);
  // Does this account have any content of its own to lose? A user who has never
  // bought the unlock has never been able to make any: the app is behind a hard
  // paywall, so the only Record on their account is the "You" Person the client
  // auto-seeds at boot (lib/selfPerson) — which the server's data-loss guard
  // dutifully counts, producing "1 items you saved in Calen" for someone who
  // saved nothing. Warning them that re-keying destroys data they neither
  // created nor can read is a scare with no decision behind it, so this
  // pre-confirms the guard for them. Owning even one calendar of their own
  // means real content, and the warning stands.
  const ownsNothing = !unlocked
    && !calendars.some((c) => c.mine && !c.feedUrl && !c.holiday);
  // After a password reset the E2EE password factor is stale server-side. That
  // flag is the difference between "you just need to sign in again" (ordinary
  // relaunch) and "signing in can never work" (post-reset) — the single most
  // important thing this screen gets right.
  const passwordWorks = !!user && user.e2eePasswordStale !== true;
  const hasPasskey = passkeysSupported();
  // Did this session already verify a password (sign-in or the reset itself)?
  // If so the re-key has its wrapping key and never needs to ask.
  const knowsPassword = hasSessionPassword();

  // While the wait is on, watch for the owner's answer — nothing else will tell
  // us. Approving clears the seat stamp server-side, so a periodic list refresh
  // is the whole mechanism; without it the user sits on a confirmation screen
  // that never resolves even after they've been let back in.
  const waiting = asked || requestPending;
  useEffect(() => {
    if (!waiting) return undefined;
    const tick = () => { void refreshCustomCalendars().catch(() => {}); };
    tick();
    const id = setInterval(tick, APPROVAL_POLL_MS);
    return () => clearInterval(id);
  }, [waiting]);

  // Only leave for the calendar once a pending request has actually cleared —
  // never on first paint, when the stamp simply hasn't been fetched yet.
  const sawPending = useRef(false);
  if (requestPending) sawPending.current = true;
  useEffect(() => {
    if (sawPending.current && !requestPending) navigation.replace('ViewerHome');
  }, [requestPending, navigation]);

  // One departure, ever: manual unlocks navigate from afterUnlock, the passive
  // self-heal below navigates on its own, and the approval effect above
  // replaces the route — without this latch two of them landing in the same
  // commit would pop/replace twice.
  const leaving = useRef(false);

  const goBackToCalendar = useCallback(() => {
    leaving.current = true;
    // Pushed from the shell → step back. Landed here as the whole shell (the
    // locked case) → there's nothing beneath, so open the calendar.
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace('ViewerHome');
  }, [navigation]);

  // An unlock that needed nobody's help: load the CalendarKeys the events are
  // sealed under and go straight to the calendar.
  const afterUnlock = useCallback(async () => {
    await ensureSharedCalendarKeys().catch(() => {});
    qc.invalidateQueries();
    goBackToCalendar();
  }, [goBackToCalendar, qc]);

  // Self-heal: leave for the calendar if the session unlocks WITHOUT an action
  // on this screen. A navigator that mounted during a still-running sign-in
  // enroll (the gate flips on setUser's render, and for a brand-new invitee the
  // billing round-trip can beat the KDF) lands here even though the unlock
  // completes moments later — and with `initialRouteName` read once at mount,
  // nothing else would ever move them off a recovery screen they don't need.
  // Guards: a manual unlock in flight (`busy`) or done (`leaving`) owns its own
  // navigation, and the request-sent state stays put — post-re-key the session
  // IS unlocked, but no calendar has been wrapped to the new key yet, so the
  // calendar would render as an empty grid that looks like lost data.
  useEffect(() => {
    if (locked || leaving.current || sawPending.current || busy || asked || requestPending) return;
    void afterUnlock();
  }, [locked, busy, asked, requestPending, afterUnlock]);

  // A stale error from one path shouldn't greet the user inside the next
  // one's sheet, so every open/close wipes it.
  const openSheet = (set: (v: boolean) => void) => () => { setError(''); set(true); };
  const closeSheet = (set: (v: boolean) => void) => () => { setError(''); set(false); };

  async function tryPasskey() {
    setBusy(true);
    setError('');
    try {
      if (await unlockWithPasskey()) await afterUnlock();
      else setError('That didn’t work. You can ask for access again below.');
    } catch (e: any) {
      setError(e?.message || 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }

  async function tryPassword() {
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      if (await unlockWithPassword(password)) await afterUnlock();
      else setError('That password didn’t work.');
    } catch (e: any) {
      setError(e?.message || 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }

  async function tryRecoveryCode() {
    const entered = code.trim();
    if (!entered) return;
    setBusy(true);
    setError('');
    try {
      if (await unlockWithRecoveryCode(entered)) await afterUnlock();
      else setError('That recovery code didn’t work.');
    } catch (e: any) {
      setError(e?.message || 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }

  // Mint a new identity key, then ask every shared calendar's owner to re-share
  // to it. One action over the whole list, not a button per calendar: the new
  // key replaces the single key every one of those calendars was sealed to.
  async function requestAccess(confirmDataLoss = false) {
    // Typed in the sheet, or — the usual case straight after a reset — the
    // password this session already verified at sign-in, held in memory by
    // e2ee.ts. Passing null lets the lib fall back to it.
    const typed = askPassword || null;
    if (!typed && !hasSessionPassword()) return;
    setBusy(true);
    setError('');
    try {
      const result = await rekeyIdentity(typed, {
        confirmDataLoss: confirmDataLoss || ownsNothing,
      });
      if (!result.ok) {
        // The account has encrypted content of its own (a refunded ex-payer,
        // say). Name what's actually at stake, in items rather than key-talk.
        setBusy(false);
        Alert.alert(
          'This will erase your own saved items',
          result.recoverableByHousehold
            ? `${result.recordCount} items you saved in Calen can only be opened with your current sign-in. Starting over won’t open them — someone else in your household will have to restore them for you. The calendars shared with you aren’t affected.`
            : `${result.recordCount} items you saved in Calen can only be opened with your current sign-in, and starting over will make them unreadable for good. The calendars shared with you aren’t affected.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Continue anyway',
              style: 'destructive',
              onPress: () => { void requestAccess(true); },
            },
          ],
        );
        return;
      }
      // Best-effort per calendar: one owner failing shouldn't sink the rest,
      // and the request re-sends on a later attempt.
      await Promise.all(
        shared.map((c) => customCalendarsApi.requestAccess(c.id).catch(() => {})),
      );
      qc.invalidateQueries();
      setAskOpen(false);
      setAskPassword('');
      setAsked(true);
    } catch (e: any) {
      setError(e?.message || 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }

  // ── Sent. The wait is on another person, so say that plainly. ──
  //
  // Every element is centred on one axis — icon, title, body, the ⓘ line, the
  // way out — because there is nothing to scan or compare here, only a status
  // to read. The upgrade offer is the exception that proves it: it sits on the
  // bottom edge as the same banner the calendar home uses, since this is the
  // one screen where the user genuinely cannot proceed — the app holds nothing
  // for them until someone else acts. That makes it an answer to "so what do I
  // do now?" rather than the upsell-for-the-problem it would be on the options
  // screen, where it is still deliberately absent.
  if (asked || requestPending) {
    return (
      <>
        <Screen>
          <View style={styles.doneIcon}>
            <Ionicons name="checkmark-circle" size={56} color={colors.success} />
          </View>
          <ScreenTitle style={styles.doneTitle}>Request sent</ScreenTitle>
          <Hint style={styles.doneBody}>
            {one
              ? `The owner of “${shared[0].name}” has been asked to share it again. It appears here once they say yes.`
              : 'Each owner has been asked to share again. Calendars appear here once they say yes.'}
          </Hint>
          {/* Same balanced-glyph treatment as the hero headline: left as a bare
              string the label stretched the full width, so it read as a
              left-aligned form row with the ⓘ stranded against the right edge —
              in the middle of an otherwise centred column. */}
          <HintDisclosure
            label={
              <View style={styles.disclosureRow}>
                <View style={styles.glyphBalance} />
                <Text style={styles.doneWhyLabel}>Why does someone else do this?</Text>
              </View>
            }
            accessibilityLabel="Why the owner has to approve"
            hint="Only the person who shared it can give access back — not us. They’ll see your request next time they open Calen."
            style={styles.doneWhy}
            hintStyle={styles.centeredHint}
          />
          {/* No "Back to calendar" here. Until an owner approves there is nothing
              to go back TO — the re-key left this account holding a new identity
              no calendar has been wrapped to yet, so the button would land the
              user on an empty grid that looks like the app lost their data. */}
          <Text
            style={styles.signOutLink}
            accessibilityRole="button"
            onPress={() => void logout()}
          >
            Sign out
          </Text>
          {/* Keep the column clear of the floating banner. */}
          <View style={styles.bannerSpacer} />
        </Screen>
        <ViewerUpgradeBanner onPress={() => navigation.navigate('UnlockPaywall')} />
      </>
    );
  }

  return (
    <>
      <Screen>
        {/* 1. WHAT'S WRONG — a lock disc and a plain-language headline. This is
            the screen's ONLY title: the nav bar is left blank (bare back
            chevron) so the hero states the user's situation instead of a route
            name repeating above it. The line under it says what happens next in
            one sentence. */}
        <View style={styles.hero}>
          <IconAvatar icon="lock-closed" size={64} bg={colors.primary} />
          {/* The headline IS the disclosure's label, so the ⓘ sits inline right
              after it and the whole line is the tap target. A separate "Why is
              it locked?" row asked the user to read the question they'd just
              been told the answer to the shape of; the glyph beside the
              statement says "there's more here" without spending a line on it.
              The what-happens-next line under this is gone for the same reason
              — "Pick an option below" only described the buttons already on
              screen. */}
          <HintDisclosure
            label={
              <View style={styles.disclosureRow}>
                {/* An empty slot the exact width of the ⓘ that HintDisclosure
                    draws on the other side. Without it the text+glyph pair is
                    centred as a block, which pushes the WORDS left of centre by
                    half a glyph; balancing it puts the headline on the view's
                    true centre line with the glyph beside it. */}
                <View style={styles.glyphBalance} />
                <Text style={styles.heroTitle}>
                  {one ? 'This calendar is locked' : 'Your shared calendars are locked'}
                </Text>
              </View>
            }
            accessibilityLabel="Why the calendar is locked"
            hint={
              passwordWorks
                ? 'Shared calendars are scrambled for privacy. This phone just needs you to prove it’s you.'
                : 'Shared calendars are scrambled for privacy. Your new password can’t unscramble what the old one protected — nobody can, including us. The owner shares it again instead.'
            }
            style={styles.heroWhy}
            hintStyle={styles.centeredHint}
          />
        </View>

        {/* 2. WHAT IT AFFECTS — the shared calendars, by name. No eyebrow over
            the card: the headline above has just said these are the locked
            shared calendars, so a "Shared with you" label restates it and adds
            a third stack of text between the user and the actions. A card of
            named rows with a padlock on each is self-evident. */}
        <Card>
          {shared.length ? shared.map((c, i) => (
            <View key={c.id}>
              {i > 0 ? <Divider /> : null}
              <View style={styles.calRow}>
                <View style={[styles.dot, { backgroundColor: c.color || colors.primary }]} />
                <Text style={styles.calName} numberOfLines={1}>{c.name}</Text>
                <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
              </View>
            </View>
          )) : (
            <View style={styles.calRow}>
              <Text style={styles.calNameMuted}>Nothing shared with you yet.</Text>
            </View>
          )}
        </Card>

        {/* Failures with no sheet to hold them — a passkey unlock, or a re-key
            fired straight off the button because the password was already
            known. Each sheet shows its own errors inline where the user is
            typing. */}
        {!pwOpen && !codeOpen && !askOpen && error
          ? <FormError style={styles.error}>{error}</FormError>
          : null}

        {/* 3. WHAT TO DO — one filled button for the best path that can work,
            everything else quieter beneath it. */}
        <SectionHeader style={styles.actionsHeader}>How to get back in</SectionHeader>
        <View style={styles.actions}>
          {hasPasskey ? (
            <Button title="Unlock with passkey" onPress={tryPasskey} disabled={busy} />
          ) : null}

          {passwordWorks ? (
            <Button
              title="Unlock with password"
              variant={hasPasskey ? 'ghost' : 'primary'}
              onPress={openSheet(setPwOpen)}
              disabled={busy}
            />
          ) : null}

          <Button
            title="Request access"
            variant={hasPasskey || passwordWorks ? 'ghost' : 'primary'}
            // Nothing to ask for when the session already holds a verified
            // password — the common path here, since a reset lands the user
            // signed in and locked. Send it and show the spinner in place.
            onPress={knowsPassword ? () => { void requestAccess(); } : openSheet(setAskOpen)}
            loading={busy && knowsPassword && !askOpen}
            disabled={busy || !shared.length}
          />
          <HintDisclosure
            label="What happens if I ask?"
            accessibilityLabel="What happens when you request access"
            hint={`We set this phone up fresh and ask ${one ? 'the owner' : 'each owner'} to share again. Nothing on their calendar changes.`}
          />
        </View>

        <Text style={styles.link} onPress={openSheet(setCodeOpen)}>
          I have a recovery code
        </Text>

        {/* The way out. A locked viewer lands here as the WHOLE shell, so the
            calendar's overflow menu — where sign-out otherwise lives — is
            unreachable; without this, someone who signed in as the wrong
            account, or who simply can't complete any option here, has no exit
            but deleting the app. Quiet muted text, exactly as the paywall
            demotes it: an escape hatch, never an offer. */}
        <Text
          style={styles.signOutLink}
          accessibilityRole="button"
          onPress={() => void logout()}
        >
          Sign out
        </Text>
      </Screen>

      {/* The ordinary relaunch unlock: one field, one button. */}
      <BottomSheet visible={pwOpen} onClose={closeSheet(setPwOpen)} title="Unlock with password" avoidKeyboard>
        <Hint>Enter the password you sign in with.</Hint>
        <Input
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
        />
        <FormError>{error}</FormError>
        <Button title="Unlock" onPress={tryPassword} loading={busy} disabled={busy || !password} />
      </BottomSheet>

      {/* The code every viewer was made to save at signup. */}
      <BottomSheet visible={codeOpen} onClose={closeSheet(setCodeOpen)} title="Recovery code" avoidKeyboard>
        <Hint>Enter the recovery code you saved when you set up Calen.</Hint>
        <Input
          value={code}
          onChangeText={setCode}
          placeholder="Enter your recovery code"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
        />
        <FormError>{error}</FormError>
        <Button title="Unlock" onPress={tryRecoveryCode} loading={busy} disabled={busy || !code.trim()} />
      </BottomSheet>

      {/* The password here is NOT a "confirm it's you" checkpoint — it is the
          key. `rekeyIdentity` → `enroll(password)` mints a new identity keypair
          and wraps its private half under this password
          (`crypto.createPasswordFactor`); that envelope IS the password factor
          the account unlocks with from here on. Drop the field and the new
          identity has only a recovery-code factor, so the viewer gets their
          calendar back and is locked out again on the next relaunch — the exact
          dead end this screen exists to end. So the copy says what it's for
          instead of asking someone who just reset their password to prove
          themselves again. */}
      <BottomSheet visible={askOpen} onClose={closeSheet(setAskOpen)} title="Request access" avoidKeyboard>
        <Hint>
          Use the password you sign in with now. It becomes this phone’s key, so the
          calendars open straight away once each owner shares again.
        </Hint>
        <Input
          value={askPassword}
          onChangeText={setAskPassword}
          placeholder="Your current password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
        />
        <FormError>{error}</FormError>
        <Button
          title="Send request"
          onPress={() => requestAccess()}
          loading={busy}
          disabled={busy || !askPassword}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: spacing.lg },
  // A HintDisclosure label that has to sit CENTRED. Its glyph is drawn after
  // the label, so an empty slot of the same width goes before it; without the
  // balance the text+glyph pair centres as a block and the words land half a
  // glyph left of the axis, and a long label stretches full width so the glyph
  // strands itself against the screen edge.
  disclosureRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  // Mirrors the glyph HintDisclosure renders after the label: its 18px icon
  // plus the row's 6px gap. Keep in step with `hintDisclosureRow` in ui.tsx —
  // if that gap or size changes, the label drifts off centre.
  glyphBalance: { width: 24 },
  // No marginTop: the title now shares a row with the ⓘ, so the gap under the
  // lock disc belongs to the row (heroWhy), not to the text inside it — an
  // offset here would push the words off the glyph's centre line. flexShrink
  // lets a long headline wrap instead of shoving the glyph off the edge.
  heroTitle: {
    fontSize: 20, fontWeight: '700', color: colors.text,
    textAlign: 'center', flexShrink: 1,
  },
  heroWhy: { marginTop: spacing.sm, alignItems: 'center' },
  // The revealed explanation under a centered disclosure keeps the centered
  // rhythm instead of snapping back to a left-aligned block.
  centeredHint: { textAlign: 'center' },
  // SectionHeader carries no top margin of its own, so it would otherwise sit
  // flush against the calendar card above it and read as part of that group.
  // This is the break between "what's locked" and "what to do about it".
  actionsHeader: { marginTop: spacing.lg },
  actions: { gap: spacing.sm },
  error: { marginTop: spacing.sm },
  doneIcon: { alignItems: 'center', marginBottom: spacing.md },
  doneTitle: { textAlign: 'center' },
  doneBody: { textAlign: 'center', marginTop: spacing.sm },
  doneWhy: { alignItems: 'center', marginTop: spacing.md },
  doneWhyLabel: {
    fontSize: 15, fontWeight: '600', color: colors.text,
    textAlign: 'center', flexShrink: 1,
  },
  // Clears the floating upgrade banner so the sign-out link can never sit
  // underneath it on a short screen.
  bannerSpacer: { height: BANNER_H + spacing.md },
  calRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: radius.sm },
  calName: { flex: 1, fontSize: 15, color: colors.text },
  calNameMuted: { flex: 1, fontSize: 15, color: colors.textMuted },
  link: {
    fontSize: 14, color: colors.primary, textAlign: 'center',
    marginTop: spacing.lg, paddingVertical: spacing.sm,
  },
  // Matches the paywall's sign-out exactly (screens/plan/UnlockPaywallScreen):
  // quiet, muted, generous tap target, set well apart from the actions above.
  signOutLink: {
    color: colors.textMuted, fontSize: 15, fontWeight: '600',
    textAlign: 'center', marginTop: spacing.xl, paddingVertical: spacing.sm,
  },
});
