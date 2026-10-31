import { describe, expect, it } from 'vitest'
import { FIELD_META, fieldHint, fieldLabel, fieldName } from './fieldLabels'

describe('字段中文名：key 不翻译，界面用中文名', () => {
  it('六个默认字段都有中文名和一句说明', () => {
    for (const key of [
      'subject_definitions',
      'summary',
      'retention_analysis',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music'
    ]) {
      expect(fieldName(key), key).not.toBe(key)
      expect(fieldHint({ key }), key).not.toBe('')
    }
  })

  it('label 是 key 的拷贝时（历史数据）用查表的中文名', () => {
    expect(fieldLabel({ key: 'summary', label: 'summary' })).toBe('段落概述')
  })

  it('用户自定义的 label 优先：字段配置里改过的名字不能被覆盖', () => {
    expect(fieldLabel({ key: 'summary', label: '本段剧情' })).toBe('本段剧情')
  })

  it('自定义字段不在表里：退回 key，不编名字', () => {
    expect(fieldLabel({ key: 'custom_visual_style', label: 'custom_visual_style' })).toBe(
      'custom_visual_style'
    )
    expect(fieldLabel({ key: 'custom_visual_style' })).toBe('custom_visual_style')
    expect(fieldHint({ key: 'custom_visual_style' })).toBe('')
  })

  it('表里的名字不含下划线（是给人读的）', () => {
    for (const [key, meta] of Object.entries(FIELD_META)) {
      expect(meta.name, key).not.toContain('_')
    }
  })
})
