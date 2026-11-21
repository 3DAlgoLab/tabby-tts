/**
 * Hotkey registrations. The bindings live in `config.store.hotkeys` (defaults
 * come from TtsConfigProvider), which the user edits under Settings > Hotkeys;
 * this only announces the IDs and their labels.
 */
import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'

import { HOTKEY_SPEAK, HOTKEY_SPEAK_CLIPBOARD, HOTKEY_STOP, HOTKEY_TOGGLE } from '../settings'

@Injectable()
export class TtsHotkeyProvider extends HotkeyProvider {
    async provide (): Promise<HotkeyDescription[]> {
        return [
            { id: HOTKEY_SPEAK, name: 'Read selection aloud' },
            { id: HOTKEY_SPEAK_CLIPBOARD, name: 'Read clipboard aloud' },
            { id: HOTKEY_STOP, name: 'Stop speaking' },
            { id: HOTKEY_TOGGLE, name: 'Toggle auto-speak on selection' },
        ]
    }
}
