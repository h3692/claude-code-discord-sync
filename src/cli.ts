#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDirFor, readConfig, readToken } from './config.ts'
import { main } from './index.ts'

const usage = `Usage: claude-code-discord-sync <command>

Commands:
  setup      connect your Discord bot and start the watcher at login
  start      run the watcher in the foreground
  status     show the config, the service and live sessions
  uninstall  remove the service, the stored token and the config`

const command = process.argv[2]
switch (command) {
  case 'start': {
    // Env vars still override the stored setup, so manual setups keep working.
    const config = readConfig(join(configDirFor(process.platform, process.env, homedir()), 'config.json'))
    const token = process.env.DISCORD_BOT_TOKEN || readToken()
    const guildId = process.env.DISCORD_GUILD_ID || config.guildId
    const userId = process.env.DISCORD_USER_ID || config.userId
    if (!token || !guildId || !userId) {
      console.error('Not set up yet. Run `claude-code-discord-sync setup`, or set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and DISCORD_USER_ID.')
      process.exit(1)
    }
    main({
      token,
      guildId,
      userId,
      claudeDir: process.env.CLAUDE_DIR || join(homedir(), '.claude'),
      ttl: Number(process.env.CCDS_ENDED_TTL_MS) || 3_600_000,
    })
    break
  }
  case 'setup':
  case 'status':
  case 'uninstall':
    console.error(`${command} is not available yet`)
    process.exit(1)
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(usage)
    break
  default:
    console.error(usage)
    process.exit(1)
}
