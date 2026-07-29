import { useCallback, useRef, useState } from 'react';
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

export interface UseDictationOptions {
  // Called with the running transcript (interim results included) so the caller
  // can mirror it into the input field live.
  onText: (text: string) => void;
  // Surfaced on permission denial or a recognition error.
  onError?: (message: string) => void;
  lang?: string;
}

export function useDictation({ onText, onError, lang = 'en-US' }: UseDictationOptions) {
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

  useSpeechRecognitionEvent('result', (e) => {
    if (!activeRef.current) return;
    const transcript = e.results?.[0]?.transcript ?? '';
    if (transcript) onTextRef.current(transcript);
  });
  useSpeechRecognitionEvent('end', () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setState('idle');
  });
  useSpeechRecognitionEvent('error', (e) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setState('idle');
    // `no-speech` just means the user didn't say anything — not worth a scary
    // message. Everything else is surfaced.
    if (e.error !== 'no-speech') onErrorRef.current?.(e.message || 'Couldn’t hear that. Try again.');
  });

  const start = useCallback(async () => {
    if (activeRef.current) return;
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        onErrorRef.current?.('Microphone access is needed to talk to Calen. Enable it in Settings.');
        return;
      }
      activeRef.current = true;
      setState('listening');
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true, // stream words as they're recognized
        continuous: false, // a natural pause ends dictation (composer, not hands-free)
        requiresOnDeviceRecognition: true, // audio stays on device
      });
    } catch (err) {
      activeRef.current = false;
      setState('idle');
      onErrorRef.current?.((err as Error)?.message || 'Couldn’t start listening.');
    }
  }, [lang]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    // `stop()` finalizes the current utterance (fires a final `result` + `end`).
    ExpoSpeechRecognitionModule.stop();
  }, []);

  return { state, start, stop };
}
