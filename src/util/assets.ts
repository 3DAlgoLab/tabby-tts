/**
 * Asset layout. Everything lives outside the plugin directory so that a plugin
 * update (npm install into %APPDATA%\tabby\plugins) never throws away a
 * downloaded 60 MB voice model, and so the dev checkout and the installed
 * plugin share one asset store.
 *
 *   <assets>/piper/<runtime>/     piper executable, DLLs, espeak-ng-data
 *   <assets>/voices/<id>.onnx     voice model + <id>.onnx.json config
 *   <assets>/audio/               per-utterance WAV output (transient)
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { PiperVoice } from '../engines/piperVoice'

/** Pinned because the phonemizer ABI and the CLI flags changed after this build. */
export const PIPER_VERSION = '2023.11.14-2'

export interface AssetStatus {
    root: string
    platform: NodeJS.Platform
    /** false on platforms without a published Piper build. */
    supported: boolean
    engineInstalled: boolean
    enginePath: string
    installedVoices: string[]
    selectedVoiceInstalled: boolean
}

export function piperRuntimeId (platform = process.platform, arch = process.arch): string | null {
    if (platform === 'win32' && arch === 'x64') { return 'windows_amd64' }
    if (platform === 'linux' && arch === 'x64') { return 'linux_x86_64' }
    if (platform === 'linux' && arch === 'arm64') { return 'linux_aarch64' }
    if (platform === 'darwin' && arch === 'x64') { return 'macos_x64' }
    if (platform === 'darwin' && arch === 'arm64') { return 'macos_aarch64' }
    return null
}

/** GitHub release asset for the pinned Piper build, or null if unsupported. */
export function piperArchiveUrl (platform = process.platform, arch = process.arch): string | null {
    const id = piperRuntimeId(platform, arch)
    if (!id) {
        return null
    }
    const ext = platform === 'win32' ? 'zip' : 'tar.gz'
    return `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_${id}.${ext}`
}

export function defaultAssetsDir (): string {
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'tabby-tts')
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'tabby-tts')
    }
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'tabby-tts')
}

export function assetsRoot (configured?: string): string {
    return configured?.trim() ? path.resolve(configured.trim()) : defaultAssetsDir()
}

export function piperDir (root: string): string {
    const id = piperRuntimeId()
    return path.join(root, 'piper', id ?? 'unsupported')
}

export function piperExecutable (root: string): string {
    return path.join(piperDir(root), process.platform === 'win32' ? 'piper.exe' : 'piper')
}

export function voicesDir (root: string): string {
    return path.join(root, 'voices')
}

export function audioDir (root: string): string {
    return path.join(root, 'audio')
}

export function voiceModelPath (root: string, id: string): string {
    return path.join(voicesDir(root), `${id}.onnx`)
}

export function voiceConfigPath (root: string, id: string): string {
    return `${voiceModelPath(root, id)}.json`
}

export function isVoiceInstalled (root: string, id: string): boolean {
    try {
        return fs.statSync(voiceModelPath(root, id)).size > 1_000_000 &&
            fs.statSync(voiceConfigPath(root, id)).size > 100
    } catch {
        return false
    }
}

export function installedVoiceIds (root: string): string[] {
    try {
        return fs.readdirSync(voicesDir(root))
            .filter(f => f.endsWith('.onnx'))
            .map(f => f.slice(0, -'.onnx'.length))
            .filter(id => isVoiceInstalled(root, id))
            .sort()
    } catch {
        return []
    }
}

/** True when the piper executable exists and espeak-ng data came with it. */
export function isEngineInstalled (root: string): boolean {
    try {
        const exe = piperExecutable(root)
        const ok = fs.statSync(exe).size > 100_000 &&
            fs.statSync(path.join(piperDir(root), 'espeak-ng-data')).isDirectory()
        return process.platform === 'win32' ? ok : ok && isExecutable(exe)
    } catch {
        return false
    }
}

function isExecutable (p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}

export function assetStatus (root: string, voiceId: string): AssetStatus {
    const installed = installedVoiceIds(root)
    return {
        root,
        platform: process.platform,
        supported: piperArchiveUrl() !== null,
        engineInstalled: isEngineInstalled(root),
        enginePath: piperExecutable(root),
        installedVoices: installed,
        selectedVoiceInstalled: isVoiceInstalled(root, voiceId),
    }
}

export function catalogEntry (catalog: PiperVoice[], id: string): PiperVoice | undefined {
    return catalog.find(v => v.id === id)
}

export function ensureDir (dir: string): void {
    fs.mkdirSync(dir, { recursive: true })
}

/** Best-effort cleanup of old per-utterance WAVs (keeps the audio dir small). */
export function pruneAudioDir (dir: string, maxAgeMs = 60 * 60 * 1000): void {
    const now = Date.now()
    let entries: string[]
    try {
        entries = fs.readdirSync(dir)
    } catch {
        return
    }
    for (const name of entries) {
        if (!name.endsWith('.wav')) {
            continue
        }
        const p = path.join(dir, name)
        try {
            if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
                fs.rmSync(p, { force: true })
            }
        } catch {
            // busy or already gone - the next sweep will get it
        }
    }
}
