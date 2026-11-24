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
        // State read once, when the menu is built: Tabby never updates an open menu.
        // `speaking` takes precedence over the selection, so stopping a long utterance
        // stays offered even if opening the menu cost the selection.
        const speaking = this.tts.isSpeaking
        const settings = this.tts.settings

        return [
            {
                // One item for both directions, the same toggle as the toolbar button -
                // and the same is true of the command-palette entries Tabby flattens from
                // these two providers. It replaces the old separate *Stop speaking* item:
                // while speech was running that item and this one said the same thing,
                // and while it was idle the Stop item was just dead weight.
                label: speaking ? 'Stop speaking' : 'Read selection aloud',
                enabled: speaking || hasSelection,
                click: () => { void this.tts.speakOrStop() },
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
