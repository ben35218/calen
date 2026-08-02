jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cacheViewerContent,
  clearViewerContentCache,
  getViewerContentCached,
  viewerContentFromStatus,
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
    await AsyncStorage.setItem('hc_viewer_content', 'true');
    expect(await getViewerContentCached()).toBe(true);
  });

  it('sign-out clears the cache so the next account starts at the paywall', async () => {
    cacheViewerContent(true);
    clearViewerContentCache();
    expect(await AsyncStorage.getItem('hc_viewer_content')).toBeNull();
    expect(await getViewerContentCached()).toBe(false);
  });

  it('folds the billing-status viewer counts down to the gate boolean', () => {
    expect(viewerContentFromStatus({})).toBe(false);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 0, pendingCalendarInvitations: 0 } })).toBe(false);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 1, pendingCalendarInvitations: 0 } })).toBe(true);
    expect(viewerContentFromStatus({ viewer: { calendarCollaborations: 0, pendingCalendarInvitations: 2 } })).toBe(true);
  });
});
