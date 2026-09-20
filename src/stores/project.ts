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
  const settings = computed<ProjectSettings>(() => current.value?.settings ?? DEFAULT_SETTINGS)
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
    const next = { ...current.value.settings, ...changes }
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
