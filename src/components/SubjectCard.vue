<script setup lang="ts">
/**
 * 主体卡片 · 一屏看全所有主体
 *
 * 原来这一页是「左窄列表 + 右详情」：想看谁长什么样，得先在左栏点一下，
 * 右栏才出来 —— 一屏永远只有一个主体，判断「这套角色够不够」要来回点 N 次。
 *
 * 卡片只负责「看得出这是谁、齐不齐」：图、名字、类型、S/P 编号、用了几段、
 * 缺什么。深编辑（设定图组、音色包、下发/推送）还是点开抽屉做 ——
 * 那是要动手的地方，塞进卡片只会把卡片撑成一页。
 */
import { computed } from 'vue'
import { ENTITY_TYPE_LABEL } from '@/domain/registry'
import type { Entity } from '@/domain/types'

const props = withDefaults(
  defineProps<{
    entity: Entity
    /** 参考图 URL；没有就显首字占位 */
    img?: string | null
    /** 原文里提到几次（只在集层有意义） */
    mentions?: number
    /** 本集多少片段引用了它 */
    refs?: number
    scope?: 'project' | 'episode'
    /** 项目层：被多少集取用 */
    used?: number
  }>(),
  { img: null, mentions: 0, refs: 0, scope: 'episode', used: 0 }
)

const emit = defineEmits<{ open: [] }>()

const desc = computed(() => {
  const t = (props.entity.textDesc ?? '').replace(/\s+/g, ' ').trim()
  return t || ''
})

/** 角色缺音色 = 到 ② 配音时会卡住；场景缺图 = 出片没参考。两种都值得在卡上标出来 */
const gaps = computed(() => {
  const out: string[] = []
  if (!props.entity.pictureN) out.push('缺参考图')
  if (props.entity.kind === 'speaking' && !(props.entity.voiceDesc ?? '').trim()) out.push('缺声音描述')
  return out
})
</script>

<template>
  <article class="sbc" :title="desc || entity.name" @click="emit('open')">
    <div class="sbc-img">
      <img v-if="img" :src="img" alt="" loading="lazy" />
      <span v-else class="sbc-initial">{{ (entity.name || '?').slice(0, 1) }}</span>
      <span class="sbc-type">{{ ENTITY_TYPE_LABEL[entity.type] }}</span>
      <span v-if="entity.subjectN != null" class="sbc-n">S{{ entity.subjectN }}</span>
      <span v-if="entity.pictureN" class="sbc-p">P{{ entity.pictureN }}</span>
    </div>

    <div class="sbc-main">
      <div class="sbc-name">{{ entity.name || '未命名' }}<span v-if="entity.kind === 'speaking'" class="sbc-talk">说话</span></div>
      <div class="sbc-desc" :class="{ empty: !desc }">
        {{ desc || (entity.type === 'character' ? '还没写长相' : '还没写描述') }}
      </div>
      <div class="sbc-meta">
        <template v-if="scope === 'episode'">
          <span v-if="mentions" class="sbc-tag is-text">原文 ×{{ mentions }}</span>
          <span v-if="refs" class="sbc-tag">{{ refs }} 段在用</span>
          <span v-else class="sbc-tag is-dim">暂无片段引用</span>
        </template>
        <template v-else>
          <span v-if="used" class="sbc-tag">{{ used }} 集取用</span>
          <span v-else class="sbc-tag is-dim">还没有集取用</span>
        </template>
        <span v-for="g in gaps" :key="g" class="sbc-tag is-warn">{{ g }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.sbc {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-2);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.12s, transform 0.12s;
}
.sbc:hover {
  border-color: var(--accent-line);
  transform: translateY(-1px);
}

/* 图区固定比例：卡片高度整齐，一眼扫下来是一排排方块，不是参差的砖 */
.sbc-img {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--panel-3);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sbc-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sbc-initial {
  font-size: 30px;
  font-weight: 600;
  color: var(--muted-3);
}
.sbc-type,
.sbc-n,
.sbc-p {
  position: absolute;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10.5px;
  line-height: 15px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.sbc-type {
  left: 6px;
  top: 6px;
}
.sbc-n {
  right: 6px;
  top: 6px;
}
.sbc-p {
  right: 6px;
  bottom: 6px;
}

.sbc-main {
  padding: 8px 9px 9px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sbc-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sbc-talk {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 500;
  line-height: 15px;
}
.sbc-desc {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 34px;
}
.sbc-desc.empty {
  color: var(--muted-3);
}
.sbc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 1px;
}
.sbc-tag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--panel-3);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--muted);
}
.sbc-tag.is-text {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.sbc-tag.is-dim {
  color: var(--muted-3);
}
.sbc-tag.is-warn {
  background: var(--warn-soft, var(--panel-3));
  color: var(--warn-ink);
}
</style>
