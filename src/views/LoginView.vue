<script setup lang="ts">
/**
 * 登录页。
 *
 * 这里**没有注册入口**：剧本台的账号只能由管理员在命令行创建
 * （`python server/app.py user add 名字`）。所以页面上也不要出现"注册"两个字，
 * 否则用户点遍全站也找不到入口。
 */
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { backendHealth } from '@/core/backend'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
/** 后端探活：连不上时先告诉人"服务没起"，而不是让人怀疑密码 */
const backendOk = ref(true)

onMounted(async () => {
  const health = await backendHealth()
  backendOk.value = !!health
})

async function submit(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写账号和密码'
    return
  }
  busy.value = true
  try {
    await auth.login(username.value, password.value)
    const next = typeof route.query.next === 'string' ? route.query.next : '/'
    await router.replace(next.startsWith('/') ? next : '/')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <div class="mark">剧</div>
        <div>
          <h1>剧本台</h1>
          <p class="muted">MiniMax H3 · 分镜与导演包</p>
        </div>
      </div>

      <form class="stack" @submit.prevent="submit">
        <n-input
          v-model:value="username"
          size="large"
          placeholder="账号"
          :input-props="{ autocomplete: 'username' }"
          :disabled="busy"
        />
        <n-input
          v-model:value="password"
          type="password"
          show-password-on="click"
          size="large"
          placeholder="密码"
          :input-props="{ autocomplete: 'current-password' }"
          :disabled="busy"
          @keyup.enter="submit"
        />

        <div v-if="error" class="err">{{ error }}</div>
        <div v-else-if="!backendOk" class="err">
          连不上后端。先在项目目录双击「启动剧本台.bat」，或跑 <code>npm start</code>。
        </div>

        <n-button type="primary" size="large" block :loading="busy" attr-type="submit">
          登 录
        </n-button>
      </form>

      <p class="hint">
        本系统不开放注册，账号需由管理员在服务器上创建：
        <code class="cmd">python server/app.py user add &lt;账号&gt;</code>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(900px 480px at 50% -10%, var(--accent-soft) 0%, rgba(232, 238, 255, 0) 70%),
    var(--bg);
}

.login-card {
  width: 100%;
  max-width: 384px;
  padding: 30px 28px 22px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 18px 48px rgba(16, 24, 40, 0.08);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.mark {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--accent);
  color: #fff;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0;
}
.brand h1 {
  margin: 0;
  font-size: 19px;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.brand p {
  margin: 0;
  font-size: 12px;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.err {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--err);
  background: var(--err-soft);
  border: 1px solid var(--err-line);
  border-radius: 8px;
  padding: 7px 10px;
}
.err code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 4px;
}

.hint {
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
}
.hint code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--line);
  padding: 1px 4px;
  border-radius: 4px;
}
/* 命令单独占一行：跟正文混排时会被折在错误的位置（"serv / er/app.py"） */
.hint .cmd {
  display: block;
  margin-top: 5px;
  padding: 4px 7px;
  word-break: normal;
  overflow-wrap: anywhere;
}
</style>
