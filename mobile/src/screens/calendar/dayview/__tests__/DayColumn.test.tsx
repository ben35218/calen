import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react-native';

// The day view's event card (calendar.md → Day view): title, location and the
// start–end range, each meta line led by its glyph. What renders is governed by
// the block's height, so a short event doesn't stack clipped rows. An event
// with a drive time extends upward from its start with a labelled travel band.
// The column canvas itself takes a long-press: empty grid space springs a
// ghost "New Event" into the pressed 15-minute slot, then drafts it in the
// event form; the ghost fades once the day view regains focus.

const mockNavigate = jest.fn();
const mockListeners: Record<string, () => void> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    addListener: (event: string, cb: () => void) => {
      mockListeners[event] = cb;
      return () => {
        delete mockListeners[event];
      };
    },
  }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

// Glyphs render as their name so the rows can be asserted by what leads them.
jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  const ReactLib = require('react');
  return {
    MaterialCommunityIcons: ({ name, accessibilityLabel }: { name: string; accessibilityLabel?: string }) =>
      ReactLib.createElement(Text, { accessibilityLabel }, `icon:${name}`),
  };
});

import DayColumn from '../DayColumn';
import { LaidBlock, MIN_BLOCK } from '../dayViewLayout';

const laid = (over: Partial<LaidBlock> = {}): LaidBlock => ({
  key: 'e1',
  title: 'EarlyON Alfred',
  location: '520 St Philippe St',
  color: '#1976D2',
  startMin: 9 * 60,
  endMin: 11 * 60,
  eventId: 'e1',
  top: 9 * 60,
  height: 120,
  travelHeight: 0,
  leftFrac: 0,
  widthFrac: 1,
  ...over,
});

// One render per test — a mid-test re-render overlaps the previous act().
const column = (over: Partial<LaidBlock> = {}) =>
  render(<DayColumn date="2026-08-12" blocks={[laid(over)]} width={200} />);

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
});

describe('DayColumn — the event card', () => {
  it('renders title, location and the collapsed time range', async () => {
    const view = await column();
    view.getByText('EarlyON Alfred');
    view.getByText('520 St Philippe St');
    view.getByText('9 – 11AM');
    view.getByText('icon:map-marker-outline');
    view.getByText('icon:clock-outline');
  });

  it('names the travel band, so the lead-in is not just a shape', async () => {
    const view = await column({ travelMinutes: 15, travelHeight: 15, height: 135 });
    view.getByText('15 min travel');
  });

  it('spells out the band for a screen reader, leave-by time included', async () => {
    const view = await column({ travelMinutes: 90, travelHeight: 90, height: 210, startMin: 10 * 60 });
    view.getByLabelText('1 hr 30 min travel time before this event — leave by 8:30 AM');
  });

  it('leaves an event without travel time with no band at all', async () => {
    const view = await column();
    expect(view.queryByText(/travel/)).toBeNull();
  });

  it('keeps the band unlabelled when the drive is too short to print a line', async () => {
    const view = await column({ travelMinutes: 8, travelHeight: 8, height: 128 });
    expect(view.queryByText(/travel/)).toBeNull();
  });

  it('sizes the event body from the block minus its travel band', async () => {
    // 45px of body: room for the time row but not the location.
    const view = await column({ travelMinutes: 30, travelHeight: 30, height: 77 });
    expect(view.queryByText('520 St Philippe St')).toBeNull();
    expect(view.queryByText('9 – 11AM')).toBeTruthy();
  });

  it('keeps all three lines on a one-hour block', async () => {
    const view = await column({ height: 60 });
    expect(view.queryByText('520 St Philippe St')).toBeTruthy();
    expect(view.queryByText('9 – 11AM')).toBeTruthy();
  });

  it('drops the location first when the block is too short for it', async () => {
    const view = await column({ height: 45 });
    expect(view.queryByText('520 St Philippe St')).toBeNull();
    expect(view.queryByText('9 – 11AM')).toBeTruthy();
  });

  it('leaves the title alone on the shortest block there is', async () => {
    const view = await column({ height: MIN_BLOCK });
    expect(view.queryByText('EarlyON Alfred')).toBeTruthy();
    expect(view.queryByText('520 St Philippe St')).toBeNull();
    expect(view.queryByText('9 – 11AM')).toBeNull();
  });

  it('keeps the travel band on a block too short for a time row', async () => {
    const view = await column({ height: MIN_BLOCK + 15, travelMinutes: 15, travelHeight: 15 });
    expect(view.queryByText('9 – 11AM')).toBeNull();
    view.getByText('15 min travel');
  });
});

describe('DayColumn — long-press to create', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('springs a ghost New Event into the pressed slot, then pushes the form', async () => {
    jest.useFakeTimers();
    const view = await column();
    // A 2:22 PM press (1 px/min) lands in the 2:15 slot.
    await act(async () => {
      fireEvent(view.root!, 'longPress', { nativeEvent: { locationY: 14 * 60 + 22 } });
    });
    // The ghost is there immediately — placement feedback before the push.
    view.getByText('New Event');
    view.getByText('2:15 – 3:15PM');
    expect(mockNavigate).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(mockNavigate).toHaveBeenCalledWith('EventForm', {
      date: '2026-08-12',
      prefill: { allDay: false, startTime: '14:15', endTime: '15:15' },
    });
  });

  it('fades the ghost out when the day view regains focus', async () => {
    jest.useFakeTimers();
    const view = await column();
    await act(async () => {
      fireEvent(view.root!, 'longPress', { nativeEvent: { locationY: 14 * 60 } });
      jest.advanceTimersByTime(300);
    });
    view.getByText('New Event');
    // Coming back from the form: focus fires, the fade runs, the ghost goes.
    await act(async () => {
      mockListeners.focus?.();
      jest.runAllTimers();
    });
    expect(view.queryByText('New Event')).toBeNull();
  });

  it('still opens the detail screen from a tap on an event block', async () => {
    const view = await column();
    fireEvent.press(view.getByText('EarlyON Alfred'));
    expect(mockNavigate).toHaveBeenCalledWith('EventDetail', { eventId: 'e1', date: '2026-08-12' });
  });
});
