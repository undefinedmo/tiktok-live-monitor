import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite, loadIdentifySettings, nodeStoreIO, saveIdentifySettings } from '../../electron/identifyFiles'
import { createIdentifyStore, type IdentificationRow } from '../identifyStore'
import { DEFAULT_IDENTIFY_URL } from '../identifySettings'

// The real disk layer under the store and the settings: a temp directory, no mocks. The pure logic is
// tested elsewhere with an in-memory file; this is what proves the file operations behave the way the
// store assumes (atomic replace, a missing file is "no rows", a huge file cannot be slurped whole).
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'identify-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW_MS = 1_800_000_000_000
const row = (id: string, at = NOW_MS / 1000 - 10): IdentificationRow => ({
  orderId: id, roomId: 'r', atEpochSec: at, head: 'h', lot: 'l', price: '$1', status: 'done', text: 't',
})

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp file behind', () => {
    const f = join(dir, 'a.json')
    writeFileSync(f, 'old')
    atomicWrite(f, 'new')
    expect(readFileSync(f, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.json'])
  })
  it('a write that fails leaves the old file exactly as it was, and no temp file', () => {
    const f = join(dir, 'a.json')
    writeFileSync(f, 'old')
    mkdirSync(f + '.tmp') // the temp name is taken by a folder: the write cannot happen
    expect(() => atomicWrite(f, 'new')).toThrow()
    expect(readFileSync(f, 'utf8')).toBe('old') // a direct, in-place write would already have replaced it
    // and when the rename is what fails, the temp file is cleaned up rather than left behind
    rmSync(f + '.tmp', { recursive: true })
    const target = join(dir, 'isdir')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'x') // a non-empty folder cannot be replaced by a file
    expect(() => atomicWrite(target, 'new')).toThrow()
    expect(existsSync(target + '.tmp')).toBe(false)
  })
  it('creates the file, and its folder, when neither exists', () => {
    const f = join(dir, 'sub', 'a.json')
    atomicWrite(f, 'x')
    expect(readFileSync(f, 'utf8')).toBe('x')
  })
})

describe('nodeStoreIO under the store', () => {
  it('a missing file is no rows, and saving creates it', () => {
    const f = join(dir, 'identifications.jsonl')
    const s = createIdentifyStore(nodeStoreIO(f), { now: () => NOW_MS })
    expect(s.load()).toEqual([])
    expect(s.save(row('1'))).toBe(true)
    expect(createIdentifyStore(nodeStoreIO(f), { now: () => NOW_MS }).load().map((r) => r.orderId)).toEqual(['1'])
  })

  it('a file that is a DIRECTORY (unreadable as a file) yields no rows instead of throwing', () => {
    const f = join(dir, 'identifications.jsonl')
    mkdirSync(f)
    const s = createIdentifyStore(nodeStoreIO(f), { now: () => NOW_MS })
    expect(s.load()).toEqual([])
    expect(s.save(row('1'))).toBe(false)
  })

  it('repairs a file damaged mid-line through a real rename, keeping the good rows', () => {
    const f = join(dir, 'identifications.jsonl')
    const good = JSON.stringify({ v: 1, ...row('1') })
    writeFileSync(f, good + '\n{"v":1,"orderId":"2","atEp')
    const s = createIdentifyStore(nodeStoreIO(f), { now: () => NOW_MS })
    expect(s.load().map((r) => r.orderId)).toEqual(['1'])
    expect(readFileSync(f, 'utf8')).toBe(good + '\n')
    expect(readdirSync(dir)).toEqual(['identifications.jsonl'])
  })

  it('does not read a runaway file whole: only the tail is read, and the file is cut back to what parsed', () => {
    const f = join(dir, 'identifications.jsonl')
    const lineOf = (i: number) => JSON.stringify({ v: 1, ...row(String(i), NOW_MS / 1000 - 5000 + i) }) + '\n'
    // ~30 lines per KB; a 4 KB read limit keeps only the newest few.
    for (let i = 0; i < 400; i++) appendFileSync(f, lineOf(i))
    const s = createIdentifyStore(nodeStoreIO(f, 4096), { now: () => NOW_MS })
    const rows = s.load()
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(400)
    expect(rows[0]?.orderId).toBe('399') // the newest survives the cut
    expect(readFileSync(f, 'utf8').split('\n').filter(Boolean)).toHaveLength(rows.length)
  })

  it('read() says null for a missing file, and THROWS for one it cannot read (the store treats those differently)', () => {
    expect(nodeStoreIO(join(dir, 'nope.jsonl')).read()).toBeNull()
    const asDir = join(dir, 'isdir.jsonl')
    mkdirSync(asDir)
    expect(() => nodeStoreIO(asDir).read()).toThrow()
  })

  it('appends to the end without disturbing earlier lines', () => {
    const f = join(dir, 'identifications.jsonl')
    const io = nodeStoreIO(f)
    io.append('a\n')
    io.append('b\n')
    expect(readFileSync(f, 'utf8')).toBe('a\nb\n')
  })
})

describe('identify.json', () => {
  it('no file: defaults, on', () => {
    expect(loadIdentifySettings(join(dir, 'identify.json'))).toEqual({ baseUrl: DEFAULT_IDENTIFY_URL, enabled: true, damaged: false })
  })
  it('round trips what was saved', () => {
    const f = join(dir, 'identify.json')
    expect(saveIdentifySettings(f, { baseUrl: 'https://w.example.com', enabled: false })).toBe(true)
    expect(loadIdentifySettings(f)).toEqual({ baseUrl: 'https://w.example.com', enabled: false, damaged: false })
  })
  it('a truncated file reads as OFF, not as the default "on"', () => {
    const f = join(dir, 'identify.json')
    writeFileSync(f, '{"baseUrl":"http://100.68.11.76:8099","enab')
    expect(loadIdentifySettings(f)).toMatchObject({ enabled: false, damaged: true })
  })
  it('an unreadable file (a directory) reads as OFF too', () => {
    const f = join(dir, 'identify.json')
    mkdirSync(f)
    expect(loadIdentifySettings(f)).toMatchObject({ enabled: false, damaged: true })
  })
  it('saving into a place that cannot be written reports false rather than throwing', () => {
    const f = join(dir, 'blocker')
    writeFileSync(f, 'a file where a folder is needed')
    expect(saveIdentifySettings(join(f, 'identify.json'), { baseUrl: DEFAULT_IDENTIFY_URL, enabled: true })).toBe(false)
    expect(existsSync(join(dir, 'blocker', 'identify.json'))).toBe(false)
  })
})
