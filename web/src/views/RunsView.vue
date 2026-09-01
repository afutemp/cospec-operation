<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { telemetryQueries, type RunItem } from "../api";
import { bytes, copyText, datetime, errorText, shortId } from "../format";
const route = useRoute(); const router = useRouter(); const limit = 20;
const page = ref(Math.max(1, Number(route.query.page) || 1));
watch(page, (value) => void router.replace({ query: value === 1 ? {} : { page: String(value) } }));
const offset = computed(() => (page.value - 1) * limit);
const query = useQuery({ queryKey: computed(() => ["runs", offset.value]), queryFn: () => telemetryQueries.listRuns(limit, offset.value), placeholderData: (old) => old });
async function copy(value: string) { await copyText(value); ElMessage.success("Run ID 已复制"); }
function open(row: RunItem) { void router.push(`/runs/${row.runId}`); }
</script>
<template><div><header class="page-head"><div><h1>Run 列表</h1><p>查看采集、解析和来源信息</p></div><el-button :loading="query.isFetching.value" @click="query.refetch()">刷新数据</el-button></header>
  <el-alert v-if="query.isError.value" :title="errorText(query.error.value)" type="error" show-icon style="margin-bottom:16px"/>
  <section class="panel"><el-table :data="query.data.value?.items ?? []" v-loading="query.isLoading.value" @row-click="open" row-class-name="clickable">
    <el-table-column label="Run ID" min-width="190"><template #default="{row}"><span class="mono">{{ shortId(row.runId) }}</span><el-button text size="small" @click.stop="copy(row.runId)">复制</el-button></template></el-table-column>
    <el-table-column label="Agent" width="135"><template #default="{row}"><el-tag effect="plain">{{ row.agentType === 'claude_code' ? 'Claude Code' : 'Codex' }}</el-tag></template></el-table-column>
    <el-table-column prop="sourceVersion" label="版本" width="115"/><el-table-column label="首次接收" min-width="170"><template #default="{row}">{{ datetime(row.firstReceivedAt) }}</template></el-table-column>
    <el-table-column prop="chunkCount" label="数据块" width="85"/><el-table-column label="大小" width="95"><template #default="{row}">{{ bytes(row.byteCount) }}</template></el-table-column>
    <el-table-column label="解析器" width="110"><template #default="{row}"><span :class="row.activeParserVersion ? '' : 'unknown'">{{ row.activeParserVersion ?? '待解析' }}</span></template></el-table-column>
  </el-table><div v-if="!query.isLoading.value && !query.data.value?.items.length" class="empty">暂无 Run 数据</div><el-pagination v-if="query.data.value?.total" v-model:current-page="page" :page-size="limit" :total="query.data.value.total" layout="total, prev, pager, next" style="margin-top:18px;justify-content:flex-end"/></section>
</div></template>
