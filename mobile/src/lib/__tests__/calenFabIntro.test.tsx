// The Calen FAB's first-run attention state (spec: features/calendar.md →
// floating chrome, bottom-right): the button wears a pulsing discovery halo
// until the first-ever tap, then retires it for good. These pin the one-shot
// contract: no halo flash before AsyncStorage answers, a returning user never
// sees it, and one tap settles every mounted consumer and persists.
// renderHook is unusable under this jest-expo/React 19 setup (see
// useBilling.test.tsx), so the hook is exercised through a tiny harness.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import React from 'react';
import { TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';
import { Text } from '../../components/Text';
import { useCalenFabIntro, __resetCalenFabIntroForTests } from '../calenFabIntro';

const KEY = 'hc_calen_fab_intro_seen';

function Harness({ tag = 'fab' }: { tag?: string }) {
  const { intro, markSeen } = useCalenFabIntro();
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={tag} onPress={markSeen}>
      <Text>{`${tag}:${intro ? 'intro' : 'quiet'}`}</Text>
    </TouchableOpacity>
  );
}

afterEach(async () => {
  cleanup();
  __resetCalenFabIntroForTests();
  await AsyncStorage.clear();
});

it('fresh install: mounts quiet (no flash), pulses once the flag loads', async () => {
  // Hold AsyncStorage's answer so the pre-load frame is observable: while the
  // read is in flight the button must be the plain disc.
  let answer!: (v: string | null) => void;
  (AsyncStorage.getItem as jest.Mock).mockReturnValueOnce(
    new Promise<string | null>((r) => {
      answer = r;
    })
  );
  const view = await render(<Harness />);
  view.getByText('fab:quiet');
  answer(null);
  await waitFor(() => view.getByText('fab:intro'));
});

it('returning user: never pulses', async () => {
  await AsyncStorage.setItem(KEY, '1');
  const view = await render(<Harness />);
  // Let the load settle, then confirm the intro never appeared.
  await new Promise((r) => setTimeout(r, 0));
  view.getByText('fab:quiet');
  expect(view.queryByText('fab:intro')).toBeNull();
});

it('first tap settles every mounted consumer and persists', async () => {
  // Month grid + day view render the same button; the flag is shared.
  const view = await render(
    <>
      <Harness tag="month" />
      <Harness tag="day" />
    </>
  );
  await waitFor(() => view.getByText('month:intro'));
  view.getByText('day:intro');

  fireEvent.press(view.getByLabelText('month'));
  await waitFor(() => view.getByText('month:quiet'));
  view.getByText('day:quiet');
  await waitFor(async () => expect(await AsyncStorage.getItem(KEY)).toBe('1'));
});
