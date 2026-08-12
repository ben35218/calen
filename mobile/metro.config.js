// Metro config for the monorepo. Lets the app resolve the linked
// @household/crypto package (TypeScript source in ../shared/crypto) and its
// "exports" subpaths (./adapters/native). See docs/E2EE-SYNC-PLAN.md Phase 1.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Watch the shared/ workspace so edits to @household/crypto hot-reload.
config.watchFolders = [path.resolve(workspaceRoot, 'shared')];

// Resolve deps from the app first, then the shared package's own node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'shared/crypto/node_modules'),
];

// @household/crypto lives outside the app root and imports react-native-libsodium
// (a native module installed only in the app). Metro resolves that import
// relative to the shared package and can't see the app's node_modules, so map
// both explicitly. extraNodeModules is a resolution fallback used from any file.
config.resolver.extraNodeModules = {
  '@household/crypto': path.resolve(workspaceRoot, 'shared/crypto'),
  'react-native-libsodium': path.resolve(projectRoot, 'node_modules/react-native-libsodium'),
  // Shared CJS engines (no deps). See §9.1 P2 / P5b.
  '@household/calendar': path.resolve(workspaceRoot, 'shared/calendar'),
  '@household/weather': path.resolve(workspaceRoot, 'shared/weather'),
  '@household/grocery': path.resolve(workspaceRoot, 'shared/grocery'),
};

// @household/crypto uses the package "exports" field (./adapters/native).
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['react-native', 'require', 'import', 'default'];

module.exports = config;
