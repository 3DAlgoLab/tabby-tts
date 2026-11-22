/**
 * Right-click menu inside terminal tabs. `tabHeader` is false/undefined for the
 * terminal body; the tab header menu gets nothing from us, since a selection is
 * not visible there.
 */
import { Injectable } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

import { TtsService, selectionOf } from '../services/tts.service'

@Injectable()
export class TtsContextMenu extends TabContextMenuItemProvider {
    // Right after Copy/Paste (-10), where selection actions belong.
    weight = 0

    constructor (private tts: TtsService) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tabHeader || !(tab instanceof BaseTerminalTabComponent)) {
            return []
        }
        const hasSelection = selectionOf(tab).length > 0
        const settings = this.tts.settings

        return [
            {
                label: 'Read selection aloud',
                enabled: hasSelection,
                click: () => { void this.tts.speakSelection() },
            },
            {
                // Replay of the last utterance. Not gated on a selection: under tmux
                // there is never one, and this is how you hear the previous line again.
                label: 'Repeat last speech',
                enabled: this.tts.canRepeat,
                click: () => { void this.tts.repeatLast() },
            },
            {
                // Always available: under tmux/vim mouse mode this is the only way to
                // read what was just copied if auto-speak on copy is off.
                label: 'Read clipboard aloud',
                click: () => { void this.tts.speakClipboard() },
            },
            {
                label: 'Stop speaking',
                enabled: this.tts.state$.value !== 'idle',
                click: () => this.tts.stop(),
            },
            { type: 'separator' },
            {
                label: 'Auto-speak on select',
                type: 'checkbox',
                checked: settings.autoSpeakOnSelect,
                click: () => this.tts.toggleAutoSpeak(),
            },
            {
                label: 'Auto-speak on remote copy',
                type: 'checkbox',
                checked: settings.autoSpeakOnCopy,
                click: () => this.tts.toggleAutoCopy(),
            },
        ]
    }
}
