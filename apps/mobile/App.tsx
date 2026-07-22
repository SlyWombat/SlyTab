import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { computeSplit, formatMinor, tokens } from '@slytab/core';
import {
  api, setToken,
  type Balances, type Expense, type Group, type HomeBalances, type Member, type User,
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
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.sheetBack} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.sheet}>
          <View style={s.grabber} />
          <Text style={s.sheetTitle}>{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- screens ----------

type Nav = { screen: 'home' } | { screen: 'group'; groupId: string };

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [nav, setNav] = useState<Nav>({ screen: 'home' });

  return (
    <View style={s.app}>
      {user === null ? (
        <AuthScreen onSignedIn={(t, u) => { setToken(t); setUser(u); }} />
      ) : nav.screen === 'group' ? (
        <GroupScreen groupId={nav.groupId} user={user} onBack={() => setNav({ screen: 'home' })} />
      ) : (
        <HomeScreen
          user={user}
          onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })}
          onSignOut={() => { api.logout().catch(() => {}); setToken(null); setUser(null); }}
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

function HomeScreen({ user, onOpenGroup, onSignOut }: {
  user: User; onOpenGroup: (id: string) => void; onSignOut: () => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const total = (data?.items ?? [])
    .filter((i) => i.currency === user.defaultCurrency)
    .reduce((a, i) => a + i.netMinor, 0);
  const incoming = (data?.pendingSettlements ?? []).filter((p) => p.toUserId === user.id);

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <Text style={s.h1}>Sly<Text style={{ color: c.text2 }}>Tab</Text></Text>
        <View style={{ flex: 1 }} />
        <Btn small label="Sign out" onPress={onSignOut} />
      </View>
      {error && <Text style={s.error}>{error}</Text>}

      <View style={s.hero}>
        <Text style={s.cap}>YOUR BALANCE</Text>
        {data === null ? <ActivityIndicator color={c.brand} /> : total === 0
          ? <Text style={{ color: c.text2, fontSize: 26, fontWeight: '600' }}>All settled up ✓</Text>
          : <Amount minor={total} currency={user.defaultCurrency} signed size={30} />}
        <Text style={s.meta}>{data ? `Across ${data.items.length} groups` : 'Loading'}</Text>
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
    </View>
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
      <Field label="Emoji (optional)" value={emoji} onChangeText={setEmoji} placeholder="🏕️" />
      <Field label="Home currency" value={currency} onChangeText={setCurrency}
        autoCapitalize="characters" maxLength={3} />
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
  const [tab, setTab] = useState<'expenses' | 'balances'>('expenses');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [adding, setAdding] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);

  const reload = useCallback(() => {
    api.group(groupId).then(setGroup).catch(() => {});
    api.expenses(groupId).then((r) => setExpenses(r.items)).catch(() => {});
    api.balances(groupId).then(setBalances).catch(() => {});
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
        {(['expenses', 'balances'] as const).map((t) => (
          <Pressable key={t} style={[s.tab, tab === t && s.tabOn]} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && { color: c.text }]}>
              {t === 'expenses' ? 'Expenses' : 'Balances'}
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
          renderItem={({ item: e }) => {
            const paid = e.payers.filter((p) => p.userId === user.id).reduce((a, p) => a + p.amountMinor, 0);
            const owed = e.shares.filter((sh) => sh.userId === user.id).reduce((a, sh) => a + sh.amountMinor, 0);
            const effect = paid - owed;
            return (
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName}>{e.description}</Text>
                  <Text style={s.meta}>
                    {e.payers.map((p) => nameOf(p.userId)).join(' + ')} paid · {e.expenseDate}
                  </Text>
                </View>
                {effect === 0 ? <Text style={s.meta}>not involved</Text>
                  : <Amount minor={effect} currency={e.currency} signed />}
              </View>
            );
          }}
        />
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
      </View>
      {inviteLink && (
        <SheetModal title="Invite to group" onClose={() => setInviteLink(null)}>
          <Text style={[s.body, { padding: 10, backgroundColor: c.surface2, borderRadius: 10 }]} selectable>
            {inviteLink}
          </Text>
          <Text style={s.meta}>Anyone with this link can join for 7 days. Long-press to copy.</Text>
        </SheetModal>
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
      {settling && (
        <SettleSheet group={group} to={settling.to} suggested={settling.suggested}
          onClose={() => setSettling(null)}
          onDone={() => { setSettling(null); reload(); }} />
      )}
    </View>
  );
}

function AddExpenseSheet({ group, user, onClose, onSaved }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
}) {
  const [description, setDescription] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [included, setIncluded] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  const [error, setError] = useState<string | null>(null);
  const amountMinor = Math.round((parseFloat(amountStr) || 0) * 100);

  const shares = useMemo(() => {
    const ids = group.members.filter((m) => included.has(m.id)).map((m) => ({ id: m.id }));
    if (ids.length === 0 || amountMinor <= 0) return null;
    try { return computeSplit('equal', amountMinor, ids); } catch { return null; }
  }, [group.members, included, amountMinor]);

  async function save() {
    if (shares === null) return;
    setError(null);
    try {
      await api.addExpense(group.id, {
        description: description.trim(),
        amountMinor,
        currency: group.homeCurrency,
        expenseDate: new Date().toISOString().slice(0, 10),
        category: 'other',
        splitMethod: 'equal',
        payers: [{ userId: user.id, amountMinor }],
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SheetModal title="New expense" onClose={onClose}>
      {error && <Text style={s.error}>{error}</Text>}
      <Field label={`Amount (${group.homeCurrency})`} value={amountStr}
        onChangeText={setAmountStr} keyboardType="decimal-pad" placeholder="0.00" />
      <Field label="Description" value={description} onChangeText={setDescription} placeholder="Groceries" />
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
      <Btn primary label="Save expense"
        disabled={amountMinor <= 0 || description.trim() === '' || shares === null}
        onPress={save} />
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
  sheetBack: { flex: 1, backgroundColor: 'rgba(4,7,14,0.62)' },
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
