import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

// Hands-free keyword commands (Level 2 — cooking mode) over the same on-device
// recognizer the composer's dictation uses (useDictation). This is grammar
// spotting, not transcription: final results are matched against a tiny fixed
// phrase list, which stays robust over kitchen noise.
//
// Privacy/cost: recognition runs on-device (`requiresOnDeviceRecognition`), so
// audio never leaves the phone and there is no AI-credit or telephony cost.
//
// Session shape: unlike dictation there is NO silence auto-stop — the cook may
// be quiet for minutes between commands. The OS still ends recognition sessions
// on its own schedule (and after `no-speech` lulls), so the `end` handler
// restarts the session for as long as the hook is switched on. Both hooks guard
// their shared singleton recognizer with an active flag, so a dictation session
// elsewhere can't leak results into this one (or vice versa).

export interface VoiceCommand {
  // Spoken variants that trigger this command (lowercase words). A `#` is a
  // number slot: "step #" matches "step 3", "step three", and the homophones
  // recognizers substitute for spoken digits ("step to" → 2).
  phrases: string[];
  // `value` is set only when the matched phrase carried a number slot.
  onMatch: (value?: number) => void;
}

export interface VoiceMatch {
  command: VoiceCommand;
  value?: number;
  // The phrase that matched — what ambiguity checks compare against.
  phrase: string;
}

// Spoken numbers, plus the homophones speech recognizers routinely emit for
// them mid-sentence ("step to", "step for"). Digits are matched directly.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
  six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const NUMBER_PATTERN = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

const normalize = (transcript: string) =>
  ` ${transcript.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;

// Match a transcript against the commands: whole-word phrase containment
// ("OK, next!" matches "next"; "the necktie" doesn't), longest phrase wins so
// "start timer" beats a bare "timer". A `#` slot captures its number. Returns
// the matched command (+ number) or null.
export function matchVoiceCommand(transcript: string, commands: VoiceCommand[]): VoiceMatch | null {
  const text = normalize(transcript);
  let best: VoiceMatch | null = null;
  let bestLen = 0;
  for (const c of commands) {
    for (const p of c.phrases) {
      if (p.length <= bestLen) continue;
      if (p.includes('#')) {
        const m = text.match(new RegExp(` ${p.replace('#', NUMBER_PATTERN)} `));
        if (m) {
          const raw = m[1];
          best = { command: c, value: /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMBER_WORDS[raw], phrase: p };
          bestLen = p.length;
        }
      } else if (text.includes(` ${p} `)) {
        best = { command: c, phrase: p };
        bestLen = p.length;
      }
    }
  }
  return best;
}

// Would more words turn this interim match into a LONGER match of a DIFFERENT
// command? True when the transcript still ends at a continuation point — some
// proper word-prefix of another command's longer phrase is the transcript's
// tail ("… ingredients" while "ingredients down" is in the grammar). The hook
// holds such a match until the transcript grows past the ambiguity or the
// final lands; without the hold, "ingredients down" would fire the bare
// "ingredients" toggle off its first interim and swallow the scroll. Same-
// command longer phrases ("read" → "read step") don't hold — the action is
// the action either way.
export function matchCouldExtend(transcript: string, match: VoiceMatch, commands: VoiceCommand[]): boolean {
  const text = normalize(transcript);
  for (const c of commands) {
    if (c === match.command) continue;
    for (const p of c.phrases) {
      if (p.length <= match.phrase.length) continue;
      const words = p.split(' ');
      for (let k = 1; k < words.length; k++) {
        const prefix = words.slice(0, k).join(' ');
        const pattern = prefix.includes('#') ? prefix.replace('#', NUMBER_PATTERN) : prefix;
        if (new RegExp(` ${pattern} $`).test(text)) return true;
      }
    }
  }
  return false;
}

export function useVoiceCommands({
  commands,
  onError,
  lang = 'en-US',
}: {
  commands: VoiceCommand[];
  // Surfaced on permission denial or a recognition failure (the hook has
  // already switched itself off).
  onError?: (message: string) => void;
  lang?: string;
}) {
  const [listening, setListening] = useState(false);
  // Keep the latest closures in refs so the always-mounted event listeners and
  // session restarts never go stale.
  const activeRef = useRef(false);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // One utterance = at most one command. Interim results are what make the
  // response feel instant (a final only arrives after the recognizer decides
  // the utterance is over — a beat late, which reads as "it didn't hear me"
  // and invites repeating the word). Acting on the first matching interim and
  // then holding until the final resets keeps the growing transcript of that
  // same utterance from re-firing the command.
  const handledRef = useRef(false);

  const startSession = useCallback(() => {
    // A session that ended without a final (OS cut it off) must not leave the
    // one-command hold stuck for the next session.
    handledRef.current = false;
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true, // act on the first match, not the utterance's end
      continuous: true,
      requiresOnDeviceRecognition: true, // audio stays on device
      // Bias recognition toward the grammar so short words survive noise
      // (number slots stripped — the words around them are what's biasable).
      contextualStrings: commandsRef.current.flatMap((c) =>
        c.phrases.map((p) => p.replace('#', '').trim()).filter(Boolean),
      ),
    });
  }, [lang]);

  useSpeechRecognitionEvent('result', (e) => {
    if (!activeRef.current) return;
    if (!handledRef.current) {
      const transcript = e.results?.[0]?.transcript ?? '';
      const m = matchVoiceCommand(transcript, commandsRef.current);
      // A prefix-ambiguous interim ("ingredients" while "ingredients down"
      // may still arrive) waits for a later interim or the final to decide.
      if (m && (e.isFinal || !matchCouldExtend(transcript, m, commandsRef.current))) {
        handledRef.current = true;
        m.command.onMatch(m.value);
      }
    }
    if (e.isFinal) handledRef.current = false; // next utterance starts clean
  });
  // Suspended = still "listening" as far as the user is concerned, but the
  // recognizer is parked — used while the phone itself is talking (the "read"
  // command's TTS), so the mic can't hear the step text and fire commands out
  // of it. `resume()` brings the session back.
  const suspendedRef = useRef(false);

  useSpeechRecognitionEvent('end', () => {
    // The OS ended the session (its own limits, or after a no-speech lull) —
    // keep listening until the user switches the mode off.
    if (activeRef.current && !suspendedRef.current) startSession();
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (!activeRef.current || suspendedRef.current) return;
    // A quiet kitchen is normal between commands — the paired `end` restarts.
    if (e.error === 'no-speech') return;
    activeRef.current = false;
    setListening(false);
    onErrorRef.current?.(e.message || 'Voice commands stopped.');
  });

  const start = useCallback(async () => {
    if (activeRef.current) return;
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        onErrorRef.current?.('Microphone access is needed for voice commands. Enable it in Settings.');
        return;
      }
      activeRef.current = true;
      setListening(true);
      startSession();
    } catch (err) {
      activeRef.current = false;
      setListening(false);
      onErrorRef.current?.((err as Error)?.message || 'Couldn’t start listening.');
    }
  }, [startSession]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    suspendedRef.current = false;
    setListening(false);
    // `abort()` (not `stop()`): nothing in flight is worth finalizing, and the
    // active flag is already down so the trailing `end` won't restart.
    ExpoSpeechRecognitionModule.abort();
  }, []);

  // Park recognition while the phone talks; the suspended flag makes the
  // aborted session's trailing `end`/`error` events no-ops instead of a
  // restart or a shutdown.
  const suspend = useCallback(() => {
    if (!activeRef.current || suspendedRef.current) return;
    suspendedRef.current = true;
    ExpoSpeechRecognitionModule.abort();
  }, []);
  const resume = useCallback(() => {
    if (!suspendedRef.current) return;
    suspendedRef.current = false;
    if (activeRef.current) startSession();
  }, [startSession]);

  // Never leave the mic running past the owning screen.
  useEffect(() => stop, [stop]);

  return { listening, start, stop, suspend, resume };
}
