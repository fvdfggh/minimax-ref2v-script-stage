<script setup lang="ts">
/**
 * 「待合成槽位」的配置弹窗 —— 素材带上那两颗「＋图片配置 / ＋音频配置」点开的
 * 就是它，保存后素材带里出现一格占位；点那格占位再打开同一个弹窗改配置。
 *
 * 为什么要先配置、再出现占位：
 *   占位不能是一格空气。它得记住"这一格要合成什么"（图片的提示词 / 语音的文本
 *   与音色），否则刷新一次就忘、也没法交给批量合成去跑。所以占位是**有内容的
 *   草稿**（asset.draft），不是画出来的空框。
 *
 * 两种槽位共用这一个弹窗，只有表单不同：
 *   图片 —— 提示词 + 落点（关键帧要锁在某一帧上；参考素材不锁帧）；
 *   音频 —— 要念的文本 + 音色（取主体已固定的音色包）。
 *
 * 这里只负责**收配置**，不做出图 / 配音：保存后由卡片决定要不要顺手合成
 * （"保存并出图 / 保存并配音"），出图那条路仍然只有一条（ImageGenModal）。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useImageStore } from '@/stores/images'
import { useRegistryStore } from '@/stores/registry'
import type { Asset, AssetActAs, Beat, Entity, ID, KeyframePlacement } from '@/domain/types'
import InfoTip from '@/components/common/InfoTip.vue'

export interface SlotConfig {
  /** 图片槽：图片合成提示词 */
  prompt?: string
  /** 音频槽：要念的文本 */
  voiceText?: string
  /** 音频槽：用谁的音色（主体 id） */
  voiceSpeakerId?: ID
  /** 关键帧图片槽：锁在段首 / 段尾 / 指定帧 */
  placement?: KeyframePlacement
  frameIdx?: number
  /** 图片槽：照着哪几张图（主体图 / 场景图 / 总图）来画 */
  refAssetIds?: ID[]
  /** 图片槽：写 prompt 时用户给的那句口语要求（下次还能改一改再生成） */
  promptBrief?: string
}

const props = defineProps<{
  show: boolean
  beat: Beat
  /** 槽位落在哪一块：关键帧（占时间轴）还是参考素材（只借给模型） */
  actAs: AssetActAs
  media: 'image' | 'audio'
  /** 编辑已有槽位时传它；新建传 null */
  slot: Asset | null
  entityById: Map<ID, Entity>
  /** 本段帧数：指定帧的输入上限 */
  frames: number
}>()

const emit = defineEmits<{
  'update:show': [boolean]
  /** andRun = 用户点的是「保存并合成」 */
  submit: [cfg: SlotConfig, andRun: boolean]
}>()

const images = useImageStore()
const registry = useRegistryStore()
const message = useMessage()

const isAudio = computed(() => props.media === 'audio')
const isRef = computed(() => props.actAs === 'reference')

/** 段内最后一帧（帧位合法区间 0..lastFrame） */
const lastFrame = computed(() => Math.max(0, Math.round(props.frames) - 1))

const prompt = ref('')
/** 一句口语要求：AI 写提示词的输入，也存下来当下次重写的起点 */
const brief = ref('')
/** 勾上的参考图（素材 id） */
const picked = ref<Set<ID>>(new Set())
/** AI 正在写提示词 */
const writing = ref(false)
const voiceText = ref('')
const speakerId = ref<ID | null>(null)
/**
 * 落点（内部仍用 placement 表达，写库口径不变）：
 * 段首 = F0、段尾 = 最后一帧、中间 = 指定帧。
 * 界面上只有**一个帧号下拉** —— 让人先选"段首 / 段中 / 段尾"再选帧号是多余的一步，
 * 而且"段中"根本不是用户想的那一帧。
 */
const placement = ref<KeyframePlacement>('head')
const frameIdx = ref(0)
/** 表单错在哪 —— 就地写一行，不弹 toast（弹窗还开着，提示得留在原地） */
const err = ref('')

/** 能当音色的主体：已经固定了音色包的角色 */
const voices = computed(() =>
  [...props.entityById.values()]
    .filter((e) => !!e.voicePack)
    .map((e) => ({ label: `${e.name} · ${e.voicePack!.id}`, value: e.id }))
)

/**
 * 段内帧位：和卡片关键帧格子上那颗下拉**同一套选项**（F0 … F最后一帧）。
 *
 * 不用裸数字输入 —— 用户要在"这一段到底有多少帧、哪一帧合适"里挑，
 * 一个 F 编号列表比让他敲数字直观，也不会敲出越界值。
 * 前端头两个选项直接标成「段首」「段尾」：它们既是最常用的两帧，
 * 也确实是打包时的锚点（startImage / endImage），只是不必再单独选一次。
 */
const frameOptions = computed(() =>
  Array.from({ length: lastFrame.value + 1 }, (_, i) => ({
    label:
      i === 0 ? 'F0 · 段首' : i === lastFrame.value ? `F${i} · 段尾` : `F${i}`,
    value: i
  }))
)

/** 帧号 → 落点：两端是锚点，中间是指定帧。帧号是唯一入口，落点由它推。 */
function placementOfFrame(n: number): KeyframePlacement {
  if (n <= 0) return 'head'
  if (n >= lastFrame.value) return 'tail'
  return 'at'
}

/** 选帧：同时把内部落点跟着推一遍（写库仍走 placement + frameIdx） */
function onFrame(n: number): void {
  const v = Math.min(Math.max(0, Math.round(Number(n) || 0)), lastFrame.value)
  frameIdx.value = v
  placement.value = placementOfFrame(v)
}

/**
 * 这一段能拿哪些图当参考：场景总图 → 出场主体 → 场景空镜
 * （顺序与出图弹窗 / 素材提示词编辑器同一份，见 images.refCandidatesFor）。
 *
 * 有 Picture 编号的才是"进参考槽"的；没有编号的只会以名字 + 外观出现在
 * 提示词里，所以按钮上标出 P 号，让人知道勾它到底发生了什么。
 */
const candidates = computed(() =>
  images.refCandidatesFor(props.beat.id).map((c) => ({
    id: c.key,
    label: c.label,
    kind: c.kind,
    url: c.url,
    pictureN: registry.assets.find((a) => a.id === c.key)?.pictureN ?? 0
  }))
)

/** 勾选态：主图就是"照着这几张画"，多选；顺序沿用候选顺序 */
function toggleRef(id: ID): void {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

/** 一键 AI 写提示词：把一句人话 + 勾选的参考图交给文本模型 */
async function aiWrite(): Promise<void> {
  if (writing.value) return
  if (!brief.value.trim()) {
    err.value = '先写一句要求，AI 才知道要画什么（例如「雨夜街头，他回头看」）'
    return
  }
  writing.value = true
  err.value = ''
  try {
    prompt.value = await images.suggestAssetPrompt({
      beatId: props.beat.id,
      brief: brief.value,
      refAssetIds: [...picked.value],
      asReference: isRef.value
    })
    message.success('提示词已生成，可以再手改')
  } catch (e) {
    const raw = e instanceof Error ? e.message : ''
    // 浏览器只说 "Failed to fetch"：翻成人话，并指向该去哪儿看
    err.value = /fetch|network|ECONNREFUSED|timeout/i.test(raw)
      ? '连不上文本模型：先确认「模型设置」里的服务在跑（本地 llama 起没起），再点一次'
      : raw || '生成提示词失败'
  } finally {
    writing.value = false
  }
}

const title = computed(() => {
  const where = isRef.value ? '参考素材' : '关键帧'
  return isAudio.value ? `${where} · 语音合成配置` : `${where} · 图片合成配置`
})

/**
 * 打开时灌初值。
 *
 * 图片槽的提示词不是空白：拿这一段当前的模板提示词（场景 / 主体外观 / 画面描述）
 * 起头，用户改几个词就行 —— 让人从零写一句英文提示词是不现实的。
 * 音频槽默认直接用这句台词，改字比重新打字快。
 */
function hydrate(): void {
  err.value = ''
  const slot = props.slot
  if (isAudio.value) {
    voiceText.value = slot?.voiceText ?? (props.beat.dialogue ?? '')
    speakerId.value = slot?.voiceSpeakerId ?? props.beat.speakerId ?? null
    frameIdx.value = Math.max(0, Math.min(lastFrame.value, Math.round(Number(slot?.frameIdx) || 0)))
    return
  }
  // 老槽位存的是 placement（段首 / 段尾 / 指定帧）：换算成具体帧号灌进那颗下拉
  const start =
    slot?.placement === 'tail'
      ? lastFrame.value
      : slot?.placement === 'head'
        ? 0
        : Math.max(0, Math.min(lastFrame.value, Math.round(Number(slot?.frameIdx) || 0)))
  frameIdx.value = start
  placement.value = placementOfFrame(start)
  // 老草稿的 prompt 可能是空串：空串也当没有，退回模板提示词，别让人对着空框发呆
  prompt.value = slot?.prompt || images.keyframePrompt(props.beat.id, placement.value)
  brief.value = slot?.promptBrief ?? ''
  /*
   * 参考图默认勾**出场主体的图**（这多半就是"这一镜要画谁"），场景总图不勾：
   * 总图是"按它编辑"的底图，勾进参考槽容易和人物图串脸。
   * 编辑已有槽位时以它自己存的那批为准，别把用户挑过的改掉。
   */
  picked.value = new Set(
    slot?.refAssetIds ?? candidates.value.filter((c) => c.kind === 'subject').map((c) => c.id)
  )
}

watch(
  () => props.show,
  (v) => {
    if (v) hydrate()
  }
)

function close(): void {
  emit('update:show', false)
}

function submit(andRun: boolean): void {
  if (isAudio.value) {
    const text = voiceText.value.trim()
    if (!text) {
      err.value = '先写下这一句要念什么'
      return
    }
    const sp = speakerId.value ? props.entityById.get(speakerId.value) : undefined
    if (!sp?.voicePack) {
      err.value = '选一个已经固定音色的说话人（没固定的去「主体登记」里先设计一条）'
      return
    }
    emit(
      'submit',
      { voiceText: text, voiceSpeakerId: sp.id, frameIdx: frameIdx.value },
      andRun
    )
    return
  }

  const p = prompt.value.trim()
  if (!p) {
    err.value = '先写一句要画什么（提示词不能为空）'
    return
  }
  emit(
    'submit',
    {
      prompt: p,
      promptBrief: brief.value.trim(),
      refAssetIds: [...picked.value],
      // 参考图不写 placement（它不锁帧），但帧位照样存 —— 那是"从第几帧起参考"
      ...(isRef.value ? {} : { placement: placement.value }),
      frameIdx: Math.min(Math.max(0, frameIdx.value), lastFrame.value)
    },
    andRun
  )
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    size="small"
    style="width: 520px"
    :mask-closable="false"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="scd">
      <div class="scd-tip">
        {{ isAudio ? '先记下要念什么、用谁的音色' : '先记下要画什么' }}
        <InfoTip
          size="sm"
          :width="320"
          :text="`保存后素材带里出现一格虚线占位；点占位随时回来改，点「保存并${isAudio ? '配音' : '出图'}」直接开始合成。`"
        />
      </div>

      <!-- 图片：提示词 + 落点 -->
      <template v-if="!isAudio">
        <label class="scd-lb">图片合成提示词</label>
        <n-input
          v-model:value="prompt"
          type="textarea"
          :autosize="{ minRows: 5, maxRows: 10 }"
          placeholder="写清这一帧画什么：机位、景别、光、人物动作与表情…"
        />

        <!-- 一句人话 → AI 写成画面语言：「主体 / 场景 / 机位」它会从这一段和勾选图里读 -->
        <div class="scd-ai">
          <n-input
            v-model:value="brief"
            size="small"
            placeholder="一句要求，例如：雨夜街头，他回头看，霓虹在湿地上反光"
            @keydown.enter.prevent="aiWrite"
          />
          <n-button size="small" type="primary" ghost :loading="writing" @click="aiWrite">
            AI 写提示词
          </n-button>
          <button
            type="button"
            class="scd-link"
            title="把系统模板（场景 / 主体外观 / 画面描述）填进上面的框"
            @click="prompt = images.keyframePrompt(beat.id, placement) || prompt"
          >
            插模板
          </button>
        </div>

        <!-- 参考图：多选主体图 / 场景图，勾上的会进参考槽，提示词末尾自动点名 <Picture N> -->
        <template v-if="candidates.length">
          <label class="scd-lb is-gap">参考图 · 可多选</label>
          <div class="scd-refs">
            <button
              v-for="c in candidates"
              :key="c.id"
              type="button"
              class="scd-ref"
              :class="{ on: picked.has(c.id), bare: c.pictureN <= 0 }"
              :title="
                c.pictureN > 0
                  ? `照着 P${c.pictureN}「${c.label}」画：这张会进参考槽，提示词里点名它`
                  : `「${c.label}」没有 Picture 编号，只会以名字 + 外观写进提示词`
              "
              @click="toggleRef(c.id)"
            >
              <img v-if="c.url" :src="c.url" alt="" />
              <span v-else class="scd-ref-ph">{{ c.label.slice(0, 1) }}</span>
              <span class="scd-ref-nm">{{ c.label }}</span>
              <b v-if="c.pictureN > 0" class="scd-ref-pn">P{{ c.pictureN }}</b>
            </button>
          </div>
          <div class="scd-sub">
            {{ picked.size ? `已选 ${picked.size} 张` : '一张都没选 = 纯文字生图' }}
            <InfoTip size="sm" :width="280" text="勾上的图会跟着这一格一起存，出图时按 P 号点名。" />
          </div>
        </template>

        <!--
          帧位：一个下拉选到底 —— F0 是段首、F最后一帧是段尾，中间任意一帧都能选。
          不再先选"段首 / 段中 / 段尾"再选帧号：那一步选出来的是"哪一种锚点"，
          而用户要回答的是"这一格锁在哪一帧"，两件事本来是一件事。
        -->
        <template v-if="!isRef">
          <label class="scd-lb is-gap">锁在哪一帧</label>
          <div class="scd-row">
            <n-select
              :value="frameIdx"
              :options="frameOptions"
              size="small"
              style="width: 132px"
              :consistent-menu-width="false"
              data-scd-frame
              @update:value="onFrame"
            />
            <span class="scd-unit">
              本段共 {{ frames }} 帧 · 任意一帧都能锁（F0 = 段首、F{{ lastFrame }} = 段尾）
            </span>
          </div>
        </template>
        <template v-else>
          <label class="scd-lb is-gap">从哪一帧起参考</label>
          <div class="scd-row">
            <span class="scd-unit">第</span>
            <n-select
              v-model:value="frameIdx"
              :options="frameOptions"
              size="small"
              style="width: 96px"
              :consistent-menu-width="false"
              data-scd-frame
            />
            <span class="scd-unit">帧起（本段共 {{ frames }} 帧）· 不锁帧，只占 Picture 槽</span>
          </div>
        </template>
      </template>

      <!-- 音频：文本 + 音色 -->
      <template v-else>
        <label class="scd-lb">要念的文本</label>
        <n-input
          v-model:value="voiceText"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          placeholder="这句配音要念的内容…"
        />
        <div class="scd-row is-gap">
          <label class="scd-lb is-inline">音色</label>
          <n-select
            v-model:value="speakerId"
            :options="voices"
            placeholder="选一个已固定音色的说话人"
            style="flex: 1"
            :consistent-menu-width="false"
          />
        </div>
        <div v-if="!voices.length" class="scd-err">
          还没有固定音色的主体
          <InfoTip size="sm" :width="300" text="先去「主体登记」里按描述设计一条并固定，回来才能合成。" />
        </div>
        <div v-else class="scd-sub">
          音色取主体上已固定的那一条
          <InfoTip size="sm" :width="280" text="主体重新设计音色后，这里跟着变。" />
        </div>

        <div class="scd-row is-gap">
          <label class="scd-lb is-inline">从第</label>
          <n-select
            v-model:value="frameIdx"
            :options="frameOptions"
            size="small"
            style="width: 96px"
            :consistent-menu-width="false"
            data-scd-frame
          />
          <span class="scd-unit">
            帧起生效（本段共 {{ frames }} 帧）{{ isRef ? ' · 只进参考通道，不占时间轴' : '' }}
          </span>
        </div>
      </template>

      <div v-if="isAudio && slot?.auto" class="scd-sub">
        台词段自带
        <InfoTip size="sm" :width="280" text="文本跟着台词走；改了文字之后就不再跟随。" />
      </div>
      <div v-if="err" class="scd-err">{{ err }}</div>
      <div v-if="slot" class="scd-sub is-edit">这一格已经有配置，保存会覆盖它。</div>
    </div>

    <template #footer>
      <div class="scd-foot">
        <n-button size="small" quaternary @click="close">取消</n-button>
        <div class="scd-foot-r">
          <n-button size="small" @click="submit(false)">保存</n-button>
          <n-button size="small" type="primary" :disabled="isAudio && !voices.length" @click="submit(true)">
            {{ isAudio ? '保存并配音' : '保存并出图' }}
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.scd {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.scd-tip {
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 11.5px;
  line-height: 17px;
}
.scd-tip b {
  color: var(--text-2);
  font-weight: 600;
}
.scd-lb {
  margin-top: 3px;
  color: var(--muted-2);
  font-size: 11px;
  line-height: 15px;
}
.scd-lb.is-gap {
  margin-top: 9px;
}
.scd-lb.is-inline {
  margin-top: 0;
  flex: none;
  line-height: 28px;
}
.scd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.scd-row.is-gap {
  margin-top: 8px;
}
.scd-unit {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 16px;
}
.scd-ai {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.scd-ai :deep(.n-input) {
  flex: 1;
  min-width: 0;
}
.scd-link {
  flex: none;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
}
.scd-link:hover {
  text-decoration: underline;
}
.scd-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.scd-ref {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 66px;
  padding: 3px 3px 4px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--muted-2);
  cursor: pointer;
}
.scd-ref img {
  width: 58px;
  height: 34px;
  object-fit: cover;
  border-radius: 4px;
  display: block;
}
.scd-ref-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 34px;
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--muted-3);
  font-size: 13px;
}
.scd-ref-nm {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 12px;
}
.scd-ref-pn {
  position: absolute;
  top: 2px;
  left: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  font-weight: 600;
  line-height: 12px;
}
.scd-ref.on {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}
.scd-ref.bare {
  border-style: dotted;
}
.scd-sub {
  color: var(--muted-3);
  font-size: 11px;
  line-height: 15px;
}
.scd-sub.is-edit {
  color: var(--muted-2);
}
.scd-err {
  color: var(--danger, #d03050);
  font-size: 11.5px;
  line-height: 16px;
}
.scd-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.scd-foot-r {
  display: flex;
  gap: 8px;
}
</style>
