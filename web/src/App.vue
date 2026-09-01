<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { watch } from "vue";
import { auth } from "./auth";
const route = useRoute(); const router = useRouter();
function logout() { auth.clear(); void router.push("/login"); }
watch(auth.token, (value) => { if (!value && !route.meta.public) void router.push("/login"); });
</script>

<template>
  <router-view v-if="route.meta.public" />
  <el-container v-else class="shell">
    <el-aside width="224px" class="sidebar">
      <div class="brand"><span class="brand-mark">C</span><div><strong>Cospec</strong><small>运营看板</small></div></div>
      <el-menu router :default-active="route.path" class="nav">
        <el-menu-item index="/"><el-icon><DataAnalysis /></el-icon><span>运营总览</span></el-menu-item>
        <el-menu-item index="/runs"><el-icon><List /></el-icon><span>Run 列表</span></el-menu-item>
      </el-menu>
      <button class="logout" @click="logout">退出当前会话</button>
    </el-aside>
    <el-main class="main"><router-view /></el-main>
  </el-container>
</template>

<script lang="ts">
import { DataAnalysis, List } from "@element-plus/icons-vue";
export default { components: { DataAnalysis, List } };
</script>
