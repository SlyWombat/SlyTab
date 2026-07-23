import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import { computeSplit, CURRENCIES, formatMinor, GROUP_EMOJI, tokens } from '@slytab/core';
import {
  api, setToken, uploadReceipt,
  type Balances, type Expense, type Group, type GroupTotals, type HomeBalances, type Member,
  type SplitwiseGroup,
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
      <Text style={s.badgeText}>{name.slice(0, 1).toUpperCase()}</Text>
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
  return <Text style={{ color, fontSize: size, fontVariant: ['tabular-nums'], fontWeight: '600' }}>{text}</Text>;
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
        data={data?.items ?? []}
        keyExtractor={(i) => i.group.id}
        onRefresh={reload}
        refreshing={false}
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
        <Text style={{ color: '#fff', fontSize: 30, lineHeight: 34 }}>+</Text>
      </Pressable>
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

function ProfileSheet({ user, onClose, onSaved, onSignOut }: {
  user: User; onClose: () => void; onSaved: (u: User) => void; onSignOut: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency);
  const [deleting, setDeleting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [paypal, setPaypal] = useState(user.paymentHandles.paypalMe ?? '');
  const [venmo, setVenmo] = useState(user.paymentHandles.venmo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName: displayName.trim(),
        defaultCurrency: currency,
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
      <Text style={s.fieldLabel}>Home currency — your overall balance shows in this</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        {CURRENCIES.map((cur) => (
          <Pressable key={cur} onPress={() => setCurrency(cur)}
            style={{ paddingVertical: 6, paddingHorizontal: 12, marginRight: 6, borderRadius: 14,
              backgroundColor: cur === currency ? c.brand : c.surface2 }}>
            <Text style={{ color: cur === currency ? '#fff' : c.text2, fontWeight: '600', fontSize: 13 }}>{cur}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={s.fieldLabel}>How people pay you</Text>
      <Field label="Interac e-Transfer email" value={interac} onChangeText={setInterac}
        keyboardType="email-address" placeholder="you@example.com" />
      <Field label="PayPal.Me username" value={paypal} onChangeText={setPaypal} placeholder="yourname" />
      <Field label="Venmo username" value={venmo} onChangeText={setVenmo} placeholder="yourname" />
      <Btn primary label={busy ? 'Saving…' : 'Save profile'} disabled={busy || displayName.trim() === ''}
        onPress={() => void save()} />
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
      <Text style={s.fieldLabel}>Home currency</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
        {CURRENCIES.map((cur) => (
          <Pressable key={cur} onPress={() => setCurrency(cur)}
            style={{ paddingVertical: 6, paddingHorizontal: 12, marginRight: 6, borderRadius: 14,
              backgroundColor: cur === currency ? c.brand : c.surface2 }}>
            <Text style={{ color: cur === currency ? '#fff' : c.text2, fontWeight: '600', fontSize: 13 }}>{cur}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Btn primary label="Create group" disabled={name.trim() === ''}
        onPress={() => api.createGroup(name, emoji, currency.toUpperCase())
          .then((g) => onCreated(g.id)).catch((e) => setError(e.message))} />
    </SheetModal>
  );
}

function GroupScreen({ groupId, user, onBack }: {
  groupId: string; user: User; onBack: () => void;
}) {
  const [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'totals'>('expenses');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [totals, setTotals] = useState<GroupTotals | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Expense | null>(null);
  const [importing, setImporting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);

  const reload = useCallback(() => {
    api.group(groupId).then(setGroup).catch(() => {});
    api.expenses(groupId).then((r) => setExpenses(r.items)).catch(() => {});
    api.balances(groupId).then(setBalances).catch(() => {});
    api.groupTotals(groupId).then(setTotals).catch(() => {});
  }, [groupId]);
  useEffect(reload, [reload]);

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
        <View style={{ flex: 1 }}>
          <Text style={s.h2}>{group.name}</Text>
          <Text style={s.meta}>{group.members.length} members · {group.homeCurrency}</Text>
        </View>
        {myNet === 0 ? <Text style={s.meta}>settled ✓</Text>
          : <Amount minor={myNet} currency={group.homeCurrency} signed size={15} />}
      </View>

      <View style={s.tabs}>
        {(['expenses', 'balances', 'totals'] as const).map((t) => (
          <Pressable key={t} style={[s.tab, tab === t && s.tabOn]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && { color: c.text }]}>
              {t === 'expenses' ? 'Expenses' : t === 'balances' ? 'Balances' : 'Totals'}
            </Text>
          </Pressable>
        ))}
      </View>

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
                  <Text style={[s.body, { flex: 1 }]}>{cat.category}</Text>
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
          <Text style={{ color: '#fff', fontSize: 30, lineHeight: 34 }}>+</Text>
        </Pressable>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ expenses: number; settlements: number; skipped: number } | null>(null);

  const swGroup = swGroups?.find((g) => g.id === swGroupId) ?? null;
  const complete = swGroup !== null
    && swGroup.members.every((m) => (mapping[String(m.id)] ?? '') !== '')
    && new Set(Object.values(mapping)).size === swGroup.members.length;

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
    if (swGroupId === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.splitwiseApiImport(group.id, apiKey.trim(), swGroupId, mapping);
      setResult(r.imported);
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
            Imported {result.expenses} expenses and {result.settlements} settlements
            {result.skipped > 0 ? ` · ${result.skipped} personal expenses skipped` : ''}.
          </Text>
          <Btn primary label="Done" onPress={onDone} />
        </>
      ) : swGroups === null ? (
        <>
          <Text style={[s.meta, { marginBottom: 10 }]}>
            Sign in at secure.splitwise.com/apps → "Register your application"
            (any name) → copy the API key. The key is used for this import
            only and never stored.
          </Text>
          <Field label="Splitwise API key" value={apiKey} onChangeText={setApiKey}
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
              <Text style={s.fieldLabel}>Who is who? Tap to cycle through members</Text>
              {swGroup.members.map((m) => {
                const mapped = group.members.find((gm) => gm.id === mapping[String(m.id)]);
                return (
                  <Pressable key={m.id} style={s.row}
                    onPress={() => {
                      const idx = group.members.findIndex((gm) => gm.id === mapping[String(m.id)]);
                      const next = group.members[(idx + 1) % group.members.length];
                      setMapping({ ...mapping, [String(m.id)]: next?.id ?? '' });
                    }}>
                    <Text style={[s.body, { flex: 1 }]}>{m.name}</Text>
                    <Text style={{ color: mapped ? c.brand : c.text3, fontSize: 13.5 }}>
                      {mapped ? `→ ${mapped.displayName}` : 'tap to map'}
                    </Text>
                  </Pressable>
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

function BusyOverlay({ label }: { label: string }) {
  return (
    <Modal transparent statusBarTranslucent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(6,10,18,0.78)',
        alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <ActivityIndicator size="large" color={c.brand} />
        <Text style={[s.body, { color: c.text2 }]}>{label}</Text>
      </View>
    </Modal>
  );
}

function AddExpenseSheet({ group, user, onClose, onSaved, editing = null, onDeleted }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
  editing?: Expense | null; onDeleted?: () => void;
}) {
  const [description, setDescription] = useState(editing?.description ?? '');
  const [amountStr, setAmountStr] = useState(editing ? (editing.amountMinor / 100).toFixed(2) : '');
  const [included, setIncluded] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  const [error, setError] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [extraReceiptIds, setExtraReceiptIds] = useState<string[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [assigning, setAssigning] = useState<ParsedReceipt | null>(null);
  const [exactShares, setExactShares] = useState<Record<string, number> | null>(() => {
    if (!editing) return null;
    const out: Record<string, number> = {};
    for (const sh of editing.shares) out[sh.userId] = sh.amountMinor;
    return out;
  });
  const [currency, setCurrency] = useState(editing?.currency ?? group.homeCurrency);
  const [date, setDate] = useState(editing?.expenseDate ?? new Date().toISOString().slice(0, 10));
  const amountMinor = Math.round((parseFloat(amountStr) || 0) * 100);

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
      setScanBusy(true);
      const r = await uploadReceipt(group.id, asset.uri, asset.mimeType ?? 'image/jpeg');
      setReceiptId(r.id);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt — enter it manually (photo attached)');
      } else {
        setAssigning(r.parsed);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanBusy(false);
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
        category: editing?.category ?? 'other',
        splitMethod: exactShares !== null ? 'exact' : 'equal',
        payers: [{ userId: editing?.payers[0]?.userId ?? user.id, amountMinor }],
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
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
      <Field label="Description" value={description} onChangeText={setDescription} placeholder="Groceries" />
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
                <Text style={s.meta}>{(v / 100).toFixed(2)}</Text>
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
                <Text style={s.meta}>{on && shares?.[m.id] !== undefined ? (shares[m.id]! / 100).toFixed(2) : '—'}</Text>
              </Pressable>
            );
          })}
        </>
      )}
      <Btn primary label={editing ? 'Save changes' : 'Save expense'}
        disabled={amountMinor <= 0 || description.trim() === '' || shares === null}
        onPress={save} />
      {editing && onDeleted && (
        <>
          <View style={{ height: 8 }} />
          <Btn label="Delete this expense" onPress={() => {
            api.deleteExpense(editing.id).then(onDeleted).catch((e) => setError((e as Error).message));
          }} />
        </>
      )}
      {scanBusy && <BusyOverlay label="Reading your receipt…" />}
      {assigning !== null && (
        <AssignItemsSheet parsed={assigning} group={group} members={group.members} user={user}
          onCancel={() => setAssigning(null)}
          onDone={(r) => {
            setAssigning(null);
            setExtraReceiptIds(r.receiptIds);
            setAmountStr((r.totalMinor / 100).toFixed(2));
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
  const [slip, setSlip] = useState<{ tipMinor: number; receiptId: string } | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [slipError, setSlipError] = useState<string | null>(null);
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
      setSlipBusy(true);
      const r = await uploadReceipt(group.id, asset.uri, asset.mimeType ?? 'image/jpeg');
      const slipTotal = r.parsed?.totalMinor ?? null;
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
      setSlipError((e as Error).message);
    } finally {
      setSlipBusy(false);
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
        {parsed.merchant ?? 'Receipt'} · total {(totalMinor / 100).toFixed(2)}
        {parsed.currency ? ` ${parsed.currency}` : ''}
        {extra !== 0 ? ` (incl. ${(extra / 100).toFixed(2)} tax/tip, prorated)` : ''}
      </Text>
      {parsed.items.map((item, i) => (
        <View key={i} style={[s.row, { flexWrap: 'wrap' }]}>
          <View style={{ flex: 1, minWidth: 120 }}>
            <Text style={s.rowName}>{item.name}</Text>
            <Text style={s.meta}>{item.quantity !== 1 ? `${item.quantity} × ` : ''}{(item.totalMinor / 100).toFixed(2)}</Text>
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
          ? `Tip from card slip: ${(slip.tipMinor / 100).toFixed(2)} ✓ — rescan`
          : 'Scan card slip (adds the tip)'}
        disabled={slipBusy} onPress={() => void scanSlip()} />
      <Text style={[s.meta, { marginVertical: 8 }]}>
        {members.filter((m) => (perMember[m.id] ?? 0) !== 0)
          .map((m) => `${m.id === user.id ? 'You' : m.displayName} ${((perMember[m.id] ?? 0) / 100).toFixed(2)}`)
          .join(' · ') || 'Tap the badges to assign each item.'}
      </Text>
      <Btn primary label="Continue" disabled={!allAssigned}
        onPress={() => onDone({
          totalMinor, currency: parsed.currency, merchant: parsed.merchant,
          date: parsed.date, shares: perMember,
          receiptIds: slip !== null ? [slip.receiptId] : [],
        })} />
      {slipBusy && <BusyOverlay label="Reading the card slip…" />}
    </SheetModal>
  );
}

function SettleSheet({ group, to, suggested, onClose, onDone }: {
  group: Group; to: Member; suggested: number; onClose: () => void; onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const amountMajor = (suggested / 100).toFixed(2);
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
