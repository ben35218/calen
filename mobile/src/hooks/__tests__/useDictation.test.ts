jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: { start: jest.fn(), stop: jest.fn(), requestPermissionsAsync: jest.fn() },
  useSpeechRecognitionEvent: jest.fn(),
}));

import { joinTranscript, spliceDictation } from '../useDictation';

// Dictation inserts at the cursor snapshot instead of clobbering the field:
// `before`/`after` are the text around the cursor when the mic was pressed, and
// every interim result re-splices the whole running utterance between them.

describe('spliceDictation', () => {
  it('starts an empty field with just the transcript', () => {
    expect(spliceDictation('', '', 'hello there')).toBe('hello there');
  });

  it('appends to existing text with a separating space', () => {
    expect(spliceDictation('Add milk', '', 'and eggs')).toBe('Add milk and eggs');
  });

  it('does not double a space the typed text already provides', () => {
    expect(spliceDictation('Add milk ', '', 'and eggs')).toBe('Add milk and eggs');
    expect(spliceDictation('Add milk', ' today', 'and eggs')).toBe('Add milk and eggs today');
  });

  it('inserts mid-text with spaces at both seams', () => {
    expect(spliceDictation('Remind me', 'tomorrow', 'to call the dentist')).toBe(
      'Remind me to call the dentist tomorrow',
    );
  });

  it('interim results replace the dictated segment, not accumulate', () => {
    const before = 'Add ';
    const after = ' to the list';
    const first = spliceDictation(before, after, 'mi');
    const second = spliceDictation(before, after, 'milk and eggs');
    expect(first).toBe('Add mi to the list');
    expect(second).toBe('Add milk and eggs to the list');
  });

  it('an empty transcript leaves the surrounding text untouched', () => {
    expect(spliceDictation('Add milk', ' today', '')).toBe('Add milk today');
  });

  it('replaces a selected range (before/after already exclude the selection)', () => {
    // Caller slices the selection out: "Add [bread] please" with "bread" selected.
    expect(spliceDictation('Add ', ' please', 'butter')).toBe('Add butter please');
  });
});

// In continuous mode the recognizer streams one segment at a time and resets its
// transcript after each final result, so the hook accumulates finalized segments
// and re-joins the live one — the caller always sees the whole utterance.
describe('joinTranscript', () => {
  it('returns the segment when nothing is finalized yet', () => {
    expect(joinTranscript('', 'hello')).toBe('hello');
  });

  it('returns the finalized text when the live segment is empty', () => {
    expect(joinTranscript('hello there', '')).toBe('hello there');
  });

  it('joins finalized + live segment with a single space', () => {
    expect(joinTranscript('add milk', 'and eggs')).toBe('add milk and eggs');
  });

  it('accumulates across finals so later segments append, not clobber', () => {
    // Segment 1 finalizes → 'add milk'; segment 2 streams on top of it.
    let finalized = joinTranscript('', 'add milk'); // final #1 absorbed
    const interim = joinTranscript(finalized, 'and'); // live interim
    expect(interim).toBe('add milk and');
    finalized = joinTranscript(finalized, 'and eggs'); // final #2 absorbed
    expect(finalized).toBe('add milk and eggs');
  });

  it('is empty when neither side has text', () => {
    expect(joinTranscript('', '')).toBe('');
  });
});
