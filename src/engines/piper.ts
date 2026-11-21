/**
 * Piper engine: one long-lived `piper` process per (voice, rate).
 *
 * Protocol, measured against piper 2023.11.14-2 on this machine:
 *   spawn:  piper --model <file> --json_input --sentence_silence <s>
 *                 --length_scale <1/rate> [-q]         (stdout = one path per request)
 *   input:  {"text":"...", "output_file":"<absolute .wav>"}\n
 *   output: the same absolute path on stdout, written *after* the WAV is closed
 *
 * Notes that shaped this implementation:
 *   - `--output_raw` cannot be framed (no utterance boundary), so each request
 *     gets its own WAV file and the stdout path line is the completion signal.
 *   - per-request `length_scale` is ignored by this build; speech rate is a
 *     process flag, so changing it restarts the worker (~1 s, model reload).
 *   - keeping the process alive is what makes selection speech feel instant:
 *     model load is ~0.4-0.9 s once, then synthesis runs at RTF ~0.09
 *     (a 5 s sentence in ~0.15-0.3 s).
 *   - interruption is player-side: synthesis continues, the audio is dropped.
 *     That avoids paying a model reload every time the user reselects.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { audioDir, ensureDir, piperExecutable, pruneAudioDir, voiceModelPath } from '../util/assets'
import { EngineContext, TtsEngine, TtsEngineError } from './engine'
import { WavPlayer } from './wavPlayer'

interface Pending {
    resolve: () => void
    reject: (e: Error) => void
    timer: NodeJS.Timeout
}

interface Job {
    file: string
    dropped: boolean
}

const READY_TIMEOUT_MS = 90_000
const SPEAK_TIMEOUT_MS = 180_000
/** Discarded first utterance: proves the model loads and warms the runtime. */
const WARMUP_TEXT = 'a'

export class PiperEngine implements TtsEngine {
    readonly id = 'piper' as const
    readonly displayName = 'Piper'

    private proc: ChildProcessWithoutNullStreams | null = null
    private stderrTail = ''
    private stdoutTail = ''
    private pending = new Map<string, Pending>()
    private current: Job | null = null
    private seq = 0
    private starting: Promise<void> | null = null
    private disposed = false
    private player: WavPlayer
    private warmupMs = 0

    constructor (private ctx: EngineContext) {
        this.player = new WavPlayer(ctx.settings.volume)
    }

    private get exe (): string {
        return piperExecutable(this.ctx.assetsRoot)
    }

    private get model (): string {
        return voiceModelPath(this.ctx.assetsRoot, this.ctx.settings.voice)
    }

    private get outDir (): string {
        return audioDir(this.ctx.assetsRoot)
    }

    async start (): Promise<void> {
        if (this.disposed) {
            throw new TtsEngineError('engine already disposed')
        }
        if (this.proc) {
            return
        }
        if (this.starting) {
            return this.starting
        }
        this.starting = this.doStart().finally(() => { this.starting = null })
        return this.starting
    }

    private async doStart (): Promise<void> {
        const { settings, log } = this.ctx
        if (!fs.existsSync(this.exe)) {
            throw new TtsEngineError(
                `Piper is not installed (${this.exe})`,
                'Open Settings > Text to Speech and download the Piper engine.',
            )
        }
        if (!fs.existsSync(this.model)) {
            throw new TtsEngineError(
                `Voice "${settings.voice}" is not downloaded`,
                'Download the voice in Settings > Text to Speech.',
            )
        }

        ensureDir(this.outDir)
        pruneAudioDir(this.outDir)

        const args = [
            '--model', this.model,
            '--json_input',
            '--sentence_silence', String(settings.sentenceSilence),
            // length_scale is the inverse of a rate multiplier
            '--length_scale', (1 / settings.rate).toFixed(3),
            '--debug',
        ]
        log.debug(`piper spawn: ${this.exe} ${args.join(' ')}`)
        const t0 = Date.now()
        try {
            this.proc = spawn(this.exe, args, {
                cwd: path.dirname(this.exe),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
        } catch (e) {
            throw new TtsEngineError(`Failed to start piper: ${e}`, undefined)
        }
        const proc = this.proc

        // A child that outlives Tabby would hold its voice model forever, and
        // Windows does not reap children of a dying parent. process 'exit' runs
        // synchronously and ChildProcess.kill() is TerminateProcess, so this is
        // the one cleanup that is guaranteed to happen.
        const killOnExit = () => {
            try {
                proc.kill()
            } catch {
                // already gone
            }
        }
        process.once('exit', killOnExit)
        proc.once('exit', () => process.removeListener('exit', killOnExit))

        proc.stderr.setEncoding('utf8')
        proc.stderr.resume()
        proc.stderr.on('data', (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-8000)
            if (/\[(error|warning)\]/.test(chunk)) {
                this.ctx.log.warn(chunk.trim().slice(0, 400))
            }
        })

        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', chunk => this.onStdout(chunk as string))

        proc.on('error', e => {
            this.ctx.log.error(`piper process error: ${e}`, e)
            this.failAll(new TtsEngineError(`Piper could not start: ${e}`, undefined))
            this.proc = null
        })
        proc.on('exit', (code, signal) => {
            const wasOurs = this.disposed
            this.proc = null
            this.failAll(new TtsEngineError(
                `Piper exited (${signal ?? `code ${code}`})`,
                wasOurs ? undefined : this.explainCrash(),
            ))
            if (!wasOurs) {
                this.ctx.log.warn(`piper exited (${signal ?? code}); it will be restarted on the next utterance`)
            }
        })

        // Readiness = the model actually synthesised something. Waiting for a log
        // line would tie the plugin to a log format; a throwaway utterance proves
        // the whole path (phonemizer, model, WAV writer) and is ~0.15 s.
        const tWarm = Date.now()
        try {
            await this.request(WARMUP_TEXT, READY_TIMEOUT_MS)
            this.warmupMs = Date.now() - tWarm
            log.info(`piper ready in ${Date.now() - t0} ms (model ${path.basename(this.model)}, warmup ${this.warmupMs} ms)`)
        } catch (e) {
            await this.hardStop()
            throw e instanceof TtsEngineError ? e : new TtsEngineError(`Piper failed to start: ${e}`, this.explainCrash())
        }
    }

    /** Piper fails fast with 0xC0000409 on voices it cannot phonemize. */
    private explainCrash (): string | undefined {
        if (/not a single codepoint/.test(this.stderrTail)) {
            return 'This voice is not compatible with Piper 2023.11.14-2 (multi-character phonemes). Pick another voice.'
        }
        const line = this.stderrTail.split('\n').filter(l => /\[error\]|Error/i.test(l)).pop()
        return line?.trim().slice(0, 300)
    }

    private chain: Promise<unknown> = Promise.resolve()

    async speak (text: string): Promise<void> {
        if (this.disposed) {
            throw new TtsEngineError('engine already disposed')
        }
        // Serialise synthesis: piper is single-threaded per request and a second
        // write while the first is in flight would just queue behind it.
        const run = this.chain.then(() => this.doSpeak(text))
        this.chain = run.catch(() => undefined)
        return run
    }

    private async doSpeak (text: string): Promise<void> {
        await this.start()

        const job: Job = { file: '', dropped: false }
        this.current = job
        // A Stop pressed while nothing was playing must not swallow this utterance.
        this.player.arm()
        const t0 = Date.now()
        let file = ''
        try {
            file = await this.request(text, SPEAK_TIMEOUT_MS)
            job.file = file
            const synthMs = Date.now() - t0

            if (job.dropped) {
                this.safeUnlink(file)
                this.ctx.log.debug(`dropped ${synthMs} ms synthesis (cancelled while synthesising)`)
                return
            }

            const size = await this.waitForNonEmpty(file, 2000)
            const result = await this.player.play(file)
            this.ctx.log.debug(`speak ${size} bytes: synth ${synthMs} ms, play ${result}`)
        } finally {
            if (this.current === job) {
                this.current = null
            }
            this.safeUnlink(file)
        }
    }

    /** Ask piper for one utterance; resolves with the WAV path it reported. */
    private request (text: string, timeoutMs: number): Promise<string> {
        const proc = this.proc
        if (!proc) {
            return Promise.reject(new TtsEngineError('piper is not running'))
        }
        const id = ++this.seq
        const file = path.join(this.outDir, `tts-${process.pid}-${id}.wav`)
        const key = path.basename(file).toLowerCase()

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(key)
                reject(new TtsEngineError(`Piper did not answer within ${Math.round(timeoutMs / 1000)} s`))
            }, timeoutMs)

            this.pending.set(key, {
                resolve: () => resolve(file),
                reject: e => { clearTimeout(timer); reject(e) },
                timer,
            })

            const payload = JSON.stringify({ text, output_file: file }) + '\n'
            if (!proc.stdin.write(payload)) {
                // Backpressure only shows up for very long utterances; piper keeps
                // reading, so the queued line is not lost.
                this.ctx.log.debug('piper stdin backpressure')
            }
        })
    }

    private onStdout (chunk: string): void {
        this.stdoutTail = (this.stdoutTail + chunk).slice(-4000)
        let idx: number
        while ((idx = this.stdoutTail.indexOf('\n')) >= 0) {
            const line = this.stdoutTail.slice(0, idx).trim()
            this.stdoutTail = this.stdoutTail.slice(idx + 1)
            if (!line) {
                continue
            }
            const key = path.basename(line).toLowerCase()
            const waiter = this.pending.get(key)
            if (waiter) {
                this.pending.delete(key)
                clearTimeout(waiter.timer)
                waiter.resolve()
            } else {
                this.ctx.log.debug(`unexpected piper stdout line: ${line.slice(0, 200)}`)
            }
        }
    }

    private failAll (e: Error): void {
        for (const [, w] of this.pending) {
            clearTimeout(w.timer)
            w.reject(e)
        }
        this.pending.clear()
    }

    private async waitForNonEmpty (file: string, timeoutMs: number): Promise<number> {
        const deadline = Date.now() + timeoutMs
        let size = 0
        for (;;) {
            try {
                size = fs.statSync(file).size
                if (size > 44) {
                    return size
                }
            } catch {
                size = 0
            }
            if (Date.now() > deadline) {
                throw new TtsEngineError(
                    `Piper reported ${path.basename(file)} but the file is empty (${size} bytes)`,
                    this.explainCrash(),
                )
            }
            await new Promise(r => setTimeout(r, 25))
        }
    }

    private safeUnlink (file: string): void {
        if (!file) {
            return
        }
        fs.rm(file, { force: true }, () => undefined)
    }

    cancel (): void {
        if (this.current) {
            this.current.dropped = true
        }
        this.player.stop()
    }

    setVolume (v: number): void {
        this.player.setVolume(v)
    }

    private async hardStop (): Promise<void> {
        const proc = this.proc
        this.proc = null
        this.failAll(new TtsEngineError('piper stopped'))
        if (!proc) {
            return
        }
        proc.stdin.end()
        await new Promise<void>(resolve => {
            const t = setTimeout(() => {
                proc.kill()
                resolve()
            }, 1500)
            proc.once('exit', () => { clearTimeout(t); resolve() })
        })
    }

    async dispose (): Promise<void> {
        this.disposed = true
        this.player.dispose()
        await this.hardStop()
    }
}
