# tabby-tts

Read terminal selections aloud in [Tabby](https://github.com/Eugeny/tabby), offline.

Primary engine is [Piper](https://github.com/rhasspy/piper) (local neural TTS, English
voices, ~25 MB per voice); Windows SAPI is the zero-download fallback. Speech is triggered
by selecting text, by the toolbar button, or by hotkey.

Built and verified against Tabby 1.0.238 on Windows x64. Other platforms fall back to
Windows SAPI (Windows only) / report "no engine" elsewhere.

## Install (from this repo)

```
npm install
npm run build
npm run install-local     # copies dist + package.json into %APPDATA%\tabby\plugins\node_modules\tabby-tts
```

Fully quit Tabby (tray icon > Quit, not just closing the window) and start it again. Then
**Settings > Text to Speech** exists, and a **Text to Speech** row appears in the settings
navigation list.

`install-local` copies into `plugins\node_modules\tabby-tts`, *not* `plugins\tabby-tts`.
Tabby's renderer resolves user plugins from `<userData>\plugins\node_modules` (see
`initModuleLookup` / `findPlugins` in `resources\app.asar`) and treats a directory as a plugin
only when its own `package.json`, or a `tabby-*`/`terminus-*` child's, carries the
`tabby-plugin` keyword. `%APPDATA%\tabby\plugins` itself is never scanned, so a copy sitting
one level too high is ignored silently - no error dialog, nothing in the log. `install-local`
deletes such a stale copy when it finds one.

Plugin code lives in `%APPDATA%\tabby\plugins\node_modules\tabby-tts`; assets (the Piper
binary and voice models) are kept separately in `%LOCALAPPDATA%\tabby-tts` so reinstalling
the plugin never re-downloads them.

To confirm it actually loaded, `%APPDATA%\tabby\log.txt` must contain the plugin's own line:

```
debug: config ready: engine=piper voice=en_US-ljspeech-medium enabled=true ...
```

First run with Piper: **Settings > Text to Speech > Engine: Piper**, then press *Install
engine* (~60 MB) and *Install* next to a voice. Everything else works immediately with
SAPI (`Engine: Windows SAPI`).

## Use

| Action | How |
| --- | --- |
| Speak the current selection | toolbar speaker button, or `Ctrl-Alt-S` |
| Speak on selection (automatic) | on by default; toggle in settings, from the toolbar submenu, or `Ctrl-Alt-R` |
| Speak what tmux/vim copies | on by default (`autoSpeakOnCopy`); settings, toolbar submenu, or right-click |
| Read the clipboard aloud | toolbar submenu or right-click *Read clipboard aloud*, or `Ctrl-Alt-C` |
| Stop speaking | toolbar submenu *Stop speaking*, settings *Stop*, or `Ctrl-Alt-D` |
| Test the current voice | settings tab, *Speak example* |

Hotkeys are ordinary Tabby hotkeys (`tts:speak-selection`, `tts:speak-clipboard`, `tts:stop`,
`tts:toggle-auto-speak`) and can be rebound under Settings > Hotkeys.

### Inside tmux, vim, or anything else that grabs the mouse

With `set -g mouse on` (tmux) or `set mouse=a` (vim) the drag is *reported to the application*
instead of selecting text in xterm. There is then no terminal selection at all, so nothing
can be spoken on select and *Read selection aloud* reports "nothing selected" - even though
the text did reach your clipboard. Three ways to still get speech:

1. **Copy it.** tmux copy-mode and vim yank send the copied text out as OSC 52, which Tabby
   decodes and tabby-tts speaks (`autoSpeakOnCopy`, on by default). This matches what you
   already do: you copy, it reads. The application has to report the copy -
   `setw -g set-clipboard on` in `~/.tmux.conf`, and in vim `set clipboard=unnamedplus`.
   Check it without an SSH session, in any local tab:
   `powershell -NoProfile -File scripts\osc52-demo.ps1 'text to be spoken'`
2. **Read the clipboard** (`Ctrl-Alt-C`, or the right-click menu). The copy is in the Windows
   clipboard even when nothing was spoken, so this always works.
3. **Force a local selection**: hold `Shift` while dragging. xterm then keeps the selection
   itself instead of forwarding the mouse, and auto-speak on select behaves exactly as it does
   outside tmux. Use this for text you do not want to copy.

## Settings (Settings > Text to Speech, or `tts:` in config.yaml)

```yaml
tts:
  enabled: true
  engine: auto          # auto | piper | sapi | off
  voice: en_US-ljspeech-medium      # installed Piper voice
  sapiVoice: ''                     # '' = system default
  rate: 1.0                         # 0.6 - 2.0
  volume: 0.9
  autoSpeakOnSelect: true
  autoSpeakOnCopy: true             # speak what tmux/vim copy (OSC 52)
  minChars: 3
  maxChars: 4000
  sentenceSilence: 0.15
  sanitize: true                    # strip control chars / emoji / noise
  lineBreaks: flow                  # flow | pause | none - what a newline in the selection does
  alphaNumOnly: false               # speak letters/digits only; symbols become a pause
  truncateLong: true
  unloadAfterMinutes: 5             # idle worker unload, 0 = keep running
  assetsDir: ''                     # default %LOCALAPPDATA%\tabby-tts
  verbose: false                    # debug lines + a preview of the spoken text
```

Tabby only writes keys that differ from these defaults.

Two toggles shape what reaches the voice:

- **Clean terminal noise** (`sanitize`) - strips ANSI escapes, drops rules, banners and
  progress bars, says `$5` as "5 dollars" and `->` as "to", and turns line breaks into pauses.
- **Letters and digits only** (`alphaNumOnly`) - anything that is not a letter or a digit (of
  any script) becomes a pause instead of being deleted, so `C:\Windows;C:\Program` is read as
  words rather than "colon backslash semicolon". Apostrophes inside words are kept, so
  contractions still sound right, and the sentence pauses added by `sanitize` survive.
- **Auto-speak on remote copy** (`autoSpeakOnCopy`) - speaks text that an application *inside*
  the terminal copies (OSC 52). Needed whenever that application owns the mouse; see
  *Inside tmux, vim, or anything else that grabs the mouse*.
- **Line breaks** (`lineBreaks`) - the terminal wraps text for the screen, not for the reader,
  so a newline is normally *not* the end of a sentence, and pausing at every one of them sounds
  choppy. `flow` (default) joins a wrapped line back onto the line above and pauses only where
  the text really breaks: sentence punctuation, a blank line, or a next line that starts a new
  unit (a prompt, `- ` / `1.` item, a timestamp, any capitalised word). `pause` is the old
  behaviour - a pause after every line. `none` throws the newlines away completely and hands the
  engine one continuous sentence, which is the smoothest but gives no pauses at all, even
  between paragraphs. Every pause is a place where `sentenceSilence` is applied, so lowering it
  (`0.05`, say) softens the choppiness of `pause` without losing line structure. Scripts with no
  letter case - Korean, Japanese, Chinese - cannot be detected as "continuation", so their line
  breaks stay pauses.

## How it works

- `src/util/text.ts` turns a raw selection into one line of speech: symbol substitutions,
  optional letters/digits-only strip, and the `lineBreaks` policy. Pauses are not silence - the
  joiner appends a marker that makes Piper close the sentence, which is where
  `--sentence_silence` is inserted; that is why wrapping every line into its own sentence
  sounded choppy and why `flow` exists.
- `src/ui/decorator.ts` hooks xterm's own `onSelectionChange` (a DOM `mouseup` listener
  never sees terminal selections - xterm stops propagation) and debounces it.
- The same decorator follows `session.oscProcessor.copyRequested$` - Tabby's own OSC 52
  decoder - to catch copies made by tmux or vim, where no selection can exist. The session
  appears late (SSH connects after the tab is created) and is replaced on reconnect, so the
  handle is polled and the subscription follows the current session.
- `src/services/tts.service.ts` owns the engine lifecycle, the selection policy
  (enabled / auto-speak / length limits / dedupe of the same text), and the engine
  restart when a setting that needs it changes.
- `src/engines/piper.ts` keeps one long-lived `piper.exe` per window, feeds it
  `--json_input` lines and reads back the WAV path it wrote; playback goes through Web
  Audio (`wavPlayer.ts`) so *Stop* cuts audio in the same frame while synthesis keeps
  running. Voices are checked against the piper build before use - some published voices
  crash the 2023.11.14-2 binary (`not a single codepoint`).
- `src/engines/sapi.ts` drives `System.Speech` through a persistent PowerShell worker with
  base64 payloads (PowerShell 5.1 decodes redirected stdin with the OEM codepage).
- Temp WAV files are unlinked as soon as playback ends.

## Development

```
npm run watch                                  # webpack watch
node scripts/dev.mjs                           # Tabby with TABBY_PLUGINS pointing at this repo
```

For a throwaway instance that does not touch your real config, both environment variables
matter - `--user-data-dir` alone is *not* enough, because `TABBY_CONFIG_DIRECTORY` (and thus
`config.yaml`) is resolved from the Electron `userData` path only when it is not already set:

```
TABBY_CONFIG_DIRECTORY='D:\dev-utils\tabby-tts\.test-profile' \
TABBY_PLUGINS='D:\dev-utils\tabby-tts' \
Tabby.exe --user-data-dir='D:\dev-utils\tabby-tts\.test-profile' --remote-debugging-port=9223
```

Logs: `<profile>\log.txt` (per profile) or `%APPDATA%\tabby\log.txt` for the real one.
Set `verbose: true` for engine-level debug lines, including a quoted preview of the exact
text handed to the voice - the quickest way to see what a filter option actually did.

## Troubleshooting

- **No Text to Speech settings tab, nothing happens** - the plugin is not being loaded. It has
  to sit at `%APPDATA%\tabby\plugins\node_modules\tabby-tts` (see *Install*), Tabby must have
  been *fully* quit since the copy, and `dist/index.js` must exist (run `npm run build`).
  Settings > Plugins should list **tabby-tts**.

- **Nothing speaks, no error** - check `tts.enabled`, `autoSpeakOnSelect`, and that the
  selection is at least `minChars`. With `verbose: true` the log says exactly why a
  selection was ignored.
- **Silent under tmux or vim** - the application owns the mouse, so the drag never becomes a
  terminal selection. Copy instead (auto-speak on copy), `Shift`+drag to select locally, or
  `Ctrl-Alt-C` to read the clipboard. If copies stay silent, the application is not reporting
  them: `setw -g set-clipboard on` for tmux, `set clipboard=unnamedplus` for vim.
- **`Piper exited (0xc0000409)`** - that voice is not compatible with the pinned Piper
  build; pick another one (the settings tab marks the known-bad ones).
- **Worker died** - it is restarted on the next utterance; the log records the exit.
- **Engine changes** take effect immediately; the worker is respawned (voice, rate,
  sentence silence, assets dir) or applied live (volume).
