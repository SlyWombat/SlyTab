import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Notifications from 'expo-notifications';
import { CATEGORIES, CATEGORY_LABELS, computeSplit, convertAcrossMinor, CURRENCIES, CURRENCY_NAMES, formatMinor, GROUP_EMOJI, minorToAmountString, normalizeParsedReceipt, parseAmount, rescaleAmountString, bridgeMinor, minorUnitScale, tokens, type Category, type Currency } from '@slytab/core';
import {
  api, ApiFailure, setToken, uploadReceipt,
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
    <View style={[s.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: badgeColor(id) }]}>
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
  return <Text style={{ color, fontSize: size, fontVariant: ['tabular-nums'], fontWeight: '600' }} maxFontSizeMultiplier={1.5}>{text}</Text>;
}

function Btn({ label, onPress, primary = false, disabled = false, small = false }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean; small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn, primary && s.btnPrimary, small && s.btnSmall,
        (disabled || pressed) && { opacity: disabled ? 0.45 : 0.8 },
      ]}
    >
      <Text style={[s.btnText, primary && { color: '#fff' }, small && { fontSize: 12 }]}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, ...input }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor={c.text3} {...input} style={[s.input, input.style]} />
    </View>
  );
}

function SheetModal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable style={s.sheetBack} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.grabber} />
          <Text style={s.sheetTitle}>{title}</Text>
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

const TOKEN_KEY = 'slytab.session';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [nav, setNav] = useState<Nav>({ screen: 'home' });

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

  return (
    <View style={s.app}>
      {restoring ? (
        <View style={[s.screen, { justifyContent: 'center' }]}>
          <ActivityIndicator color={c.brand} />
        </View>
      ) : user === null ? (
        <AuthScreen onSignedIn={signedIn} />
      ) : nav.screen === 'group' ? (
        <GroupScreen groupId={nav.groupId} user={user} onBack={() => setNav({ screen: 'home' })} />
      ) : (
        <HomeScreen
          user={user}
          onUserUpdated={setUser}
          onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })}
          onSignOut={() => {
            api.logout().catch(() => {});
            setToken(null);
            setUser(null);
            SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
          }}
        />
      )}
      <StatusBar style="light" />
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
    <KeyboardAvoidingView style={s.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={s.wordmark}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
      <Text style={s.tagline}>Split expenses with the people you actually share life with.</Text>
      {error && <Text style={s.error}>{error}</Text>}
      <View style={{ width: '100%', maxWidth: 340 }}>
        {mode === 'create' && (
          <Field label="Your name" value={name} onChangeText={setName} autoCapitalize="words" />
        )}
        <Field label="Email" value={email} onChangeText={setEmail}
          autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Field label={mode === 'create' ? 'Password (10+ characters)' : 'Password'}
          value={password} onChangeText={setPassword} secureTextEntry />
        <Btn primary disabled={busy}
          label={busy ? '…' : mode === 'create' ? 'Create account' : 'Sign in'}
          onPress={submit} />
        <Pressable onPress={() => setMode(mode === 'create' ? 'signin' : 'create')}>
          <Text style={s.link}>
            {mode === 'create' ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function HomeScreen({ user, onOpenGroup, onSignOut, onUserUpdated }: {
  user: User; onOpenGroup: (id: string) => void; onSignOut: () => void;
  onUserUpdated: (u: User) => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [creating, setCreating] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload, user.defaultCurrency]);

  const total = data?.total ?? null;
  const incoming = (data?.pendingSettlements ?? []).filter((p) => p.toUserId === user.id);

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Text style={s.h1}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
        <View style={{ flex: 1 }} />
        <Btn small label="Profile" onPress={() => setProfileOpen(true)} />
      </View>
      {error && <Text style={s.error}>{error}</Text>}

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
        {total === null ? <ActivityIndicator color={c.brand} /> : total.minor === 0
          ? <Text style={{ color: c.text2, fontSize: 26, fontWeight: '600' }}>All settled up ✓</Text>
          : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {total.approximate && <Text style={{ color: c.text2, fontSize: 22 }}>≈</Text>}
              <Amount minor={total.minor} currency={total.currency} signed size={30} />
            </View>
          )}
        <Text style={s.meta}>
          {data === null ? 'Loading'
            : `Across ${data.items.length} groups`
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

      <FlatList
        data={(data?.items ?? []).filter((i) => !i.group.isDirect)}
        keyExtractor={(i) => i.group.id}
        onRefresh={reload}
        refreshing={false}
        ListHeaderComponent={(data?.items ?? []).some((i) => i.group.isDirect) ? (
          <View>
            <Text style={s.cap}>FRIENDS</Text>
            {(data?.items ?? []).filter((i) => i.group.isDirect).map(({ group, netMinor, currency }) => {
              const other = group.members.find((m) => m.id !== user.id);
              return (
                <Pressable style={s.row} key={group.id} onPress={() => onOpenGroup(group.id)}>
                  <Badge id={other?.id ?? group.id} name={other?.displayName ?? '?'} />
                  <Text style={[s.rowName, { flex: 1 }]}>{other?.displayName ?? 'Friend'}</Text>
                  {netMinor === 0 ? <Text style={s.meta}>settled ✓</Text> : (
                    <View style={{ alignItems: 'flex-end' }}>
                      <Amount minor={netMinor} currency={currency} signed />
                      <Text style={s.meta}>{netMinor > 0 ? 'owes you' : 'you owe'}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
            <Text style={s.cap}>GROUPS</Text>
          </View>
        ) : null}
        ListEmptyComponent={data ? <Text style={s.meta}>No groups yet — create one.</Text> : null}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => onOpenGroup(item.group.id)}>
            <Text style={{ fontSize: 22 }}>{item.group.emoji || '👥'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.rowName}>{item.group.name}</Text>
              <Text style={s.meta}>{item.group.members.map((m) => m.displayName).join(', ')}</Text>
            </View>
            {item.netMinor === 0
              ? <Text style={s.meta}>settled ✓</Text>
              : <Amount minor={item.netMinor} currency={item.currency} signed />}
          </Pressable>
        )}
      />

      <Pressable style={s.fab} onPress={() => setCreating(true)}>
        <Text style={{ color: '#fff', fontSize: 30, lineHeight: 34 }} maxFontSizeMultiplier={1}>+</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 10 }}>
        <Btn small label="Split with a friend" onPress={() => setAddingFriend(true)} />
      </View>
      {addingFriend && (
        <AddFriendSheet onClose={() => setAddingFriend(false)}
          onCreated={(id) => { setAddingFriend(false); onOpenGroup(id); }} />
      )}
      {creating && (
        <CreateGroupSheet defaultCurrency={user.defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onOpenGroup(id); }} />
      )}
      {profileOpen && (
        <ProfileSheet user={user} onClose={() => setProfileOpen(false)} onSignOut={onSignOut}
          onSaved={(u) => { onUserUpdated(u); setProfileOpen(false); }} />
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
  if (label === 'mobile') return 'Android app';
  return label || 'Unknown device';
}

function ProfileSheet({ user, onClose, onSaved, onSignOut }: {
  user: User; onClose: () => void; onSaved: (u: User) => void; onSignOut: () => void;
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

  useEffect(() => {
    api.listSessions().then((r) => setSessions(r.items)).catch(() => {});
  }, []);

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
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetModal title="Profile" onClose={onClose}>
      {error && <Text style={s.error}>{error}</Text>}
      <Field label="Display name" value={displayName} onChangeText={setDisplayName} />
      <CurrencySingleField label="Home currency — your overall balance shows in this"
        value={currency} onChange={setCurrency} />
      <Text style={s.fieldLabel}>Notifications</Text>
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
        {([['all', 'Everything'], ['important', 'Important only'], ['none', 'Nothing']] as const).map(([v, label]) => (
          <Pressable key={v} onPress={() => setNotifyLevel(v)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              backgroundColor: notifyLevel === v ? c.brand : c.surface2 }}>
            <Text style={{ color: notifyLevel === v ? '#fff' : c.text2, fontSize: 12.5 }}>{label}</Text>
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
    </SheetModal>
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
      {error && <Text style={s.error}>{error}</Text>}
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
      {error && <Text style={s.error}>{error}</Text>}
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
      {error && <Text style={s.error}>{error}</Text>}
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
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [totals, setTotals] = useState<GroupTotals | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Expense | null>(null);
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
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
    api.group(groupId).then(setGroup).catch(() => {});
    api.balances(groupId).then(setBalances).catch(() => {});
    api.groupTotals(groupId).then(setTotals).catch(() => {});
    api.activity(groupId).then((r) => setFeed(r.items)).catch(() => {});
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
    return <View style={s.screen}><Btn small label="‹ Back" onPress={onBack} /><ActivityIndicator color={c.brand} style={{ marginTop: 40 }} /></View>;
  }
  const myNet = balances?.net[user.id] ?? 0;

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Btn small label="‹" onPress={onBack} />
        <Text style={{ fontSize: 22 }}>{group.emoji || '👥'}</Text>
        <Pressable style={{ flex: 1 }} onPress={() => { if (!group.isDirect) setSettingsOpen(true); }}>
          <Text style={s.h2}>
            {group.isDirect
              ? group.members.find((m) => m.id !== user.id)?.displayName ?? 'Friend'
              : group.name}
            {!group.isDirect && <Text style={[s.meta, { fontSize: 12 }]}> ✎</Text>}
          </Text>
          <Text style={s.meta}>
            {group.isDirect ? `just the two of you · ${group.homeCurrency}` : `${group.members.length} members · ${group.homeCurrency}`}
          </Text>
        </Pressable>
        {myNet === 0 ? <Text style={s.meta}>settled ✓</Text>
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
            {CATEGORIES.map((cat) => (
              <Pressable key={cat} onPress={() => setCatFilter(catFilter === cat ? '' : cat)}
                style={{ paddingVertical: 4, paddingHorizontal: 9, borderRadius: 11,
                  backgroundColor: catFilter === cat ? c.brand : c.surface2 }}>
                <Text style={{ color: catFilter === cat ? '#fff' : c.text2, fontSize: 11.5 }}>
                  {CATEGORY_LABELS[cat]}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {tab === 'expenses' ? (
        <FlatList
          data={expenses}
          keyExtractor={(e) => e.id}
          onRefresh={reload}
          refreshing={false}
          ListEmptyComponent={<Text style={s.meta}>No expenses yet.</Text>}
          ListHeaderComponent={lastDeleted === null ? null : (
            <View style={[s.row, { borderColor: c.owe }]}>
              <Text style={[s.body, { flex: 1, fontSize: 12.5 }]}>Deleted "{lastDeleted.description}"</Text>
              <Btn small label="Undo" onPress={() => {
                api.restoreExpense(lastDeleted.id).then(() => { setLastDeleted(null); reload(); }).catch(() => {});
              }} />
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
                      <Text style={s.meta}>{effect > 0 ? 'you lent' : 'you borrowed'}</Text>
                    </>
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      ) : tab === 'activity' ? (
        <ScrollView>
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
        </ScrollView>
      ) : tab === 'totals' ? (
        <ScrollView>
          {totals === null ? <ActivityIndicator color={c.brand} /> : (
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
              {totals.byCategory.map((cat) => (
                <View style={s.row} key={cat.category}>
                  <Text style={[s.body, { flex: 1 }]}>{CATEGORY_LABELS[cat.category as Category] ?? cat.category}</Text>
                  <Amount minor={cat.minor} currency={group.homeCurrency} />
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
        </ScrollView>
      ) : (
        <ScrollView>
          {group.members.map((m) => (
            <View style={s.row} key={m.id}>
              <Badge id={m.id} name={m.displayName} />
              <Text style={[s.rowName, { flex: 1 }]}>{m.id === user.id ? 'You' : m.displayName}</Text>
              {(balances?.net[m.id] ?? 0) === 0 ? <Text style={s.meta}>settled ✓</Text>
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
        </ScrollView>
      )}

      <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 10 }}>
        <Btn small label="Invite"
          onPress={() => api.createInvite(group.id)
            .then((i) => setInviteLink(`https://electricrv.ca/slytab/join/${i.token}`))} />
        {group.archivedAt === null && (
          <Btn small label="Import from Splitwise" onPress={() => setImporting(true)} />
        )}
      </View>
      {inviteLink && (
        <InviteSheet group={group} link={inviteLink} onClose={() => setInviteLink(null)} />
      )}

      {group.archivedAt === null && (
        <Pressable style={s.fab} onPress={() => setAdding(true)}>
          <Text style={{ color: '#fff', fontSize: 30, lineHeight: 34 }} maxFontSizeMultiplier={1}>+</Text>
        </Pressable>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user}
          lastCurrency={expenses[0]?.currency}
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
    imported: { expenses: number; settlements: number; skipped: number }; invited: string[];
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
      {error && <Text style={s.error}>{error}</Text>}
      {result !== null ? (
        <>
          <Text style={[s.body, { marginBottom: 10 }]}>
            Imported {result.imported.expenses} expenses and {result.imported.settlements} settlements
            {result.imported.skipped > 0 ? ` · ${result.imported.skipped} personal expenses skipped` : ''}.
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
                <Text style={{ color: g.id === swGroupId ? '#fff' : c.text2, fontSize: 13 }}>{g.name}</Text>
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

function InviteSheet({ group, link, onClose }: { group: Group; link: string; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <SheetModal title="Invite to group" onClose={onClose}>
      {error && <Text style={s.error}>{error}</Text>}
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
              <Text style={{ color: c.brand, width: 14, fontSize: 13 }}>{on ? '✓' : ''}</Text>
              <Text style={{ color: c.text, fontWeight: '700', width: 44, fontSize: 13.5 }}>{cur}</Text>
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
              <Text style={{ color: '#fff', fontSize: 12.5 }}>{cur} ✕</Text>
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
            <Text style={{ color: cur === value ? '#fff' : c.text2, fontSize: 12.5 }}>
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
        <ActivityIndicator size="large" color={c.brand} />
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

function AddExpenseSheet({ group, user, onClose, onSaved, editing = null, onDeleted, lastCurrency }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
  editing?: Expense | null; onDeleted?: () => void; lastCurrency?: string;
}) {
  const [description, setDescription] = useState(editing?.description ?? '');
  const [notes, setNotes] = useState((editing as (Expense & { notes?: string | null }) | null)?.notes ?? '');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentText, setCommentText] = useState('');
  const [amountStr, setAmountStr] = useState(editing ? minorToAmountString(editing.amountMinor, editing.currency) : '');
  const [included, setIncluded] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  const [error, setError] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [extraReceiptIds, setExtraReceiptIds] = useState<string[]>([]);
  const [scanProg, setScanProg] = useState<ScanStage | null>(null);
  const scanHandle = useRef<{ cancel: () => void } | null>(null);
  const [assigning, setAssigning] = useState<ParsedReceipt | null>(null);
  const scanBusy = scanProg !== null;
  const [exactShares, setExactShares] = useState<Record<string, number> | null>(() => {
    if (!editing) return null;
    const out: Record<string, number> = {};
    for (const sh of editing.shares) out[sh.userId] = sh.amountMinor;
    return out;
  });
  // New expenses start in whatever currency the group used last (mid-trip
  // you keep paying in the local currency).
  const [currency, setCurrency] = useState(editing?.currency ?? lastCurrency ?? group.homeCurrency);
  const [category, setCategory] = useState(editing?.category ?? 'dining');
  const [allCurrencies, setAllCurrencies] = useState(false);
  const [date, setDate] = useState(editing?.expenseDate ?? new Date().toISOString().slice(0, 10));
  const amountMinor = parseAmount(amountStr, currency);

  // Keep the number the user sees when the picker moves between
  // currencies of different scales: "950000.00" reparsed as CLP would
  // become 95,000,000 pesos.
  function switchCurrency(next: string) {
    setAmountStr((s) => rescaleAmountString(s, currency, next));
    setExactShares((m) => m === null ? null : Object.fromEntries(
      Object.entries(m).map(([id, v]) => [id, bridgeMinor(v, minorUnitScale(currency), next)]),
    ));
    setCurrency(next);
  }

  useEffect(() => {
    if (editing) api.comments(editing.id).then((r) => setComments(r.items)).catch(() => {});
  }, [editing]);

  const shares = useMemo(() => {
    if (exactShares !== null) return exactShares;
    const ids = group.members.filter((m) => included.has(m.id)).map((m) => ({ id: m.id }));
    if (ids.length === 0 || amountMinor <= 0) return null;
    try { return computeSplit('equal', amountMinor, ids); } catch { return null; }
  }, [exactShares, group.members, included, amountMinor]);

  async function scan(fromCamera: boolean) {
    setError(null);
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { setError('camera permission is needed to scan receipts'); return; }
      }
      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      setScanProg({ stage: 'upload', fraction: 0 });
      fetchEta();
      const small = await shrinkPhoto(asset.uri);
      const handle = uploadReceipt(group.id, small.uri, small.mime, {
        onUploadProgress: (fraction) => setScanProg({ stage: 'upload', fraction }),
        onUploaded: () => setScanProg({ stage: 'read', startedAt: Date.now() }),
      }, currency);
      scanHandle.current = handle;
      const r = await handle.promise;
      setReceiptId(r.id);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt — enter it manually (photo attached)');
      } else {
        // Pin the parse to a definite currency before any math on it: a
        // parse without one is scaled at 100, which is 100x off for
        // zero-decimal currencies (the 95,000,000-peso Boragó).
        const cur = r.parsed.currency && CURRENCIES.includes(r.parsed.currency as never)
          ? r.parsed.currency : currency;
        setAssigning(normalizeParsedReceipt(r.parsed, cur));
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

  async function save() {
    if (shares === null) return;
    setError(null);
    try {
      const payload = {
        description: description.trim(),
        amountMinor,
        currency,
        expenseDate: date,
        category,
        splitMethod: exactShares !== null ? 'exact' : 'equal',
        payers: [{ userId: editing?.payers[0]?.userId ?? user.id, amountMinor }],
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
        ...(receiptId !== null || extraReceiptIds.length > 0
          ? { receiptIds: [...(receiptId !== null ? [receiptId] : []), ...extraReceiptIds] }
          : {}),
      };
      await (editing ? api.updateExpense(editing.id, payload) : api.addExpense(group.id, payload));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SheetModal title={editing ? 'Edit expense' : 'New expense'} onClose={onClose}>
      {error && <Text style={s.error}>{error}</Text>}
      <Field label={`Amount (${currency})`} value={amountStr}
        onChangeText={(v) => { setAmountStr(v); setExactShares(null); }}
        keyboardType="decimal-pad" placeholder="0.00" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: allCurrencies ? 8 : 12 }}>
        {[...new Set([group.homeCurrency, ...group.currencies, currency])].map((cur) => (
          <Pressable key={cur} onPress={() => switchCurrency(cur)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              backgroundColor: currency === cur ? c.brand : c.surface2 }}>
            <Text style={{ color: currency === cur ? '#fff' : c.text2, fontSize: 12.5 }}>{cur}</Text>
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
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes}
        placeholder="e.g. includes the corkage fee" />
      <Text style={s.fieldLabel}>Category</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {CATEGORIES.map((cat) => (
          <Pressable key={cat} onPress={() => setCategory(cat)}
            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12,
              backgroundColor: category === cat ? c.brand : c.surface2 }}>
            <Text style={{ color: category === cat ? '#fff' : c.text2, fontSize: 12.5 }}>
              {CATEGORY_LABELS[cat]}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Btn label={scanBusy ? 'Reading…' : receiptId ? 'Rescan receipt' : '📷 Scan receipt'}
            disabled={scanBusy} onPress={() => void scan(true)} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn label="Photo library" disabled={scanBusy} onPress={() => void scan(false)} />
        </View>
      </View>
      {exactShares !== null ? (
        <>
          <Text style={s.fieldLabel}>Split from receipt</Text>
          {Object.entries(exactShares).map(([uid, v]) => {
            const m = group.members.find((mm) => mm.id === uid);
            return (
              <View key={uid} style={s.checkRow}>
                <Badge id={uid} name={m?.displayName ?? '?'} size={22} />
                <Text style={[s.body, { flex: 1 }]}>{uid === user.id ? 'You' : m?.displayName ?? 'Member'}</Text>
                <Text style={s.meta}>{minorToAmountString(v, currency)}</Text>
              </View>
            );
          })}
          <Pressable onPress={() => setExactShares(null)}>
            <Text style={s.link}>Clear and split equally instead</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={s.fieldLabel}>Split equally between</Text>
          {group.members.map((m) => {
            const on = included.has(m.id);
            return (
              <Pressable key={m.id} style={s.checkRow}
                onPress={() => {
                  const next = new Set(included);
                  on ? next.delete(m.id) : next.add(m.id);
                  setIncluded(next);
                }}>
                <Text style={{ color: on ? c.brand : c.text3, fontSize: 16, width: 22 }}>{on ? '☑' : '☐'}</Text>
                <Badge id={m.id} name={m.displayName} size={22} />
                <Text style={[s.body, { flex: 1 }]}>{m.id === user.id ? 'You' : m.displayName}</Text>
                <Text style={s.meta}>{on && shares?.[m.id] !== undefined ? minorToAmountString(shares[m.id]!, currency) : '—'}</Text>
              </Pressable>
            );
          })}
        </>
      )}
      <Btn primary label={editing ? 'Save changes' : 'Save expense'}
        disabled={amountMinor <= 0 || description.trim() === '' || shares === null}
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
          <Btn label="Delete this expense" onPress={() => {
            api.deleteExpense(editing.id).then(onDeleted).catch((e) => setError((e as Error).message));
          }} />
        </>
      )}
      {scanProg !== null && <BusyOverlay scan={scanProg} onCancel={() => scanHandle.current?.cancel()} />}
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
            setExactShares(r.shares);
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
  const itemsSum = parsed.items.reduce((a, i) => a + i.totalMinor, 0);
  const billTotal = parsed.totalMinor ?? itemsSum + (parsed.taxMinor ?? 0) + (parsed.tipMinor ?? 0);
  const totalMinor = billTotal + (slip?.tipMinor ?? 0);
  const extra = totalMinor - itemsSum;

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
  const allAssigned = parsed.items.every((_, i) => (assign[i]?.size ?? 0) > 0);

  const perMember = useMemo(() => {
    const out: Record<string, number> = {};
    parsed.items.forEach((item, i) => {
      const who = [...(assign[i] ?? [])].sort();
      if (who.length === 0) return;
      const split = computeSplit('equal', item.totalMinor, who.map((id) => ({ id })));
      for (const [id, v] of Object.entries(split)) out[id] = (out[id] ?? 0) + v;
    });
    if (extra !== 0 && Object.keys(out).length > 0) {
      const weights = Object.entries(out).filter(([, v]) => v > 0)
        .map(([id, v]) => ({ id, shares: v }));
      if (weights.length > 0) {
        const prorated = computeSplit('shares', Math.abs(extra), weights);
        for (const [id, v] of Object.entries(prorated)) out[id] = (out[id] ?? 0) + (extra > 0 ? v : -v);
      }
    }
    return out;
  }, [assign, parsed.items, extra]);

  return (
    <SheetModal title="Assign items" onClose={onCancel}>
      <Text style={[s.meta, { marginBottom: 8 }]}>
        {parsed.merchant ?? 'Receipt'} · total {minorToAmountString(totalMinor, rcur)}
        {parsed.currency ? ` ${parsed.currency}` : ''}
        {extra !== 0 ? ` (incl. ${minorToAmountString(extra, rcur)} tax/tip, prorated)` : ''}
      </Text>
      {parsed.items.map((item, i) => (
        <View key={i} style={[s.row, { flexWrap: 'wrap' }]}>
          <View style={{ flex: 1, minWidth: 120 }}>
            <Text style={s.rowName}>{item.name}</Text>
            <Text style={s.meta}>{item.quantity !== 1 ? `${item.quantity} × ` : ''}{minorToAmountString(item.totalMinor, rcur)}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {members.map((m) => {
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
                  style={{ opacity: on ? 1 : 0.35, padding: 2, borderRadius: 14,
                    borderWidth: 2, borderColor: on ? c.brand : 'transparent' }}>
                  <Badge id={m.id} name={m.displayName} size={22} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {!allAssigned && (
        <Btn label="Split the rest equally"
          onPress={() => setAssign((prev) => {
            const next = { ...prev };
            parsed.items.forEach((_, i) => {
              if ((next[i]?.size ?? 0) === 0) next[i] = new Set(members.map((m) => m.id));
            });
            return next;
          })} />
      )}
      {slipError !== null && <Text style={s.error}>{slipError}</Text>}
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
      {error && <Text style={s.error}>{error}</Text>}
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
  screen: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 16, paddingTop: 56 },
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
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#0c1220', fontWeight: '600', fontSize: 12 },
  btn: {
    backgroundColor: c.surface2, borderRadius: 12, paddingVertical: 12,
    alignItems: 'center', marginBottom: 8,
  },
  btnPrimary: { backgroundColor: c.brand },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12, marginBottom: 0 },
  btnText: { color: c.text, fontWeight: '600', fontSize: 14 },
  fieldLabel: { color: c.text3, fontSize: 11.5, marginBottom: 4 },
  input: {
    backgroundColor: c.surface2, borderColor: c.outline, borderWidth: 1,
    borderRadius: 10, color: c.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  link: { color: c.brand, fontSize: 13, textAlign: 'center', padding: 10 },
  error: {
    color: c.text, backgroundColor: 'rgba(239,93,107,0.14)', borderColor: c.danger,
    borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 10,
  },
  tabs: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: 10, padding: 3, marginBottom: 12 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 8 },
  tabOn: { backgroundColor: c.surface },
  tabText: { color: c.text2, fontWeight: '600', fontSize: 13 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
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
});
