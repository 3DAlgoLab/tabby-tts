# Tabby TTS Plugin

TTS plug-in for [Tabby](https://github.com/Eugeny/tabby) (the terminal app, `tabby-plugin` keyword).

References:

- vscode TTS project (`references/free-tts-for-code`) - text filtering + Piper engine approach.

Features:

- When the user selects a region in a terminal with the mouse, it is copied to the clipboard.
- The plugin synthesizes and plays TTS for that selection.
- Plugin UI: turn playback on/off (toolbar/command, terminal context menu, settings tab).

## Research (done)

### Tabby plugin API - verified against the *installed* app

Installed app: `Tabby 1.0.238` at `%LOCALAPPDATA%\Programs\Tabby`; it ships the plugin
**sources and `.d.ts`** under `resources\builtin-plugins\tabby-*\{src,typings}` - that is the
authoritative API for this machine (npm `tabby-core` latest tag = `1.0.231-nightly.0`, same API).

- A plugin = npm package with `"keywords": ["tabby-plugin"]`, `main: dist/index.js`, whose
  **default export is an `NgModule`**. Loaded from `%APPDATA%\tabby\plugins`, from
  `TABBY_PLUGINS=<dir>`, or from the dev checkout. Template: official example
  [tabby-clippy](https://github.com/Eugeny/tabby-clippy).
- Extension points used here (all `multi: true` providers):
  - `ConfigProvider` (tabby-core) - default config under `tts.*` + `hotkeys.tts-*`.
  - `TerminalDecorator` (tabby-terminal) - `attach(tab)` is called **after** `frontendReady`
    (verified: `baseTerminalTab.component.ts` calls `decorator.attach()` inside the first
    `resize$` handler), so `tab.frontend` is already set. Per-terminal hook.
  - `CommandProvider` (tabby-core) - the modern replacement for the visible toolbar
    (`CommandLocation.LeftToolbar/RightToolbar`, raw SVG in `icon`, `[fastHtmlBind]` in
    `appRoot.component.pug`). Toolbar commands are collected **once** at startup, so the
    toolbar icon cannot show live state; live feedback goes to toasts + context menu labels.
  - `TabContextMenuItemProvider` (tabby-core) - right-click menu in terminals; built on demand,
    so labels can reflect live state. (`TerminalContextMenuItemProvider` is `@deprecated`.)
  - `HotkeyProvider` + `HotkeysService.hotkey$` (subscribe and switch on id), `SettingsTabProvider`
    (tabby-settings) for the settings page.
- Selection access: `tab.frontend.getSelection()` / `copySelection()` / `clearSelection()`
  (`Frontend`), and `frontend.xterm.onSelectionChange()` via `XTermFrontend.xterm` (public,
  `XTermWebGLFrontend extends XTermFrontend` so one `instanceof` covers both).
- Clipboard: `PlatformService.setClipboard({ text })` / `readClipboard()` - works on desktop.
- Renderer has Node integration (builtin plugins `require('electron')`, `mz/child_process`), so
  `child_process.spawn` from the plugin is fine.

### TTS engine - measured on this machine

- Windows SAPI (`Add-Type -AssemblyName System.Speech`) has 3 voices installed:
  `Microsoft David Desktop` (en-US), `Microsoft Zira Desktop` (en-US),
  `Microsoft Heami Desktop` (ko-KR).
- Cold `powershell.exe` start = **0.35 s**; a persistent PowerShell worker + `SpeakAsync`
  measures **0.20 s** from request to `start` event, ready in 0.56 s once. Worker protocol was
  prototyped end-to-end: JSON-lines on stdin, events on stdout, `SpeakAsyncCancelAll()` for
  interruption, and UTF-8 payloads carried as **base64** (PS 5.1 decodes redirected stdin with
  the OEM codepage, which mangles Hangul - base64 makes it encoding-proof).
- Chosen default engine: **`sapi`** (zero download, offline, instant). Piper (the reference
  project's engine: bundled binary + `.onnx` voices, ~60 MB download) is left as an opt-in
  backend behind the same `SpeechEngine` interface.

## Plan

1. **Scaffold** - `package.json` (`tabby-plugin` keyword, `main: dist/index.js`), `tsconfig.json`
   (Angular 15 / TS 4.9), `webpack.config.js` (`target: node`, UMD, everything Angular / `tabby-*`
   / `rxjs` / `@xterm/*` / node builtins external), `.gitignore`, dev helper scripts
   (`dev` = run Tabby with `TABBY_PLUGINS`, `install-local` = copy into the plugins dir).
2. **Engine layer** (`src/engines/`) - `SpeechEngine` interface (`init/speak/stop/listVoices/dispose`),
   `SapiEngine` (persistent PowerShell worker, base64 JSON-lines, auto-restart on death),
   `SayEngine` (macOS `say`), `UnsupportedEngine`; `createEngine()` factory by platform/config.
3. **Text pipeline** (`src/filter.ts`) - port `sanitizeText` from the reference project
   (control chars, unicode controls, emoji, custom regex patterns, whitespace collapse) and add
   terminal-specific handling: join xterm's hard-wrapped lines into sentences, optional shell
   prompt stripping, length cap.
4. **Service** (`src/services/tts.service.ts`) - enabled state persisted in config, engine
   lifecycle (lazy start, restart on engine change), debounce, min/max length, dedupe of the
   same selection, clipboard copy, `speakSelection()` for the active tab (split-aware), `stop()`,
   child-process cleanup on quit (`beforeunload` + `ngOnDestroy`).
5. **Selection hook** (`src/ui/decorator.ts`) - `TerminalDecorator`: `xterm.onSelectionChange`
   gated on "a mouse interaction happened on this terminal very recently" (so `Ctrl-Shift-A`
   and programmatic selections stay silent) + debounce, DOM `mouseup`/`keyup` fallback for
   non-xterm frontends, cleanup on `detach`.
6. **UI** (`src/ui/`) - commands (`Toggle read-aloud`, `Read selection now`, `Stop speaking`),
   terminal context menu entries with live labels, hotkeys
   (`tts-toggle`, `tts-speak-selection`, `tts-stop`, empty defaults to avoid collisions),
   settings tab (master switch, voice, rate, volume, trigger mode, debounce, limits, filter
   options, Test/Stop buttons).
7. **Verify** - build, load into the installed Tabby, check `%APPDATA%\tabby\log.txt`, drive the
   renderer over CDP (`--remote-debugging-port`) to confirm: plugin module loads, decorator
   attaches, worker spawns, selection -> clipboard + speech, toggle off silences it.

## TODO

- [x] Check how to write a Tabby plugin (API + build layout, verified against installed 1.0.238)
- [x] Check vscode TTS project to learn the TTS engine usage (`src/extension.ts`: piper + wav playback)
- [x] Write an implementation plan (above)
- [x] Implement it (scaffold, engines, filter, service, decorator, commands/menu/settings)
- [x] Verify in the installed Tabby (load, selection -> speech, toggle, no console errors)
- [x] Piper backend behind `SpeechEngine` (persistent `piper.exe` worker, `--json_input`,
      Web Audio playback, voice compatibility catalog, one-click engine/voice download)
- [x] Text filter options: `sanitize` (ANSI/noise stripping, `$5` -> "5 dollars", line pauses)
      and `alphaNumOnly` (letters/digits only - punctuation, box drawing and progress bars
      become a pause; word-internal apostrophes and non-Latin scripts are kept)
- [x] tmux/vim mouse mode: speak what the app inside the terminal copies (`autoSpeakOnCopy`,
      via Tabby's `session.oscProcessor.copyRequested$` = OSC 52) + *Read clipboard aloud*
      (`tts:speak-clipboard`, `Ctrl-Alt-C`) for the case where even the copy is not reported
- [x] `lineBreaks` (`flow` default / `pause` / `none`): rejoin lines the terminal wrapped, so
      sentence silence lands on real breaks instead of every screen line
- [x] letters/digits-only keeps the punctuation that carries tone (`. , ! ? ; :`) and collapses
      runs like `...` / `?!`, so a filtered question is still read as a question
- [x] *Read the current selection aloud* falls back to repeating the last utterance when nothing
      is selected, plus a *Repeat last speech* entry in the context menu / command palette
- [ ] Non-Windows engines beyond macOS `say`: Linux (`spd-say`/`espeak-ng`)
- [ ] Optional: read the last output block / whole screen (`xterm.buffer`) on hotkey
- [ ] Optional: language auto-detect per selection (voice switching for ko/en mixes)
- [x] Published to npm as `tabby-tts` (0.1.2, git tag `v0.1.2`) - `npm install tabby-tts`
      resolves and ships the verified bundle, and npm's search index picked the `tabby-plugin`
      keyword up ~25 min after the publish, so Tabby's Install tab lists it as **tts**
- [ ] Optional: list it on Tabby's own docs/wiki plugin list once the npm listing is live
