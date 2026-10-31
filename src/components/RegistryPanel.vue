<script setup lang="ts">
/**
 * 素材与音色（弹窗）。
 *
 * 主体本身不在这里维护 —— 统一在「主体登记」tab（SubjectManager）里做，
 * 那边有描述 / 参考图 / 声音描述 / 取用与推送。这里只留两件在阶段里
 * 顺手要看的东西：
 *   音色表 —— 所有会说话角色的 voiceDesc 并排看，检查跨段是否一致
 *   素材   —— <Picture N> 图片池，处理没被主体引用的孤儿图、压缩编号
 */
import { computed, ref } from 'vue'
import { NButton, NInput, NTabPane, NTabs, NTag } from 'naive-ui'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { normalizeVoiceDesc } from '@/domain/registry'
import type { Asset } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

const registry = useRegistryStore()
const project = useProjectStore()

const fileInput = ref<HTMLInputElement | null>(null)
const projectId = computed(() => project.currentId ?? '')

/** 只列主体参考图：关键帧 / 音视频属于某个片段（在细节填充里），场景图 pictureN=0 不进 reference 槽 */
const pictureAssets = computed(() =>
  registry.assets.filter(
    (a) => a.kind !== 'keyframe' && a.kind !== 'material' && a.kind !== 'scene' && a.pictureN > 0
  )
)

/** 素材的归属主体（按 pictureN 反查），空 = 孤儿素材 */
function ownerOf(a: Asset) {
  return registry.entities.find((e) => e.pictureN === a.pictureN) ?? null
}

const orphans = computed(() => pictureAssets.value.filter((a) => !ownerOf(a)).length)

const voiceRows = computed(() =>
  registry.sortedEntities.filter((e) => e.kind === 'speaking' && e.type !== 'scene')
)

async function addImages(ev: Event) {
  const input = ev.target as HTMLInputElement
  const files = input.files
  if (!files) return
  for (const f of Array.from(files)) await registry.addAsset(projectId.value, f)
  input.value = ''
}
</script>

<template>
  <n-tabs type="line" animated>
    <n-tab-pane name="voices" tab="音色表">
      <div class="muted row" style="font-size: 12.5px; margin-bottom: 10px; gap: 0; align-items: center">
        跨段逐字复用
        <InfoTip
          :width="340"
          text="只在这里写一次；末尾的 (Sx) 由系统自动追加，不需要手写。&#10;要改主体的描述或参考图，请到「主体登记」tab。"
        />
      </div>
      <div v-for="e in voiceRows" :key="e.id" class="stack" style="gap: 4px; margin-bottom: 12px">
        <div class="row" style="gap: 6px">
          <n-tag size="small" :bordered="false" type="info">S{{ e.subjectN ?? '?' }}</n-tag>
          <span style="font-weight: 600">{{ e.name }}</span>
        </div>
        <n-input
          type="textarea"
          :rows="2"
          size="small"
          :value="e.voiceDesc ?? ''"
          placeholder="speaking with a young male voice, slightly hoarse, tired but determined, measured and urgent"
          @update:value="(v: string) => registry.updateEntity(e.id, { voiceDesc: normalizeVoiceDesc(v) })"
        />
      </div>
      <div v-if="!voiceRows.length" class="empty">还没有会说话的角色</div>
    </n-tab-pane>

    <n-tab-pane name="assets" tab="素材">
      <div class="row-between" style="margin-bottom: 10px; gap: 12px">
        <div class="muted row" style="font-size: 12.5px; gap: 0; align-items: center; flex-wrap: wrap">
          图片按 <span class="mono">shared_params/PictureN.png</span> 编号
          <span v-if="orphans" style="color: var(--warn)">· 有 {{ orphans }} 张没被任何主体引用，仍在占编号</span>
          <InfoTip
            :width="360"
            text="主体通过 Picture N 引用图片。&#10;每张素材的「说明」会作为只读上下文交给大模型帮它理解参考内容，但不会写进最终提示词。"
          />
        </div>
        <div class="row" style="gap: 6px; flex: none">
          <n-button size="small" @click="registry.compactAssets()">压缩编号</n-button>
          <n-button size="small" type="primary" ghost @click="fileInput?.click()">添加图片</n-button>
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="addImages"
      />
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px">
        <div v-for="a in pictureAssets" :key="a.id" class="panel" style="padding: 8px">
          <img
            v-if="registry.assetUrl(a)"
            :src="registry.assetUrl(a)!"
            style="width: 100%; height: 76px; object-fit: cover; border-radius: 6px"
          />
          <div v-else style="height: 76px; background: var(--panel-3); border-radius: 6px" />
          <div class="row-between" style="margin-top: 6px; gap: 4px">
            <span class="mono" style="font-size: 11.5px">P{{ a.pictureN }}</span>
            <span
              class="muted"
              style="font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
            >
              {{ ownerOf(a)?.name ?? '未引用' }}
            </span>
            <n-button size="tiny" quaternary type="error" @click="registry.removeAsset(a.id)">
              移除
            </n-button>
          </div>
          <n-input
            size="tiny"
            :value="a.label"
            placeholder="标签"
            @update:value="(v: string) => registry.updateAsset(a.id, { label: v })"
          />
          <n-input
            type="textarea"
            size="tiny"
            :rows="2"
            :value="a.desc ?? ''"
            placeholder="素材说明（供大模型读取，不进最终提示词）"
            @update:value="(v: string) => registry.updateAsset(a.id, { desc: v })"
          />
        </div>
      </div>
      <div v-if="!pictureAssets.length" class="empty">
        还没有参考图
        <InfoTip
          size="sm"
          :width="320"
          text="参考图挂在主体上，请在「主体登记」tab 里上传或生成；这里只处理未绑定的图片。"
        />
      </div>
    </n-tab-pane>
  </n-tabs>
</template>
