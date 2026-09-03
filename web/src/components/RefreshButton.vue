<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
defineProps<{ loading?: boolean }>();
defineEmits<{ click: [] }>();
</script>
<template>
  <el-button
    circle
    title="刷新数据"
    aria-label="刷新数据"
    :loading="loading"
    @click="$emit('click')"
    ><el-icon><Refresh /></el-icon
  ></el-button>
</template>
