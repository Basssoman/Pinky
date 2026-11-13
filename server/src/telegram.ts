// Minimal Telegram Bot API client (long polling, no webhook) and the bot's
// texts. The bot NEVER sends links or deal details: every
// text below is fixed, with no URL, amount, title or id in it.

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramApi {
  /** Long poll: waits up to `timeoutSeconds` for new updates. */
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Best effort; a bot may delete messages in a private chat for 48 h. */
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}

export class TelegramError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
  }
  /** The person blocked the bot or deleted the chat: stop writing to it. */
  get gone(): boolean {
    return this.status === 403 || (this.status === 400 && /chat not found/i.test(this.message));
  }
}

/** The real API. The token is part of the URL path: it must never be logged (we log no URLs here). */
export function httpTelegram(token: string, fetchImpl: typeof fetch = (...a) => fetch(...a), base = 'https://api.telegram.org'): TelegramApi {
  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let json: { ok?: boolean; result?: T; description?: string; error_code?: number } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* not JSON */
    }
    if (!res.ok || !json.ok) throw new TelegramError(json.error_code ?? res.status, String(json.description ?? `HTTP ${res.status}`));
    return json.result as T;
  }
  return {
    getUpdates: (offset, timeoutSeconds, signal) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] }, signal, (timeoutSeconds + 10) * 1000),
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    },
    deleteMessage: async (chatId, messageId) => {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
  };
}

// ---------------------------------------------------------------- texts

/** Things the watcher tells a party. No amounts, titles or links, ever. */
export type NotifyEvent =
  | 'paid' // the money is in the deal
  | 'delivered' // client: the work was delivered
  | 'review_soon' // client: 1 day (or less) left to review
  | 'accepted' // creator: accepted, or the review time ended: the money is yours
  | 'dispute' // creator: the client opened a dispute
  | 'decided' // both: the arbiter (or the dispute timeout) decided
  | 'refunded' // client: the creator gave the money back
  | 'deliver_soon' // creator: 1 day (or less) left to deliver
  | 'late' // client: delivery time is over, the work was not delivered
  | 'leave_review' // client of a deal from a request: less than 2 days left to leave a review
  | 'ended'; // the deal ended in another way

export type BotLang = 'en' | 'uk';

export const botLang = (v: unknown): BotLang => (v === 'uk' ? 'uk' : 'en');

interface BotTexts {
  news: string;
  open: string;
  events: Record<NotifyEvent, string>;
  subscribed: string;
  badCode: string;
  tooMany: string;
  hello: string;
  stopped: string;
  stoppedNone: string;
  noLinks: string;
  help: string;
  /**
   * Support confirmed a change of the key of
   * the creator's profile. Sent to the chats subscribed as the creator of a
   * deal made from that profile. No profile name, link or time.
   */
  keyReset: string;
  /** Answer to /chatid: this chat's id, for TELEGRAM_REPORTS_CHAT_ID. */
  chatId: (id: string) => string;
}

const NEVER_EN = 'We never ask for your personal link, and this bot never sends links.';
const NEVER_UK = 'Ми ніколи не просимо ваше особисте посилання, а цей бот ніколи не надсилає посилань.';

export const BOT_TEXTS: Record<BotLang, BotTexts> = {
  en: {
    news: 'Pinky: your deal has news.',
    open: `Open your saved personal link to see it. ${NEVER_EN}`,
    events: {
      paid: 'The payment arrived: the money is in the deal.',
      delivered: 'The creator marked the work as delivered. Check it before the review time ends.',
      review_soon: 'Less than 1 day left to review. If you do nothing, the creator can take the money.',
      accepted: 'The work is accepted (or the review time is over): you can take your money.',
      dispute: 'The client opened a dispute.',
      decided: 'The dispute is decided.',
      refunded: 'The creator gave the money back: you can take it.',
      deliver_soon: 'Less than 1 day left to deliver the work.',
      late: 'The delivery time is over and the work was not delivered: you can take your money back.',
      leave_review: 'You can still leave a review of the creator: less than 2 days left. After that, reviews of this deal are closed.',
      ended: 'The deal has ended.',
    },
    subscribed: `Done. You will get a short message here when your deal has news. ${NEVER_EN} To stop: /stop`,
    badCode: 'This code is used or too old. Press the Telegram button on your deal page again.',
    tooMany: 'This chat follows too many deals. Send /stop first, then subscribe again.',
    hello: `Hi! This is the Pinky notification bot. Subscribe from your deal page (the Telegram button). ${NEVER_EN}`,
    stopped: 'Done. This chat gets no more deal messages.',
    stoppedNone: 'This chat follows no deals.',
    noLinks:
      'Please never send links or keys here. This bot does not need them. If someone asked you for your personal link, it is a scam. If you can, delete that message.',
    help: `This bot only tells you that your deal has news. /stop — stop all messages. ${NEVER_EN}`,
    keyReset: `Pinky: support is changing the key of your creator profile. If you did not ask for this, open "Requests" on the site with your profile key and press "Cancel the change", then write to support. ${NEVER_EN}`,
    chatId: (id) => `This chat's id: ${id}\nOnly the Pinky team needs it (to get "Report" messages here).`,
  },
  uk: {
    news: 'Pinky: у вашій угоді є новини.',
    open: `Відкрийте своє збережене особисте посилання, щоб побачити. ${NEVER_UK}`,
    events: {
      paid: 'Оплата прийшла: гроші в угоді.',
      delivered: 'Виконавець позначив роботу як здану. Перевірте її, поки не скінчився час на перевірку.',
      review_soon: 'На перевірку лишилося менше 1 дня. Якщо нічого не робити, виконавець зможе забрати гроші.',
      accepted: 'Роботу прийнято (або час на перевірку скінчився): ви можете забрати гроші.',
      dispute: 'Замовник відкрив спір.',
      decided: 'Спір вирішено.',
      refunded: 'Виконавець повернув гроші: ви можете їх забрати.',
      deliver_soon: 'На здачу роботи лишилося менше 1 дня.',
      late: 'Час на здачу скінчився, а роботу не здано: ви можете забрати свої гроші.',
      leave_review: 'Ви ще можете залишити відгук про виконавця: лишилося менше 2 днів. Потім відгуки до цієї угоди закриються.',
      ended: 'Угоду завершено.',
    },
    subscribed: `Готово. Коли в угоді будуть новини, сюди прийде коротке повідомлення. ${NEVER_UK} Зупинити: /stop`,
    badCode: 'Цей код уже використано або він застарів. Натисніть кнопку Telegram на сторінці угоди ще раз.',
    tooMany: 'Цей чат стежить за забагатьма угодами. Спершу надішліть /stop, потім підпишіться знову.',
    hello: `Привіт! Це бот сповіщень Pinky. Підпишіться на сторінці угоди (кнопка Telegram). ${NEVER_UK}`,
    stopped: 'Готово. Цей чат більше не отримуватиме повідомлень про угоди.',
    stoppedNone: 'Цей чат не стежить за жодною угодою.',
    noLinks:
      'Будь ласка, ніколи не надсилайте сюди посилання чи ключі. Боту вони не потрібні. Якщо хтось просив ваше особисте посилання — це шахрай. Якщо можете, видаліть те повідомлення.',
    help: `Цей бот лише каже, що в угоді є новини. /stop — зупинити всі повідомлення. ${NEVER_UK}`,
    keyReset: `Pinky: підтримка змінює ключ вашого профілю виконавця. Якщо ви цього не просили, відкрийте на сайті «Запити» зі своїм ключем профілю і натисніть «Скасувати зміну», а потім напишіть у підтримку. ${NEVER_UK}`,
    chatId: (id) => `Id цього чату: ${id}\nВін потрібен лише команді Pinky (щоб отримувати сюди скарги).`,
  },
};

/** One message for everything that happened in a deal since the last check. */
export function newsText(lang: BotLang, events: NotifyEvent[]): string {
  const t = BOT_TEXTS[lang];
  return [t.news, ...events.map((e) => t.events[e]), t.open].join('\n\n');
}

/** Text that looks like a link, a personal link or a key: the bot never takes those. */
export const LOOKS_SECRET = /(https?:\/\/|www\.|t\.me\/|\/k#|k1\.(?:creator|client)\.|ed25519:|\b[0-9a-f]{40,}\b|\.[a-z]{2,10}\/)/i;
