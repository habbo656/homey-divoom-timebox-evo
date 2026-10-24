import Homey from 'homey';
import { registerDevHarness } from './dev/devHarness';

class DivoomApp extends Homey.App {
  async onInit(): Promise<void> {
    this.log('TimeBox Evo app initialized');
    // Hardware-test harness (docs/pipeline.md): only with `homey app run` (DEBUG=1), never in a released build.
    if (process.env.DEBUG === '1') registerDevHarness(this.homey, (message) => this.log(message));
  }
}

module.exports = DivoomApp;
