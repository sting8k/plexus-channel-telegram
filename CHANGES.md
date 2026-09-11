# Changes from upstream

Fork of [jackControls/dsh-telegram-control](https://github.com/jackControls/dsh-telegram-control) (MIT).
Upstream is the `upstream` remote; pull fixes from there when useful.

- Package renamed to `@plexus/channel-telegram`; repo `sting8k/plexus-channel-telegram`.
- **Security**: inline-button presses (approve/reject/question) are only honoured
  from a chat in `allowedChatIds`. Upstream trusted the random token alone, so a
  forwarded approval message — or another member of an allowlisted group — could
  settle an approval from any chat.
- Smoke test boots `dsh web --no-open` (no browser tab), covers the stranger
  press, and matches callback answers by id because updates are handled concurrently.
