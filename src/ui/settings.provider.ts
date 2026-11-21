import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { TtsSettingsComponent } from './settings.component'

@Injectable()
export class TtsSettingsTabProvider extends SettingsTabProvider {
    id = 'tab-tts'
    /** Font Awesome solid name: Settings > ... > <i class="fas fa-volume-up">. */
    icon = 'volume-up'
    title = 'Text to Speech'
    /** After the built-in tabs, which all sit at weight 0. */
    weight = 100

    getComponentType (): any {
        return TtsSettingsComponent
    }
}
