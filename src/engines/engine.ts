/**
 * Engine contract. An engine owns its synthesis process *and* its playback path:
 * Piper produces WAV files that the renderer plays through Web Audio, while SAPI
 * speaks inside its own helper process. Everything above this file (TtsService)
 * only sees start / speak / cancel / dispose.
 */
import { TtsSettings } from '../settings'

export interface EngineLog {
    debug: (msg: string) => void
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string, err?: unknown) => void
}

export interface EngineContext {
    settings: TtsSettings
    /** Resolved asset root, see src/util/assets.ts. */
    assetsRoot: string
    log: EngineLog
}

export interface TtsEngine {
    /** Stable identifier for UI/status. */
    readonly id: 'piper' | 'sapi'
    readonly displayName: string

    /**
     * Bring the engine to a state where speak() has minimal latency: spawn the
     * helper process, load the model, discard a throwaway utterance. Must be
     * idempotent and safe to await concurrently.
     */
    start (): Promise<void>

    /**
     * Synthesize and play `text`, resolving when playback has finished.
     * A cancelled utterance resolves rather than rejects.
     */
    speak (text: string): Promise<void>

    /** Silence right now. Must not throw and must not reject pending speak(). */
    cancel (): void

    /**
     * Live output level, 0..1. Piper applies it in the player; SAPI passes it to
     * the next utterance. Optional because it never needs a restart.
     */
    setVolume? (volume: number): void

    dispose (): Promise<void>
}

/** Raised when the engine cannot produce audio at all (missing assets, crash). */
export class TtsEngineError extends Error {
    constructor (message: string, public hint?: string) {
        super(message)
        this.name = 'TtsEngineError'
    }
}

/** Settings that require the helper process to be restarted. */
export function engineSignature (s: TtsSettings, assetsRoot: string): string {
    return JSON.stringify([
        s.engine, s.voice, s.sapiVoice, s.rate, s.sentenceSilence, s.assetsDir, assetsRoot,
    ])
}
