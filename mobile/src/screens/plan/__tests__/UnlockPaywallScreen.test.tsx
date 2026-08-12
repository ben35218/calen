import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The hard paywall's offer block (billing-plans.md → App unlock). One filled
// control carrying the price ONCE, its terms as micro-copy beneath it, and the
// utilities — Restore (which App Review requires to stay discoverable), the
// legal links, and sign-out — demoted to text links so nothing competes with
// the CTA.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
// Stub the shared UI kit so the test doesn't drag in native modules
// (keyboard-controller / reanimated) that ui.tsx imports.
jest.mock('../../../components/ui', () => {
  const ReactActual = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    Card: ({ children }: any) => ReactActual.createElement(View, null, children),
    // Tagged so a test can count how many Button PRIMITIVES the screen draws
    // (the text links are plain Text, however they're labelled for a11y).
    Button: ({ title, onPress, disabled }: any) =>
      ReactActual.createElement(
        TouchableOpacity,
        { onPress, disabled, accessibilityRole: 'button', testID: 'ui-button' },
        ReactActual.createElement(Text, null, title)
      ),
  };
});
jest.mock('../../../lib/purchases', () => ({ isPurchasesConfigured: () => false }));
jest.mock('../../../config', () => ({
  ASSISTANT_NAME: 'Calen',
  TERMS_URL: 'https://example.com/terms',
  PRIVACY_URL: 'https://example.com/privacy',
}));

const mockLogout = jest.fn();
jest.mock('../../../store/auth', () => ({ useAuth: () => ({ logout: mockLogout }) }));

const mockBuy = jest.fn();
const mockRestore = jest.fn();
const purchase = { state: 'idle' as string };
jest.mock('../shared', () => ({
  useUnlockPurchase: () => ({
    billing: { data: { unlockPrice: 5.99 } },
    activation: { state: purchase.state },
    pkg: null,
    busy: false,
    buy: mockBuy,
    restore: mockRestore,
  }),
}));

import UnlockPaywallScreen from '../UnlockPaywallScreen';

describe('UnlockPaywallScreen', () => {
  afterEach(() => {
    purchase.state = 'idle';
    mockBuy.mockReset();
    mockRestore.mockReset();
    mockLogout.mockReset();
    cleanup();
  });

  it('states the price once — on the CTA, not also above it', async () => {
    const view = await render(<UnlockPaywallScreen />);
    expect(view.getByText('Unlock Calen — $5.99')).toBeTruthy();
    expect(view.getAllByText(/\$5\.99/).length).toBe(1);
  });

  it('puts the purchase terms under the CTA as micro-copy', async () => {
    const view = await render(<UnlockPaywallScreen />);
    expect(view.getByText(/One-time purchase, per contact/)).toBeTruthy();
    expect(view.getByText(/not a subscription/)).toBeTruthy();
  });

  it('keeps Restore discoverable as a text link beside the legal links', async () => {
    const view = await render(<UnlockPaywallScreen />);
    const restore = view.getByText('Restore purchase');
    await fireEvent.press(restore);
    expect(mockRestore).toHaveBeenCalled();
    expect(view.getByText('Terms of Use')).toBeTruthy();
    expect(view.getByText('Privacy Policy')).toBeTruthy();
  });

  it('drops Restore once the unlock has activated', async () => {
    purchase.state = 'active';
    const view = await render(<UnlockPaywallScreen />);
    expect(view.getByText('Unlocked — welcome in!')).toBeTruthy();
    expect(view.queryByText('Restore purchase')).toBeNull();
    expect(view.getByText('Terms of Use')).toBeTruthy();
  });

  it('signs out from a quiet text link, not a button', async () => {
    const view = await render(<UnlockPaywallScreen />);
    await fireEvent.press(view.getByText('Sign out'));
    expect(mockLogout).toHaveBeenCalled();
    // The CTA is the only bordered/filled control on the screen — Restore and
    // Sign out are text links (still labelled as buttons for screen readers).
    expect(view.getAllByTestId('ui-button').length).toBe(1);
  });
});
