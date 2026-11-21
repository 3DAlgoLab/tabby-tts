/**
 * Settings tab (Settings > Text to Speech).
 *
 * Controls bind straight to the live config object (`tts.settings` is
 * `config.store.tts`), each change persisting through `config.save()` and
 * notifying the service, which decides whether the change is live (volume) or
 * needs a worker restart (voice, rate, silence, assets dir).
 */
import { Component, HostBinding, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService } from 'tabby-core'

import { TtsSettings } from '../settings'
import { PiperVoice, formatSize } from '../engines/piperVoice'
import { PIPER_VOICES } from '../voiceCatalog'
import { TtsService, AssetProgress, PluginStatus } from '../services/tts.service'
import { SapiEngine } from '../engines/sapi'

const ENGINES = [
    { value: 'auto', label: 'Automatic - Piper if installed, otherwise Windows speech' },
    { value: 'piper', label: 'Piper - local neural voices (download required)' },
    { value: 'sapi', label: 'Windows SAPI - pre-installed, lower quality' },
    { value: 'off', label: 'Disabled' },
]

const LINE_BREAKS = [
    { value: 'flow', label: 'Join wrapped lines - pause only at real sentence breaks' },
    { value: 'pause', label: 'Pause after every line' },
    { value: 'none', label: 'Ignore them - one continuous sentence' },
]

/** Piper's published Windows archive, for the "how big is this" hint. */
const PIPER_ENGINE_BYTES = 62_000_000

@Component({
    template: `
<div class="content-box">
    <div class="row">
        <div class="col-12">

            <h3 class="mb-3">Text to Speech</h3>

            <!-- ------------------------------------------------------ status -->
            <div class="d-flex align-items-center mb-3">
                <span class="badge me-3"
                      [class.bg-success]="state === 'idle'"
                      [class.bg-primary]="state === 'starting'"
                      [class.bg-warning]="state === 'speaking'"
                      [class.bg-danger]="state === 'error'">
                    {{ state }}
                </span>
                <span class="me-3">Engine: <strong>{{ status?.resolved ?? 'off' }}</strong></span>
                <span class="text-muted" *ngIf="status?.running">
                    worker running ({{ status.running }})
                </span>
                <span class="text-muted" *ngIf="!status?.running">
                    no worker - starts on first use
                </span>
            </div>

            <div class="progress mb-3" *ngIf="progress" style="height: 22px">
                <div class="progress-bar progress-bar-striped"
                     [class.bg-danger]="progress.stage === 'error'"
                     [class.bg-success]="progress.stage === 'done'"
                     [class.text-dark]="false"
                     [style.width.%]="percent(progress)"
                     [class.progress-bar-animated]="progress.stage === 'download' && !progress.total">
                    {{ progress.label }} - {{ progressText(progress) }}
                </div>
            </div>

            <!-- --------------------------------------------------- downloads -->
            <div class="alert alert-warning py-2" *ngIf="status && !status.assets.engineInstalled">
                <div class="mb-2">
                    <strong>Piper is not installed.</strong>
                    It is a {{ ENGINE_MB }} MB offline speech engine plus one voice model
                    ({{ sizeOf(selectedVoice) }} for the current selection). Nothing is sent
                    over the network while speaking - only these downloads touch the network.
                </div>
                <button class="btn btn-sm btn-primary me-2"
                        [disabled]="busy || !status.assets.supported"
                        (click)="installEngine()">
                    Download Piper
                </button>
                <span class="text-muted" *ngIf="!status.assets.supported">
                    No published Piper build for {{ platform }}
                </span>
            </div>

            <div class="alert alert-warning py-2"
                 *ngIf="status?.assets.engineInstalled && !status?.assets.selectedVoiceInstalled">
                <div class="mb-2">The selected voice model is not downloaded yet.</div>
                <button class="btn btn-sm btn-primary"
                        [disabled]="busy"
                        (click)="installVoice(selectedVoice)">
                    Download {{ settings.voice }}
                </button>
            </div>

            <!-- ----------------------------------------------------- general -->
            <div class="form-line">
                <div class="header">
                    <div class="title">Enable text to speech</div>
                    <div class="description">Master switch. Off stops every worker and hotkey.</div>
                </div>
                <toggle [ngModel]="settings.enabled"
                        (ngModelChange)="set('enabled', $event)"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Engine</div>
                    <div class="description">
                        Piper runs a local neural model through a background process.
                        Windows SAPI uses the voices that ship with Windows.
                    </div>
                </div>
                <select class="form-control w-50"
                        [ngModel]="settings.engine"
                        (ngModelChange)="set('engine', $event)">
                    <option *ngFor="let e of engines" [value]="e.value">{{ e.label }}</option>
                </select>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Auto-speak on select</div>
                    <div class="description">
                        Speak as soon as text is selected with the mouse or keyboard.
                        Can also be toggled from the toolbar or with a hotkey.
                    </div>
                </div>
                <toggle [ngModel]="settings.autoSpeakOnSelect"
                        (ngModelChange)="set('autoSpeakOnSelect', $event)"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Auto-speak on remote copy</div>
                    <div class="description">
                        Speak what an app inside the terminal copies (tmux copy-mode, vim yank).
                        Needed under tmux with <code>mouse on</code>, where a drag never becomes
                        a terminal selection; <code>Shift</code>+drag still selects locally.
                    </div>
                </div>
                <toggle [ngModel]="settings.autoSpeakOnCopy"
                        (ngModelChange)="set('autoSpeakOnCopy', $event)"></toggle>
            </div>

            <!-- ------------------------------------------------------- voice -->
            <div class="form-line">
                <div class="header">
                    <div class="title">Piper voice</div>
                    <div class="description">
                        English models only. Download once; models live outside the plugin
                        directory so plugin updates keep them.
                    </div>
                </div>
                <div class="d-flex align-items-center">
                    <select class="form-control me-2"
                            [ngModel]="settings.voice"
                            (ngModelChange)="set('voice', $event)">
                        <option *ngFor="let v of catalog" [value]="v.id">
                            {{ v.label }}{{ installed(v) ? '' : ' - not installed' }}
                        </option>
                    </select>
                    <button class="btn btn-sm btn-outline-primary me-2 text-nowrap"
                            [disabled]="busy || installed(selectedVoice)"
                            (click)="installVoice(selectedVoice)">
                        {{ installed(selectedVoice) ? 'installed' : 'download' }}
                    </button>
                    <span class="text-muted text-nowrap">{{ sizeOf(selectedVoice) }}</span>
                </div>
            </div>

            <div class="form-line" *ngIf="sapiAvailable">
                <div class="header">
                    <div class="title">Windows voice</div>
                    <div class="description">Used only when the engine is Windows SAPI.</div>
                </div>
                <select class="form-control w-50"
                        [ngModel]="settings.sapiVoice"
                        (ngModelChange)="set('sapiVoice', $event)">
                    <option value="">System default</option>
                    <option *ngFor="let v of sapiVoices" [value]="v">{{ v }}</option>
                </select>
            </div>

            <div class="d-flex align-items-center my-3">
                <button class="btn btn-primary me-2" (click)="test()">Speak sample</button>
                <button class="btn btn-outline-secondary" (click)="tts.stop()">Stop</button>
                <span class="ms-3 text-muted" *ngIf="state === 'starting'">
                    starting the engine - the first run loads the voice model
                </span>
            </div>

            <!-- ------------------------------------------------------ speech -->
            <div class="form-line">
                <div class="header">
                    <div class="title">Rate</div>
                    <div class="description">{{ settings.rate.toFixed(2) }}x - 1.00x is natural pace.</div>
                </div>
                <input type="range" class="form-range w-50" min="0.6" max="2" step="0.05"
                       [ngModel]="settings.rate" (ngModelChange)="set('rate', $event)">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Volume</div>
                    <div class="description">{{ pct(settings.volume) }}% - applied while playing.</div>
                </div>
                <input type="range" class="form-range w-50" min="0" max="1" step="0.05"
                       [ngModel]="settings.volume" (ngModelChange)="set('volume', $event)">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Sentence pause</div>
                    <div class="description">{{ settings.sentenceSilence.toFixed(2) }} s between sentences.</div>
                </div>
                <input type="range" class="form-range w-50" min="0" max="0.6" step="0.05"
                       [ngModel]="settings.sentenceSilence"
                       (ngModelChange)="set('sentenceSilence', $event)">
            </div>

            <!-- ------------------------------------------------------- limits -->
            <div class="form-line">
                <div class="header">
                    <div class="title">Minimum selection</div>
                    <div class="description">Characters below this are ignored - clicks and stray keys.</div>
                </div>
                <input type="number" class="form-control w-25" min="1"
                       [ngModel]="settings.minChars" (ngModelChange)="set('minChars', $event)">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Maximum utterance</div>
                    <div class="description">
                        Longest selection that will be spoken, characters. Whole logs would
                        otherwise queue an hour of speech.
                    </div>
                </div>
                <input type="number" class="form-control w-25" min="100"
                       [ngModel]="settings.maxChars" (ngModelChange)="set('maxChars', $event)">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Clean terminal noise</div>
                    <div class="description">
                        Strip ANSI escapes, progress bars and bell characters before speaking.
                    </div>
                </div>
                <toggle [ngModel]="settings.sanitize"
                        (ngModelChange)="set('sanitize', $event)"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Line breaks</div>
                    <div class="description">
                        The terminal wraps text for the screen, so a newline is usually not the
                        end of a sentence. Each pause below is where the configured sentence
                        silence is inserted.
                    </div>
                </div>
                <select class="form-control w-50"
                        [ngModel]="settings.lineBreaks"
                        (ngModelChange)="set('lineBreaks', $event)">
                    <option *ngFor="let m of lineBreakModes" [value]="m.value">{{ m.label }}</option>
                </select>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Truncate instead of skipping</div>
                    <div class="description">
                        Speak the first {{ settings.maxChars }} characters of an over-long
                        selection rather than staying silent.
                    </div>
                </div>
                <toggle [ngModel]="settings.truncateLong"
                        (ngModelChange)="set('truncateLong', $event)"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Letters and digits only</div>
                    <div class="description">
                        Speak only words and numbers: box drawing, progress bars, brackets and
                        other symbols are replaced by a pause. Tone punctuation (. , ! ? ; :) is
                        kept, so a question is still read as a question and 1,024 stays one
                        number. Apostrophes inside words are kept, so contractions still read
                        correctly.
                    </div>
                </div>
                <toggle [ngModel]="settings.alphaNumOnly"
                        (ngModelChange)="set('alphaNumOnly', $event)"></toggle>
            </div>

            <!-- ---------------------------------------------------- advanced -->
            <div class="form-line">
                <div class="header">
                    <div class="title">Unload engine after (minutes)</div>
                    <div class="description">
                        Frees the voice model from RAM while idle. 0 keeps it resident.
                    </div>
                </div>
                <input type="number" class="form-control w-25" min="0"
                       [ngModel]="settings.unloadAfterMinutes"
                       (ngModelChange)="set('unloadAfterMinutes', $event)">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Asset folder</div>
                    <div class="description">
                        {{ status?.assets.root }}
                    </div>
                </div>
                <div class="d-flex align-items-center">
                    <input type="text" class="form-control me-2" placeholder="default"
                           [ngModel]="settings.assetsDir"
                           (ngModelChange)="set('assetsDir', $event)">
                    <button class="btn btn-sm btn-outline-secondary text-nowrap"
                            (click)="openFolder()">Open</button>
                </div>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Verbose logging</div>
                    <div class="description">Latency and worker messages in the Tabby log.</div>
                </div>
                <toggle [ngModel]="settings.verbose"
                        (ngModelChange)="set('verbose', $event)"></toggle>
            </div>

        </div>
    </div>
</div>
`,
    styles: [`
        .form-line {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1.5rem;
            padding: 0.6rem 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .form-line .header { flex: 1 1 auto; min-width: 0; }
        .form-line .title { font-weight: 600; }
        .form-line .description { opacity: 0.65; font-size: 0.85rem; }
        .form-line toggle, .form-line select, .form-line input, .form-line .d-flex { flex: 0 0 auto; }
        select option { color: #000; }
    `],
})
export class TtsSettingsComponent implements OnDestroy {
    @HostBinding('class.content-box') true

    readonly engines = ENGINES
    readonly lineBreakModes = LINE_BREAKS
    readonly catalog = PIPER_VOICES
    readonly ENGINE_MB = Math.round(PIPER_ENGINE_BYTES / 1e6)
    readonly platform = `${process.platform}/${process.arch}`

    settings: TtsSettings
    state = 'idle'
    status: PluginStatus | null = null
    progress: AssetProgress | null = null
    sapiVoices: string[] = []
    sapiAvailable = SapiEngine.available

    private subs: Subscription[] = []

    constructor (public tts: TtsService, private config: ConfigService) {
        this.settings = tts.settings
        this.subs.push(
            this.tts.state$.subscribe(s => this.state = s),
            this.tts.status$.subscribe(s => this.status = s),
            this.tts.progress$.subscribe(p => this.progress = p),
        )
        if (this.sapiAvailable) {
            SapiEngine.listVoices().then(r => this.sapiVoices = r.voices).catch(() => null)
        }
    }

    get selectedVoice (): PiperVoice {
        return this.tts.voiceById(this.settings.voice) ?? this.catalog[0]
    }

    get busy (): boolean {
        return !!this.progress && this.progress.stage !== 'done' && this.progress.stage !== 'error'
    }

    installed (v: PiperVoice): boolean {
        return !!this.status?.assets.installedVoices.includes(v.id)
    }

    pct (v: number): number {
        return Math.round(v * 100)
    }

    sizeOf (v: PiperVoice): string {
        return v ? formatSize(v.sizeBytes) : ''
    }

    percent (p: AssetProgress): number {
        if (!p.total) {
            return p.stage === 'done' || p.stage === 'error' ? 100 : 35
        }
        return Math.min(100, Math.round(p.done / p.total * 100))
    }

    progressText (p: AssetProgress): string {
        if (p.stage === 'error') {
            return `${p.label} failed`
        }
        if (p.stage === 'done') {
            return `${p.label} done`
        }
        if (p.stage === 'extract') {
            return p.label
        }
        return p.total ?
            `${p.label} - ${formatSize(p.done)} / ${formatSize(p.total)}` :
            `${p.label} - ${formatSize(p.done)}`
    }

    /** One write path: store, persist, tell the service what changed. */
    set (key: keyof TtsSettings, value: any): void {
        (this.settings as any)[key] = value
        this.config.save()
        this.tts.onSettingsChanged(key)
    }

    test (): void {
        this.tts.testVoice()
    }

    installEngine (): void {
        void this.tts.installEngine()
    }

    installVoice (v: PiperVoice): void {
        if (v) {
            void this.tts.installVoice(v)
        }
    }

    openFolder (): void {
        // The renderer keeps Node integration on, and builtin plugins already
        // require('electron'); a failed require must not break the settings tab.
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { shell } = require('electron')
            void shell.openPath(this.status?.assets.root ?? this.tts.root)
        } catch {
            // no shell available - the path above is still selectable
        }
    }

    ngOnDestroy (): void {
        this.subs.forEach(s => s.unsubscribe())
    }
}
