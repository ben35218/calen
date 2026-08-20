import React from 'react';
import { View, StyleSheet } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from './types';
import { HeaderIconButton, HeaderCloseButton } from '../components/ui';
import { colors } from '../theme';
import { ASSISTANT_NAME } from '../config';
import { useSyncTimezone } from '../lib/useSyncTimezone';
import { useBilling } from '../hooks/useBilling';

// Calendar
import CalendarScreen from '../screens/calendar/CalendarScreen';
import CalendarDayScreen from '../screens/calendar/CalendarDayScreen';
import EventFormScreen from '../screens/calendar/EventFormScreen';
import EventDetailScreen from '../screens/calendar/EventDetailScreen';
import AttachmentPreviewScreen from '../screens/calendar/AttachmentPreviewScreen';
import PlacePreviewScreen from '../screens/chat/PlacePreviewScreen';
import AssistantScreen from '../screens/chat/AssistantScreen';
import CalendarSearchScreen from '../screens/calendar/CalendarSearchScreen';
import CalendarsScreen from '../screens/calendar/CalendarsScreen';
import AddCalendarMenuScreen from '../screens/calendar/AddCalendarMenuScreen';
import AddCalendarScreen from '../screens/calendar/AddCalendarScreen';
import SubscribeCalendarScreen from '../screens/calendar/SubscribeCalendarScreen';
import AddHolidayCalendarScreen from '../screens/calendar/AddHolidayCalendarScreen';
import CalendarColorsScreen from '../screens/calendar/CalendarColorsScreen';
import PrintCalendarScreen from '../screens/calendar/PrintCalendarScreen';
import HolidaysScreen from '../screens/calendar/HolidaysScreen';
import HolidayAlertsScreen from '../screens/calendar/HolidayAlertsScreen';
import OccasionsScreen from '../screens/calendar/OccasionsScreen';
import ECardFormScreen from '../screens/calendar/ECardFormScreen';
import OccasionAlertsScreen from '../screens/calendar/OccasionAlertsScreen';
import WeatherScreen from '../screens/calendar/WeatherScreen';
import WeatherLocationSearchScreen from '../screens/calendar/WeatherLocationSearchScreen';
import InvitationsScreen from '../screens/calendar/InvitationsScreen';
import EventInviteesScreen from '../screens/calendar/EventInviteesScreen';
import EventTravelTimeScreen from '../screens/calendar/EventTravelTimeScreen';
import EventRepeatScreen from '../screens/calendar/EventRepeatScreen';
import EventLocationScreen from '../screens/calendar/EventLocationScreen';
import InteractionScreen from '../screens/calendar/InteractionScreen';
import EventActionScreen from '../screens/calendar/EventActionScreen';

// Maintenance (item-centric)
import MaintenanceScreen from '../screens/maintenance/MaintenanceScreen';
import TaskDetailScreen from '../screens/maintenance/TaskDetailScreen';
import TaskFormScreen from '../screens/maintenance/TaskFormScreen';
import TaskTemplatesScreen from '../screens/maintenance/TaskTemplatesScreen';
import TaskTemplateReviewScreen from '../screens/maintenance/TaskTemplateReviewScreen';
import ItemDetailScreen from '../screens/maintenance/ItemDetailScreen';
import ItemFormScreen from '../screens/maintenance/ItemFormScreen';
import MaintenanceChatScreen from '../screens/maintenance/MaintenanceChatScreen';

// Chores (separate flow)
import ChoresScreen from '../screens/maintenance/ChoresScreen';
import ChoreDetailScreen from '../screens/maintenance/ChoreDetailScreen';
import AddChoreScreen from '../screens/maintenance/AddChoreScreen';
import ChoreFormScreen from '../screens/maintenance/ChoreFormScreen';
import ChoreTemplatesScreen from '../screens/maintenance/ChoreTemplatesScreen';

// Kitchen
import KitchenScreen from '../screens/kitchen/KitchenScreen';
import RecipesScreen from '../screens/kitchen/RecipesScreen';
import GroceryScheduleScreen from '../screens/kitchen/GroceryScheduleScreen';
import RecipeDetailScreen from '../screens/kitchen/RecipeDetailScreen';
import RecipeFormScreen from '../screens/kitchen/RecipeFormScreen';
import CookingModeScreen from '../screens/kitchen/CookingModeScreen';
import FindRecipesScreen from '../screens/kitchen/FindRecipesScreen';
import MealPlannerSettingsScreen from '../screens/kitchen/MealPlannerSettingsScreen';
import AddMealScreen from '../screens/kitchen/AddMealScreen';

// Trips
import TripsScreen from '../screens/trips/TripsScreen';
import TripFormScreen from '../screens/trips/TripFormScreen';
import TripDetailScreen from '../screens/trips/TripDetailScreen';
import TripItemFormScreen from '../screens/trips/TripItemFormScreen';
import TripSettleScreen from '../screens/trips/TripSettleScreen';
import TripAssistantScreen from '../screens/trips/TripAssistantScreen';

// Profile
import ProfileScreen from '../screens/ProfileScreen';
import AccountScreen from '../screens/profile/AccountScreen';
import RemindersScreen from '../screens/profile/RemindersScreen';
import PrivacyDataScreen from '../screens/profile/PrivacyDataScreen';
import HelpFeedbackScreen from '../screens/profile/HelpFeedbackScreen';
import GuardianRecoveryScreen from '../screens/profile/GuardianRecoveryScreen';
import RecoveryCodeScreen from '../screens/profile/RecoveryCodeScreen';
import LinkDeviceScreen from '../screens/profile/LinkDeviceScreen';
import ContactsScreen from '../screens/profile/ContactsScreen';
import ContactDetailScreen from '../screens/profile/ContactDetailScreen';
import ContactFormScreen from '../screens/profile/ContactFormScreen';
import ContactImportScreen from '../screens/profile/ContactImportScreen';
import HouseholdScreen from '../screens/profile/HouseholdScreen';
import AddOnsScreen from '../screens/plan/AddOnsScreen';
import DiscoverScreen from '../screens/plan/DiscoverScreen';
import WidgetPromoScreen from '../screens/calendar/WidgetPromoScreen';
import CreditsScreen from '../screens/plan/CreditsScreen';
import CreditHistoryScreen from '../screens/plan/CreditHistoryScreen';
import BuyCreditsSheet from '../screens/plan/BuyCreditsSheet';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Every header bar takes the body background (`colors.background`) with no
// shadow, so it blends seamlessly into the screen beneath it — the feature
// accent lives in the body (add button, FAB, save check), never on header
// chrome. The one exception is the two WebView media viewers, which keep pure
// black so the chrome disappears around the content.
const BLACK = '#000';
const hdr = (bg: string) => ({ headerStyle: { backgroundColor: bg }, headerTintColor: '#fff' as const });

// Screen options for a feature-calendar home: the standard header. (The old
// header pencil into Edit Calendar was removed — the Calendars view's per-row
// edit button is now the single path to a calendar's colour/alerts/delete.)
const featureCalendarHome = (title: string) => ({
  ...hdr(colors.background),
  headerShadowVisible: false,
  title,
});

// Assistant chat screens open full screen, as an ordinary push. (They were
// briefly a resizable form sheet, but react-native-screens doesn't give a form
// sheet's JS content a stable height across detent drags, which broke the chat
// layout — a full-screen push is the reliable presentation. The name says
// "screen", not "sheet", so the next edit doesn't reintroduce the sheet.)
const assistantScreen = (title: string) => ({
  ...hdr(colors.background),
  headerShadowVisible: false,
  title,
});

// A self-contained task presented modally: it slides up, is dismissed with a ✕
// (or the native swipe-down), and returns nothing to a hierarchy. Contrast with
// a push, which is how the app navigates *deeper into content* — see the
// presentation rules in specs/features/*.md and mobile/CLAUDE.md.
const modalTask = (title: string, bg: string = colors.background) =>
  ({ navigation }: { navigation: { goBack: () => void } }) => ({
    ...hdr(bg),
    headerShadowVisible: false,
    presentation: 'modal' as const,
    title,
    headerLeft: () => <HeaderCloseButton onPress={() => navigation.goBack()} />,
  });

// One flat stack rooted at the calendar (web's `/` → `/calendar`). The calendar
// home + events list hide the native header and render their own black top bar.
export default function AppNavigator() {
  // Keep the stored timezone aligned with this device (drives 9am alert timing).
  useSyncTimezone();
  // Mounted for its cache side effect, like the viewer shell and the paywall:
  // the status fetch re-mirrors the owned add-ons / unlock / viewer-content
  // caches on entry to the unlocked app. Sign-out clears `hc_owned_addons`
  // (account state), so a fresh session boots locked-by-default — without a
  // root-level fetch the month grid stayed locked until the user happened to
  // visit a screen that mounts useBilling (Calendars, Profile…), which is
  // exactly the "add-on lanes empty until I open Calendars" bug. Mounting it
  // here bounds that window to one status round-trip, and cacheOwnedAddons'
  // changed-set invalidation repaints the grid when it lands.
  useBilling();
  return (
    <View style={styles.root}>
      <Stack.Navigator
      initialRouteName="CalendarHome"
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        // Chevron only — never show the previous screen's title (the headerless
        // CalendarHome would otherwise leak its route name as the label).
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      {/* Calendar family (black). The grid/agenda toggle lives inside
          CalendarHome (crossfading layers), not as a separate route. */}
      <Stack.Screen name="CalendarHome" component={CalendarScreen} options={{ headerShown: false }} />
      {/* Headerless: the day view draws its own floating chrome (back pill,
          view switcher). Native swipe-back stays off so horizontal swipes page
          between days instead of popping to the month.
          animation 'none' is load-bearing, not a preference: month and day are
          the same canvas with the same bottom pills in the same place, so the
          move between them is drawn as a zoom by the two screens themselves
          (screens/calendar/dayTransition) — a native slide would throw that
          shared furniture across the screen and back. */}
      <Stack.Screen name="CalendarDay" component={CalendarDayScreen} options={{ headerShown: false, gestureEnabled: false, animation: 'none' }} />
      <Stack.Screen name="EventDetail" component={EventDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Event' }} />
      {/* In-app attachment preview (WebView: images + PDFs). Dark modal — a
          media viewer keeps the pure-black chrome rather than the app
          background. The title is the file name; a Share button sits in the
          header. */}
      <Stack.Screen
        name="AttachmentPreview"
        component={AttachmentPreviewScreen}
        options={(props) => ({
          ...modalTask(props.route.params?.title || 'Attachment', BLACK)(props),
        })}
      />
      {/* In-app place preview (WebView on the Google Maps lookup) for places
          Calen links in chat. Dark modal; closing resumes the conversation. */}
      <Stack.Screen
        name="PlacePreview"
        component={PlacePreviewScreen}
        options={(props) => ({
          ...modalTask(props.route.params?.title || 'Place', BLACK)(props),
        })}
      />
      <Stack.Screen name="EventForm" component={EventFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Event' }} />
      {/* Unified assistant: Calendar / Chores / Task Plan swap in place inside one
          view; header stays "Calen". Entry points pass `initial` to pick a body. */}
      <Stack.Screen name="Assistant" component={AssistantScreen} options={assistantScreen(ASSISTANT_NAME)} />
      <Stack.Screen name="CalendarSearch" component={CalendarSearchScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Search' }} />
      {/* A push, not a modal: Calendars is browsable hierarchy — it drills into
          Add Calendar, Colours & Order, Print — rather than a task you finish
          and dismiss. */}
      <Stack.Screen
        name="Calendars"
        component={CalendarsScreen}
        options={({ navigation }) => ({
          ...hdr(colors.background),
          headerShadowVisible: false,
          title: 'Calendars',
          // The list's primary add action lives in the header (app convention),
          // opening the Add Calendar chooser (new / subscribe / holiday / restore).
          headerRight: () => (
            <HeaderIconButton
              icon="add"
              size={30}
              onPress={() => navigation.navigate('AddCalendarMenu')}
              accessibilityLabel="Add calendar"
            />
          ),
        })}
      />
      {/* A push, like the other Profile inboxes (Household, Contacts). */}
      <Stack.Screen name="Invitations" component={InvitationsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Invitations' }} />
      <Stack.Screen name="EventInvitees" component={EventInviteesScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Invitees' }} />
      <Stack.Screen name="EventTravelTime" component={EventTravelTimeScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Travel Time' }} />
      <Stack.Screen name="EventRepeat" component={EventRepeatScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Repeat' }} />
      <Stack.Screen name="EventLocation" component={EventLocationScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Location' }} />
      <Stack.Screen name="Interaction" component={InteractionScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Calen Call' }} />
      <Stack.Screen name="EventAction" component={EventActionScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Event Action' }} />
      <Stack.Screen name="AddCalendarMenu" component={AddCalendarMenuScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Add Calendar' }} />
      <Stack.Screen name="AddCalendar" component={AddCalendarScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'New Calendar' }} />
      <Stack.Screen name="SubscribeCalendar" component={SubscribeCalendarScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Subscribe' }} />
      <Stack.Screen name="AddHolidayCalendar" component={AddHolidayCalendarScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Add Holidays' }} />
      <Stack.Screen name="CalendarColors" component={CalendarColorsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Colours & Order' }} />
      {/* A modal: pick a range, produce a PDF, dismiss — a finish-and-dismiss
          task, not a place in the calendar hierarchy. */}
      <Stack.Screen name="PrintCalendar" component={PrintCalendarScreen} options={modalTask('Print')} />
      {/* Title is set by the screen itself from the selected holiday calendar. */}
      <Stack.Screen name="Holidays" component={HolidaysScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Holidays', headerTitleAlign: 'center' }} />
      <Stack.Screen name="HolidayAlerts" component={HolidayAlertsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Holiday Alerts' }} />
      {/* Route name stays "Birthdays" (the add-on key + deep-links are keyed to
          it); only the visible title becomes "Occasions". */}
      <Stack.Screen name="Birthdays" component={OccasionsScreen} options={featureCalendarHome('Occasions')} />
      <Stack.Screen name="ECardForm" component={ECardFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Schedule E-Card' }} />
      <Stack.Screen name="OccasionAlerts" component={OccasionAlertsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Occasion Alerts' }} />
      {/* Transparent header: sky gradient runs edge-to-edge, only the back
          chevron floats. headerStyle must be reset too, or the navigator-level
          red background still paints. */}
      <Stack.Screen
        name="Weather"
        component={WeatherScreen}
        options={{
          headerTransparent: true,
          headerStyle: { backgroundColor: 'transparent' },
          headerShadowVisible: false,
          headerTintColor: '#fff',
          title: '',
        }}
      />
      {/* Pushed from the Weather source sheet — a plain form-style screen (the
          sky gradient stays behind on Weather), field under the header. */}
      <Stack.Screen name="WeatherLocationSearch" component={WeatherLocationSearchScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Another Location' }} />

      {/* Maintenance (blue) */}
      <Stack.Screen name="MaintenanceHome" component={MaintenanceScreen} options={featureCalendarHome('Maintenance')} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Task' }} />
      <Stack.Screen name="TaskForm" component={TaskFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Task' }} />
      <Stack.Screen name="TaskTemplates" component={TaskTemplatesScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Task Templates' }} />
      <Stack.Screen name="TaskTemplateReview" component={TaskTemplateReviewScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Link Items' }} />
      <Stack.Screen name="ItemDetail" component={ItemDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Item' }} />
      <Stack.Screen name="ItemForm" component={ItemFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Item' }} />
      <Stack.Screen name="MaintenanceChat" component={MaintenanceChatScreen} options={assistantScreen(`${ASSISTANT_NAME} · Maintenance`)} />

      {/* Chores (orange) */}
      <Stack.Screen name="ChoresHome" component={ChoresScreen} options={featureCalendarHome('Chores')} />
      <Stack.Screen name="ChoreDetail" component={ChoreDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Chore' }} />
      <Stack.Screen name="AddChore" component={AddChoreScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Add Chore' }} />
      <Stack.Screen name="ChoreForm" component={ChoreFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Chore' }} />
      <Stack.Screen name="ChoreTemplates" component={ChoreTemplatesScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Chore Templates' }} />

      {/* Kitchen / meals (teal) */}
      <Stack.Screen name="KitchenHome" component={KitchenScreen} options={featureCalendarHome('Meals')} />
      <Stack.Screen name="Recipes" component={RecipesScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Recipes' }} />
      <Stack.Screen name="GrocerySchedule" component={GroceryScheduleScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Grocery Shopping Schedule' }} />
      <Stack.Screen name="RecipeDetail" component={RecipeDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Recipe' }} />
      <Stack.Screen name="RecipeForm" component={RecipeFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Recipe' }} />
      <Stack.Screen name="CookingMode" component={CookingModeScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Cooking' }} />
      <Stack.Screen name="RecipeAssistant" component={FindRecipesScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: `${ASSISTANT_NAME} · Recipes` }} />
      <Stack.Screen name="MealPlannerSettings" component={MealPlannerSettingsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Grocery List Sections' }} />
      <Stack.Screen name="AddMeal" component={AddMealScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: '' }} />

      {/* Trips (purple) */}
      <Stack.Screen name="Trips" component={TripsScreen} options={featureCalendarHome('Trips')} />
      <Stack.Screen name="TripForm" component={TripFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Trip' }} />
      {/* TripDetail re-declares its header in a layout effect (the status badge
          + pencil title); the background must already match there, or the push
          transition flashes a differently-coloured bar first. */}
      <Stack.Screen name="TripDetail" component={TripDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Trip' }} />
      <Stack.Screen name="TripItemForm" component={TripItemFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Booking' }} />
      <Stack.Screen name="TripSettle" component={TripSettleScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Settle Up' }} />
      <Stack.Screen name="TripAssistant" component={TripAssistantScreen} options={assistantScreen(`${ASSISTANT_NAME} · Trips`)} />

      {/* Profile (app primary) */}
      <Stack.Screen name="ProfileHome" component={ProfileScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Profile' }} />
      <Stack.Screen name="Account" component={AccountScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Account' }} />
      <Stack.Screen name="Reminders" component={RemindersScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Reminders' }} />
      <Stack.Screen name="PrivacyData" component={PrivacyDataScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Privacy & Security' }} />
      <Stack.Screen name="LinkDevice" component={LinkDeviceScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Link device' }} />
      <Stack.Screen name="GuardianRecovery" component={GuardianRecoveryScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Guardian recovery' }} />
      <Stack.Screen name="RecoveryCode" component={RecoveryCodeScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Recovery code' }} />
      <Stack.Screen name="Contacts" component={ContactsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Contacts' }} />
      <Stack.Screen name="ContactDetail" component={ContactDetailScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Contact' }} />
      <Stack.Screen name="ContactForm" component={ContactFormScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Contact' }} />
      <Stack.Screen name="ContactImport" component={ContactImportScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Import Contacts' }} />
      <Stack.Screen name="Household" component={HouseholdScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Household' }} />
      <Stack.Screen name="HelpFeedback" component={HelpFeedbackScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Help & Feedback' }} />
      {/* Billing: the credits summary card lives inline on ProfileHome; these
          are its drill-ins — the Credits screen and the top-up sheet the
          AI-surface nudges open as a modal. */}
      {/* The feature-calendar add-ons store. Never titled "App Store" (5.2.5). */}
      <Stack.Screen name="AddOns" component={AddOnsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Add-ons' }} />
      <Stack.Screen name="Discover" component={DiscoverScreen} options={modalTask('Discover')} />
      {/* The widget promo: learn about / add the Home Screen widget and dismiss —
          a self-contained task, so a modal from both the nudge and Profile. */}
      <Stack.Screen name="WidgetPromo" component={WidgetPromoScreen} options={modalTask('Home Screen Widget')} />
      <Stack.Screen name="Credits" component={CreditsScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'AI credits' }} />
      <Stack.Screen name="CreditHistory" component={CreditHistoryScreen} options={{ ...hdr(colors.background), headerShadowVisible: false, title: 'Credit history' }} />
      {/* A modal: buy a pack and dismiss, back to whatever nudged the top-up. */}
      <Stack.Screen name="BuyCredits" component={BuyCreditsSheet} options={modalTask('Buy credits')} />
      </Stack.Navigator>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
});
