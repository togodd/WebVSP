import { afterEach, describe, expect, it } from 'vitest'
import { displayLabel, displayMessage, t, useLocale } from './index'

const original = useLocale.getState().locale
afterEach(() => useLocale.getState().setLocale(original))

describe('mirror translations', () => {
  it('translates real menu labels while preserving dialog ellipses', () => {
    useLocale.getState().setLocale('zh')
    expect(displayLabel('CompGeom...')).toBe('部件几何...')
    expect(displayLabel('Planar Slice...')).toBe('平面剖切...')
    expect(displayLabel('CFD Mesh...')).toBe('CFD 网格...')
  })
  it('translates fixed form labels and complete prompts', () => {
    useLocale.getState().setLocale('zh')
    expect(displayLabel('Total Planform')).toBe('整体平面形')
    expect(displayLabel('Half Mesh')).toBe('半模型网格')
    expect(displayMessage('Convert Fuselage to Stack Geom (can not be un-done)?')).toBe('将机身转换为堆叠几何体（无法撤销）？')
    expect(displayMessage('File export failed\nFile: Wing.vsp3')).toBe('文件导出失败\n文件：Wing.vsp3')
  })
  it('leaves unknown text and FLTK symbols intact, and English as original', () => {
    useLocale.getState().setLocale('zh')
    expect(displayLabel('Untranslated label')).toBe('Untranslated label')
    expect(displayLabel('@>')).toBe('▶')
    useLocale.getState().setLocale('en')
    expect(displayLabel('CompGeom...')).toBe('CompGeom...')
    expect(t('viewer.modelRow')).toBe('Model')
  })
})
