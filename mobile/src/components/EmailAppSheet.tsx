import React, { useCallback, useState } from 'react';
import { StyleSheet} from 'react-native';
import { Text } from './Text';
import * as Clipboard from 'expo-clipboard';
import { BottomSheet, Divider, Hint, ListRow } from './ui';
import {
  EmailContent,
  MailApp,
  composeShareEmail,
  composeShareEmailWith,
  detectMailApps,
  getPreferredMailApp,
  resolveEmailContent,
  setPreferredMailApp,
} from '../lib/shareInvite';
import { colors, spacing } from '../theme';

// The "Send invite with…" chooser for device-composed email invites. mailto:
// alone always lands in the ONE default mail app (Apple Mail unless the user
// changed it in iOS Settings), which strands Gmail/Outlook users — so when more
// than one known mail client is installed we ask once, open that app's own
// compose deep link (recipient/subject/body prefilled), and remember the pick.
// A share sheet is deliberately NOT used here: share extensions can't accept a
// prefilled To: address, and the address is the whole point of this flow.

// One tappable row per detected mail app; `children` appends caller-specific
// rows (copy-to-clipboard in the invite flow, "Ask each time" in Account).
export function MailAppPickerSheet({
  visible,
  onClose,
  title,
  subtitle,
  apps,
  onPick,
  hint,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  apps: MailApp[];
  onPick: (app: MailApp) => void;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {apps.map((a) => (
        <ListRow
          key={a.id}
          icon={a.icon as any}
          mdiIcon={a.mdiIcon}
          title={a.label}
          onPress={() => onPick(a)}
        />
      ))}
      {children ? <Divider /> : null}
      {children}
      {hint ? <Hint style={styles.hint}>{hint}</Hint> : null}
    </BottomSheet>
  );
}

// Orchestrates a device-composed email invite:
//   0 known apps → mailto: (Android, or nothing detectable — the OS default);
//   1 known app → open it directly, nothing to choose;
//   a remembered pick that's still installed → open it directly;
//   otherwise → show the chooser, remember the pick for next time.
// Returns { composeEmail, emailSheet }: call composeEmail wherever
// composeShareEmail was called (same signature + throw behavior), and render
// {emailSheet} anywhere in the screen (it's a Modal). Dismissing the sheet
// resolves without opening anything — the invitation is already saved
// server-side; the screens' note text already tells the user to send it.
export function useEmailComposer(): { composeEmail: (email: string, content: string | EmailContent) => Promise<void>; emailSheet: React.ReactNode } {
  const [req, setReq] = useState<{
    email: string;
    content: string | EmailContent;
    apps: MailApp[];
    resolve: (choice: MailApp | 'copy' | null) => void;
  } | null>(null);

  const composeEmail = useCallback(async (email: string, content: string | EmailContent) => {
    const apps = await detectMailApps();
    if (apps.length === 0) return composeShareEmail(email, content);
    if (apps.length === 1) return composeShareEmailWith(apps[0], email, content);
    const prefId = await getPreferredMailApp();
    const preferred = apps.find((a) => a.id === prefId);
    if (preferred) return composeShareEmailWith(preferred, email, content);

    const choice = await new Promise<MailApp | 'copy' | null>((resolve) => {
      setReq({ email, content, apps, resolve });
    });
    if (choice === null) return;
    if (choice === 'copy') {
      await Clipboard.setStringAsync(resolveEmailContent(content).body);
      return;
    }
    await setPreferredMailApp(choice.id);
    await composeShareEmailWith(choice, email, content);
  }, []);

  const settle = (choice: MailApp | 'copy' | null) => {
    if (!req) return;
    setReq(null);
    req.resolve(choice);
  };

  const emailSheet = req ? (
    <MailAppPickerSheet
      visible
      onClose={() => settle(null)}
      title="Send invite with"
      subtitle={`To: ${req.email}`}
      apps={req.apps}
      onPick={(a) => settle(a)}
      hint="Your choice is remembered for future invites — change it anytime in Profile → Account."
    >
      <ListRow icon="copy-outline" title="Copy invite message" onPress={() => settle('copy')} />
    </MailAppPickerSheet>
  ) : null;

  return { composeEmail, emailSheet };
}

const styles = StyleSheet.create({
  subtitle: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm },
  hint: { marginTop: spacing.sm },
});
