import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClipKeeper } from '../../electron/identifyClips'
import { MAX_KEPT_AGE_MS, MAX_KEPT_CLIPS, keptStem } from '../identifyKept'
import type { WireClip } from '../identifySend'

// The real disk under Retry: a temp folder, no mocks. The rules (what is kept, named, read back, evicted) are
// tested in identifyKept.test.ts; this proves the file operations do what those rules assume.
let dir = ''
let keeperDir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'identify-clips-'))
  keeperDir = join(dir, 'identify-clips') // does not exist yet: the keeper makes it
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = 1_800_000_000_000
const sec = NOW / 1000
const job = (orderId: string) => ({ orderId, roomId: 'r1', saleEpochSec: sec - 100, auctionStartEpochSec: sec - 130, prevBoundaryEpochSec: sec - 160 })
const clip = (n = 64, fill = 9): WireClip => ({ bytes: new Uint8Array(n).fill(fill) as Uint8Array<ArrayBuffer>, startEpochSec: sec - 170, durationSec: 80, leadInSec: 2, truncated: false, gapSec: 0 })
const payload = (orderId: string, n = 64, fill = 9) => ({ job: job(orderId), clip: clip(n, fill) })
const keeper = (now = NOW) => createClipKeeper(keeperDir, { now: () => now })
const files = () => (existsSync(keeperDir) ? readdirSync(keeperDir).sort() : [])

describe('createClipKeeper', () => {
  it('keeps a clip, creating its folder, and gives back exactly the same job, clip fields and bytes', () => {
    const k = keeper()
    expect(k.keep(payload('111', 64, 9))).toBe(true)
    const back = k.load('111')!
    expect(back.job).toEqual(job('111'))
    expect({ ...back.clip, bytes: undefined }).toEqual({ ...clip(), bytes: undefined })
    expect(Array.from(back.clip.bytes)).toEqual(Array.from(clip(64, 9).bytes))
    expect(back.clip.bytes).toBeInstanceOf(Uint8Array)
  })

  it('is two files per clip, named from the order, and the meta is JSON a person can read', () => {
    keeper().keep(payload('111'))
    expect(files()).toEqual([`${keptStem('111')}.bin`, `${keptStem('111')}.json`])
    const meta = JSON.parse(readFileSync(join(keeperDir, `${keptStem('111')}.json`), 'utf8'))
    expect(meta).toMatchObject({ v: 1, orderId: '111', savedAtMs: NOW, byteLength: 64 })
    expect(JSON.stringify(meta)).not.toMatch(/token|bearer|authorization/i)
  })

  it('leaves no temp file behind', () => {
    keeper().keep(payload('111'))
    expect(files().filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a second keep for the same order replaces the first (a retry that failed again)', () => {
    const k = keeper()
    k.keep(payload('111', 10, 1))
    k.keep(payload('111', 20, 2))
    expect(files()).toHaveLength(2)
    expect(Array.from(k.load('111')!.clip.bytes)).toEqual(Array(20).fill(2))
  })

  it('load is null for an order never kept', () => {
    expect(keeper().load('nope')).toBeNull()
    keeper().keep(payload('111'))
    expect(keeper().load('112')).toBeNull()
  })

  it('what one keeper wrote another reads: it survives a restart', () => {
    keeper().keep(payload('111'))
    expect(keeper(NOW + 3_600_000).load('111')).not.toBeNull()
  })

  it('refuses what is not worth keeping, and writes nothing for it', () => {
    const k = keeper()
    expect(k.keep({ job: job('111'), clip: clip(0) })).toBe(false)
    expect(k.keep({ job: { ...job('111'), orderId: '' }, clip: clip() })).toBe(false)
    expect(k.keep(null as never)).toBe(false)
    expect(k.keep({ job: job('111') } as never)).toBe(false)
    expect(k.keep('x' as never)).toBe(false)
    expect(files()).toEqual([])
  })

  it('drop deletes both files, and dropping what is not there is fine', () => {
    const k = keeper()
    k.keep(payload('111'))
    k.keep(payload('222'))
    k.drop('111')
    expect(k.load('111')).toBeNull()
    expect(k.load('222')).not.toBeNull()
    expect(files()).toEqual([`${keptStem('222')}.bin`, `${keptStem('222')}.json`])
    expect(() => k.drop('111')).not.toThrow()
    expect(() => k.drop('never')).not.toThrow()
    expect(() => createClipKeeper(join(dir, 'absent'), { now: () => NOW }).drop('x')).not.toThrow()
  })

  it('list names the orders that can really be loaded', () => {
    const k = keeper()
    k.keep(payload('111'))
    k.keep(payload('222'))
    expect(k.list().sort()).toEqual(['111', '222'])
    expect(createClipKeeper(join(dir, 'absent'), { now: () => NOW }).list()).toEqual([])
  })

  it('list and load skip a clip whose files are damaged, missing a half, or do not match each other', () => {
    const k = keeper()
    k.keep(payload('aaa', 10))
    k.keep(payload('bbb', 10))
    k.keep(payload('ccc', 10))
    k.keep(payload('ddd', 10))
    writeFileSync(join(keeperDir, `${keptStem('aaa')}.json`), '{"v":1,"orderId":"aaa"') // torn
    rmSync(join(keeperDir, `${keptStem('bbb')}.bin`)) // audio missing
    writeFileSync(join(keeperDir, `${keptStem('ccc')}.bin`), new Uint8Array(11)) // audio of another length: not this meta's
    expect(k.list()).toEqual(['ddd'])
    for (const id of ['aaa', 'bbb', 'ccc']) expect(k.load(id), id).toBeNull()
    expect(k.load('ddd')).not.toBeNull()
  })

  it('a meta that names another order than its file is not trusted', () => {
    const k = keeper()
    k.keep(payload('111'))
    const real = readFileSync(join(keeperDir, `${keptStem('111')}.json`), 'utf8')
    writeFileSync(join(keeperDir, `${keptStem('222')}.json`), real)
    writeFileSync(join(keeperDir, `${keptStem('222')}.bin`), new Uint8Array(64))
    expect(k.load('222')).toBeNull()
    expect(k.list()).toEqual(['111'])
  })

  it('an order id that is a path cannot write or read outside the folder', () => {
    const k = keeper()
    expect(k.keep(payload('../../escape'))).toBe(true)
    expect(existsSync(join(dir, 'escape.bin'))).toBe(false)
    expect(readdirSync(dir)).toEqual(['identify-clips'])
    expect(files().every((f) => /^h[0-9a-z]+\.(bin|json)$/.test(f))).toBe(true)
    expect(k.load('../../escape')).not.toBeNull()
    expect(k.list()).toEqual(['../../escape'])
  })

  it('keeps no more than MAX_KEPT_CLIPS, dropping the oldest', () => {
    let t = NOW
    const k = createClipKeeper(keeperDir, { now: () => t })
    for (let i = 0; i < MAX_KEPT_CLIPS + 2; i++) {
      t = NOW + i * 1000
      k.keep(payload(`o${i}`, 8))
    }
    const ids = k.list()
    expect(ids).toHaveLength(MAX_KEPT_CLIPS)
    expect(ids).not.toContain('o0')
    expect(ids).not.toContain('o1')
    expect(ids).toContain('o2')
    expect(ids).toContain(`o${MAX_KEPT_CLIPS + 1}`)
    expect(files()).toHaveLength(MAX_KEPT_CLIPS * 2) // the evicted ones' audio is gone too, not just their meta
  })

  it('drops what is older than the age limit when anything is next kept', () => {
    const old = createClipKeeper(keeperDir, { now: () => NOW })
    old.keep(payload('stale'))
    const later = createClipKeeper(keeperDir, { now: () => NOW + MAX_KEPT_AGE_MS + 1 })
    later.keep(payload('fresh'))
    expect(later.list()).toEqual(['fresh'])
    expect(files()).toHaveLength(2)
  })

  it('clear removes every kept clip, and only those: it is "off means off" for audio at rest', () => {
    const k = keeper()
    k.keep(payload('111'))
    k.keep(payload('222'))
    writeFileSync(join(keeperDir, 'strange.txt'), 'not ours')
    mkdirSync(join(keeperDir, 'sub'))
    k.clear()
    expect(k.list()).toEqual([])
    expect(files()).toEqual(['strange.txt', 'sub'])
    expect(() => createClipKeeper(join(dir, 'absent'), { now: () => NOW }).clear()).not.toThrow()
  })

  it('a folder that cannot be written reports false rather than throwing', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'a file where a folder is needed')
    const k = createClipKeeper(join(blocker, 'clips'), { now: () => NOW })
    expect(k.keep(payload('111'))).toBe(false)
    expect(k.load('111')).toBeNull()
    expect(k.list()).toEqual([])
    expect(() => k.drop('111')).not.toThrow()
    expect(() => k.clear()).not.toThrow()
  })
})
