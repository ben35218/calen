import React, { useCallback, useEffect, useLayoutEffect } from 'react';
import { TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useChat } from '../../hooks/useChat';
import ChatScreen from '../chat/ChatScreen';
import CreditsBanner from '../../components/CreditsBanner';
import { peopleApi, householdApi, calendarApi, callsApi } from '../../api';
import { getHDK, openRecord, sealNew } from '../../lib/e2ee';
import type { AssistantFocusEvent, RootStackParamList } from '../../navigation/types';
import { loadCalendarSources } from '../../lib/calendarData';
import { loadPassiveForecast } from '../../lib/weatherSource';
import { usePrivacyPrefs } from '../../lib/privacyPrefs';
import { useAuth } from '../../store/auth';
import { createAliasContext } from '../../lib/aiPayload';
import { deriveAiWindow, scopeCalendarSources } from '../../lib/aiWindow';
import type { AssistantId } from '../chat/assistantTabs';

// Turn the assistant's drafted event (open_create_event_form input) into the
// CalendarEvent payload the API expects — mirrors EventFormScreen's save logic
// so "Save this to my calendar" produces the same record as saving the form.
function buildEventPayload(ev: Record<string, any>): Record<string, unknown> {
  const allDay = ev.allDay !== false; // events default to all-day
  const startDate = allDay
    ? `${ev.date}T12:00:00.000Z`
    : new Date(`${ev.date}T${ev.startTime || '09:00'}:00`).toISOString();
  const endPart = ev.endDate || ev.date;
  const endDate = allDay
    ? ev.endDate
      ? `${ev.endDate}T12:00:00.000Z`
      : undefined
    : ev.endTime
    ? new Date(`${endPart}T${ev.endTime}:00`).toISOString()
    : undefined;
  return {
    title: String(ev.title || '').trim(),
    calendarType: ev.calendarType || 'activities',
    allDay,
    startDate,
    endDate,
    description: ev.description || undefined,
    phone: ev.phone || undefined,
    reminderMinutes: typeof ev.reminderMinutes === 'number' ? ev.reminderMinutes : undefined,
    recurrence: ev.recurrFreq
      ? {
          freq: ev.recurrFreq,
          interval: typeof ev.recurrInterval === 'number' && ev.recurrInterval > 1 ? ev.recurrInterval : undefined,
        }
      : undefined,
  };
}

// A chip that would have Calen place a phone call gets the phone glyph — it
// commits to actually ringing a business, so it should read as more than a
// suggested reply. Chips about an already-running call ("Any update on the
// call?") deliberately don't match.
function isCallChip(text: string): boolean {
  return (
    /^((yes|okay?|sure|please)[,!]?\s+)*(please\s+)?call\b/i.test(text) ||
    /\b(place|make)\s+(the|a|that)\s+call\b/i.test(text) ||
    /\bcall\s+(them|him|her|the|back)\b/i.test(text)
  );
}

// Calendar Assistant — ports client/src/views/CalendarAssistantView.vue.
// navigateTo from the web (router paths) doesn't map to RN screens, so instead
// of navigating we just refresh the calendar so any changes the assistant made
// show up. (Deep-link mapping of navigateTo is a deferred polish item.)
export default function CalendarAssistantScreen({
  onSelectAssistant,
  focusEvent,
}: { onSelectAssistant?: (id: AssistantId) => void; focusEvent?: AssistantFocusEvent } = {}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const qc = useQueryClient();
  const { user } = useAuth();
  // Privacy toggle ("Use personal & contact info in prompts"). Read reactively so
  // the assistant's system prompt, its "what I can see" panel, and the decrypt/
  // upload of contacts all track the setting — and re-sync if it resolves late.
  const usePersonal = usePrivacyPrefs().prefs.aiUsePersonalInfo;

  // Ephemeral-consent (§9.1 P4c): post-drop send decrypted people + calendar
  // sources so the server needn't read stored plaintext. Dormant pre-drop.
  // `ephemeralRef` holds the (sanitized) roster for the context panel + prompt;
  // the calendar sources are kept RAW here and scoped per-turn in buildBody (G4).
  const ephemeralRef = React.useRef<Record<string, unknown> | null>(null);
  const rawCalendarRef = React.useRef<Record<string, unknown> | null>(null);
  const weatherRef = React.useRef<unknown>(null);

  // G1 (AI payload minimization): everything leaving the device passes through
  // this context — record/foreign-key ids become per-conversation aliases, and
  // ids inside tool results resolve back to real ids before the app acts.
  const aliasCtx = React.useMemo(() => createAliasContext(), []);

  const chat = useChat({
    endpoint: '/calendar/chat',
    // Pass the toggle to the context endpoint too, so the "what I can see" panel
    // doesn't claim access to household details the prompt won't actually get.
    contextEndpoint: `/calendar/chat/context?includePersonalInfo=${usePersonal}`,
    // Post-drop the DB people are sealed — POST the decrypted roster instead.
    contextBody: () =>
      ephemeralRef.current ? { includePersonalInfo: usePersonal, people: ephemeralRef.current.people } : null,
    // Privacy toggle: tell the server whether it may use household contacts in the
    // prompt. When off, the server withholds them (and we also skip decrypting/
    // sending people below, so plaintext contacts never leave the device).
    // G4 (query-scoped context): scope the calendar sources to a window DERIVED
    // FROM THIS TURN'S CONVERSATION before they leave the device — only the
    // records the turn plausibly needs are sent (recurring items always kept, so
    // recurrence questions never regress). The window recomputes each turn, so a
    // follow-up naming a later date widens the next payload.
    buildBody: (messages) => {
      const focusDate = focusEvent?.startDate ? new Date(focusEvent.startDate) : null;
      const window = deriveAiWindow(messages.map((m) => m.content), new Date(), focusDate);
      const scoped = rawCalendarRef.current
        ? aliasCtx.sanitize(scopeCalendarSources(rawCalendarRef.current, window))
        : null;
      return {
        messages,
        includePersonalInfo: usePersonal,
        ...(focusEvent ? { focusEvent: aliasCtx.sanitize(focusEvent) as AssistantFocusEvent } : {}),
        ...(ephemeralRef.current || {}),         // { people } (roster — not windowed)
        ...(scoped ? { calendarSources: scoped } : {}),
        ...(weatherRef.current ? { weather: weatherRef.current } : {}),
      };
    },
    transformResult: aliasCtx.resolveAliases,
    onResult: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      // Link-back for chat-placed calls (G1): rows created by call_business hold
      // an aliased event id only this conversation can resolve — patch the real
      // id on so the confirmed-cancel → event-cancelled flow keeps working.
      callsApi.list().then(({ data }) => Promise.all(
        data.flatMap((c) => {
          const real = c.eventId ? aliasCtx.fromAlias(c.eventId) : undefined;
          return real ? [callsApi.link(c._id, real)] : [];
        }),
      )).catch(() => { /* best-effort; retried on the next turn */ });
    },
    toolLabels: {
      list_events: 'Checking your calendar…',
      get_event_details: 'Checking the event…',
      get_household_members: 'Checking household names…',
      open_create_event_form: 'Opening the event form…',
      open_edit_event_form: 'Opening the event…',
      open_delete_event_form: 'Opening the event…',
      call_business: 'Placing the call…',
      check_call_status: 'Checking the call…',
      get_weather_forecast: 'Checking the weather…',
      suggest_navigation: 'Finding a shortcut…',
    },
  });

  // (Re)load the "what I can see & do" panel whenever the toggle resolves/changes
  // so it stays truthful about whether household details are in scope.
  useEffect(() => {
    chat.loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usePersonal]);

  useEffect(() => {
    (async () => {
      try {
        let e2eeActive = false;
        try { e2eeActive = !!(await householdApi.get()).data.e2eeActive; } catch { /* solo/offline */ }
        if (!e2eeActive || !getHDK()) return;
        // Honor the privacy toggle: when contacts aren't allowed in prompts, don't
        // even decrypt/upload them — the server withholds them regardless.
        const now = new Date();
        const from = new Date(now.getFullYear() - 1, 0, 1).toISOString();
        const to = new Date(now.getFullYear() + 2, 0, 1).toISOString();
        const [calendarSources, peopleRows, weather] = await Promise.all([
          loadCalendarSources({ from, to }),
          usePersonal
            ? peopleApi.list().then(({ data }) => Promise.all(data.map((p) => openRecord('Person', p as any))))
            : Promise.resolve([]),
          loadPassiveForecast().catch(() => null),
        ]);
        // G1: strip server metadata + alias every id before anything leaves the
        // device — the model reasons over content and opaque aliases only. The
        // roster is sanitized once here (not windowed); the calendar sources stay
        // RAW and are scoped + sanitized per turn in buildBody (G4).
        //
        // People projection (spec ai-assistant.md) — the only people shape that
        // leaves the device:
        //   • family/friend  → NAME ONLY (nothing else — no birthdays, so the
        //     calendar sources also drop their people feed below).
        //   • service (pro)  → the business details the user saved them for
        //     (service + business name + address), so the assistant can reason
        //     about who handles what. Phone/email stay "on file" flags, never
        //     raw — the reference-not-values rule and the public transparency
        //     promise ("phone numbers replaced with 'on file' markers").
        const selfId = String(user?._id || '');
        const projected = (peopleRows as Array<Record<string, unknown>>)
          .filter((p) => p && typeof p.name === 'string'
            && (p.type === 'family' || p.type === 'friend' || p.type === 'service'))
          .map((p) => {
            if (p.type === 'service') {
              return {
                _id: p._id,
                name: p.name,
                type: p.type,
                service: p.relationship || undefined,     // e.g. "plumber"
                businessName: p.businessName || undefined,
                address: p.address || undefined,
                phoneOnFile: !!p.phone,
                emailOnFile: !!p.email,
              };
            }
            return {
              _id: p._id,
              name: p.name,
              type: p.type,
              isSelf: !!p.accountId && String(p.accountId) === selfId,
            };
          });
        ephemeralRef.current = { people: aliasCtx.sanitize(projected) };
        rawCalendarRef.current = {
          ...(calendarSources as unknown as Record<string, unknown>),
          people: [],
        };
        weatherRef.current = weather || null;
        chat.loadContext(); // refresh the "what I can see" panel with the decrypted roster
      } catch { /* non-fatal — server falls back to its DB read */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usePersonal]);

  // After the assistant drafts an event it pins two chips: "Save this to my
  // calendar" (create it directly) and "Edit in form" (open the pre-filled create
  // form). Both consume the draft; any other chip falls through to a chat send.
  const handleFollowup = useCallback(
    (text: string): boolean => {
      const ev = chat.pendingEvent as Record<string, any> | null;
      if (!ev) return false;
      if (text === 'Edit in form') {
        chat.resolvePending();
        navigation.navigate('EventForm', { prefill: ev });
        return true;
      }
      if (text === 'Save this to my calendar') {
        (async () => {
          try {
            // E2EE dual-write: seal ciphertext alongside plaintext (no-op without an HDK).
            await calendarApi.createEvent(await sealNew('CalendarEvent', buildEventPayload(ev)));
            qc.invalidateQueries({ queryKey: ['calendar'] });
            chat.resolvePending();
            Alert.alert('Added to your calendar', String(ev.title || 'Event'));
          } catch (e: any) {
            Alert.alert('Couldn’t save', e?.response?.data?.error || 'Please try again.');
          }
        })();
        return true;
      }
      return false;
    },
    [chat, navigation, qc]
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        chat.messages.length > 0 ? (
          <TouchableOpacity onPress={chat.clear} disabled={chat.loading}>
            <Text style={styles.clear}>Clear</Text>
          </TouchableOpacity>
        ) : undefined,
    });
  }, [navigation, chat.messages.length, chat.loading, chat.clear]);

  return (
    <ChatScreen
      chat={chat}
      surface="calendar"
      activeAssistant="calendar"
      onSelectAssistant={onSelectAssistant}
      banner={<CreditsBanner />}
      emptyHint={
        focusEvent
          ? `e.g. "Cancel this appointment" or "Reschedule ${focusEvent.title} to next week"`
          : 'e.g. "Add a dentist appointment on June 20"'
      }
      placeholder="Message…"
      onFollowupPress={handleFollowup}
      followupKind={(text) =>
        text === 'Save this to my calendar'
          ? 'add'
          : text === 'Edit in form'
          ? 'review'
          : isCallChip(text)
          ? 'call'
          : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  clear: { color: '#fff', fontSize: 15, fontWeight: '500' },
});
