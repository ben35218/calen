import { useCallback, useEffect, useRef, useState } from 'react';
import EventSource from 'react-native-sse';
import { API_URL } from '../config';
import { getCachedToken } from '../lib/secureToken';
import api from '../api/client';
import { AttachmentKind, PickedFile, classifyAttachment, readFileBase64 } from '../lib/media';
import {
  StoredChatWithSurface,
  consumeResumeFor,
  loadAllRecentChats,
  newChatId,
  saveChat,
} from '../lib/chatHistory';
import { useAuth } from '../store/auth';

// Mirrors client/src/composables/useChat.js for React Native. RN's fetch can't
// stream response bodies, so the SSE transport uses react-native-sse (an
// XHR-based EventSource that supports POST + custom headers + body). The bearer
// token is attached explicitly here from the SecureStore-backed cache — this
// request does NOT go through the axios instance, so it would otherwise be
// unauthenticated.
//
// Deferred vs web: rich markdown rendering (bubbles use flattenMarkdown
// instead). History persistence is device-local via lib/chatHistory (opt-in
// per surface with `historyKey`).

// A file the user attached to their message. `data` (base64) rides along in the
// request body so the server can hand it to Claude as an image/PDF block; `uri`
// is kept only for the on-device thumbnail in the sent bubble.
export interface ChatAttachment {
  name: string;
  type: string; // mime type
  kind: AttachmentKind;
  uri?: string;
  data?: string; // base64, no data: prefix
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  // Credits this assistant turn cost (from the `done` event) — chat is
  // token-priced, so it grows with the reply length. Shown under the bubble.
  credits?: number;
  // Interactive affordances the assistant offered ON THIS turn — the follow-up /
  // action chips and the nav suggestions — rendered inline under this bubble and
  // kept in scrollback (they persist with the message, so they survive a resume).
  // Every past turn keeps its own chips, all still tappable. Only assistant turns
  // carry these.
  followups?: string[];
  navSuggestions?: { view: string; label: string; kind?: 'nav' | 'setup' }[];
  // The record this turn drafted (calendar event / chore), stashed on the message
  // so a chip tapped later — even after scrolling back through the history — acts
  // with that turn's own draft rather than a single shared "latest draft".
  pendingEvent?: Record<string, unknown> | null;
  pendingChore?: Record<string, unknown> | null;
  // Events the calendar assistant staged this turn for deletion (delete_event) —
  // rendered as one "Delete from my calendar" confirm chip; the tap runs the
  // actual deletes. Nothing is removed until the user confirms.
  pendingDeletes?: PendingDelete[] | null;
  // Event the calendar assistant staged this turn for editing (open_edit_event_form);
  // the "Open the event to edit" chip opens the native edit form on it.
  pendingEdit?: PendingEdit | null;
  // Labels of one-shot action chips already executed on this turn (e.g. the
  // direct-create "Save this to my calendar"). Such a chip stays VISIBLE but is
  // rendered disabled once used, so it can't run twice and create a duplicate.
  // Chips that merely open a form (Edit in form / Review & add chore) are never
  // marked, so they stay tappable.
  usedActions?: string[];
}

export interface ChatContext {
  sees?: string[];
  can?: string[];
  note?: string;
}

// A single event the calendar assistant staged for deletion (server delete_event).
// `eventId` is a real record id (aliases already resolved by transformResult).
export interface PendingDelete {
  eventId: string;
  title?: string;
  recurring?: boolean;
  scope?: 'occurrence' | 'series';
  occurrenceDate?: string; // YYYY-MM-DD, for a recurring occurrence
}

// The event the calendar assistant staged for editing (server open_edit_event_form).
export interface PendingEdit {
  eventId: string;
  title?: string;
  occurrenceDate?: string;
}

export interface ChatDoneData {
  reply?: string;
  followups?: string[];
  // Screens the assistant offered to open (suggest_navigation tool); each `view`
  // maps to a client screen in screens/chat/navDestinations.ts. `kind` is 'nav'
  // (go look at / act on a screen) or 'setup' (go configure a missing value) —
  // the chip renders a gear icon for setup, an arrow for nav.
  navSuggestions?: { view: string; label: string; kind?: 'nav' | 'setup' }[];
  navigateTo?: string;
  tasksCreated?: { id: string; title: string }[];
  // Claude tokens this reply consumed (summed across the agentic tool loop).
  // Kept for diagnostics; the UI shows `creditsUsed`, not tokens.
  tokensUsed?: number;
  // Whole credits this turn was debited (token-priced chat). Shown to the user.
  creditsUsed?: number;
  // Proposed tasks the client must create encrypted post-drop (§9.1 P4d).
  clientCreateTasks?: Record<string, unknown>[];
  // Maintenance tasks Calen staged this turn in the AI plan chat (not created).
  proposedTasks?: Record<string, unknown>[];
  // Event the calendar assistant drafted this turn (open_create_event_form
  // input). Present it as "Save this to my calendar" / "Edit in form" actions.
  pendingEvent?: Record<string, unknown>;
  // Chore the chores assistant drafted this turn (open_create_chore_form input);
  // the "Review & add chore" chip opens the prefilled chore form.
  pendingChore?: Record<string, unknown>;
  // Events the calendar assistant staged for deletion (delete_event) / editing
  // (open_edit_event_form) this turn. Ids are aliases here; transformResult
  // resolves them to real ids before they reach the screen.
  pendingDeletes?: PendingDelete[];
  pendingEdit?: PendingEdit;
}

export interface UseChatOptions {
  endpoint: string; // relative to API_URL, e.g. '/calendar/chat'
  contextEndpoint?: string; // relative GET path incl. any query string
  // §9.1 P4 polish: when this returns a body (e.g. decrypted records on an E2EE
  // household), the context is POSTed with it instead of GET — the server can't
  // read sealed content, so the client supplies it. Return null for plain GET.
  contextBody?: () => Record<string, unknown> | null;
  buildBody: (messages: ChatMessage[]) => Record<string, unknown>;
  onResult?: (data: ChatDoneData) => void;
  toolLabels?: Record<string, string>;
  // AI payload minimization (G1): records leave the device with their ids
  // replaced by per-conversation aliases, so any ids in a tool RESULT are
  // aliases too. When set, every done-payload is passed through this before
  // the app acts on it (screens pass their alias context's resolveAliases).
  transformResult?: <T>(data: T) => T;
  // Opt into device-local 7-day chat history (lib/chatHistory) under this
  // surface key (e.g. 'calendar', `trips:<tripId>`). Enables the Recent-chats
  // sheet + resume; `clear` then starts a NEW chat (the old one stays in
  // history) instead of destroying the conversation.
  historyKey?: string;
}

class ChatQuotaError extends Error {}

type ChatSSEEvent = 'text' | 'tool' | 'done';

function parseData(data: string | null): Record<string, any> {
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function useChat(options: UseChatOptions) {
  // Keep the latest options in a ref so the streaming callbacks never go stale
  // and don't need to be torn down/recreated when the caller passes inline
  // buildBody/onResult/toolLabels.
  const optsRef = useRef(options);
  optsRef.current = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  // Files staged for the next message; cleared on send. Removable one-by-one
  // from the input bar before sending.
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toolActivity, setToolActivity] = useState('');
  const [error, setError] = useState('');
  // True when the last turn was refused because the prepaid credit balance is
  // spent (HTTP 402 CREDITS_EXHAUSTED). Drives a tappable "Buy credits"
  // affordance instead of the useless Retry.
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  // Chips (follow-ups, nav suggestions) and drafted records are no longer held as
  // a single "latest turn" state — each assistant turn carries its own on the
  // ChatMessage, so every past turn's chips stay in scrollback and tappable. See
  // the `done` handler, which stamps them onto the appended message.
  const [context, setContext] = useState<ChatContext | null>(null);
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([]);
  // Running total of credits this chat session has cost (for a live indicator).
  const [sessionCredits, setSessionCredits] = useState(0);

  // Device-local history (when `historyKey` is set): the id of the conversation
  // on screen, and the sheet's visibility. `allChats` holds recents from EVERY
  // assistant surface (not just this one) so the sheet is unified — resuming a
  // chat from another tab hands off via chatHistory's resume channel. History is
  // per-user — signed out, nothing persists.
  const { user } = useAuth();
  const userId = user?._id ? String(user._id) : null;
  const chatIdRef = useRef(newChatId());
  const [allChats, setAllChats] = useState<StoredChatWithSurface[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const esRef = useRef<EventSource<ChatSSEEvent> | null>(null);
  // Set to the in-flight turn's aborter while a stream is open (cleared on
  // teardown). Tapping the composer's Stop button calls this to end the turn —
  // it settles the streamRequest promise so `run`'s finally clears `loading`.
  const abortRef = useRef<(() => void) | null>(null);

  // Tear down any in-flight stream on unmount.
  useEffect(
    () => () => {
      esRef.current?.removeAllEventListeners();
      esRef.current?.close();
      esRef.current = null;
      abortRef.current = null;
    },
    []
  );

  // Swap a stored conversation onto the screen. Chips + drafted records ride on
  // the messages themselves, so restoring `messages` restores every past turn's
  // affordances ("Save this to my calendar" / "Edit in form" / "Review & add
  // chore") automatically — including which were already used (disabled). The
  // user continues by typing; the next send posts the resumed history like any
  // other turn (the server is stateless). Adopting the stored id means the persist
  // effect re-saves it, bumping updatedAt so a just-resumed chat won't expire.
  const applyResume = useCallback((conv: StoredChatWithSurface) => {
    chatIdRef.current = conv.id;
    setMessages(conv.messages);
    setAttachments([]);
    setError('');
    setQuotaExceeded(false);
    setStreamingText('');
    setSessionCredits(conv.messages.reduce((n, m) => n + (m.credits || 0), 0));
    setHistoryOpen(false);
  }, []);

  // Seed the unified Recent-chats sheet from storage (every surface, 7-day
  // window). On mount this surface also claims any cross-tab resume request
  // parked for it — the sheet on another tab tapped one of THIS surface's chats,
  // switched here, and left the id to pick up once the chats have loaded.
  const historyKey = options.historyKey;
  useEffect(() => {
    if (!historyKey || !userId) return;
    let alive = true;
    loadAllRecentChats(userId).then((chats) => {
      if (!alive) return;
      setAllChats(chats);
      const pendingId = consumeResumeFor(historyKey);
      const conv = pendingId ? chats.find((c) => c.id === pendingId) : undefined;
      if (conv) applyResume(conv);
    });
    return () => {
      alive = false;
    };
  }, [historyKey, userId, applyResume]);

  // Persist the conversation as it grows (both the user turn and the assistant
  // reply land here), then refresh the unified sheet so the new/updated chat
  // shows across every tab's view.
  useEffect(() => {
    if (!historyKey || !userId || messages.length === 0) return;
    // Chips + drafts live on the messages, so persisting `messages` persists them
    // (including a chip flipped to used by markActionUsed, which rewrites the
    // message). Nothing extra to thread through.
    saveChat(userId, historyKey, { id: chatIdRef.current, messages })
      .then(() => loadAllRecentChats(userId))
      .then(setAllChats)
      .catch(() => {});
  }, [historyKey, userId, messages]);

  const loadContext = useCallback(async () => {
    const ep = optsRef.current.contextEndpoint;
    if (!ep) return;
    try {
      const body = optsRef.current.contextBody?.() ?? null;
      // POST carries the decrypted records; its params live in the body, so the
      // GET-style query string is dropped.
      const { data } = body ? await api.post(ep.split('?')[0], body) : await api.get(ep);
      setContext(data.context || null);
      setSuggestedPrompts(Array.isArray(data.suggestedPrompts) ? data.suggestedPrompts : []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const addAttachment = useCallback((file: PickedFile) => {
    setAttachments((a) => [...a, file]);
  }, []);
  const removeAttachment = useCallback((index: number) => {
    setAttachments((a) => a.filter((_, i) => i !== index));
  }, []);

  // With history on, "clear" is really "new chat": the conversation so far is
  // already persisted (and stays resumable for 7 days) — rotating the id means the
  // next send starts a fresh stored conversation instead of overwriting it.
  const clear = useCallback(() => {
    chatIdRef.current = newChatId();
    setMessages([]);
    setAttachments([]);
    setError('');
    setQuotaExceeded(false);
    setStreamingText('');
    setSessionCredits(0);
  }, []);

  // Resume one of THIS surface's own chats in place (the sheet's same-tab fast
  // path). A chat from another assistant isn't ours to load — the sheet routes
  // those through the cross-tab hand-off instead — so guard on surfaceKey.
  const resumeChat = useCallback(
    (id: string) => {
      if (loading) return;
      const conv = allChats.find((c) => c.id === id);
      if (!conv || conv.surfaceKey !== historyKey) return;
      applyResume(conv);
    },
    [allChats, loading, historyKey, applyResume]
  );

  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  // Mark a one-shot action chip (a direct-create like "Save this to my calendar")
  // as used on the message at `index`, so it renders visible-but-disabled and
  // can't fire twice. The chip stays in place; only its interactivity is spent.
  // Rewriting the message persists through the messages-effect above.
  const markActionUsed = useCallback((index: number, label: string) => {
    setMessages((m) =>
      m.map((msg, i) =>
        i === index && !msg.usedActions?.includes(label)
          ? { ...msg, usedActions: [...(msg.usedActions ?? []), label] }
          : msg
      )
    );
  }, []);

  const streamRequest = useCallback(
    (history: ChatMessage[]) =>
      new Promise<void>((resolve, reject) => {
        const { endpoint, buildBody, onResult, toolLabels = {}, transformResult } = optsRef.current;
        const token = getCachedToken();
        const es = new EventSource<ChatSSEEvent>(`${API_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(buildBody(history)),
          pollingInterval: 0, // one-shot request; never auto-reconnect
        });
        esRef.current = es;

        let acc = '';
        let finished = false;
        let settled = false;

        const teardown = () => {
          es.removeAllEventListeners();
          es.close();
          if (esRef.current === es) esRef.current = null;
          if (abortRef.current === abort) abortRef.current = null;
        };
        const done = () => {
          if (settled) return;
          settled = true;
          teardown();
          resolve();
        };
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          teardown();
          reject(err);
        };
        // User tapped Stop: close the connection and end the turn cleanly. Any
        // text streamed so far is kept as the assistant's reply (a partial
        // answer is still useful) — the same salvage the stream-error path does.
        const abort = () => {
          if (settled) return;
          if (!finished && acc) {
            setMessages((m) => [...m, { role: 'assistant', content: acc }]);
          }
          setStreamingText('');
          done();
        };
        abortRef.current = abort;

        es.addEventListener('text', (e) => {
          acc += parseData(e.data).delta || '';
          setStreamingText(acc);
          setToolActivity('');
        });
        es.addEventListener('tool', (e) => {
          const name = parseData(e.data).name as string;
          setToolActivity(toolLabels[name] || 'Working…');
        });
        es.addEventListener('done', (e) => {
          let data = parseData(e.data) as ChatDoneData;
          if (transformResult) data = transformResult(data);
          finished = true;
          const credits = typeof data.creditsUsed === 'number' ? data.creditsUsed : undefined;
          // Stamp this turn's chips + drafted record onto the assistant message so
          // they render inline under it and stay in scrollback (all past turns keep
          // their own chips). Omitted keys stay absent (no empty chip rows).
          const followups = Array.isArray(data.followups) ? data.followups : undefined;
          const navSuggestions = Array.isArray(data.navSuggestions) ? data.navSuggestions : undefined;
          const pendingEvent =
            data.pendingEvent && typeof data.pendingEvent === 'object' ? data.pendingEvent : undefined;
          const pendingChore =
            data.pendingChore && typeof data.pendingChore === 'object' ? data.pendingChore : undefined;
          const pendingDeletes =
            Array.isArray(data.pendingDeletes) && data.pendingDeletes.length ? data.pendingDeletes : undefined;
          const pendingEdit =
            data.pendingEdit && typeof data.pendingEdit === 'object' ? data.pendingEdit : undefined;
          setMessages((m) => [
            ...m,
            {
              role: 'assistant',
              content: data.reply || acc || '',
              credits,
              ...(followups?.length ? { followups } : {}),
              ...(navSuggestions?.length ? { navSuggestions } : {}),
              ...(pendingEvent ? { pendingEvent } : {}),
              ...(pendingChore ? { pendingChore } : {}),
              ...(pendingDeletes ? { pendingDeletes } : {}),
              ...(pendingEdit ? { pendingEdit } : {}),
            },
          ]);
          if (credits) setSessionCredits((n) => n + credits);
          setStreamingText('');
          onResult?.(data);
          done();
        });
        // Built-in error: HTTP non-2xx, network failure, or stream exception.
        es.addEventListener('error', (e) => {
          if (e.type === 'error' && e.xhrStatus === 402) {
            fail(new ChatQuotaError());
            return;
          }
          // Stream broke after some text arrived — salvage the partial reply.
          if (!finished && acc) {
            setMessages((m) => [...m, { role: 'assistant', content: acc }]);
            setStreamingText('');
            done();
            return;
          }
          fail(new Error('stream error'));
        });
        // Normal end-of-stream without an explicit done event.
        es.addEventListener('close', () => {
          if (finished) return;
          if (acc) {
            setMessages((m) => [...m, { role: 'assistant', content: acc }]);
            setStreamingText('');
            done();
          } else {
            fail(new Error('connection closed'));
          }
        });
      }),
    []
  );

  const run = useCallback(
    async (history: ChatMessage[]) => {
      setLoading(true);
      setStreamingText('');
      setToolActivity('');
      setError('');
      setQuotaExceeded(false);
      try {
        await streamRequest(history);
      } catch (e) {
        setStreamingText('');
        const overQuota = e instanceof ChatQuotaError;
        setQuotaExceeded(overQuota);
        setError(
          overQuota
            ? 'You’re out of AI credits. Buy a pack to continue.'
            : 'Sorry, something went wrong.'
        );
      } finally {
        setLoading(false);
        setToolActivity('');
      }
    },
    [streamRequest]
  );

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();
      // A message with attachments and no text is valid (e.g. "here's a photo").
      const files = text === undefined ? attachments : [];
      if ((!content && files.length === 0) || loading) return;
      setInput('');
      setAttachments([]);
      // Past turns' chips stay in scrollback (they live on their messages); this
      // new turn simply appends and gets its own chips when it resolves.

      let atts: ChatAttachment[] | undefined;
      if (files.length) {
        atts = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            type: f.type,
            kind: classifyAttachment(f.type),
            uri: f.uri,
            data: await readFileBase64(f),
          }))
        );
      }

      const next: ChatMessage[] = [...messages, { role: 'user', content, ...(atts ? { attachments: atts } : {}) }];
      setMessages(next);
      await run(next);
    },
    [input, attachments, loading, messages, run]
  );

  const retry = useCallback(async () => {
    if (loading) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') return;
    await run(messages);
  }, [loading, messages, run]);

  // Interrupt the in-flight assistant turn (the composer's Stop button). Ends
  // the stream, keeps whatever streamed so far, and drops back to idle. No-op
  // when nothing is running.
  const stop = useCallback(() => {
    abortRef.current?.();
  }, []);

  return {
    messages,
    input,
    setInput,
    attachments,
    addAttachment,
    removeAttachment,
    loading,
    streamingText,
    toolActivity,
    error,
    quotaExceeded,
    context,
    suggestedPrompts,
    sessionCredits,
    // Unified recent chats (all surfaces), minus the conversation on screen.
    recentChats: allChats.filter((c) => c.id !== chatIdRef.current),
    // This surface's storage key — the sheet compares it per row to pick the
    // same-tab fast path vs. the cross-tab hand-off.
    historyKey,
    historyOpen,
    openHistory,
    closeHistory,
    resumeChat,
    send,
    retry,
    stop,
    clear,
    markActionUsed,
    loadContext,
  };
}

export type ChatController = ReturnType<typeof useChat>;
