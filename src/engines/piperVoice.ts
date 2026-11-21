/**
 * One Piper voice: upstream metadata plus everything needed to download and
 * launch it. Generated entries live in src/voiceCatalog.ts.
 */
export interface PiperVoice {
    /** e.g. `en_US-ljspeech-medium` - also the file stem under `<assets>/voices`. */
    id: string
    /** Human-readable label for the settings UI. */
    label: string
    /** Path inside the piper-voices dataset, used to build the download URL. */
    path: string
    /** `en_US` / `en_GB`. */
    lang: string
    quality: 'high' | 'medium' | 'low'
    sampleRate: number
    /** Model size in bytes, for the download hint. */
    sizeBytes: number
    speakers: number
    /** Documented speaker gender; undefined when the model card is silent. */
    gender?: 'female' | 'male' | 'mixed'
    /** Shown first in the picker. */
    featured?: boolean
    /** md5 of the `.onnx` file as published upstream, verified after download. */
    md5?: string
}

export const VOICE_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

export function voiceUrl (voice: PiperVoice, suffix: '.onnx' | '.onnx.json'): string {
    const base = voice.path.endsWith('.onnx') ? voice.path.slice(0, -'.onnx'.length) : voice.path
    return `${VOICE_BASE_URL}/${base}${suffix}`
}

export function formatSize (bytes: number): string {
    if (bytes >= 1e6) {
        return `${(bytes / 1e6).toFixed(0)} MB`
    }
    return `${Math.max(1, Math.round(bytes / 1e3))} kB`
}
