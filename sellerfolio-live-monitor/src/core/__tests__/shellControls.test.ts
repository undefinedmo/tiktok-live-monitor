import { describe, it, expect } from 'vitest'
import {
  TEXT_STEPS, nearestStep, factorToPct, pctToFactor, stepText, canShrink, canGrow, isBigText,
  parseSavedZoom, controlKeyOf, badgeText,
} from '../shellControls'

describe('text size steps', () => {
  it('has the six approved steps', () => {
    expect([...TEXT_STEPS]).toEqual([85, 90, 100, 110, 120, 130])
  })
  it('snaps any percent to the nearest step, garbage to 100', () => {
    expect(nearestStep(100)).toBe(100)
    expect(nearestStep(114)).toBe(110)
    expect(nearestStep(116)).toBe(120)
    expect(nearestStep(50)).toBe(85)
    expect(nearestStep(400)).toBe(130)
    expect(nearestStep(NaN)).toBe(100)
    expect(nearestStep(0)).toBe(100)
    expect(nearestStep(-5)).toBe(100)
  })
  it('converts between factor and percent through the steps', () => {
    expect(factorToPct(1)).toBe(100)
    expect(factorToPct(1.1)).toBe(110)
    expect(factorToPct(0.85)).toBe(85)
    expect(factorToPct(1.23)).toBe(120)
    expect(pctToFactor(130)).toBe(1.3)
    expect(pctToFactor(97)).toBe(1)
  })
  it('steps one at a time and stops at the ends', () => {
    expect(stepText(100, 1)).toBe(110)
    expect(stepText(100, -1)).toBe(90)
    expect(stepText(90, -1)).toBe(85)
    expect(stepText(85, -1)).toBe(85)
    expect(stepText(130, 1)).toBe(130)
  })
  it('knows the ends and the big-text threshold', () => {
    expect(canShrink(85)).toBe(false)
    expect(canShrink(90)).toBe(true)
    expect(canGrow(130)).toBe(false)
    expect(canGrow(120)).toBe(true)
    expect(isBigText(110)).toBe(false)
    expect(isBigText(120)).toBe(true)
    expect(isBigText(130)).toBe(true)
  })
})

describe('parseSavedZoom', () => {
  it('reads a saved factor and snaps it to a step', () => {
    expect(parseSavedZoom('{"factor":1.2}')).toBe(1.2)
    expect(parseSavedZoom('{"factor":1.17}')).toBe(1.2)
    expect(parseSavedZoom('{"factor":0.85}')).toBe(0.85)
  })
  it('falls back to 1 on a missing or broken file', () => {
    expect(parseSavedZoom(null)).toBe(1)
    expect(parseSavedZoom('')).toBe(1)
    expect(parseSavedZoom('not json')).toBe(1)
    expect(parseSavedZoom('{}')).toBe(1)
    expect(parseSavedZoom('{"factor":"x"}')).toBe(1)
    expect(parseSavedZoom('{"factor":-1}')).toBe(1)
    expect(parseSavedZoom('null')).toBe(1)
  })
})

describe('controlKeyOf', () => {
  it('forwards a fresh F14 key-down', () => {
    expect(controlKeyOf({ type: 'keyDown', key: 'F14' })).toBe('F14')
    expect(controlKeyOf({ type: 'keyDown', key: 'Unidentified', code: 'F14' })).toBe('F14')
  })
  it('ignores key-up, auto-repeat, modifiers and other keys', () => {
    expect(controlKeyOf({ type: 'keyUp', key: 'F14' })).toBeNull()
    expect(controlKeyOf({ type: 'keyDown', key: 'F14', isAutoRepeat: true })).toBeNull()
    expect(controlKeyOf({ type: 'keyDown', key: 'F14', control: true })).toBeNull()
    expect(controlKeyOf({ type: 'keyDown', key: 'F14', alt: true })).toBeNull()
    expect(controlKeyOf({ type: 'keyDown', key: 'F13' })).toBeNull()
    expect(controlKeyOf({ type: 'keyDown', key: 'p' })).toBeNull()
  })
})

describe('badgeText', () => {
  it('hides at zero, counts, and caps at 99+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(-2)).toBe('')
    expect(badgeText(NaN)).toBe('')
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})
