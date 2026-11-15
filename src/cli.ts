#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
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
    for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_USER_ID']) {
      if (!process.env[name]) {
        console.error(`Missing required environment variable ${name}`)
        process.exit(1)
      }
    }
    main({
      token: process.env.DISCORD_BOT_TOKEN!,
      guildId: process.env.DISCORD_GUILD_ID!,
      userId: process.env.DISCORD_USER_ID!,
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
