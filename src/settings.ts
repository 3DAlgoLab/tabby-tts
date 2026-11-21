/**
 * Persisted settings (config.yaml -> `tts:`) plus the hotkey IDs the plugin
 * registers. Keep this file dependency-free (type-only imports aside): it is
 * imported by the config provider, the engines and the settings UI.
 */
import type { LineBreaks } from './util/text'

export type TtsEngineName = 'auto' | 'piper' | 'sapi' | 'off'

export interface TtsSettings {
    /** Master switch. Off = no workers, no hotkey actions. */
    enabled: boolean

    /**
     * `piper`  - local neural TTS, needs a one-time engine + voice download.
     * `sapi`   - Windows SAPI 5 (pre-installed, lower quality, US English voices only by default).
     * `auto`   - piper when its assets are present, otherwise sapi on Windows.
     * `off`    - disabled.
     */
    engine: TtsEngineName

    /** Piper voice ID (see src/voiceCatalog.ts). */
    voice: string

    /** SAPI voice name; empty = system default. */
    sapiVoice: string

    /** Speech rate multiplier. 1.0 = natural. Mapped to piper `--length_scale` = 1/rate. */
    rate: number

    /** 0..1, applied by the player (not the synthesiser) so it can change live. */
    volume: number

    /** Speak automatically whenever text gets selected. */
    autoSpeakOnSelect: boolean

    /**
     * Speak what an application *inside* the terminal copies (OSC 52 - tmux
     * `set-clipboard`, vim yank). With mouse mode on, tmux eats the drag, so no
     * terminal selection ever exists and `autoSpeakOnSelect` cannot fire; the copy
     * is the only signal that you picked something.
     */
    autoSpeakOnCopy: boolean

    /** Selections shorter than this are ignored (mouse clicks, stray characters). */
    minChars: number

    /** Hard cap, so selecting a whole log file does not queue an hour of speech. */
    maxChars: number

    /** Pause between sentences, seconds (piper `--sentence_silence`). */
    sentenceSilence: number

    /** Strip ANSI escapes / collapse terminal noise before speaking. */
    sanitize: boolean

    /**
     * What a newline in the selection does. The terminal wraps for the screen, not
     * for the reader, so the default (`flow`) joins a wrapped line back onto the one
     * above it and keeps a pause only where the text really breaks - each pause is
     * where piper applies `sentenceSilence`.
     */
    lineBreaks: LineBreaks

    /**
     * Speak only letters and digits (any script). Punctuation, box drawing,
     * progress bars and other symbols become a pause instead of being deleted, so
     * words never glue together. Sentence rhythm survives: the per-line pause that
     * `sanitize` appends is added after the strip.
     */
    alphaNumOnly: boolean

    /** Truncate instead of refusing to speak an over-long selection. */
    truncateLong: boolean

    /** Engine/voice assets. Empty = %LOCALAPPDATA%/tabby-tts (Windows). */
    assetsDir: string

    /** Free the synthesis worker (and its model) after this much silence. 0 = keep resident. */
    unloadAfterMinutes: number

    /** Log synth latency to the Tabby devtools console. */
    verbose: boolean
}

export const DEFAULT_SETTINGS: TtsSettings = {
    enabled: true,
    engine: 'auto',
    voice: 'en_US-ljspeech-medium',
    sapiVoice: '',
    rate: 1.0,
    volume: 0.9,
    // On by default: the point of installing a read-aloud plugin is that selecting
    // text should speak. Tabby prunes config values that equal these defaults, so
    // turning it off is what shows up in config.yaml, not turning it on.
    autoSpeakOnSelect: true,
    autoSpeakOnCopy: true,
    minChars: 3,
    maxChars: 4000,
    sentenceSilence: 0.15,
    sanitize: true,
    lineBreaks: 'flow',
    alphaNumOnly: false,
    truncateLong: true,
    assetsDir: '',
    unloadAfterMinutes: 5,
    verbose: false,
}

export const HOTKEY_SPEAK = 'tts:speak-selection'
export const HOTKEY_SPEAK_CLIPBOARD = 'tts:speak-clipboard'
export const HOTKEY_STOP = 'tts:stop'
export const HOTKEY_TOGGLE = 'tts:toggle-auto-speak'

export const DEFAULT_HOTKEYS: Record<string, string> = {
    // Tabby's canonical keystroke format: hyphen-separated, ordered
    // Ctrl-Meta-Alt-Shift-Key (see tabby-core hotkeys.util.getKeystrokeName).
    // Matching is case-insensitive but the separator is fixed - "CTRL+ALT+S"
    // would simply never fire.
    [HOTKEY_SPEAK]: 'Ctrl-Alt-S',
    // Ctrl-Alt-C is free on Windows: Tabby's own defaults there use Ctrl-Alt with
    // arrows, Enter, [ ] and T only.
    [HOTKEY_SPEAK_CLIPBOARD]: 'Ctrl-Alt-C',
    [HOTKEY_STOP]: 'Ctrl-Alt-D',
    [HOTKEY_TOGGLE]: 'Ctrl-Alt-R',
}

/** Engine/player state, surfaced to the toolbar button and the settings tab. */
export type TtsState = 'idle' | 'starting' | 'speaking' | 'error'

export interface TtsStatus {
    state: TtsState
    /** Resolved engine actually running (config `engine` may be `auto`). */
    engine: TtsEngineName
    message?: string
}

/** Merge stored config over defaults; tolerates partial/legacy objects. */
export function mergeSettings (stored: Partial<TtsSettings> | undefined | null): TtsSettings {
    const s: TtsSettings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
    s.rate = clamp(s.rate, 0.5, 2.5)
    s.volume = clamp(s.volume, 0, 1)
    s.sentenceSilence = clamp(s.sentenceSilence, 0, 1)
    s.minChars = Math.max(1, Math.floor(s.minChars))
    s.maxChars = Math.max(s.minChars + 1, Math.floor(s.maxChars))
    s.unloadAfterMinutes = Math.max(0, s.unloadAfterMinutes)
    if (typeof s.voice !== 'string' || !s.voice) {
        s.voice = DEFAULT_SETTINGS.voice
    }
    // Literal check: an unknown value from hand-edited config must not reach the
    // joiner, and listing the modes here keeps this file import-free.
    if (s.lineBreaks !== 'flow' && s.lineBreaks !== 'pause' && s.lineBreaks !== 'none') {
        s.lineBreaks = DEFAULT_SETTINGS.lineBreaks
    }
    return s
}

function clamp (v: number, min: number, max: number): number {
    if (typeof v !== 'number' || !isFinite(v)) {
        return min
    }
    return Math.min(max, Math.max(min, v))
}
