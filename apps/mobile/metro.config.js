// Expo/Metro config. @slytab/core uses NodeNext-style imports ("./money.js"
// resolving to money.ts) which Vite and Vitest map automatically but Metro
// does not — this resolver retries such specifiers without the extension.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    /\.(ts|tsx)$/.test(context.originModulePath)
  ) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // fall through to the literal specifier
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
