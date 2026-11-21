/**
 * Fallback engine: Windows SAPI 5, the voices every Windows install already has.
 *
 * One short-lived PowerShell process per utterance, speaking *synchronously*:
 *   - process exit == speech finished, which gives exact engine state for free,
 *   - killing the process is an instant stop,
 *   - no persistent protocol to keep alive, and nothing to respawn after a crash.
 *
 * A persistent worker would remove the ~0.4-0.6 s process start per utterance,
 * but System.Speech's SpeakStarted/SpeakCompleted events are PowerShell *event
 * queue* items: they are never dispatched while the worker is blocked reading
 * stdin, so a resident worker cannot report when speech ends. Piper is the
 * engine for low-latency repeat speech; this one is the zero-download path.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import * as fs from 'fs'

import { EngineContext, TtsEngine, TtsEngineError } from './engine'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Speaks everything on stdin, then exits. */
const SPEAK_SCRIPT = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$vol = $env:TABBY_TTS_VOLUME
if ($vol) { $synth.Volume = [int]$vol }
$rate = $env:TABBY_TTS_RATE
if ($rate) { $synth.Rate = [int]$rate }
$name = $env:TABBY_TTS_VOICE
if ($name) { try { $synth.SelectVoice($name) } catch { } }
$text = [Console]::In.ReadToEnd()
if ($text) { $synth.Speak($text) }
`

/** JSON array of installed voice names. */
const VOICES_SCRIPT = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$names = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{voices=$names; default=$synth.Voice.Name}))
`

export class SapiEngine implements TtsEngine {
    readonly id = 'sapi' as const
    readonly displayName = 'Windows SAPI'

    private current: { proc: ChildProcessWithoutNullStreams | null, cancelled: boolean } | null = null
    private disposed = false
    private busy = Promise.resolve()

    constructor (private ctx: EngineContext) { }

    static get available (): boolean {
        return process.platform === 'win32'
    }

    async start (): Promise<void> {
        if (!SapiEngine.available) {
            throw new TtsEngineError('Windows SAPI is only available on Windows')
        }
        if (!fs.existsSync(POWERSHELL)) {
            throw new TtsEngineError(`PowerShell not found at ${POWERSHELL}`)
        }
    }

    async speak (text: string): Promise<void> {
        if (this.disposed) {
            throw new TtsEngineError('engine already disposed')
        }
        const run = this.busy.then(() => this.doSpeak(text))
        this.busy = run.catch(() => undefined)
        return run
    }

    private doSpeak (text: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const { settings, log } = this.ctx
            const t0 = Date.now()
            const job = { proc: null as ChildProcessWithoutNullStreams | null, cancelled: false }
            this.current = job
            const proc = spawn(POWERSHELL, [
                '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', encodeCommand(SPEAK_SCRIPT),
            ], {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    TABBY_TTS_VOLUME: String(Math.round(settings.volume * 100)),
                    TABBY_TTS_RATE: String(rateToSapi(settings.rate)),
                    TABBY_TTS_VOICE: settings.sapiVoice || '',
                },
            })
            job.proc = proc

            // Same orphan guard as the Piper worker.
            const killOnExit = () => {
                try {
                    proc.kill()
                } catch {
                    // already gone
                }
            }
            process.once('exit', killOnExit)
            proc.once('exit', () => process.removeListener('exit', killOnExit))

            let err = ''
            proc.stdout.resume()
            proc.stderr.setEncoding('utf8')
            proc.stderr.on('data', chunk => { err = (err + chunk).slice(-2000) })
            proc.on('error', e => {
                if (this.current === job) { this.current = null }
                reject(new TtsEngineError(`Could not start PowerShell: ${e}`))
            })
            proc.on('exit', code => {
                if (this.current === job) { this.current = null }
                if (job.cancelled || code === null) {
                    // Stopped by the user: not an error, just silence.
                    resolve()
                    return
                }
                if (code === 0) {
                    log.debug(`sapi spoke ${text.length} chars in ${Date.now() - t0} ms`)
                    resolve()
                } else {
                    reject(new TtsEngineError(`SAPI exited with ${code}`, err.trim().slice(0, 300) || undefined))
                }
            })

            proc.stdin.write(text, 'utf8')
            proc.stdin.end()
        })
    }

    cancel (): void {
        const job = this.current
        if (!job) {
            return
        }
        job.cancelled = true
        if (job.proc) {
            try {
                job.proc.kill()
            } catch {
                // already gone
            }
        }
    }

    /** Live volume changes only need the next utterance, nothing to restart. */
    setVolume (_v: number): void { }

    async dispose (): Promise<void> {
        this.disposed = true
        this.cancel()
        await this.busy.catch(() => undefined)
    }

    /** Installed SAPI voices, for the settings tab. */
    static listVoices (): Promise<{ voices: string[], default: string }> {
        return new Promise((resolve, reject) => {
            const proc = spawn(POWERSHELL, [
                '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
                '-EncodedCommand', encodeCommand(VOICES_SCRIPT),
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            let err = ''
            proc.stdout.setEncoding('utf8')
            proc.stdout.on('data', chunk => { out += chunk })
            proc.stderr.setEncoding('utf8')
            proc.stderr.on('data', chunk => { err += chunk })
            proc.on('error', reject)
            proc.on('exit', code => {
                if (code !== 0) {
                    reject(new Error(`voice list exited with ${code}: ${err.slice(0, 200)}`))
                    return
                }
                try {
                    resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}'))
                } catch (e) {
                    reject(new Error(`could not parse voice list: ${e}`))
                }
            })
        })
    }
}

/** -10..10 semitone-ish steps -> log2 of the rate multiplier, like SAPI expects. */
export function rateToSapi (rate: number): number {
    return Math.max(-10, Math.min(10, Math.round(10 * Math.log2(Math.max(0.25, rate)))))
}

/** PowerShell -EncodedCommand wants UTF-16LE base64 (no quoting problems). */
function encodeCommand (script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64')
}
