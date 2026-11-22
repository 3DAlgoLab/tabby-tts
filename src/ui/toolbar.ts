/**
 * Toolbar button + its submenu. The toolbar renders providers once per change,
 * so the labels here stay state-free; live state lives in the settings tab.
 *
 * Two things about reachability, both read out of Tabby 1.0.238:
 *
 * - `title` doubles as the command-palette / start-page label
 *   (`Command.fromToolbarButton` in `commands.service`), so keep it short.
 * - The terminal toolbar exists only where a tab sets `enableToolbar`, and in 1.0.238
 *   that is SSH, Telnet and Serial tabs - a local shell tab has no toolbar at all. So
 *   anything that matters must also live in the tab context menu, whose items the same
 *   service flattens into palette commands.
 */
import { Injectable } from '@angular/core'
import { ToolbarButton, ToolbarButtonProvider } from 'tabby-core'

import { TtsService } from '../services/tts.service'

/** Feather "volume-2", stroked with currentColor so it follows the theme. */
const ICON_SPEAK = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a9 9 0 0 1 0 14"></path></svg>`

@Injectable()
export class TtsToolbarProvider extends ToolbarButtonProvider {
    constructor (private tts: TtsService) {
        super()
    }

    provide (): ToolbarButton[] {
        return [{
            icon: ICON_SPEAK,
            title: 'Read the current selection aloud',
            weight: 100,
            click: () => { void this.tts.speakSelection() },
            submenu: async () => [
                { title: 'Stop speaking', click: () => this.tts.stop() },
                { title: 'Repeat last speech', click: () => { void this.tts.repeatLast() } },
                { title: 'Read clipboard aloud', click: () => { void this.tts.speakClipboard() } },
                { title: 'Toggle auto-speak on select', click: () => this.tts.toggleAutoSpeak() },
                { title: 'Toggle auto-speak on remote copy', click: () => this.tts.toggleAutoCopy() },
                { title: 'Test voice', click: () => this.tts.testVoice() },
            ],
        }]
    }
}
