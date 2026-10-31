<script setup lang="ts">
/**
 * 主体的「设定图组」面板。
 *
 * 一块画布里同时塞头像和三视图是画不好的：脸只占 1/3，模型会把预算摊给
 * 三个全身，脸必然糊。所以这里把它拆成三步，每一步都整张画布只画一样东西：
 *
 *   基模头（master）  正面头肩特写，头颈完整可见 —— 定"这张脸"
 *     └─ 编辑 ─▶ 组头（head）  同一张脸 + 一套造型 —— 定"这一次长什么样"
 *                   └─ 编辑 ─▶ 三视图（view）  正 / 侧 / 背 全身并排
 *
 * 组 = 1 张组头 + N 张三视图，可以有多组（不同造型 / 年龄段 / 季节）；
 * 基模头全片只有一张，是所有组的源头。
 * 用的时候不是"整组都上"，而是从任一组里挑**一张**写进 <Picture N>
 * ——挑组头是认脸，挑三视图是连身形和服装一起认。
 *
 * 版式按用户的要求排：左边组头（竖版），右边三视图（横向并排）。
 * 这和拼接槽位是同一套关系 —— 左边的图只画头，右边的图只画全身。
 * 但显示尺寸不跟着画布比例走：组头定宽 140、三视图限宽，一组约 240px 高，
 * 一组一个缩略图就够用；脸看不清点开大图看（原先按容器宽度铺满，
 * 一个组头能撑到 583px 高，一个人好几组造型时根本翻不过来）。
 */
import { computed, ref } from 'vue'
import { NButton, NInput, NPopconfirm, NTag, useMessage } from 'naive-ui'
import ImageGenModal from './ImageGenModal.vue'
import AssetPreview from './AssetPreview.vue'
import { useImageStore, type RefCandidate } from '@/stores/images'
import { useProjectStore } from '@/stores/project'
import { useRegistryStore } from '@/stores/registry'
import { uid, now } from '@/core/id'
import {
  addGroup,
  addView,
  costumeLeakInFace,
  designIssues,
  findGroup,
  HEAD_GEN_SIZE,
  nextGroupLabel,
  patchGroup,
  refProblemOf,
  removeGroup as removeGroupOf,
  SHEET_LABEL,
  SHEET_LAYOUT,
  sheetOf,
  VIEW_GEN_SIZE
} from '@/domain/refSheet'
import type { Asset, Entity, ID, SheetSlot } from '@/domain/types'
import InfoTip from './common/InfoTip.vue'

const props = defineProps<{ entity: Entity }>()

const registry = useRegistryStore()
const images = useImageStore()
const project = useProjectStore()
const message = useMessage()

/**
 * 头图尺寸 = 拼接槽位比例：448:768 就是 7:12，出图 736×1264。
 *
 * 不是随便挑的竖版 —— 拼的时候**一个像素都不许拉伸**，源图比例必须贴着
 * 槽位走。用 3:4 出图再 contain 进 448×768，上下会各留 96px 的空白带。
 */
const HEAD_SIZE = HEAD_GEN_SIZE
/** 三视图尺寸 = 928:768 = 29:24，出图 1056×880（16:9 会上下留 123px 空白） */
const VIEW_SIZE = VIEW_GEN_SIZE

/**
 * 永远从 store 里读最新的实体，而不是读 props。
 *
 * 连续两次写（比如"生成基模头 → 顺手设为参考图"）时，第二次拿到的 props
 * 还是上一帧的对象；用它去 spread 会把第一次写的 masterId 覆盖回去。
 * 读 store 则每次都是刚落库的那一份。
 */
const sheet = computed(() => {
  const live = registry.entityById.get(props.entity.id)
  return sheetOf(live ?? props.entity)
})

/** 覆盖同名参考图后浏览器会拿缓存：每次改完 bump 一下 */
const bust = ref(0)

/** 同样读 store：连续写之间 props 是旧的 */
const liveEntity = computed(() => registry.entityById.get(props.entity.id) ?? props.entity)

function urlOf(a: Asset | null | undefined, bustIt = false): string | null {
  if (!a) return null
  const base = registry.assetUrl(a)
  if (!base) return null
  return bustIt ? `${base}?v=${bust.value}` : base
}

const master = computed(() => registry.sheetAssetById(sheet.value.masterId))
const masterUrl = computed(() => urlOf(master.value, true))

const currentRef = computed(() => registry.subjectImageFor(props.entity.id))
const currentRefUrl = computed(() => urlOf(currentRef.value, true))

/**
 * 当前参考图够不够用。null = 是拼接图（头 + 身子都有）。
 *
 * 单独拎出来是因为这件事最容易漏：图"有"不等于"能用"，一张脸也能占住
 * <Picture N>，而下游每一段都拿它当唯一依据。
 */
const refProblem = computed(() => refProblemOf(liveEntity.value))

const activeId = computed(() => sheet.value.active?.assetId ?? null)

/**
 * 现在这张参考图是从哪来的 —— 换组后要能一眼看出来。
 *
 * compose 模式下 assetId 指向的是**拼接产物**，不是设定图里任何一张，
 * 所以必须靠 active.groupId + viewId 反过来说明"用的是造型几、哪张三视图"。
 */
const activeLabel = computed(() => {
  const a = sheet.value.active
  if (!a) return ''
  const g = findGroup(sheet.value, a.groupId)
  if (!g) return a.mode === 'compose' ? `拼接图` : '基模头'
  if (a.mode === 'compose') return `${g.label} · 拼接（组头 + 三视图）`
  return g.headId === a.assetId ? `${g.label} · 组头` : `${g.label} · 三视图`
})

const issues = computed(() => designIssues(liveEntity.value.textDesc))

/**
 * 长相里混了"穿什么"。
 *
 * 提示词那一步已经自动略过（`domain/refSheet.faceOnly`）—— 头部两步不会再
 * 照着画外套。但三视图 / 关键帧仍然吃这段文字，衣服的"真相"散在两个地方
 * 迟早会打架，所以这里还是要说一句，让人把穿着搬到「服装与身形」。
 *
 * 检查的是**真正进提示词的那一段**（英文优先），不是编辑器里显示的中文。
 */
const costumeInFace = computed(() => {
  const e = liveEntity.value
  if (e.type !== 'character') return []
  return costumeLeakInFace(((e.textDescEn ?? '') || (e.textDesc ?? '')).trim())
})

interface GroupView {
  id: ID
  label: string
  variant?: string
  head: Asset | null
  views: Asset[]
  /** 拼参考图时用哪张（null = 还没选，取第一张） */
  pickedViewId: ID | null
}

const groups = computed<GroupView[]>(() =>
  sheet.value.groups.map((g) => ({
    id: g.id,
    label: g.label,
    variant: g.variant,
    head: registry.sheetAssetById(g.headId),
    views: g.viewIds
      .map((id) => registry.sheetAssetById(id))
      .filter((a): a is Asset => !!a),
    pickedViewId: g.pickedViewId ?? null
  }))
)

/** 这一组拼图时实际会用哪张：点选的那张 → 第一张 → null */
function pickedOf(g: GroupView): Asset | null {
  if (g.pickedViewId) {
    const hit = g.views.find((v) => v.id === g.pickedViewId)
    if (hit) return hit
  }
  return g.views[0] ?? null
}

/** 点一下缩略图 = 指定"这一组拼图时用这张" */
function pickView(groupId: ID, assetId: ID) {
  void registry.setRefSheet(props.entity.id, patchGroup(sheet.value, groupId, { pickedViewId: assetId }))
}

/** 新建组时填的变体要求（只对"下一组"生效，建完就清掉） */
const variantDraft = ref('')
const masterInput = ref<HTMLInputElement | null>(null)

function refOf(a: Asset, label: string): RefCandidate {
  return {
    key: a.id,
    label,
    kind: 'subject',
    ref: { projectId: a.projectId, fileName: a.fileName },
    url: registry.assetUrl(a)
  }
}

/* ------------------------------ 出图 ------------------------------ */

interface GenState {
  slot: SheetSlot
  title: string
  prompt: string
  base: string | null
  refs: RefCandidate[]
  size: string
  groupId: ID | null
  /** 出图前记下的旧图 id：替换型操作用来收尸 */
  replacing: ID | null
}

const gen = ref<GenState | null>(null)
const busy = ref(false)

/**
 * 缩略图只有 140px 宽，脸看不清 —— 点一下弹大图，看完 Esc 回到原位置。
 *
 * 不为看清脸就把缩略图做大：一个人往往有好几组造型，图一大就一屏一组，
 * "比较多组"这件事反而做不成。看细节走弹窗，看全局走缩略图。
 */
const preview = ref<Asset | null>(null)

function openPreview(a: Asset | null | undefined) {
  if (a) preview.value = a
}

function genMaster(replace = false) {
  gen.value = {
    slot: 'master',
    title: replace ? '改基模头（图生图）' : '基模头',
    prompt: images.sheetPrompt(props.entity.id, 'master'),
    base: replace ? masterUrl.value : null,
    refs: [],
    size: HEAD_SIZE,
    groupId: null,
    replacing: replace ? (master.value?.id ?? null) : null
  }
}

function startHead(groupId: ID | null) {
  if (!master.value) {
    message.warning('先出基模头：所有组头都要由它编辑出来，否则每组会各长一张脸')
    return
  }
  const variant = groupId
    ? (findGroup(sheet.value, groupId)?.variant ?? '')
    : variantDraft.value.trim()
  gen.value = {
    slot: 'head',
    title: groupId ? '重出组头（保持同一张脸，只改造型）' : '新建一组：组头',
    prompt: images.sheetPrompt(props.entity.id, 'head', variant),
    base: masterUrl.value,
    refs: [refOf(master.value, '基模头')],
    size: HEAD_SIZE,
    groupId,
    replacing: groupId ? (findGroup(sheet.value, groupId)?.headId ?? null) : null
  }
}

function startViews(groupId: ID) {
  const g = groups.value.find((x) => x.id === groupId)
  if (!g?.head) {
    message.warning('这一组还没有组头：三视图要由组头编辑出来，否则脸和衣服会重画')
    return
  }
  gen.value = {
    slot: 'view',
    title: '三视图（正 / 侧 / 背）',
    prompt: images.sheetPrompt(props.entity.id, 'view'),
    base: urlOf(g.head),
    refs: [refOf(g.head, '组头')],
    size: VIEW_SIZE,
    groupId,
    replacing: null
  }
}

async function onDone(blob: Blob) {
  const g = gen.value
  gen.value = null
  const pid = project.currentId
  if (!g || !pid || busy.value) return
  busy.value = true
  try {
    const eid = props.entity.id
    let composed = false
    const label = g.slot === 'master' ? '基模头' : g.slot === 'head' ? '组头' : '三视图'
    const asset = await registry.addSheetImage(pid, eid, blob, label)
    const prev = g.replacing

    if (g.slot === 'master') {
      await registry.setRefSheet(eid, { ...sheet.value, masterId: asset.id })
    } else if (g.slot === 'head') {
      if (g.groupId) {
        await registry.setRefSheet(eid, patchGroup(sheet.value, g.groupId, { headId: asset.id }))
      } else {
        await registry.setRefSheet(
          eid,
          addGroup(sheet.value, {
            id: uid('grp'),
            label: nextGroupLabel(sheet.value),
            headId: asset.id,
            viewIds: [],
            variant: variantDraft.value.trim() || undefined,
            createdAt: now()
          })
        )
        variantDraft.value = ''
      }
    } else {
      await registry.setRefSheet(eid, addView(sheet.value, g.groupId!, asset.id))
      // 三视图一落地，这一组就凑齐了「头 + 身子」：自动拼成参考图。
      // 让用户再点一次「拼成参考图」是没必要的，而且十有八九会忘记点 ——
      // 结果就是参考图一直停在基模头那张脸上（这正是最初的病根）。
      composed = await autoCompose(g.groupId!, asset.id)
    }

    // 换掉的那张旧头已经不在组里了，别让它挂在素材目录里占地方
    if (prev && prev !== asset.id) await registry.removeAsset(prev)

    if (composed) {
      message.success(`已自动拼成参考图（组头 + 三视图，${SHEET_LABEL}）`)
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

/* ------------------------------ 选 / 删 ------------------------------ */

function groupIdOf(assetId: ID): ID | null {
  for (const g of sheet.value.groups) {
    if (g.headId === assetId) return g.id
    if (g.viewIds.includes(assetId)) return g.id
  }
  return null
}

async function useAsRef(asset: Asset) {
  const pid = project.currentId
  if (!pid) return
  busy.value = true
  try {
    await registry.useSheetImageAsReference(pid, props.entity.id, asset.id)
    await registry.setRefSheet(props.entity.id, {
      ...sheet.value,
      active: { groupId: groupIdOf(asset.id), assetId: asset.id, mode: 'single' }
    })
    bust.value++
    // 单张是"临时凑合"，不是合格参考图：明确说清缺什么，别让人以为已经好了
    message.warning(
      `已设为参考图${liveEntity.value.pictureN ? `（Picture ${liveEntity.value.pictureN}）` : ''}：` +
        `这只是单张，${assetsCaption(asset)}。正式用请走「拼成参考图」。`,
      { duration: 6000 }
    )
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

/** 单张图缺哪一半 —— 提示语里要说清楚，不然用户不知道"不完整"在哪 */
function assetsCaption(asset: Asset): string {
  const g = sheet.value.groups.find((x) => x.headId === asset.id || x.viewIds.includes(asset.id))
  if (sheet.value.masterId === asset.id) return '只有一张脸，没有身高体型和穿着'
  if (g && g.headId === asset.id) return '只有一张脸，没有身高体型和穿着'
  return '只有身形，脸太小、多半还是侧脸'
}

/**
 * 三视图落地后自动拼参考图。
 *
 * 只在"这一组已经有组头"时才拼 —— 没有组头就拼不出来，那就安静地等用户
 * 补完那一步（不弹错，因为这是正常的中途状态）。
 */
async function autoCompose(groupId: ID, viewId: ID): Promise<boolean> {
  const pid = project.currentId
  const g = findGroup(sheet.value, groupId)
  if (!pid || !g?.headId) return false
  try {
    await registry.composeGroupAsReference(pid, props.entity.id, groupId, viewId)
    bust.value++
    return true
  } catch (e) {
    // 拼接失败不该把"三视图已经存好"这件事一起回滚：图还在，用户能手动再拼
    message.warning(
      `三视图已保存，但自动拼接没成功：${e instanceof Error ? e.message : String(e)}`
    )
    return false
  }
}

/**
 * 一键补齐到「可用的参考图」：基模头 → 组头 → 三视图 → 拼接。
 *
 * 老项目里常见只做了第一步（出一张脸就当参考图了）。四个按钮挨个点一遍太绕，
 * 而缺哪一步是确定的：没有组就用基模头开一组（同一个人同一发型，不需重画），
 * 有组就直接出三视图。三视图落地时的自动拼接会把最后一步也接上。
 */
async function quickBuild() {
  const pid = project.currentId
  if (!pid || busy.value || !master.value) return
  const existing = groups.value[0]
  if (existing?.views.length) {
    await composeGroup(existing)
    return
  }
  let gid = existing?.id ?? null
  busy.value = true
  try {
    if (!gid) {
      gid = uid('grp')
      await registry.setRefSheet(props.entity.id, addGroup(sheet.value, {
        id: gid,
        label: nextGroupLabel(sheet.value),
        headId: master.value.id,
        viewIds: [],
        createdAt: now()
      }))
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
    return
  } finally {
    busy.value = false
  }
  startViews(gid)
}

/**
 * 把这一组拼成参考图：组头（左 1/3）+ 选定的一张三视图（右 2/3）→ 1376×768。
 *
 * 这是每集"选用造型"的正式入口。为什么不是"挑一张直接用"：
 * 单张全身 / 单张头都只定住一半 —— 模型拿到的参考图只有一张，
 * 那就把头和身形拼在一起交给它。拼接在服务端做，这里只负责等结果。
 */
async function composeGroup(g: GroupView) {
  const pid = project.currentId
  if (!pid || busy.value) return
  const view = pickedOf(g)
  if (!g.head) {
    message.warning('这一组还没有组头')
    return
  }
  if (!view) {
    message.warning('这一组还没有三视图：拼图需要一张三视图放在右边')
    return
  }
  busy.value = true
  try {
    await registry.composeGroupAsReference(pid, props.entity.id, g.id, view.id)
    bust.value++
    message.success(`已拼成参考图 ${SHEET_LABEL}${liveEntity.value.pictureN ? `（Picture ${liveEntity.value.pictureN}）` : ''}`)
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e), { duration: 8000 })
  } finally {
    busy.value = false
  }
}

async function dropImage(asset: Asset) {
  await registry.removeSheetImage(props.entity.id, asset.id)
  bust.value++
}

async function dropGroup(groupId: ID) {
  const g = findGroup(sheet.value, groupId)
  if (!g) return
  const ids = [...(g.headId ? [g.headId] : []), ...g.viewIds]
  await registry.setRefSheet(props.entity.id, removeGroupOf(sheet.value, groupId))
  for (const id of ids) await registry.removeAsset(id)
}

function renameGroup(groupId: ID, label: string) {
  const v = label.trim()
  if (!v) return
  void registry.setRefSheet(props.entity.id, patchGroup(sheet.value, groupId, { label: v }))
}

function pickMaster() {
  masterInput.value?.click()
}

async function onMasterPicked(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const pid = project.currentId
  if (!file || !pid) return
  const asset = await registry.addSheetImage(pid, props.entity.id, file, '基模头')
  const prev = sheet.value.masterId
  await registry.setRefSheet(props.entity.id, { ...sheet.value, masterId: asset.id })
  // 传一张头当基模头，只解决"脸从哪来"，不能顺手当参考图 —— 单张头参考不了
  // 身高、体型和穿着，正是这个自动行为让参考图一直停在脸上
  if (prev && prev !== asset.id) await registry.removeAsset(prev)
}
</script>

<template>
  <div class="sheet">
    <div class="sheet-h">
      <b>设定图组</b>
      <InfoTip
        :width="340"
        :text="`基模头 → 组头 → 三视图。用的时候选一组，拼成 ${SHEET_LABEL} 的参考图。`"
      />
    </div>

    <!-- 两条提示合并成一行：都只是"描述写法提醒"，分开各占一块会把下面的图全推下去 -->
    <div v-if="issues.length || costumeInFace.length" class="sheet-warn">
      <template v-if="issues.length">描述里像有非设定内容（{{ issues.join('、') }}）</template>
      <template v-if="issues.length && costumeInFace.length"> · </template>
      <template v-if="costumeInFace.length">长相里写了穿着（{{ costumeInFace.join('、') }}）</template>
      <InfoTip
        size="sm"
        :width="340"
        text="主体只写长相 / 服装 / 材质 / 气质；动作、表情、镜头属于具体某一拍，请写到那个片段的画面描述里。&#10;长相里的穿着会在基模头 / 组头生成时自动略过，三视图仍照它画全身 —— 不改也能出对图；想让不同组换造型，再挪到「服装与身形」。"
      />
    </div>

    <!-- 当前参考图：拼接产物是一张 16:9 的整图，缩略图按 1376×768 显示 -->
    <div class="cur">
      <div class="cur-thumb">
        <img
          v-if="currentRefUrl"
          class="zoomable"
          :src="currentRefUrl"
          alt=""
          title="点击看大图"
          @click="openPreview(currentRef)"
        />
        <div v-else class="ph">还没有参考图</div>
      </div>
      <div class="cur-body">
        <div class="cur-h">
          <n-tag v-if="liveEntity.pictureN" size="small" :bordered="false" type="info">
            &lt;Picture {{ liveEntity.pictureN }}&gt;
          </n-tag>
          <span v-else class="muted">纯文本（还没定参考图）</span>
          <n-tag v-if="sheet.active?.mode === 'compose'" size="small" :bordered="false" type="success">
            {{ SHEET_LABEL }}
          </n-tag>
          <span v-if="activeLabel" class="muted cur-from">来自 {{ activeLabel }}</span>
        </div>
        <!-- 参考图"有"不等于"能用"：一张脸也能占住 <Picture N>，下游却拿它当唯一依据。
             这条提示放到 .cur 外面（整行宽）：塞进右侧栏会被缩成四行，没人读。 -->
        <n-input
          v-if="currentRef"
          class="cur-desc"
          type="textarea"
          size="small"
          :rows="2"
          :value="currentRef.desc ?? ''"
          placeholder="图片说明（供大模型理解参考图，不进提示词）"
          @update:value="(v: string) => currentRef && registry.updateAsset(currentRef.id, { desc: v })"
        />
      </div>
    </div>

    <div v-if="refProblem" class="sheet-warn">
      {{ refProblem }}
      <InfoTip
        size="sm"
        :width="320"
        :text="`正式参考图必须是组头 + 三视图拼成的 ${SHEET_LABEL} 一张图 —— 左边认脸，右边定身高、体型和这一身衣服。`"
      />
    </div>

    <!-- 基模头 -->
    <div class="master">
      <div class="master-h">
        <b>基模头</b>
        <InfoTip
          size="sm"
          :width="300"
          text="全片一张 · 正面头肩特写 · 头颈完整可见。&#10;一张画布只画一张脸：写成「左边头像右边三视图」会让脸只占 1/3，必然糊。"
        />
      </div>
      <div class="master-body">
        <div class="shot" :class="{ on: activeId === master?.id }">
          <img v-if="masterUrl" :src="masterUrl" alt="" />
          <div v-else class="ph">还没有<br />基模头</div>
          <div v-if="master" class="ops">
            <button class="op" title="只有一张脸，定不住身高和穿着：正式参考图请在组里拼" @click="useAsRef(master)">
              单张用
            </button>
            <button class="op op-del" @click="dropImage(master)">删</button>
          </div>
        </div>
        <div class="master-ops">
          <n-button size="small" type="primary" ghost :disabled="busy" @click="genMaster(false)">
            生成基模头
          </n-button>
          <n-button size="small" :disabled="busy" @click="pickMaster">上传</n-button>
          <n-button v-if="master" size="small" quaternary :disabled="busy" @click="genMaster(true)">
            改这张（图生图）
          </n-button>
          <input
            ref="masterInput"
            type="file"
            accept="image/*"
            style="display: none"
            @change="onMasterPicked"
          />
        </div>
      </div>
    </div>

    <!-- 一键补齐：只出了基模头的老项目，一步到"能用的参考图" -->
    <div v-if="refProblem" class="quick">
      <n-button size="small" type="primary" :disabled="!master || busy" :loading="busy" @click="quickBuild">
        {{ groups.some((g) => g.views.length) ? '用现有造型拼成参考图' : '补齐参考图（出三视图后自动拼）' }}
      </n-button>
      <InfoTip
        size="sm"
        :width="300"
        :text="`缺什么补什么：没有组头就先用基模头顶上，三视图出来自动拼成 ${SHEET_LABEL}。`"
      />
    </div>

    <!-- 新建组 -->
    <div class="newgrp">
      <n-input
        v-model:value="variantDraft"
        size="small"
        placeholder="变体要求（可空）：换季军大衣 / 老了十岁 / 头发湿透"
      />
      <n-button size="small" type="primary" :disabled="!master || busy" @click="startHead(null)">
        + 新建一组
      </n-button>
    </div>

    <!-- 组列表：左 1/3 组头，右 2/3 三视图 -->
    <div v-for="g in groups" :key="g.id" class="grp">
      <div class="grp-h">
        <n-input
          size="small"
          :value="g.label"
          style="width: 104px"
          @update:value="(v: string) => renameGroup(g.id, v)"
        />
        <span class="muted" :title="`1 张组头 · ${g.views.length} 张三视图`">视图 {{ g.views.length }}</span>
        <span class="sp" />
        <n-button size="tiny" quaternary :disabled="busy" @click="startHead(g.id)">重出组头</n-button>
        <n-button size="tiny" quaternary :disabled="!g.head || busy" @click="startViews(g.id)">
          三视图
        </n-button>
        <n-button
          size="tiny"
          type="primary"
          :disabled="!g.head || !g.views.length || busy"
          :loading="busy"
          :title="`拼成 ${SHEET_LAYOUT.width}×${SHEET_LAYOUT.height} 的参考图`"
          @click="composeGroup(g)"
        >
          拼参考图
        </n-button>
        <n-popconfirm @positive-click="dropGroup(g.id)">
          <template #trigger>
            <n-button size="tiny" quaternary type="error">删组</n-button>
          </template>
          整组（组头 + 三视图）都会删掉，确定？
        </n-popconfirm>
      </div>

      <div class="grp-body">
        <!-- 左：组头（竖版，定宽 140） -->
        <div class="cell head" :class="{ on: activeId === g.head?.id }">
          <div class="shot tall">
            <img
              v-if="g.head"
              class="zoomable"
              :src="urlOf(g.head)!"
              alt=""
              title="点击看大图"
              @click="openPreview(g.head)"
            />
            <div v-else class="ph">还没有组头<br />（由基模头编辑）</div>
            <div v-if="g.head" class="ops">
              <button class="op" title="组头只有脸：拼参考图用它，别单独用" @click="useAsRef(g.head)">单张用</button>
              <button class="op op-del" @click="dropImage(g.head)">删</button>
            </div>
          </div>
          <div v-if="g.variant" class="variant" :title="g.variant">变体：{{ g.variant }}</div>
        </div>

        <!-- 右：三视图横排。点一张 = 指定拼图用哪张（拼图只需要一张） -->
        <div class="cell views">
          <div
            v-for="v in g.views"
            :key="v.id"
            class="shot view"
            :class="{ on: activeId === v.id, picked: pickedOf(g)?.id === v.id }"
            @click="pickView(g.id, v.id)"
          >
            <img :src="urlOf(v)!" alt="" />
            <div v-if="pickedOf(g)?.id === v.id" class="pick-badge">拼这张</div>
            <div class="ops">
              <button class="op op-see" title="看大图" @click.stop="openPreview(v)">看</button>
              <button class="op" title="只有身形：脸太小，认脸不稳" @click.stop="useAsRef(v)">单张用</button>
              <button class="op op-del" @click.stop="dropImage(v)">删</button>
            </div>
          </div>
          <div v-if="!g.views.length" class="shot view empty">
            <div class="ph">还没有三视图<br />（由组头编辑 · 正 / 侧 / 背 全身并排）</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!groups.length" class="empty-all">
      还没有任何一组造型
      <InfoTip size="sm" :width="300" text="先出基模头，再「新建一组」—— 每一组都是一套造型的完整设定。" />
    </div>

    <ImageGenModal
      v-if="gen"
      :show="true"
      :title="gen.title"
      :default-prompt="gen.prompt"
      :base-image-url="gen.base"
      :default-size="gen.size"
      :refs="gen.refs"
      @done="onDone"
      @update:show="(v: boolean) => { if (!v) gen = null }"
    />

    <!-- 缩略图 140px 宽只够认轮廓：细节 / 脸要靠这一层看 -->
    <AssetPreview
      :show="!!preview"
      :asset="preview"
      @update:show="(v: boolean) => { if (!v) preview = null }"
    />
  </div>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.sheet-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.sheet-h b {
  font-size: 13px;
}
.sheet-h .muted,
.muted {
  color: var(--muted);
  font-size: 12px;
}

.sheet-warn {
  border: 1px solid color-mix(in srgb, var(--warn, var(--warn)) 45%, transparent);
  background: color-mix(in srgb, var(--warn, var(--warn)) 10%, transparent);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11.5px;
  line-height: 1.5;
}

/* 当前参考图 */
.cur {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.cur-thumb {
  /* 拼接产物是 1376×768 的 16:9 整图，缩略图必须按同一个比例显示 ——
     按 3:4 裁，左边那张脸会被切掉一半，看起来像"拼歪了" */
  width: 132px;
  flex: none;
  /* 高度不能靠 img 的 100% 撑：父级高度 auto 时那是 0，图会整块消失 */
  aspect-ratio: 1376 / 768;
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel-2, var(--panel-3));
  border: 1px solid var(--line, var(--line-strong));
}
.cur-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cur-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cur-h {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 基模头 */
.master {
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
  padding: 9px;
  background: var(--panel-2, var(--panel-2));
}
.master-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.master-body {
  display: flex;
  gap: 10px;
}
/* 三个按钮横排：竖排在左侧那一列里会占满整张基模头的高度 */
.master-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: flex-start;
  align-content: flex-start;
  min-width: 0;
}
.tip {
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.5;
  max-width: 300px;
}

/* 一张图 = 一个格子，鼠标移上去才出操作 */
.shot {
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel-2, var(--panel-3));
  border: 1px solid var(--line, var(--line-strong));
  width: 104px;
  /* 头图是 448×768（7:12），不是 3:4 —— 按 3:4 裁的话，拼进左边槽位会
     上下各留一条空白，看着像"图没铺满" */
  aspect-ratio: 448 / 768;
  flex: none;
}
.shot.tall {
  width: 100%;
}
.shot.view {
  /* 高度定死、宽度按 928×768 自己推：跟着容器宽度长的话，一张就能撑到 365 高，
     一组吃掉半屏。认轮廓够用，看细节还是点开大图。 */
  flex: 0 0 auto;
  height: 216px;
  width: auto;
  aspect-ratio: 928 / 768;
  cursor: pointer;
}
.shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 缩略图只够认轮廓，点开看细节 */
img.zoomable {
  cursor: zoom-in;
}
.shot.on {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* 选中"拼这张"的角标：和 .on（当前参考图）不是一回事，用角标区分 */
.pick-badge {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #fff;
  background: var(--accent);
  pointer-events: none;
}
.shot.picked {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.shot .ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
  padding: 6px;
}
.ops {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
  opacity: 0;
  transition: opacity 0.15s;
}
.shot:hover .ops,
.shot:focus-within .ops {
  opacity: 1;
}
.op {
  flex: 1;
  border: none;
  border-radius: 4px;
  padding: 3px 0;
  font-size: 11px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.86);
  color: var(--text);
}
.op:hover {
  background: #fff;
}
.op-del {
  flex: none;
  width: 26px;
  color: var(--err-ink);
}

/* 新建组 */
/* 一键补齐：参考图不合格时才出现，所以给它一条左色条强调，不做成大卡片 */
.quick {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed var(--line-strong);
  border-left: 3px solid var(--warn);
  border-radius: var(--r-sm, 6px);
  background: var(--panel-2);
}

.newgrp {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 组 */
.grp {
  border: 1px solid var(--line, var(--line-strong));
  border-radius: 8px;
  padding: 9px;
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.sp {
  flex: 1;
}
/* 组图排布：左边一张组头（竖），右边三视图横排。
   以前按 448fr : 928fr 把整行铺满 —— 组头会被撑到 340×583，一组就吃掉
   大半屏，多组根本没法同时看。现在组头定宽 140（高 240）、三视图限宽 880
   （每张约 288×238），两者几乎等高，一组约 240px，一屏能看三四组。
   左右"窄竖 + 宽横"的关系没变，只是不再随容器宽度无限放大。 */
.grp-body {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.cell {
  min-width: 0;
}
.cell.head {
  flex: none;
  width: 118px;
}
.cell.views {
  flex: 1 1 0;
  min-width: 0;
  /* 宽屏下三视图跟着长就会比组头高出一截，一组组高矮不一反而更乱 */
  max-width: 880px;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
}
.variant {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-all {
  color: var(--muted);
  font-size: 12px;
  border: 1px dashed var(--line, var(--line-strong));
  border-radius: 8px;
  padding: 14px;
  text-align: center;
}
</style>
