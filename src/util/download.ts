/**
 * Resumable HTTPS download with md5 verification, plus archive extraction for
 * the Piper release bundle. Pure Node - no Angular, no DOM - so the same code
 * backs both the in-app downloader and scripts/download-assets.mjs.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { spawn } from 'child_process'

import { ensureDir } from './assets'

export type ProgressFn = (done: number, total: number) => void

const SOCKET_TIMEOUT = 30_000
const RETRIES = 3

function request (url: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('http:') ? http : https
        const req = mod.get(url, { headers: { 'User-Agent': 'tabby-tts', ...headers } }, resolve)
        req.setTimeout(SOCKET_TIMEOUT, () => req.destroy(new Error(`timeout after ${SOCKET_TIMEOUT / 1000}s: ${url}`)))
        req.on('error', reject)
    })
}

function hashFile (p: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('md5')
        const s = fs.createReadStream(p)
        s.on('error', reject)
        s.on('data', d => h.update(d as Buffer))
        s.on('end', () => resolve(h.digest('hex')))
    })
}

/**
 * Download `url` to `dest`. Writes to `dest.part`, resumes an existing part,
 * verifies md5 when given, and only then renames into place, so a half-finished
 * download never looks like an installed asset.
 */
export async function downloadFile (url: string, dest: string, onProgress?: ProgressFn, expectedMd5?: string): Promise<void> {
    ensureDir(path.dirname(dest))
    const part = `${dest}.part`

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            await attemptDownload(url, part, onProgress)
            if (expectedMd5) {
                const got = await hashFile(part)
                if (got !== expectedMd5) {
                    fs.rmSync(part, { force: true })
                    throw new Error(`md5 mismatch (got ${got}, expected ${expectedMd5})`)
                }
            }
            fs.renameSync(part, dest)
            return
        } catch (e) {
            if (attempt === RETRIES) {
                throw e
            }
            await new Promise(r => setTimeout(r, 1000 * attempt))
        }
    }
}

async function attemptDownload (url: string, part: string, onProgress?: ProgressFn): Promise<void> {
    let offset = 0
    try {
        offset = fs.statSync(part).size
    } catch {
        offset = 0
    }

    let res = await request(url, offset ? { Range: `bytes=${offset}-` } : {})
    // GitHub and HF both answer with 302s; follow them by hand to keep Range.
    for (let hop = 0; hop < 5 && res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode); hop++) {
        const next = res.headers.location
        res.resume()
        if (!next) {
            throw new Error(`${res.statusCode} without Location`)
        }
        res = await request(new URL(next, url).toString(), offset ? { Range: `bytes=${offset}-` } : {})
    }

    if (res.statusCode === 416) {
        // Part is complete or the server ignored the range; re-fetch from zero.
        res.resume()
        fs.rmSync(part, { force: true })
        return attemptDownload(url, part, onProgress)
    }
    if (res.statusCode === 200 && offset > 0) {
        // Server ignored Range: restart from scratch instead of corrupting the part.
        res.resume()
        fs.rmSync(part, { force: true })
        offset = 0
        res = await request(url, {})
    }
    if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }

    const lengthHeader = Number(res.headers['content-length'] ?? 0)
    const total = res.statusCode === 206 ? offset + lengthHeader : lengthHeader
    const resume = offset > 0 && res.statusCode === 206
    const out = fs.createWriteStream(part, { flags: resume ? 'a' : 'w' })
    let done = offset
    let lastTick = 0

    await new Promise<void>((resolve, reject) => {
        res.on('data', chunk => {
            done += chunk.length
            const now = Date.now()
            if (onProgress && (now - lastTick > 200 || done === total)) {
                lastTick = now
                onProgress(done, total)
            }
        })
        res.on('error', reject)
        out.on('error', reject)
        out.on('finish', () => resolve())
        res.pipe(out)
    })

    if (total && done < total) {
        throw new Error(`truncated stream (${done}/${total} bytes)`)
    }
}

/** Extract a .zip (Windows) or .tar.gz release into `dest` without its top folder. */
export function extractArchive (archive: string, dest: string): Promise<void> {
    ensureDir(dest)
    // Windows 10+ ships bsdtar, which reads zip; -S strips the archive's folder.
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
    const args = ['-xf', archive, '-C', dest, '--strip-components=1']
    return new Promise((resolve, reject) => {
        const p = spawn(tar, args, { windowsHide: true })
        let err = ''
        p.stderr.on('data', d => { err += d.toString() })
        p.on('error', reject)
        p.on('close', code => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`tar exited ${code}: ${err.slice(0, 400)}`))
            }
        })
    })
}
