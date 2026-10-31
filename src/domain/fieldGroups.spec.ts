import { describe, expect, it } from 'vitest'
import { DEFAULT_FIELD_SCHEMA } from './types'
import type { FieldSchema } from './types'
import { FIELD_GROUP_RULES, groupFields } from './fieldGroups'

/* ------------------------------------------------------------------ *
 * 交付字段分组
 *
 * 背景：交付页原来是一串平铺的字段卡，六个字段一路排下去，谁也说不清
 * 「哪几个是讲画面的、哪几个是讲声音的」。改成模块化之后，分组口径必须
 * 稳：认不出的字段只能落到「其他」，绝不能凭空消失。
 * ------------------------------------------------------------------ */

function field(key: string, order = 1): FieldSchema {
  return { key, label: key, order, source: 'manual', editable: true, required: false, lang: 'en' }
}

describe('交付字段分组', () => {
  it('默认 schema 分成四组，顺序稳定', () => {
    const groups = groupFields(DEFAULT_FIELD_SCHEMA)
    expect(groups.map((g) => g.id)).toEqual(['subject', 'narrative', 'visual', 'audio'])
    expect(groups.map((g) => g.fields.map((f) => f.key))).toEqual([
      ['subject_definitions'],
      ['summary', 'retention_analysis'],
      ['detailed_description'],
      ['overall_soundscape', 'non_diegetic_music']
    ])
  })

  it('自定义字段认得出来就归组，认不出来落到其他', () => {
    const groups = groupFields([
      field('subject_definitions'),
      field('camera_note'),
      field('sound_ambience'),
      field('whatever_flag')
    ])
    expect(groups.map((g) => g.id)).toEqual(['subject', 'visual', 'audio', 'other'])
    expect(groups.at(-1)!.fields.map((f) => f.key)).toEqual(['whatever_flag'])
  })

  it('空 schema 不给空卡', () => {
    expect(groupFields([])).toEqual([])
  })

  it('每个字段只出现一次，不丢不重', () => {
    const schema = DEFAULT_FIELD_SCHEMA.concat([field('summary_extra'), field('custom_thing')])
    const flat = groupFields(schema).flatMap((g) => g.fields.map((f) => f.key))
    expect(flat.sort()).toEqual(schema.map((f) => f.key).sort())
  })

  it('组内保持字段配置里的顺序', () => {
    const groups = groupFields([
      field('sound_b'),
      field('summary_a'),
      field('music_c')
    ])
    const audio = groups.find((g) => g.id === 'audio')!
    expect(audio.fields.map((f) => f.key)).toEqual(['sound_b', 'music_c'])
  })

  it('规则正则都能匹配到自己举的例子（防止手滑写坏）', () => {
    for (const rule of FIELD_GROUP_RULES) {
      expect(rule.test.test(`${rule.id}_x`)).toBe(true)
    }
  })
})
