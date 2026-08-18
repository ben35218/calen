// Calen home-screen widget target (WidgetKit). Generated into the Xcode
// project by @bacons/apple-targets on `expo prebuild` — the /ios directory
// stays disposable (CNG); this folder is the target's source of truth.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'CalenWidget',
  displayName: 'Calen',
  // Appended to the app's bundle id → app.householdcalendar.mobile.widget
  bundleIdentifier: '.widget',
  // iOS 17+: containerBackground API; comfortably below current-2 in 2026.
  deploymentTarget: '17.0',
  colors: {
    // App primary — used for the date header accent.
    $accent: '#4F9DF5',
  },
  // Read access to the snapshot the app writes (modules/calen-widget). Also
  // mirrored from ios.entitlements in app.json; explicit here so the target
  // stands alone.
  entitlements: {
    'com.apple.security.application-groups': ['group.app.householdcalendar.mobile'],
  },
};
