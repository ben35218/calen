// JS face of the CalenWidget native module (ios/CalenWidgetModule.swift).
// The module only exists in dev-client/EAS iOS builds — Expo Go, Android, and
// jest all resolve it to null, so every call degrades to a silent no-op and
// callers never need a Platform guard.
import { requireOptionalNativeModule } from 'expo-modules-core';

type CalenWidgetNative = {
  setSnapshot(json: string): Promise<void>;
  clearSnapshot(): Promise<void>;
  reloadWidgets(): Promise<void>;
  installedWidgetCount(): Promise<number>;
};

const native = requireOptionalNativeModule<CalenWidgetNative>('CalenWidget');

// Whether the native bridge is linked (iOS dev-client/EAS build). Exposed so
// the snapshot writer can skip the whole decrypt-and-expand pass when there is
// nowhere to write the result.
export function widgetBridgeAvailable(): boolean {
  return native != null;
}

export async function setWidgetSnapshotJson(json: string): Promise<void> {
  await native?.setSnapshot(json);
}

export async function clearWidgetSnapshotFile(): Promise<void> {
  await native?.clearSnapshot();
}

export async function reloadWidgetTimelines(): Promise<void> {
  await native?.reloadWidgets();
}

// How many Calen widgets the user has on their Home/Lock Screen (WidgetKit's
// getCurrentConfigurations). `null` when the bridge is missing — callers that
// gate promo UI on "not installed" should treat null as "unknowable", not 0.
export async function getInstalledWidgetCount(): Promise<number | null> {
  return (await native?.installedWidgetCount()) ?? null;
}

// TEMP DEBUG (remove after device verification).
export async function widgetSnapshotDebug(): Promise<Record<string, unknown> | null> {
  return (await (native as unknown as { snapshotDebug?: () => Promise<Record<string, unknown>> })?.snapshotDebug?.()) ?? null;
}
