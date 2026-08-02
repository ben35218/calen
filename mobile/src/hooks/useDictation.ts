import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

// Speech-to-text for the composer mic button (Level 1 — dictation). The user
// taps the mic, speaks, and the live transcript flows into the text field so
// they can review/edit before sending through the normal chat pipeline.
//
// Privacy: recognition runs on-device (`requiresOnDeviceRecognition: true`), so
// the audio is transcribed on the phone and isn't sent to Apple — consistent
// with the assistant's on-device / data-minimization stance. The transcript
// then rides the SAME E2EE-safe send path as a typed message (no new server
// data path). Metering is identical to text chat.

export type DictationState = 'idle' | 'listening';

// Merge the running transcript into the text surrounding the cursor at the
// moment the mic was pressed. The recognizer streams the WHOLE utterance on
// every interim result, so the caller snapshots `before`/`after` once at start
// and re-splices each update — dictation inserts at the cursor instead of
// clobbering what was already typed. Adds a single space at either seam unless
// the neighboring text already provides whitespace.
export function spliceDictation(before: string, after: string, transcript: string): string {
  if (!transcript) return before + after;
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  return before + lead + transcript + trail + after;
}

// Join an already-finalized transcript with the next segment. In `continuous`
// mode the recognizer streams ONE utterance segment at a time and resets after
// each final result, so the hook accumulates finalized segments and re-joins the
// live segment on top — the caller always receives the WHOLE transcript since
// the mic was pressed, preserving `spliceDictation`'s single-shot contract.
export function joinTranscript(finalized: string, segment: string): string {
  if (!finalized) return segment;
  if (!segment) return finalized;
  return `${finalized} ${segment}`;
}

// How long the mic keeps listening through silence before it auto-finalizes.
// `continuous` recognition never ends on a natural pause, so this is the only
// thing that stops an abandoned session; it re-arms on every speech result, so
// the countdown only runs while the user is actually quiet.
const SILENCE_TIMEOUT_MS = 10000;

export interface UseDictationOptions {
  // Called with the running transcript (interim results included) so the caller
  // can mirror it into the input field live.
  onText: (text: string) => void;
  // Surfaced on permission denial or a recognition error.
  onError?: (message: string) => void;
  lang?: string;
  // Silence window before the mic auto-finalizes (see SILENCE_TIMEOUT_MS).
  silenceTimeoutMs?: number;
}

export function useDictation({
  onText,
  onError,
  lang = 'en-US',
  silenceTimeoutMs = SILENCE_TIMEOUT_MS,
}: UseDictationOptions) {
  const [state, setState] = useState<DictationState>('idle');
  // Keep callbacks in refs so the global speech-event listeners never go stale.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // The event listeners below are always mounted; only act on them while THIS
  // hook owns an active session, so a concurrent voice-mode session (which uses
  // the same singleton recognizer) can't leak its results into the composer.
  const activeRef = useRef(false);
  // Finalized segments accumulated this session (continuous mode resets the
  // recognizer's transcript after each final result — see joinTranscript).
  const finalizedRef = useRef('');
  // Idle-silence auto-stop timer; re-armed on every result so it only counts
  // down while the user is quiet.
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);
  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      // No speech for the whole window — finalize gracefully. `stop()` fires a
      // final `result` + `end`, which flips state back to idle.
      if (activeRef.current) ExpoSpeechRecognitionModule.stop();
    }, silenceTimeoutMs);
  }, [clearSilenceTimer, silenceTimeoutMs]);

  useSpeechRecognitionEvent('result', (e) => {
    if (!activeRef.current) return;
    armSilenceTimer(); // speech activity — reset the idle countdown
    const segment = e.results?.[0]?.transcript ?? '';
    const full = joinTranscript(finalizedRef.current, segment);
    if (full) onTextRef.current(full);
    // Absorb a finalized segment so the next one appends after it rather than
    // clobbering it.
    if (e.isFinal) finalizedRef.current = full;
  });
  useSpeechRecognitionEvent('end', () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearSilenceTimer();
    setState('idle');
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearSilenceTimer();
    setState('idle');
    // `no-speech` just means the user didn't say anything — not worth a scary
    // message. Everything else is surfaced.
    if (e.error !== 'no-speech') onErrorRef.current?.(e.message || 'Couldn’t hear that. Try again.');
  });

  // Clear any pending timer if the screen unmounts mid-session.
  useEffect(() => clearSilenceTimer, [clearSilenceTimer]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        onErrorRef.current?.('Microphone access is needed to talk to Calen. Enable it in Settings.');
        return;
      }
      activeRef.current = true;
      finalizedRef.current = '';
      setState('listening');
      armSilenceTimer();
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true, // stream words as they're recognized
        // Keep listening through natural pauses so a mid-thought breath doesn't
        // cut the user off; our own silence timer (armSilenceTimer) is what ends
        // an abandoned session, giving a generous grace window before stopping.
        continuous: true,
        requiresOnDeviceRecognition: true, // audio stays on device
      });
    } catch (err) {
      activeRef.current = false;
      clearSilenceTimer();
      setState('idle');
      onErrorRef.current?.((err as Error)?.message || 'Couldn’t start listening.');
    }
  }, [lang, armSilenceTimer, clearSilenceTimer]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    clearSilenceTimer();
    // `stop()` finalizes the current utterance (fires a final `result` + `end`).
    ExpoSpeechRecognitionModule.stop();
  }, [clearSilenceTimer]);

  // Toggle the mic off immediately and DISCARD anything still in flight — used
  // when the composed message has already been sent, so a trailing final result
  // must not re-populate the just-cleared field. Clearing `activeRef` first makes
  // the guards drop the `aborted` error + `end` events (no toast, no re-fill);
  // `abort()` cancels recognition without delivering a final transcript.
  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearSilenceTimer();
    setState('idle');
    ExpoSpeechRecognitionModule.abort();
  }, [clearSilenceTimer]);

  return { state, start, stop, cancel };
}
