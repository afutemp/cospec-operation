<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { auth } from "./auth";
import { telemetryQueries } from "./api";
const route = useRoute();
const router = useRouter();
const currentUser = useQuery({ queryKey: ["current-user"], queryFn: telemetryQueries.getCurrentUser, enabled: () => auth.authenticated() });
function logout() {
  auth.clear();
  void router.push("/login");
}
watch(auth.token, (value) => {
  if (!value && !route.meta.public) void router.push("/login");
});
</script>

<template>
  <router-view v-if="route.meta.public" />
  <el-container v-else class="shell">
    <el-aside width="224px" class="sidebar">
      <div class="brand">
        <span class="brand-mark">C</span>
        <div><strong>Cospec</strong><small>运营看板</small></div>
      </div>
      <el-menu router :default-active="route.path" class="nav">
        <el-menu-item index="/"
          ><el-icon><DataAnalysis /></el-icon
          ><span>运营概览</span></el-menu-item
        >
        <el-menu-item index="/workflows"
          ><el-icon><List /></el-icon><span>工作流分析</span></el-menu-item
        >
        <el-menu-item index="/skills"
          ><el-icon><Histogram /></el-icon><span>SKILL 分析</span></el-menu-item
        >
        <el-menu-item index="/adoption"
          ><el-icon><UserFilled /></el-icon><span>推广使用</span></el-menu-item
        >
        <el-menu-item v-if="currentUser.data.value?.role === 'admin'" index="/users"
          ><el-icon><Setting /></el-icon><span>用户管理</span></el-menu-item
        >
      </el-menu>
      <button class="logout" @click="logout">退出当前会话</button>
    </el-aside>
    <el-main class="main"><router-view /></el-main>
  </el-container>
</template>

<script lang="ts">
import { DataAnalysis, Histogram, List, Setting, UserFilled } from "@element-plus/icons-vue";
export default { components: { DataAnalysis, Histogram, List, Setting, UserFilled } };
</script>
