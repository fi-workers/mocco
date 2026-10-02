// Push notifications for messenger replies. The sender is a port; the Expo push service
// (https://exp.host) is the first driver, called with fetch (no SDK). Expo apps get
// their token from expo-notifications; bare apps can use Expo's service too.
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushResult {
  to: string;
  ok: boolean;
  /** The service says this device no longer takes notifications: stop sending to it. */
  isDeviceGone: boolean;
}

export interface PushSender {
  send(messages: readonly PushMessage[]): Promise<PushResult[]>;
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts up to 100 notifications per request. */
const EXPO_BATCH = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

export class ExpoPushSender implements PushSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { accessToken?: string; fetch?: typeof fetch } = {}) {
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
  }

  private async sendBatch(batch: readonly PushMessage[]): Promise<PushResult[]> {
    const response = await this.fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(this.options.accessToken !== undefined && { authorization: `Bearer ${this.options.accessToken}` }),
      },
      body: JSON.stringify(batch.map(message => ({ ...message, sound: 'default' }))),
    });
    if (!response.ok) {
      throw new Error(`Expo push answered ${response.status}`);
    }
    const { data } = (await response.json()) as { data: ExpoTicket[] };
    return batch.map((message, index) => {
      const ticket = data[index];
      return {
        to: message.to,
        ok: ticket?.status === 'ok',
        isDeviceGone: ticket?.details?.error === 'DeviceNotRegistered',
      };
    });
  }

  async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    const batches = Array.from({ length: Math.ceil(messages.length / EXPO_BATCH) }, (_, index) =>
      messages.slice(index * EXPO_BATCH, (index + 1) * EXPO_BATCH),
    );
    const results = await Promise.all(batches.map(async batch => await this.sendBatch(batch)));
    return results.flat();
  }
}
