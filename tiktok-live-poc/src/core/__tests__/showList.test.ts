import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseShowList, showWindowMs, roomNameMap } from '../showList'

const RAW = readFileSync(join(__dirname, '../../../fixtures/show-list-sample.json'), 'utf8')

describe('parseShowList', () => {
  it('parses every session with name, ids, and times', () => {
    const shows = parseShowList(RAW)
    expect(shows).toHaveLength(7)
    const first = shows[0]!
    expect(first.sessionId).toBe('4389560838')
    expect(first.name).toBe('Alo Yoga and More - Final Sale')
    expect(first.startTime).toBe(1782167400)
    expect(first.durationSec).toBe(10800)
    expect(first.eventId).toBe('7654248187959443469')
    expect(first.roomIds).toEqual(['7654357221282777870'])
    expect(first.reservations).toBe(15)
  })

  it('keeps 19-digit room/event ids exact (no float rounding)', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4463472902')!.roomIds)
      .toEqual(['7649102219992369933'])
  })

  it('handles a multi-room session', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4353398534')!.roomIds)
      .toEqual(['7642488665180097311', '7642505372850195231'])
  })

  it('handles a session with no rooms', () => {
    const shows = parseShowList(RAW)
    expect(shows.find((s) => s.sessionId === '4523526918')!.roomIds).toEqual([])
  })

  it('returns [] on error code or malformed text', () => {
    expect(parseShowList('{"code":1,"message":"nope"}')).toEqual([])
    expect(parseShowList('not json')).toEqual([])
  })
})

describe('showWindowMs', () => {
  it('spans session start to session end in ms', () => {
    const shows = parseShowList(RAW)
    const w = showWindowMs(shows[0]!)
    expect(w.startMs).toBe(1782167400 * 1000)
    expect(w.endMs).toBe((1782167400 + 10800) * 1000)
  })
})

describe('roomNameMap', () => {
  it('keys every room id to its session name', () => {
    const m = roomNameMap(parseShowList(RAW))
    expect(m.get('7654357221282777870')!.name).toBe('Alo Yoga and More - Final Sale')
    expect(m.get('7642505372850195231')!.sessionId).toBe('4353398534')
    expect(m.size).toBe(7) // 6 single-room + 1 two-room − 1 no-room session = 7 rooms
  })
})
