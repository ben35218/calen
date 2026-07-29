import { useCallback, useEffect, useRef, useState } from 'react';
import EventSource from 'react-native-sse';
import { API_URL } from '../config';
import { getCachedToken } from '../lib/secureToken';
import api from '../api/client';
import { AttachmentKind, PickedFile, classifyAttachment, readFileBase64 } from '../lib/media';

// Mirrors client/src/composables/useChat.js for React Native. RN's fetch can't
// stream response bodies, so the SSE transport uses react-native-sse (an
// XHR-based EventSource that supports POST + custom headers + body). The bearer
// token is attached explicitly here from the SecureStore-backed cache — this
// request does NOT go through the axios instance, so it would otherwise be
// unauthenticated.
//
// Deferred vs web: history persistence (no AsyncStorage dep yet) and rich
// markdown rendering (bubbles use flattenMarkdown instead).

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
  tokens?: number; // Claude tokens this assistant turn consumed (from the `done` event)
}

export interface ChatContext {
  sees?: string[];
  can?: string[];
  note?: string;
}

export interface ChatDoneData {
  reply?: string;
  followups?: string[];
  // Screens the assistant offered to open (suggest_navigation tool); each `view`
  // maps to a client screen in screens/chat/navDestinations.ts.
  navSuggestions?: { view: string; label: string }[];
  navigateTo?: string;
  tasksCreated?: { id: string; title: string }[];
  // Claude tokens this reply consumed (summed across the agentic tool loop).
  tokensUsed?: number;
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
  [key: string]: unknown;
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
  const [followups, setFollowups] = useState<string[]>([]);
  // Screens the assistant offered to open this turn (model-driven, via the
  // suggest_navigation tool) — rendered as "navigate" chips.
  const [navSuggestions, setNavSuggestions] = useState<{ view: string; label: string }[]>([]);
  // The event the assistant drafted this turn (drives the Save/Edit chips).
  const [pendingEvent, setPendingEvent] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [suggestedPrompts, setSuggestedPrompts] = useState<string[]>([]);
  // Running total of Claude tokens used this chat session (for a live indicator).
  const [sessionTokens, setSessionTokens] = useState(0);

  const esRef = useRef<EventSource<ChatSSEEvent> | null>(null);

  // Tear down any in-flight stream on unmount.
  useEffect(
    () => () => {
      esRef.current?.removeAllEventListeners();
      esRef.current?.close();
      esRef.current = null;
    },
    []
  );

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

  const clear = useCallback(() => {
    setMessages([]);
    setAttachments([]);
    setFollowups([]);
    setNavSuggestions([]);
    setPendingEvent(null);
    setError('');
    setQuotaExceeded(false);
    setStreamingText('');
    setSessionTokens(0);
  }, []);

  // Consume the drafted event + its Save/Edit chips once the user acts on them,
  // so the chips don't linger (and can't be tapped twice) after handling.
  const resolvePending = useCallback(() => {
    setPendingEvent(null);
    setFollowups([]);
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
          const tokens = typeof data.tokensUsed === 'number' ? data.tokensUsed : undefined;
          setMessages((m) => [...m, { role: 'assistant', content: data.reply || acc || '', tokens }]);
          if (tokens) setSessionTokens((n) => n + tokens);
          setStreamingText('');
          setFollowups(Array.isArray(data.followups) ? data.followups : []);
          setNavSuggestions(Array.isArray(data.navSuggestions) ? data.navSuggestions : []);
          setPendingEvent(
            data.pendingEvent && typeof data.pendingEvent === 'object' ? data.pendingEvent : null
          );
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
      setFollowups([]);
      setNavSuggestions([]);
      setPendingEvent(null);

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
    followups,
    navSuggestions,
    pendingEvent,
    context,
    suggestedPrompts,
    sessionTokens,
    send,
    retry,
    clear,
    resolvePending,
    loadContext,
  };
}

export type ChatController = ReturnType<typeof useChat>;
