import React from 'react';
import { render, cleanup } from '@testing-library/react-native';

// The Credits screen contract (billing-plans.md → Billing surfaces): the
// optional Calen AI plan card (subscribe CTA with price + renewal wording when
// inactive, "renews with N credits" when active, hidden for unlimited admins),
// the "What things cost" flat price list from `status.actionCosts`, and a
// History that itemizes usage debits by action alongside the grants.

// Ionicons render as labelled text (same stub as AddOnsScreen.test.tsx).
jest.mock('@expo/vector-icons', () => {
  const ReactActual = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: ({ name, accessibilityLabel }: any) =>
      ReactActual.createElement(Text, { accessibilityLabel }, `icon:${name}`),
    MaterialCommunityIcons: () => null,
  };
});
// Stub the shared UI kit so the test doesn't drag in native modules.
jest.mock('../../../components/ui', () => {
  const ReactActual = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    Badge: ({ label }: any) => ReactActual.createElement(Text, null, label),
    Card: ({ children }: any) => ReactActual.createElement(View, null, children),
    Hint: ({ children }: any) => ReactActual.createElement(Text, null, children),
    SectionTitle: ({ children }: any) => ReactActual.createElement(Text, null, children),
    Button: ({ title, onPress, disabled }: any) =>
      ReactActual.createElement(
        TouchableOpacity,
        { onPress, disabled, accessibilityRole: 'button' },
        ReactActual.createElement(Text, null, title)
      ),
  };
});
jest.mock('../../../lib/purchases', () => ({ isPurchasesConfigured: () => false }));
jest.mock('../../../api', () => ({ billingApi: { ledger: jest.fn() } }));
jest.mock('../../../config', () => ({
  TERMS_URL: 'https://example.com/terms',
  PRIVACY_URL: 'https://example.com/privacy',
}));
jest.mock('../PackStore', () => () => null);

// The ledger query resolves synchronously with the parameterized entries.
const mockLedger = { entries: [] as any[] };
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockLedger.entries }),
}));

// Parameterized billing status + plan-purchase state per test.
const mockStatus = { data: {} as any };
const mockPlanBuy = jest.fn();
jest.mock('../shared', () => ({
  useCreditsPurchase: () => ({
    billing: { data: mockStatus.data, refetch: jest.fn() },
    activation: { state: 'idle' },
    rows: [],
    busyId: null,
    buy: jest.fn(),
  }),
  useAiPlanPurchase: () => ({
    billing: { data: mockStatus.data, refetch: jest.fn() },
    activation: { state: 'idle' },
    pkg: null, // RC not loaded → the USD catalog fallback price renders
    busy: false,
    buy: mockPlanBuy,
    restore: jest.fn(),
  }),
  describeReset: () => null,
  humanCredits: (n: number) => Math.max(0, Math.floor(n ?? 0)).toLocaleString(),
  shortDate: (iso?: string | null) => (iso ? 'August 15' : null),
}));

import CreditsScreen from '../CreditsScreen';

function baseStatus(overrides: any = {}) {
  return {
    unlocked: true,
    creditBalance: 250,
    creditBalanceMc: 250_000,
    lowBalance: false,
    unlimited: false,
    packs: [
      { productId: 'credits_499', label: 'Starter', price: 4.99, credits: 500 },
      { productId: 'credits_1999', label: 'Max', price: 19.99, credits: 2200 },
    ],
    actionCosts: { chat: 2, scan: 3, generation: 3, manualParse: 1, aiHelper: 1, callPerMinute: 20 },
    aiPlan: {
      active: false,
      productId: 'calen_ai_monthly_499',
      price: 4.99,
      monthlyCredits: 600,
      expiresAt: null,
    },
    usage: {},
    usageScope: 'user',
    hasHousehold: true,
    ...overrides,
  };
}

describe('CreditsScreen', () => {
  beforeEach(() => {
    mockStatus.data = baseStatus();
    mockLedger.entries = [];
  });
  afterEach(cleanup);

  it('inactive plan: value framing, subscribe CTA with price + renewal wording, never-expire copy', async () => {
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Calen AI plan')).toBeTruthy();
    // 600cr/$4.99 beats the best pack's 2200cr/$19.99 by ~9% — computed from
    // the catalog, not hard-coded.
    expect(view.getByText('600 credits every month — 9% more credits per dollar than any pack.')).toBeTruthy();
    // App Review: an auto-renewable CTA carries price + renewal period wording.
    expect(view.getByText('Subscribe for $4.99/month')).toBeTruthy();
    expect(
      view.getByText(/\$4\.99\/month, renews monthly, cancel anytime in Settings/)
    ).toBeTruthy();
    expect(view.getByText(/Credits\s+you receive never expire/)).toBeTruthy();
  });

  it('active plan: Active state with the renewal grant and date, no subscribe CTA', async () => {
    mockStatus.data = baseStatus({
      aiPlan: {
        active: true,
        productId: 'calen_ai_monthly_499',
        price: 4.99,
        monthlyCredits: 600,
        expiresAt: '2026-08-15T00:00:00.000Z',
      },
    });
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Active')).toBeTruthy();
    expect(view.getByText('Renews with 600 credits on August 15.')).toBeTruthy();
    expect(view.queryByText('Subscribe for $4.99/month')).toBeNull();
    // Plan credits are ordinary balance — the copy says so.
    expect(view.getByText(/never expire — even if you\s+cancel/)).toBeTruthy();
  });

  it('unlimited admins see neither the plan card nor the store', async () => {
    mockStatus.data = baseStatus({ unlimited: true });
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Unlimited')).toBeTruthy();
    expect(view.queryByText('Calen AI plan')).toBeNull();
    expect(view.queryByText('Buy credits')).toBeNull();
  });

  it('renders the flat per-action prices, with the call price per minute', async () => {
    const view = await render(<CreditsScreen />);
    expect(view.getByText('What things cost')).toBeTruthy();
    expect(view.getByText('Chat message')).toBeTruthy();
    expect(view.getByText('2 credits')).toBeTruthy();
    expect(view.getByText('Receipt & photo scan')).toBeTruthy();
    expect(view.getByText('Phone call')).toBeTruthy();
    expect(view.getByText('20 credits/min')).toBeTruthy();
  });

  it('history itemizes usage debits by action and plan grants, keeping grant styling', async () => {
    mockLedger.entries = [
      { kind: 'usage', credits: -6.7, productId: null, action: 'call', note: null, createdAt: '2026-07-28T00:00:00Z' },
      { kind: 'usage', credits: -2, productId: null, action: 'chat', note: null, createdAt: '2026-07-27T00:00:00Z' },
      { kind: 'plan', credits: 600, productId: 'calen_ai_monthly_499', action: null, note: null, createdAt: '2026-07-15T00:00:00Z' },
      { kind: 'purchase', credits: 500, productId: 'credits_499', action: null, note: null, createdAt: '2026-07-01T00:00:00Z' },
    ];
    const view = await render(<CreditsScreen />);
    // Usage rows label by action; a prorated call debit keeps its fraction.
    expect(view.getAllByText('Phone call').length).toBe(2); // price list + ledger row
    expect(view.getByText('-6.7')).toBeTruthy();
    expect(view.getByText('Chat')).toBeTruthy();
    expect(view.getByText('-2')).toBeTruthy();
    // Grants render as today: labeled kind, +whole credits.
    expect(view.getByText('Monthly plan credits')).toBeTruthy();
    expect(view.getByText('+600')).toBeTruthy();
    expect(view.getByText('Credit pack')).toBeTruthy();
    expect(view.getByText('+500')).toBeTruthy();
  });
});
