// Pin every embedded Apple target (the CalenWidget extension) to the SAME
// device family as the app. @bacons/apple-targets hard-codes
// TARGETED_DEVICE_FAMILY = "1,2" for widget targets, but App Store processing
// requires an extension's UIDeviceFamily to be a subset of its containing
// app's — with `ios.supportsTablet: false` the app is "1" and the mismatch is
// rejected SILENTLY (email only; the build never appears in App Store Connect).
//
// apple-targets creates its targets inside its own Xcode mod
// (`ios.xcodeProjectBeta2`, a @bacons/xcode project model), which runs after
// the standard `ios.xcodeProject` mod — so this plugin hooks the same mod.
// Expo runs actions on one mod in REVERSE registration order (the last plugin
// added runs first and hands its result to the earlier ones), and apple-targets
// installs the mod's provider last, refusing any later registration — so this
// plugin is listed BEFORE "@bacons/apple-targets" in app.json `plugins`, which
// is what makes it run AFTER the widget target exists.
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');

function deviceFamilyFor(config) {
  if (config.ios?.isTabletOnly) return '2';
  return config.ios?.supportsTablet ? '1,2' : '1';
}

module.exports = function withTargetDeviceFamily(config) {
  const appBundleId = config.ios?.bundleIdentifier;
  if (!appBundleId) return config;
  return withXcodeProjectBeta(config, (config) => {
    const family = deviceFamilyFor(config);
    const project = config.modResults;
    let patched = 0;
    for (const target of project.rootObject.props.targets) {
      const list = target.props.buildConfigurationList;
      if (!list) continue;
      for (const bc of list.props.buildConfigurations) {
        const settings = bc.props.buildSettings || {};
        const id = String(settings.PRODUCT_BUNDLE_IDENTIFIER || '');
        // Embedded targets extend the app's bundle id (".widget", ".clip", …).
        if (!id.startsWith(appBundleId + '.')) continue;
        if (settings.TARGETED_DEVICE_FAMILY !== family) {
          settings.TARGETED_DEVICE_FAMILY = family;
          patched++;
        }
      }
    }
    if (patched) {
      console.log(`[withTargetDeviceFamily] TARGETED_DEVICE_FAMILY=${family} on ${patched} embedded-target build configuration(s)`);
    }
    return config;
  });
};
