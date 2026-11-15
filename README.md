# claude-code-discord-sync

Mirror every local Claude Code session into its own Discord channel, and reply to it or answer its
prompts from Discord. It is a standalone watcher, not a hook, plugin or MCP server, so it adds no
tokens or context to your sessions and Claude never knows it is there. It only reads the files
Claude Code already writes under `~/.claude` and types into tmux.

## What you see

- **One channel per session** under the **Claude Sessions** category, named after the session and
  its folder, and renamed once Claude gives the conversation a title.
- **Claude's replies** as normal messages (Markdown kept, tables turned into code blocks, long text
  split). Prompts you type in the terminal show up as quotes. Thinking is never shown.
- **A live activity message** for each run of tool calls, edited in place: one line per tool that
  flips from ⏳ to ✅ or ❌.
- **A subagent panel** for each batch of agents, with type, description, status and duration.
- **Approval and question cards** when Claude is waiting on you. They @-ping you, show the prompt,
  and have one button per option when the option list can be read reliably. Otherwise they show the
  prompt text and a hint to answer with `!keys` or `!type`.
- **A done ping** when a turn finishes: `✅ Done in 1m 12s @you`, plus how many background agents
  are still running.
- **Ended sessions** move to **Ended Sessions** and are deleted after one hour, unless you type
  `!archive` in the channel, which moves it to **Archive** (then `Archive 2`, `Archive 3`, … as
  categories fill up).

Running `/clear` or `/resume` keeps the same channel and posts a divider.

## Requirements

- macOS
- Node.js 24.12 or later (runs the TypeScript sources directly, no build step)
- tmux. Sessions must run inside tmux to be controllable from Discord. Sessions outside tmux are
  mirrored read-only.
- Claude Code

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application and open its **Bot** page. Enable **Message Content Intent** under
   Privileged Gateway Intents and copy the bot token. Under **OAuth2 → URL Generator**, pick the
   `bot` scope and these permissions: View Channels, Send Messages, Manage Channels, Read Message
   History, Embed Links, Add Reactions. Open the generated URL and invite the bot to a **private
   server** that only you use.

2. **Install dependencies.**

   ```sh
   npm install
   ```

3. **Store the token in the Keychain.** It prompts for the token, so it never lands in your shell
   history.

   ```sh
   security add-generic-password -s claude-code-discord-sync -a "$USER" -w
   ```

4. **Copy your IDs.** In Discord, turn on **Settings → Advanced → Developer Mode**, then right-click
   the server and pick **Copy Server ID**, and right-click yourself and pick **Copy User ID**.

5. **Try it in the foreground.**

   ```sh
   DISCORD_BOT_TOKEN="$(security find-generic-password -s claude-code-discord-sync -w)" \
   DISCORD_GUILD_ID=<server id> DISCORD_USER_ID=<your user id> npm start
   ```

   Start a Claude Code session inside tmux and its channel appears within a few seconds. Stop with
   Ctrl-C. Only one watcher can run at a time, so stop the foreground one before loading the
   LaunchAgent.

6. **Run it at login.** From the repo directory, fill in the LaunchAgent template and load it:

   ```sh
   GUILD_ID=<server id> USER_ID=<your user id>
   sed -e "s|__REPO__|$PWD|g" -e "s|__NODE__|$(command -v node)|g" -e "s|__HOME__|$HOME|g" \
       -e "s|__GUILD_ID__|$GUILD_ID|g" -e "s|__USER_ID__|$USER_ID|g" \
       launchd/claude-code-discord-sync.plist > ~/Library/LaunchAgents/claude-code-discord-sync.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/claude-code-discord-sync.plist
   ```

   The agent reads the token from the Keychain each time it starts and exits with an error if it
   is missing. launchd restarts it if it stops.

   ```sh
   launchctl kickstart -k gui/$(id -u)/claude-code-discord-sync   # restart
   launchctl bootout gui/$(id -u)/claude-code-discord-sync        # stop and unload
   tail -f ~/Library/Logs/claude-code-discord-sync.log            # logs
   ```

   Re-run the `sed` line after moving the repo or changing Node versions.

## Commands in a session channel

| Message | What happens |
|---|---|
| plain text | Pasted into the session followed by Enter. If Claude is busy, Claude Code queues it as usual. A ✅ reaction means it was delivered. Refused while a prompt is open. |
| `/command` | Slash commands pass through like any other text. |
| `!keys <keys>` | Sends raw keys, up to 20, for prompts the buttons can't handle (multi-select, tall prompts). Allowed: digits `0`–`9`, `Up`, `Down`, `Left`, `Right`, `Enter`, `Escape`, `Tab`, `BTab` (Shift-Tab), `Space`, `BSpace`. Example: `!keys Down Enter`. |
| `!type <text>` | Pastes the text even while a prompt is open, for example to fill in an "Other" answer. |
| `!archive` | In a live session: archive the channel instead of deleting it when the session ends. In an ended session: archive it now. |

Any other message starting with `!` is refused. Claude Code runs input that starts with `!` as a
shell command, so the watcher never pastes it, and `!type` refuses text that starts with `!` too.

## Configuration

All configuration is through environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | | Bot token. The LaunchAgent reads it from the Keychain. |
| `DISCORD_GUILD_ID` | yes | | ID of the server to mirror into. |
| `DISCORD_USER_ID` | yes | | Your Discord user ID. The only user whose messages and clicks are acted on, and the one who gets pinged. |
| `CLAUDE_DIR` | no | `~/.claude` | Claude Code's data directory. |
| `CCDS_ENDED_TTL_MS` | no | `3600000` | How long an ended session's channel is kept before it is deleted, in milliseconds. |
| `TMUX_SOCKET_NAME` | no | | tmux socket name (as in `tmux -L <name>`) to use instead of the default server. |

## Security notes

- Only messages and button clicks from `DISCORD_USER_ID` in `DISCORD_GUILD_ID` are acted on.
- Anyone who gets into your Discord account can type into your terminal. Turn on two-factor
  authentication.
- Everything Claude prints, including code, file paths and any secret that appears in output, is
  sent to Discord.
- Before sending any keystroke, the watcher checks that the tmux pane still belongs to the same
  Claude process and is not in copy mode.
- The bot token is stored only in the macOS Keychain, never in the repo or the LaunchAgent.

## Limitations

- Relies on undocumented Claude Code internals: the session registry, the transcript format and
  the layout of prompts on screen. A Claude Code update can break it.
- Talks to one tmux server: the default one, or the one named by `TMUX_SOCKET_NAME`.
- Multi-select and other prompts without a plain numbered list get no buttons; answer them with
  `!keys`.
- Output produced while the watcher is not running is not backfilled.
- Images and attachments are not forwarded in either direction.

## Development

```sh
npm test
```
