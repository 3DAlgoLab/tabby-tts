#!/usr/bin/env node
/**
 * Generate src/voiceCatalog.ts from the upstream piper-voices index.
 *
 * Piper's 2023.11.14 C++ runtime rejects voices whose `phoneme_id_map` contains
 * multi-codepoint symbols ("aɪ" is not a single codepoint -> fail-fast exit
 * 0xC0000409), so every candidate's model config is probed and only compatible
 * voices are emitted. English only, matching this plugin's target.
 *
 *   node scripts/gen-voices.mjs [--refresh]
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
const INDEX_URL = `${BASE}/voices.json`
const CACHE = path.join(ROOT, '.cache', 'voice-probes.json')

/**
 * Gender where it is documented by the model card or the source dataset.
 * Anything not listed stays undefined and is shown without a gender hint.
 */
const GENDER = {
    'en_US-kristin-medium': 'female',
    'en_US-ljspeech-medium': 'female',
    'en_US-ljspeech-high': 'female',
    'en_US-lessac-medium': 'female',
    'en_US-lessac-high': 'female',
    'en_US-lessac-low': 'female',
    'en_US-amy-low': 'female',
    'en_US-kathleen-low': 'female',
    'en_GB-cori-high': 'female',
    'en_GB-southern_english_female-low': 'female',
    'en_US-ryan-high': 'male',
    'en_US-ryan-low': 'male',
    'en_US-danny-low': 'male',
    'en_US-hfc_male-medium': 'male',
    'en_US-bryce-medium': 'male',
    'en_US-john-medium': 'male',
    'en_US-kusal-medium': 'male',
    'en_US-norman-medium': 'male',
    'en_US-reza_ibrahim-medium': 'male',
    'en_GB-alan-medium': 'male',
    'en_GB-alan-low': 'male',
    'en_GB-northern_english_male-medium': 'male',
    'en_GB-semaine-medium': 'male',
    'en_US-arctic-medium': 'mixed',
    'en_US-l2arctic-medium': 'mixed',
    'en_US-libritts-high': 'mixed',
    'en_US-libritts_r-medium': 'mixed',
}

/** Voices worth offering first in the UI; everything else is still downloadable. */
const FEATURED = [
    'en_US-ljspeech-medium',
    'en_US-kristin-medium',
    'en_US-lessac-medium',
    'en_US-ryan-high',
    'en_GB-cori-high',
    'en_GB-alan-medium',
]

async function getJson (url, tries = 3) {
    let last
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url)
            if (!res.ok) { throw new Error(`${res.status} ${res.statusText}`) }
            return await res.json()
        } catch (e) {
            last = e
            await new Promise(r => setTimeout(r, 500 * (i + 1)))
        }
    }
    throw last
}

async function probe (voice, cached) {
    const configPath = Object.keys(voice.files).find(p => p.endsWith('.onnx.json'))
    const modelPath = Object.keys(voice.files).find(p => p.endsWith('.onnx'))
    if (!configPath || !modelPath) {
        return null
    }
    if (cached[voice.key]) {
        return { ...cached[voice.key], modelPath }
    }
    const cfg = await getJson(`${BASE}/${configPath}`)
    const ids = Object.keys(cfg.phoneme_id_map ?? {})
    const multiChar = ids.filter(k => [...k].length > 1)
    const out = {
        compatible: multiChar.length === 0,
        reason: multiChar.length ? `multi-char phonemes: ${multiChar.slice(0, 3).join(' ')}` : '',
        sampleRate: cfg.audio?.sample_rate ?? 22050,
        phonemes: ids.length,
        speakers: voice.num_speakers ?? 1,
        modelPath,
    }
    cached[voice.key] = out
    return out
}

async function main () {
    const refresh = process.argv.includes('--refresh')
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    const cached = refresh || !fs.existsSync(CACHE) ? {} : JSON.parse(fs.readFileSync(CACHE, 'utf8'))

    const index = await getJson(INDEX_URL)
    const english = Object.values(index).filter(v => v.language?.family === 'en')
    console.log(`upstream voices: ${Object.keys(index).length}, english: ${english.length}`)

    const rows = []
    for (const voice of english) {
        const p = await probe(voice, cached)
        if (!p) { continue }
        if (!p.compatible) {
            console.log(`  skip ${voice.key}: ${p.reason}`)
            continue
        }
        const size = Object.entries(voice.files).filter(([f]) => f.endsWith('.onnx')).reduce((a, [, v]) => a + v.size_bytes, 0)
        const md5 = voice.files[p.modelPath]?.md5_digest
        rows.push({
            id: voice.key,
            label: voice.key.replace(/_/g, ' ').replace(/-/g, ' · '),
            path: p.modelPath,
            lang: voice.language.code,
            quality: voice.quality,
            sampleRate: p.sampleRate,
            sizeBytes: size,
            speakers: p.speakers,
            gender: GENDER[voice.key],
            featured: FEATURED.includes(voice.key),
            md5,
        })
        process.stdout.write('.')
    }
    fs.writeFileSync(CACHE, JSON.stringify(cached, null, 1))

    const rank = { high: 0, medium: 1, low: 2 }
    rows.sort((a, b) => (b.featured - a.featured) || a.lang.localeCompare(b.lang) || rank[a.quality] - rank[b.quality] || a.id.localeCompare(b.id))

    const out = `/* eslint-disable */
/**
 * Generated by scripts/gen-voices.mjs - do not edit by hand.
 * English Piper voices that load with piper 2023.11.14-2 (single-codepoint phoneme ids).
 */
import { PiperVoice } from './engines/piperVoice'

export const PIPER_VOICES: PiperVoice[] = ${JSON.stringify(rows, null, 4).replace(/\n/g, '\n')}
`
    fs.writeFileSync(path.join(ROOT, 'src', 'voiceCatalog.ts'), out)
    console.log(`\n\nwrote src/voiceCatalog.ts with ${rows.length} compatible English voices`)
}

main().catch(e => { console.error(e); process.exit(1) })
