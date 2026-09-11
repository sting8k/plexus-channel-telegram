/**
 * Pure formatting helpers for Telegram payloads. No harness or network
 * dependencies, so they are unit-testable in isolation.
 * @module dsh-telegram-control/format
 */
/** Escape text so it is safe inside Telegram's HTML parse mode. */
export function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (char) => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return char;
        }
    });
}
/**
 * Render the subset of Markdown that Telegram's HTML parse mode can show:
 * fenced and inline code, bold, italic, links, headings
 * (as bold) and list markers (as bullets). Everything else is escaped text —
 * a model reply must never produce a 400 from Telegram.
 */
export function markdownToTelegramHtml(markdown) {
    const out = [];
    const lines = markdown.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^\s*```/.test(line)) {
            const body = [];
            i += 1;
            while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
                body.push(lines[i] ?? '');
                i += 1;
            }
            i += 1; // closing fence (or EOF)
            out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
            continue;
        }
        out.push(inlineMarkdown(line));
        i += 1;
    }
    return out.join('\n');
}
function inlineMarkdown(line) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null)
        return `<b>${inlineSpans(heading[1] ?? '')}</b>`;
    return inlineSpans(line.replace(/^(\s*)[-*+]\s+/, '$1• '));
}
/**
 * Inline code first (its contents are literal), then links, bold and italic on the rest.
 *
 * Links are held out of the emphasis passes the way code is: `[x](https://…/_y_)`
 * used to become `<a href="…/<i>y</i>">`, markup inside an attribute, which
 * Telegram rejects. The label is escaped and may still carry emphasis; the href
 * never passes through them, so nothing can be injected into it.
 */
function inlineSpans(text) {
    return text.split(/(`[^`\n]+`)/).map((part, index) => {
        if (index % 2 === 1)
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        return escapeHtml(part)
            .split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/)
            .map((piece, at) => {
            if (at % 2 === 0)
                return emphasize(piece);
            const link = LINK.exec(piece);
            return link === null ? emphasize(piece) : `<a href="${link[2] ?? ''}">${emphasize(link[1] ?? '')}</a>`;
        })
            .join('');
    }).join('');
}
/** The emphasis passes, which must never see the inside of a link's `href`. */
function emphasize(text) {
    return text
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
        .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
}
/** One Markdown link. Not a full URL grammar: the one shape this renderer accepts. */
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
/** Tool-call notice for the chat: the tool name, then its command or path as a code block (each field clipped to `maxChars`, the command's original line breaks kept). */
export function toolCallPreview(name, rawArguments, maxChars = 100) {
    let args = {};
    try {
        args = JSON.parse(rawArguments);
    }
    catch { /* not JSON: name only */ }
    const value = ['command', 'path', 'file_path', 'pattern', 'query', 'url']
        .map((key) => args[key])
        .find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
    // dsh tools carry a one-line `description` of what the call is for; the
    // reader on a phone wants that before the command itself (picoclaw does the same).
    // Clipped like the command: this notice is sent as one message and is never
    // split, so an unbounded field here is a `message is too long` 400 that loses it.
    const description = typeof args['description'] === 'string' ? clip(args['description'].trim(), maxChars) : '';
    const head = description === ''
        ? `🔧 <b>${escapeHtml(name)}</b>`
        : `🔧 <b>${escapeHtml(name)}</b> — ${escapeHtml(description)}`;
    if (value === undefined)
        return head;
    return `${head}\n<pre>${escapeHtml(clip(value.trim(), maxChars))}</pre>`;
}
/** Clip `text` to `maxChars` with an ellipsis, so one field cannot blow a message's length. */
function clip(text, maxChars) {
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
/** The fence tags a chunk boundary has to close and reopen when it lands in code. */
const PRE_OPEN = '<pre>';
const PRE_CLOSE = '</pre>';
/** Whether `text` opens more `<pre>` blocks than it closes. */
function opensPre(text) {
    return (text.match(/<pre>/g)?.length ?? 0) > (text.match(/<\/pre>/g)?.length ?? 0);
}
/**
 * Where to cut a line that offers no newline.
 *
 * Walks the tags this renderer emits across the window and remembers the last
 * closing tag that left nothing open, so both halves are valid messages on their
 * own — the sequence is balanced per span, so such a position is the common case.
 * Failing that it backs the raw cut off the nearest `<` or `&`, which keeps it in
 * text rather than inside a tag or an entity. A window with neither — one
 * unbroken construct 4000 characters long — is cut raw and accepted as malformed;
 * the renderer cannot produce that from a model reply.
 */
function hardCut(text, max) {
    const tag = /<\/?(pre|code|b|i|a)(?:\s[^>]*)?>/g;
    const open = [];
    let boundary = 0;
    for (let match = tag.exec(text); match !== null && match.index + match[0].length <= max; match = tag.exec(text)) {
        const name = match[1] ?? '';
        if (match[0].startsWith('</')) {
            // Only a close that matches the innermost open tag is trusted to empty it.
            if (open.at(-1) === name)
                open.pop();
        }
        else {
            open.push(name);
        }
        if (open.length === 0)
            boundary = match.index + match[0].length;
    }
    if (boundary > 0)
        return boundary;
    const start = Math.max(text.lastIndexOf('<', max - 1), text.lastIndexOf('&', max - 1));
    if (start <= 0)
        return max;
    return text.slice(start, max).includes(text[start] === '<' ? '>' : ';') ? max : start;
}
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
export function splitMessage(text, max = 4000) {
    if (text.length <= max)
        return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut <= 0)
            cut = hardCut(rest, max);
        if (opensPre(rest.slice(0, cut))) {
            // Reserve the room the closing tag will take and cut again. The new
            // boundary can land before the block opened; the check below is what
            // actually decides, so that case simply adds no tags.
            const budget = Math.max(1, max - PRE_CLOSE.length);
            const retry = rest.lastIndexOf('\n', budget);
            cut = retry <= 0 ? hardCut(rest, budget) : retry;
        }
        let head = rest.slice(0, cut);
        let tail = rest.slice(cut).replace(/^\n/, '');
        if (opensPre(head)) {
            head += PRE_CLOSE;
            tail = `${PRE_OPEN}${tail}`;
        }
        chunks.push(head);
        rest = tail;
    }
    if (rest.length > 0)
        chunks.push(rest);
    return chunks;
}
/** Render a duration in seconds as a compact `1h 23m 45s` string. */
export function renderUptime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const parts = [];
    if (hours > 0)
        parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0)
        parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}
/**
 * Shorten an absolute path under the user's home directory to `~/…` form.
 * @param path - the absolute path to shorten.
 * @param home - the home directory to anchor on (empty means `path` is already `~`).
 * @returns `~`/`~/…` for paths under `home`, otherwise the path unchanged.
 */
export function homeShorten(path, home) {
    if (path === home)
        return '~';
    if (path.startsWith(`${home}/`))
        return `~${path.slice(home.length)}`;
    return path;
}
/**
 * Summarize a reasoning chain the way the Web UI's collapsed Think row does:
 * the first line of the finished chain. A single over-long line is capped at
 * `maxChars`, cut at a sentence boundary when one fits, ellipsized.
 * @param text - the full reasoning text.
 * @param maxChars - the per-line cap; `0` (or below) suppresses reasoning entirely.
 * @returns the summary, or `''` when suppressed.
 */
export function trimReasoning(text, maxChars) {
    if (maxChars <= 0)
        return '';
    const newline = text.indexOf('\n');
    let summary = (newline === -1 ? text : text.slice(0, newline)).trim();
    if (summary.length <= maxChars)
        return summary;
    let cut = maxChars;
    for (const match of summary.slice(0, maxChars).matchAll(/[。！？!?.]\s*/g)) {
        cut = (match.index ?? 0) + match[0].length;
    }
    if (cut < maxChars * 0.5)
        cut = maxChars;
    return `${summary.slice(0, cut).trimEnd()}…`;
}
/**
 * Parse a Telegram message as a bot command. Group-chat mentions
 * (`/status@my_bot`) are normalized away; anything that does not start with a
 * slash returns `undefined`.
 * @param text - the raw message text.
 * @returns the parsed command, or `undefined` for a plain message.
 */
export function parseBotCommand(text) {
    const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (match === null)
        return undefined;
    return {
        command: (match[1] ?? '').toLowerCase(),
        rawInput: match[2] === undefined ? '' : match[2].trim(),
    };
}
/**
 * Parse an inline-button callback for an approval request.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export function parseApprovalCallback(data) {
    const match = /^(approve|reject):([0-9a-f-]+)$/.exec(data);
    if (match === null)
        return undefined;
    return { approve: match[1] === 'approve', token: match[2] ?? '' };
}
/** The longest a numbered option button may be, its number included. */
const OPTION_BUTTON_MAX = 40;
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
export function questionOptions(options, token, singleSelect) {
    const lines = options.map((option, index) => {
        const description = option.description === undefined || option.description.trim() === ''
            ? ''
            : ` — ${escapeHtml(option.description)}`;
        return `${index + 1}. <b>${escapeHtml(option.label)}</b>${description}`;
    });
    if (!singleSelect)
        return { lines, keyboard: undefined };
    return {
        lines,
        keyboard: {
            inline_keyboard: options.map((option, index) => [{
                    // An operator reads "2." in the body and must find "2." on the button; a
                    // label past the cap is clipped with an ellipsis rather than cut silently.
                    text: clip(`${index + 1}. ${option.label}`, OPTION_BUTTON_MAX),
                    callback_data: `question:${token}:${index}`,
                }]),
        },
    };
}
/**
 * Parse an inline-button callback for a forwarded user question.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export function parseQuestionCallback(data) {
    const match = /^question:([0-9a-f-]+):(\d+)$/.exec(data);
    if (match === null)
        return undefined;
    return { token: match[1] ?? '', optionIndex: Number(match[2]) };
}
