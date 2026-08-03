import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, CenteredLoader, EmptyState, Hint } from '../../components/ui';
import AnchoredMenu, { AnchoredMenuItem } from '../../components/AnchoredMenu';
import { useAuth } from '../../store/auth';
import { useBilling } from '../../hooks/useBilling';
import { useSessionLocked } from '../../hooks/useSessionLocked';
import { customCalendarsApi, type CalendarEvent } from '../../api';
import { useCustomCalendars, refreshCustomCalendars } from '../../lib/calendarPrefs';
import { expandCalendarRange, loadCalendarWindowSources } from '../../lib/calendarData';
import type { YearMonth } from '../../lib/calendarWindow';
import { ensureSharedCalendarKeys } from '../../lib/calendarKeys';
import { getResourceKey, currentCalendarKeyVersion } from '../../lib/e2ee';
import type { RootStackParamList, ViewerEventSnapshot } from '../../navigation/types';
import ViewerMonthGrid, { type ViewerGridHandle } from './ViewerMonthGrid';
import ViewerAgendaList, { type ViewerAgendaHandle } from './ViewerAgendaList';
import ViewerUpgradeBanner, { BANNER_H } from './ViewerUpgradeBanner';
import { MonthJumpHeaderButton } from '../calendar/MonthJumpSheet';
import { colors, spacing } from '../../theme';

// Free viewer mode's home: the read-only shell a locked (no $4.99 unlock) user
// with shared-calendar access gets instead of the hard paywall (RootNavigator →
// ViewerNavigator). Shows ONLY the calendars shared TO this user (`mine ===
// false`) — the viewer's own household lanes stay behind the paywall.
//
// This screen is the host: it resolves the shared calendars, loads the replica
// once, and hosts two read-only layers under shared floating chrome —
// ViewerMonthGrid (the default; a read-only cousin of the unlocked app's
// Details month grid) and ViewerAgendaList (the upcoming-events list).
//
// The chrome follows the platform's division of labour: NAVIGATION on top
// (the grid's own "Month Year" jump label on the leading edge, and one
// trailing pill opening the view/actions menu — Calendar · List · Print ·
// What more can Calen do? · Sign out), the OFFER on the bottom edge (a
// persistent upgrade banner stating the value and the one-time price), and
// Today floating above it. The upsell deliberately does NOT sit in the
// top-left slot: that is the platform's back/identity affordance, so a promo
// there gets mis-tapped, and a promo shaped like nav chrome reads as a control
// and stops being seen.
//
// A viewer doesn't triage invitations: pending calendar shares are accepted
// silently on entry/focus, so a shared calendar simply appears (the unlocked
// app keeps the Invitations inbox's Accept/Decline flow). See billing-plans.md
// "Free viewer mode".

type Nav = NativeStackNavigationProp<RootStackParamList, 'ViewerHome'>;

// How far ahead the LIST layer looks. The grid's own window is unbounded; the
// agenda is consumed as "what's coming up", and eight weeks covers that.
const AGENDA_DAYS = 56;

// Floating-chrome metrics, matching the unlocked calendar's.
const TOP_BAR_ROW = 52;
const PILL_BG = colors.surface;
const BTN_FG = '#fff';

// Which layer the viewer last used. Remembered per device so the shell reopens
// where they left it (the grid is the first-run default).
const VIEW_KEY = 'hc_viewer_view';
type ViewMode = 'calendar' | 'list';

// Whether this device holds the calendar's current CalendarKey (the owner's
// device wraps it to a new collaborator on their next unlocked session — until
// then the shared events are ciphertext we can't open).
const monthLabel = (m: YearMonth) =>
  new Date(m.year, m.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

function keysHeld(calId: string): boolean {
  const version = currentCalendarKeyVersion(calId);
  return version > 0 && !!getResourceKey(calId, version);
}

export default function ViewerCalendarScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { logout } = useAuth();
  const { calendars, loaded: calendarsLoaded } = useCustomCalendars();
  // Mounted for its cache side effect, not its data: the status fetch
  // re-caches `hc_viewer_content` / `hc_unlocked`, so a purchase made
  // elsewhere, or a refund, or an un-share, re-routes the gate.
  useBilling();
  // Reactive: a render-time key read went stale after an unlock elsewhere,
  // leaving the locked note up on a session that could decrypt fine.
  const e2eeLocked = useSessionLocked();

  // The calendars shared TO this user. Feed/holiday calendars are device-local
  // derivations and can't be outside-shared — filtered for safety.
  const shared = useMemo(
    () => calendars.filter((c) => !c.mine && !c.feedUrl && !c.holiday),
    [calendars],
  );
  const sharedIds = useMemo(() => new Set(shared.map((c) => c.id)), [shared]);

  // Waiting on an owner to approve a re-key, with nothing readable yet. The
  // "Request sent" confirmation is component state on ViewerUnlock, so it used
  // to evaporate on sign-out and drop the user here — onto a blank grid whose
  // note ("events appear the next time its owner opens Calen") reads as an
  // ordinary sync delay rather than "your request is pending". The seat's
  // `accessRequestedAt` is the server's durable record of that wait, so hand
  // the screen back to ViewerUnlock, which shows the confirmation again.
  // `replace`, not navigate: there is nothing here to come back to until the
  // owner says yes, and the approval clears the stamp server-side.
  const awaitingApproval = shared.length > 0
    && shared.some((c) => c.accessRequestedAt)
    && shared.every((c) => !keysHeld(c.id));
  useEffect(() => {
    if (awaitingApproval) navigation.replace('ViewerUnlock');
  }, [awaitingApproval, navigation]);

  // ── The one replica read, shared by both layers ──
  // Load the member-wrapped CalendarKeys first (no-op once held), so the shared
  // events decrypt into the replica before the read. Range-independent, so the
  // grid can grow its month window for free (expansion is synchronous).
  const srcQ = useQuery({
    queryKey: ['viewer', 'sources'],
    queryFn: async () => {
      await ensureSharedCalendarKeys().catch(() => {});
      return loadCalendarWindowSources({ sync: 'background' });
    },
    enabled: shared.length > 0,
  });

  // Only the shared calendars' events — the viewer's own household lanes
  // (tasks, chores, own events) stay behind the paywall.
  const agendaEvents = useMemo(() => {
    if (!srcQ.data) return [] as CalendarEvent[];
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + AGENDA_DAYS * 86400_000);
    const data = expandCalendarRange(srcQ.data, from.toISOString(), to.toISOString());
    return (data.events ?? [])
      .filter((e) => e.calendarType && sharedIds.has(e.calendarType))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  }, [srcQ.data, sharedIds]);

  // A viewer never sees Accept/Decline: silently accept any pending calendar
  // share so it simply appears in the list. Best-effort per invitation (an
  // offline miss retries on the next focus); a success re-pulls the calendar
  // list, tries the member-wrapped key, and refreshes the free-viewer gate
  // signal (billing status counts accepted collaborations too, so it stays
  // truthful once the invite stops being pending).
  const acceptingShares = useRef(false);
  const acceptPendingShares = useCallback(async () => {
    if (acceptingShares.current) return;
    acceptingShares.current = true;
    try {
      const { data } = await customCalendarsApi.invitations();
      const pending = (data ?? []).filter((i) => i.status === 'pending');
      if (!pending.length) return;
      await Promise.all(
        pending.map((i) => customCalendarsApi.acceptInvitation(i._id).catch(() => {})),
      );
      await refreshCustomCalendars();
      await ensureSharedCalendarKeys().catch(() => {});
      qc.invalidateQueries({ queryKey: ['calendarInvitations'] });
      qc.invalidateQueries({ queryKey: ['billing', 'status'] });
      qc.invalidateQueries({ queryKey: ['viewer', 'sources'] });
    } catch { /* offline — retried on the next focus */ }
    finally { acceptingShares.current = false; }
  }, [qc]);

  // Re-check on every focus: a share sent while we were away auto-accepts, and
  // the owner finishing a share should surface events without a restart.
  useFocusEffect(
    useCallback(() => {
      void acceptPendingShares();
      if (shared.length) srcQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shared.length, acceptPendingShares]),
  );

  // ── The view toggle: calendar (default) ⇄ list ──
  const [mode, setMode] = useState<ViewMode>('calendar');
  const [listMounted, setListMounted] = useState(false);
  const progress = useRef(new Animated.Value(0)).current; // 0 = grid, 1 = list
  const gridRef = useRef<ViewerGridHandle>(null);
  const listRef = useRef<ViewerAgendaHandle>(null);
  const isList = mode === 'list';

  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY)
      .then((v) => { if (v === 'list') setMode('list'); })
      .catch(() => {});
  }, []);

  // Crossfade in place, so the chrome never moves. The list layer mounts lazily
  // (first use) and then stays, keeping each layer's scroll position.
  useEffect(() => {
    if (isList) setListMounted(true);
    Animated.timing(progress, { toValue: isList ? 1 : 0, duration: 220, useNativeDriver: true }).start();
  }, [isList, progress]);

  const setViewMode = (next: ViewMode) => {
    setMode(next);
    AsyncStorage.setItem(VIEW_KEY, next).catch(() => {});
  };

  const gridLayer = {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }],
  };
  const listLayer = {
    opacity: progress,
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }],
  };

  // The month on screen in whichever layer is active — kept in a ref for Print
  // (it moves at scroll frequency), mirrored into state only for the list
  // layer's header button, which has to re-render to relabel itself. The grid
  // draws its own label inside its sticky header.
  const viewedMonth = useRef<YearMonth | null>(null);
  const onViewedMonth = useCallback((m: YearMonth) => { viewedMonth.current = m; }, []);
  const [listMonth, setListMonth] = useState<YearMonth>(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const onListMonth = useCallback((m: YearMonth) => {
    viewedMonth.current = m;
    setListMonth((prev) => (prev.year === m.year && prev.month === m.month ? prev : m));
  }, []);

  // A month picked from the LIST's header: scroll the agenda there when its
  // rolling window covers that month, otherwise hand the jump to the grid and
  // switch to it — month travel past the agenda's horizon is a calendar job.
  const jumpFromList = useCallback((m: YearMonth) => {
    onListMonth(m);
    if (listRef.current?.scrollToMonth(m)) return;
    setViewMode('calendar');
    requestAnimationFrame(() => gridRef.current?.jumpTo(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onListMonth]);

  const openEvent = useCallback((event: ViewerEventSnapshot, calendarId?: string) => {
    const cal = shared.find((c) => c.id === (calendarId ?? event.calendarType));
    navigation.navigate('ViewerEvent', {
      event,
      calendarName: cal?.name ?? 'Calendar',
      accent: cal?.color || colors.primary,
    });
  }, [navigation, shared]);

  const openPrint = () => {
    const m = viewedMonth.current;
    navigation.navigate('ViewerPrint', m ? { year: m.year, month: m.month } : undefined);
  };
  const openPaywall = () => navigation.navigate('UnlockPaywall');

  // One trailing pill for everything that isn't navigation-by-scrolling: the
  // two views (checkmarked, Apple-Calendar style), then the occasional actions.
  // Print and Sign out live here rather than as top-level icons — both are
  // rare, high-intent, and don't deserve the weight of the view switch. The
  // upgrade path is deliberately NOT duplicated here: the banner owns it, and
  // a promo row inside a utility menu is noise.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems: AnchoredMenuItem[] = [
    ...(shared.length ? [{
      key: 'calendar',
      label: 'Calendar',
      active: !isList,
      // The unlocked app's glyph for this exact view (CalendarScreen's
      // DENSITY_META 'details') — the viewer grid IS that view, read-only.
      icon: <MaterialCommunityIcons name="view-stream-outline" size={20} color={colors.text} />,
      onPress: () => setViewMode('calendar'),
    },
    {
      key: 'list',
      label: 'List',
      active: isList,
      icon: <MaterialCommunityIcons name="format-list-bulleted" size={20} color={colors.text} />,
      onPress: () => setViewMode('list'),
    },
    {
      key: 'print',
      label: 'Print',
      dividerBefore: true,
      icon: <Ionicons name="print-outline" size={20} color={colors.text} />,
      onPress: openPrint,
    }] as AnchoredMenuItem[] : []),
    // Kept reachable from the menu as well as the note: with nothing
    // decryptable the grid may be empty, and the note sits in chrome the user
    // can miss. While locked, this is the only useful action on the screen.
    ...(e2eeLocked && shared.length ? [{
      key: 'restore',
      label: 'Restore access',
      dividerBefore: true,
      icon: <Ionicons name="lock-open-outline" size={20} color={colors.text} />,
      onPress: () => navigation.navigate('ViewerUnlock'),
    }] as AnchoredMenuItem[] : []),
    {
      key: 'signout',
      label: 'Sign out',
      dividerBefore: true,
      icon: <Ionicons name="log-out-outline" size={20} color={colors.text} />,
      onPress: () => void logout(),
    },
  ];

  // Calendars whose key hasn't reached this device yet (the owner must open
  // Calen unlocked to wrap it) — surfaced as a waiting note.
  const waiting = shared.filter((c) => !keysHeld(c.id));
  // The locked note must NOT say "sign in again". A forgotten-password reset is
  // how a viewer usually gets here, and it re-wraps nothing — the key envelope
  // still needs the OLD password, so signing in again with the new one can
  // never work. Telling them to do it loops them forever. Point at the one
  // screen that can actually resolve it instead.
  const hint = e2eeLocked && shared.length
    ? 'These events are encrypted to a key this device no longer has. Tap to restore access.'
    : !e2eeLocked && waiting.length
      ? waiting.length === 1
        ? `Events on “${waiting[0].name}” appear the next time its owner opens Calen.`
        : 'Some events appear once each calendar’s owner next opens Calen.'
      : null;
  const hintOpensUnlock = e2eeLocked && shared.length > 0;
  const openUnlock = useCallback(() => navigation.navigate('ViewerUnlock'), [navigation]);

  // The list layer's header carries the waiting/locked note and nothing else —
  // no roster of shared calendars: each row already wears its calendar's
  // colour, and the list is read as "what's coming up", not "whose". (In grid
  // mode the note floats above the Today pill instead.)
  const listHeader = hint ? (
    hintOpensUnlock ? (
      <TouchableOpacity onPress={openUnlock} activeOpacity={0.7}>
        <Hint style={[styles.hint, styles.hintAction]}>{hint}</Hint>
      </TouchableOpacity>
    ) : (
      <Hint style={styles.hint}>{hint}</Hint>
    )
  ) : null;

  // Sign out normally lives in the view/actions menu; the empty state repeats
  // it, because with nothing shared that screen is all a viewer has.
  const signOutRow = (
    <View style={styles.footer}>
      <Button title="Sign out" variant="ghost" onPress={() => void logout()} />
    </View>
  );

  // Waiting on an owner's approval: the effect above is already handing this
  // screen over to the confirmation, so paint nothing that belongs to a
  // calendar. Rendering the grid for those few frames flashed an empty month
  // with the waiting note floating over it — chrome that explains an ordinary
  // sync delay, shown to someone whose request is genuinely pending, as the
  // very first thing they see after signing in. A bare backdrop hands over
  // cleanly instead.
  if (awaitingApproval) {
    return (
      <View style={styles.screen}>
        <CenteredLoader color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Animated.View style={[StyleSheet.absoluteFill, gridLayer]} pointerEvents={isList ? 'none' : 'auto'}>
        <ViewerMonthGrid
          ref={gridRef}
          sources={srcQ.data}
          calendars={shared}
          onOpenEvent={openEvent}
          onViewedMonth={onViewedMonth}
          bottomPad={insets.bottom + BANNER_H + 72}
        />
      </Animated.View>
      {listMounted ? (
        <Animated.View style={[StyleSheet.absoluteFill, listLayer]} pointerEvents={isList ? 'auto' : 'none'}>
          <ViewerAgendaList
            ref={listRef}
            events={agendaEvents}
            calendars={shared}
            loading={srcQ.isLoading}
            refreshing={srcQ.isRefetching}
            onRefresh={() => srcQ.refetch()}
            onOpenEvent={openEvent}
            header={listHeader}
            onViewedMonth={onListMonth}
            topPad={insets.top + TOP_BAR_ROW + spacing.md}
            bottomPad={insets.bottom + BANNER_H + 72}
          />
        </Animated.View>
      ) : null}

      {/* ── Top row: navigation only. The leading edge belongs to the grid's
          own "Month Year" jump label (it scrolls with the calendar, so it
          lives in that layer and fades with it); the host draws the list
          layer's title there instead, and the trailing view/actions pill. ── */}
      <View
        style={[styles.topChrome, { paddingTop: insets.top, height: insets.top + TOP_BAR_ROW }]}
        pointerEvents="box-none"
      >
        {/* In grid mode this slot is empty and non-interactive so taps fall
            through to the grid's own sticky month label; the list has no
            sticky header of its own, so the host draws the same jump button
            here for it. */}
        <View style={styles.topLeading} pointerEvents={isList ? 'box-none' : 'none'}>
          {isList ? (
            <MonthJumpHeaderButton
              label={monthLabel(listMonth)}
              current={listMonth}
              onSelect={jumpFromList}
            />
          ) : null}
        </View>

        {/* A stable menu affordance, not a state-reflecting toggle: the glyph
            never changes meaning, and the active view is shown by the
            checkmark inside the menu. */}
        <TouchableOpacity
          style={[styles.pill, styles.menuPill]}
          onPress={() => setMenuOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Menu — change view, print, sign out"
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={BTN_FG} />
        </TouchableOpacity>
      </View>

      <AnchoredMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + TOP_BAR_ROW}
        items={menuItems}
      />

      {/* Nothing shared (yet) — an empty month grid explains nothing, so cover
          both layers with the state that does. Reachable when the gate signal
          came from a pending invitation the auto-accept pass hasn't landed
          yet, or after the owner un-shared their last calendar.

          Gated on `calendarsLoaded`: the list arrives asynchronously, so before
          it lands `shared` is empty for a reason that is NOT "nothing is shared
          with you". Rendering the verdict early told a viewer who DOES have a
          shared calendar that they had none — show the loader until the server
          list has actually answered. */}
      {!shared.length ? (
        <View
          style={[
            styles.emptyOverlay,
            { paddingTop: insets.top + TOP_BAR_ROW, paddingBottom: insets.bottom + BANNER_H },
          ]}
        >
          {!calendarsLoaded ? (
            <CenteredLoader color={colors.primary} />
          ) : (
            <>
              <EmptyState
                icon="calendar-outline"
                title="No shared calendars yet"
                message="When someone shares a calendar with you, it appears here automatically."
              />
              {signOutRow}
            </>
          )}
        </View>
      ) : null}

      {/* The waiting/locked note in grid mode (the list carries it in its
          header). The waiting note is passive chrome and stays click-through so
          it never eats a tap meant for the grid beneath; the LOCKED note is the
          entry point to recovery, so it takes taps. */}
      {hint && !isList ? (
        <View
          style={[styles.hintBanner, { bottom: insets.bottom + BANNER_H + 64 }]}
          pointerEvents={hintOpensUnlock ? 'box-none' : 'none'}
        >
          {hintOpensUnlock ? (
            <TouchableOpacity onPress={openUnlock} activeOpacity={0.7}>
              <Hint style={[styles.hintBannerText, styles.hintAction]}>{hint}</Hint>
            </TouchableOpacity>
          ) : (
            <Hint style={styles.hintBannerText}>{hint}</Hint>
          )}
        </View>
      ) : null}

      {/* ── Bottom-left: Today, driving whichever layer is active. Floats just
          above the banner, keeping the unlocked app's corner. ── */}
      {shared.length ? (
        <View style={[styles.pill, styles.bottomLeft, { bottom: insets.bottom + BANNER_H + 22 }]}>
          <TouchableOpacity
            style={styles.todayBtn}
            onPress={() => (isList ? listRef : gridRef).current?.scrollToToday(true)}
          >
            <Text style={styles.todayText}>Today</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* The standing offer, shared with the restore-access screen. */}
      <ViewerUpgradeBanner onPress={openPaywall} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },

  topChrome: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: PILL_BG, borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 4,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  topLeading: { flex: 1 },
  menuPill: { paddingHorizontal: 11, paddingVertical: 9 },
  pillBtn: { paddingHorizontal: 8, paddingVertical: 6 },

  bottomLeft: { position: 'absolute', left: spacing.md, zIndex: 10 },
  todayBtn: { paddingHorizontal: 16, paddingVertical: 6 },
  todayText: { color: BTN_FG, fontSize: 17, fontWeight: '700' },

  emptyOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 5, backgroundColor: '#000',
    justifyContent: 'center', paddingHorizontal: spacing.lg,
  },
  hintBanner: { position: 'absolute', left: spacing.md, right: spacing.md, zIndex: 10 },
  hintBannerText: { textAlign: 'center' },

  hint: { marginTop: spacing.md },
  // The locked note is a link, not a caption — colour it so the tap reads.
  hintAction: { color: colors.primary, textDecorationLine: 'underline' },
  footer: { marginTop: spacing.xl },
});
