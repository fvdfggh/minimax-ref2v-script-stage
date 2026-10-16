import type { DataTable } from '@/core/backend'
import type { AppDb, KvStore } from '@/db'
import type { Assembly, Asset, Beat, Entity, Project, Provider } from '@/domain/types'

/**
 * 内存版数据表 / kv —— 数据只存在于 JS Map 里，不落磁盘、也不落浏览器存储。
 * 与后端适配器实现同一套 DataTable 接口，供测试注入（见 db/index.ts 的 setDbImpl/setKvImpl）。
 */
type Row = Record<string, unknown>

function idOf<T>(row: T): string {
  return String((row as unknown as Row).id ?? '')
}

function cmp(field: string, desc = false) {
  return (a: unknown, b: unknown) => {
    const av = (a as Row)?.[field]
    const bv = (b as Row)?.[field]
    if (av === bv) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const r = av > bv ? 1 : -1
    return desc ? -r : r
  }
}

class MemTable<T> implements DataTable<T> {
  constructor(
    private readonly _name: string
  ) {}

  private rows = new Map<string, T>()

  private all(): T[] {
    return [...this.rows.values()]
  }

  async toArray(): Promise<T[]> {
    return this.all()
  }

  async get(key: string): Promise<T | undefined> {
    return this.rows.get(key)
  }

  async put(row: T): Promise<unknown> {
    this.rows.set(idOf(row), row)
    return idOf(row)
  }

  async bulkPut(rows: T[]): Promise<unknown> {
    for (const r of rows) this.rows.set(idOf(r), r)
    return this.rows.size
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key)
  }

  async bulkDelete(keys: string[]): Promise<unknown> {
    for (const k of keys) this.rows.delete(k)
    return keys.length
  }

  async count(): Promise<number> {
    return this.rows.size
  }

  where(field: string) {
    const self = this
    return {
      equals(value: string) {
        const match = () => self.all().filter((r) => String((r as Row)[field]) === String(value))
        return {
          toArray: async () => match(),
          sortBy: async (sortField: string) => match().sort(cmp(sortField)),
          delete: async () => {
            const doomed = match().map((r) => idOf(r))
            for (const k of doomed) self.rows.delete(k)
            return doomed.length
          }
        }
      }
    }
  }

  orderBy(field: string) {
    const self = this
    return {
      reverse() {
        return {
          toArray: async () => self.all().sort(cmp(field, true))
        }
      }
    }
  }
}

export function createMemoryDb(): AppDb {
  return {
    projects: new MemTable<Project>('projects'),
    entities: new MemTable<Entity>('entities'),
    assets: new MemTable<Asset>('assets'),
    beats: new MemTable<Beat>('beats'),
    assemblies: new MemTable<Assembly>('assemblies'),
    providers: new MemTable<Provider>('providers')
  }
}

export function createMemoryKv(): KvStore {
  const bag = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return bag.get(key) as T | undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      bag.set(key, value)
    },
    async delete(key: string): Promise<void> {
      bag.delete(key)
    }
  }
}
