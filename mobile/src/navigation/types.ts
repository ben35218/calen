import type { InvitationEventSnapshot, Item, ContactLabeledValue, ContactRelatedName, ProposedTask, Recipe, TravelMode } from '../api';
import type { RepeatRule } from '../lib/eventRepeat';
import type { AssistantId } from '../screens/chat/assistantTabs';

// The Meals screen's segmented panes; also usable as a KitchenHome route param
// to land on a specific pane.
export type KitchenPane = 'planner' | 'grocery';

// The decrypted event snapshot "Ask Calen" (event detail) hands the calendar
// assistant, so "cancel this appointment" resolves without a lookup.
export interface AssistantFocusEvent {
  _id: string;
  title: string;
  startDate?: string;
  allDay?: boolean;
  calendarType?: string;
  location?: string;
  phone?: string;
}

// The decrypted event content the viewer shell's agenda hands its read-only
// detail view (free viewer mode — see ViewerEventScreen).
export interface ViewerEventSnapshot {
  _id: string;
  title: string;
  startDate: string;
  endDate?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  calendarType?: string;
}

// A contact prefilled from device import (direct or AI-assisted), fed into
// ContactForm in review mode. All fields optional except type + name.
export interface ContactPrefill {
  type: 'family' | 'friend' | 'service';
  name: string;
  // Structured name from a device import (expo-contacts firstName/lastName);
  // when absent the form splits `name`.
  firstName?: string;
  lastName?: string;
  relationship?: string;
  businessName?: string;
  jobTitle?: string;
  company?: string;
  birthday?: string;
  address?: string;
  notes?: string;
  phone?: string;
  email?: string;
  // Multi-value fields from a device/AI import (fold in alongside the singles).
  phones?: ContactLabeledValue[];
  emails?: ContactLabeledValue[];
  addresses?: ContactLabeledValue[];
  dates?: ContactLabeledValue[];
  urls?: ContactLabeledValue[];
  relatedNames?: ContactRelatedName[];
  deviceContactId?: string;
}

// The single, flat route map for the whole app — the React-Navigation analogue
// of the web's one flat vue-router. Every screen is a sibling route, so any
// screen can navigate to any other (day view → detail, My Calendars → a feature
// flow, calendar avatar → profile), exactly like router.push(path) on web.
//
// Each feature navigator file re-exports its old `XStackParamList` name as an
// alias of this type, so existing screen imports keep resolving unchanged.
export type RootStackParamList = {
  // ----- Calendar -----
  // `fromAssistant` marks an instance pushed on top of the assistant by a nav
  // chip (see ChatScreen.openNavSuggestion) so the calendar shows a "‹ Calen"
  // return pill instead of the profile avatar — a plain navigate() would pop the
  // assistant off the stack (it sits below) and strand the live chat.
  CalendarHome: { fromAssistant?: boolean } | undefined;
  CalendarDay: { date: string };
  EventForm: { eventId?: string; date?: string; prefill?: Record<string, unknown> };
  // Read-only event detail (tapped from a calendar card). `date` is passed on to
  // the Edit form so it returns to the same day. Household-owned events only —
  // guest/collaborator copies still open read-only in EventForm.
  EventDetail: { eventId: string; date?: string };
  // Full-screen in-app preview of a decrypted attachment, rendered in a WebView
  // (images + PDFs). `uri` is the on-device decrypted file; `mimeType` feeds the
  // header Share action.
  AttachmentPreview: { uri: string; title?: string; mimeType?: string };
  // Full-screen in-app preview of a place Calen mentioned in chat (modal
  // WebView on the Google Maps place lookup). `query` is "Name, Area" from the
  // reply's place link; `title` is the tapped display text.
  PlacePreview: { query: string; title?: string };
  // Unified assistant view (Calendar / Chores / Task Plan swap in place). `initial`
  // picks which body opens; the switcher swaps the rest without navigating.
  // `focusEvent` scopes the calendar assistant to one event ("Ask Calen" on the
  // event detail screen) so cancel/reschedule requests need no lookup.
  Assistant: { initial?: AssistantId; focusEvent?: AssistantFocusEvent } | undefined;
  CalendarSearch: undefined;
  Calendars: undefined;
  // The "Add Calendar" chooser: pick what kind of calendar to add.
  AddCalendarMenu: undefined;
  // Create a custom calendar; `calendarId` switches the form to edit mode.
  // `holidayCountry` seeds the form as a new holiday calendar for that country.
  AddCalendar: { calendarId?: string; holidayCountry?: string } | undefined;
  // Subscribe to an external ICS/webcal calendar (paste URL → preview → save).
  SubscribeCalendar: undefined;
  // Pick a country to add its holiday calendar (Canadian Holidays, etc.).
  AddHolidayCalendar: undefined;
  CalendarColors: undefined;
  PrintCalendar: undefined;
  // Edit one country's holiday calendar (its national/regional/cultural toggles).
  Holidays: { calendarId: string };
  // Alert settings shared by every holiday calendar (offsets + time). The
  // `calendarId` is only the calendar it was opened from — it tints the screen;
  // the settings themselves are not per-calendar.
  HolidayAlerts: { calendarId?: string } | undefined;
  // The Occasions calendar home (route id stays `Birthdays` for add-on/deep-link
  // continuity; the screen and title are "Occasions"). `focus` (from tapping an
  // occasion on the calendar) scrolls the list to that occasion and highlights it.
  Birthdays: {
    focus?: {
      contactId: string;
      kind: 'birthday' | 'anniversary' | 'marriage' | 'death' | 'custom';
      month: number;
      day: number;
      label: string;
    };
  } | undefined;
  // Schedule (or edit) an e-card for one occasion. Context comes from the
  // occasion row; `ecardId` opens an already-scheduled card for edit/cancel.
  ECardForm: {
    contactId?: string;
    contactName?: string;
    kind: 'birthday' | 'anniversary' | 'marriage' | 'death' | 'custom';
    occasionLabel?: string;
    month: number;
    day: number;
    ecardId?: string;
  };
  // Calendar-level occasion alert settings (offsets + time).
  OccasionAlerts: undefined;
  Weather: undefined;
  WeatherLocationSearch: undefined;
  Invitations: undefined;
  // ----- Free viewer shell (ViewerNavigator) -----
  // The read-only shell a locked (no app unlock) user with shared-calendar
  // access gets instead of the paywall. `ViewerEvent` carries the decrypted
  // event snapshot straight from the agenda list (the viewer's replica already
  // holds it — no refetch), plus its calendar's display name/colour.
  ViewerHome: undefined;
  ViewerEvent: { event: ViewerEventSnapshot; calendarName: string; accent: string };
  // The shell's print sheet, seeded with the month the grid was showing
  // (absent = today's month).
  ViewerPrint: { year: number; month: number } | undefined;
  // The shell's way back in when the viewer's key no longer opens the shared
  // events (a forgotten-password reset re-wraps nothing): passkey, recovery
  // code, or re-key + ask each owner to restore access. See crypto-e2ee.md.
  ViewerUnlock: undefined;
  // The unlock paywall pushed as an upgrade route from the viewer shell (the
  // same screen the RootNavigator gate renders full-screen).
  UnlockPaywall: undefined;
  // Manage one event's invitees. `snapshot` is the decrypted event content the
  // invite emails/.ics are built from; no `eventId` = a new-event draft whose
  // invitees queue in lib/inviteeDraft until the event is saved.
  EventInvitees: { eventId?: string; snapshot: InvitationEventSnapshot };
  // The event form's travel-time settings (switch / starting location / manual
  // duration). Edits flow back to the form via lib/travelDraft.
  EventTravelTime: { enabled: boolean; fromAddress: string; mode: TravelMode; manualMinutes: number | null };
  // The event form's custom repeat rule (frequency / every N / weekday / month
  // patterns). Edits flow back to the form via lib/repeatDraft. `date` = the
  // event's start date, seeding pattern defaults.
  EventRepeat: { rule: RepeatRule; date: string };
  // The event's Location view. With `initial` (from the event form) the picked
  // location flows back via locationDraft; with `eventId` (e.g. Call to Cancel
  // needing a phone number) the checkmark saves straight onto the event.
  // `promptPhone` = arrived from the event view's Reschedule/Cancel card with no
  // business number yet, so the screen nudges the user to add one to enable calling.
  EventLocation: { eventId?: string; initial?: { location?: string; phone?: string; placeId?: string }; promptPhone?: boolean } | undefined;
  // A phone call Calen placed: live status, outcome, summary, and the
  // confirm-cancellation actions. `id` is the PhoneCall record id.
  Interaction: { id: string };
  // Event Action — set up a Calen call to cancel or reschedule this appointment
  // (pick the action, answer the fee question, propose reschedule windows).
  // Carries the decrypted event snapshot: under E2EE the server (and this
  // screen, without re-decrypting) can't read the stored row.
  EventAction: {
    eventId: string;
    event: { title: string; startDate: string; phone: string; allDay?: boolean; calendarType?: string };
    // Recurring event: the tapped occurrence's local Y-M-D. The call is scoped to
    // this instance (its outcome dims only that occurrence). Omitted / undefined
    // for a non-recurring event.
    occurrenceDate?: string;
  };

  // ----- Maintenance (item-centric) -----
  MaintenanceHome: undefined;
  // `date` = the occurrence the user tapped through from (yyyy-MM-dd), for a
  // repeating task. It scopes "this occurrence only" edits and deletes the same
  // way EventDetail/EventForm's `date` does; absent when opened from a list,
  // where the whole series is the subject.
  TaskDetail: { id: string; date?: string };
  TaskForm: { id?: string; itemId?: string; categoryId?: string; date?: string };
  // `mode: 'multi'` = bulk multi-select flow (→ TaskTemplateReview); default is
  // single tap-to-create. `categoryName` filters the list to one category when
  // browsing templates for a known item. `itemId` links the single-tap task to
  // that item and scopes the "in use" block to the item's property.
  TaskTemplates: { mode?: 'multi'; categoryName?: string; itemId?: string } | undefined;
  // Review step for the bulk flow: link each selected template (or a task Calen
  // staged in the AI plan chat) to an item — existing or auto-created — grouped
  // by category.
  TaskTemplateReview: { templateIds: string[] } | { proposedTasks: ProposedTask[] };
  ItemDetail: { id: string };
  ItemForm: { id?: string; prefill?: Partial<Item> };
  MaintenanceChat: { itemId: string; itemName?: string };

  // ----- Chores (separate flow) -----
  ChoresHome: undefined;
  // `date`: same occurrence-scoping contract as TaskDetail above.
  ChoreDetail: { id: string; date?: string };
  AddChore: undefined;
  ChoreForm: { id?: string; prefill?: Record<string, unknown>; date?: string };
  ChoreTemplates: undefined;

  // ----- Kitchen / meal planner -----
  // Three independent params; pass whichever the arrival actually means.
  // `pane`: which Meals pane to show. Say it explicitly — it is the ONLY thing
  // that selects a pane, so a `scrollToDate` never drags the user off the pane
  // the caller asked for.
  // `weekStart` (YYYY-MM-DD): a date within the shopping period to show, so the
  // view opens on that period rather than the current one.
  // `scrollToDate` (YYYY-MM-DD): a day for the Planner pane to scroll to and
  // highlight. It is consumed by `PlannerPane`, so it survives until that pane
  // is actually on screen — the calendar's grocery cart opens the Grocery pane
  // with all three, and the highlight is waiting when the user flips over to
  // the planner. Pass `weekStart` alongside it whenever the day may sit outside
  // the current period: the pane ignores (and leaves unconsumed) a scrollToDate
  // outside the period it is showing.
  KitchenHome: { scrollToDate?: string; pane?: KitchenPane; weekStart?: string } | undefined;
  // The recipe library (list/search/manage); reached from the Meals view's
  // Recipes button rather than a segmented pane.
  Recipes: undefined;
  // Shopping cadence + day configuration (the Meals view's schedule card).
  GrocerySchedule: undefined;
  RecipeDetail: { id: string };
  // `initial` pre-fills a new recipe for review/save (e.g. an AI-generated
  // suggestion) without persisting anything until the user taps save.
  // `scheduleDate` (YYYY-MM-DD): when the recipe originated from the planner's
  // "Add recipe" for a date, schedule it to that date on save and return to Meals.
  RecipeForm: { id?: string; initial?: Partial<Recipe>; scheduleDate?: string };
  // `variation` = the flavor kit being cooked (picked at Start Cooking when the
  // recipe has variations); cooking mode shows only that kit's steps/ingredients.
  CookingMode: { id: string; variation?: string };
  RecipeAssistant: { scheduleDate?: string } | undefined;
  MealPlannerSettings: undefined;
  AddMeal: { date: string };

  // ----- Trips -----
  Trips: undefined;
  TripForm: { id?: string };
  TripDetail: { id: string };
  TripItemForm: { tripId: string; itemId?: string; date?: string };
  TripSettle: { id: string };
  TripAssistant: { tripId: string; tripName?: string };

  // ----- Profile -----
  ProfileHome: undefined;
  // `promptField` deep-links from a Calen assistant "setup" chip: arrives with a
  // SetupCallout + highlighted field to fill ('homeAddress' when a request needed
  // the home area; 'mailApp' for invite delivery).
  Account: { promptField?: 'homeAddress' | 'mailApp' } | undefined;
  // The reminders hub — the master on/off toggle + the personal day-based alert
  // time (see features/notifications.md). `promptEnable` deep-links from a Calen
  // "setup" chip: shows a SetupCallout nudging the user to turn reminders on.
  Reminders: { promptEnable?: boolean } | undefined;
  // The dedicated Privacy & security screen. `focus` deep-links intent: 'unlock'
  // (locked-data prompt — auto-presents Face ID), 'recovery', or 'aiPersonalInfo'
  // (a Calen "setup" chip — SetupCallout on the "Use personal & contact info" toggle).
  PrivacyData: { focus?: 'unlock' | 'recovery' | 'aiPersonalInfo' } | undefined;
  // The recovery-code detail view — explains it + create/replace the code.
  RecoveryCode: undefined;
  // Signal-parity F4 — QR device linking. 'show' = the new (locked) device shows
  // its code; 'scan' = an existing (unlocked) device scans + hands over the keys.
  LinkDevice: { mode: 'show' | 'scan' };
  // Dual-control guardian recovery. 'setup' = arm/remove a guardian; 'recover' =
  // the locked user requests + finishes with their PIN; 'approve' = the guardian
  // hands over the PIN-locked key. See specs/features/guardian-recovery.md.
  GuardianRecovery: { mode?: 'setup' | 'recover' | 'approve' } | undefined;
  Contacts: undefined;
  ContactDetail: { id: string };
  ContactForm: {
    id?: string;
    isSelf?: boolean;
    type?: 'family' | 'friend' | 'service';
    // Open scrolled to a section (e.g. 'dates' from the Occasions list, 'phone'
    // from a Calen "setup" chip — SetupCallout + highlighted phone field, or
    // 'related' from the e-card recipients card to link another contact).
    focus?: 'dates' | 'phone' | 'related';
    // Review-mode import: a queue of prefilled contacts to step through. The
    // form saves the one at `queueIndex`, then advances to the next.
    prefills?: ContactPrefill[];
    queueIndex?: number;
    // True when the review queue came from an AI-assisted import: the AI already
    // pre-sorted, so the "Ask Calen" form-assist panel stays available. A direct
    // import passes false/omits it, hiding the panel (nothing to re-derive).
    aiReview?: boolean;
  };
  // `type` seeds the default classification of imported/added contacts from the
  // roster tab the user launched import from (Family / Friends / Professionals).
  ContactImport: { type?: 'family' | 'friend' | 'service' } | undefined;
  // `promptInvite` deep-links from a Calen "setup" chip when the user wants to
  // share/assign but has no household members — SetupCallout nudging them to
  // invite someone.
  Household: { promptInvite?: boolean } | undefined;
  // Help & feedback — submit a question, bug report, or idea (features/feedback.md).
  HelpFeedback: undefined;

  // ----- Billing (credits summary card is inlined on ProfileHome) -----
  // Prepaid AI credits: balance, pack store, history, usage + AI preferences.
  Credits: undefined;
  // The full purchases & grants ledger (the Credits History card's "See all").
  CreditHistory: undefined;
  // Focused top-up sheet the AI-surface nudges open (low balance / out).
  BuyCredits: { reason: 'low' | 'out' } | undefined;
  // The Add-ons store: one-time feature-calendar purchases (Meals, Maintenance,
  // Trips + bundle). `focus` highlights one add-on's card.
  AddOns: { focus?: 'recipes' | 'maintenance' | 'trips' | 'birthdays' | 'chores' } | undefined;
};
