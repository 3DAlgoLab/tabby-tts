#!/usr/bin/env node
/**
 * Copy the built plugin into Tabby's user plugin directory so the normal
 * (non-dev) Tabby shortcut loads it.
 *
 *   npm run build && npm run install-local
 *
 * The location is not a guess. Tabby's main process sets
 * `userPluginsPath = app.getPath('userData')/plugins`, and the renderer resolves
 * plugins through `nodeModule.globalPaths`, which contains
 * `<userData>/plugins/node_modules` - see initModuleLookup/findPlugins in
 * resources/app.asar (`paths.unshift(path.join(userPluginsPath, 'node_modules'))`).
 * Discovery then accepts a directory whose own package.json carries the
 * `tabby-plugin` keyword, or any `tabby-*`/`terminus-*` child that has one.
 * `%APPDATA%\tabby\plugins` itself is never scanned, so a plugin copied to
 * `plugins\tabby-tts` is simply invisible to Tabby - it has to be
 * `plugins\node_modules\tabby-tts`, which is also where npm installs it.
 *
 * Assets (engine + voices) deliberately do NOT live here: they stay in
 * %LOCALAPPDATA%\\tabby-tts so reinstalling the plugin never re-downloads them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pluginsDir = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'tabby', 'plugins',
)
const nodeModules = path.join(pluginsDir, 'node_modules')
const dest = path.join(nodeModules, 'tabby-tts')
/** Layout used before 0.1.1 - Tabby never scans it, so it is dead weight. */
const stale = path.join(pluginsDir, 'tabby-tts')

if (!fs.existsSync(path.join(repo, 'dist', 'index.js'))) {
    console.error('dist/index.js is missing - run `npm run build` first')
    process.exit(1)
}
if (!fs.existsSync(pluginsDir)) {
    console.error(`Tabby plugin directory not found: ${pluginsDir}\nStart Tabby once, or use \`npm run dev\` (TABBY_PLUGINS).`)
    process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
fs.cpSync(path.join(repo, 'dist'), path.join(dest, 'dist'), { recursive: true })
fs.copyFileSync(path.join(repo, 'package.json'), path.join(dest, 'package.json'))

if (fs.existsSync(stale)) {
    fs.rmSync(stale, { recursive: true, force: true })
    console.log(`removed stale ${stale} (Tabby does not scan that path)`)
}

const bytes = fs.statSync(path.join(dest, 'dist', 'index.js')).size
console.log(`installed ${dest}`)
console.log(`  dist/index.js ${(bytes / 1024).toFixed(0)} kB`)
console.log('restart Tabby (fully quit, not just close the window) to load it')
console.log('check: Settings > Plugins should list "tabby-tts"')
