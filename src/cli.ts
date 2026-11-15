#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appName, configDirFor, readConfig, readToken } from './config.ts'
import type { Config } from './config.ts'
import { main } from './index.ts'
import { status, uninstall } from './service.ts'
import { setup } from './setup.ts'

const usage = `Usage: claude-code-discord-sync <command>

Commands:
  setup      connect your Discord bot and start the watcher at login
  start      run the watcher in the foreground
  status     show the config, the service and live sessions
  uninstall  remove the service, the stored token and the config`

const command = process.argv[2]
switch (command) {
  case 'start': {
    // The Windows Run entry: detach a hidden watcher that logs to a file, and return.
    if (process.argv[3] === '--background') {
      const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), appName(process.env))
      mkdirSync(dir, { recursive: true })
      const log = openSync(join(dir, 'watcher.log'), 'a')
      spawn(process.execPath, [process.argv[1], 'start'], { detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref()
      break
    }
    // Env vars still override the stored setup, so manual setups keep working; with all three, the config isn't read.
    const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_USER_ID } = process.env
    let config: Config = {}
    if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_USER_ID) {
      try {
        config = readConfig(join(configDirFor(process.platform, process.env, homedir()), 'config.json'))
      } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
      }
    }
    const token = DISCORD_BOT_TOKEN || readToken()
    const guildId = DISCORD_GUILD_ID || config.guildId
    const userId = DISCORD_USER_ID || config.userId
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
    try {
      await setup()
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }
    break
  case 'status':
    try {
      await status()
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }
    break
  case 'uninstall':
    uninstall()
    break
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
