// Dynamic Expo config: iOS and Android carry INDEPENDENT version numbers
// (owner, 2026-07-25). Everything static still lives in app.json; this only
// injects the per-platform version/build from versions.json based on which
// platform EAS is building. Bump versions.json — not app.json — for a release.
const base = require('./app.json');
const versions = require('./versions.json');

module.exports = () => {
  const platform = process.env.EAS_BUILD_PLATFORM; // 'ios' | 'android' | undefined (local)
  const expo = { ...base.expo, ios: { ...base.expo.ios }, android: { ...base.expo.android } };

  if (platform === 'android') {
    expo.version = versions.android.version;
    expo.android.versionCode = versions.android.versionCode;
  } else {
    // iOS build, or local/dev — default to the iOS line.
    expo.version = versions.ios.version;
    expo.ios.buildNumber = versions.ios.buildNumber;
    if (platform === 'ios') delete expo.android.versionCode; // don't leak the android code into an iOS build
  }
  // Screenshot builds point at a throwaway API seeded with demo data, so a
  // store listing never shows a real person's spending. Absent this variable
  // the app falls back to production, which is what every normal build wants.
  if (process.env.SLYTAB_API_BASE) {
    expo.extra = { ...(expo.extra ?? {}), apiBase: process.env.SLYTAB_API_BASE };
  }

  return { ...base, expo };
};
