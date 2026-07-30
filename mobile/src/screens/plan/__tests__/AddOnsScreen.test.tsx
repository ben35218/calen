import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react-native';

// The Add-ons store card contract (billing-plans.md → Feature-calendar
// add-ons): an owned add-on shows the green "Added/Purchased" check — unless
// this device has locally deleted its calendar, in which case the card offers
// the same one-tap device-local restore as the Add Calendar chooser's Deleted
// Calendars rows. Unowned cards keep their buy/claim CTA regardless of the
// deleted pref (the storefront CTA is the affordance until owned).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: {} }),
}));
// Ionicons render as labelled text so the check-vs-plus state is assertable.
jest.mock('@expo/vector-icons', () => {
  const ReactActual = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name, accessibilityLabel }: any) =>
      ReactActual.createElement(Text, { accessibilityLabel }, `icon:${name}`),
    MaterialCommunityIcons: () => null,
  };
});
// Stub the shared UI kit so the test doesn't drag in native modules
// (keyboard-controller / reanimated) that ui.tsx imports.
jest.mock('../../../components/ui', () => {
  const ReactActual = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    Badge: () => null,
    IconAvatar: () => null,
    Card: ({ children }: any) => ReactActual.createElement(View, null, children),
    SectionHeader: ({ children }: any) => ReactActual.createElement(Text, null, children),
    Button: ({ title, onPress, disabled }: any) =>
      ReactActual.createElement(
        TouchableOpacity,
        { onPress, disabled, accessibilityRole: 'button' },
        ReactActual.createElement(Text, null, title)
      ),
  };
});
jest.mock('../../../lib/purchases', () => ({ isPurchasesConfigured: () => false }));
jest.mock('../../../api', () => ({ billingApi: { claimAddon: jest.fn() } }));
jest.mock('../../../config', () => ({
  TERMS_URL: 'https://example.com/terms',
  PRIVACY_URL: 'https://example.com/privacy',
}));

// Parameterized deleted-calendar prefs per test.
const mockRestoreDefault = jest.fn();
const mockDeleted = { ids: [] as string[] };
jest.mock('../../../lib/calendarPrefs', () => ({
  useCalendarColors: () => ({ colors: {} }),
  useDeletedDefaultCalendars: () => ({
    deletedIds: mockDeleted.ids,
    restoreDefault: mockRestoreDefault,
  }),
}));

// Parameterized add-on ownership per test.
const mockOwned = { ids: [] as string[] };
const mockCatalog = {
  items: [
    { key: 'recipes', label: 'Meals', price: 2.99, description: '' },
    { key: 'maintenance', label: 'Maintenance', price: 2.99, description: '' },
    { key: 'trips', label: 'Trips', price: 2.99, description: '' },
    { key: 'birthdays', label: 'Occasions', price: 0, description: '' },
    { key: 'chores', label: 'Chores', price: 0, description: '' },
  ],
  bundle: { label: 'All add-ons', price: 7.99, description: '' },
};
jest.mock('../shared', () => ({
  useAddonPurchase: () => ({
    billing: {
      data: { addons: mockOwned.ids, addonCatalog: mockCatalog },
      refetch: jest.fn(),
    },
    activation: { state: 'idle' },
    packagesByAddon: {},
    busyId: null,
    buy: jest.fn(),
    restore: jest.fn(),
  }),
}));

import AddOnsScreen from '../AddOnsScreen';

const ALL = ['recipes', 'maintenance', 'trips', 'birthdays', 'chores'];

describe('AddOnsScreen owned-card state', () => {
  beforeEach(() => {
    mockRestoreDefault.mockClear();
    mockOwned.ids = [...ALL];
    mockDeleted.ids = [];
  });
  afterEach(cleanup);

  it('owned add-ons show the check mark and no restore affordance', async () => {
    const view = await render(<AddOnsScreen />);
    expect(view.getAllByLabelText('Purchased')).toHaveLength(3);
    expect(view.getAllByLabelText('Added')).toHaveLength(2);
    expect(view.queryByLabelText('Add back to your calendar')).toBeNull();
  });

  it('an owned but locally-deleted calendar swaps the check for a restore +, which runs restoreDefault', async () => {
    mockDeleted.ids = ['birthdays'];
    const view = await render(<AddOnsScreen />);
    // Occasions no longer reads as "all set"…
    expect(view.getAllByLabelText('Added')).toHaveLength(1); // chores only
    // …its card carries the restore + instead, same process as Add Calendar.
    await fireEvent.press(view.getByLabelText('Add back to your calendar'));
    expect(mockRestoreDefault).toHaveBeenCalledWith('birthdays');
  });

  it('the deleted pref never surfaces on an unowned card — the buy/claim CTA stays', async () => {
    mockOwned.ids = [];
    mockDeleted.ids = ['recipes', 'birthdays'];
    const view = await render(<AddOnsScreen />);
    expect(view.queryByLabelText('Add back to your calendar')).toBeNull();
    expect(view.getAllByText('Get')).toHaveLength(2); // free claims still offered
  });
});
