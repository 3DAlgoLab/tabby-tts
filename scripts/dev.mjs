#!/usr/bin/env node
/**
 * Run the installed Tabby against this checkout via TABBY_PLUGINS, so `npm run
 * build` + a Tabby restart is all that is needed - no copying into %APPDATA%.
 *
 *   npm run dev                  # loads dist/index.js from this directory
 *   npm run dev -- --cdp         # also open a DevTools port (9223) for scripted checks
 *
 * Extra arguments are forwarded to Tabby.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const cdp = argv.includes('--cdp')
const rest = argv.filter(a => a !== '--cdp')

const candidates = [
    process.env.TABBY_EXE,
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Tabby', 'Tabby.exe'),
    '/Applications/Tabby.app/Contents/MacOS/Tabby',
    path.join(process.env.APPDIR ?? '/opt', 'tabby', 'tabby'),
].filter(Boolean)

const exe = candidates.find(c => fs.existsSync(c))
if (!exe) {
    console.error(`Tabby executable not found. Looked for:\n  ${candidates.join('\n  ')}\nSet TABBY_EXE to override.`)
    process.exit(1)
}
if (!fs.existsSync(path.join(repo, 'dist', 'index.js'))) {
    console.error('dist/index.js is missing - run `npm run build` first')
    process.exit(1)
}

const args = [...(cdp ? ['--remote-debugging-port=9223'] : []), ...rest]
console.log(`spawning ${exe} ${args.join(' ')}`)
console.log(`TABBY_PLUGINS=${repo}`)

const child = spawn(exe, args, {
    stdio: 'inherit',
    env: { ...process.env, TABBY_PLUGINS: repo },
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
