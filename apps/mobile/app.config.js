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
    // Android has refused cleartext HTTP by default since API 28, and a
    // release build of this app is no exception: the screenshot run reached
    // its own API at http://10.0.2.2:8100 and the request never left the
    // device — "can't reach SlyTab", with the server sitting there answering
    // nothing. Only ever opened for an http base, which no shipped build has:
    // production is https, so a real release cannot pick this up.
    if (process.env.SLYTAB_API_BASE.startsWith('http://')) {
      // Through expo-build-properties, not `android.usesCleartextTraffic`:
      // that key is quietly ignored by prebuild, and the first attempt at this
      // produced a manifest without it and an app that could not reach its own
      // API. The build now asserts the attribute is present before an emulator
      // is even started.
      expo.plugins = (expo.plugins ?? []).map((p) =>
        Array.isArray(p) && p[0] === 'expo-build-properties'
          ? [p[0], { ...p[1], android: { ...(p[1].android ?? {}), usesCleartextTraffic: true } }]
          : p);
    }
  }

  return { ...base, expo };
};
