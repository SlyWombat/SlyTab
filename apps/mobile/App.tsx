import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { formatMinor, tokens } from '@slytab/core';

const c = tokens.color.dark;

/**
 * Placeholder Welcome screen (ui_requirements.md §2.1) proving the shared
 * core package resolves in the Expo/metro monorepo setup.
 */
export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Sly<Text style={{ color: c.text2 }}>Tab</Text>
      </Text>
      <Text style={styles.tagline}>
        Split expenses with the people you actually share life with.
      </Text>
      <Text style={styles.amount}>{'+' + formatMinor(14210, 'CAD')}</Text>
      <Text style={styles.note}>
        Scaffold build — screens land per docs/design/ui_requirements.md
      </Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  title: {
    color: c.text,
    fontSize: 34,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  tagline: {
    color: c.text2,
    fontSize: 15,
    textAlign: 'center',
    maxWidth: 280,
  },
  amount: {
    color: c.owed,
    fontSize: 22,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  note: {
    color: c.text3,
    fontSize: 13,
    textAlign: 'center',
  },
});
