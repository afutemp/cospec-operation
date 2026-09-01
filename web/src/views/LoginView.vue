<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { auth } from "../auth";
import { ApiError, telemetryQueries } from "../api";
const token = ref(""); const loading = ref(false); const route = useRoute(); const router = useRouter();
async function login() {
  if (!token.value.trim()) return;
  loading.value = true; auth.set(token.value);
  try { await telemetryQueries.getRunUsage({}); await router.replace(typeof route.query.redirect === "string" ? route.query.redirect : "/"); }
  catch (error) { auth.clear(); ElMessage.error(error instanceof ApiError && error.status === 401 ? "Token 无效，请重新输入" : "无法连接服务端，请稍后重试"); }
  finally { loading.value = false; }
}
</script>
<template><main class="login-page"><section class="login-card"><div class="brand-mark">C</div><h1>Cospec 运营看板</h1><p>请输入服务端访问 Token。Token 只保存在当前页面内存中，刷新或关闭页面后需要重新输入。</p><el-input v-model="token" type="password" show-password size="large" placeholder="Bearer Token" @keyup.enter="login" /><el-button type="primary" size="large" :loading="loading" :disabled="!token.trim()" @click="login">进入看板</el-button></section></main></template>
