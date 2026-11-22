/**
 * Orchestration: settings -> engine lifecycle -> speak/stop, plus the asset
 * installer the settings tab drives.
 *
 * Lifecycle rules that matter:
 *   - Nothing is spawned until the first utterance (no CPU/RAM at Tabby start),
 *     with one optional prewarm shortly after the app is ready.
 *   - `auto` resolves to Piper when its assets are present, else Windows SAPI.
 *   - Voice/rate/silence changes are process-level for Piper, so the engine is
 *     rebuilt when that signature changes; volume is live (player-side).
 *   - The worker is unloaded after a quiet period so a 60-120 MB voice model is
 *     not held in RAM all day, and it is killed synchronously if Tabby exits.
 */
import { Injectable, NgZone } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import * as fs from 'fs'
import * as path from 'path'

import {
    AppService, BaseTabComponent, ConfigService, HotkeysService, Logger, LogService,
    NotificationsService, PlatformService, SplitTabComponent,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

import {
    DEFAULT_SETTINGS, HOTKEY_SPEAK, HOTKEY_SPEAK_CLIPBOARD, HOTKEY_STOP, HOTKEY_TOGGLE,
    TtsSettings, TtsState, mergeSettings,
} from '../settings'
import { PIPER_VOICES } from '../voiceCatalog'
import { PiperVoice, formatSize, voiceUrl } from '../engines/piperVoice'
import { EngineContext, EngineLog, TtsEngine, TtsEngineError, engineSignature } from '../engines/engine'
import { PiperEngine } from '../engines/piper'
import { SapiEngine } from '../engines/sapi'
import {
    AssetStatus, assetsRoot, assetStatus, catalogEntry, isEngineInstalled, isVoiceInstalled,
    piperArchiveUrl, piperDir, voicesDir,
} from '../util/assets'
import { ProgressFn, downloadFile, extractArchive } from '../util/download'
import { Prepared, prepareForSpeech } from '../util/text'

export interface AssetProgress {
    label: string
    done: number
    /** 0 = unknown size (indeterminate bar). */
    total: number
    stage: 'download' | 'extract' | 'done' | 'error'
}

export interface PluginStatus {
    assets: AssetStatus
    /** Engine the current settings resolve to. */
    resolved: 'piper' | 'sapi' | 'off'
    /** Engine actually running right now, or null when nothing is spawned. */
    running: 'piper' | 'sapi' | null
    catalog: PiperVoice[]
    state: TtsState
    busy: boolean
}

const SAMPLE_TEXT = 'Tabby text to speech is working. Selected terminal output will be read aloud like this.'
const PREWARM_DELAY_MS = 4000
/** Debounce so dragging a slider does not respawn the worker per pixel. */
const RESTART_DEBOUNCE_MS = 700
/** Coalesce the mouseup/keyup pair xterm reports for one selection. */
const AUTO_SPEAK_DEBOUNCE_MS = 250

@Injectable()
export class TtsService {
    private log: Logger
    private engine: TtsEngine | null = null
    private engineSig = ''
    private lastSpoken = ''
    private unloadTimer: NodeJS.Timeout | null = null
    private restartTimer: NodeJS.Timeout | null = null
    private autoTimer: NodeJS.Timeout | null = null
    private warnedMissingAssets = false
    private speaking = false

    readonly state$ = new BehaviorSubject<TtsState>('idle')
    readonly progress$ = new BehaviorSubject<AssetProgress | null>(null)
    readonly status$ = new BehaviorSubject<PluginStatus | null>(null)

    constructor (
        private config: ConfigService,
        private logs: LogService,
        private app: AppService,
        private hotkeys: HotkeysService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private zone: NgZone,
    ) {
        this.log = this.logs.create('TTS')
        // ConfigService.store is a ConfigProxy that only exists once the config has
        // loaded, and plugin modules are constructed before that happens - so the
        // store is never written here, only read (through the guarded getters), and
        // the status is recomputed when the store appears.
        this.refreshStatus()
        this.config.ready$.subscribe(() => {
            const s = this.settings
            this.log.debug(
                `config ready: engine=${s.engine} voice=${s.voice} enabled=${s.enabled} ` +
                `autoSpeakOnSelect=${s.autoSpeakOnSelect} hotkey=${JSON.stringify(this.config.store.hotkeys?.[HOTKEY_SPEAK])}`,
            )
            this.refreshStatus()
        })

        this.bindHotkeys()
        this.prewarmWhenIdle()

        // Belt and braces: the engines also kill their children on process exit,
        // but an explicit stop keeps the worker from surviving a window close.
        window.addEventListener('beforeunload', () => {
            this.stop()
            void this.destroy()
        })
    }

    // ---------------------------------------------------------------- settings

    /**
     * The live, writable settings section (`config.store.tts`). ConfigService
     * already layers TtsConfigProvider.defaults under it, and only keys the user
     * actually changes end up in config.yaml, so this is read as-is and never
     * replaced. Bind the UI here.
     */
    get settings (): TtsSettings {
        return (this.config?.store?.tts as TtsSettings) ?? DEFAULT_SETTINGS
    }

    /**
     * What the engines consume: the stored values clamped into the ranges the
     * synth and the player can actually handle (a hand-edited config.yaml can put
     * any number here). Never write to the result - it is a fresh object per call.
     */
    get effective (): TtsSettings {
        return mergeSettings(this.settings)
    }

    get root (): string {
        return assetsRoot(this.settings.assetsDir)
    }

    resolveEngine (s: TtsSettings = this.settings): 'piper' | 'sapi' | 'off' {
        if (!s.enabled || s.engine === 'off') {
            return 'off'
        }
        if (s.engine === 'piper' || s.engine === 'sapi') {
            return s.engine
        }
        const root = assetsRoot(s.assetsDir)
        if (isEngineInstalled(root) && isVoiceInstalled(root, s.voice)) {
            return 'piper'
        }
        if (SapiEngine.available) {
            return 'sapi'
        }
        // Nothing installed and no fallback: keep pointing at Piper so the error
        // message tells the user exactly what to download.
        return 'piper'
    }

    voiceById (id: string): PiperVoice | undefined {
        return catalogEntry(PIPER_VOICES, id)
    }

    refreshStatus (): void {
        const s = this.settings
        const status: PluginStatus = {
            assets: assetStatus(this.root, s.voice),
            resolved: this.resolveEngine(s),
            running: this.engine?.id ?? null,
            catalog: PIPER_VOICES,
            state: this.state$.value,
            busy: this.progress$.value !== null,
        }
        this.emit(this.status$, status)
    }

    // ------------------------------------------------------------------ speech

    /** Speak arbitrary text (hotkey, toolbar, settings test, auto-speak). */
    async speakText (raw: string, why: string): Promise<void> {
        if (!this.settings.enabled) {
            return
        }
        const prepared = prepareForSpeech(raw, this.effective)
        if (prepared.rejected) {
            this.log.debug(`skip ${why}: ${prepared.rejected} (raw ${prepared.rawLength} chars)`)
            return
        }
        if (this.speaking && prepared.text === this.lastSpoken) {
            this.log.debug(`skip ${why}: same text already spoken`)
            return
        }
        this.logUtterance(prepared, why)
        this.lastSpoken = prepared.text
        await this.run(prepared, why)
    }

    /** One line per utterance, plus the exact text the engine gets when verbose. */
    private logUtterance (prepared: Prepared, why: string): void {
        this.log.debug(`speak ${why}: ${prepared.text.length} chars${prepared.truncated ? ` of ${prepared.rawLength}` : ''}`)
        if (this.effective.verbose) {
            // Quotes make the pauses and stripping visible; capped so no screenful of a
            // user's buffer lands in the log at debug level.
            this.log.debug(`  text: ${JSON.stringify(prepared.text.slice(0, 120))}`)
        }
    }

    /**
     * Read the selection; when nothing is selected, replay the previous utterance.
     * That fallback is what a second press of the button means, and under tmux or vim
     * - where a terminal selection cannot exist at all - it is also the only way to
     * hear the last line again.
     */
    async speakSelection (): Promise<void> {
        const sel = readSelection(focusedTab(this.app))
        if (sel) {
            await this.speakText(sel, 'selection')
            return
        }
        this.log.debug('speak selection: nothing selected, repeating the last utterance')
        await this.repeatLast()
    }

    /** True once something has been spoken, i.e. there is something to replay. */
    get canRepeat (): boolean {
        return this.lastSpoken.length > 0
    }

    /** Replay the last utterance - even though it is by definition the same text. */
    async repeatLast (): Promise<void> {
        if (!this.settings.enabled) {
            return
        }
        if (!this.lastSpoken) {
            this.log.debug('skip repeat: nothing spoken yet')
            this.notifications.notice('Nothing has been spoken yet')
            return
        }
        // The stored text was prepared already, so it must not go through
        // prepareForSpeech a second time - that would append another pause marker - and
        // the identical-text guard in speakText is bypassed on purpose here.
        const prepared: Prepared = { text: this.lastSpoken, rawLength: this.lastSpoken.length, truncated: false }
        this.logUtterance(prepared, 'repeat')
        await this.run(prepared, 'repeat')
    }

    /** Called by the terminal decorator on every selection change. */
    noteSelection (text: string): void {
        if (!text) {
            return
        }
        if (!this.settings.enabled || !this.settings.autoSpeakOnSelect) {
            this.log.debug(`selection (${text.length} chars) ignored: enabled=${this.settings.enabled} autoSpeakOnSelect=${this.settings.autoSpeakOnSelect}`)
            return
        }
        if (this.autoTimer) {
            clearTimeout(this.autoTimer)
        }
        this.autoTimer = setTimeout(() => {
            this.autoTimer = null
            void this.speakText(text, 'auto-select')
        }, AUTO_SPEAK_DEBOUNCE_MS)
    }

    /**
     * Speak the system clipboard. This is the fallback for the case where a
     * terminal selection cannot exist at all: with tmux `mouse on` (or vim with
     * `mouse=a`) the drag is reported to the application instead of xterm, so the
     * only thing you can act on is what that application copied - which lands in
     * the clipboard anyway.
     */
    async speakClipboard (): Promise<void> {
        let text = ''
        try {
            text = this.platform.readClipboard() ?? ''
        } catch (e) {
            this.log.warn(`clipboard read failed: ${(e as Error).message}`)
            this.notifications.error('Could not read the clipboard')
            return
        }
        if (!text.trim()) {
            this.log.debug('speak clipboard: empty')
            this.notifications.notice('Clipboard is empty')
            return
        }
        await this.speakText(text, 'clipboard')
    }

    /**
     * Text an application inside a terminal copied via OSC 52, forwarded by the
     * decorator. Same policy as an automatic selection, own switch.
     */
    noteRemoteCopy (text: string): void {
        if (!text) {
            return
        }
        if (!this.settings.enabled || !this.settings.autoSpeakOnCopy) {
            this.log.debug(`copy (${text.length} chars) ignored: enabled=${this.settings.enabled} autoSpeakOnCopy=${this.settings.autoSpeakOnCopy}`)
            return
        }
        if (this.autoTimer) {
            clearTimeout(this.autoTimer)
        }
        this.autoTimer = setTimeout(() => {
            this.autoTimer = null
            void this.speakText(text, 'copy')
        }, AUTO_SPEAK_DEBOUNCE_MS)
    }

    stop (): void {
        if (this.autoTimer) {
            clearTimeout(this.autoTimer)
            this.autoTimer = null
        }
        this.engine?.cancel()
        this.setState('idle')
    }

    toggleAutoSpeak (): void {
        this.settings.autoSpeakOnSelect = !this.settings.autoSpeakOnSelect
        this.notifications.notice(`Auto-speak on select: ${this.settings.autoSpeakOnSelect ? 'on' : 'off'}`)
        this.refreshStatus()
    }

    toggleAutoCopy (): void {
        this.settings.autoSpeakOnCopy = !this.settings.autoSpeakOnCopy
        this.notifications.notice(`Auto-speak on remote copy: ${this.settings.autoSpeakOnCopy ? 'on' : 'off'}`)
        this.refreshStatus()
    }

    testVoice (): void {
        void this.speakText(SAMPLE_TEXT, 'test')
    }

    private async run (prepared: Prepared, why: string): Promise<void> {
        this.speaking = true
        this.clearUnload()
        this.setState('starting')
        try {
            const engine = await this.getEngine()
            this.setState('speaking')
            await engine.speak(prepared.text)
            this.setState('idle')
            if (prepared.truncated) {
                this.log.debug(`spoke ${this.effective.maxChars} chars of ${prepared.rawLength} (${why}), rest truncated`)
            }
        } catch (e) {
            this.setState('error')
            this.reportError(e)
            setTimeout(() => {
                if (this.state$.value === 'error') {
                    this.setState('idle')
                }
            }, 4000)
        } finally {
            this.speaking = false
            this.armUnload()
        }
    }

    private reportError (e: unknown): void {
        const msg = (e as Error)?.message ?? String(e)
        const hint = e instanceof TtsEngineError ? e.hint : undefined
        this.log.error(`speech failed: ${msg}`, e)
        this.notifications.error(`Text to speech: ${msg}`, hint)
    }

    // ------------------------------------------------------------------ engine

    private engineLog (): EngineLog {
        const log = this.log
        const verbose = () => this.settings.verbose
        return {
            debug: m => { if (verbose()) { log.debug(m) } },
            info: m => { if (verbose()) { log.info(m) } },
            warn: m => log.warn(m),
            error: (m, e) => log.error(m, e),
        }
    }

    private context (): EngineContext {
        return { settings: this.effective, assetsRoot: this.root, log: this.engineLog() }
    }

    private async getEngine (): Promise<TtsEngine> {
        const name = this.resolveEngine()
        if (name === 'off') {
            throw new TtsEngineError('Text to speech is disabled', 'Enable it in Settings > Text to Speech.')
        }
        const sig = engineSignature(this.effective, this.root)
        if (this.engine && this.engineSig !== sig) {
            await this.disposeEngine()
        }
        if (!this.engine) {
            this.engine = name === 'piper' ? new PiperEngine(this.context()) : new SapiEngine(this.context())
            this.engineSig = sig
        }
        await this.engine.start()
        return this.engine
    }

    private async disposeEngine (): Promise<void> {
        const engine = this.engine
        this.engine = null
        this.engineSig = ''
        if (engine) {
            await engine.dispose().catch(e => this.log.debug(`engine dispose: ${e}`))
            this.refreshStatus()
        }
    }

    private setState (state: TtsState): void {
        this.emit(this.state$, state)
        this.refreshStatus()
    }

    private armUnload (): void {
        const minutes = this.effective.unloadAfterMinutes
        this.clearUnload()
        if (!minutes || !this.engine) {
            return
        }
        this.unloadTimer = setTimeout(() => {
            this.log.debug(`unloading ${this.engine?.displayName ?? 'engine'} after ${minutes} min idle`)
            void this.disposeEngine()
        }, minutes * 60_000)
    }

    private clearUnload (): void {
        if (this.unloadTimer) {
            clearTimeout(this.unloadTimer)
            this.unloadTimer = null
        }
    }

    private prewarmWhenIdle (): void {
        this.app.ready$.subscribe(() => {
            setTimeout(() => { void this.prewarm() }, PREWARM_DELAY_MS)
        })
    }

    private async prewarm (): Promise<void> {
        if (!this.settings.enabled || this.engine) {
            return
        }
        const name = this.resolveEngine()
        if (name === 'off') {
            return
        }
        if (name === 'piper' && !isEngineInstalled(this.root)) {
            if (!this.warnedMissingAssets) {
                this.warnedMissingAssets = true
                this.notifications.info(
                    'Text to speech: Piper is not downloaded yet',
                    'Open Settings > Text to Speech to install the offline engine and an English voice.',
                )
            }
            return
        }
        try {
            await (await this.getEngine()).start()
        } catch (e) {
            this.log.warn(`prewarm skipped: ${(e as Error).message}`)
        }
    }

    /**
     * Called by the settings tab when a knob changed. Volume is live; the other
     * process-level knobs rebuild the worker once the user stops fiddling.
     */
    onSettingsChanged (key: keyof TtsSettings): void {
        if (key === 'volume') {
            this.engine?.setVolume?.(this.effective.volume)
            return
        }
        if (key === 'enabled') {
            if (!this.settings.enabled) {
                this.stop()
                void this.disposeEngine()
            }
            this.refreshStatus()
            return
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
        }
        this.restartTimer = setTimeout(() => {
            const sig = engineSignature(this.effective, this.root)
            if (this.engine && this.engineSig !== sig) {
                this.log.debug(`restarting engine (${key} changed)`)
                void this.disposeEngine().then(() => this.prewarm())
            }
            this.refreshStatus()
        }, RESTART_DEBOUNCE_MS)
    }

    // ----------------------------------------------------------------- hotkeys

    private bindHotkeys (): void {
        this.hotkeys.hotkey$.subscribe(hotkey => {
            switch (hotkey) {
                case HOTKEY_SPEAK:
                    void this.speakSelection()
                    break
                case HOTKEY_SPEAK_CLIPBOARD:
                    void this.speakClipboard()
                    break
                case HOTKEY_STOP:
                    this.stop()
                    break
                case HOTKEY_TOGGLE:
                    this.toggleAutoSpeak()
                    break
            }
        })
    }

    // ------------------------------------------------------------------ assets

    async installEngine (): Promise<boolean> {
        const url = piperArchiveUrl()
        if (!url) {
            this.notifications.error(`No Piper build published for ${process.platform}/${process.arch}`)
            return false
        }
        const root = this.root
        const archive = path.join(root, 'tmp', `piper-${Date.now()}${path.extname(url) === '.gz' ? '.tar.gz' : '.zip'}`)
        fs.mkdirSync(path.dirname(archive), { recursive: true })

        const ok = await this.withProgress('Piper engine', 'download', 0, report =>
            downloadFile(url, archive, report))
        if (!ok) {
            return false
        }
        const extracted = await this.withProgress('Unpacking Piper', 'extract', 0, async () => {
            await extractArchive(archive, piperDir(root))
            await fs.promises.rm(archive, { force: true })
        })
        if (!extracted) {
            return false
        }
        this.refreshStatus()
        if (!isEngineInstalled(root)) {
            this.notifications.error('Piper unpacked but the executable is missing', `Expected ${piperDir(root)}`)
            return false
        }
        this.notifications.info('Piper engine installed')
        void this.prewarm()
        return true
    }

    async installVoice (voice: PiperVoice): Promise<boolean> {
        const root = this.root
        const dir = voicesDir(root)
        const model = path.join(dir, `${voice.id}.onnx`)
        const config = `${model}.json`

        // Config first: ~5 kB, and it tells the engine the sample rate and phoneme
        // inventory before a 60-120 MB model lands on disk.
        if (!await this.withProgress(`${voice.id} · config`, 'download', 0,
            report => downloadFile(voiceUrl(voice, '.onnx.json'), config, report))) {
            return false
        }
        const ok = await this.withProgress(`${voice.id} · ${formatSize(voice.sizeBytes)}`, 'download', voice.sizeBytes,
            report => downloadFile(voiceUrl(voice, '.onnx'), model, report, voice.md5))
        if (!ok) {
            return false
        }
        this.refreshStatus()
        // If the configured voice was never installed, switch to the one we have.
        if (!isVoiceInstalled(root, this.settings.voice)) {
            this.settings.voice = voice.id
            this.onSettingsChanged('voice')
        }
        this.notifications.info(`Voice ${voice.id} ready`)
        return true
    }

    /** Progress-bar wrapper. Resolves true on success, notifies and returns false on failure. */
    private async withProgress (
        label: string, stage: AssetProgress['stage'], total: number,
        fn: (report: ProgressFn) => Promise<unknown>,
    ): Promise<boolean> {
        if (this.progress$.value && this.progress$.value.stage !== 'done') {
            this.notifications.notice('Another download is already running')
            return false
        }
        const report: ProgressFn = (done, size) => {
            this.emit(this.progress$, { label, done, total: size || total, stage })
        }
        this.emit(this.progress$, { label, done: 0, total, stage })
        try {
            await fn(report)
            this.emit(this.progress$, { label, done: total, total, stage: 'done' })
            return true
        } catch (e) {
            const msg = (e as Error).message ?? String(e)
            this.log.error(`asset step failed (${label}): ${msg}`, e)
            this.notifications.error(`${label}: ${msg}`)
            this.emit(this.progress$, { label, done: 0, total, stage: 'error' })
            return false
        } finally {
            setTimeout(() => {
                this.emit(this.progress$, null)
                this.refreshStatus()
            }, 1500)
        }
    }

    /** Node callbacks run outside Angular's zone; re-enter it so the UI updates. */
    private emit<T> (subject: BehaviorSubject<T>, value: T): void {
        if (this.zone.isStable) {
            subject.next(value)
        } else {
            this.zone.run(() => subject.next(value))
        }
    }

    /** Kill every worker; called on window unload. */
    async destroy (): Promise<void> {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = null
        }
        this.clearUnload()
        await this.disposeEngine()
    }
}

/** Focused tab, looking through splits. */
function focusedTab (app: AppService): BaseTabComponent | null {
    const tab = app.activeTab
    if (tab instanceof SplitTabComponent) {
        return tab.getFocusedTab() ?? tab
    }
    return tab
}

/** xterm selection, or '' when the tab is not a terminal / has no selection. */
function readSelection (tab: BaseTabComponent | null): string {
    if (tab instanceof BaseTerminalTabComponent) {
        try {
            return tab.frontend?.getSelection() ?? ''
        } catch {
            return ''
        }
    }
    return ''
}

/** Used by the decorator, which already holds the terminal instance. */
export function selectionOf (terminal: BaseTerminalTabComponent<any>): string {
    try {
        return terminal.frontend?.getSelection() ?? ''
    } catch {
        return ''
    }
}
