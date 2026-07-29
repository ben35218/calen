import { useCallback, useEffect, useRef } from 'react';
import { ActionSheetIOS, Alert, Platform } from 'react-native';

// The Apple-style "discard your changes?" confirm. On iOS it's the native
// destructive action sheet (a red "Discard Changes" over a Cancel); on Android
// it falls back to the equivalent alert. `onDiscard` runs only if the user
// commits to leaving — tapping Cancel keeps them on the screen.
export function confirmDiscardChanges(onDiscard: () => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'Are you sure you want to discard your changes?',
        options: ['Discard Changes', 'Cancel'],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
      (i) => {
        if (i === 0) onDiscard();
      },
    );
  } else {
    Alert.alert('Discard changes?', 'Your unsaved changes will be lost.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard Changes', style: 'destructive', onPress: onDiscard },
    ]);
  }
}

// Minimal shape we need from a navigation prop — kept structural (like
// useHeaderCheckButton) so any stack navigator satisfies it.
type Guardable = {
  addListener: (type: 'beforeRemove', cb: (e: any) => void) => () => void;
  dispatch: (action: any) => void;
};

// Guards a form against losing unsaved edits. Listens on React Navigation's
// `beforeRemove`, which fires for EVERY way off the screen — the header ✕, the
// back chevron, the iOS swipe-back gesture, and the Android hardware back — so a
// single hook per screen covers them all. When `hasUnsavedChanges` is true it
// blocks the leave and shows the discard confirm; the leave only proceeds if the
// user taps "Discard Changes".
//
// Returns `allowLeave`: call it immediately before an intentional programmatic
// exit (e.g. inside a save/delete mutation's onSuccess, right before goBack) so
// the guard doesn't prompt on the way out even though the form still reads dirty.
export function useUnsavedChangesGuard(
  navigation: Guardable,
  hasUnsavedChanges: boolean,
): () => void {
  // Read the latest dirtiness inside the listener without re-subscribing on
  // every keystroke (the subscription is installed once per screen).
  const dirtyRef = useRef(hasUnsavedChanges);
  dirtyRef.current = hasUnsavedChanges;
  // Set once we've decided to leave (user discarded, or a save succeeded) so the
  // re-dispatched navigation action passes straight through.
  const allowRef = useRef(false);

  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (allowRef.current || !dirtyRef.current) return;
      e.preventDefault();
      confirmDiscardChanges(() => {
        allowRef.current = true;
        navigation.dispatch(e.data.action);
      });
    });
  }, [navigation]);

  return useCallback(() => {
    allowRef.current = true;
  }, []);
}
