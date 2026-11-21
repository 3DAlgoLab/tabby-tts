/**
 * Config defaults + a permissive schema.
 *
 * The schema exists so the built-in config editor validates `tts` and offers
 * completion; `additionalProperties: true` keeps it from rejecting keys added by
 * a future version while an older plugin is still loaded.
 */
import { ConfigProvider } from 'tabby-core'

import { DEFAULT_HOTKEYS, DEFAULT_SETTINGS } from './settings'

export class TtsConfigProvider extends ConfigProvider {
    defaults = {
        tts: { ...DEFAULT_SETTINGS },
        hotkeys: { ...DEFAULT_HOTKEYS },
    }

    schema = {
        tts: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                engine: { type: 'string', enum: ['auto', 'piper', 'sapi', 'off'] },
                voice: { type: 'string' },
                sapiVoice: { type: 'string' },
                rate: { type: 'number', minimum: 0.5, maximum: 2.5 },
                volume: { type: 'number', minimum: 0, maximum: 1 },
                autoSpeakOnSelect: { type: 'boolean' },
                autoSpeakOnCopy: { type: 'boolean' },
                minChars: { type: 'number', minimum: 1 },
                maxChars: { type: 'number', minimum: 2 },
                sentenceSilence: { type: 'number', minimum: 0, maximum: 1 },
                sanitize: { type: 'boolean' },
                lineBreaks: { type: 'string', enum: ['flow', 'pause', 'none'] },
                truncateLong: { type: 'boolean' },
                assetsDir: { type: 'string' },
                unloadAfterMinutes: { type: 'number', minimum: 0 },
                verbose: { type: 'boolean' },
            },
            additionalProperties: true,
        },
    }
}
