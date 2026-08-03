import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react-native';
import LoginScreen from '../LoginScreen';
import ForgotPasswordScreen from '../ForgotPasswordScreen';

// An email typed on the sign-in form must survive the trip to "Forgot password?"
// — the reset screen is seeded from the route param, not blank.
const mockNavigate = jest.fn();
const mockRoute: { params: Record<string, unknown> | undefined } = { params: undefined };

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: jest.fn() }),
  useRoute: () => mockRoute,
}));

// Stub the UI kit so the test doesn't drag in native modules (keyboard-controller
// / reanimated). The Input becomes a plain TextInput keyed by its label.
jest.mock('../../../components/ui', () => {
  const RN = require('react-native');
  return {
    Input: ({ label, value, onChangeText }: any) => (
      <RN.TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} />
    ),
    Button: ({ title, onPress }: any) => <RN.Text onPress={onPress}>{title}</RN.Text>,
  };
});
jest.mock('../AuthScaffold', () => ({
  AuthScaffold: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../../store/auth', () => ({
  useAuth: () => ({ login: jest.fn(), loginWithPasskey: jest.fn(), resetPassword: jest.fn() }),
}));
jest.mock('../../../lib/passkeys', () => ({ passkeysSupported: () => false }));
jest.mock('../../../api', () => ({ authApi: { forgotPassword: jest.fn() } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

describe('forgot-password email hand-off', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockRoute.params = undefined;
  });
  afterEach(cleanup);

  it('passes the typed sign-in email to the reset screen', async () => {
    await render(<LoginScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), '  user@example.com  ');
    await fireEvent.press(screen.getByText('Forgot password?'));
    expect(mockNavigate).toHaveBeenCalledWith('ForgotPassword', { email: 'user@example.com' });
  });

  it('passes no email when the sign-in field is empty', async () => {
    await render(<LoginScreen />);
    await fireEvent.press(screen.getByText('Forgot password?'));
    expect(mockNavigate).toHaveBeenCalledWith('ForgotPassword', { email: undefined });
  });

  it('seeds the reset screen email field from the route param', async () => {
    mockRoute.params = { email: 'user@example.com' };
    await render(<ForgotPasswordScreen />);
    expect(screen.getByLabelText('Email').props.value).toBe('user@example.com');
  });

  it('starts blank when arriving without an email', async () => {
    await render(<ForgotPasswordScreen />);
    expect(screen.getByLabelText('Email').props.value).toBe('');
  });
});
