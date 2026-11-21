/**
 * WAV playback in the renderer via Web Audio.
 *
 * The file is read with Node fs and decoded with Chromium's own WAV decoder, so
 * there is no dependency on a `<audio>` element or on file:// URLs (Tabby's page
 * is served from an app:// style origin). Playing through a BufferSource instead
 * of an element is what makes "stop" instant: `source.stop()` cuts the audio in
 * the same frame, while synthesis keeps running in the background.
 */
import * as fs from 'fs'

type Ctor = typeof AudioContext

function audioContextCtor (): Ctor | null {
    const w = window as unknown as { AudioContext?: Ctor, webkitAudioContext?: Ctor }
    return w.AudioContext ?? w.webkitAudioContext ?? null
}

export class WavPlayer {
    private ctx: AudioContext | null = null
    private gain: GainNode | null = null
    private source: AudioBufferSourceNode | null = null
    private stopRequested = false
    private resolveDone: ((r: 'finished' | 'cancelled') => void) | null = null
    private resumeHook: (() => void) | null = null

    constructor (private volume: number) { }

    private ensureContext (): AudioContext | null {
        if (this.ctx) {
            return this.ctx
        }
        const Ctor = audioContextCtor()
        if (!Ctor) {
            return null
        }
        this.ctx = new Ctor()
        this.gain = this.ctx.createGain()
        this.gain.gain.value = this.volume
        this.gain.connect(this.ctx.destination)

        // Chromium suspends contexts created without a user gesture; Tabby
        // plugins usually speak straight after a mouse selection, which is a
        // gesture, but auto-play after a key press is not always seen as one.
        // One pointer/key press anywhere resumes the context for good.
        this.resumeHook = () => { void this.ctx?.resume() }
        document.addEventListener('pointerdown', this.resumeHook, { passive: true })
        document.addEventListener('keydown', this.resumeHook)
        return this.ctx
    }

    /**
     * Play `file` to the end. Resolves 'cancelled' if stop() cut it short.
     * Concurrent calls are serialised by the caller (TtsService queue).
     */
    async play (file: string): Promise<'finished' | 'cancelled'> {
        const ctx = this.ensureContext()
        if (!ctx) {
            throw new Error('Web Audio is not available in this window')
        }
        const buf = await fs.promises.readFile(file)
        // decodeAudioData consumes the ArrayBuffer, so hand it an isolated copy.
        const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const audio = await ctx.decodeAudioData(copy)

        if (ctx.state === 'suspended') {
            await ctx.resume().catch(() => undefined)
        }

        if (this.stopRequested) {
            // Stop arrived while the audio was still being synthesised or decoded;
            // never start what the user already cancelled.
            this.stopRequested = false
            return 'cancelled'
        }

        // Cut any previous utterance (this is what cancel-on-new-selection does).
        this.stopSource()

        const source = ctx.createBufferSource()
        source.buffer = audio
        source.connect(this.gain!)
        const done = new Promise<'finished' | 'cancelled'>((resolve) => {
            // BufferSource has no error event: decoding and start() already throw
            // synchronously/asynchronously for real failures, which propagate out
            // of play(). onended is the only natural completion signal, and stop()
            // settles the same promise by hand - an interrupted source never fires
            // onended once it has been disconnected, so leaving this unresolved
            // would wedge the caller's serialisation chain forever.
            this.resolveDone = value => { this.resolveDone = null; resolve(value) }
            source.onended = () => {
                this.resolveDone = null
                resolve(this.stopRequested ? 'cancelled' : 'finished')
            }
        })
        source.start()
        this.source = source
        return done
    }

    /** Cut the current utterance. Safe to call when idle. */
    stop (): void {
        this.stopRequested = true
        this.stopSource()
    }

    /**
     * Clear a pending stop before a fresh utterance, so a Stop pressed while
     * nothing was playing cannot swallow the next one.
     */
    arm (): void {
        this.stopRequested = false
    }

    private stopSource (): void {
        const s = this.source
        this.source = null
        try {
            s?.disconnect()
        } catch {
            // already stopped or never started
        }
        // Hand-settle the waiter: a stopped source does not report onended once
        // its handler is removed, and the caller awaits this promise.
        const settle = this.resolveDone
        this.resolveDone = null
        settle?.('cancelled')
        if (s) {
            s.onended = null
            try {
                s.stop()
            } catch {
                // already stopped or never started
            }
        }
    }

    setVolume (v: number): void {
        this.volume = Math.min(1, Math.max(0, v))
        if (this.gain) {
            this.gain.gain.value = this.volume
        }
    }

    dispose (): void {
        this.stop()
        if (this.resumeHook) {
            document.removeEventListener('pointerdown', this.resumeHook)
            document.removeEventListener('keydown', this.resumeHook)
            this.resumeHook = null
        }
        void this.ctx?.close()
        this.ctx = null
        this.gain = null
    }
}
