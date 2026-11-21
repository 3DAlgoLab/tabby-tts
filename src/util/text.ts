/**
 * Terminal selection -> speakable text.
 *
 * A selection is raw terminal content: prompts, box-drawing banners, progress
 * bars, trailing whitespace and, occasionally, stray escape sequences. Piper is
 * fast but not free, so the goal is text that sounds like a sentence rather
 * than like a screenful of punctuation.
 */

/* eslint-disable no-control-regex */

/** CSI / OSC / two-char escapes, the same shape xterm strips on paste. */
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** Lines that carry no speech value: rules, bullet rows, empty prompts. */
const NOISE_LINE = /^[\s\-_=~*#.%•·─━│┃┌┐└┘├┤┬┴┼░▒▓\p{P}]*$/u

/**
 * Characters a voice needs for prosody, kept even in letters/digits-only mode:
 * `?` lifts the pitch of a question, `.` `!` `;` `:` `,` open or close a phrase.
 * Dropping them makes "Is this an error?" read as a flat statement.
 */
const SENTENCE_PUNCT = '.,!?:;'

/**
 * Decorative junk: box drawing, progress bars, ASCII art, brackets, quotes,
 * slashes. Apostrophes are handled separately so that English contractions
 * survive ("don't" would otherwise come out as "don t"), and sentence punctuation
 * is kept for its intonation value - see SENTENCE_PUNCT.
 */
const NON_SENTENCE = new RegExp(`[^\\p{L}\\p{N}\\s'\u2019${SENTENCE_PUNCT}]`, 'gu')
const STRAY_APOSTROPHE = /(?<!\p{L})['\u2019]|['\u2019](?!\p{L})/gu
/** Two or more punctuation marks, possibly spaced ("...", "?!", ", ,"): one is enough. */
const PUNCT_RUN = new RegExp(`[${SENTENCE_PUNCT}](?:[${SENTENCE_PUNCT}\\s]*[${SENTENCE_PUNCT}])+`, 'gu')
/** The mark worth keeping out of such a run: a question beats a full stop. */
const PUNCT_PRIORITY: Record<string, number> = { '?': 6, '!': 5, '.': 4, ';': 3, ':': 2, ',': 1 }

/**
 * Keep letters and digits (of any script) plus sentence punctuation. Each dropped
 * run becomes a space, never nothing, so "foo/bar" reads as two words rather than
 * one glued token. Punctuation *between* digits is left alone: "1.2s" and "1,024"
 * survive, which is how espeak says "one point two" and "one thousand twenty-four".
 */
export function stripToAlnum (text: string): string {
    return text
        .replace(/\u2026/g, '.')  // one ellipsis character -> dots, collapsed just below
        .replace(NON_SENTENCE, ' ')
        .replace(STRAY_APOSTROPHE, ' ')
        .replace(PUNCT_RUN, run => [...run].reduce((a, c) => (PUNCT_PRIORITY[c] ?? 0) > (PUNCT_PRIORITY[a] ?? 0) ? c : a, ''))
        .replace(/\s+([.,!?:;])/gu, '$1')  // "done ," -> "done,"
        .replace(/ {2,}/g, ' ')
}

/** Spoken substitutions for symbols espeak reads awkwardly mid-sentence. */
type SpokenSub = string | ((match: string, ...rest: string[]) => string)
const SPOKEN: Array<[RegExp, SpokenSub]> = [
    [/->|=>|→/g, ' to '],
    [/\|\|/g, ' or '],
    [/&&/g, ' and '],
    [/\$\d+(?:\.\d+)?/g, m => `${m.slice(1)} dollars`],
    [/\b(\d+(?:\.\d+)?)%/g, '$1 percent'],
    [/\bhttps?:\/\//g, ' '],
    [/\bsudo\b/gi, ' sudo '],
]

/**
 * How a line break in the selection is turned into speech.
 *
 * A terminal wraps text for the *screen*, not for the reader, so a hard newline is
 * usually not a sentence end. Piper is given a single line either way - the mode
 * only decides which breaks become a pause.
 *
 * - `flow`  join a wrapped line back onto the previous one, pause at real
 *           boundaries (sentence punctuation, blank line, new prompt/bullet/row)
 * - `pause` a pause after every line
 * - `none`  no pauses at all: every line break is simply a space
 */
export type LineBreaks = 'flow' | 'pause' | 'none'

/** A segment ending like this already says "boundary", nothing to add. */
const BREAK_AFTER = /[.!?:\u2026][)\]"'\u2019\u201d]?$/u
/** A line starting with a lower-case letter is the tail of the line above it. */
const LOWER_START = /^\p{Ll}/u
/** A pause marker: Piper inserts `sentenceSilence` here, espeak gives the rhythm. */
const PAUSE = ' ,'

export interface Prepared {
    /** Text to hand to the engine; always single-line. */
    text: string
    /** Characters in the raw selection. */
    rawLength: number
    truncated: boolean
    /** True when the selection looked like binary/random noise, i.e. do not speak. */
    rejected?: 'empty' | 'too-short' | 'too-long' | 'binary'
}

export function prepareForSpeech (raw: string, opts: { minChars: number, maxChars: number, sanitize: boolean, truncateLong?: boolean, alphaNumOnly?: boolean, lineBreaks?: LineBreaks }): Prepared {
    const rawLength = raw.length
    let text = raw.replace(/\r\n?/g, '\n')

    if (opts.sanitize) {
        text = sanitize(text, opts.alphaNumOnly, opts.lineBreaks ?? 'flow')
    } else {
        text = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
        if (opts.alphaNumOnly) {
            // No per-line pauses to re-add here, so this path loses sentence rhythm.
            text = stripToAlnum(text)
        }
    }

    text = text.replace(/\s+/g, ' ').trim()

    if (!text) {
        return { text: '', rawLength, truncated: false, rejected: 'empty' }
    }
    if (looksLikeNoise(text)) {
        return { text: '', rawLength, truncated: false, rejected: 'binary' }
    }
    if ([...text].length < opts.minChars) {
        return { text: '', rawLength, truncated: false, rejected: 'too-short' }
    }

    let truncated = false
    if ([...text].length > opts.maxChars) {
        if (opts.truncateLong === false) {
            return { text: '', rawLength, truncated: false, rejected: 'too-long' }
        }
        // Cut on a code-point boundary, then on a word boundary when close by.
        const chars = [...text].slice(0, opts.maxChars)
        const lastSpace = chars.lastIndexOf(' ')
        if (lastSpace > opts.maxChars * 0.75) {
            chars.length = lastSpace
        }
        text = chars.join('')
        truncated = true
    }

    return { text, rawLength, truncated }
}

/**
 * Remove escapes/punctuation-only lines and turn line breaks into pauses.
 *
 * `lineBreaks` decides which breaks are audible; see `LineBreaks`. With `none` the
 * text is handed to the engine as one continuous sentence.
 */
export function sanitize (text: string, alphaNumOnly = false, lineBreaks: LineBreaks = 'flow'): string {
    const stripped = text.replace(ANSI, ' ')
    // Blank lines are paragraph boundaries, so split on them *before* the noise
    // filter drops the rows around them.
    const paragraphs = stripped
        .split(/\n(?:[ \t]*\n)+/)
        .map(p => cleanParagraph(p, alphaNumOnly))
        .filter(p => p.length)
    const kept = paragraphs.length ? paragraphs : [cleanParagraph(stripped, alphaNumOnly)]
    return kept.map(p => joinParagraph(p, lineBreaks)).filter(Boolean).join(' ').trim()
}

/** Per line: control chars, noise rows, symbol substitutions, optional alnum strip. */
function cleanParagraph (text: string, alphaNumOnly: boolean): string[] {
    return text.split('\n')
        .map(l => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+$/g, '').trim())
        .filter(l => l && !NOISE_LINE.test(l))
        // Substitutions first: "$5" -> "5 dollars" survives a symbol strip.
        .map(l => SPOKEN.reduce((acc, [re, to]) => typeof to === 'string' ? acc.replace(re, to) : acc.replace(re, to), l))
        .map(l => alphaNumOnly ? stripToAlnum(l).trim() : l)
        .filter(l => l)
}

/** Turn the lines of one paragraph into speakable text under `lineBreaks`. */
function joinParagraph (lines: string[], lineBreaks: LineBreaks): string {
    if (!lines.length) {
        return ''
    }
    if (lineBreaks === 'none') {
        return lines.join(' ')
    }

    const segments: string[] = []
    let current = lines[0]
    for (const line of lines.slice(1)) {
        // A wrapped line starts where the sentence stopped: no punctuation above,
        // a lower-case word below. Anything else (new prompt, list item, log line
        // starting with a timestamp) is a new unit and keeps its pause.
        const wrapped = lineBreaks === 'flow' && !BREAK_AFTER.test(current) && LOWER_START.test(line)
        if (wrapped) {
            current = `${current} ${line}`
        } else {
            segments.push(current)
            current = line
        }
    }
    segments.push(current)

    return segments
        .map(s => /[.!?;:,]$/.test(s) ? s : `${s}${PAUSE}`)
        .join(' ')
}

/**
 * Reject text that would be read as a meaningless hiss: a very low letter share
 * (progress bars, hex dumps, boxed graphics) after sanitising.
 */
export function looksLikeNoise (text: string): boolean {
    const chars = [...text]
    if (chars.length < 8) {
        return false
    }
    let letters = 0
    let weird = 0
    for (const c of chars) {
        if (/[\p{L}\p{N}]/u.test(c)) {
            letters++
        } else if (c === '�' || c === '\ufffd') {
            weird++
        }
    }
    return weird > chars.length * 0.02 || letters < chars.length * 0.25
}
