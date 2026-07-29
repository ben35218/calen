import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

// Non-sensitive device/app context attached to an in-app feedback submission so
// a report is actionable without a round-trip (spec: features/feedback.md). This
// is a plaintext support payload — it MUST NOT carry household content, secrets,
// or precise location. `route` (the screen the user came from) is passed in by
// the caller, since it depends on navigation state.
export interface Diagnostics {
  appVersion: string;
  buildNumber: string;
  platform: string;
  osVersion: string;
  deviceModel: string;
  route: string;
  locale: string;
}

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    return '';
  }
}

export function collectDiagnostics(route = ''): Diagnostics {
  const build =
    Constants.expoConfig?.ios?.buildNumber ??
    (Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : '');
  return {
    appVersion: Constants.expoConfig?.version ?? '',
    buildNumber: build ?? '',
    platform: Platform.OS,
    osVersion: Device.osVersion ?? '',
    deviceModel: Device.modelName ?? Device.deviceName ?? '',
    route,
    locale: deviceLocale(),
  };
}

// A short, human-readable summary shown to the user before they submit, so it's
// transparent what device context is attached.
export function summarizeDiagnostics(d: Diagnostics): string {
  const parts: string[] = [];
  if (d.appVersion) parts.push(`App ${d.appVersion}${d.buildNumber ? ` (${d.buildNumber})` : ''}`);
  const os = [d.platform, d.osVersion].filter(Boolean).join(' ');
  if (os) parts.push(os);
  if (d.deviceModel) parts.push(d.deviceModel);
  return parts.join(' · ');
}
