/**
 * Pure formatting helpers for Telegram payloads. No harness or network
 * dependencies, so they are unit-testable in isolation.
 * @module dsh-telegram-control/format
 */
/** Escape text so it is safe inside Telegram's HTML parse mode. */
export declare function escapeHtml(text: string): string;
/**
 * Render the subset of Markdown that Telegram's HTML parse mode can show:
 * fenced and inline code, bold, italic, links, headings
 * (as bold) and list markers (as bullets). Everything else is escaped text —
 * a model reply must never produce a 400 from Telegram.
 */
export declare function markdownToTelegramHtml(markdown: string): string;
/** Tool-call notice for the chat: the tool name, then its command or path as a code block (each field clipped to `maxChars`, the command's original line breaks kept). */
export declare function toolCallPreview(name: string, rawArguments: string, maxChars?: number): string;
/**
 * Split one message into Telegram-safe chunks (hard cap `max` chars each).
 *
 * Prefers newline boundaries. A line with none is cut at a closing tag that
 * leaves nothing open, or failing that between constructs. A boundary that falls
 * inside a fenced code block closes the block in the chunk it leaves and reopens
 * it in the next, because Telegram refuses an unclosed `<pre>` with a 400 and that
 * loses the whole reply rather than one block.
 *
 * @param text - the full message to split, already rendered to Telegram HTML.
 * @param max - per-chunk character cap (Telegram's own limit is 4096).
 * @returns the ordered chunks; `[text]` when it already fits.
 */
export declare function splitMessage(text: string, max?: number): string[];
/** Render a duration in seconds as a compact `1h 23m 45s` string. */
export declare function renderUptime(seconds: number): string;
/**
 * Shorten an absolute path under the user's home directory to `~/…` form.
 * @param path - the absolute path to shorten.
 * @param home - the home directory to anchor on (empty means `path` is already `~`).
 * @returns `~`/`~/…` for paths under `home`, otherwise the path unchanged.
 */
export declare function homeShorten(path: string, home: string): string;
/**
 * Summarize a reasoning chain the way the Web UI's collapsed Think row does:
 * the first line of the finished chain. A single over-long line is capped at
 * `maxChars`, cut at a sentence boundary when one fits, ellipsized.
 * @param text - the full reasoning text.
 * @param maxChars - the per-line cap; `0` (or below) suppresses reasoning entirely.
 * @returns the summary, or `''` when suppressed.
 */
export declare function trimReasoning(text: string, maxChars: number): string;
/** One parsed bot command: `/name@bot extra` → `{ command: 'name', rawInput: 'extra' }`. */
export interface ParsedBotCommand {
    /** Lowercase command name without the leading slash or bot username. */
    command: string;
    /** Exact text after the command (whitespace-stripped), empty when absent. */
    rawInput: string;
}
/**
 * Parse a Telegram message as a bot command. Group-chat mentions
 * (`/status@my_bot`) are normalized away; anything that does not start with a
 * slash returns `undefined`.
 * @param text - the raw message text.
 * @returns the parsed command, or `undefined` for a plain message.
 */
export declare function parseBotCommand(text: string): ParsedBotCommand | undefined;
/** One parsed approval-button callback: which choice and which request token. */
export interface ParsedApprovalCallback {
    /** Whether the button granted (`approve`) or denied (`reject`) the request. */
    approve: boolean;
    /** The random request token embedded in the button's callback_data. */
    token: string;
}
/**
 * Parse an inline-button callback for an approval request.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export declare function parseApprovalCallback(data: string): ParsedApprovalCallback | undefined;
/** One option of a user question, as the question seam declares it. */
export interface QuestionOption {
    label: string;
    /** Optional extra context; the body shows it, a button never does. */
    description?: string;
}
/** The buttons for one question: one option per row, in the order the body lists them. */
export interface QuestionKeyboard {
    inline_keyboard: {
        text: string;
        callback_data: string;
    }[][];
}
/**
 * How one question's options appear in Telegram: body lines, and buttons when
 * the question has a single answer to give.
 *
 * The body carries every option in full — escaped label, then the description
 * when there is one — because a button shows only a clipped label. The number is
 * what ties the two together, so it is in both and in the same order. Multi
 * select and free-text questions get the list and no buttons: there is no single
 * option a press could mean.
 *
 * @param options - the question's options, in the order the caller declared.
 * @param token - the request token embedded in every button's callback_data.
 * @param singleSelect - whether one press answers the question.
 */
export declare function questionOptions(options: readonly QuestionOption[], token: string, singleSelect: boolean): {
    lines: string[];
    keyboard: QuestionKeyboard | undefined;
};
/** One parsed question-button callback: the request token and the option index. */
export interface ParsedQuestionCallback {
    token: string;
    /** Index into the question's `options` array that was pressed. */
    optionIndex: number;
}
/**
 * Parse an inline-button callback for a forwarded user question.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export declare function parseQuestionCallback(data: string): ParsedQuestionCallback | undefined;
