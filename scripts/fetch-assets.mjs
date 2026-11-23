#!/usr/bin/env node
/**
 * Download the Piper engine and voice models from the command line - the same
 * assets the in-app installer fetches, for headless setup or a machine where
 * you would rather not click through Settings.
 *
 *   node scripts/fetch-assets.mjs --engine --voice en_US-ljspeech-medium
 *   node scripts/fetch-assets.mjs --all-installed     # everything in the catalog already chosen
 *   node scripts/fetch-assets.mjs --dir D:\piper-assets --voice en_US-ryan-high
 *
 * Voice IDs come from src/voiceCatalog.ts. Files land in
 * <assets>/piper/<runtime>/ and <assets>/voices/, shared with the plugin.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'

const PIPER_VERSION = '2023.11.14-2'
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

const runtime = (() => {
    const map = {
        'win32-x64': 'windows_amd64',
        'linux-x64': 'linux_x86_64',
        'linux-arm64': 'linux_aarch64',
        'darwin-x64': 'macos_x64',
        'darwin-arm64': 'macos_aarch64',
    }
    return map[`${process.platform}-${process.arch}`] ?? null
})()

function defaultAssetsDir () {
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tabby-tts')
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'tabby-tts')
    }
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'tabby-tts')
}

function parseArgs (argv) {
    const out = { engine: false, voices: [], dir: null, force: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--engine') { out.engine = true } else
        if (a === '--voice') { out.voices.push(argv[++i]) } else
        if (a === '--dir') { out.dir = path.resolve(argv[++i]) } else
        if (a === '--force') { out.force = true } else
        if (a === '--help' || a === '-h') { out.help = true } else
        { console.error(`unknown argument: ${a}`); process.exit(2) }
    }
    return out
}

function get (url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'tabby-tts', ...headers } }, resolve)
        req.on('error', reject)
        req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${url}`)))
    })
}

async function follow (url, headers) {
    let res = await get(url, headers)
    for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(res.statusCode); hop++) {
        const next = res.headers.location
        res.resume()
        if (!next) {
            throw new Error(`HTTP ${res.statusCode} without Location for ${url}`)
        }
        res = await get(new URL(next, url).toString(), headers)
    }
    return res
}

async function download (url, dest, expectedMd5, force) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (!force && fs.existsSync(dest)) {
        console.log(`  already present: ${dest}`)
        return
    }
    const part = `${dest}.part`
    let offset = 0
    try {
        const local = fs.statSync(part).size
        const remote = await head(url)
        if (remote && local === remote) {
            fs.renameSync(part, dest)
            offset = local
        } else {
            offset = local
        }
    } catch {
        offset = 0
    }

    const res = await follow(url, offset ? { Range: `bytes=${offset}-` } : {})
    if (res.statusCode >= 400) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }
    const size = Number(res.headers['content-length'] ?? 0)
    const total = res.statusCode === 206 ? offset + size : size
    const out = fs.createWriteStream(part, { flags: res.statusCode === 206 ? 'a' : 'w' })
    let done = res.statusCode === 206 ? offset : 0
    let last = 0
    const t0 = Date.now()

    await new Promise((resolve, reject) => {
        res.on('data', chunk => {
            done += chunk.length
            const now = Date.now()
            if (now - last > 500) {
                last = now
                const mb = (done / 1e6).toFixed(1)
                const rate = (done / 1e6 / ((now - t0) / 1000)).toFixed(1)
                const pct = total ? ` ${(done / total * 100).toFixed(0)}%` : ''
                process.stdout.write(`\r  ${mb} MB${pct} of ${(total / 1e6).toFixed(1)} MB, ${rate} MB/s   `)
            }
        })
        res.on('error', reject)
        out.on('error', reject)
        out.on('finish', resolve)
        res.pipe(out)
    })
    process.stdout.write('\r' + ' '.repeat(70) + '\r')
    res.destroy()

    if (expectedMd5) {
        const got = await md5(part)
        if (got !== expectedMd5) {
            fs.rmSync(part, { force: true })
            throw new Error(`md5 mismatch for ${path.basename(dest)}: got ${got}, expected ${expectedMd5}`)
        }
    }
    fs.renameSync(part, dest)
    console.log(`  saved ${dest} (${(done / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

async function head (url) {
    return new Promise(resolve => {
        const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'tabby-tts' } }, res => {
            let size = Number(res.headers['content-length'] ?? 0)
            for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(res.statusCode); hop++) {
                // follow the redirect chain with another HEAD
                return head(new URL(res.headers.location, url).toString()).then(resolve)
            }
            res.resume()
            resolve(size || null)
        })
        req.on('error', () => resolve(null))
        req.end()
    })
}

function md5 (p) {
    return new Promise((resolve, reject) => {
        const h = createHash('md5')
        const s = fs.createReadStream(p)
        s.on('error', reject)
        s.on('data', d => h.update(d))
        s.on('end', () => resolve(h.digest('hex')))
    })
}

function extract (archive, dest) {
    fs.mkdirSync(dest, { recursive: true })
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
    const r = spawnSync(tar, ['-xf', archive, '-C', dest, '--strip-components=1'], { stdio: 'inherit' })
    if (r.status !== 0) {
        throw new Error(`${tar} exited ${r.status}`)
    }
}

/** Voice metadata we need for the URL: id -> dataset path + md5, from the local catalog. */
function catalog () {
    const file = path.join(process.cwd(), 'src', 'voiceCatalog.ts')
    if (!fs.existsSync(file)) {
        return []
    }
    const src = fs.readFileSync(file, 'utf8')
    // The array literal is the operand of the export's assignment. The first '['
    // in the file is the one in the `PiperVoice[]` type annotation, which is not
    // it - slice from the '=' so the JSON boundaries line up.
    const assign = src.search(/=\s*\[/)
    const start = assign < 0 ? -1 : src.indexOf('[', assign)
    const end = src.lastIndexOf(']')
    if (start < 0 || end < start) {
        console.warn('could not find the voice array in src/voiceCatalog.ts; pass full ids and expect no md5 check')
        return []
    }
    try {
        // Keep both brackets: the inner text alone is a bare comma-separated
        // list of objects, which JSON.parse rejects.
        return JSON.parse(src.slice(start, end + 1))
    } catch {
        console.warn('could not parse src/voiceCatalog.ts; pass full ids and expect no md5 check')
        return []
    }
}

const args = parseArgs(process.argv.slice(2))
if (args.help || (!args.engine && args.voices.length === 0)) {
    console.log(`usage: node scripts/fetch-assets.mjs [--engine] [--voice <id>]... [--dir <path>] [--force]

  --engine   download the Piper ${PIPER_VERSION} build for this platform
  --voice    download one voice model (repeatable), e.g. en_US-ljspeech-medium
  --dir      asset root (default ${defaultAssetsDir()})
  --force    re-download even when the file is already there`)
    process.exit(args.help ? 0 : 2)
}

const root = args.dir ?? defaultAssetsDir()
const piperDir = path.join(root, 'piper', runtime ?? 'unsupported')
const voicesDir = path.join(root, 'voices')
console.log(`asset root: ${root}`)

if (args.engine) {
    if (!runtime) {
        console.error(`no published Piper build for ${process.platform}/${process.arch}`)
        process.exit(1)
    }
    const exe = path.join(piperDir, process.platform === 'win32' ? 'piper.exe' : 'piper')
    if (fs.existsSync(exe) && !args.force) {
        console.log(`engine already installed: ${exe}`)
    } else {
        const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
        const url = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_${runtime}.${ext}`
        const archive = path.join(root, 'tmp', `piper.${ext}`)
        console.log(`engine: ${url}`)
        await download(url, archive, null, args.force)
        extract(archive, piperDir)
        fs.rmSync(archive, { force: true })
        console.log(`  installed ${exe}`)
    }
}

const known = catalog()
for (const id of args.voices) {
    const entry = known.find(v => v.id === id)
    if (!entry && !id.includes('/')) {
        console.error(`unknown voice id: ${id} (known: ${known.map(v => v.id).join(', ') || 'catalog not found'})`)
        process.exit(2)
    }
    const datasetPath = entry?.path ?? id
    const stem = datasetPath.endsWith('.onnx') ? datasetPath.slice(0, -'.onnx'.length) : datasetPath
    const model = path.join(voicesDir, `${id}.onnx`)
    console.log(`voice ${id}:`)
    await download(`${VOICE_BASE}/${stem}.onnx.json`, `${model}.json`, null, args.force)
    await download(`${VOICE_BASE}/${stem}.onnx`, model, entry?.md5, args.force)
}
console.log('done')
