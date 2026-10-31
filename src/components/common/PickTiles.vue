<script setup lang="ts">
/**
 * 「缩略图 + 加号」选择器 —— 用来替代下拉框。
 *
 * 为什么不用 n-select：这两个字段（场景 / 主体）选的是**有长相的东西**，
 * 下拉框里只有一行名字，选完还得往下看参考图才知道是谁；反过来改绑也要
 * 先把名字和下面的缩略图对上看。改成图块之后，选中的东西自己就是一张图，
 * 名字压在图上，缺图的那块直接是黄虚线（一眼看出这段出图会缺参考）。
 *
 * 交互：
 *   加号  → 打开候选面板（超过 6 个自动带搜索框），多选可连续点，
 *           单选点一下即关；已选项前面有勾，再点一次取消。
 *   图块  → 看大图；悬停右侧两颗小钮：「换」/「×」。换有两种口径（见 swapTo）：
 *           picture = 换这个实体自己的参考图（跨段共用）；
 *           entity  = 打开候选面板**换个主体**（这一段换成谁，不动参考图）。
 *   缺图  → 块本身就是「补图」入口，点它直接选文件。
 *
 * 尺寸给得克制：卡片里这一格只有 ~200 宽，2 个各 96、3 个各 64 都能排一行，
 * 4 个以上两列（2×2），不会出现"一行 3 个、末尾 1 个拉宽"的错位感。
 * 单选（场景）不参与分摊：一张图定宽 92，剩下的横向空间留给多选的主体。
 */
import { computed, ref, watch } from 'vue'
import { NPopover } from 'naive-ui'
import type { ID } from '@/domain/types'

interface PickOption {
  id: ID
  name: string
  /** 名字后面的小字（S 编号 / 说话） */
  sub?: string
  /** 缩略图地址；空 = 这个实体还没有参考图 */
  img?: string | null
  /** 左上角编号（P3） */
  badge?: string
}

const props = defineProps<{
  /** 已选：数组顺序就是显示顺序 */
  selected: PickOption[]
  /** 全部候选 */
  options: PickOption[]
  /** 多选：选中后不关面板；单选：选中即关 */
  multiple?: boolean
  /** 一个都没选时，那颗虚线加号块上的字 */
  placeholder?: string
  /** 必填但没选：虚线块描黄边 */
  warn?: boolean
  /** 候选面板的表头 */
  title?: string
  /**
   * 图块上那颗「换」按钮做什么：
   *   picture（默认）= 换实体自己的参考图，会波及所有用到它的段；
   *   entity = 打开候选面板换个主体 —— 主体是"这一段用谁"，换人和换图是两件事。
   */
  swapTo?: 'picture' | 'entity'
  /**
   * 单选且已经选满了：把「＋」收走。
   * 一个位置只能放一个场景，选完还杵着一颗加号，点开也只会把原来那个顶掉，
   * 那不如让位给主体。换场景走图块上的「换」。
   */
  hideAdd?: boolean
}>()

const emit = defineEmits<{
  pick: [id: ID]
  unpick: [id: ID]
  /** 换这个实体的参考图（挂在实体上，用到它的段都会跟着变） */
  swap: [id: ID]
  /** 把 from 换成 to（只影响这一段） */
  replace: [from: ID, to: ID]
  /** 看大图 */
  preview: [id: ID]
}>()

const open = ref(false)
const q = ref('')
/**
 * 「换主体」时记下要换掉的是哪一个：面板进入替换态，
 * 点哪一项就把哪一个顶掉，而不是又加一个进去。
 */
const replaceFrom = ref<ID | null>(null)

const pickedIds = computed(() => new Set(props.selected.map((s) => s.id)))
const replaceName = computed(
  () => props.selected.find((s) => s.id === replaceFrom.value)?.name ?? ''
)

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return props.options
  return props.options.filter(
    (o) => o.name.toLowerCase().includes(k) || (o.sub ?? '').toLowerCase().includes(k)
  )
})

/* 每次打开都从"没搜"开始：上次的搜索词留着会让人以为候选变少了 */
watch(open, (v) => {
  if (v) q.value = ''
  else replaceFrom.value = null
})

function toggle(o: PickOption) {
  // 替换态：点谁都算"把原来那个换掉"，选完就关，不会变成多选
  if (replaceFrom.value) {
    const from = replaceFrom.value
    replaceFrom.value = null
    open.value = false
    if (o.id !== from) emit('replace', from, o.id)
    return
  }
  if (pickedIds.value.has(o.id)) {
    emit('unpick', o.id)
    return
  }
  emit('pick', o.id)
  if (!props.multiple) open.value = false
}

/** 图块上那颗「换」：换图还是换人，由 swapTo 决定 */
function requestSwap(s: PickOption) {
  if (props.swapTo === 'entity') {
    replaceFrom.value = s.id
    open.value = true
    return
  }
  emit('swap', s.id)
}

function onTile(s: PickOption) {
  if (s.img) emit('preview', s.id)
  else emit('swap', s.id)
}
</script>

<template>
  <div class="pt" :class="multiple ? 'is-multi' : 'is-single'">
    <span
      v-for="s in selected"
      :key="s.id"
      class="pt-tile"
      :class="{ 'is-noimg': !s.img }"
      role="button"
      tabindex="0"
      :title="
        s.img
          ? `${s.name}${s.sub ? ' · ' + s.sub : ''}${s.badge ? ' · ' + s.badge : ''} · 点开看大图`
          : `${s.name} 还没有参考图：点这里补一张（挂在主体上，跨段共用）`
      "
      @click="onTile(s)"
      @keydown.enter.prevent="onTile(s)"
    >
      <img v-if="s.img" :src="s.img" alt="" />
      <span v-else class="pt-noimg-lb">＋ 缺图</span>
      <!-- 编号只在有图时给：缺图块中间要留给「＋ 缺图」，两个挤在左上会叠字 -->
      <b v-if="s.badge && s.img" class="pt-badge">{{ s.badge }}</b>
      <b class="pt-name">{{ s.name }}</b>
      <span class="pt-ops">
        <button
          type="button"
          class="pt-op"
          :title="
            swapTo === 'entity'
              ? `把「${s.name}」换成另一个主体（只影响这一段）`
              : `换「${s.name}」的参考图（挂在主体上，用到它的段都会跟着换）`
          "
          @click.stop="requestSwap(s)"
        >
          换
        </button>
        <button type="button" class="pt-op" :title="`把「${s.name}」移出这一格`" @click.stop="emit('unpick', s.id)">
          ×
        </button>
      </span>
    </span>

    <n-popover v-model:show="open" trigger="click" placement="bottom-start" :show-arrow="false" raw>
      <template #trigger>
        <button
          type="button"
          class="pt-add"
          :class="{ 'is-warn': warn && !selected.length, 'is-hidden': hideAdd }"
          :title="placeholder || '添加'"
        >
          <span class="pt-plus">＋</span>
          <span v-if="!selected.length" class="pt-ph">{{ placeholder }}</span>
        </button>
      </template>

      <div class="pt-pop">
        <div class="pt-pop-h">
          <span class="pt-pop-t">
            {{ replaceFrom ? `换成…（替换「${replaceName}」）` : title || '选择' }}
          </span>
          <span v-if="replaceFrom" class="pt-pop-n">点一项替换</span>
          <span v-else class="pt-pop-n" :title="`已选 ${selected.length} 个，共 ${options.length} 个`">
            已选 {{ selected.length }} / {{ options.length }}
          </span>
        </div>
        <input
          v-if="options.length > 6"
          v-model="q"
          class="pt-q"
          placeholder="搜名字"
          spellcheck="false"
          @keydown.stop
        />
        <div class="pt-list">
          <button
            v-for="o in filtered"
            :key="o.id"
            type="button"
            class="pt-row"
            :class="{ 'is-on': pickedIds.has(o.id), 'is-cur': replaceFrom === o.id }"
            @click="toggle(o)"
          >
            <span class="pt-row-img">
              <img v-if="o.img" :src="o.img" alt="" />
              <i v-else>缺</i>
            </span>
            <span class="pt-row-name">
              {{ o.name }}<i v-if="o.sub">{{ o.sub }}</i>
            </span>
            <span class="pt-row-tick">{{ replaceFrom === o.id ? '当前' : pickedIds.has(o.id) ? '✓' : '' }}</span>
          </button>
          <div v-if="!filtered.length" class="pt-row-empty">没有匹配的</div>
        </div>
      </div>
    </n-popover>
  </div>
</template>

<style scoped>
.pt {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px;
}
/* 4 个以上两列：flex 排 4 个会「一行 3 个 + 末尾 1 个拉满」，宽窄不一看着像出错了 */
.pt:has(> .pt-tile:nth-of-type(4)) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.pt-tile {
  position: relative;
  display: block;
  flex: 1 1 0;
  /* 3 个主体 + 加号要能排进一行（201 = 3×52 + 3×4 + 26），所以下限给 52 */
  min-width: 52px;
  max-width: 92px;
  height: 46px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  overflow: hidden;
  background: var(--hover);
  cursor: zoom-in;
}
/*
 * 单选（场景）不参与分摊：只有一张图，拉满整格只是白白占掉主体的横向空间。
 * 定宽 92 + 加号 26 + 间距 4 = 122，放在 auto 列里正好是"一张图"的宽度。
 */
.pt.is-single .pt-tile {
  flex: 0 0 auto;
  width: 92px;
  max-width: none;
}
.pt-tile:hover {
  border-color: var(--accent);
}
.pt-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.pt-tile > img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 缺图：黄虚线 + 「缺图」两个字 —— 和"有图但暗"要能分开 */
.pt-tile.is-noimg {
  border-style: dashed;
  border-color: var(--warn-line);
  background: var(--warn-soft);
  cursor: pointer;
}
.pt-noimg-lb {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-60%);
  text-align: center;
  font-size: 10px;
  line-height: 12px;
  color: var(--warn-ink);
}
.pt-badge {
  position: absolute;
  left: 2px;
  top: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--accent-ink);
  font-size: 9px;
  line-height: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.pt-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 0 3px;
  font-size: 10px;
  line-height: 14px;
  font-weight: 500;
  color: #fff;
  background: linear-gradient(to top, rgba(12, 18, 28, 0.74), rgba(12, 18, 28, 0.32));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
/* 缺图块的名字压在黄底上：白字看不见，换深色 */
.pt-tile.is-noimg .pt-name {
  color: var(--warn-ink);
  background: none;
}

/* 换 / 移除：只在悬停时露出，一排小字会把图盖住 */
.pt-ops {
  position: absolute;
  right: 2px;
  top: 2px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.pt-tile:hover .pt-ops,
.pt-ops:focus-within {
  opacity: 1;
}
.pt-op {
  width: 15px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--label);
  font-size: 9.5px;
  line-height: 14px;
  text-align: center;
  cursor: pointer;
}
.pt-op:hover {
  color: var(--accent);
}

/* 加号：没选东西时是一块带字的虚线，选了之后缩成一颗小方块 */
.pt-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 0 0 auto;
  width: 26px;
  height: 46px;
  padding: 0;
  border: 1px dashed var(--line-strong);
  border-radius: 5px;
  background: transparent;
  color: var(--muted-3);
  font-size: 10.5px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.pt-add:not(:has(.pt-ph)) {
  width: 26px;
}
.pt-add:has(.pt-ph) {
  width: auto;
  /* 与一张图同宽（92）：空态和有图态列宽一致，选完场景不会整行跟着跳一下 */
  min-width: 92px;
  padding: 0 8px;
}
.pt-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.pt-add.is-warn {
  border-color: var(--warn-line);
  color: var(--warn-ink);
  background: var(--warn-soft);
}
/*
 * 选满了就把加号收走（场景这种单选）。不能 display:none —— 它同时是候选面板的
 * 定位锚点，真拿掉之后点图块上的「换」，面板会跑到屏幕左上角去。压成 0 宽、透明即可。
 */
.pt-add.is-hidden {
  width: 0 !important;
  min-width: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
.pt-plus {
  font-size: 13px;
  line-height: 1;
}
.pt-ph {
  font-size: 10.5px;
  line-height: 1;
  white-space: nowrap;
}

/* ------------------------------ 候选面板 ------------------------------ */
.pt-pop {
  width: 262px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow-2);
}
.pt-pop-h {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 4px 5px;
}
.pt-pop-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.pt-pop-n {
  font-size: 10.5px;
  color: var(--muted-3);
  font-variant-numeric: tabular-nums;
}
.pt-q {
  width: 100%;
  height: 24px;
  margin-bottom: 5px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}
.pt-q:focus {
  border-color: var(--accent);
}
.pt-list {
  max-height: 232px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pt-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 5px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pt-row:hover {
  background: var(--hover);
}
.pt-row.is-on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
/* 替换态下"要被换掉的那个"：不是选中态，用黄色标出来，和 ✓ 区分 */
.pt-row.is-cur {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.pt-row-img {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 38px;
  height: 24px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--panel-3);
}
.pt-row-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pt-row-img i {
  font-style: normal;
  font-size: 9px;
  color: var(--muted-3);
}
.pt-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pt-row-name i {
  margin-left: 4px;
  font-style: normal;
  font-size: 10px;
  color: var(--muted-3);
}
.pt-row.is-on .pt-row-name i {
  color: var(--accent-ink);
  opacity: 0.7;
}
.pt-row-tick {
  flex: none;
  min-width: 12px;
  font-size: 11px;
  color: var(--accent);
  text-align: right;
}
.pt-row.is-cur .pt-row-tick {
  font-size: 9.5px;
  color: var(--warn-ink);
}
.pt-row-empty {
  padding: 10px 4px;
  text-align: center;
  font-size: 11px;
  color: var(--muted-3);
}
</style>
