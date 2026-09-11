/**
 * Minimal Telegram Bot API client over the global `fetch`. Covers long-poll
 * `getUpdates`, `sendMessage` with inline keyboards, `sendChatAction`,
 * callback-query answering, message editing, and the bot command menu. No
 * third-party runtime dependencies.
 * @module dsh-telegram-control/client
 */
/**
 * The key for a conversation in the plugin's own maps.
 *
 * General (and a chat without topics) is just the chat id, which is also what
 * state files written before topics existed already use, so an old selection
 * still resolves.
 */
export function keyOf(chat) {
    return chat.threadId === undefined ? `${chat.chatId}` : `${chat.chatId}:${chat.threadId}`;
}
/** The conversation an incoming message or button press belongs to. */
export function chatKeyOf(source) {
    return source.message_thread_id === undefined
        ? { chatId: source.chat.id }
        : { chatId: source.chat.id, threadId: source.message_thread_id };
}
/** A Telegram API error with the API's numeric error code when supplied. */
export class TelegramApiError extends Error {
    /** The `error_code` field from the API response, when present. */
    code;
    constructor(message, code) {
        super(message);
        this.name = 'TelegramApiError';
        this.code = code;
    }
}
/**
 * Long-polling Telegram bot client. Webhook deployments should disable
 * polling and adapt the inbound path themselves; this client owns the
 * outbound half only.
 */
export class TelegramClient {
    token;
    baseUrl;
    /**
     * @param token - the bot token (`123456:ABC-DEF...`).
     * @param apiBase - API base URL; defaults to the public endpoint. Overridable
     *   for tests and self-hosted proxies.
     */
    constructor(token, apiBase = 'https://api.telegram.org') {
        this.token = token;
        this.baseUrl = apiBase.replace(/\/+$/, '');
    }
    url(method) {
        return `${this.baseUrl}/bot${this.token}/${method}`;
    }
    /** Perform one API call and unwrap the `{ ok, result }` envelope. */
    async call(method, body, signal) {
        let response;
        const init = { method: body === undefined ? 'GET' : 'POST' };
        if (body !== undefined) {
            init.headers = { 'content-type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        if (signal !== undefined)
            init.signal = signal;
        try {
            response = await fetch(this.url(method), init);
        }
        catch (error) {
            if (signal !== undefined && signal.aborted)
                throw error;
            throw new TelegramApiError(`telegram request ${method} failed: ${String(error)}`, undefined);
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new TelegramApiError(`telegram ${method} returned non-JSON (HTTP ${response.status})`, response.status);
        }
        const envelope = payload;
        if (envelope.ok !== true) {
            throw new TelegramApiError(`telegram ${method} error${envelope.error_code === undefined ? '' : ` ${envelope.error_code}`}: ${envelope.description ?? 'unknown'}`, envelope.error_code);
        }
        return envelope.result;
    }
    /**
     * Long-poll `getUpdates`. Resolves with the updates available within
     * `timeoutSec` seconds.
     * @param offset - first update id to return; pass the last consumed id + 1.
     * @param timeoutSec - long-poll seconds (Telegram accepts up to 50).
     * @param signal - optional abort; the underlying fetch rejects on abort.
     */
    async getUpdates(offset, timeoutSec = 50, signal) {
        const query = new URLSearchParams({
            timeout: String(timeoutSec),
            allowed_updates: JSON.stringify(['message', 'callback_query']),
        });
        if (offset > 0)
            query.set('offset', String(offset));
        return this.call(`getUpdates?${query.toString()}`, undefined, signal);
    }
    /** Send one text message to a chat, optionally with an inline keyboard. */
    async sendMessage(chat, text, options = {}, signal) {
        return this.call('sendMessage', {
            chat_id: chat.chatId,
            text,
            parse_mode: options.parseMode ?? 'HTML',
            disable_web_page_preview: options.disableWebPagePreview ?? true,
            ...chat.threadId === undefined ? {} : { message_thread_id: chat.threadId },
            ...options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup },
        }, signal);
    }
    /** Show a chat-action indicator (e.g. `typing`) while work is pending. */
    async sendChatAction(chat, action, signal) {
        await this.call('sendChatAction', {
            chat_id: chat.chatId,
            action,
            ...chat.threadId === undefined ? {} : { message_thread_id: chat.threadId },
        }, signal);
    }
    /** Acknowledge a callback-query button press (required to stop its spinner). */
    async answerCallbackQuery(callbackQueryId, text, signal) {
        await this.call('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...text === undefined ? {} : { text },
        }, signal);
    }
    /**
     * Replace the text of a previously sent message (e.g. to show an approval outcome).
     *
     * The edit is keyed by the message id, and `editMessageText` has no
     * `message_thread_id` parameter, so the body carries none: the `ChatKey` is here
     * so callers pass the same shape everywhere, not to put a thread in the request.
     */
    async editMessageText(chat, messageId, text, signal) {
        await this.call('editMessageText', {
            chat_id: chat.chatId,
            message_id: messageId,
            text,
            parse_mode: 'HTML',
        }, signal);
    }
    /** Publish the bot's command menu (shown above the Telegram input field). */
    async setMyCommands(commands, signal) {
        await this.call('setMyCommands', { commands: commands.map(({ command, description }) => ({ command, description })) }, signal);
    }
}
