import { StatusBar } from 'expo-status-bar';
import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, BackHandler, FlatList, Image, KeyboardAvoidingView, Linking,
  Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Notifications from 'expo-notifications';
import { allAssigned as allItemsAssigned, assignedShares, categoryLabel, CATEGORY_HEADINGS, resolveCategories, computeSplit, convertAcrossMinor, CURRENCIES, CURRENCY_NAMES, currencyForLocation, formatMinor, GROUP_EMOJI, minorToAmountString, normalizeParsedReceipt, parseAmount, receiptBill, rescaleAmountFields, rescaleAmountString, SplitError, splitInputsFromStored, splitInputsToStored, splitMembersFromInputs, tokens, type CategoryOverride, type Currency, type SplitMethod } from '@slytab/core';
import {
  api, ApiFailure, appVersion, noteClientError, receiptImageSource, setToken, uploadReceipt,
  type Balances, type Expense, type Group, type GroupTotals, type HomeBalances, type Member,
  type ActivityItem, type Comment, type Session, type SplitwiseGroup,
  type ParsedReceipt, type User,
} from './src/api';

const c = tokens.color.dark;

// ---------- shared bits ----------

const BADGE_HUES = ['#79aaff', '#6ee0d2', '#f5a05e', '#ff8fb2', '#b78cff', '#6fc2ff'];
function badgeColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BADGE_HUES[h % BADGE_HUES.length]!;
}

function Badge({ id, name, size = 30 }: { id: string; name: string; size?: number }) {
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants"
      style={[s.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: badgeColor(id) }]}>
      <Text style={s.badgeText} maxFontSizeMultiplier={1.1}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function Amount({ minor, currency, signed = false, size = 14 }: {
  minor: number; currency: string; signed?: boolean; size?: number;
}) {
  const color = !signed ? c.text : minor >= 0 ? c.owed : c.owe;
  const text = signed
    ? `${minor >= 0 ? '+' : '−'}${formatMinor(Math.abs(minor), currency)}`
    : formatMinor(minor, currency);
  // VoiceOver reads the U+2212 minus unreliably (the default punctuation
  // setting skips it), so "owed" and "owe" could sound identical — the one
  // distinction this app exists to make. Spell the direction out (#95).
  const spoken = signed
    ? `${minor >= 0 ? 'you are owed' : 'you owe'} ${formatMinor(Math.abs(minor), currency)}`
    : formatMinor(minor, currency);
  return (
    <Text style={{ color, fontSize: size, fontVariant: ['tabular-nums'], fontWeight: '600' }}
      maxFontSizeMultiplier={1.5} accessibilityLabel={spoken}>{text}</Text>
  );
}

function Btn({ label, onPress, primary = false, disabled = false, small = false,
  destructive = false, a11yLabel }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean; small?: boolean;
  destructive?: boolean; a11yLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // Every button in the app comes through here, so the role belongs here
      // too — without it VoiceOver reads the label with no button trait and no
      // "double tap to activate" (#95). a11yLabel is for the icon-only callers
      // ('‹', '›'), whose glyph is meaningless read aloud.
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        s.btn, primary && s.btnPrimary, small && s.btnSmall,
        destructive && s.btnDestructive,
        // 0.45 put the disabled primary at 2.12:1 — unreadable, so a user
        // could not tell a blocked form from a missed tap (#94).
        (disabled || pressed) && { opacity: disabled ? 0.6 : 0.8 },
      ]}
    >
      <Text style={[
        s.btnText,
        // White on the brand blue is 3.21:1. The dark ink is 5.83:1 on the
        // same fill and reads well on blue (#94).
        primary && { color: c.bg },
        destructive && { color: c.danger },
        small && { fontSize: 12 },
      ]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Selection chips — split method, payer, currency, filters.
 *
 * Two things they all got wrong. They were 22–25pt tall against Apple's 44pt
 * minimum, and mis-tapping "Shares" instead of "Exact" silently changes what
 * everyone owes (#97). And selection was conveyed by background colour alone,
 * which VoiceOver cannot see — so a screen-reader user heard "Exact" and
 * "Shares" with no idea which was active (#95).
 *
 * Spread onto a Pressable: `{...chip(active)}`.
 */
function chip(active: boolean) {
  return {
    accessibilityRole: 'button' as const,
    accessibilityState: { selected: active },
    style: {
      paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
      minHeight: 44, justifyContent: 'center' as const,
      backgroundColor: active ? c.brand : c.surface2,
    },
  };
}

function Field({ label, ...input }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      {/* keyboardAppearance: the UI is hard-dark, and a light iOS keyboard
          slammed up against it looked like a different app (issue #50). */}
      <TextInput placeholderTextColor={c.text3} keyboardAppearance="dark"
        {...input} style={[s.input, input.style]} />
    </View>
  );
}

function SheetModal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  // The modal covers the full screen (statusBarTranslucent), so the sheet
  // must keep its own content above the Android gesture bar (issue #40).
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* behavior='padding' on Android double-counts the keyboard inset the
          platform already applies, leaving an 84dp dead band between the
          sheet and the keyboard (issue #61). iOS still needs it. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable style={s.sheetBack} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: 16 + insets.bottom }]}>
          <View style={s.grabber} />
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <Text style={[s.sheetTitle, { flex: 1 }]}>{title}</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close"
              hitSlop={16} style={{ minWidth: 44, minHeight: 44,
                alignItems: 'flex-end', justifyContent: 'center' }}>
              <Text style={{ color: c.text2, fontSize: 16 }} maxFontSizeMultiplier={1.4}>✕</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- screens ----------

type Nav = { screen: 'home' } | { screen: 'group'; groupId: string };
// UI spec §1: bottom tab bar with four destinations (issue #40 follow-up —
// this replaces the interim avatar-sheet shell).
type Tab = 'home' | 'groups' | 'activity' | 'profile';

const TOKEN_KEY = 'slytab.session';
// Last server answer to "is Google sign-in configured?" — shows the button
// instantly on later launches instead of after a network round-trip (#40).
const GOOGLE_READY_KEY = 'slytab.googleReady';

/**
 * Catches a render-time throw instead of letting it unmount everything (#89).
 *
 * The whole UI is one subtree, so any throw — a null member lookup, a
 * malformed payload, a currency the money formatter doesn't know — left the
 * user staring at a permanently blank dark screen with no message and no way
 * back but force-quitting. And nothing was captured, so the bug report that
 * followed described a black screen and carried no evidence.
 *
 * Remounting by bumping a key is deliberate: the failure is usually one bad
 * payload, and refetching clears it without losing the session.
 */
class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { message: string | null; attempt: number }
> {
  override state = { message: null as string | null, attempt: 0 };

  static getDerivedStateFromError(e: unknown) {
    return { message: (e as Error)?.message ?? 'Something went wrong' };
  }

  override componentDidCatch(e: unknown) {
    noteClientError('render', (e as Error)?.message ?? String(e));
  }

  override render() {
    if (this.state.message === null) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    return (
      <View style={[s.screen, s.center]}>
        <Text style={s.wordmark}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
        <Text style={[s.body, { textAlign: 'center', marginBottom: 4 }]}>
          Something went wrong on this screen.
        </Text>
        <Text style={[s.meta, { textAlign: 'center', marginBottom: 16 }]}>
          Nothing you entered has been lost. You can report this from Profile.
        </Text>
        <View style={{ width: '100%', maxWidth: 320 }}>
          <Btn primary label="Try again"
            onPress={() => this.setState((st) => ({ message: null, attempt: st.attempt + 1 }))} />
        </View>
      </View>
    );
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

function AppShell() {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [nav, setNav] = useState<Nav>({ screen: 'home' });
  const [tab, setTab] = useState<Tab>('home');

  // Stay signed in: the session token lives in the device keystore.
  useEffect(() => {
    SecureStore.getItemAsync(TOKEN_KEY)
      .then(async (stored) => {
        if (stored === null) return;
        setToken(stored);
        try {
          setUser(await api.me());
        } catch {
          setToken(null);
          await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, []);

  function signedIn(t: string, u: User) {
    setToken(t);
    setUser(u);
    SecureStore.setItemAsync(TOKEN_KEY, t).catch(() => {});
  }

  // Issue #3: register for push once signed in (best-effort).
  useEffect(() => {
    if (user === null) return;
    (async () => {
      try {
        const perm = await Notifications.requestPermissionsAsync();
        if (!perm.granted) return;
        const tok = await Notifications.getExpoPushTokenAsync();
        await api.registerPushToken(tok.data);
      } catch { /* no push on this device — fine */ }
    })();
  }, [user]);

  // SDK 54 draws edge-to-edge on Android, so the app itself keeps content
  // clear of the status bar and gesture bar (issue #40: bottom overprint).
  const insets = useSafeAreaInsets();

  // Android's system Back used to leave the app from a group screen, which
  // reads as "I lost my place" rather than "I went up a level" (issue #64).
  useEffect(() => {
    if (Platform.OS !== 'android' || nav.screen !== 'group') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setNav({ screen: 'home' });
      return true; // handled — don't fall through to exiting the app
    });
    return () => sub.remove();
  }, [nav.screen]);

  return (
    // The TAB BAR owns the bottom inset so its surface reaches the screen
    // edge (#46) — but only the tab screens have one. Group detail, sign-in
    // and onboarding are full-screen routes, so the shell pads for them or
    // their content runs under the gesture bar, which is #40 all over again.
    <View style={[s.app, {
      paddingTop: insets.top,
      paddingBottom: (user !== null && user.onboardedAt !== null && nav.screen !== 'group')
        ? 0 : insets.bottom,
    }]}>
      {restoring ? (
        <View style={[s.screen, { justifyContent: 'center' }]}>
          <ActivityIndicator accessibilityLabel="Loading" color={c.brand} />
        </View>
      ) : user === null ? (
        <AuthScreen onSignedIn={signedIn} />
      ) : user.onboardedAt === null ? (
        <OnboardingScreen user={user} onDone={setUser} />
      ) : nav.screen === 'group' ? (
        <GroupScreen groupId={nav.groupId} user={user} onBack={() => setNav({ screen: 'home' })} />
      ) : (
        // The four tab screens stay mounted (hidden, not unmounted) so
        // half-typed profile edits or an open sheet survive a tab switch;
        // each screen refetches when its tab regains focus.
        <>
          <View style={{ flex: 1, display: tab === 'home' ? 'flex' : 'none' }}>
            <HomeScreen active={tab === 'home'} user={user}
              onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })} />
          </View>
          <View style={{ flex: 1, display: tab === 'groups' ? 'flex' : 'none' }}>
            <GroupsScreen active={tab === 'groups'} user={user}
              onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })} />
          </View>
          <View style={{ flex: 1, display: tab === 'activity' ? 'flex' : 'none' }}>
            <ActivityScreen active={tab === 'activity'} user={user}
              onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })} />
          </View>
          <View style={{ flex: 1, display: tab === 'profile' ? 'flex' : 'none' }}>
            <ProfileScreen active={tab === 'profile'} user={user} onSaved={setUser}
              onSignOut={() => {
                api.logout().catch(() => {});
                setToken(null);
                setUser(null);
                SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
              }} />
          </View>
          <TabBar tab={tab} onTab={setTab} user={user} />
        </>
      )}
      <StatusBar style="light" />
    </View>
  );
}

function TabBar({ tab, onTab, user }: { tab: Tab; onTab: (t: Tab) => void; user: User }) {
  // The bar owns the bottom inset so its SURFACE runs to the screen edge.
  // Padding the root view instead left a strip of page background below the
  // bar in a different colour — a 34pt band on iPhone (issue #46).
  const insets = useSafeAreaInsets();
  const items: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'home', label: 'Home', icon: <Text style={s.tabIcon} maxFontSizeMultiplier={1.2}>🏠</Text> },
    { key: 'groups', label: 'Groups', icon: <Text style={s.tabIcon} maxFontSizeMultiplier={1.2}>👥</Text> },
    { key: 'activity', label: 'Activity', icon: <Text style={s.tabIcon} maxFontSizeMultiplier={1.2}>🕓</Text> },
    // The Profile tab is the user's avatar badge (UI spec §1 / issue #40).
    { key: 'profile', label: 'Profile', icon: <Badge id={user.id} name={user.displayName} size={22} /> },
  ];
  return (
    <View style={[s.tabbar, { paddingBottom: insets.bottom }]}>
      {items.map((it) => (
        <Pressable key={it.key} style={s.tabItem} onPress={() => onTab(it.key)}
          accessibilityRole="tab" accessibilityLabel={it.label}
          accessibilityState={{ selected: tab === it.key }}>
          <View style={[s.tabIconBox, { opacity: tab === it.key ? 1 : 0.45 }]}>{it.icon}</View>
          <Text style={[s.tabBarLabel, tab === it.key && { color: c.text }]}
            maxFontSizeMultiplier={1.2}>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function AuthScreen({ onSignedIn }: { onSignedIn: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  // Apple sign-in needs iOS 13+; asking the device beats assuming.
  const [appleReady, setAppleReady] = useState(false);
  const [waitingGoogle, setWaitingGoogle] = useState(false);
  const handoff = useRef<{ state: string; verifier: string } | null>(null);

  // Issue #40: the Google button used to appear only after a network
  // round-trip (seconds on a cold start). Trust the last-known answer
  // right away, then reconcile with the server.
  useEffect(() => {
    // iOS offers Sign in with Apple and nothing else (owner, 2026-07-30).
    // Google there meant bouncing out to Safari and polling to get back,
    // which reads as a hang and is the wrong shape on the platform. Skip the
    // config call entirely rather than fetching an answer we will ignore.
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync()
        .then(setAppleReady)
        .catch(() => setAppleReady(false));
      return;
    }
    SecureStore.getItemAsync(GOOGLE_READY_KEY)
      .then((v) => { if (v === '1') setGoogleReady(true); })
      .catch(() => {});
    api.googleConfig().then((cfg) => {
      setGoogleReady(cfg.enabled);
      SecureStore.setItemAsync(GOOGLE_READY_KEY, cfg.enabled ? '1' : '0').catch(() => {});
    }).catch(() => {});
  }, []);

  // Issue #39: while the user signs in with Google in the system browser,
  // poll for the session it parks server-side. Offline blips keep polling;
  // only a server verdict (handoff expired) or Cancel stops the wait.
  useEffect(() => {
    if (!waitingGoogle || handoff.current === null) return;
    const { state, verifier } = handoff.current;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const r = await api.handoffClaim(state, verifier);
        if (!active) return;
        if (r.token !== undefined && r.user !== undefined) {
          setWaitingGoogle(false);
          onSignedIn(r.token, r.user);
          return;
        }
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiFailure) {
          setWaitingGoogle(false);
          setError("Google sign-in didn't finish — try again");
          return;
        }
      } finally {
        inFlight = false;
      }
      timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    // Issue #40: when the browser bounces back to the app (slytab://signed-in
    // or a manual switch), claim immediately instead of waiting out the timer.
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && active && !inFlight) {
        clearTimeout(timer);
        void poll();
      }
    });
    return () => { active = false; clearTimeout(timer); sub.remove(); };
  }, [waitingGoogle]); // eslint-disable-line react-hooks/exhaustive-deps

  async function googleSignIn() {
    setError(null);
    try {
      const h = await api.handoffStart();
      handoff.current = { state: h.state, verifier: h.verifier };
      setWaitingGoogle(true);
      await Linking.openURL(`https://electricrv.ca/slytab/app-signin/${h.state}`);
    } catch (e) {
      setWaitingGoogle(false);
      setError((e as Error).message);
    }
  }

  /**
   * Sign in with Apple, natively. Required on iOS the moment we offer any
   * other third-party sign-in (App Store Review Guideline 4.8) — and until
   * this existed, an Apple-linked account simply could not get into the
   * iPhone build.
   *
   * Apple returns the full name ONCE, on first authorization, and never
   * again; if it is not forwarded here it is lost for good.
   */
  async function appleSignIn() {
    setError(null);
    setBusy(true);
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) throw new Error('Apple did not return a sign-in token');
      const full = [cred.fullName?.givenName, cred.fullName?.familyName]
        .filter(Boolean).join(' ').trim();
      // The authorization code is handed over once and is the only way to a
      // refresh token, which is the only way to revoke this account later
      // when the user deletes it (#81).
      const r = await api.appleSignIn(cred.identityToken, full, cred.authorizationCode ?? '');
      onSignedIn(r.token, r.user);
    } catch (e) {
      // Dismissing the sheet is a choice, not a failure to report.
      const code = (e as { code?: string }).code;
      if (code !== 'ERR_REQUEST_CANCELED' && code !== 'ERR_CANCELED') {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'create'
        ? await api.register(email, password, name)
        : await api.login(email, password);
      onSignedIn(r.token, r.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    // The app's front door, and it had no working keyboard handling on
    // EITHER platform: `behavior` resolved to undefined on Android (a
    // no-op) and on iOS the KeyboardAvoidingView had nothing scrollable
    // inside it, so the keyboard pushed the primary button off screen with
    // no way to reach it (issues #47/#59). This mirrors OnboardingScreen,
    // which already had the correct shape.
    <KeyboardAvoidingView style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={[s.center, { flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Text style={s.wordmark}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
      <Text style={s.tagline}>Split expenses with the people you actually share life with.</Text>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <View style={{ width: '100%', maxWidth: 340 }}>
        {mode === 'create' && (
          <Field label="Your name" value={name} onChangeText={setName} autoCapitalize="words" />
        )}
        {/* textContentType is what lets iCloud Keychain fill an existing
            password and offer to save/generate one on sign-up. Without it our
            users hand-typed 10+ characters on every reinstall — the biggest
            everyday friction in the app (#99). passwordRules keeps Safari's
            generator inside what the API accepts. */}
        <Field label="Email" value={email} onChangeText={setEmail}
          autoCapitalize="none" keyboardType="email-address" autoComplete="email"
          textContentType="username" returnKeyType="next" />
        <Field label={mode === 'create' ? 'Password (10+ characters)' : 'Password'}
          value={password} onChangeText={setPassword} secureTextEntry
          textContentType={mode === 'create' ? 'newPassword' : 'password'}
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          passwordRules="minlength: 10; required: lower; required: upper; required: digit;"
          returnKeyType="go" onSubmitEditing={() => { if (!busy) void submit(); }} />
        <Btn primary disabled={busy}
          label={busy ? '…' : mode === 'create' ? 'Create account' : 'Sign in'}
          onPress={submit} />
        {Platform.OS === 'ios' && appleReady && (
          <>
            <Text style={[s.meta, { textAlign: 'center', paddingTop: 4 }]}>or</Text>
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={12}
              style={{ width: '100%', height: 48, marginTop: 8 }}
              onPress={appleSignIn}
            />
          </>
        )}
        {Platform.OS !== 'ios' && googleReady && (
          <>
            <Text style={[s.meta, { textAlign: 'center', paddingTop: 4 }]}>or</Text>
            <Btn disabled={busy || waitingGoogle}
              label={waitingGoogle ? 'Waiting for your browser…' : 'Continue with Google'}
              onPress={googleSignIn} />
            {waitingGoogle && (
              <Pressable onPress={() => { setWaitingGoogle(false); handoff.current = null; }}>
                <Text style={s.link}>Cancel</Text>
              </Pressable>
            )}
          </>
        )}
        <Pressable onPress={() => setMode(mode === 'create' ? 'signin' : 'create')}>
          <Text style={s.link}>
            {mode === 'create' ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </Text>
        </Pressable>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Issue #36: first-run welcome. Shown once (server onboardedAt is null),
 * captures the key things — name and home currency — plus optional
 * payment handles, then marks onboarding complete.
 */
function OnboardingScreen({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency || 'USD');
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [showHandles, setShowHandles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName: displayName.trim(),
        defaultCurrency: currency,
        paymentHandles: { ...(interac ? { interacEmail: interac } : {}) },
        onboarded: true,
      });
      onDone(updated);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={s.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ alignItems: 'center', paddingVertical: 24 }} keyboardShouldPersistTaps="handled">
        <Text style={s.wordmark}>Welcome to Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
        <Text style={s.tagline}>Split expenses with family and friends — no math, no awkward reminders. Two quick things and you're set.</Text>
        {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
        <View style={{ width: '100%', maxWidth: 340 }}>
          <Field label="What should we call you?" value={displayName} onChangeText={setDisplayName} autoCapitalize="words" />
          <CurrencySingleField label="Your home currency — your overall balance shows in this"
            value={currency} onChange={setCurrency} />
          {!showHandles ? (
            <Btn label="＋ Add how people pay you (optional)" onPress={() => setShowHandles(true)} />
          ) : (
            <Field label="Interac e-Transfer email" value={interac} onChangeText={setInterac}
              autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com" />
          )}
          <Btn primary disabled={busy || displayName.trim() === ''}
            label={busy ? 'Setting up…' : 'Get started'} onPress={submit} />
          <Text style={[s.meta, { textAlign: 'center', paddingTop: 8 }]}>
            You can change any of this later in Profile.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Quick-add remembers where you last added an expense (per device) so the
// picker defaults to the group you're living in right now (issue #20).
const LAST_GROUP_KEY = 'slytab.lastGroup';

function HomeScreen({ user, onOpenGroup, active }: {
  user: User; onOpenGroup: (id: string) => void; active: boolean;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [quickAdd, setQuickAdd] = useState<{ group: Group; lastCurrency?: string } | null>(null);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [lastGroupId, setLastGroupId] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  // Refetch whenever the tab regains focus (spec §2.2 auto-refetch).
  useEffect(() => { if (active) reload(); }, [active, reload, user.defaultCurrency]);
  useEffect(() => {
    SecureStore.getItemAsync(LAST_GROUP_KEY).then(setLastGroupId).catch(() => {});
  }, []);

  const total = data?.total ?? null;
  const incoming = (data?.pendingSettlements ?? []).filter((p) => p.toUserId === user.id);

  function rememberGroup(id: string) {
    setLastGroupId(id);
    SecureStore.setItemAsync(LAST_GROUP_KEY, id).catch(() => {});
  }
  function openGroup(id: string) {
    rememberGroup(id);
    onOpenGroup(id);
  }

  // Archived groups are read-only, so they can't take new expenses.
  const activeItems = (data?.items ?? []).filter((i) => !i.group.archivedAt);
  const pickerItems = [...activeItems].sort((a, b) =>
    Number(b.group.id === lastGroupId) - Number(a.group.id === lastGroupId));

  // Add expense in one tap: single group goes straight to the sheet, else
  // ask which group (most recently used first). The sheet opens in the
  // group's last-used currency — same mid-trip behaviour as in the group.
  function startQuickAdd(group: Group) {
    setQuickBusy(group.id);
    rememberGroup(group.id);
    api.expenses(group.id)
      .then((r) => setQuickAdd({ group, lastCurrency: r.items[0]?.currency }))
      .catch(() => setQuickAdd({ group }))
      .finally(() => { setQuickBusy(null); setPicking(false); });
  }
  function onAddExpense() {
    const only = activeItems.length === 1 ? activeItems[0] : undefined;
    if (only !== undefined) startQuickAdd(only.group);
    else setPicking(true); // includes the no-groups case (picker explains)
  }

  // #56/#57: this chrome used to sit ABOVE the list as fixed siblings,
  // so at large system font scales it ate the screen and the group list
  // collapsed to a sliver. As a list header it scrolls with the content.
  const chrome = (
    <View>
      <View style={s.header}>
        <Text style={s.h1}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
      </View>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}

      {user.emailVerifiedAt === null && (
        <View style={[s.row, { borderColor: c.owe }]}>
          <Text style={[s.body, { flex: 1, fontSize: 12.5 }]}>
            {verifySent
              ? `Confirmation email sent to ${user.email} — check your inbox and junk folder.`
              : `Confirm your email — press Resend to get a link at ${user.email}.`}
          </Text>
          <Btn small label={verifySent ? 'Sent ✓' : 'Resend'} disabled={verifySent}
            onPress={() => {
              api.resendVerification()
                .then(() => { setError(null); setVerifySent(true); })
                .catch((e) => setError((e as Error).message));
            }} />
        </View>
      )}

      <View style={s.hero}>
        <Text style={s.cap}>YOUR BALANCE</Text>
        {total === null ? <ActivityIndicator accessibilityLabel="Loading" color={c.brand} />
          : total.owedMinor === 0 && total.oweMinor === 0
            ? <Text style={{ color: c.text2, fontSize: 26, fontWeight: '600' }}>All settled up ✓</Text>
            : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {total.approximate && <Text style={{ color: c.text2, fontSize: 22 }}>≈</Text>}
                <Amount minor={total.minor} currency={total.currency} signed size={30} />
              </View>
            )}
        {total !== null && (total.owedMinor > 0 || total.oweMinor > 0) && (
          <View style={{ flexDirection: 'row', gap: 14 }}>
            {total.owedMinor > 0 && (
              <Text style={s.pairline} maxFontSizeMultiplier={1.5}>
                you're owed <Text style={[s.pairAmt, { color: c.owed }]}>
                  {formatMinor(total.owedMinor, total.currency)}</Text>
              </Text>
            )}
            {total.oweMinor > 0 && (
              <Text style={s.pairline} maxFontSizeMultiplier={1.5}>
                you owe <Text style={[s.pairAmt, { color: c.owe }]}>
                  {formatMinor(total.oweMinor, total.currency)}</Text>
              </Text>
            )}
          </View>
        )}
        <Text style={s.meta}>
          {data === null ? 'Loading'
            : `Across ${data.items.length} group${data.items.length === 1 ? '' : 's'}`
              + (total?.approximate ? ` · in ${total.currency} at today's rate` : '')
              + (total !== null && total.excluded.length > 0 ? ` · no rate for ${total.excluded.join(', ')}` : '')}
        </Text>
      </View>

      {incoming.map((p) => (
        <View style={s.row} key={p.id}>
          <Text style={[s.body, { flex: 1 }]}>
            Payment of {formatMinor(p.amountMinor, p.currency)} sent to you
          </Text>
          <Btn small primary label="Confirm" onPress={() => api.confirmSettlement(p.id).then(reload)} />
        </View>
      ))}
    </View>
  );

  return (
    <View style={s.screen}>
      <FlatList
        data={[
          ...(data?.items ?? []).filter((i) => !i.group.isDirect && !i.group.archivedAt),
          ...(showArchived ? (data?.items ?? []).filter((i) => !i.group.isDirect && i.group.archivedAt) : []),
        ]}
        keyExtractor={(i) => i.group.id}
        onRefresh={reload}
        refreshing={false}
        contentContainerStyle={{ paddingBottom: 150 }}
        ListHeaderComponent={(
          <View>
            {chrome}
            {(data?.items ?? []).some((i) => i.group.isDirect) && (
              <>
            <Text style={s.cap}>FRIENDS · {(data?.items ?? []).filter((i) => i.group.isDirect).length}</Text>
            {(data?.items ?? []).filter((i) => i.group.isDirect).map(({ group, netMinor, currency }) => {
              const other = group.members.find((m) => m.id !== user.id);
              return (
                <Pressable style={s.row} key={group.id} onPress={() => openGroup(group.id)}>
                  <Badge id={other?.id ?? group.id} name={other?.displayName ?? '?'} />
                  <Text style={[s.rowName, { flex: 1 }]}>{other?.displayName ?? 'Friend'}</Text>
                  {netMinor === 0 ? <Text maxFontSizeMultiplier={1.5} style={s.meta}>settled ✓</Text> : (
                    <View style={{ alignItems: 'flex-end' }}>
                      <Amount minor={netMinor} currency={currency} signed />
                      <Text maxFontSizeMultiplier={1.5} style={s.meta}>{netMinor > 0 ? 'owes you' : 'you owe'}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
            <Text style={s.cap}>
              GROUPS{(() => { const n = (data?.items ?? []).filter((i) => !i.group.isDirect && !i.group.archivedAt).length; return n > 0 ? ` · ${n}` : ''; })()}
            </Text>
              </>
            )}
          </View>
        )}
        ListEmptyComponent={data ? <Text style={s.meta}>No groups yet — create one.</Text> : null}
        ListFooterComponent={(() => {
          const archived = (data?.items ?? []).filter((i) => !i.group.isDirect && i.group.archivedAt);
          if (archived.length === 0 || showArchived) return null;
          return (
            <Btn small label={`Show ${archived.length} archived group${archived.length === 1 ? '' : 's'}`}
              onPress={() => setShowArchived(true)} />
          );
        })()}
        renderItem={({ item }) => {
          const pairs = item.myPairs ?? [];
          const firstName = (id: string) =>
            item.group.members.find((m) => m.id === id)?.displayName?.split(' ')[0] ?? 'Former member';
          const others = item.group.members.filter((m) => m.id !== user.id);
          return (
            <Pressable style={s.row} onPress={() => openGroup(item.group.id)}>
              <View style={s.tile}>
                <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 22 }}>{item.group.emoji || '👥'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>{item.group.name}{item.group.archivedAt ? ' (archived)' : ''}</Text>
                {pairs.length === 0 ? (
                  <Text style={s.pairline} maxFontSizeMultiplier={1.5}>
                    {others.length > 0
                      ? `all square with ${others.map((m) => m.displayName.split(' ')[0]).join(', ')} ✓`
                      : 'just you so far — invite your people'}
                  </Text>
                ) : (
                  <View>
                    {pairs.slice(0, 2).map((p) => (
                      <Text style={s.pairline} key={p.userId} maxFontSizeMultiplier={1.5}>
                        {p.amountMinor > 0
                          ? <>{firstName(p.userId)} owes you <Text style={[s.pairAmt, { color: c.owed }]}>
                              {formatMinor(p.amountMinor, item.currency)}</Text></>
                          : <>you owe {firstName(p.userId)} <Text style={[s.pairAmt, { color: c.owe }]}>
                              {formatMinor(-p.amountMinor, item.currency)}</Text></>}
                      </Text>
                    ))}
                    {pairs.length > 2 && (
                      <Text style={[s.pairline, { color: c.text3 }]} maxFontSizeMultiplier={1.5}>
                        plus {pairs.length - 2} more balance{pairs.length - 2 === 1 ? '' : 's'}
                      </Text>
                    )}
                  </View>
                )}
              </View>
              {item.netMinor === 0
                ? <Text maxFontSizeMultiplier={1.5} style={s.meta}>settled ✓</Text>
                : (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Amount minor={item.netMinor} currency={item.currency} signed />
                    <Text maxFontSizeMultiplier={1.5} style={s.meta}>{item.netMinor > 0 ? 'you are owed' : 'you owe'}</Text>
                  </View>
                )}
            </Pressable>
          );
        }}
      />

      <Pressable style={[s.fab, s.fabWide]} onPress={onAddExpense} disabled={data === null}
        accessibilityRole="button" accessibilityLabel="Add expense">
        <Text style={{ color: c.bg, fontSize: 18 }} maxFontSizeMultiplier={1.3}>＋</Text>
        <Text style={{ color: c.bg, fontSize: 15, fontWeight: '600' }} maxFontSizeMultiplier={1.3}>Add expense</Text>
      </Pressable>
      {picking && (
        <SheetModal title="Add an expense" onClose={() => setPicking(false)}>
          {pickerItems.length === 0 ? (
            <View>
              <Text style={[s.body, { color: c.text2, marginBottom: 12 }]}>
                Every expense lives in a group or a one-on-one tab — start
                one and you're seconds away from splitting.
              </Text>
              <Btn primary label="New group"
                onPress={() => { setPicking(false); setCreating(true); }} />
              <Btn label="Split with a friend"
                onPress={() => { setPicking(false); setAddingFriend(true); }} />
            </View>
          ) : (
            <View>
              <Text style={[s.meta, { marginBottom: 8 }]}>Where did this expense happen?</Text>
              {pickerItems.map(({ group }) => {
                const other = group.isDirect ? group.members.find((m) => m.id !== user.id) : undefined;
                return (
                  <Pressable style={s.row} key={group.id} disabled={quickBusy !== null}
                    onPress={() => startQuickAdd(group)}>
                    {group.isDirect
                      ? <Badge id={other?.id ?? group.id} name={other?.displayName ?? '?'} />
                      : <View style={s.tile}><Text maxFontSizeMultiplier={1.4} style={{ fontSize: 22 }}>{group.emoji || '👥'}</Text></View>}
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowName}>
                        {group.isDirect ? other?.displayName ?? 'Friend' : group.name}
                      </Text>
                      {!group.isDirect && (
                        <Text style={s.meta}>{group.members.map((m) => m.displayName).join(', ')}</Text>
                      )}
                    </View>
                    {quickBusy === group.id
                      ? <ActivityIndicator accessibilityLabel="Loading" color={c.brand} />
                      : group.id === lastGroupId && <Text style={s.meta}>recent</Text>}
                  </Pressable>
                );
              })}
            </View>
          )}
        </SheetModal>
      )}
      {quickAdd !== null && (
        <AddExpenseSheet group={quickAdd.group} user={user} lastCurrency={quickAdd.lastCurrency}
          onClose={() => setQuickAdd(null)}
          onSaved={() => { setQuickAdd(null); reload(); }} />
      )}
      {addingFriend && (
        <AddFriendSheet onClose={() => setAddingFriend(false)}
          onCreated={(id) => { setAddingFriend(false); openGroup(id); }} />
      )}
      {creating && (
        <CreateGroupSheet defaultCurrency={user.defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); openGroup(id); }} />
      )}
    </View>
  );
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function deviceName(label: string): string {
  if (label === 'web') return 'Web browser';
  // Sessions are labelled by platform now; 'mobile' is what older sessions
  // carry and could be either OS, so it stays deliberately vague rather
  // than telling an iPhone user they signed in from an Android (issue #49).
  if (label === 'mobile') return 'Mobile app';
  if (label === 'ios') return 'iPhone app';
  if (label === 'android') return 'Android app';
  return label || 'Unknown device';
}

/** Report a bug (profile page): comment + optional screenshot. */
function BugReportSection() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<{ uri: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null); // tracking code
  const [error, setError] = useState<string | null>(null);

  if (sent !== null) {
    return (
      <Text style={[s.meta, { textAlign: 'center', paddingVertical: 8 }]}>
        Thanks — your report is in as {sent}. We read every one, and
        you'll get an email when it's fixed. 🐛✓
      </Text>
    );
  }
  if (!open) {
    return (
      <>
        <Btn label="🐛 Report a bug" onPress={() => setOpen(true)} />
        <View style={{ height: 8 }} />
      </>
    );
  }
  return (
    <View style={{ borderColor: c.outline, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 }}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Field label="What went wrong?" value={message} onChangeText={setMessage}
        multiline numberOfLines={3} maxLength={2000}
        placeholder="What did you do, what did you expect, what happened instead?" />
      <Btn small label={image === null ? '🖼 Attach a screenshot (optional)' : 'Screenshot attached ✓ (tap to change)'}
        onPress={() => {
          void ImagePicker.launchImageLibraryAsync({ quality: 0.9 }).then((r) => {
            const asset = r.assets?.[0];
            if (!r.canceled && asset) {
              setImage({ uri: asset.uri, mime: asset.mimeType ?? 'image/jpeg' });
            }
          });
        }} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Btn label="Cancel" disabled={busy} onPress={() => { setOpen(false); setError(null); }} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn primary label={busy ? 'Sending…' : 'Send report'}
            disabled={busy || message.trim() === ''}
            onPress={() => {
              setBusy(true);
              setError(null);
              api.reportBug(message.trim(), image)
                .then((r) => setSent(r.tracking ?? 'received'))
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }} />
        </View>
      </View>
    </View>
  );
}

function ProfileScreen({ user, onSaved, onSignOut, active }: {
  user: User; onSaved: (u: User) => void; onSignOut: () => void; active: boolean;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency);
  const [deleting, setDeleting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [notifyLevel, setNotifyLevel] = useState<'all' | 'important' | 'none'>(user.notifyLevel ?? 'all');
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [paypal, setPaypal] = useState(user.paymentHandles.paypalMe ?? '');
  const [venmo, setVenmo] = useState(user.paymentHandles.venmo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    if (active) api.listSessions().then((r) => setSessions(r.items)).catch(() => {});
  }, [active]);

  // Unsaved-edit tracking (issue #22): as a tab there's no close to guard,
  // but it still powers the "Saved ✓" confirmation below the button.
  const dirty = displayName !== user.displayName
    || currency !== user.defaultCurrency
    || notifyLevel !== (user.notifyLevel ?? 'all')
    || interac !== (user.paymentHandles.interacEmail ?? '')
    || paypal !== (user.paymentHandles.paypalMe ?? '')
    || venmo !== (user.paymentHandles.venmo ?? '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName: displayName.trim(),
        defaultCurrency: currency,
        notifyLevel,
        paymentHandles: {
          ...(interac ? { interacEmail: interac } : {}),
          ...(paypal ? { paypalMe: paypal } : {}),
          ...(venmo ? { venmo } : {}),
        },
      });
      setSavedOk(true);
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Badge id={user.id} name={user.displayName} size={34} />
        <Text style={s.h1}>Profile</Text>
      </View>
      {/* This screen has fields near the bottom (payment handles, the
          delete-account confirmation), and a ScrollView alone does not lift
          them clear of the keyboard on iOS — issue #48. */}
      <KeyboardAvoidingView style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Field label="Display name" value={displayName} onChangeText={setDisplayName} />
      <CurrencySingleField label="Home currency — your overall balance shows in this"
        value={currency} onChange={setCurrency} />
      <Text style={s.fieldLabel}>Notifications</Text>
      {/* Wraps: at large font scales the three options ran off the right
          edge and "Nothing" became untappable (issue #60). */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {([['all', 'Everything'], ['important', 'Important only'], ['none', 'Nothing']] as const).map(([v, label]) => (
          <Pressable key={v} onPress={() => setNotifyLevel(v)}
            accessibilityRole="button" accessibilityState={{ selected: notifyLevel === v }}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              minHeight: 44, justifyContent: 'center',
              backgroundColor: notifyLevel === v ? c.brand : c.surface2 }}>
            <Text style={{ color: notifyLevel === v ? c.bg : c.text2, fontSize: 12.5 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.fieldLabel}>How people pay you</Text>
      <Field label="Interac e-Transfer email" value={interac} onChangeText={setInterac}
        keyboardType="email-address" placeholder="you@example.com" />
      <Field label="PayPal.Me username" value={paypal} onChangeText={setPaypal} placeholder="yourname" />
      <Field label="Venmo username" value={venmo} onChangeText={setVenmo} placeholder="yourname" />
      <Btn primary label={busy ? 'Saving…' : 'Save profile'} disabled={busy || displayName.trim() === ''}
        onPress={() => void save()} />
      {savedOk && !dirty && (
        <Text style={[s.meta, { textAlign: 'center', paddingBottom: 4 }]}>Profile saved ✓</Text>
      )}
      <View style={{ height: 8 }} />
      {/* Report a bug sits above the session list (report #42 ordering —
          the async list otherwise pushes the button around as it loads). */}
      <BugReportSection />
      {sessions !== null && sessions.length > 0 && (
        <>
          <Text style={[s.cap, { marginTop: 14 }]}>WHERE YOU'RE SIGNED IN</Text>
          {sessions.map((sess) => (
            <View style={s.row} key={sess.id}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>
                  {deviceName(sess.deviceLabel)}{sess.current ? ' · this device' : ''}
                </Text>
                <Text style={s.meta}>last active {ago(sess.lastSeenAt)}</Text>
              </View>
              {!sess.current && (
                <Btn small label="Sign out" onPress={() => {
                  api.revokeSession(sess.id)
                    .then(() => setSessions(sessions.filter((x) => x.id !== sess.id)))
                    .catch(() => {});
                }} />
              )}
            </View>
          ))}
        </>
      )}
      <View style={{ height: 8 }} />
      <Btn label="Sign out" onPress={onSignOut} />
      <View style={{ height: 8 }} />
      {!deleting ? (
        <Pressable onPress={() => setDeleting(true)}>
          <Text style={{ color: c.owe, textAlign: 'center', fontSize: 13.5, padding: 6 }}>Delete my account…</Text>
        </Pressable>
      ) : (
        <View style={{ borderWidth: 1, borderColor: c.owe, borderRadius: 12, padding: 12 }}>
          <Text style={[s.body, { fontSize: 12.5, marginBottom: 8 }]}>
            This signs you out everywhere and anonymizes you as "Deleted user"
            in shared groups (past expenses stay so nobody's balance changes).
            It cannot be undone. Type your email to confirm.
          </Text>
          <Field label="Your email" value={confirmEmail} onChangeText={setConfirmEmail}
            keyboardType="email-address" autoCapitalize="none" placeholder={user.email} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn label="Keep my account" onPress={() => { setDeleting(false); setConfirmEmail(''); }} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn label="Delete forever"
                disabled={confirmEmail.trim().toLowerCase() !== user.email}
                onPress={() => {
                  api.deleteAccount(confirmEmail.trim()).then(onSignOut)
                    .catch((e) => setError((e as Error).message));
                }} />
            </View>
          </View>
        </View>
      )}
      <Text style={[s.meta, { textAlign: 'center', marginTop: 10 }]}>Account: {user.email}</Text>
      {/* Guideline 5.1.1(i): the policy link must be in App Store Connect AND
          reachable inside the app. The web app had it; the binary did not,
          which is a certain rejection (#80). */}
      <Pressable accessibilityRole="link"
        onPress={() => Linking.openURL('https://electricrv.ca/slytab/marketing/privacy/')}>
        <Text style={s.link}>Privacy policy</Text>
      </Pressable>
      {/* Spec §2.10 version footer. Without it a tester on TestFlight has
          no way to tell you which build they are looking at (issue #45). */}
      <Text style={[s.meta, { textAlign: 'center', marginTop: 4 }]}>
        SlyTab {appVersion().version} ({appVersion().build})
      </Text>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Groups tab (UI spec §2.3): cards with member badges + your net. */
function GroupsScreen({ user, onOpenGroup, active }: {
  user: User; onOpenGroup: (id: string) => void; active: boolean;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { if (active) reload(); }, [active, reload]);

  const groups = (data?.items ?? []).filter((i) => !i.group.isDirect);
  const activeGroups = groups.filter((i) => !i.group.archivedAt);
  const archived = groups.filter((i) => i.group.archivedAt);

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Text style={s.h1}>Groups</Text>
        <View style={{ flex: 1 }} />
        <Btn small label="New group" onPress={() => setCreating(true)} />
      </View>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <FlatList
        data={[...activeGroups, ...(showArchived ? archived : [])]}
        keyExtractor={(i) => i.group.id}
        onRefresh={reload}
        refreshing={false}
        ListEmptyComponent={data
          ? <Text style={s.meta}>No groups yet. Start a group and invite your people.</Text>
          : null}
        ListFooterComponent={
          <View>
            {archived.length > 0 && !showArchived && (
              <Btn small label={`Show ${archived.length} archived group${archived.length === 1 ? '' : 's'}`}
                onPress={() => setShowArchived(true)} />
            )}
            <View style={{ height: 8 }} />
            <Btn label="Split with a friend" onPress={() => setAddingFriend(true)} />
          </View>
        }
        renderItem={({ item }) => {
          const members = item.group.members;
          return (
            <Pressable style={s.row} onPress={() => onOpenGroup(item.group.id)}>
              <View style={s.tile}>
                <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 22 }}>{item.group.emoji || '👥'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowName}>
                  {item.group.name}{item.group.archivedAt ? ' (archived)' : ''}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingTop: 4 }}>
                  {members.slice(0, 5).map((m) => (
                    <Badge key={m.id} id={m.id} name={m.displayName} size={20} />
                  ))}
                  {members.length > 5 && (
                    <Text style={s.meta}>+{members.length - 5}</Text>
                  )}
                </View>
              </View>
              {item.netMinor === 0
                ? <Text maxFontSizeMultiplier={1.5} style={s.meta}>settled ✓</Text>
                : (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Amount minor={item.netMinor} currency={item.currency} signed />
                    <Text maxFontSizeMultiplier={1.5} style={s.meta}>{item.netMinor > 0 ? 'you are owed' : 'you owe'}</Text>
                  </View>
                )}
            </Pressable>
          );
        }}
      />
      {addingFriend && (
        <AddFriendSheet onClose={() => setAddingFriend(false)}
          onCreated={(id) => { setAddingFriend(false); onOpenGroup(id); }} />
      )}
      {creating && (
        <CreateGroupSheet defaultCurrency={user.defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onOpenGroup(id); }} />
      )}
    </View>
  );
}

/**
 * Activity tab (UI spec §2.9): one feed across every group, newest first,
 * grouped by day. There is no global endpoint yet, so the per-group feeds
 * are merged client-side — fine at family-beta scale.
 */
function ActivityScreen({ user, onOpenGroup, active }: {
  user: User; onOpenGroup: (id: string) => void; active: boolean;
}) {
  type FeedRow = ActivityItem & { groupId: string; groupLabel: string; who: string };
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(async (r) => {
      const feeds = await Promise.all(r.items.map(async ({ group }) => {
        try {
          const f = await api.activity(group.id);
          const other = group.members.find((m) => m.id !== user.id);
          const label = group.isDirect ? `with ${other?.displayName ?? 'a friend'}` : group.name;
          return f.items.map((ev): FeedRow => ({
            ...ev, groupId: group.id, groupLabel: label,
            who: ev.userId === user.id ? 'You'
              : group.members.find((m) => m.id === ev.userId)?.displayName ?? 'Former member',
          }));
        } catch { return []; }
      }));
      setRows(feeds.flat()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100));
    }).catch((e) => setError(e.message));
  }, [user.id]);
  useEffect(() => { if (active) reload(); }, [active, reload]);

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Text style={s.h1}>Activity</Text>
      </View>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <FlatList
        data={rows ?? []}
        keyExtractor={(ev) => ev.id}
        onRefresh={reload}
        refreshing={false}
        ListEmptyComponent={rows === null
          ? <ActivityIndicator accessibilityLabel="Loading" color={c.brand} style={{ marginTop: 40 }} />
          : <Text style={s.meta}>Nothing yet — activity from all your groups lands here.</Text>}
        renderItem={({ item: ev, index }) => {
          const day = ev.createdAt.slice(0, 10);
          const prev = index > 0 ? (rows ?? [])[index - 1] : undefined;
          const newDay = prev === undefined || prev.createdAt.slice(0, 10) !== day;
          return (
            <View>
              {newDay && <Text style={s.cap}>{day}</Text>}
              <Pressable style={s.row} onPress={() => onOpenGroup(ev.groupId)}>
                <Badge id={ev.userId} name={ev.who === 'You' ? user.displayName : ev.who} size={22} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.body, { fontSize: 13 }]}>
                    <Text style={{ fontWeight: '700' }}>{ev.who}</Text>
                    {' '}{activityText(ev)}
                    <Text style={{ color: c.text3 }}> · {ev.groupLabel}</Text>
                  </Text>
                  <Text style={s.meta}>{ago(ev.createdAt)}</Text>
                </View>
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}

function CreateGroupSheet({ defaultCurrency, onClose, onCreated }: {
  defaultCurrency: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  return (
    <SheetModal title="New group" onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Field label="Name" value={name} onChangeText={setName} placeholder="Cottage Trip" />
      <Text style={s.fieldLabel}>Emoji</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {GROUP_EMOJI.map((e) => (
          <Pressable key={e} onPress={() => setEmoji(e === emoji ? '' : e)}
            style={{ padding: 5, borderRadius: 8, borderWidth: 2,
              borderColor: e === emoji ? c.brand : 'transparent' }}>
            <Text style={{ fontSize: 20 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <CurrencySingleField label="Home currency" value={currency} onChange={setCurrency} />
      <Text style={s.fieldLabel}>Also often used (quick picks in expenses — optional)</Text>
      <CurrencyMultiPicker selected={[...favorites]} exclude={currency}
        onChange={(next) => setFavorites(new Set(next))} />
      <Btn primary label="Create group" disabled={name.trim() === ''}
        onPress={() => api.createGroup(name, emoji, currency.toUpperCase(), [...favorites])
          .then((g) => onCreated(g.id)).catch((e) => setError(e.message))} />
    </SheetModal>
  );
}

function AddFriendSheet({ onClose, onCreated }: {
  onClose: () => void; onCreated: (groupId: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SheetModal title="Split with a friend" onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Text style={[s.meta, { marginBottom: 10 }]}>
        One-on-one expenses, no group needed. If they're not on SlyTab yet
        we'll email an invite — anything you add is waiting when they join.
      </Text>
      <Field label="Their email" value={email} onChangeText={setEmail}
        keyboardType="email-address" autoCapitalize="none" placeholder="friend@example.com" />
      <Btn primary label={busy ? '…' : 'Start splitting'} disabled={busy || email.trim() === ''}
        onPress={() => {
          setBusy(true);
          api.addFriend(email.trim())
            .then((g) => onCreated(g.id))
            .catch((e) => setError((e as Error).message))
            .finally(() => setBusy(false));
        }} />
    </SheetModal>
  );
}

function GroupSettingsSheet({ group, onClose, onSaved }: {
  group: Group; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [favorites, setFavorites] = useState<Set<string>>(new Set(group.currencies));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <SheetModal title="Group settings" onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Field label="Name" value={name} onChangeText={setName} />
      <Text style={s.fieldLabel}>Emoji</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {GROUP_EMOJI.map((e) => (
          <Pressable key={e} onPress={() => setEmoji(e === emoji ? '' : e)}
            style={{ padding: 5, borderRadius: 8, borderWidth: 2,
              borderColor: e === emoji ? c.brand : 'transparent' }}>
            <Text style={{ fontSize: 20 }}>{e}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.fieldLabel}>Often-used currencies (home is always {group.homeCurrency})</Text>
      <CurrencyMultiPicker selected={[...favorites]} exclude={group.homeCurrency}
        onChange={(next) => setFavorites(new Set(next))} />
      <Btn primary label={busy ? 'Saving…' : 'Save'} disabled={busy || name.trim() === ''}
        onPress={() => {
          setBusy(true);
          api.updateGroup(group.id, { name, emoji, currencies: [...favorites] })
            .then(onSaved)
            .catch((e) => setError((e as Error).message))
            .finally(() => setBusy(false));
        }} />
      <View style={{ height: 8 }} />
      {/* Issue #35: groups aren't deleted (balances must stay honest) —
          they archive to read-only and collapse on the home page. */}
      <Btn label="Archive this group…" disabled={busy}
        onPress={() => Alert.alert(
          `Archive "${group.name}"?`,
          'It becomes read-only — no new expenses — and moves under "Show archived groups" on Home. '
          + "History and balances stay visible. This can't be undone from the app.",
          [
            { text: 'Keep it active', style: 'cancel' },
            { text: 'Archive', style: 'destructive', onPress: () => {
              setBusy(true);
              api.archiveGroup(group.id)
                .then(onSaved)
                .catch((e) => { setError((e as Error).message); setBusy(false); });
            } },
          ],
        )} />
      {/* #84: the way out. Anyone can add you to a group by email without your
          agreeing, and until now only they could remove you — Guideline 1.2
          expects an escape hatch for unwanted content. The server refuses
          while a balance is outstanding, so surface that plainly rather than
          letting it look like a bug. */}
      <Btn label="Leave this group" destructive disabled={busy}
        onPress={() => Alert.alert(
          'Leave this group?',
          'You stop seeing it and stop getting updates about it. Past expenses '
          + 'stay so nobody else\'s balance changes. You can be added back later.',
          [
            { text: 'Stay', style: 'cancel' },
            { text: 'Leave', style: 'destructive', onPress: () => {
              setBusy(true);
              api.leaveGroup(group.id)
                .then(onSaved)
                .catch((e) => {
                  const msg = (e as Error).message;
                  setError(msg.includes('settle')
                    ? 'Settle up first — you still have a balance in this group.'
                    : msg);
                  setBusy(false);
                });
            } },
          ],
        )} />
    </SheetModal>
  );
}

/** Human phrasing for the activity feed (issue #16). */
function activityText(ev: ActivityItem): string {
  const d = (ev.diff ?? {}) as { description?: string; source?: string };
  const what = d.description ? `"${d.description}"` : `a ${ev.entityType}`;
  switch (ev.verb) {
    case 'created': return 'started the group';
    case 'joined': return 'joined the group';
    case 'left': return 'left the group';
    case 'added': return ev.entityType === 'member' ? 'added a member' : `added ${what}`;
    case 'edited': return ev.entityType === 'group' ? 'updated the group settings' : `edited ${what}`;
    case 'deleted': return `deleted ${what}`;
    case 'restored': return `restored ${what}`;
    case 'settled': return 'recorded a payment';
    case 'confirmed': return 'confirmed a payment';
    case 'declined': return "couldn't find a payment (declined)";
    case 'imported': return 'imported from Splitwise';
    case 'commented': return `commented on ${what}`;
    default: return `${ev.verb} ${what}`;
  }
}

function GroupScreen({ groupId, user, onBack }: {
  groupId: string; user: User; onBack: () => void;
}) {
  const [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'totals' | 'activity'>('expenses');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  // Nullable so the empty state can tell 'nothing here' from 'not loaded yet'
  // — as [] it announced "No expenses yet" on every open (#98).
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [totals, setTotals] = useState<GroupTotals | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Expense | null>(null);
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-group category customisation (#18): overrides on the shipped taxonomy.
  const [catOverrides, setCatOverrides] = useState<Record<string, CategoryOverride>>({});
  const [managingCategories, setManagingCategories] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);
  // Today's group-home → user-home rate, for the fine print under each
  // expense (the user thinks in their own currency, not the group's).
  const [homeRate, setHomeRate] = useState<number | null>(null);

  const groupHome = group?.homeCurrency;
  useEffect(() => {
    if (groupHome === undefined || user.defaultCurrency === groupHome) return;
    api.fxRate(groupHome, user.defaultCurrency)
      .then((r) => setHomeRate(r.rate))
      .catch(() => setHomeRate(null)); // fall back to group-home display
  }, [groupHome, user.defaultCurrency]);

  const reload = useCallback(() => {
    // The primary fetch owns the error: swallowing it left a spinner that
    // never resolved, with nothing on screen to explain or retry (#93/#98).
    // The secondary ones stay best-effort — a missing rate should not blank
    // the screen.
    api.group(groupId).then((g) => { setGroup(g); setLoadError(null); })
      .catch((e) => setLoadError((e as Error).message));
    api.balances(groupId).then(setBalances).catch(() => {});
    api.groupTotals(groupId).then(setTotals).catch(() => {});
    api.activity(groupId).then((r) => setFeed(r.items)).catch(() => {});
    api.groupCategories(groupId).then((r) => setCatOverrides(r.overrides ?? {})).catch(() => {});
  }, [groupId]);
  useEffect(reload, [reload]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.expenses(groupId, { q: search, category: catFilter })
        .then((r) => setExpenses(r.items)).catch(() => {});
    }, search !== '' ? 300 : 0);
    return () => clearTimeout(t);
  }, [groupId, search, catFilter, group, feed]);

  const memberById = useMemo(() => new Map((group?.members ?? []).map((m) => [m.id, m])), [group]);
  const nameOf = (id: string) => memberById.get(id)?.displayName ?? 'Former member';

  if (group === null) {
    // Offline this used to spin forever with no message and no way out, because
    // every fetch error was swallowed (#93/#98). Name the problem and offer the
    // retry — ui_requirements.md:318, "every error names a next step".
    return (
      <View style={s.screen}>
        <Btn small label="‹ Back" a11yLabel="Back" onPress={onBack} />
        {loadError === null ? (
          <ActivityIndicator color={c.brand} style={{ marginTop: 40 }} accessibilityLabel="Loading group" />
        ) : (
          <View style={{ marginTop: 40 }}>
            <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{loadError}</Text>
            <Btn primary label="Try again" onPress={() => { setLoadError(null); reload(); }} />
          </View>
        )}
      </View>
    );
  }
  // "Category management can be a separate page" (owner, #18).
  if (managingCategories) {
    return (
      <ManageCategoriesScreen group={group} onBack={() => { setManagingCategories(false); reload(); }} />
    );
  }
  // Deliberately NOT `?? 0`: zero means settled, and null means we do not
  // know yet. Collapsing them made the header announce "settled ✓" on
  // every open until the balances landed (#98).
  const myNet = balances === null ? null : (balances.net[user.id] ?? 0);

  // #56: header, tab strip and the search/filter row used to sit above
  // the list as fixed siblings — at font scale 1.8 they consumed the
  // screen and the expense list disappeared. They scroll with it now.
  const chrome = (
    <View>
      <View style={s.header}>
        <Btn small label="‹" a11yLabel="Back" onPress={onBack} />
        <Text maxFontSizeMultiplier={1.4} style={{ fontSize: 22 }}>{group.emoji || '👥'}</Text>
        <Pressable style={{ flex: 1 }} onPress={() => { if (!group.isDirect) setSettingsOpen(true); }}>
          <Text style={s.h2}>
            {group.isDirect
              ? group.members.find((m) => m.id !== user.id)?.displayName ?? 'Friend'
              : group.name}
            {!group.isDirect && <Text style={[s.meta, { fontSize: 12 }]}> ✎</Text>}
          </Text>
          <Text style={s.meta}>
            {group.isDirect ? `just the two of you · ${group.homeCurrency}` : `${group.members.length} member${group.members.length === 1 ? '' : 's'} · ${group.homeCurrency}`}
          </Text>
        </Pressable>
        {myNet === null ? <Text style={s.meta}>—</Text>
          : myNet === 0 ? <Text maxFontSizeMultiplier={1.5} style={s.meta}>settled ✓</Text>
          : <Amount minor={myNet} currency={group.homeCurrency} signed size={15} />}
      </View>

      <View style={s.tabs}>
        {(['expenses', 'balances', 'totals', 'activity'] as const).map((t) => (
          <Pressable key={t} style={[s.tab, tab === t && s.tabOn]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && { color: c.text }]} maxFontSizeMultiplier={1.3}>
              {t === 'expenses' ? 'Expenses' : t === 'balances' ? 'Balances' : t === 'totals' ? 'Totals' : 'Activity'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'expenses' && (
        <View>
          <Field label="" value={search} onChangeText={setSearch} placeholder="Search expenses…" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {CATEGORY_HEADINGS.map((cat) => (
              <Pressable key={cat} onPress={() => setCatFilter(catFilter === cat ? '' : cat)}
                style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 11,
              minHeight: 44, justifyContent: 'center',
                  backgroundColor: catFilter === cat ? c.brand : c.surface2 }}>
                <Text style={{ color: catFilter === cat ? c.bg : c.text2, fontSize: 11.5 }}>
                  {categoryLabel(cat, catOverrides)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  );
  // Likewise the action row, which was being drawn under the gesture bar.
  const actions = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 10 }}>
      <Btn small label="Invite"
        onPress={() => api.createInvite(group.id)
          .then((i) => setInviteLink(`https://electricrv.ca/slytab/join/${i.token}`))} />
      {group.archivedAt === null && (
        <Btn small label="Import from Splitwise" onPress={() => setImporting(true)} />
      )}
      <Btn small label="Categories" onPress={() => setManagingCategories(true)} />
    </View>
  );

  return (
    <View style={s.screen}>
      {tab === 'expenses' ? (
        <FlatList
          data={expenses}
          keyExtractor={(e) => e.id}
          onRefresh={reload}
          refreshing={false}
          contentContainerStyle={{ paddingBottom: 150 }}
          ListEmptyComponent={expenses === null
            ? <ActivityIndicator accessibilityLabel="Loading" color={c.brand} style={{ marginTop: 20 }} />
            : <Text style={s.meta}>No expenses yet.</Text>}
          ListFooterComponent={actions}
          ListHeaderComponent={(
            <View>
            {chrome}
            {lastDeleted !== null && (
            <View style={[s.row, { borderColor: c.owe }]}>
              <Text style={[s.body, { flex: 1, fontSize: 12.5 }]}>Deleted "{lastDeleted.description}"</Text>
              <Btn small label="Undo" onPress={() => {
                api.restoreExpense(lastDeleted!.id).then(() => { setLastDeleted(null); reload(); }).catch(() => {});
              }} />
            </View>
            )}
            </View>
          )}
          renderItem={({ item: e }) => {
            const paid = e.payers.filter((p) => p.userId === user.id).reduce((a, p) => a + p.amountMinor, 0);
            const owed = e.shares.filter((sh) => sh.userId === user.id).reduce((a, sh) => a + sh.amountMinor, 0);
            const effect = paid - owed;
            return (
              <Pressable style={s.row} onPress={() => setEditing(e)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName}>{e.description}</Text>
                  <Text style={s.meta}>
                    {e.payers.map((p) => nameOf(p.userId)).join(' + ')} paid{' '}
                    {formatMinor(e.amountMinor, e.currency)} · {e.expenseDate}
                    {(() => {
                      // Fine print: the expense's value in the viewer's own
                      // home currency, falling back to the group home value
                      // when no cross rate is available.
                      const inGroupHome = e.fxRate !== null
                        ? convertAcrossMinor(e.amountMinor, e.fxRate, e.currency, group.homeCurrency)
                        : (e.currency === group.homeCurrency ? e.amountMinor : null);
                      if (inGroupHome === null) return '';
                      if (user.defaultCurrency !== group.homeCurrency && homeRate !== null
                        && e.currency !== user.defaultCurrency) {
                        const inUserHome = convertAcrossMinor(inGroupHome, homeRate, group.homeCurrency, user.defaultCurrency);
                        return ` · ≈ ${formatMinor(inUserHome, user.defaultCurrency)}`;
                      }
                      return e.fxRate !== null ? ` · ≈ ${formatMinor(inGroupHome, group.homeCurrency)}` : '';
                    })()}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {effect === 0 ? <Text style={s.meta}>not involved</Text> : (
                    <>
                      <Amount minor={effect} currency={e.currency} signed />
                      <Text maxFontSizeMultiplier={1.5} style={s.meta}>{effect > 0 ? 'you lent' : 'you borrowed'}</Text>
                    </>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      ) : tab === 'activity' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 150 }}>
          {chrome}
          {feed.length === 0 && <Text style={s.meta}>Nothing yet.</Text>}
          {feed.map((ev) => (
            <View style={s.row} key={ev.id}>
              <Badge id={ev.userId} name={nameOf(ev.userId)} size={22} />
              <View style={{ flex: 1 }}>
                <Text style={[s.body, { fontSize: 13 }]}>
                  <Text style={{ fontWeight: '700' }}>{ev.userId === user.id ? 'You' : nameOf(ev.userId)}</Text>
                  {' '}{activityText(ev)}
                </Text>
                <Text style={s.meta}>{ev.createdAt}</Text>
              </View>
            </View>
          ))}
          {actions}
        </ScrollView>
      ) : tab === 'totals' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 150 }}>
          {chrome}
          {totals === null ? <ActivityIndicator accessibilityLabel="Loading" color={c.brand} /> : (
            <>
              <View style={s.hero}>
                <Text style={s.cap}>GROUP SPENDING</Text>
                <Amount minor={totals.totalMinor} currency={group.homeCurrency} size={26} />
                <Text style={s.meta}>All expenses, in {group.homeCurrency}</Text>
              </View>
              {totals.byMonth.length > 1 && (
                <>
                  <Text style={s.cap}>BY MONTH</Text>
                  {totals.byMonth.map((m) => (
                    <View style={s.row} key={m.month}>
                      <Text style={[s.body, { flex: 1 }]}>{m.month}</Text>
                      <Amount minor={m.minor} currency={group.homeCurrency} />
                    </View>
                  ))}
                </>
              )}
              <Text style={s.cap}>BY CATEGORY</Text>
              {totals.byHeading.map((h) => (
                <View key={h.category}>
                  <View style={s.row}>
                    <Text style={[s.body, { flex: 1 }]}>{categoryLabel(h.category, catOverrides)}</Text>
                    <Amount minor={h.minor} currency={group.homeCurrency} />
                  </View>
                  {/* Leaves under this heading keep the roll-up explorable. */}
                  {totals.byCategory
                    .filter((cat) => cat.category.startsWith(`${h.category}.`))
                    .map((cat) => (
                      <View style={[s.row, { paddingLeft: 18 }]} key={cat.category}>
                        <Text style={[s.body, { flex: 1, color: c.text2, fontSize: 12.5 }]}>{categoryLabel(cat.category, catOverrides)}</Text>
                        <Amount minor={cat.minor} currency={group.homeCurrency} />
                      </View>
                    ))}
                </View>
              ))}
              <Text style={s.cap}>WHO PAID</Text>
              {totals.byPayer.map((pr) => (
                <View style={s.row} key={pr.userId}>
                  <Badge id={pr.userId} name={nameOf(pr.userId)} size={22} />
                  <Text style={[s.body, { flex: 1 }]}>{pr.userId === user.id ? 'You' : nameOf(pr.userId)}</Text>
                  <Amount minor={pr.minor} currency={group.homeCurrency} />
                </View>
              ))}
              <Text style={s.cap}>WHO CONSUMED</Text>
              {totals.byShare.map((sh) => (
                <View style={s.row} key={sh.userId}>
                  <Badge id={sh.userId} name={nameOf(sh.userId)} size={22} />
                  <Text style={[s.body, { flex: 1 }]}>{sh.userId === user.id ? 'You' : nameOf(sh.userId)}</Text>
                  <Amount minor={sh.minor} currency={group.homeCurrency} />
                </View>
              ))}
            </>
          )}
          {actions}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 150 }}>
          {chrome}
          {group.members.map((m) => (
            <View style={s.row} key={m.id}>
              <Badge id={m.id} name={m.displayName} />
              <Text style={[s.rowName, { flex: 1 }]}>{m.id === user.id ? 'You' : m.displayName}</Text>
              {(balances?.net[m.id] ?? 0) === 0 ? <Text maxFontSizeMultiplier={1.5} style={s.meta}>settled ✓</Text>
                : <Amount minor={balances?.net[m.id] ?? 0} currency={group.homeCurrency} signed />}
            </View>
          ))}
          <Text style={s.cap}>SUGGESTED SETTLEMENTS</Text>
          {(balances?.plan ?? []).length === 0 && <Text style={s.meta}>Everyone is settled up ✓</Text>}
          {(balances?.plan ?? []).map((tr, i) => (
            <View style={s.row} key={i}>
              <Text style={[s.body, { flex: 1 }]}>
                {tr.from === user.id ? 'You' : nameOf(tr.from)} → {tr.to === user.id ? 'you' : nameOf(tr.to)}{' '}
                {formatMinor(tr.amountMinor, group.homeCurrency)}
              </Text>
              {tr.from === user.id && memberById.get(tr.to) && (
                <Btn small primary label="Settle"
                  onPress={() => setSettling({ to: memberById.get(tr.to)!, suggested: tr.amountMinor })} />
              )}
            </View>
          ))}
          {actions}
        </ScrollView>
      )}

      {/* The action row now rides at the bottom of whichever list is on
          screen (see `actions`), so it can never be stranded under the
          gesture bar again — issue #56. */}
      {inviteLink && (
        <InviteSheet group={group} user={user} link={inviteLink} onClose={() => setInviteLink(null)} onChanged={reload} />
      )}

      {/* The Home FAB was labelled and this one was not, so the group screen's
          primary action announced as "plus" (#95). */}
      {group.archivedAt === null && (
        <Pressable style={s.fab} accessibilityRole="button" accessibilityLabel="Add expense"
          onPress={() => setAdding(true)}>
          <Text style={{ color: c.bg, fontSize: 30, lineHeight: 34 }} maxFontSizeMultiplier={1}>+</Text>
        </Pressable>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user}
          lastCurrency={expenses?.[0]?.currency}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }} />
      )}
      {editing !== null && (
        <AddExpenseSheet group={group} user={user} editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onDeleted={() => { setLastDeleted(editing); setEditing(null); reload(); }} />
      )}
      {importing && (
        <ImportSheet group={group} onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); reload(); }} />
      )}
      {settingsOpen && (
        <GroupSettingsSheet group={group} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); reload(); }} />
      )}
      {settling && (
        <SettleSheet group={group} to={settling.to} suggested={settling.suggested}
          onClose={() => setSettling(null)}
          onDone={() => { setSettling(null); reload(); }} />
      )}
    </View>
  );
}

function ImportSheet({ group, onClose, onDone }: {
  group: Group; onClose: () => void; onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [swGroups, setSwGroups] = useState<SplitwiseGroup[] | null>(null);
  const [swGroupId, setSwGroupId] = useState<number | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: { expenses: number; settlements: number; skipped: number; duplicates?: number }; invited: string[];
  } | null>(null);

  const swGroup = swGroups?.find((g) => g.id === swGroupId) ?? null;
  const complete = swGroup !== null
    && swGroup.members.every((m) => {
      const v = mapping[String(m.id)] ?? '';
      if (v === '__invite') return /.+@.+\..+/.test((inviteEmails[String(m.id)] ?? '').trim());
      return v !== '';
    })
    && new Set(swGroup.members.map((m) => {
      const v = mapping[String(m.id)] ?? '';
      return v === '__invite' ? `email:${(inviteEmails[String(m.id)] ?? '').trim().toLowerCase()}` : v;
    })).size === swGroup.members.length;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.splitwiseApiGroups(group.id, apiKey.trim());
      setSwGroups(r.groups);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (swGroupId === null || swGroup === null) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string | { email: string; name: string }> = {};
      for (const m of swGroup.members) {
        const v = mapping[String(m.id)] ?? '';
        payload[String(m.id)] = v === '__invite'
          ? { email: (inviteEmails[String(m.id)] ?? '').trim(), name: m.name }
          : v;
      }
      const r = await api.splitwiseApiImport(group.id, apiKey.trim(), swGroupId, payload);
      setResult({ imported: r.imported, invited: r.invited ?? [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetModal title="Import from Splitwise" onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      {result !== null ? (
        <>
          <Text style={[s.body, { marginBottom: 10 }]}>
            Imported {result.imported.expenses} expenses and {result.imported.settlements} settlements
            {result.imported.skipped > 0 ? ` · ${result.imported.skipped} personal expenses skipped` : ''}
            {(result.imported.duplicates ?? 0) > 0
              ? ` · ${result.imported.duplicates} already in this group, not added again` : ''}.
          </Text>
          {result.invited.length > 0 && (
            <Text style={[s.meta, { marginBottom: 10 }]}>
              Invitations sent to {result.invited.join(', ')} — their share of the
              history is saved and appears under their name the moment they join.
            </Text>
          )}
          <Btn primary label="Done" onPress={onDone} />
        </>
      ) : swGroups === null ? (
        <>
          <Text style={[s.meta, { marginBottom: 10 }]}>
            To connect your Splitwise account, get a one-time code:{'\n\n'}
            1. In a browser, sign in at secure.splitwise.com/apps{'\n'}
            2. Choose "Register your application" — the name can be anything (e.g. SlyTab){'\n'}
            3. Copy the long code Splitwise shows (labelled "API key") and paste it below{'\n\n'}
            SlyTab uses the code once to read your groups — it is never stored.
          </Text>
          <Field label="Splitwise code" value={apiKey} onChangeText={setApiKey}
            secureTextEntry autoCapitalize="none" />
          <Btn primary label={busy ? 'Connecting…' : 'Load my Splitwise groups'}
            disabled={busy || apiKey.trim() === ''} onPress={() => void connect()} />
        </>
      ) : (
        <>
          <Text style={s.fieldLabel}>Splitwise group</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {swGroups.map((g) => (
              <Pressable key={g.id}
                onPress={() => { setSwGroupId(g.id); setMapping({}); }}
                style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 14,
                  backgroundColor: g.id === swGroupId ? c.brand : c.surface2 }}>
                <Text style={{ color: g.id === swGroupId ? c.bg : c.text2, fontSize: 13 }}>{g.name}</Text>
              </Pressable>
            ))}
          </View>
          {swGroup !== null && (
            <>
              <Text style={s.fieldLabel}>Who is who? Tap a name to change</Text>
              {swGroup.members.map((m) => {
                const v = mapping[String(m.id)] ?? '';
                const mapped = group.members.find((gm) => gm.id === v);
                return (
                  <View key={m.id}>
                    <Pressable style={s.row}
                      onPress={() => {
                        // Cycle: each member → "invite by email" → around again.
                        const order = [...group.members.map((gm) => gm.id), '__invite'];
                        const next = order[(order.indexOf(v) + 1) % order.length];
                        setMapping({ ...mapping, [String(m.id)]: next ?? '' });
                      }}>
                      <Text style={[s.body, { flex: 1 }]}>{m.name}</Text>
                      <Text style={{ color: v !== '' ? c.brand : c.text3, fontSize: 13.5 }}>
                        {v === '__invite' ? '→ invite by email' : mapped ? `→ ${mapped.displayName}` : 'tap to choose'}
                      </Text>
                    </Pressable>
                    {v === '__invite' && (
                      <Field label={`${m.name}'s email — we'll invite them and keep their share ready`}
                        value={inviteEmails[String(m.id)] ?? ''}
                        onChangeText={(t) => setInviteEmails({ ...inviteEmails, [String(m.id)]: t })}
                        keyboardType="email-address" autoCapitalize="none"
                        placeholder="them@example.com" />
                    )}
                  </View>
                );
              })}
              <Btn primary label={busy ? 'Importing…' : 'Import everything'}
                disabled={!complete || busy} onPress={() => void run()} />
            </>
          )}
        </>
      )}
    </SheetModal>
  );
}

function InviteSheet({ group, user, link, onClose, onChanged }: {
  group: Group; user: User; link: string; onClose: () => void; onChanged: () => void;
}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Issue #24: people from your other groups are one tap away.
  const [people, setPeople] = useState<Member[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState<string | null>(null);
  useEffect(() => {
    api.homeBalances().then((r) => {
      const inGroup = new Set(group.members.map((m) => m.id));
      const seen = new Map<string, Member>();
      for (const item of r.items) {
        for (const m of item.group.members) {
          if (m.id !== user.id && !inGroup.has(m.id) && !seen.has(m.id)) seen.set(m.id, m);
        }
      }
      setPeople([...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));
    }).catch(() => setPeople([]));
  }, [group.members, user.id]);
  return (
    <SheetModal title="Invite to group" onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      {people !== null && people.length > 0 && (
        <>
          <Text style={s.cap}>PEOPLE YOU KNOW</Text>
          {people.map((p) => (
            <View style={s.row} key={p.id}>
              <Badge id={p.id} name={p.displayName} />
              <Text style={[s.rowName, { flex: 1 }]}>{p.displayName}</Text>
              <Btn small primary={!added.has(p.id)}
                label={added.has(p.id) ? 'Added ✓' : addBusy === p.id ? '…' : '＋ Add'}
                disabled={addBusy !== null || added.has(p.id)}
                onPress={() => {
                  setAddBusy(p.id);
                  setError(null);
                  api.addKnownMember(group.id, p.id)
                    .then(() => { setAdded((s2) => new Set(s2).add(p.id)); onChanged(); })
                    .catch((e) => setError((e as Error).message))
                    .finally(() => setAddBusy(null));
                }} />
            </View>
          ))}
          <Text style={s.cap}>OR SOMEONE NEW</Text>
        </>
      )}
      {sent && <Text style={[s.meta, { marginBottom: 8 }]}>Invitation emailed to {sent} ✓</Text>}
      <Field label="Invite by email" value={email} onChangeText={setEmail}
        autoCapitalize="none" keyboardType="email-address" placeholder="them@example.com" />
      <Btn primary label="Send email invite" disabled={email.trim() === ''}
        onPress={() => api.createInvite(group.id, email.trim())
          .then(() => { setSent(email.trim()); setEmail(''); setError(null); })
          .catch((e) => setError(e.message))} />
      <Text style={s.cap}>OR SHARE THE LINK</Text>
      <Text style={[s.body, { padding: 10, backgroundColor: c.surface2, borderRadius: 10 }]} selectable>
        {link}
      </Text>
      <Text style={s.meta}>Anyone with this link can join for 7 days. Long-press to copy.</Text>
    </SheetModal>
  );
}

type ScanStage =
  | { stage: 'upload'; fraction: number }
  | { stage: 'read'; startedAt: number };

let etaCache: { typicalMs: number; slowMs: number } | null = null;
function fetchEta(): void {
  api.receiptEta().then((e) => { if (e.samples > 0) etaCache = e; }).catch(() => {});
}

/** Staged scan progress (issue #9): upload % → reading with elapsed time. */
/**
 * Searchable currency list with full names (user feedback: a wall of
 * 3-letter chips was unusable). Shows the top matches; typing narrows.
 */
function CurrencySearchList({ onPick, exclude = [], selected = [] }: {
  onPick: (c: string) => void; exclude?: string[]; selected?: string[];
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = CURRENCIES
    .filter((cur) => !exclude.includes(cur))
    .filter((cur) => q === ''
      || cur.toLowerCase().includes(q)
      || CURRENCY_NAMES[cur].toLowerCase().includes(q))
    .slice(0, 8);
  return (
    <View>
      <Field label="Search — e.g. peso, CLP, dollar" value={query} onChangeText={setQuery}
        autoCapitalize="none" placeholder="Type a currency name or code" />
      <View style={{ borderWidth: 1, borderColor: c.outline, borderRadius: 10, marginBottom: 12 }}>
        {matches.map((cur) => {
          const on = selected.includes(cur);
          return (
            <Pressable key={cur} onPress={() => onPick(cur)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10,
                paddingVertical: 9, paddingHorizontal: 12,
                backgroundColor: on ? c.surface2 : 'transparent' }}>
              {/* Fixed widths clipped the tick and the code — and choosing
                  the wrong currency silently changes every amount's scale,
                  since some are zero-decimal (#96). */}
              <Text maxFontSizeMultiplier={1.6}
                style={{ color: c.brand, minWidth: 14, fontSize: 13 }}>{on ? '✓' : ''}</Text>
              <Text maxFontSizeMultiplier={1.6}
                style={{ color: c.text, fontWeight: '700', minWidth: 44, flexShrink: 0, fontSize: 13.5 }}>{cur}</Text>
              <Text style={{ color: c.text2, fontSize: 13.5 }}>{CURRENCY_NAMES[cur]}</Text>
            </Pressable>
          );
        })}
        {matches.length === 0 && (
          <Text style={[s.meta, { padding: 12 }]}>No matches.</Text>
        )}
      </View>
    </View>
  );
}

/** Multi-select favorites: removable chips + the search list. */
function CurrencyMultiPicker({ selected, onChange, exclude }: {
  selected: string[]; onChange: (next: string[]) => void; exclude?: string;
}) {
  return (
    <View>
      {selected.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map((cur) => (
            <Pressable key={cur} onPress={() => onChange(selected.filter((x) => x !== cur))}
              style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.brand }}>
              <Text style={{ color: c.bg, fontSize: 12.5 }}>{cur} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}
      <CurrencySearchList selected={selected} exclude={exclude ? [exclude] : []}
        onPick={(cur) => onChange(selected.includes(cur)
          ? selected.filter((x) => x !== cur) : [...selected, cur])} />
    </View>
  );
}

/** Single currency field: current pick shown; tap "change" to search. */
function CurrencySingleField({ label, value, onChange, quick = [] }: {
  label: string; value: string; onChange: (c: string) => void; quick?: string[];
}) {
  const [open, setOpen] = useState(false);
  const chips = [...new Set([value, ...quick])];
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: open ? 8 : 0 }}>
        {chips.map((cur) => (
          <Pressable key={cur} onPress={() => { onChange(cur); setOpen(false); }}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              backgroundColor: cur === value ? c.brand : c.surface2 }}>
            <Text style={{ color: cur === value ? c.bg : c.text2, fontSize: 12.5 }}>
              {cur === value ? `${cur} — ${CURRENCY_NAMES[cur as Currency] ?? cur}` : cur}
            </Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setOpen(!open)}
          style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.brand, fontSize: 12.5 }}>{open ? 'close' : 'change…'}</Text>
        </Pressable>
      </View>
      {open && (
        <CurrencySearchList selected={[value]}
          onPick={(cur) => { onChange(cur); setOpen(false); }} />
      )}
    </View>
  );
}

function BusyOverlay({ scan, onCancel }: { scan: ScanStage; onCancel?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = scan.stage === 'read' ? Math.round((Date.now() - scan.startedAt) / 1000) : 0;
  return (
    <Modal transparent statusBarTranslucent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(6,10,18,0.78)',
        alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <ActivityIndicator accessibilityLabel="Loading" size="large" color={c.brand} />
        {scan.stage === 'upload' ? (
          <>
            <Text style={s.body}>Uploading photo… {Math.round(scan.fraction * 100)}%</Text>
            <View style={{ width: 200, height: 6, borderRadius: 3, backgroundColor: c.surface2 }}>
              <View style={{ width: 200 * Math.min(1, scan.fraction), height: 6,
                borderRadius: 3, backgroundColor: c.brand }} />
            </View>
          </>
        ) : (
          <Text style={s.body}>
            Reading the receipt… {elapsed}s{'  '}
            <Text style={{ color: c.text2 }}>
              {etaCache !== null && elapsed * 1000 > etaCache.slowMs
                ? '(taking longer than usual — still working)'
                : `(usually ~${Math.max(1, Math.round((etaCache?.typicalMs ?? 15000) / 1000))}s)`}
            </Text>
          </Text>
        )}
        {onCancel && <Btn small label="Cancel" onPress={onCancel} />}
      </View>
    </Modal>
  );
}

/**
 * Downscale a photo before upload — slow cellular links choke on the
 * 10-20 MB photos phones produce, and the server only needs ~1600px.
 */
async function shrinkPhoto(uri: string): Promise<{ uri: string; mime: string }> {
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri, [{ resize: { width: 1600 } }],
      { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: out.uri, mime: 'image/jpeg' };
  } catch {
    return { uri, mime: 'image/jpeg' };
  }
}

/**
 * Two-level category picker (#18): headings on the first row, the chosen
 * heading's subcategories on the second. Picking a heading assigns it
 * directly — speed entry still costs one tap — and the leaves are there
 * when someone wants the detail. Hidden categories are omitted unless the
 * expense already uses one.
 */
/**
 * Manage categories (#18) — its own screen, reached from the group.
 *
 * Everything lives in one ScrollView so it survives large system font
 * scales (the Android UI review found fixed-height siblings collapsing the
 * lists they wrap); rows wrap rather than clip.
 */
function ManageCategoriesScreen({ group, onBack }: { group: Group; onBack: () => void }) {
  const [overrides, setOverrides] = useState<Record<string, CategoryOverride> | null>(null);
  const [saved, setSaved] = useState<Record<string, CategoryOverride>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.groupCategories(group.id)
      .then((r) => {
        if (!live) return;
        setOverrides(r.overrides ?? {});
        setSaved(r.overrides ?? {});
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [group.id]);

  const prune = (o: Record<string, CategoryOverride>): Record<string, CategoryOverride> => {
    const out: Record<string, CategoryOverride> = {};
    for (const [slug, v] of Object.entries(o)) {
      const entry: CategoryOverride = {};
      if (typeof v.label === 'string' && v.label.trim() !== '') entry.label = v.label.trim();
      if (v.hidden === true) entry.hidden = true;
      if (typeof v.sortOrder === 'number') entry.sortOrder = v.sortOrder;
      if (Object.keys(entry).length > 0) out[slug] = entry;
    }
    return out;
  };

  const tree = useMemo(() => resolveCategories(overrides ?? {}), [overrides]);
  const dirty = JSON.stringify(prune(overrides ?? {})) !== JSON.stringify(prune(saved));
  const visible = tree.flatMap((h) => [h, ...h.children]).filter((x) => !x.hidden).length;

  function patch(slug: string, change: CategoryOverride) {
    setOverrides((prev) => ({ ...(prev ?? {}), [slug]: { ...(prev?.[slug] ?? {}), ...change } }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveGroupCategories(group.id, prune(overrides ?? {}));
      setOverrides(r.overrides ?? {});
      setSaved(r.overrides ?? {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Btn small label="‹" a11yLabel="Back" onPress={onBack} />
        <Text style={[s.h1, { flex: 1 }]} numberOfLines={1}>Categories</Text>
        {dirty && <Btn small primary label={busy ? 'Saving…' : 'Save'} onPress={save} />}
      </View>
      {overrides === null ? (
        <ActivityIndicator accessibilityLabel="Loading" color={c.brand} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
          <Text style={[s.meta, { paddingBottom: 8 }]}>
            Rename anything to suit {group.name}, and hide what you never use. Hidden
            categories stay on expenses already filed under them.
          </Text>
          {error !== null && <Text style={[s.meta, { color: c.owe }]}>{error}</Text>}
          {tree.map((heading) => (
            <View key={heading.slug}>
              <Text style={s.cap}>{heading.emoji} {heading.label.toUpperCase()}</Text>
              {[heading, ...heading.children].map((cat) => (
                <View key={cat.slug}
                  style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8,
                    paddingVertical: 6, opacity: cat.hidden ? 0.5 : 1 }}>
                  <TextInput keyboardAppearance="dark"
                    value={cat.label}
                    onChangeText={(t) => patch(cat.slug, { label: t })}
                    maxLength={60}
                    accessibilityLabel={`Label for ${cat.defaultLabel}`}
                    style={{ flexGrow: 1, flexBasis: 160, color: c.text, backgroundColor: c.surface2,
                      borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 }} />
                  {cat.renamed && (
                    <Btn small label="Reset" onPress={() => patch(cat.slug, { label: '' })} />
                  )}
                  <Btn small
                    label={cat.hidden ? 'Hidden' : 'Shown'}
                    onPress={() => {
                      if (!cat.hidden && visible === 1) return; // never hide the last one
                      patch(cat.slug, { hidden: !cat.hidden });
                    }} />
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function CategoryPicker({ value, onChange, overrides }: {
  value: string; onChange: (slug: string) => void;
  overrides: Record<string, CategoryOverride>;
}) {
  const tree = useMemo(() => resolveCategories(overrides), [overrides]);
  const headingOf = value.includes('.') ? value.slice(0, value.indexOf('.')) : value;
  const [open, setOpen] = useState(headingOf);
  const current = tree.find((h) => h.slug === open) ?? tree[0];
  // Local style helper predating the shared one above; keep it, but it needs
  // the same 44pt floor (#97).
  const chip = (active: boolean) => ({
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
    minHeight: 44, justifyContent: 'center' as const,
    backgroundColor: active ? c.brand : c.surface2,
  });

  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {tree.filter((h) => !h.hidden || h.slug === value).map((h) => (
          <Pressable key={h.slug} onPress={() => { setOpen(h.slug); onChange(h.slug); }}
            accessibilityRole="button" accessibilityState={{ selected: headingOf === h.slug }}
            style={chip(headingOf === h.slug)}>
            <Text style={{ color: headingOf === h.slug ? c.bg : c.text2, fontSize: 12.5 }}>
              {h.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {current !== undefined && current.children.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {current.children.filter((leaf) => !leaf.hidden || leaf.slug === value).map((leaf) => (
            <Pressable key={leaf.slug} onPress={() => onChange(leaf.slug)}
              accessibilityRole="button" accessibilityState={{ selected: value === leaf.slug }}
              style={chip(value === leaf.slug)}>
              <Text style={{ color: value === leaf.slug ? c.bg : c.text3, fontSize: 12 }}>
                {leaf.emoji} {leaf.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function AddExpenseSheet({ group, user, onClose, onSaved, editing = null, onDeleted, lastCurrency }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
  editing?: Expense | null; onDeleted?: () => void; lastCurrency?: string;
}) {
  const [description, setDescription] = useState(editing?.description ?? '');
  const [notes, setNotes] = useState((editing as (Expense & { notes?: string | null }) | null)?.notes ?? '');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentText, setCommentText] = useState('');
  const [amountStr, setAmountStr] = useState(editing ? minorToAmountString(editing.amountMinor, editing.currency) : '');
  // FR-3.2 (issue #13): all five split methods. Editing re-opens on the
  // stored method; shares/percent/adjustment restore their form inputs
  // from the persisted splitInput (legacy rows without one fall back to
  // the data-faithful exact view).
  const [method, setMethod] = useState<SplitMethod>(() => {
    if (!editing) return 'equal';
    const m = editing.splitMethod as SplitMethod;
    if (m === 'equal' || m === 'exact') return m;
    return editing.splitInput ? m : 'exact';
  });
  const [included, setIncluded] = useState<Set<string>>(() =>
    editing && editing.splitMethod === 'equal'
      ? new Set(editing.shares.map((sh) => sh.userId))
      : new Set(group.members.map((m) => m.id)));
  // Per-member form inputs for the weighted methods, kept separately so
  // flipping between tabs doesn't reinterpret 33.3 shares as 33.3%.
  const [weights, setWeights] = useState<Record<string, Record<string, string>>>(() => {
    const m = editing?.splitMethod as SplitMethod | undefined;
    if (editing?.splitInput && (m === 'shares' || m === 'percent' || m === 'adjustment')) {
      return { [m]: splitInputsFromStored(m, editing.splitInput, editing.currency) };
    }
    return {};
  });
  // Issue #37: who paid was hard-wired to "you" on mobile — now selectable.
  const [payerId, setPayerId] = useState(editing?.payers[0]?.userId ?? user.id);
  // FR-3.3 (issue #14): an expense can be paid by several people. Single
  // payer stays the default; "Multiple…" swaps the chips for per-member
  // amount inputs that must sum to the total (same reconciliation rule
  // as the exact split). Editing a multi-payer expense re-opens in that
  // mode instead of collapsing to payers[0].
  const [multiPayer, setMultiPayer] = useState((editing?.payers.length ?? 0) > 1);
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() => {
    if (!editing) return {};
    const out: Record<string, string> = {};
    for (const p of editing.payers) out[p.userId] = minorToAmountString(p.amountMinor, editing.currency);
    return out;
  });
  // Issue #37 speed entry: category + notes + paid-by tuck behind "More"
  // (opened up front when a multi-payer edit needs the payer rows visible).
  const [showMore, setShowMore] = useState((editing?.payers.length ?? 0) > 1);
  const [error, setError] = useState<string | null>(null);
  // Seed from the expense being edited so a previously scanned receipt
  // stays linked on save and can be viewed/rescanned here.
  const [receiptId, setReceiptId] = useState<string | null>(editing?.receiptId ?? null);
  const [viewingReceipt, setViewingReceipt] = useState<number | null>(null); // index into linked receipts
  const [extraReceiptIds, setExtraReceiptIds] = useState<string[]>(
    editing ? (editing.receiptIds ?? []).filter((id) => id !== editing.receiptId) : [],
  );
  const [scanProg, setScanProg] = useState<ScanStage | null>(null);
  const scanHandle = useRef<{ cancel: () => void } | null>(null);
  const [assigning, setAssigning] = useState<ParsedReceipt | null>(null);
  // The last successful parse, kept so "Split by item" stays available
  // without re-scanning. A scan fills the form directly now — it used to
  // drop the user into item assignment, which meant every receipt cost an
  // extra decision before it could be saved (owner, 2026-07-27).
  const [lastParsed, setLastParsed] = useState<ParsedReceipt | null>(null);
  const scanBusy = scanProg !== null;
  const [exact, setExact] = useState<Record<string, string>>(() => {
    if (!editing) return {};
    const out: Record<string, string> = {};
    for (const sh of editing.shares) out[sh.userId] = minorToAmountString(sh.amountMinor, editing.currency);
    return out;
  });
  // New expenses start in whatever currency the group used last (mid-trip
  // you keep paying in the local currency).
  const [currency, setCurrency] = useState(editing?.currency ?? lastCurrency ?? group.homeCurrency);
  const [category, setCategory] = useState(editing?.category ?? 'dining');
  // Opened from Home's quick-add as well as the group screen, so it fetches
  // the group's category overrides itself (#18).
  const [catOverrides, setCatOverrides] = useState<Record<string, CategoryOverride>>({});
  // In-flight guard + duplicate confirmation (#76).
  const [saving, setSaving] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  useEffect(() => {
    let live = true;
    api.groupCategories(group.id)
      .then((r) => { if (live) setCatOverrides(r.overrides ?? {}); })
      .catch(() => {}); // shipped defaults are a fine fallback
    return () => { live = false; };
  }, [group.id]);
  const [allCurrencies, setAllCurrencies] = useState(false);
  const [date, setDate] = useState(editing?.expenseDate ?? new Date().toISOString().slice(0, 10));
  const amountMinor = parseAmount(amountStr, currency);

  // Keep the number the user sees when the picker moves between
  // currencies of different scales: "950000.00" reparsed as CLP would
  // become 95,000,000 pesos.
  function switchCurrency(next: string) {
    setAmountStr((s) => rescaleAmountString(s, currency, next));
    // Exact shares and payer amounts have to keep summing to the total, so
    // they rescale as a set rather than one at a time (issue #74) —
    // otherwise each rounds half-up on its own and Save locks behind a
    // "remaining: -1" nobody typed.
    setExact((m) => rescaleAmountFields(m, amountStr, currency, next));
    setPayerAmounts((m) => rescaleAmountFields(m, amountStr, currency, next));
    // Adjustment offsets are amounts too; share counts and percents are
    // scale-free.
    setWeights((w) => w.adjustment === undefined ? w : { ...w,
      adjustment: Object.fromEntries(Object.entries(w.adjustment).map(([id, v]) =>
        [id, v.startsWith('-') ? `-${rescaleAmountString(v.slice(1), currency, next)}` : rescaleAmountString(v, currency, next)])) });
    setCurrency(next);
  }

  useEffect(() => {
    if (editing) api.comments(editing.id).then((r) => setComments(r.items)).catch(() => {});
  }, [editing]);

  // Split result per member, plus the SplitError message as the form
  // hint when the inputs don't reconcile yet.
  const { shares, splitHint } = useMemo((): { shares: Record<string, number> | null; splitHint: string | null } => {
    if (amountMinor <= 0) return { shares: null, splitHint: null };
    try {
      if (method === 'exact') {
        const out: Record<string, number> = {};
        for (const m of group.members) {
          const v = parseAmount(exact[m.id] ?? '', currency);
          if (v > 0) out[m.id] = v;
        }
        return { shares: out, splitHint: null }; // "remaining" line covers the hint
      }
      const ids = method === 'equal'
        ? group.members.filter((m) => included.has(m.id)).map((m) => m.id)
        : group.members.map((m) => m.id);
      if (ids.length === 0) return { shares: null, splitHint: 'pick at least one person' };
      const computed = computeSplit(method, amountMinor,
        splitMembersFromInputs(method, ids, weights[method] ?? {}, currency));
      const out: Record<string, number> = {};
      for (const [id, v] of Object.entries(computed)) if (v > 0) out[id] = v;
      return { shares: out, splitHint: null };
    } catch (err) {
      return { shares: null, splitHint: err instanceof SplitError ? err.message : null };
    }
  }, [method, group.members, included, exact, weights, amountMinor, currency]);

  const sharesSum = Object.values(shares ?? {}).reduce((a, b) => a + b, 0);
  const remaining = amountMinor - sharesSum;

  const payers = useMemo((): { userId: string; amountMinor: number }[] => {
    if (!multiPayer) return [{ userId: payerId, amountMinor }];
    const out: { userId: string; amountMinor: number }[] = [];
    for (const m of group.members) {
      const v = parseAmount(payerAmounts[m.id] ?? '', currency);
      if (v > 0) out.push({ userId: m.id, amountMinor: v });
    }
    return out;
  }, [multiPayer, payerId, amountMinor, payerAmounts, group.members, currency]);
  const payersRemaining = amountMinor - payers.reduce((a, p) => a + p.amountMinor, 0);

  async function scan(fromCamera: boolean) {
    setError(null);
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { setError('camera permission is needed to scan receipts'); return; }
      }
      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.8, exif: true })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.8, exif: true });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      // Issue #21 (and #9 item 1): the photo's EXIF GPS knows what
      // country the receipt is from — a better currency hint than the
      // form's current pick. Android reports signed degrees; iOS pairs
      // positive degrees with N/S/E/W refs.
      let localCurrency: string | null = null;
      const exif = asset.exif as {
        GPSLatitude?: number; GPSLongitude?: number;
        GPSLatitudeRef?: string; GPSLongitudeRef?: string;
      } | null | undefined;
      if (typeof exif?.GPSLatitude === 'number' && typeof exif.GPSLongitude === 'number') {
        const lat = exif.GPSLatitudeRef === 'S' ? -Math.abs(exif.GPSLatitude) : exif.GPSLatitude;
        const lon = exif.GPSLongitudeRef === 'W' ? -Math.abs(exif.GPSLongitude) : exif.GPSLongitude;
        localCurrency = currencyForLocation(lat, lon);
      }
      setScanProg({ stage: 'upload', fraction: 0 });
      fetchEta();
      const small = await shrinkPhoto(asset.uri);
      const handle = uploadReceipt(group.id, small.uri, small.mime, {
        onUploadProgress: (fraction) => setScanProg({ stage: 'upload', fraction }),
        onUploaded: () => setScanProg({ stage: 'read', startedAt: Date.now() }),
      }, localCurrency ?? currency);
      scanHandle.current = handle;
      const r = await handle.promise;
      setReceiptId(r.id);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt — enter it manually (photo attached)');
      } else {
        // Pin the parse to a definite currency before any math on it: a
        // parse without one is scaled at 100, which is 100x off for
        // zero-decimal currencies (the 95,000,000-peso Boragó).
        applyParse(r.parsed);
      }
    } catch (e) {
      if (!(e instanceof ApiFailure && e.error.code === 'CANCELED')) {
        setError((e as Error).message);
      }
    } finally {
      setScanProg(null);
      scanHandle.current = null;
    }
  }

  /**
   * Put a parse into the form: merchant, total, currency, date. The split
   * is deliberately untouched, so it stays on the default equal split and
   * the user can just press Save.
   */
  function applyParse(parsed: ParsedReceipt): void {
    const cur = parsed.currency && CURRENCIES.includes(parsed.currency as never)
      ? parsed.currency : currency;
    const pinned = normalizeParsedReceipt(parsed, cur);
    setLastParsed(pinned);
    if (pinned.totalMinor !== null) setAmountStr(minorToAmountString(pinned.totalMinor, cur));
    if (pinned.merchant) setDescription(pinned.merchant);
    if (pinned.currency && CURRENCIES.includes(pinned.currency as never)) setCurrency(pinned.currency);
    if (pinned.date && /^\d{4}-\d{2}-\d{2}$/.test(pinned.date)) setDate(pinned.date);
  }

  /** Re-run the parser on the stored photo — no re-photographing. */
  async function rescan() {
    if (receiptId === null) return;
    setScanProg({ stage: 'read', startedAt: Date.now() });
    setError(null);
    fetchEta();
    try {
      const r = await api.rescanReceipt(receiptId, currency);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt');
      } else {
        applyParse(r.parsed);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanProg(null);
    }
  }

  async function save() {
    // A second tap while the first save is in flight is what filed the
    // same expense twice in production (issue #76).
    if (shares === null || saving) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
        description: description.trim(),
        amountMinor,
        currency,
        expenseDate: date,
        category,
        splitMethod: method,
        payers,
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
        ...(() => {
          const stored = splitInputsToStored(method, group.members.map((m) => m.id), weights[method] ?? {}, currency);
          return stored !== null ? { splitInput: stored } : {};
        })(),
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
        ...(receiptId !== null || extraReceiptIds.length > 0
          ? { receiptIds: [...(receiptId !== null ? [receiptId] : []), ...extraReceiptIds] }
          : {}),
      };
      await (editing
        ? api.updateExpense(editing.id, payload)
        : api.addExpense(group.id, { ...payload, ...(allowDuplicate ? { allowDuplicate: true } : {}) }));
      onSaved();
    } catch (e) {
      // The group already holds this expense — tell the user and turn Save
      // into an explicit confirmation rather than filing it twice (#76).
      if (e instanceof ApiFailure && e.error.code === 'DUPLICATE_EXPENSE') {
        setAllowDuplicate(true);
      }
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SheetModal title={editing ? 'Edit expense' : 'New expense'} onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Field label={`Amount (${currency})`} value={amountStr}
        onChangeText={setAmountStr}
        keyboardType="decimal-pad" placeholder="0.00" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: allCurrencies ? 8 : 12 }}>
        {[...new Set([group.homeCurrency, ...group.currencies, currency])].map((cur) => (
          <Pressable key={cur} onPress={() => switchCurrency(cur)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              backgroundColor: currency === cur ? c.brand : c.surface2 }}>
            <Text style={{ color: currency === cur ? c.bg : c.text2, fontSize: 12.5 }}>{cur}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setAllCurrencies(!allCurrencies)}
          style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.surface2 }}>
          <Text style={{ color: c.brand, fontSize: 12.5 }}>{allCurrencies ? 'close' : 'other…'}</Text>
        </Pressable>
      </View>
      {allCurrencies && (
        <CurrencySearchList selected={[currency]}
          onPick={(cur) => { switchCurrency(cur); setAllCurrencies(false); }} />
      )}
      <Field label="Description" value={description} onChangeText={setDescription} placeholder="Groceries" />
      {/* Issue #37 speed entry: category, who-paid, notes behind "More". */}
      <Pressable onPress={() => setShowMore((v) => !v)} style={{ paddingVertical: 8 }}>
        <Text style={{ color: c.text2, fontSize: 13 }} maxFontSizeMultiplier={1.4}>
          {showMore ? '▾ ' : '▸ '}More options
          {!showMore && (
            <Text style={{ color: c.text3 }}>
              {'  '}{multiPayer
                ? `${payers.length > 1 ? `${payers.length} people` : 'multiple people'} paid`
                : payerId === user.id ? 'you paid' : `${group.members.find((m) => m.id === payerId)?.displayName ?? 'someone'} paid`}
              {' · '}{categoryLabel(category, catOverrides)}{notes.trim() !== '' ? ' · note' : ''}
            </Text>
          )}
        </Text>
      </Pressable>
      {showMore && (
        <>
          <Text style={s.fieldLabel}>Paid by</Text>
          {!multiPayer ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {group.members.map((m) => (
                <Pressable key={m.id} onPress={() => setPayerId(m.id)}
                  style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, minHeight: 44, justifyContent: 'center',
                    backgroundColor: payerId === m.id ? c.brand : c.surface2 }}>
                  <Text style={{ color: payerId === m.id ? c.bg : c.text2, fontSize: 12.5 }}>
                    {m.id === user.id ? 'You' : m.displayName}
                  </Text>
                </Pressable>
              ))}
              <Pressable onPress={() => {
                  // Seed the current payer with the full amount so the user
                  // only moves the other contributions off it — unless edit
                  // state already holds per-payer amounts.
                  setPayerAmounts((m) => {
                    const hasAny = group.members.some((mm) => parseAmount(m[mm.id] ?? '', currency) > 0);
                    return hasAny || amountMinor <= 0 ? m
                      : { ...m, [payerId]: minorToAmountString(amountMinor, currency) };
                  });
                  setMultiPayer(true);
                }}
                style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, backgroundColor: c.surface2 }}>
                <Text style={{ color: c.brand, fontSize: 12.5 }}>Multiple…</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {group.members.map((m) => (
                <View key={m.id} style={s.checkRow}>
                  <Badge id={m.id} name={m.displayName} size={22} />
                  <Text style={[s.body, { flex: 1 }]}>{m.id === user.id ? 'You' : m.displayName}</Text>
                  <TextInput placeholderTextColor={c.text3} keyboardAppearance="dark" placeholder="0.00" keyboardType="decimal-pad"
                    value={payerAmounts[m.id] ?? ''}
                    onChangeText={(v) => setPayerAmounts({ ...payerAmounts, [m.id]: v })}
                    style={[s.input, { minWidth: 96, flexShrink: 1, marginBottom: 0, paddingVertical: 6, textAlign: 'right' }]} />
                </View>
              ))}
              <Text style={[s.meta, { color: payersRemaining === 0 ? c.owed : c.owe, paddingVertical: 4 }]}>
                remaining: {minorToAmountString(payersRemaining, currency)}
              </Text>
              <View style={{ flexDirection: 'row', marginBottom: 8 }}>
                <Btn small label="Single payer" onPress={() => setMultiPayer(false)} />
              </View>
            </>
          )}
          <Text style={s.fieldLabel}>Category</Text>
          <CategoryPicker value={category} onChange={setCategory} overrides={catOverrides} />
          <Field label="Notes (optional)" value={notes} onChangeText={setNotes}
            placeholder="e.g. includes the corkage fee" />
        </>
      )}
      {receiptId !== null && (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn label={`🧾 View receipt${extraReceiptIds.length > 0 ? 's' : ''}`}
              disabled={scanBusy} onPress={() => setViewingReceipt(0)} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn label="↻ Rescan" disabled={scanBusy} onPress={() => void rescan()} />
          </View>
        </View>
      )}
      {/* Splitting item by item is a choice now, not a toll gate: a scanned
          receipt lands filled in and splittable equally, and this is here
          for the times somebody only ate the starter. */}
      {lastParsed !== null && lastParsed.items.length > 0 && (
        <Btn label={`🍽 Split by item (${lastParsed.items.length})`}
          disabled={scanBusy} onPress={() => setAssigning(lastParsed)} />
      )}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Btn label={scanBusy ? 'Reading…' : receiptId ? '📷 New photo' : '📷 Scan receipt'}
            disabled={scanBusy} onPress={() => void scan(true)} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn label="Photo library" disabled={scanBusy} onPress={() => void scan(false)} />
        </View>
      </View>
      {/* FR-3.2 (issue #13): all five split methods */}
      <Text style={s.fieldLabel}>
        {method === 'equal'
          ? (included.size === group.members.length
              ? `Split equally — everyone's in (${group.members.length})`
              : `Split equally between ${included.size} of ${group.members.length}`)
          : method === 'exact' ? 'Split by exact amounts'
          : method === 'shares' ? 'Split by shares (2:1:1 …)'
          : method === 'percent' ? 'Split by percentages'
          : 'Split equally after + / − offsets'}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {([['equal', 'Equal'], ['exact', 'Exact'], ['shares', 'Shares'], ['percent', '%'], ['adjustment', '+/−']] as const).map(([m, label]) => (
          <Pressable key={m} onPress={() => setMethod(m)} {...chip(method === m)}>
            <Text style={{ color: method === m ? c.bg : c.text2, fontSize: 12.5 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {method === 'equal' && (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
          <Btn small label="Everyone" onPress={() => setIncluded(new Set(group.members.map((m) => m.id)))} />
          <Btn small label="Just me" onPress={() => setIncluded(new Set([user.id]))} />
        </View>
      )}
      {group.members.map((m) => {
        const on = included.has(m.id);
        return (
          <Pressable key={m.id} style={s.checkRow} disabled={method !== 'equal'}
            onPress={() => {
              const next = new Set(included);
              on ? next.delete(m.id) : next.add(m.id);
              setIncluded(next);
            }}>
            {/* minWidth, not width, and capped: at accessibility sizes a fixed
                22pt box clipped the glyph, so the user could not tell ☑ from ☐
                — i.e. could not see who was in the split (#96). */}
            {method === 'equal' && (
              <Text maxFontSizeMultiplier={1.6}
                style={{ color: on ? c.brand : c.text3, fontSize: 16, minWidth: 22 }}>{on ? '☑' : '☐'}</Text>
            )}
            <Badge id={m.id} name={m.displayName} size={22} />
            <Text style={[s.body, { flex: 1 }]}>{m.id === user.id ? 'You' : m.displayName}</Text>
            {method !== 'exact' && (
              <Text style={s.meta}>
                {(method !== 'equal' || on) && shares?.[m.id] !== undefined
                  ? minorToAmountString(shares[m.id]!, currency) : '—'}
              </Text>
            )}
            {method === 'exact' && (
              <TextInput placeholderTextColor={c.text3} keyboardAppearance="dark" placeholder="0.00" keyboardType="decimal-pad"
                value={exact[m.id] ?? ''} onChangeText={(v) => setExact({ ...exact, [m.id]: v })}
                style={[s.input, { minWidth: 96, flexShrink: 1, marginBottom: 0, paddingVertical: 6, textAlign: 'right' }]} />
            )}
            {(method === 'shares' || method === 'percent' || method === 'adjustment') && (
              <TextInput placeholderTextColor={c.text3} keyboardAppearance="dark"
                keyboardType={method === 'shares' ? 'number-pad'
                  : method === 'percent' ? 'decimal-pad'
                  : 'numbers-and-punctuation' /* adjustment needs a minus key */}
                placeholder={method === 'shares' ? '0' : method === 'percent' ? '0%' : '±0.00'}
                value={weights[method]?.[m.id] ?? ''}
                onChangeText={(v) => setWeights({ ...weights,
                  [method]: { ...(weights[method] ?? {}), [m.id]: v } })}
                style={[s.input, { minWidth: 76, flexShrink: 1, marginBottom: 0, paddingVertical: 6, textAlign: 'right' }]} />
            )}
          </Pressable>
        );
      })}
      {method === 'exact' && (
        <Text style={[s.meta, { color: remaining === 0 ? c.owed : c.owe, paddingVertical: 4 }]}>
          remaining: {minorToAmountString(remaining, currency)}
        </Text>
      )}
      {splitHint !== null && amountMinor > 0 && (
        <Text style={[s.meta, { color: c.owe, paddingVertical: 4 }]}>{splitHint}</Text>
      )}
      <Btn primary
        label={saving ? 'Saving…' : allowDuplicate ? 'Add it anyway'
          : editing ? 'Save changes' : 'Save expense'}
        disabled={saving || amountMinor <= 0 || description.trim() === '' || shares === null
          || Object.keys(shares).length === 0 || remaining !== 0
          || payers.length === 0 || payersRemaining !== 0}
        onPress={save} />
      {editing && (
        <>
          <Text style={[s.cap, { marginTop: 12 }]}>COMMENTS</Text>
          {(comments ?? []).map((cm) => {
            const member = group.members.find((m) => m.id === cm.userId);
            return (
              <View key={cm.id} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
                <Badge id={cm.userId} name={member?.displayName ?? '?'} size={22} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.body, { fontSize: 13 }]}>
                    <Text style={{ fontWeight: '700' }}>{cm.userId === user.id ? 'You' : member?.displayName ?? 'Former member'}</Text>
                    {' '}{cm.body}
                  </Text>
                  <Text style={s.meta}>{cm.createdAt}</Text>
                </View>
              </View>
            );
          })}
          <Field label="" value={commentText} onChangeText={setCommentText} placeholder="Add a comment…" />
          <Btn small label="Send comment" disabled={commentText.trim() === ''}
            onPress={() => {
              api.addComment(editing.id, commentText.trim())
                .then((cm) => { setComments([...(comments ?? []), cm]); setCommentText(''); })
                .catch((e) => setError((e as Error).message));
            }} />
        </>
      )}
      {editing && onDeleted && (
        <>
          <View style={{ height: 8 }} />
          {/* FR-3.5 asks once before deleting. It used to go on one tap, and
              the undo lives in the expenses-tab header — so deleting from this
              sheet while on Balances or Totals meant no undo was ever seen
              (#100). Styled destructive, per HIG. */}
          <Btn label="Delete this expense" destructive onPress={() => {
            Alert.alert(
              'Delete this expense?',
              'It can be undone from the Expenses tab straight afterwards.',
              [
                { text: 'Keep it', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => {
                    api.deleteExpense(editing.id).then(onDeleted)
                      .catch((e) => setError((e as Error).message));
                  },
                },
              ],
            );
          }} />
        </>
      )}
      {scanProg !== null && <BusyOverlay scan={scanProg} onCancel={() => scanHandle.current?.cancel()} />}
      {viewingReceipt !== null && (() => {
        const ids = [receiptId, ...extraReceiptIds].filter((x): x is string => x !== null);
        if (ids.length === 0) return null;
        const idx = ((viewingReceipt % ids.length) + ids.length) % ids.length;
        return (
          <Modal transparent animationType="fade" onRequestClose={() => setViewingReceipt(null)}>
            <Pressable style={{ flex: 1, backgroundColor: 'rgba(8,12,22,0.92)',
              alignItems: 'center', justifyContent: 'center', gap: 12 }}
              onPress={() => setViewingReceipt(null)}>
              <Image source={receiptImageSource(ids[idx]!)} resizeMode="contain"
                style={{ width: '92%', height: '76%', borderRadius: 10 }}
                accessibilityLabel="Receipt photo" />
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                {ids.length > 1 && (
                  <>
                    <Btn small label="‹" a11yLabel="Previous receipt" onPress={() => setViewingReceipt(idx - 1)} />
                    <Text style={{ color: c.text2, fontSize: 13 }} maxFontSizeMultiplier={1.4}>
                      {idx + 1} / {ids.length}
                    </Text>
                    <Btn small label="›" onPress={() => setViewingReceipt(idx + 1)} />
                  </>
                )}
                <Btn small label="Close" onPress={() => setViewingReceipt(null)} />
              </View>
            </Pressable>
          </Modal>
        );
      })()}
      {assigning !== null && (
        <AssignItemsSheet parsed={assigning} group={group} members={group.members} user={user}
          onCancel={() => setAssigning(null)}
          onDone={(r) => {
            setAssigning(null);
            setExtraReceiptIds(r.receiptIds);
            setAmountStr(minorToAmountString(r.totalMinor,
              r.currency && CURRENCIES.includes(r.currency as never) ? r.currency : currency));
            if (r.merchant) setDescription(r.merchant);
            if (r.currency && CURRENCIES.includes(r.currency as never)) setCurrency(r.currency);
            if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) setDate(r.date);
            const cur = r.currency && CURRENCIES.includes(r.currency as never) ? r.currency : currency;
            setMethod('exact');
            setExact(Object.fromEntries(Object.entries(r.shares).map(([uid, v]) =>
              [uid, minorToAmountString(v, cur)])));
          }} />
      )}
    </SheetModal>
  );
}

// ---- Receipt item assignment (mobile port of the web sheet) ----

function AssignItemsSheet({ parsed, group, members, user, onCancel, onDone }: {
  parsed: ParsedReceipt;
  group: Group;
  members: Member[];
  user: User;
  onCancel: () => void;
  onDone: (r: {
    totalMinor: number; currency: string | null; merchant: string | null;
    date: string | null; shares: Record<string, number>; receiptIds: string[];
  }) => void;
}) {
  const [assign, setAssign] = useState<Record<number, Set<string>>>({});
  const rcur = parsed.currency && /^[A-Z]{3}$/.test(parsed.currency) ? parsed.currency : group.homeCurrency;
  const [slip, setSlip] = useState<{ tipMinor: number; receiptId: string } | null>(null);
  const [slipScan, setSlipScan] = useState<ScanStage | null>(null);
  const slipHandle = useRef<{ cancel: () => void } | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);
  const slipBusy = slipScan !== null;
  // Issue #23: parsed lines that aren't part of the bill (loyalty
  // credits, promo blurbs) can be ignored — they then count toward
  // nothing and don't block Continue.
  const [ignoredItems, setIgnoredItems] = useState<Set<number>>(new Set());
  const { totalMinor, extraMinor: extra } = receiptBill(parsed, ignoredItems, slip?.tipMinor ?? 0);
  const billTotal = totalMinor - (slip?.tipMinor ?? 0);

  // Issue #9: the card slip carries the final total with tip — scan it,
  // take the difference over the bill as the tip, prorate like tax.
  async function scanSlip() {
    setSlipError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setSlipError('camera permission is needed'); return; }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      setSlipScan({ stage: 'upload', fraction: 0 });
      fetchEta();
      const small = await shrinkPhoto(asset.uri);
      const handle = uploadReceipt(group.id, small.uri, small.mime, {
        onUploadProgress: (fraction) => setSlipScan({ stage: 'upload', fraction }),
        onUploaded: () => setSlipScan({ stage: 'read', startedAt: Date.now() }),
      }, rcur);
      slipHandle.current = handle;
      const r = await handle.promise;
      // Slip amounts arrive in the slip parse's own scale — bridge to the
      // bill's currency before comparing totals.
      const slipTotal = r.parsed === null ? null
        : normalizeParsedReceipt(r.parsed, rcur).totalMinor;
      if (slipTotal === null) {
        setSlipError('could not read a total on that slip — you can adjust the amount after Continue');
        return;
      }
      const tip = slipTotal - billTotal;
      if (tip < 0) {
        setSlipError('the card slip total is lower than the bill — check you scanned the right photos');
        return;
      }
      setSlip({ tipMinor: tip, receiptId: r.id });
    } catch (e) {
      if (!(e instanceof ApiFailure && e.error.code === 'CANCELED')) {
        setSlipError((e as Error).message);
      }
    } finally {
      setSlipScan(null);
      slipHandle.current = null;
    }
  }
  const allAssigned = allItemsAssigned(parsed.items, assign, ignoredItems);

  function toggleIgnored(itemIndex: number) {
    setIgnoredItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemIndex)) {
        next.delete(itemIndex);
      } else {
        next.add(itemIndex);
        setAssign((a) => ({ ...a, [itemIndex]: new Set() }));
      }
      return next;
    });
  }

  /** Shared math (@slytab/core): equal split per item, extra prorated. */
  const perMember = useMemo(
    () => assignedShares(parsed.items, assign, ignoredItems, extra),
    [assign, parsed.items, ignoredItems, extra],
  );

  return (
    <SheetModal title="Assign items" onClose={onCancel}>
      <Text style={[s.meta, { marginBottom: 8 }]}>
        {parsed.merchant ?? 'Receipt'} · total {minorToAmountString(totalMinor, rcur)}
        {parsed.currency ? ` ${parsed.currency}` : ''}
        {extra !== 0 ? ` (incl. ${minorToAmountString(extra, rcur)} tax/tip, prorated)` : ''}
      </Text>
      {parsed.items.map((item, i) => {
        const off = ignoredItems.has(i);
        return (
          <View key={i} style={[s.row, { flexWrap: 'wrap', opacity: off ? 0.45 : 1 }]}>
            <View style={{ flex: 1, minWidth: 120 }}>
              <Text style={[s.rowName, off && { textDecorationLine: 'line-through' }]}>{item.name}</Text>
              <Text style={s.meta}>
                {item.quantity !== 1 ? `${item.quantity} × ` : ''}{minorToAmountString(item.totalMinor, rcur)}
                {off ? ' · ignored — not part of the bill' : ''}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
              {!off && members.map((m) => {
                const on = assign[i]?.has(m.id) ?? false;
                return (
                  <Pressable key={m.id}
                    onPress={() => setAssign((prev) => {
                      const next = { ...prev };
                      const set = new Set(next[i] ?? []);
                      set.has(m.id) ? set.delete(m.id) : set.add(m.id);
                      next[i] = set;
                      return next;
                    })}
                    accessibilityRole="button"
                    accessibilityLabel={`${on ? 'Unassign' : 'Assign'} ${item.name} ${on ? 'from' : 'to'} ${m.displayName}`}
                    accessibilityState={{ selected: on }}
                    // 44pt minimum: these were ~30pt with 4pt between them,
                    // and mis-tapping one changes who owes what (issue #52).
                    hitSlop={8}
                    style={{ opacity: on ? 1 : 0.35, padding: 2, borderRadius: 14,
                      minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
                      borderWidth: 2, borderColor: on ? c.brand : 'transparent' }}>
                    <Badge id={m.id} name={m.displayName} size={22} />
                  </Pressable>
                );
              })}
              <Pressable onPress={() => toggleIgnored(i)} hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={off ? `Restore ${item.name}` : `Ignore ${item.name}`}
                style={{ padding: 4, minWidth: 44, minHeight: 44,
                  alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: c.text2, fontSize: 15 }} maxFontSizeMultiplier={1.4}>{off ? '↩' : '✕'}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {!allAssigned && (
        <Btn label="Split the rest equally"
          onPress={() => setAssign((prev) => {
            const next = { ...prev };
            parsed.items.forEach((_, i) => {
              if (!ignoredItems.has(i) && (next[i]?.size ?? 0) === 0) {
                next[i] = new Set(members.map((m) => m.id));
              }
            });
            return next;
          })} />
      )}
      {slipError !== null && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{slipError}</Text>}
      <Btn label={slip !== null
          ? `Tip from card slip: ${minorToAmountString(slip.tipMinor, rcur)} ✓ — rescan`
          : 'Scan card slip (adds the tip)'}
        disabled={slipBusy} onPress={() => void scanSlip()} />
      <Text style={[s.meta, { marginVertical: 8 }]}>
        {members.filter((m) => (perMember[m.id] ?? 0) !== 0)
          .map((m) => `${m.id === user.id ? 'You' : m.displayName} ${minorToAmountString(perMember[m.id] ?? 0, rcur)}`)
          .join(' · ') || 'Tap the badges to assign each item.'}
      </Text>
      <Btn primary label="Continue" disabled={!allAssigned}
        onPress={() => onDone({
          totalMinor, currency: parsed.currency, merchant: parsed.merchant,
          date: parsed.date, shares: perMember,
          receiptIds: slip !== null ? [slip.receiptId] : [],
        })} />
      {slipScan !== null && <BusyOverlay scan={slipScan} onCancel={() => slipHandle.current?.cancel()} />}
    </SheetModal>
  );
}

function SettleSheet({ group, to, suggested, onClose, onDone }: {
  group: Group; to: Member; suggested: number; onClose: () => void; onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const amountMajor = minorToAmountString(suggested, group.homeCurrency);
  const handles = to.paymentHandles;

  async function record(method: string, url?: string) {
    setError(null);
    try {
      if (url) await Linking.openURL(url).catch(() => {});
      await api.settle(group.id, to.id, suggested, method);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SheetModal title={`You pay ${to.displayName}`} onClose={onClose}>
      {error && <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={s.error}>{error}</Text>}
      <Text style={[s.body, { textAlign: 'center', fontSize: 28, marginBottom: 14, fontVariant: ['tabular-nums'] }]}>
        {formatMinor(suggested, group.homeCurrency)}
      </Text>
      {handles.interacEmail && (
        <Btn primary label="Interac e-Transfer"
          onPress={() => record('interac',
            `mailto:${handles.interacEmail}?subject=${encodeURIComponent(`Interac e-Transfer: $${amountMajor}`)}`)} />
      )}
      {handles.paypalMe && (
        <Btn label="PayPal.Me"
          onPress={() => record('paypal',
            `https://paypal.me/${handles.paypalMe}/${amountMajor}${group.homeCurrency}`)} />
      )}
      {handles.venmo && (
        <Btn label="Venmo"
          onPress={() => record('venmo',
            `https://venmo.com/${handles.venmo}?txn=pay&amount=${amountMajor}&note=${encodeURIComponent(`${group.name} (via SlyTab)`)}`)} />
      )}
      <Btn label="Record cash or other" onPress={() => record('cash')} />
      <Text style={[s.meta, { textAlign: 'center', marginTop: 8 }]}>
        SlyTab never holds your money — {to.displayName} confirms when it arrives.
      </Text>
    </SheetModal>
  );
}

// ---------- styles (Ledger tokens) ----------

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: c.bg },
  // Top/bottom system-bar clearance comes from the AppShell insets.
  screen: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 16, paddingTop: 12 },
  center: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 14 },
  wordmark: { color: c.text, fontSize: 34, fontWeight: '600', letterSpacing: -0.5 },
  tagline: { color: c.text2, fontSize: 15, textAlign: 'center', maxWidth: 280, marginBottom: 8 },
  h1: { color: c.text, fontSize: 22, fontWeight: '600' },
  h2: { color: c.text, fontSize: 17, fontWeight: '600' },
  body: { color: c.text, fontSize: 14 },
  meta: { color: c.text3, fontSize: 12 },
  cap: { color: c.text3, fontSize: 10.5, letterSpacing: 1.4, fontWeight: '600', paddingVertical: 10 },
  hero: {
    backgroundColor: c.surface, borderColor: c.outline, borderWidth: 1,
    borderRadius: 16, padding: 16, marginBottom: 14, gap: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    backgroundColor: c.surface, borderColor: c.outline, borderWidth: 1,
    borderRadius: 12, padding: 12, marginBottom: 8,
  },
  rowName: { color: c.text, fontSize: 14, fontWeight: '600' },
  // Home cards (issue #20 design pass)
  tile: {
    minWidth: 44, minHeight: 44, aspectRatio: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surface2, borderColor: c.outline, borderWidth: 1,
  },
  pairline: { color: c.text2, fontSize: 12, lineHeight: 18 },
  pairAmt: { fontVariant: ['tabular-nums'], fontSize: 12, fontWeight: '600' },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#0c1220', fontWeight: '600', fontSize: 12 },
  btn: {
    backgroundColor: c.surface2, borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', marginBottom: 8,
    // The compact variant was fixed for 44pt in #62 and the main one was
    // missed — it measured ~41pt, on Sign in, Save expense, Settle and
    // Delete (#97).
    minHeight: 44, justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: c.brand },
  btnDestructive: { backgroundColor: 'rgba(239,93,107,0.14)', borderColor: c.danger, borderWidth: 1 },
  // 44dp minimum hit area — the compact buttons measured 30dp tall (#62).
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12, marginBottom: 0,
    minHeight: 44, justifyContent: 'center' },
  btnText: { color: c.text, fontWeight: '600', fontSize: 14 },
  fieldLabel: { color: c.text3, fontSize: 11.5, marginBottom: 4 },
  input: {
    backgroundColor: c.surface2, borderColor: c.outline, borderWidth: 1,
    borderRadius: 10, color: c.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    minHeight: 44,
  },
  link: { color: c.brand, fontSize: 13, textAlign: 'center', padding: 10,
    minHeight: 44, textAlignVertical: 'center' },
  error: {
    color: c.text, backgroundColor: 'rgba(239,93,107,0.14)', borderColor: c.danger,
    borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 10,
  },
  tabs: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: 10, padding: 3, marginBottom: 12 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8,
    minHeight: 44, justifyContent: 'center' },
  tabOn: { backgroundColor: c.surface },
  tabText: { color: c.text2, fontWeight: '600', fontSize: 13 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7,
    minHeight: 44 },
  sheetBack: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(4,7,14,0.62)' },
  sheet: {
    backgroundColor: c.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    padding: 16, maxHeight: '88%',
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.outline, alignSelf: 'center', marginBottom: 12 },
  sheetTitle: { color: c.text, fontSize: 16, fontWeight: '600', marginBottom: 12 },
  fab: {
    position: 'absolute', right: 18, bottom: 26, width: 56, height: 56, borderRadius: 28,
    backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center', elevation: 6,
  },
  // Labelled variant — the primary "Add expense" action on Home (issue #20).
  fabWide: { width: 'auto', paddingHorizontal: 20, flexDirection: 'row', gap: 7 },
  // Bottom tab shell (UI spec §1). The AppShell already pads for the
  // gesture bar, so the bar only needs its own height. 44pt+ targets.
  tabbar: {
    flexDirection: 'row', backgroundColor: c.surface,
    borderTopWidth: 1, borderTopColor: c.outline,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingTop: 7, paddingBottom: 6, gap: 2, minHeight: 52 },
  tabIcon: { fontSize: 19, lineHeight: 24 },
  // Fixed box so the avatar Badge and the emoji glyphs occupy the same
  // height — otherwise the Profile label sits higher than the other three
  // once the system font grows (issue #63).
  tabIconBox: { height: 24, justifyContent: 'center', alignItems: 'center' },
  tabBarLabel: { color: c.text3, fontSize: 10.5, fontWeight: '600' },
});
