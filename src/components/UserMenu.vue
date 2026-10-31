<script setup lang="ts">
/**
 * 右上角的当前用户。点开能改密码、退出登录。
 *
 * 改密码这里是唯一入口 —— 系统没有注册、也没有"忘记密码"（邮件/短信都无从
 * 谈起，账号是管理员在本机命令行建的），忘了只能用
 * `python server/app.py user passwd <账号>` 重置。
 */
import { computed, h, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NDropdown,
  NInput,
  NModal,
  useMessage,
  type DropdownOption
} from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import InfoTip from '@/components/common/InfoTip.vue'

const auth = useAuthStore()
const router = useRouter()
const message = useMessage()

const showPassword = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref('')

const initial = computed(() => (auth.displayName || '?').slice(0, 1).toUpperCase())

function renderLabel(text: string) {
  return () => h('span', { style: 'font-size:13px' }, text)
}

const options = computed<DropdownOption[]>(() => [
  { key: 'who', label: renderLabel(`已登录：${auth.user?.username ?? ''}`), disabled: true },
  { type: 'divider', key: 'd1' },
  { key: 'password', label: renderLabel('修改密码') },
  { key: 'logout', label: renderLabel('退出登录') }
])

function onSelect(key: string): void {
  if (key === 'password') openPassword()
  if (key === 'logout') void doLogout()
}

function openPassword(): void {
  oldPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  error.value = ''
  showPassword.value = true
}

async function doLogout(): Promise<void> {
  await auth.logout()
  message.success('已退出登录')
  await router.replace({ name: 'login' })
}

async function submitPassword(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if (!oldPassword.value || !newPassword.value) {
    error.value = '请填写原密码和新密码'
    return
  }
  if (newPassword.value.length < 6) {
    error.value = '新密码至少 6 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  try {
    await auth.changePassword(oldPassword.value, newPassword.value)
    showPassword.value = false
    message.success('密码已修改，其它设备上的登录已失效')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="user-menu">
    <n-dropdown trigger="click" :options="options" placement="bottom-end" @select="onSelect">
      <div class="um-trigger" :title="auth.user?.username">
        <span class="avatar">{{ initial }}</span>
        <span class="name">{{ auth.displayName }}</span>
        <span class="caret">▾</span>
      </div>
    </n-dropdown>

    <n-modal
      v-model:show="showPassword"
      preset="card"
      title="修改密码"
      style="max-width: 400px"
    >
      <div class="stack" style="gap: 10px">
        <n-input
          v-model:value="oldPassword"
          type="password"
          show-password-on="click"
          placeholder="原密码"
        />
        <n-input
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          placeholder="新密码（至少 6 位）"
        />
        <n-input
          v-model:value="confirmPassword"
          type="password"
          show-password-on="click"
          placeholder="再输一次新密码"
          @keyup.enter="submitPassword"
        />
        <div v-if="error" class="err">{{ error }}</div>
        <div class="muted" style="font-size: 12px">
          其它设备上的登录会立即失效
          <InfoTip size="sm" :width="240" text="改完密码后需要重新登录。" />
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <n-button quaternary @click="showPassword = false">取消</n-button>
          <n-button type="primary" :loading="busy" @click="submitPassword">确定</n-button>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.user-menu {
  display: flex;
  align-items: center;
  height: 100%;
  padding-left: 14px;
  margin-left: 10px;
  border-left: 1px solid var(--line);
}
.um-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 7px 3px 3px;
  border-radius: 999px;
  cursor: pointer;
  max-width: 168px;
  transition: background 0.12s;
}
.um-trigger:hover {
  background: var(--panel-2);
}
.avatar {
  width: 21px;
  height: 21px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}
.name {
  font-size: 12.5px;
  /* 比一级 tab 淡一档：这是身份，不是第四个工作面 */
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.um-trigger:hover .name {
  color: var(--text);
}
.caret {
  font-size: 10px;
  color: var(--muted);
  line-height: 1;
}
.stack {
  display: flex;
  flex-direction: column;
}
.err {
  font-size: 12.5px;
  color: var(--err);
  background: var(--err-soft);
  border: 1px solid var(--err-line);
  border-radius: 8px;
  padding: 6px 9px;
}
</style>
