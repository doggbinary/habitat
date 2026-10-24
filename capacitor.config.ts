import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell configuration.
 *
 * The editor is entirely self-contained, so the native app simply loads the
 * built `dist` from the bundle. There is no server to reach and nothing to
 * fetch at runtime, which means it works in airplane mode from first launch.
 */
const config: CapacitorConfig = {
  // TODO: replace with the bundle identifier registered in App Store Connect.
  appId: 'com.oliviabee.pixelfusion',
  appName: 'Pixel Fusion',
  webDir: 'dist',
  backgroundColor: '#0e0f13',

  ios: {
    backgroundColor: '#0e0f13',
    // The canvas handles its own gestures; WebView bounce would fight them.
    scrollEnabled: false,
    // Let the app paint under the status bar and home indicator, the way the
    // CSS safe-area insets already expect.
    contentInset: 'never',
    // Pixel art must never be resampled by the WebView.
    limitsNavigationsToAppBoundDomains: true,
  },
};

export default config;
