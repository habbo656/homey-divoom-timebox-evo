import Homey from 'homey';
import { asFlow, registerTimeboxFlowCards } from '../flow';
import { asBleManager } from '../transport/BleTransport';
import { registerPairHandlers } from './pairing';

export class TimeboxDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    registerTimeboxFlowCards(asFlow(this.homey.flow), (key) => this.homey.__(key));
  }

  /**
   * Pairing runs in the custom view `scan` (drivers/timebox/pair/scan.html): the view starts a 60 s BLE scan, receives
   * the candidates as events and asks for a verification of the chosen one (src/device/pairing.ts).
   */
  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    registerPairHandlers(session, {
      ble: asBleManager(this.homey.ble),
      pairedIds: () => this.getDevices().map((device) => String(device.getData().id)),
      log: (message) => this.log(message),
    });
  }
}
