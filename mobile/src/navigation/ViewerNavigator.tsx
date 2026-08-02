import React from 'react';
import { TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import ViewerCalendarScreen from '../screens/viewer/ViewerCalendarScreen';
import ViewerEventScreen from '../screens/viewer/ViewerEventScreen';
import InvitationsScreen from '../screens/calendar/InvitationsScreen';
import UnlockPaywallScreen from '../screens/plan/UnlockPaywallScreen';
import { RootStackParamList } from './types';
import { colors } from '../theme';

// Free viewer mode's shell (billing-plans.md): what a signed-in user WITHOUT
// the $4.99 app unlock gets when a calendar has been shared with them (or a
// share invitation is pending) — instead of the hard paywall. Deliberately
// tiny: the read-only shared-calendar agenda, the invitations inbox (to accept
// a share), the unlock paywall as an upgrade route, and sign-out (inside the
// screens). Everything else stays behind the paywall in AppNavigator.
//
// Routes are a slice of RootStackParamList so the reused screens' typings
// resolve unchanged; InvitationsScreen's only navigate() target (Interaction,
// a call notice) can't render for a viewer — they have no PhoneCall rows.

const Stack = createNativeStackNavigator<RootStackParamList>();

const hdr = (bg: string) => ({ headerStyle: { backgroundColor: bg }, headerTintColor: '#fff' as const });

export default function ViewerNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="ViewerHome"
      screenOptions={{
        ...hdr(colors.background),
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen
        name="ViewerHome"
        component={ViewerCalendarScreen}
        options={{ title: 'Shared with you' }}
      />
      <Stack.Screen name="ViewerEvent" component={ViewerEventScreen} options={{ title: 'Event' }} />
      <Stack.Screen
        name="Invitations"
        component={InvitationsScreen}
        options={({ navigation }) => ({
          presentation: 'modal',
          title: 'Invitations',
          headerLeft: () => (
            <TouchableOpacity onPress={() => navigation.goBack()} style={{ paddingHorizontal: 4 }}>
              <Ionicons name="close" size={26} color="#fff" />
            </TouchableOpacity>
          ),
        })}
      />
      <Stack.Screen
        name="UnlockPaywall"
        component={UnlockPaywallScreen}
        options={{ title: 'Unlock Calen' }}
      />
    </Stack.Navigator>
  );
}
