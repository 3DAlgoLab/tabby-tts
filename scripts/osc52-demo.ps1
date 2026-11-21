# Emit an OSC 52 "copy" sequence - byte-for-byte what tmux (`set-clipboard on`) or
# vim (with `clipboard=unnamedplus`) sends when you yank inside the terminal.
#
# Use it to check the "Auto-speak on remote copy" path without needing an SSH or
# tmux session, and to prove whether Tabby is receiving the copy at all:
#
#   powershell -NoProfile -File scripts\osc52-demo.ps1
#   powershell -NoProfile -File scripts\osc52-demo.ps1 'text to be spoken'
#
# If tabby-tts speaks, remote copies are reaching the plugin. If it stays silent
# with auto-speak on, the app is not reporting copies (tmux: `setw -g set-clipboard on`).
param([string]$Text = 'Remote copy test for tabby-tts.')

$ErrorActionPreference = 'Stop'
$base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))

# ESC ] 52 ; c ; <base64> BEL   ("c" is the clipboard selection)
[Console]::Out.Write([char]27 + ']52;c;' + $base64 + [char]7)
Write-Host "OSC 52 sent: $Text"
