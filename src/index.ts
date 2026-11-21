/**
 * tabby-tts - read terminal selections aloud in Tabby, offline.
 *
 * Module wiring only. The interesting parts are:
 *   services/tts.service.ts  settings -> engine lifecycle -> speech
 *   engines/                 Piper (local neural) and Windows SAPI workers
 *   ui/decorator.ts          selection capture, the only hook Tabby lacks
 */
import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'

import TabbyCorePlugin, {
    ConfigProvider, HotkeyProvider, TabContextMenuItemProvider, ToolbarButtonProvider,
} from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { TtsConfigProvider } from './config'
import { TtsService } from './services/tts.service'
import { TtsSelectionDecorator } from './ui/decorator'
import { TtsToolbarProvider } from './ui/toolbar'
import { TtsContextMenu } from './ui/contextMenu'
import { TtsHotkeyProvider } from './ui/hotkeys'
import { TtsSettingsTabProvider } from './ui/settings.provider'
import { TtsSettingsComponent } from './ui/settings.component'

@NgModule({
    imports: [CommonModule, FormsModule, TabbyCorePlugin],
    declarations: [TtsSettingsComponent],
    providers: [
        TtsService,
        { provide: ConfigProvider, useClass: TtsConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: TtsHotkeyProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: TtsToolbarProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: TtsContextMenu, multi: true },
        { provide: TerminalDecorator, useClass: TtsSelectionDecorator, multi: true },
        { provide: SettingsTabProvider, useClass: TtsSettingsTabProvider, multi: true },
    ],
})
export default class TabbyTtsModule {
    /**
     * Injecting TtsService instantiates it while the app root is being built, so
     * the hotkeys are bound and the optional prewarm is armed even before the
     * first terminal tab exists.
     */
    constructor (tts: TtsService) {
        void tts
    }
}
