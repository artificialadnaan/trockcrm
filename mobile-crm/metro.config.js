// Default Expo Metro config. T-Rock CRM is a self-contained (non-workspace) app nested in the trockcrm
// monorepo: its own node_modules is complete, so Metro's nearest-node_modules resolution always finds
// this app's React/dependencies first and never walks up into the repo root. No monorepo overrides
// needed (unlike a hoisted workspace app), which also keeps `expo-doctor` clean.
//
// This is exactly why mobile-crm must NOT be added to the root package.json "workspaces" array — doing
// so hoists the dependencies, breaks that resolution, and breaks standalone EAS builds.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
