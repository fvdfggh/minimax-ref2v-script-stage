import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import {
  backendProjectRevs,
  setBackendWriteSink,
  type BackendTable,
  type BackendWrite
} from '@/core/backend'

/* ------------------------------------------------------------------ *
 * 数据同步总线
 *
 * 项目里同一份数据被好几个 tab 同时用：片段（beats）在拆解页改标题、
 * 在填充页改画面、在卡片素材带改绑定；段字段（assemblies）在补全页生成、
 * 在交付页手改。所有这些都必须落在后端**同一份** JSON 上。
 *
 * 已经成立的部分：写库只有一条路（HttpTable），store 之间共享同一份
 * 响应式数据，所以同页面内的联动是自动的。
 *
 * 这里补的是页面之外的两种"不同步"：
 *
 * 1. 另一个浏览器窗口 / 另一台机器改了同一个项目 —— 前端看不到，
 *    继续拿旧数据算，甚至会把自己那份旧值写回去覆盖别人的改动。
 *    做法：定时问后端「盘上文件还是不是上次那个指纹」，变了就 reload，
 *    并在页面顶部说明"哪张表被改过、已经刷新"。
 * 2. 本页正在编辑、尚未提交的草稿 —— reload 不能把人的输入抹掉。
 *    做法：external 事件带上「哪些行变了」，由页面自己决定保留还是覆盖。
 *
 * 为什么不做乐观锁（版本号冲突报错）：这是一个单人为主的导演工作台，
 * 冲突的代价远小于"每次都要先点一下确认"。所以默认**同步更改**，
 * 只在页面里对"你有未提交草稿"给出提醒。
 * ------------------------------------------------------------------ */

export const SYNC_TABLES: BackendTable[] = [
  'projects',
  'entities',
  'assets',
  'beats',
  'assemblies',
  'providers'
]

export const TABLE_LABEL: Record<BackendTable, string> = {
  projects: '项目',
  entities: '主体',
  assets: '素材',
  beats: '片段',
  assemblies: '段与字段',
  providers: '模型配置'
}

/** 外部改动的通知 */
export interface ExternalChange {
  table: BackendTable
  /** 该表最近一次本地写之后的新指纹，仅用于去重 */
  fingerprint: string
  at: number
}

type ExternalListener = (change: ExternalChange) => void | Promise<void>

/** 轮询间隔：够快能让人感觉"自动同步了"，又不会把后端压出噪音 */
const POLL_MS = 6000
/** 本地写完之后多久去刷新基线（防抖：连续写多张表只刷一次） */
const BASELINE_REFRESH_MS = 400

/** 指纹里除数据表之外的两项：project.json 算「项目」，meta.json 不作为变化通知 */
export type RevName = BackendTable | 'project'

export interface RevChange {
  table: RevName
  fingerprint: string
}

/**
 * 比对两轮指纹，返回真正变了的表。
 *
 * 抽成纯函数是为了能单独测：这段逻辑一旦写错，表现是"改了不同步"或者
 * "没改也一直刷新"，两种都很难在界面上看出来。
 *
 * meta.json 要算成 assemblies 的变化：字段覆盖值（overrides / summaries）
 * 和段指纹（segmeta）都存在那里，但它们的效果体现在段字段上。漏掉它，
 * 「另一个窗口改了 summary」在本页就永远看不到。
 */
export function diffRevs(
  prev: Record<string, string>,
  next: Record<string, string>
): RevChange[] {
  const out = new Map<RevName, RevChange>()
  for (const [name, fp] of Object.entries(next)) {
    if (!fp || prev[name] === fp) continue
    const table: RevName | null =
      name === 'meta'
        ? 'assemblies'
        : name === 'project'
          ? 'project'
          : SYNC_TABLES.includes(name as BackendTable)
            ? (name as BackendTable)
            : null
    if (!table) continue
    // assemblies 和 meta 同时变时只报一次：它们本来就是一起 reload 的
    if (!out.has(table)) out.set(table, { table, fingerprint: fp })
  }
  return [...out.values()]
}

export const useSyncStore = defineStore('sync', () => {
  /** 当前监视的项目 */
  const projectId = ref('')
  /** 本地写序号，用来给"最近一次写"排序 */
  const seq = ref(0)
  /** 每张表最近一次被写的时间（本页写的） */
  const lastLocalAt = reactive<Record<BackendTable, number>>(blankTimes())
  /** 每张表被外部改过几次：页面 watch 它就能拿到"该 reload 了" */
  const externalRev = reactive<Record<BackendTable, number>>(blankRev())
  /** 最近一次外部改动摘要，给提示条用 */
  const external = ref<ExternalChange[]>([])
  /** 最近的本地写（调试 / 给页面判断"是不是我刚改的"） */
  const recentWrites = ref<BackendWrite[]>([])
  /** 是否正在轮询 */
  const running = ref(false)
  /** 最近一次成功比对的时间（0 = 还没成功过） */
  const lastCheckAt = ref(0)

  const listeners = new Set<ExternalListener>()
  let timer: ReturnType<typeof setInterval> | null = null
  /** 上一次看到的指纹基线 */
  let baseline: Record<string, string> = {}
  /** 本地刚写完：稍后去把基线刷新掉 */
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let checking = false

  const watching = computed(() => !!projectId.value && running.value)

  function blankTimes(): Record<BackendTable, number> {
    return { projects: 0, entities: 0, assets: 0, beats: 0, assemblies: 0, providers: 0 }
  }
  function blankRev(): Record<BackendTable, number> {
    return { projects: 0, entities: 0, assets: 0, beats: 0, assemblies: 0, providers: 0 }
  }

  /** 本地写：记时间，并安排一次基线刷新 */
  function noteLocal(write: BackendWrite): void {
    seq.value += 1
    lastLocalAt[write.table] = Date.now()
    recentWrites.value = [...recentWrites.value.slice(-49), write]
    scheduleBaselineRefresh()
  }

  /**
   * 写完就把基线刷新成"含我这次写"的状态。
   *
   * 之前这里是"本地刚写过 → 整轮比对跳过"。那是错的：别的表（比如 meta.json）
   * 恰好在这时候被别处改了，也会被一起跳过，基线顺势吞掉那处改动 ——
   * 表现就是「另一个窗口改了 summary，这一页怎么都不刷新」。
   * 现在只跳过自己的写，别人的照报。
   */
  function scheduleBaselineRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(async () => {
      refreshTimer = null
      const pid = projectId.value
      if (!pid) return
      const revs = await backendProjectRevs(pid)
      if (revs) baseline = { ...baseline, ...revs }
    }, BASELINE_REFRESH_MS)
  }

  function installSink(): void {
    setBackendWriteSink(noteLocal)
  }

  /** 订阅外部改动，返回取消函数 */
  function onExternal(fn: ExternalListener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function mark(table: BackendTable, fingerprint: string): void {
    const change: ExternalChange = { table, fingerprint, at: Date.now() }
    externalRev[table] += 1
    // 同一张表只留最新一条，提示条不该滚成一条瀑布
    external.value = [...external.value.filter((e) => e.table !== table), change]
    for (const fn of listeners) {
      try {
        void fn(change)
      } catch {
        // 一个订阅者出错不该影响其他页面
      }
    }
  }

  /**
   * 立刻比对一次。
   *
   * 页面不可见时不查（人不在看，reload 只会闪一下就丢焦点、还可能丢光标）。
   * 基线还没建立时（刚 start）只记录不报：那时没有"上一版"可比。
   */
  async function check(force = false): Promise<void> {
    const pid = projectId.value
    if (!pid || checking) return
    if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    checking = true
    try {
      const revs = await backendProjectRevs(pid)
      if (!revs) return
      const now = Date.now()
      if (!Object.keys(baseline).length) {
        baseline = revs
        lastCheckAt.value = now
        return
      }
      const changes = diffRevs(baseline, revs)
      /*
       * 整份覆盖，而不是逐条写 baseline[change.table]。
       *
       * 逐条写会漏键：meta.json 的变化被映射成「assemblies」上报，
       * 于是 baseline['assemblies'] 更新了、baseline['meta'] 还停在旧值 ——
       * 下一轮又判定 meta 变了，于是无限 reload。
       * （这个 bug 的表现是"每 6 秒闪一下、数据反复重载"，不会报错，很难看出来。）
       */
      baseline = { ...revs }
      for (const change of changes) {
        mark(change.table === 'project' ? 'projects' : change.table, change.fingerprint)
      }
      lastCheckAt.value = now
    } finally {
      checking = false
    }
  }

  /** 开始监视某个项目 */
  function start(pid: string): void {
    installSink()
    if (projectId.value === pid && running.value) return
    stop()
    projectId.value = pid
    baseline = {}
    running.value = true
    void check(true)
    timer = setInterval(() => void check(), POLL_MS)
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    running.value = false
    projectId.value = ''
    baseline = {}
  }

  /** 提示条关掉之后，把它从列表里摘掉（不清计数：计数是给 watch 用的） */
  function dismiss(table?: BackendTable): void {
    external.value = table
      ? external.value.filter((e) => e.table !== table)
      : []
  }

  /** 最近一次本地写某张表过了多久（ms）；没写过返回 Infinity */
  function sinceLocalWrite(table: BackendTable): number {
    const t = lastLocalAt[table]
    return t ? Date.now() - t : Number.POSITIVE_INFINITY
  }

  return {
    projectId,
    running,
    watching,
    external,
    externalRev,
    recentWrites,
    lastCheckAt,
    start,
    stop,
    check,
    dismiss,
    onExternal,
    noteLocal,
    sinceLocalWrite,
    TABLE_LABEL
  }
})
