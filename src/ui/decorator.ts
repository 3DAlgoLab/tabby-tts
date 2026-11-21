/**
 * Captures selections from every terminal tab.
 *
 * There is no selection observable in the Tabby SDK: `Frontend` only exposes
 * `getSelection()`. The reliable source is xterm itself - `XTermFrontend.xterm`
 * is public in Tabby 1.0.x and `Terminal.onSelectionChange` fires for every
 * selection change however it was made (drag, double/triple click, keyboard,
 * search, programmatic).
 *
 * DOM `mouseup`/`keyup` listeners are kept as a fallback because xterm stops the
 * propagation of its own mouse events, so listening on the tab element alone
 * misses drag selections; they only matter on a Tabby version where the xterm
 * handle is not reachable. Both sources are merged, debounced and de-duplicated,
 * so a single drag still produces exactly one utterance.
 *
 * A second, separate source covers applications that take the mouse away from the
 * terminal - tmux with `mouse on`, vim with `mouse=a`. There the drag never becomes
 * a selection, so nothing above fires; what those apps copy is reported as OSC 52,
 * which Tabby decodes itself (`session.oscProcessor.copyRequested$`) and which is
 * forwarded to `TtsService.noteRemoteCopy`.
 */
import { Injectable } from '@angular/core'
import { fromEvent, merge, Observable, Subscription } from 'rxjs'
import { catchError, debounceTime, distinctUntilChanged, filter, map } from 'rxjs/operators'

import { LogService } from 'tabby-core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'

import { TtsService, selectionOf } from '../services/tts.service'

/** Collapse the burst of events a drag produces into one utterance. */
const DEBOUNCE_MS = 150
/** How long to wait for `frontend.xterm` to appear after the tab is decorated. */
const HOOK_RETRIES = 50
const HOOK_RETRY_MS = 100
/** Wait for a session to exist; then keep checking, slower, for a reconnect. */
const SESSION_POLL_MS = 250
const SESSION_REPOLL_MS = 2000

@Injectable()
export class TtsSelectionDecorator extends TerminalDecorator {
    constructor (private tts: TtsService, private logs: LogService) {
        super()
    }

    attach (terminal: BaseTerminalTabComponent<any>): void {
        const log = this.logs.create('TTS')
        log.debug(`decorator attached to ${terminal.title ?? 'tab'}`)
        const sub: Subscription = this.selection$(terminal)
            .subscribe(text => this.tts.noteSelection(text))
        this.subscribeUntilDetached(terminal, sub)

        const copySub: Subscription = this.remoteCopy$(terminal)
            .subscribe(text => this.tts.noteRemoteCopy(text))
        this.subscribeUntilDetached(terminal, copySub)
    }

    /**
     * Copies made by the application *inside* the terminal. tmux (`set-clipboard
     * on`) and vim report them as OSC 52; Tabby's own OSC middleware decodes them
     * and re-emits the text. The session does not exist yet when a tab is decorated
     * (SSH connects later) and is replaced on reconnect, so the handle is polled and
     * the subscription follows whichever session is current.
     */
    private remoteCopy$ (terminal: BaseTerminalTabComponent<any>): Observable<string> {
        return new Observable<string>(observer => {
            let disposed = false
            let timer: any = null
            let watched: any = null
            let sub: Subscription | null = null
            const log = this.logs.create('TTS')

            const poll = (): void => {
                if (disposed) {
                    return
                }
                const processor = (terminal.session as any)?.oscProcessor
                if (processor && processor !== watched) {
                    watched = processor
                    try {
                        sub?.unsubscribe()
                        sub = processor.copyRequested$?.subscribe({
                            next: (text: string) => observer.next(typeof text === 'string' ? text : ''),
                            error: (e: any) => log.warn(`OSC 52 source failed: ${e?.message ?? e}`),
                        }) ?? null
                        if (sub) {
                            log.debug('copy source: OSC 52 (tmux / vim)')
                        }
                    } catch (e) {
                        watched = null
                        log.warn(`OSC 52 hook failed: ${(e as Error).message}`)
                    }
                }
                timer = setTimeout(poll, watched ? SESSION_REPOLL_MS : SESSION_POLL_MS)
            }
            poll()

            return () => {
                disposed = true
                if (timer) {
                    clearTimeout(timer)
                }
                try {
                    sub?.unsubscribe()
                } catch { /* already closed */ }
            }
        })
    }

    /** Text of the current selection, emitted once per distinct selection. */
    private selection$ (terminal: BaseTerminalTabComponent<any>): Observable<string> {
        return merge(this.xtermSelection$(terminal), this.domSelection$(terminal)).pipe(
            debounceTime(DEBOUNCE_MS),
            map(text => text ?? ''),
            distinctUntilChanged(),
            filter(text => text.length > 0),
        )
    }

    /** xterm's own selection event, polled briefly because the frontend is built
     * after the decorator is attached. Never errors: the DOM source stays useful. */
    private xtermSelection$ (terminal: BaseTerminalTabComponent<any>): Observable<string> {
        return new Observable<string>(observer => {
            let disposed = false
            let timer: any = null
            let listener: { dispose?: () => void } | null = null
            let tries = HOOK_RETRIES

            const hook = (): void => {
                if (disposed) {
                    return
                }
                const xterm = (terminal.frontend as any)?.xterm
                if (xterm?.onSelectionChange) {
                    try {
                        listener = xterm.onSelectionChange((text: unknown) => {
                            observer.next(typeof text === 'string' ? text : selectionOf(terminal))
                        })
                        this.logs.create('TTS').debug('selection source: xterm onSelectionChange')
                    } catch (e) {
                        this.logs.create('TTS').warn(`xterm selection hook failed: ${(e as Error).message}`)
                        observer.next('')
                    }
                    return
                }
                if (--tries <= 0) {
                    return
                }
                timer = setTimeout(hook, HOOK_RETRY_MS)
            }
            hook()

            return () => {
                disposed = true
                if (timer) {
                    clearTimeout(timer)
                }
                try {
                    listener?.dispose?.()
                } catch { /* already disposed */ }
            }
        })
    }

    private domSelection$ (terminal: BaseTerminalTabComponent<any>): Observable<string> {
        // `element` is an ElementRef on BaseTerminalTabComponent; read it
        // defensively so a typing difference across Tabby versions cannot throw
        // inside the tab-creation path.
        const element: HTMLElement | undefined = (terminal as any).element?.nativeElement
        if (!element) {
            return new Observable<string>(observer => observer.complete())
        }
        return merge(
            fromEvent(element, 'mouseup'),
            fromEvent(element, 'keyup'),
            fromEvent(element, 'copy'),
        ).pipe(
            map(() => selectionOf(terminal)),
            catchError(() => new Observable<string>(observer => observer.complete())),
        )
    }
}
