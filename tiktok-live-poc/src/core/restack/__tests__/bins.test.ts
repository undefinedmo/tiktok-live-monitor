import { describe, it, expect } from 'vitest'
import { binOf } from '../bins'

describe('binOf', () => {
  it('detects Bin A', () => expect(binOf('Random Premium Pull (Bin A)')).toBe('A'))
  it('detects Bin B case-insensitively', () => expect(binOf('leggings bin b')).toBe('B'))
  it('returns ? when no bin', () => expect(binOf('Handbag')).toBe('?'))
  it('returns ? for null/empty', () => {
    expect(binOf(null)).toBe('?')
    expect(binOf('')).toBe('?')
  })
})
