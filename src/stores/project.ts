import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, deleteProjectDeep, kvGet, kvSet, saveOne } from '@/db'
import { uid, now } from '@/core/id'
import { DEFAULT_FIELD_SCHEMA, DEFAULT_SETTINGS } from '@/domain/types'
import type { FieldSchema, Project, ProjectSettings, ProjectStage } from '@/domain/types'

export const useProjectStore = defineStore('project', () => {
  const projects = ref<Project[]>([])
  const currentId = ref<string | null>(null)
  const loading = ref(false)

  const current = computed(() => projects.value.find((p) => p.id === currentId.value) ?? null)

  /**
   * ★ 存的 settings 必须与默认值合并后再用，不能直接取。
   *
   * 新加的设置项在老项目上是不存在的（库里存的是当时那份完整对象）。
   * 直接取用的话字段是 undefined，再被下游兜底成某个值 ——
   * workLanguage 就是这么被兜成 'en' 的：功能上线前建的项目，
   * 一打开就在中文工作稿上跑英文校验。
   */
  const settings = computed<ProjectSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(current.value?.settings ?? {})
  }))
  const fieldSchema = computed<FieldSchema[]>(() =>
    [...(current.value?.fieldSchema ?? DEFAULT_FIELD_SCHEMA)].sort((a, b) => a.order - b.order)
  )

  async function loadAll() {
    loading.value = true
    try {
      projects.value = await db.projects.orderBy('updatedAt').reverse().toArray()
      currentId.value = await kvGet<string | null>('currentProjectId', null)
      if (currentId.value && !projects.value.some((p) => p.id === currentId.value)) {
        currentId.value = projects.value[0]?.id ?? null
      }
      if (!currentId.value && projects.value.length) currentId.value = projects.value[0].id
    } finally {
      loading.value = false
    }
  }

  async function select(id: string | null) {
    currentId.value = id
    await kvSet('currentProjectId', id)
  }

  async function create(name: string, story = ''): Promise<Project> {
    const ts = now()
    const project: Project = {
      id: uid('prj'),
      name: name || '未命名项目',
      story,
      stage: 'split',
      settings: { ...DEFAULT_SETTINGS },
      fieldSchema: structuredClone(DEFAULT_FIELD_SCHEMA),
      createdAt: ts,
      updatedAt: ts
    }
    await saveOne(db.projects, project)
    projects.value = [project, ...projects.value]
    await select(project.id)
    return project
  }

  async function patch(id: string, patch: Partial<Project>) {
    const p = projects.value.find((x) => x.id === id)
    if (!p) return
    Object.assign(p, patch, { updatedAt: now() })
    await saveOne(db.projects, { ...p })
  }

  async function updateSettings(changes: Partial<ProjectSettings>) {
    if (!current.value) return
    // 基于合并后的 settings 写回，顺手把老项目缺的键补齐
    const next = { ...settings.value, ...changes }
    await patch(current.value.id, { settings: next })
  }

  async function updateFieldSchema(schema: FieldSchema[]) {
    if (!current.value) return
    const normalized = schema.map((f, i) => ({ ...f, order: i + 1 }))
    await patch(current.value.id, { fieldSchema: normalized })
  }

  async function setStage(stage: ProjectStage) {
    if (!current.value) return
    await patch(current.value.id, { stage })
  }

  async function remove(id: string) {
    await deleteProjectDeep(id)
    projects.value = projects.value.filter((p) => p.id !== id)
    if (currentId.value === id) await select(projects.value[0]?.id ?? null)
  }

  async function rename(id: string, name: string) {
    await patch(id, { name })
  }

  function reset() {
    projects.value = []
    currentId.value = null
  }

  return {
    projects,
    currentId,
    current,
    settings,
    fieldSchema,
    loading,
    loadAll,
    select,
    create,
    patch,
    updateSettings,
    updateFieldSchema,
    setStage,
    remove,
    rename,
    reset
  }
})
