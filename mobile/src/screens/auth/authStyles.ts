import { StyleSheet, Platform } from 'react-native';
import { colors, spacing } from '../../theme';

// Shared look for the pre-auth screens (Login / Register / Forgot password).
// They sit on the brand-blue background, so text, links, and inputs are all
// white/translucent-white rather than the app's dark-theme tokens.
export const authStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.primary },
  inner: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  title: { fontSize: 24, fontWeight: '700', color: '#fff', marginTop: spacing.sm },
  subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 4, textAlign: 'center' },
  error: { color: '#fff', marginBottom: spacing.md, textAlign: 'center', fontWeight: '600' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg },
  footerText: { color: 'rgba(255,255,255,0.8)' },
  link: { color: '#fff', fontWeight: '600' },
  inputLabel: { color: '#fff' },
  inputField: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderColor: 'rgba(255,255,255,0.4)',
    color: '#fff',
  },
});

// Common props for an <Input> on the blue auth background. The clear ✕ is
// tinted the same translucent white as the placeholder — the app's muted grey
// reads as a dirty smudge against the brand blue.
export const authInputProps = {
  labelStyle: authStyles.inputLabel,
  style: authStyles.inputField,
  placeholderTextColor: 'rgba(255,255,255,0.6)',
  clearColor: 'rgba(255,255,255,0.55)',
} as const;

// The primary CTA sits on the blue background, so tint its fill darker to keep
// it distinct; ghost buttons get a white outline + label.
export const AUTH_PRIMARY_BTN_COLOR = colors.primaryDark;
export const AUTH_GHOST_BTN_COLOR = '#fff';

// `Platform` re-exported so screens can keep a single import for the shared
// KeyboardAvoidingView behaviour.
export const keyboardBehavior = Platform.OS === 'ios' ? 'padding' : undefined;
