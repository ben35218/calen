import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react-native';

// The Credits screen contract (billing-plans.md → Billing surfaces): the
// optional Calen AI plan card in its three states — subscribe CTA with price +
// renewal wording when inactive; "renews with N credits" + Manage subscription
// when active & renewing; "Cancelled — benefits until ⟨date⟩" + Manage when
// auto-renew is off — hidden for unlimited admins; the "What things cost" flat
// price list from `status.actionCosts`; a "Where your credits go" card that
// summarizes credits SPENT per feature this week (from `status.spend`); and a
// History limited to purchases & grants (usage debits are NOT listed there).

// useFocusEffect fires outside a navigator in this bare render — no-op it;
// useNavigation feeds the History card's "See all" drill-in.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ navigate: mockNavigate }),
}));

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
const mockPlanManage = jest.fn();
// The RC will-renew snapshot the real deriveAiPlanState folds with the server
// base — null (RC not loaded) by default, set per active-state test.
const mockPlan = { entitlement: null as { willRenew: boolean; expirationDate: string | null } | null };
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
    entitlement: mockPlan.entitlement,
    refresh: jest.fn().mockResolvedValue(undefined),
    manage: mockPlanManage,
  }),
  useCreditLedger: () => ({ data: mockLedger.entries }),
  describeReset: () => null,
  humanCredits: (n: number) => Math.max(0, Math.floor(n ?? 0)).toLocaleString(),
  shortDate: (iso?: string | null) => (iso ? 'August 15' : null),
  ledgerAmount: (n: number) =>
    Number.isInteger(n) ? Math.floor(n).toLocaleString() : n.toFixed(1),
  LEDGER_LABEL: {
    purchase: 'Credit pack',
    starter: 'Welcome credits',
    plan: 'Monthly plan credits',
    refund: 'Refund',
    admin: 'Adjustment',
    usage: 'AI usage',
  },
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
    actionCosts: { chat: 5, scan: 3, generation: 3, manualParse: 40, aiHelper: 1, callPerMinute: 20 },
    aiPlan: {
      active: false,
      productId: 'calen_ai_monthly_499',
      price: 4.99,
      monthlyCredits: 600,
      expiresAt: null,
    },
    usage: {},
    spend: {},
    usageScope: 'user',
    hasHousehold: true,
    ...overrides,
  };
}

describe('CreditsScreen', () => {
  beforeEach(() => {
    mockStatus.data = baseStatus();
    mockLedger.entries = [];
    mockPlan.entitlement = null;
    mockPlanManage.mockClear();
  });
  afterEach(cleanup);

  it('inactive plan: value framing, subscribe CTA with price + renewal wording, never-expire copy', async () => {
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Calen AI plan')).toBeTruthy();
    // 600cr/$4.99 beats the best pack's 2200cr/$19.99, so the plan asserts the
    // advantage (no specific %) — the branch is still catalog-driven.
    expect(view.getByText('600 credits every month — more credits per dollar than any pack.')).toBeTruthy();
    // App Review: an auto-renewable CTA carries price + renewal period wording.
    expect(view.getByText('Subscribe for $4.99/month')).toBeTruthy();
    expect(
      view.getByText(/\$4\.99\/month, renews monthly, cancel anytime in Settings/)
    ).toBeTruthy();
    expect(view.getByText(/Credits\s+you receive never expire/)).toBeTruthy();
  });

  it('active & renewing: Active badge, renewal grant + date, Manage subscription, no subscribe CTA', async () => {
    mockStatus.data = baseStatus({
      aiPlan: {
        active: true,
        productId: 'calen_ai_monthly_499',
        price: 4.99,
        monthlyCredits: 600,
        expiresAt: '2026-08-15T00:00:00.000Z',
      },
    });
    // RC reports the subscription will auto-renew (the happy path).
    mockPlan.entitlement = { willRenew: true, expirationDate: '2026-08-15T00:00:00.000Z' };
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Active')).toBeTruthy();
    expect(view.getByText('Renews with 600 credits on August 15.')).toBeTruthy();
    expect(view.queryByText('Subscribe for $4.99/month')).toBeNull();
    // Plan credits are ordinary balance — the copy says so.
    expect(view.getByText(/never expire — even if you\s+cancel/)).toBeTruthy();
    // The Manage affordance makes the "manage anytime" promise real.
    const manage = view.getByText('Manage subscription');
    expect(manage).toBeTruthy();
    fireEvent.press(manage);
    expect(mockPlanManage).toHaveBeenCalledTimes(1);
  });

  it('active & cancelled (auto-renew off): distinct copy, credits-forever, Manage doubles as re-subscribe', async () => {
    mockStatus.data = baseStatus({
      aiPlan: {
        active: true,
        productId: 'calen_ai_monthly_499',
        price: 4.99,
        monthlyCredits: 600,
        expiresAt: '2026-08-15T00:00:00.000Z',
      },
    });
    // Server still reports active (cancellation is a no-op until expiry); RC is
    // the only source that knows auto-renew is off.
    mockPlan.entitlement = { willRenew: false, expirationDate: '2026-08-15T00:00:00.000Z' };
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Cancelled')).toBeTruthy();
    expect(
      view.getByText(/Cancelled — plan benefits until August 15\.\s*Your credits are yours forever\./)
    ).toBeTruthy();
    // Not the renewing copy, and not the subscribe CTA.
    expect(view.queryByText('Renews with 600 credits on August 15.')).toBeNull();
    expect(view.queryByText('Subscribe for $4.99/month')).toBeNull();
    const manage = view.getByText('Manage subscription');
    fireEvent.press(manage);
    expect(mockPlanManage).toHaveBeenCalledTimes(1);
  });

  it('unlimited admins see neither the plan card nor the store', async () => {
    mockStatus.data = baseStatus({ unlimited: true });
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Unlimited')).toBeTruthy();
    expect(view.queryByText('Calen AI plan')).toBeNull();
    expect(view.queryByText('Buy credits')).toBeNull();
  });

  it('renders the rate card: chat pinned first, price ascending, call pinned last', async () => {
    const view = await render(<CreditsScreen />);
    expect(view.getByText('What things cost')).toBeTruthy();
    // Chat is token-priced (grows with the reply), so it reads "Varies with
    // length" instead of a flat number; each reply reports its own cost.
    expect(view.getByText('Varies with length')).toBeTruthy();
    expect(view.getByText('20 credits/min')).toBeTruthy();
    // Web search is no longer a separate charge (folded into token-priced chat).
    expect(view.queryByText('Web search')).toBeNull();
    // Chat pins first; the rest ascend by the live server price (ties
    // alphabetical by label); the per-minute call row pins last — its unit
    // differs and the per-second billing note under the list is its footnote.
    const labels = [
      'Chat message', // token-priced, pinned first
      'Form assist', // 1
      'Photo scan', // 3
      'Recipe generation', // 3 — tie broken alphabetically
      'Owner’s manual parsing', // 40
      'Phone call', // 20/min, pinned last
    ].map((t) => view.getByText(t));
    const json = JSON.stringify(view.toJSON());
    const positions = labels.map((n) => json.indexOf(JSON.stringify(n.props.children)));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('history lists purchases & grants only — usage debits are excluded', async () => {
    mockLedger.entries = [
      { kind: 'usage', credits: -6.7, productId: null, action: 'call', note: null, createdAt: '2026-07-28T00:00:00Z' },
      { kind: 'usage', credits: -2, productId: null, action: 'chat', note: null, createdAt: '2026-07-27T00:00:00Z' },
      { kind: 'plan', credits: 600, productId: 'calen_ai_monthly_499', action: null, note: null, createdAt: '2026-07-15T00:00:00Z' },
      { kind: 'purchase', credits: 500, productId: 'credits_499', action: null, note: null, createdAt: '2026-07-01T00:00:00Z' },
    ];
    const view = await render(<CreditsScreen />);
    // Grants render as before: labeled kind, +whole credits.
    expect(view.getByText('Monthly plan credits')).toBeTruthy();
    expect(view.getByText('+600')).toBeTruthy();
    expect(view.getByText('Credit pack')).toBeTruthy();
    expect(view.getByText('+500')).toBeTruthy();
    // Usage debits are summarized in the spend card, never itemized in History.
    expect(view.queryByText('-6.7')).toBeNull();
    expect(view.queryByText('-2')).toBeNull();
  });

  it('history caps the inline card and drills into the full history when there are more', async () => {
    mockNavigate.mockClear();
    // Six grants — one over the inline cap, so a "See all" appears.
    mockLedger.entries = Array.from({ length: 6 }, (_, i) => ({
      kind: 'purchase',
      credits: 500,
      productId: 'credits_499',
      action: null,
      note: null,
      createdAt: `2026-07-0${i + 1}T00:00:00Z`,
    }));
    const view = await render(<CreditsScreen />);
    // Only the cap (5) of the six grant rows render inline.
    expect(view.getAllByText('Credit pack')).toHaveLength(5);
    // The "See all" affordance drills into the full-history screen.
    const seeAll = view.getByText('See all history');
    fireEvent.press(seeAll);
    expect(mockNavigate).toHaveBeenCalledWith('CreditHistory');
  });

  it('history hides "See all" when the grants fit inline', async () => {
    mockLedger.entries = [
      { kind: 'plan', credits: 600, productId: 'calen_ai_monthly_499', action: null, note: null, createdAt: '2026-07-15T00:00:00Z' },
      { kind: 'purchase', credits: 500, productId: 'credits_499', action: null, note: null, createdAt: '2026-07-01T00:00:00Z' },
    ];
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Monthly plan credits')).toBeTruthy();
    expect(view.queryByText('See all history')).toBeNull();
  });

  it('spend card summarizes credits per feature this week, biggest first, with a total', async () => {
    mockStatus.data = baseStatus({ spend: { chat: 42, call: 6.7, scan: 3 } });
    const view = await render(<CreditsScreen />);
    expect(view.getByText('Where your credits go')).toBeTruthy();
    // Feature labels reuse the friendly analytics names; a prorated call keeps
    // its fraction.
    expect(view.getByText('Chat & assistants')).toBeTruthy();
    expect(view.getByText('42')).toBeTruthy();
    expect(view.getByText('Assistant calls')).toBeTruthy();
    expect(view.getByText('6.7')).toBeTruthy();
    // A total row sums the week's spend.
    expect(view.getByText('Spent this week')).toBeTruthy();
    expect(view.getByText('51.7 credits')).toBeTruthy();
    // Biggest-first ordering: chat (42) before scan (3).
    const json = JSON.stringify(view.toJSON());
    expect(json.indexOf('Chat & assistants')).toBeLessThan(json.indexOf('Photo scans'));
  });
});
