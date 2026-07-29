// The unsaved-changes guard blocks a screen exit (header ✕ / back / swipe-back /
// Android back — all funneled through React Navigation's `beforeRemove`) when the
// form is dirty, and shows the Apple-style "Discard Changes?" confirm. Leaving
// only proceeds on Discard; `allowLeave` bypasses it for a successful save.
// See mobile/CLAUDE.md → "Unsaved-changes guard" and specs/features/calendar.md.
import React from 'react';
import { ActionSheetIOS, Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import { useUnsavedChangesGuard } from '../useUnsavedChangesGuard';

// Capture the `beforeRemove` listener a screen registers so we can fire fake
// navigation attempts at it.
function makeNav() {
  const state: { cb: ((e: any) => void) | null } = { cb: null };
  return {
    fire: (e: any) => state.cb!(e),
    hasListener: () => !!state.cb,
    addListener: (_type: string, cb: (e: any) => void) => {
      state.cb = cb;
      return () => { state.cb = null; };
    },
    dispatch: jest.fn(),
  };
}

// A `beforeRemove` event: preventDefault records the block; data.action is what a
// confirmed leave re-dispatches.
function makeEvent() {
  const action = { type: 'POP' };
  return { action, e: { data: { action }, preventDefault: jest.fn() } };
}

function Harness({ nav, dirty, onReady }: { nav: any; dirty: boolean; onReady?: (allow: () => void) => void }) {
  const allowLeave = useUnsavedChangesGuard(nav, dirty);
  onReady?.(allowLeave);
  return null;
}

describe('useUnsavedChangesGuard', () => {
  let showSheet: jest.SpyInstance;

  beforeEach(() => {
    Platform.OS = 'ios';
    showSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
  });

  afterEach(() => showSheet.mockRestore());

  it('lets a clean form leave without prompting', async () => {
    const nav = makeNav();
    await render(<Harness nav={nav} dirty={false} />);
    const { e } = makeEvent();
    nav.fire(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(showSheet).not.toHaveBeenCalled();
  });

  it('blocks a dirty leave and shows the discard confirm', async () => {
    const nav = makeNav();
    await render(<Harness nav={nav} dirty />);
    const { e } = makeEvent();
    nav.fire(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(showSheet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Are you sure you want to discard your changes?', destructiveButtonIndex: 0 }),
      expect.any(Function),
    );
    // Cancel (index 1) → stay put, no re-dispatch.
    showSheet.mock.calls[0][1](1);
    expect(nav.dispatch).not.toHaveBeenCalled();
  });

  it('re-dispatches the original action when the user discards', async () => {
    const nav = makeNav();
    await render(<Harness nav={nav} dirty />);
    const { e, action } = makeEvent();
    nav.fire(e);
    // Tap "Discard Changes" (index 0).
    showSheet.mock.calls[0][1](0);
    expect(nav.dispatch).toHaveBeenCalledWith(action);
  });

  it('allowLeave bypasses the prompt for a programmatic exit (successful save)', async () => {
    const nav = makeNav();
    let allow: () => void = () => {};
    await render(<Harness nav={nav} dirty onReady={(a) => { allow = a; }} />);
    allow();
    const { e } = makeEvent();
    nav.fire(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(showSheet).not.toHaveBeenCalled();
  });
});
