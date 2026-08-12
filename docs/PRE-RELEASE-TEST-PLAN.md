# Calen — release test plan

What to check in the app before a release goes out, written to be run by a
person, not a programmer. Work top to bottom. Each line is one check:
**what to do**, then after the arrow, **what you should see**.

- A case marked **⛔** must pass before the release ships — the portal's
  sign-off button stays locked until every one of them has passed somewhere.
- If something looks wrong but isn't covered by a case, that's still a bug —
  note it on the nearest case.

**This file is the master copy.** The admin portal (Quality → Test cases) is
where you *run* it: import this file there, open a Release for the build, start
a run per phone, and tap Pass/Fail as you go. To change a case, edit it here
and re-import — deleted cases are retired in the portal, not lost. The deeper
engineering checks (server audits, App Store paperwork, deploy steps) live in
[ENGINEERING-TEST-PLAN.md](ENGINEERING-TEST-PLAN.md) and are not imported.

**Before you start, you'll want:**

- Your main iPhone with the new build installed from TestFlight.
- A second iPhone signed into a **helper account that's in your household**
  (cases that need it say *"needs your second phone"*).
- A **friend account** that is NOT in your household, for sharing tests.
- An email address that has **no Calen account**, for invite tests.
- A **sandbox (test) Apple ID** for purchase tests, so nothing real is charged.
- Notifications allowed on your main phone.

---

## 1. First-time setup

Spec: [onboarding.md](../specs/features/onboarding.md)

- [ ] **START-01** — Delete the app, reinstall it, and create a brand-new account. → The welcome screen (naming Meals, Home & chores, Trips, Contacts, the assistant, and the privacy promise) appears exactly once, before anything asks you to pay.
- [ ] **START-02** — Tap Get started, then force-quit and reopen the app. → The welcome screen does not appear again.
- [ ] **START-03** — Right after signing up, the app shows your one-time recovery code. Write it down. → The screen warns the code can never be shown again, and lets you copy it.
- [ ] **START-04** — Force-quit the app *while the recovery code is on screen*, then reopen and unlock. → You are not locked out, and the app offers a freshly made code to save (the old unsaved one is dead). **⛔**
- [ ] **START-05** — Open the AI credits screen on the new account. → It starts with the free welcome credits (about 100).
- [ ] **START-06** — After the welcome screen, a new account that hasn't paid sees the purchase screen. → One big buy button with the price on it, small links for Restore purchase / Terms / Privacy, and a quiet Sign out link. Nothing else looks like a button.
- [ ] **START-07** — Buy the unlock with the test Apple ID. → The purchase completes and the app opens within a minute; if it takes longer, the screen reassures you rather than showing an error. **⛔**

## 2. Signing in and out

Spec: [auth-identity.md](../specs/features/auth-identity.md)

- [ ] **SIGNIN-01** — Sign out (Profile, bottom of the page), then sign back in with your password. → All your data is back and readable. **⛔**
- [ ] **SIGNIN-02** — Try signing in with a wrong password. → A clear error; the app doesn't crash or lock you out on the first few tries.
- [ ] **SIGNIN-03** — Close and reopen the app while signed in. → Face ID (or Touch ID) offers to unlock; declining leaves the app usable but showing a red "!" on your avatar until you unlock.
- [ ] **SIGNIN-04** — On the sign-in screen, tap the passkey button *without typing your email*. → The phone's account picker appears and one Face ID signs you in.
- [ ] **SIGNIN-05** — Use "Forgot password?" with your email already typed on the sign-in form. → The reset screen opens with your email pre-filled, and the 6-digit code arrives by email.
- [ ] **SIGNIN-06** — Reset your password from your own phone (one you've signed in on before). → The reset applies immediately, with no waiting period.
- [ ] **SIGNIN-07** — Reset your password from a phone the account has never used (your second phone, signed out). → The reset is *held* for a waiting period, your other devices are loudly warned, and you can cancel it from one of them. **⛔**
- [ ] **SIGNIN-08** — After any password reset, note what the app tells you about your data. → It explains your data is still locked and offers real ways back in (passkey, recovery code); it never suggests "just sign in again" as the fix. **⛔**
- [ ] **SIGNIN-09** — Sign out of your account, then sign in as the helper account on the *same* phone. → Nothing from your account is visible — no calendar names, colours, events, or contacts leak across. **⛔**
- [ ] **SIGNIN-10** — Sign out and back in as yourself, in one sitting, without force-quitting. → The app never hangs on the splash screen.
- [ ] **SIGNIN-11** — In Profile → Privacy & security → Devices, look at the list after signing in twice on the same phone. → Each physical device appears once (no duplicate rows for repeat sign-ins), and removing a device signs it out.
- [ ] **SIGNIN-12** — Sign in on a phone your account has never seen. → Your other devices get a "new device" alert.

## 3. Your account

Spec: [auth-identity.md](../specs/features/auth-identity.md)

- [ ] **ACCT-01** — Edit your first and last name. → The keyboard capitalizes names properly and iOS suggests your own name above the keyboard.
- [ ] **ACCT-02** — Change your email (tap the email row). → With Face ID set up, a face scan replaces retyping your password; the new address works for your next sign-in.
- [ ] **ACCT-03** — Change your password (Privacy & security), sign out, sign in with the NEW password. → Everything still opens and reads normally. **⛔**
- [ ] **ACCT-04** — Add your phone number, then have the helper account invite that number to something. → The invite finds your account (the number matching works).
- [ ] **ACCT-05** — With the home-address field empty, tap "Use my current location". → It fills the field with your address for review; nothing is saved until you save.
- [ ] **ACCT-06** — Change your home address and then open the Weather screen. → Weather reflects the new address without restarting the app.
- [ ] **ACCT-07** — Open Profile → Reminders and change the daily reminder time. → Day-based reminders (chores, birthdays) move to the new time.
- [ ] **ACCT-08** — Start deleting your account (don't finish) while the AI monthly plan is active. → It first warns that deleting does NOT cancel the Apple subscription, and the final confirm tells you how many unused credits you'd forfeit. **⛔**

## 4. Keeping your data safe

Spec: [crypto-e2ee.md](../specs/platform/crypto-e2ee.md)

- [ ] **SAFE-01** — Try to screenshot the app with screen security on (the default). → The screenshot comes out blank/blocked, and the app switcher shows a cover instead of your calendar.
- [ ] **SAFE-02** — Turn on App Lock with a 1-minute delay, background the app for 2 minutes, return. → Face ID is required to get back in; returning within a minute is not.
- [ ] **SAFE-03** — On a fresh phone (or after sign-out), sign in and unlock using your **recovery code** instead of Face ID. → Your data opens normally. **⛔**
- [ ] **SAFE-04** — Replace your recovery code from Privacy & security. → The old code stops working; the new one is shown once.
- [ ] **SAFE-05** — On the Household screen, compare safety numbers with your helper account and mark them verified (needs your second phone). → Both phones show the same code; after verifying, the member shows as verified.
- [ ] **SAFE-06** — Set up a household guardian with a 4-digit PIN. → Weak PINs like 0000 or 1234 are rejected, and the screen says plainly to pick someone you'd trust with your data.
- [ ] **SAFE-07** — Recover using the guardian: from a locked device, request recovery; approve from the guardian's phone; enter the PIN (needs your second phone). → Your data comes back, and the app then prompts you to set a new password/recovery code. **⛔**
- [ ] **SAFE-08** — During guardian recovery, enter the WRONG pin once. → It fails without killing the request; the right PIN still works after.
- [ ] **SAFE-09** — Link a new device by QR code from Privacy & security → Devices. → The second device gets your data without typing a password, and the household is alerted about the new device.

## 5. Your household

Spec: [households-sharing.md](../specs/features/households-sharing.md)

- [ ] **HOME-01** — Invite the no-account email address to your household. → Your own mail app opens with the invite written for you (if you have 2+ mail apps, a chooser asks which — and remembers).
- [ ] **HOME-02** — Change the remembered mail app from Profile → Account → Email app. → The choice sticks, including "Ask each time".
- [ ] **HOME-03** — Invite an address that already HAS a Calen account. → No email composer opens; the app says they've been notified in-app, and their phone gets a push.
- [ ] **HOME-04** — Type a few letters of a saved contact into the invite field. → Matching contacts are suggested; tapping one invites them without retyping.
- [ ] **HOME-05** — Accept an invite on the helper account, then approve the join from your phone (needs your second phone). → You're shown a safety code to compare — the joiner sees the SAME code on their own screen — and only after you approve are they actually in. **⛔**
- [ ] **HOME-06** — Before joining, put a few events on the helper account's own calendar; then join. → Their old events come along into the shared household, and both phones eventually show the same calendar. **⛔**
- [ ] **HOME-07** — Decline a join request. → The invite disappears from the inviter's screen and shows as declined for the person who asked.
- [ ] **HOME-08** — Remove the helper from the household (needs your second phone). → They get told, they land in their own fresh space, and the shared calendar is NO longer readable on their phone. **⛔**
- [ ] **HOME-09** — As the helper, leave the household. → The shared data stays with you; the leaver starts fresh; nothing breaks on either phone.
- [ ] **HOME-10** — As a household of one, look for a "leave household" button. → There isn't one (there's nothing to leave).
- [ ] **HOME-11** — Watch the red badge on your calendar avatar through an invite/approval. → The count matches what's actually waiting in the Invitations inbox, and clears when handled.
- [ ] **HOME-12** — Check the Household screen's encryption badge on a new account. → It reads "Finishing encryption setup…" only briefly, then "End-to-end encrypted".

## 6. The calendar

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **CAL-01** — Tap + on the calendar. → The new-event form opens with the cursor already in Title and the keyboard up.
- [ ] **CAL-02** — Create an event filling everything: notes, a place, a web link, an alert, travel time. Reopen it. → Every field you set is visible on the event's page.
- [ ] **CAL-03** — On a 9–10am event, change the start to 8am. → The end follows to 9am (the hour length is kept). Changing the END changes the length instead. **⛔**
- [ ] **CAL-04** — Make an event at 11:05 pm. Open it and save it, five times in a row. → The date never creeps forward a day, and it never turns into a multi-day event. **⛔**
- [ ] **CAL-05** — Make an all-day event on the 15th. → It shows on the 15th, full stop — including after a restart.
- [ ] **CAL-06** — Make an event from 11 pm to 1 am. → It correctly shows on both days.
- [ ] **CAL-07** — Scroll the month view far into the future and far into the past, then tap Today. → Scrolling is smooth, months keep loading, and Today snaps you back.
- [ ] **CAL-08** — Open the app on the month view and just wait, hands off, 30 seconds. → The view stays put on today — it must not drift backwards through past months on its own. **⛔**
- [ ] **CAL-09** — Tap the month name in the header and jump to a month two years away. → The jump is instant and lands on that month.
- [ ] **CAL-10** — Flip between the view styles (the dots view, bars view, full view, list view). → Switching is instant with no blank flash, and your choice sticks after a restart.
- [ ] **CAL-11** — In list view, tap a day, then tap +. → The new event starts on the day you tapped, not today.
- [ ] **CAL-12** — Open a day, and try its three looks (one day, two days, list). → Timed events sit at their hours, all-day items sit in the top lane, and today shows the "now" line.
- [ ] **CAL-13** — Search for an event by a word in its title. → It's found; opening it works.
- [ ] **CAL-14** — Delete a one-off event. → One confirm, then it's gone from every view.
- [ ] **CAL-15** — Print a month (Calendars → Print). → The preview/PDF shows your visible calendars, long titles wrap to two lines, and the 24-hour clock switch works.

## 7. Repeating events

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **REPEAT-01** — Create a weekly event (say, every Thursday). → It appears on every Thursday, and its page says "Repeats weekly".
- [ ] **REPEAT-02** — Tap the third week's copy. → The page shows THAT date, not the first week's.
- [ ] **REPEAT-03** — Delete just one week's copy ("This Event Only"). → Only that week disappears; the rest stay. **⛔**
- [ ] **REPEAT-04** — Delete "All Future Events" from a middle week. → Earlier weeks stay; that week and later are gone.
- [ ] **REPEAT-05** — Edit one week's copy (change the title) and save "This Event Only". → After saving, the page in front of you shows the EDITED event, and other weeks are unchanged. **⛔**
- [ ] **REPEAT-06** — Move one Thursday to Friday and save "For Future Events". → From that week on it repeats on Friday; earlier weeks stay on Thursday.
- [ ] **REPEAT-07** — Change the repeat rule itself (weekly → monthly), from the FIRST week's copy. → The app still asks how to apply the change — it never saves a rule change silently. **⛔**
- [ ] **REPEAT-08** — Delete two individual weeks, then rename the series. → The two deleted weeks stay deleted. **⛔**
- [ ] **REPEAT-09** — Set an "End Repeat" date, then reopen the form a few times. → The end date reads the same every time (it must not slip a day per visit).
- [ ] **REPEAT-10** — Start an edit, get the "how should this apply?" question, and Cancel. → You're back on the form with your edits still there.

## 8. Alerts & reminders

Spec: [notifications.md](../specs/features/notifications.md)

- [ ] **ALERT-01** — Set an alert on an event 10 minutes from now and leave the app open. → The notification fires on time. **⛔**
- [ ] **ALERT-02** — Same, but close the app completely. → It still fires.
- [ ] **ALERT-03** — Add a second alert to an event. → The second picker won't offer the time the first already uses; the event page shows both.
- [ ] **ALERT-04** — Set two alerts, then clear the FIRST one. → The second moves up into its place (it doesn't vanish or get stuck).
- [ ] **ALERT-05** — On an event with travel time, set a custom alert of "2 hours before". Reopen it. → It still says 2 hours before — not reworded into "before leaving" math. **⛔**
- [ ] **ALERT-06** — In the custom alert sheet, tap Minutes → Hours → Days. → Each unit starts at a sensible default (not 23 hours), and Minutes goes up to 180.
- [ ] **ALERT-07** — Flip an event's "All day" switch on, then off. → It turns on AND off cleanly (no springing back), and existing alerts become sensible whole-day ones when on. **⛔**
- [ ] **ALERT-08** — Give an all-day event a "1 day before" alert. → It fires at your daily reminder hour (9 am unless you changed it), local time. **⛔**
- [ ] **ALERT-09** — Have at least one REPEATING chore active, plus an event alert due soon. → Both remind — a repeating chore must never silently kill the app's reminders. **⛔**
- [ ] **ALERT-10** — Read the notification wording for a travel-time event vs a plain one. → "Leave in 20 minutes" vs "Starts in 20 minutes" — the two aren't confused.
- [ ] **ALERT-11** — Tap a notification for a household event invite. → It opens the Invitations inbox; a reply notification opens the event itself.
- [ ] **ALERT-12** — Turn "Allow reminders" off, then on (Profile → Reminders). → Off cancels everything pending; on brings them back.

## 9. Inviting people to events

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **INVITE-01** — Invite the helper (a household member) to an event (needs your second phone). → They instantly get a push and an inbox card with Accept/Decline; their answer shows on the event with a ✓ or ✕. **⛔**
- [ ] **INVITE-02** — Have them change their answer. → The event shows the newest answer.
- [ ] **INVITE-03** — Change the event's time. → Invitees are re-notified, and their earlier answers are kept, not reset.
- [ ] **INVITE-04** — Invite the no-account email to an event. → Your mail app opens with the invite and a link that shows the event and can add it to Apple Calendar.
- [ ] **INVITE-05** — Use the paper-plane "remind" button on a pending invite. → The email composer opens again for a nudge.
- [ ] **INVITE-06** — Turn OFF "Guests can see who's invited", then open the invite as a guest. → The guest list is genuinely hidden from them. **⛔**
- [ ] **INVITE-07** — Accept an event invitation from another household (friend account). → A copy lands on your calendar, and its delete button reads "Leave event".
- [ ] **INVITE-08** — Try to respond to an invite while the app is locked (before Face ID unlock). → A clear "unlock to respond" message — not a silent failure.
- [ ] **INVITE-09** — On the invitees screen with no outside guests, look for the guest-list switch. → It isn't shown (it only appears once someone outside is invited).
- [ ] **INVITE-10** — Cancel/delete an invited event. → It drops out of the invitee's inbox.

## 10. Sharing calendars

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **SHARE-01** — Make a custom calendar, pick a colour, add events to it. → It appears in the calendar list; its events wear its colour.
- [ ] **SHARE-02** — Share it with the friend account with full access. → After you next open the app, the friend can see AND add events, and their additions appear for you. **⛔**
- [ ] **SHARE-03** — Share with the friend as view-only. → They can read it but any edit attempt is clearly refused — no mystery errors.
- [ ] **SHARE-04** — Sign out and back in as yourself. → Your shared calendar's events are all still there. **⛔**
- [ ] **SHARE-05** — On the friend's side, right after accepting a fresh share. → A gentle "events appear when the owner next opens Calen" note — then they do.
- [ ] **SHARE-06** — Un-share (remove the friend). → Their access ends.
- [ ] **SHARE-07** — Recolour a calendar, reorder the list, hide one; sign out and back in. → All those choices survive. **⛔**
- [ ] **SHARE-08** — Subscribe to a public calendar link (any webcal/ICS link). → Its events show; a bad link fails with a readable message.
- [ ] **SHARE-09** — Check the auto-added holidays calendar. → Your country's holidays show, and your home province/state was pre-selected if it could be.
- [ ] **SHARE-10** — Turn holiday alerts on from the holidays screen. → The setting is shared across all your holiday calendars, and it survives a sign-out.

## 11. Free viewer mode (someone who hasn't paid)

Spec: [billing-plans.md](../specs/features/billing-plans.md)

- [ ] **VIEW-01** — Share a calendar to a brand-new email; register that account fresh (no purchase). → They land in a read-only viewer showing your calendar — not a dead "nothing shared with you" screen and not the paywall. **⛔**
- [ ] **VIEW-02** — Browse the viewer. → A month grid + list toggle of shared events only; nothing paid is reachable; a bottom banner offers the upgrade.
- [ ] **VIEW-03** — Print from the viewer. → Only the shared calendars appear in the printout.
- [ ] **VIEW-04** — Reset the viewer account's password, then sign back in. → The viewer gets a plain-language "locked" screen with real options (passkey / recovery code / ask the owner), never a paywall as the only way out. **⛔**
- [ ] **VIEW-05** — Use "Request access" on that screen, then approve it from the owner's phone. → The confirmation survives sign-out, and once the owner approves, the viewer lands back on the calendar. **⛔**
- [ ] **VIEW-06** — Buy the unlock from the viewer's banner (test Apple ID). → The full app opens.
- [ ] **VIEW-07** — On the locked viewer screen, find sign out. → It's there, at the bottom.
- [ ] **VIEW-08** — As a locked user with NO shares at all. → The plain paywall, not the viewer.

## 12. Buying things

Spec: [billing-plans.md](../specs/features/billing-plans.md)

- [ ] **BUY-01** — Buy a credit pack (test Apple ID). → The balance rises by the right amount exactly once, and the purchase shows in History. **⛔**
- [ ] **BUY-02** — Read the "What things cost" list. → Plain labels, prices low-to-high, chat says "varies with length", phone calls per-minute at the bottom.
- [ ] **BUY-03** — Have a long chat with the assistant, then check what it charged. → A handful of credits per reply, shown under the reply — never 50+ for one answer. **⛔**
- [ ] **BUY-04** — Spend the balance to zero (or use a test account at zero) and try an AI action. → A friendly "out of credits" screen with a Buy button — not a crash or a spinner.
- [ ] **BUY-05** — Subscribe to the monthly AI plan (test Apple ID). → The monthly credits land, and the plan card says when it renews. **⛔**
- [ ] **BUY-06** — Cancel the plan in Apple's sheet (Manage subscription) and return. → The card flips to "Cancelled — benefits until ⟨date⟩, credits yours forever" without restarting the app.
- [ ] **BUY-07** — Open the Add-ons store. → It's titled "Add-ons"; the free ones (Occasions, Chores) are listed first with a Get button; Restore and Terms/Privacy are present.
- [ ] **BUY-08** — Claim a free add-on. → It unlocks immediately, for the whole household (check the helper's phone too).
- [ ] **BUY-09** — Buy a paid add-on (test Apple ID). → The calendar's lane fills in right away — no waiting for a restart — and the helper's phone gets it too. **⛔**
- [ ] **BUY-10** — As the helper who bought an add-on, leave the household. → They still own what they personally bought. **⛔**
- [ ] **BUY-11** — Open a locked feature (e.g., Trips before buying it). → A clean "add this feature" screen — including if you arrive via the assistant or a link.
- [ ] **BUY-12** — Delete an add-on's calendar, then look at its card in the store. → The card offers a restore (+) instead of pretending all is well, and restoring brings the calendar back.

## 13. Meals

Spec: [kitchen.md](../specs/features/kitchen.md)

- [ ] **MEAL-01** — Add a recipe by hand with ingredients and steps. → It saves and reads back correctly.
- [ ] **MEAL-02** — Capture a recipe from a photo, and one from a web link. → Both come in reasonably; each costs the listed credit price.
- [ ] **MEAL-03** — Plan a recipe onto a day. → It shows on the calendar's meals lane.
- [ ] **MEAL-04** — Open the grocery list for that week. → Ingredients from the planned meals are combined sensibly.
- [ ] **MEAL-05** — Check off grocery items, then look on the helper's phone (needs your second phone). → The checkmarks are shared.
- [ ] **MEAL-06** — Move a planned meal to another week. → The grocery lists of both weeks update; checked items you already had stay checked.
- [ ] **MEAL-07** — Cook with cooking mode. → Steps advance, timers run, and the screen stays awake through a step.

## 14. Chores & home care

Spec: [maintenance.md](../specs/features/maintenance.md)

- [ ] **CHORE-01** — Add a weekly chore assigned to the helper. → The assignee list offers household members only, you first.
- [ ] **CHORE-02** — Look at the month view with a repeating chore. → It appears on EVERY due day, not just one. **⛔**
- [ ] **CHORE-03** — Change a chore's repeat rule. → The next-due date visibly reseeds to match the new rule before you save.
- [ ] **CHORE-04** — From a calendar day, edit just that day's chore ("This Chore Only"). → Only that day changes; and moving just that day's date offers the this-day/future choice.
- [ ] **CHORE-05** — Skip a few days, then rename the chore. → The skipped days stay skipped. **⛔**
- [ ] **CHORE-06** — End a chore series ("All Future"), then find it under "Ended chores" and resume it. → Resume brings back future days only; the past stays as it looked.
- [ ] **CHORE-07** — Add a home item (an appliance) and upload its manual PDF. → The upload is free; the AI "find manual" / "extract tasks" actions are the ones that cost credits.
- [ ] **CHORE-08** — Complete a maintenance task. → The next due date advances and the completion is in its history.
- [ ] **CHORE-09** — Add a task from the templates library. → It lands with a sensible schedule; adding the same template twice is allowed.
- [ ] **CHORE-10** — Log a car's odometer readings against a mileage-based task. → The task's next-due mileage updates.

## 15. Trips

Spec: [trips.md](../specs/features/trips.md)

- [ ] **TRIP-01** — Create a trip with dates. → It spans those days on the calendar as a bar.
- [ ] **TRIP-02** — Add a booking by pasting a confirmation email. → The details come in; fix-ups save.
- [ ] **TRIP-03** — Change the trip's start date. → The end moves with it, keeping the trip the same length.
- [ ] **TRIP-04** — Share the trip with the friend account. → They can see it; a no-account invitee gets a composed email instead.
- [ ] **TRIP-05** — Enter a few costs split across the two households, then check the settle-up screen with a calculator. → Who-owes-whom is right. **⛔**
- [ ] **TRIP-06** — Attach a booking PDF to a trip item. → It opens back up later.
- [ ] **TRIP-07** — While a booked trip spans today, open Weather. → A destination forecast card shows under the home weather.

## 16. Contacts

Spec: [contacts.md](../specs/features/contacts.md)

- [ ] **CONTACT-01** — Browse the three tabs (Family / Friends / Professionals) with the A–Z rail and search. → Sorting, sticky letters, and search (including by phone digits) all behave.
- [ ] **CONTACT-02** — Add a person with first + last name, two phones, an email, an address. → The card shows everything; labels look right.
- [ ] **CONTACT-03** — Import from your phone's contacts. → NOTHING imports until you pick people and confirm — granting access alone adds no one. **⛔**
- [ ] **CONTACT-04** — If iOS gave the app limited contact access, use "Choose more contacts". → Apple's picker reopens in-app and the list refreshes.
- [ ] **CONTACT-05** — Re-select someone already imported. → An "Imported" badge and a duplicate warning — but it lets you proceed if you insist.
- [ ] **CONTACT-06** — Import a contact, then invite them to the household by their number. → The imported number matches their account (no silent formatting mismatch). **⛔**
- [ ] **CONTACT-07** — Link two contacts as spouses. → The other card automatically shows the mirrored relationship; renaming one updates the other's link.
- [ ] **CONTACT-08** — Delete a linked contact. → No other card is left pointing at the deleted person.
- [ ] **CONTACT-09** — Use "Add to iPhone Contacts" from a card. → It lands in the phone's address book; denying permission just shows a note.
- [ ] **CONTACT-10** — Share a contact. → The share sheet sends a contact file that imports cleanly into Apple Contacts.

## 17. Birthdays, occasions & cards

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **OCC-01** — Give a contact a birthday and an anniversary. → Both appear on the calendar as little icons, and the month view repaints right away.
- [ ] **OCC-02** — Open the Occasions list. → It reads as a timeline around today: recently passed (dimmed), Today, the next ~2 months highlighted, the far future folded away.
- [ ] **OCC-03** — Turn off "Show on Occasions calendar" for one contact. → Their dates vanish from calendar, list, and reminders alike.
- [ ] **OCC-04** — Set occasion alert times, sign out, sign in. → The settings survive. **⛔**
- [ ] **OCC-05** — Schedule an e-card: pick a design, edit the greeting lines, add 2–3 photos. → Photos pick in one visit; saving returns you immediately (photos finish uploading in the background).
- [ ] **OCC-06** — Receive the sent card (send one to your own Gmail and Apple Mail). → Photos show inline at card size, the subject reads like "Happy Birthday, Sam! — from Ben" (no odd punctuation), and no "OBJ" boxes appear. **⛔**
- [ ] **OCC-07** — After a card sends. → The occasion row shows "Sent", and the card does not re-send next year on its own.
- [ ] **OCC-08** — Reopen a scheduled card and cancel it. → It won't send.

## 18. The Calen assistant

Spec: [ai-assistant.md](../specs/features/ai-assistant.md)

- [ ] **AI-01** — Ask the calendar assistant a question. → The reply streams in, short and to the point, with a few tappable follow-up chips.
- [ ] **AI-02** — Tap Stop mid-reply. → It stops and keeps what was written so far.
- [ ] **AI-03** — Close the chat, come back the next day, open history (the clock icon). → Past conversations from all the assistants are listed and resumable, searchable by any word in them.
- [ ] **AI-04** — Dictate into a half-typed message with the mic. → Your words are inserted where the cursor was — typing isn't erased — and nothing sends until you tap send.
- [ ] **AI-05** — Ask it to plan an event at a named restaurant. → The draft carries the place's name+address in Location and its phone in Phone (not buried in notes), and the form highlights what the assistant filled. **⛔**
- [ ] **AI-06** — Ask it to change or delete an event. → It never claims it's done — it gives you a tap-to-confirm chip, and only your tap makes the change. **⛔**
- [ ] **AI-07** — Ask "when am I free next week?". → A sensible free/busy answer; all-day notes mentioned but not treated as busy.
- [ ] **AI-08** — Tap a place name in a reply. → Google Maps (or an in-app map view) opens on that place; closing returns you to the chat where you left it.
- [ ] **AI-09** — Turn AI OFF in Privacy & security. → Every assistant, scan, and AI import is unavailable until you turn it back on. **⛔**
- [ ] **AI-10** — Turn "Use personal & contact info" OFF, then chat. → The assistant can still plan around your free/busy but cannot see or repeat event titles or contact details. **⛔**
- [ ] **AI-11** — Open the assistant's "what I can see" panel. → It honestly matches your toggles (and mentions your general area, never your street address).
- [ ] **AI-12** — Check under each reply. → The credit cost of that reply is shown.

## 19. Phone calls by Calen

Spec: [ai-assistant.md](../specs/features/ai-assistant.md)

- [ ] **CALL-01** — Open an event's Call to Cancel/Reschedule screen. → The per-minute credit price is shown BEFORE you place the call.
- [ ] **CALL-02** — Place a real call to a number you control. → The agent announces it's an AI assistant right away. **⛔**
- [ ] **CALL-03** — Check "Share my contact details if asked" before a call. → It's OFF by default; leaving it off, the agent gives your name only.
- [ ] **CALL-04** — After a confirmed cancellation. → The event dims with a strikethrough everywhere, and Dismiss clears the marking (delete is separate and yours to do).
- [ ] **CALL-05** — After a confirmed reschedule. → The event does NOT move by itself; you're offered "Update event time".
- [ ] **CALL-06** — On the call, say "please don't call this number again". → Future calls to that number are refused with a clear reason, and the call's outcome page says the request was honored. **⛔**
- [ ] **CALL-07** — Look for a transcript or recording afterward. → There is none — only the outcome summary, which names no personal details.
- [ ] **CALL-08** — Try to place a call with nearly no credits. → It refuses before dialing rather than cutting off mid-call.

## 20. Weather

Spec: [calendar.md](../specs/features/calendar.md)

- [ ] **WX-01** — Open Weather for the first time. → It asks for location once; denying it offers "use home address" instead of a dead screen.
- [ ] **WX-02** — Switch the source chip between My location / Home / another city. → Each works; the city picker only accepts a real picked suggestion.
- [ ] **WX-03** — Toggle the Weather calendar on. → The month view gets the 7-day strip; the day view gets the hourly rail; toggling off removes them.
- [ ] **WX-04** — With no home address set, choose Home. → A friendly card sends you to add the address, and coming back shows weather without an app restart.
- [ ] **WX-05** — Glance at rain amounts and icons. → Heavier rain shows more drops; amounts show in mm; the thunderstorm icon has its bolt.

## 21. Everyday quality

- [ ] **LOOK-01** — Use the app in dark mode and light mode. → Everything stays readable; no invisible text.
- [ ] **LOOK-02** — Set text size to the largest accessibility size. → Buttons stay reachable and labels don't clip on the key screens (paywall, event form, invite screens).
- [ ] **LOOK-03** — Turn on VoiceOver and create an event. → The core flow is navigable; buttons announce sensible names.
- [ ] **LOOK-04** — Put the phone in airplane mode and open the app. → The calendar and lists show your data from the device; actions that need internet fail with clear messages, not endless spinners. **⛔**
- [ ] **LOOK-05** — With both phones open on the calendar, add an event on one (needs your second phone). → It appears on the other within a few seconds, no refresh. **⛔**
- [ ] **LOOK-06** — Background the app for half an hour and return. → It comes back where you were; nothing typed is lost; App Lock applies if configured.
- [ ] **LOOK-07** — Deny each permission (camera, photos, contacts, location, mic, notifications) and try the feature anyway. → Each shows a helpful path to Settings — never a crash.
- [ ] **LOOK-08** — Use the app hard for 15 minutes — calendar, day view, chat, contacts, back and forth. → No crash, no growing sluggishness, no hot phone.
- [ ] **LOOK-09** — Rotate the phone. → The app stays portrait (no broken sideways layouts).
