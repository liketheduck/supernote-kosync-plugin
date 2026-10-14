import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import type {JumpPrompt, Settings, Status} from './src/core/engine.ts';
import {answerPrompt, engine, native, onPrompt} from './src/device.ts';
import {version} from './package.json';

function Button({label, onPress, primary}: {label: string; onPress: () => void; primary?: boolean}) {
  return (
    <Pressable style={[styles.button, primary && styles.primary]} onPress={onPress}>
      <Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({label, value, onChange}: {label: string; value: boolean; onChange: (v: boolean) => void}) {
  return (
    <Pressable style={styles.toggle} onPress={() => onChange(!value)}>
      <View style={[styles.box, value && styles.boxOn]}>{value ? <Text style={styles.check}>✓</Text> : null}</View>
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

/** True for http:// to an address that is not on a home or VPN network. */
function publicHttp(url: string): boolean {
  const match = /^http:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(url);
  if (!match) {
    return false;
  }
  const host = match[1].toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.')) {
    return false;
  }
  const ip = host.split('.').map(Number);
  if (ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = ip;
    return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  return !host.endsWith('.ts.net');
}

function ago(iso: string | null): string {
  if (!iso) {
    return 'never';
  }
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function when(seconds: number): string {
  if (!seconds) {
    return '';
  }
  return ago(new Date(seconds * 1000).toISOString());
}

function PromptView({prompt}: {prompt: JumpPrompt}) {
  const approximate = prompt.method === 'percentage';
  const target = `page ${prompt.targetPage + 1}`;
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Continue reading?</Text>
      <Text style={styles.text}>{prompt.book}</Text>
      <Text style={styles.text}>
        {prompt.device} is at {approximate ? 'about ' : ''}
        {target} of {prompt.total}
        {prompt.percentage !== null ? ` (${Math.round(prompt.percentage * 100)}%)` : ''}
        {prompt.timestamp ? `, saved ${when(prompt.timestamp)}` : ''}. You are on page {prompt.currentPage + 1}.
      </Text>
      {approximate ? (
        <Text style={styles.note}>That device shared only a percentage, so the page is approximate.</Text>
      ) : null}
      <Button primary label={`Go to ${target}`} onPress={() => answerPrompt(true)} />
      <Button label={`Stay on page ${prompt.currentPage + 1}`} onPress={() => answerPrompt(false)} />
    </View>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>(engine.status);
  const [prompt, setPrompt] = useState<JumpPrompt | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [logText, setLogText] = useState<string | null>(null);

  const load = async () => {
    const value: Settings = await native.settings();
    setSettings(value);
    setUrl(value.url);
    setUsername(value.username);
    setDeviceName(value.deviceName);
    setEditing(!(value.url && value.username && value.hasPassword));
  };

  useEffect(() => {
    const offStatus = engine.onChange(() => setStatus(engine.status));
    const offPrompt = onPrompt(setPrompt);
    load().catch(() => setEditing(true));
    return () => {
      offStatus();
      offPrompt();
    };
  }, []);

  if (prompt) {
    return <PromptView prompt={prompt} />;
  }

  const save = async () => {
    setNotice('Checking…');
    try {
      await native.saveServer(url.trim(), username.trim(), password);
      if (deviceName.trim() && deviceName.trim() !== settings?.deviceName) {
        await native.setDeviceName(deviceName.trim());
      }
      setPassword('');
      engine.reloadSettings();
      let capabilities: string[];
      try {
        capabilities = await engine.testConnection();
      } catch (error) {
        // Stock KOSync servers serve the API at the root; CWA serves it under /kosync.
        if (!/404/.test((error as Error)?.message ?? '')) {
          throw error;
        }
        await native.setRootPath(true);
        capabilities = await engine.testConnection();
      }
      const full = capabilities.includes('percentage_push') && capabilities.includes('anchor');
      const warning = publicHttp(url.trim())
        ? ' Warning: this is plain http to an address outside your home network, so your password travels unencrypted. Prefer https.'
        : '';
      setNotice(
        (full ? 'Connected. EPUB and PDF positions will sync.' : 'Connected. This server syncs PDFs; EPUB sync needs Calibre-Web-Automated (NextGen).') + warning,
      );
      await load();
      setEditing(false);
      engine.tick();
    } catch (error) {
      setNotice((error as Error)?.message || 'Could not connect');
    }
  };

  const setOption = async (name: 'autoSync' | 'askBeforeJump', value: boolean) => {
    await native.setOption(name, value);
    engine.reloadSettings();
    await load();
    engine.tick();
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Supernote KOSync</Text>
      {status.book ? <Text style={styles.text}>{status.title || status.book}</Text> : null}
      <Text style={[styles.status, status.error && styles.error]}>{status.message}</Text>
      {status.book ? (
        <Text style={styles.note}>
          Checked {ago(status.lastPull)} · Saved {ago(status.lastPush)}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button primary label="Sync now" onPress={() => engine.syncNow()} />
        <Button label="Back to book" onPress={() => PluginManager.closePluginView()} />
      </View>

      {settings ? (
        <View style={styles.section}>
          <Toggle label="Sync automatically while reading" value={settings.autoSync} onChange={v => setOption('autoSync', v)} />
          <Toggle label="Ask before jumping to a newer position" value={settings.askBeforeJump} onChange={v => setOption('askBeforeJump', v)} />
        </View>
      ) : null}

      {editing ? (
        <View style={styles.section}>
          <Text style={styles.heading}>Server</Text>
          <Text style={styles.label}>Server address (CWA or KOSync)</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} placeholder="http://192.168.1.10:8083" />
          <Text style={styles.label}>Username</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
          <Text style={styles.label}>Password or app password</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            placeholder={settings?.hasPassword ? 'Saved — leave empty to keep' : ''}
          />
          <Text style={styles.label}>This device's name on the server</Text>
          <TextInput style={styles.input} autoCorrect={false} value={deviceName} onChangeText={setDeviceName} />
          <Button primary label="Save and test" onPress={save} />
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.note}>
            {settings?.username}@{settings?.url} · {settings?.deviceName}
          </Text>
          <View style={styles.row}>
            <Button label="Change server" onPress={() => setEditing(true)} />
            <Button
              label="Remove login"
              onPress={async () => {
                await native.clearServer();
                engine.reloadSettings();
                setNotice('Login removed from this Supernote.');
                await load();
              }}
            />
          </View>
        </View>
      )}
      {notice ? <Text style={styles.text}>{notice}</Text> : null}
      <View style={styles.row}>
        <Text style={styles.note}>Version {version}</Text>
        <Pressable
          onPress={() => (logText === null ? native.readLog(40).then((t: string) => setLogText(t || '(empty)')) : setLogText(null))}>
          <Text style={[styles.note, styles.link]}>{logText === null ? 'Show log' : 'Hide log'}</Text>
        </Pressable>
      </View>
      {logText !== null ? <Text style={styles.log}>{logText}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {padding: 36, gap: 18, backgroundColor: '#fff', flexGrow: 1},
  title: {fontSize: 34, fontWeight: '700', color: '#000'},
  heading: {fontSize: 26, fontWeight: '700', color: '#000'},
  text: {fontSize: 22, color: '#000'},
  status: {fontSize: 24, color: '#000', fontWeight: '600'},
  error: {textDecorationLine: 'underline'},
  note: {fontSize: 18, color: '#333'},
  link: {textDecorationLine: 'underline'},
  log: {fontSize: 14, color: '#000', fontFamily: 'monospace'},
  label: {fontSize: 18, color: '#000', marginTop: 6},
  input: {borderWidth: 2, borderColor: '#000', padding: 14, fontSize: 22, color: '#000'},
  row: {flexDirection: 'row', gap: 16, flexWrap: 'wrap'},
  section: {gap: 12, borderTopWidth: 1, borderTopColor: '#000', paddingTop: 18},
  button: {borderWidth: 2, borderColor: '#000', paddingVertical: 18, paddingHorizontal: 28, alignItems: 'center'},
  primary: {backgroundColor: '#000'},
  buttonText: {fontSize: 22, color: '#000', fontWeight: '600'},
  primaryText: {color: '#fff'},
  toggle: {flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 8},
  box: {width: 34, height: 34, borderWidth: 2, borderColor: '#000', alignItems: 'center', justifyContent: 'center'},
  boxOn: {backgroundColor: '#000'},
  check: {color: '#fff', fontSize: 22, fontWeight: '700'},
});
