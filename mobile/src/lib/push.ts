import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { notificationsApi } from '../api';

// Remote-push token registration, wired by hooks/usePushNotifications (sign-in
// + foreground). Reminders stay on-device (lib/notifications.ts, the server
// cron skips localReminders users); remote push carries what can't be computed
// locally — household event invite/response alerts, cross-household invitation
// alerts, and security alerts.
//
// Ask permission, get the Expo push token, and register it with the backend so
// the server can deliver via APNs/FCM through the Expo Push API
// (server/src/services/push.js sendToExpo). Returns the token, or null if
// unavailable (simulator, denied permission, or missing projectId).

// The token this install last registered, so sign-out can retire exactly it.
let lastToken: string | null = null;

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) return null; // push tokens require a physical device

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );

  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  await notificationsApi.registerNative(token, platform, Device.modelName ?? undefined);
  lastToken = token;
  return token;
}

export async function unregisterPushToken(token: string): Promise<void> {
  await notificationsApi.unregisterNative(token).catch(() => {});
}

// Sign-out hygiene: a signed-out install must not keep receiving the previous
// account's pushes. Best-effort — a failure just leaves a dead token the
// server prunes on its next DeviceNotRegistered.
export async function unregisterCurrentPushToken(): Promise<void> {
  if (!lastToken) return;
  await unregisterPushToken(lastToken);
  lastToken = null;
}
