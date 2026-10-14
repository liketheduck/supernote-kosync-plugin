import {AppRegistry, DeviceEventEmitter, Image} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import App from './App';
import {name} from './app.json';
import {dismissPrompt, log, onTouch, startSync, stopSync} from './src/device.ts';
import {DEVELOPER_HARNESS} from './src/buildFlags.ts';
import {checkHarness} from './src/harness.ts';

AppRegistry.registerComponent(name, () => App);

async function initialize() {
  await PluginManager.init();
  await PluginManager.registerButton(1, ['DOC'], {
    id: 100,
    name: 'KOSync',
    icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
    showType: 1,
  });
  // Finger lifted: the page may have turned.
  PluginManager.registerMotionListener(1, {
    onMsg(msg) {
      if (msg?.action === 1 && msg?.toolType === 1) {
        onTouch();
      }
    },
  });
  PluginManager.registerPluginLifeListener({
    onMsg(msg) {
      log(`lifecycle ${JSON.stringify(msg)}`);
      // 3: plugin view closed, 4/5: plugin stopping. A question left open is dismissed.
      if (msg?.state === 3 || msg?.state === 4 || msg?.state === 5) {
        dismissPrompt();
      }
    },
  });
  if (DEVELOPER_HARNESS) {
    DeviceEventEmitter.addListener('kosync_tick', () => {
      checkHarness().catch(error => log(`harness failed: ${error?.message}`));
    });
  }
  await startSync();
}

initialize().catch(error => log(`start failed: ${error?.message}`));
