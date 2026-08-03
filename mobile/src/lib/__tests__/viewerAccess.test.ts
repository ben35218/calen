jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import React from 'react';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, act } from '@testing-library/react-native';
import {
  cacheViewerContent,
  clearViewerContentCache,
  getViewerContentCached,
  viewerContentFromStatus,
  useViewerContent,
} from '../viewerAccess';

describe('viewer-content cache (free viewer mode)', () => {
  afterEach(() => {
    clearViewerContentCache();
  });

  it('defaults to no content while nothing is cached (safe default → paywall)', async () => {
    expect(await getViewerContentCached()).toBe(false);
  });

  it('round-trips through AsyncStorage, including the content going away', async () => {
    cacheViewerContent(true);
    expect(await getViewerContentCached()).toBe(true);
    expect(await AsyncStorage.getItem('hc_viewer_content')).toBe('true');

    // Declining the last invitation / losing the last share — the cache follows.
    cacheViewerContent(false);
    expect(await getViewerContentCached()).toBe(false);
    expect(await AsyncStorage.getItem('hc_viewer_content')).toBe('false');
  });

  it('persisted content survives a cold start (offline relaunch into the shell)', async () => {
    // A real cold start gets fresh module state — load an isolated copy of the
    // module (and the AsyncStorage instance it sees) so its first read comes
    // from storage, not memory.
    let freshStorage: typeof AsyncStorage;
    let freshViewer: typeof import('../viewerAccess');
    jest.isolateModules(() => {
      const storageModule = require('@react-native-async-storage/async-storage');
      freshStorage = storageModule.default ?? storageModule;
      freshViewer = require('../viewerAccess');
    });
    await freshStorage!.setItem('hc_viewer_content', 'true');
    expect(await freshViewer!.getViewerContentCached()).toBe(true);
  });

  it('sign-out clears the cache so the next account starts at the paywall', async () => {
    cacheViewerContent(true);
    clearViewerContentCache();
    expect(await AsyncStorage.getItem('hc_viewer_content')).toBeNull();
    expect(await getViewerContentCached()).toBe(false);
  });

  // Regression (2026-08-02): sign-out left the cache at null forever, so the
  // still-mounted RootNavigator's useViewerContent reported loaded:false and
  // held the splash spinner for the NEXT sign-in — the billing fetch that would
  // re-cache the signal only runs once the gate renders a screen. A clear must
  // resolve to a KNOWN no-content state, keeping the hook loaded.
  it('useViewerContent stays loaded across a sign-out clear (splash-gate deadlock)', async () => {
    cacheViewerContent(true);
    // renderHook is unusable under this jest-expo/React 19 setup (see
    // useBilling.test) — probe the hook through a tiny harness component.
    function Probe() {
      const { hasContent, loaded } = useViewerContent();
      return React.createElement(Text, null, `content:${hasContent} loaded:${loaded}`);
    }
    const view = await render(React.createElement(Probe));
    expect(view.getByText('content:true loaded:true')).toBeTruthy();
    await act(async () => {
      clearViewerContentCache();
    });
    expect(view.getByText('content:false loaded:true')).toBeTruthy();
  });

  it('folds the billing-status viewer counts down to the gate boolean', () => {
    expect(viewerContentFromStatus({})).toBe(false);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 0, pendingCalendarInvitations: 0 } })).toBe(false);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 1, pendingCalendarInvitations: 0 } })).toBe(true);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 0, pendingCalendarInvitations: 2 } })).toBe(true);
  });
});
