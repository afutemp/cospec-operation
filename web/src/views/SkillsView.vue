<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { InfoFilled } from "@element-plus/icons-vue";
import { telemetryQueries } from "../api";
import EChart from "../components/EChart.vue";
import RefreshButton from "../components/RefreshButton.vue";
import TimeRangeFilter from "../components/TimeRangeFilter.vue";
import { presetRange, type DatePreset } from "../date-range";
import { count, duration, errorText, percent } from "../format";

const route = useRoute();
const router = useRouter();
const filters = reactive({
  from: String(route.query.from ?? ""),
  to: String(route.query.to ?? ""),
  workflowKind: String(route.query.workflowKind ?? ""),
  proposerDept: String(route.query.proposerDept ?? ""),
});
const initialRange = !filters.from || !filters.to ? presetRange("week") : null;
if (initialRange) {
  filters.from = initialRange[0].toISOString();
  filters.to = initialRange[1].toISOString();
}
const validPresets: DatePreset[] = [
  "today", "week", "month", "last24h", "last7", "last30", "custom",
];
const requestedPreset = String(route.query.period ?? "") as DatePreset;
const timePreset = ref<DatePreset>(
  initialRange ? "week" : validPresets.includes(requestedPreset) ? requestedPreset : "custom",
);
const timeDates = ref<string[]>([filters.from, filters.to]);
const search = ref(String(route.query.search ?? ""));
const sortBy = ref(String(route.query.sort ?? "executions"));
const selectedSkill = ref<any>(null);
const drawerReady = ref(false);

const queryFilters = computed(() =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
);
const query = useQuery({
  queryKey: computed(() => ["skill-analysis", queryFilters.value]),
  queryFn: () => telemetryQueries.getRunUsage(queryFilters.value),
});
const optionQuery = useQuery({
  queryKey: ["workflow-filter-options"],
  queryFn: () => telemetryQueries.getWorkflowSummary({}),
});
const skills = computed(() => query.data.value?.skills ?? {});
const skillOptions = computed(() => Object.keys(skills.value.bySkill ?? {}).sort());
const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const values = Object.entries(skills.value.bySkill ?? {}).map(([skill, value]: [string, any]) => ({ skill, ...value }));
  const filtered = needle ? values.filter((item) => item.skill.toLowerCase().includes(needle)) : values;
  return filtered.sort((left, right) => {
    const field: Record<string, string> = {
      executions: "executions", workflows: "unique_runs", duration: "p90_ms",
      failures: "failed", toolFailures: "resources.tools.failures",
    };
    const read = (item: any, path: string) => path.split(".").reduce((value, key) => value?.[key], item) ?? -1;
    return Number(read(right, field[sortBy.value] ?? "executions")) - Number(read(left, field[sortBy.value] ?? "executions"));
  });
});
const topSkills = computed(() =>
  Object.entries(skills.value.bySkill ?? {})
    .map(([skill, value]: [string, any]) => ({ skill, ...value }))
    .sort((a, b) => Number(b.executions) - Number(a.executions))
    .slice(0, 5),
);
const days = computed(() => Object.keys(skills.value.byDay ?? {}).sort());
const trendOption = computed(() => ({
  tooltip: { trigger: "axis" }, legend: { top: 0 },
  grid: { left: 42, right: 20, top: 48, bottom: 30 },
  xAxis: { type: "category", data: days.value }, yAxis: { type: "value", minInterval: 1 },
  series: topSkills.value.map((item) => ({
    name: item.skill, type: days.value.length > 1 ? "line" : "bar",
    smooth: true, symbolSize: 7, barMaxWidth: 34,
    data: days.value.map((day) => skills.value.byDay?.[day]?.[item.skill] ?? 0),
  })),
}));
const selectedTrend = computed(() => ({
  tooltip: { trigger: "axis" }, grid: { left: 40, right: 16, top: 24, bottom: 28 },
  xAxis: { type: "category", data: days.value }, yAxis: { type: "value", minInterval: 1 },
  series: [{ type: days.value.length > 1 ? "line" : "bar", smooth: true, areaStyle: days.value.length > 1 ? {} : undefined, barMaxWidth: 34, data: days.value.map((day) => skills.value.byDay?.[day]?.[selectedSkill.value?.skill] ?? 0) }],
}));

function apply() {
  void router.replace({ query: {
    period: timePreset.value, from: filters.from, to: filters.to,
    ...(filters.workflowKind ? { workflowKind: filters.workflowKind } : {}),
    ...(filters.proposerDept ? { proposerDept: filters.proposerDept } : {}),
    ...(search.value ? { search: search.value } : {}),
    ...(sortBy.value !== "executions" ? { sort: sortBy.value } : {}),
  }});
}
function reset() {
  filters.workflowKind = ""; filters.proposerDept = ""; search.value = ""; sortBy.value = "executions";
  timePreset.value = "week";
  const range = presetRange("week")!;
  filters.from = range[0].toISOString(); filters.to = range[1].toISOString();
  timeDates.value = [filters.from, filters.to]; apply();
}
function openRuns(skill: string) {
  void router.push({ path: "/workflows", query: {
    from: filters.from, to: filters.to, period: timePreset.value, skill,
    ...(filters.workflowKind ? { workflowKind: filters.workflowKind } : {}),
    ...(filters.proposerDept ? { proposerDept: filters.proposerDept } : {}),
  }});
}
function openSkill(skill: any) {
  drawerReady.value = false;
  selectedSkill.value = skill;
}
watch(timePreset, (value) => {
  const range = presetRange(value); if (!range) return;
  filters.from = range[0].toISOString(); filters.to = range[1].toISOString();
  timeDates.value = [filters.from, filters.to]; apply();
});
watch(timeDates, (value) => {
  if (value.length !== 2 || timePreset.value !== "custom") return;
  [filters.from, filters.to] = value; apply();
}, { deep: true });
watch(() => [filters.workflowKind, filters.proposerDept], () => apply());
</script>

<template>
  <div>
    <header class="page-head">
      <div><h1>SKILL 分析</h1><p>查看 SKILL 使用情况，定位耗时和失败较集中的环节</p></div>
      <RefreshButton :loading="query.isFetching.value" @click="query.refetch()" />
    </header>
    <section class="panel global-filters">
      <TimeRangeFilter v-model:preset="timePreset" v-model:dates="timeDates" />
      <el-select v-model="filters.workflowKind" clearable placeholder="全部工作流类型" style="width:170px">
        <el-option label="大需求" value="large" /><el-option label="小需求" value="small" /><el-option label="自定义" value="custom" />
      </el-select>
      <el-select v-model="filters.proposerDept" filterable clearable placeholder="全部产线" style="width:220px">
        <el-option v-for="department in optionQuery.data.value?.filter_options?.proposer_depts ?? []" :key="department" :label="department" :value="department" />
      </el-select>
      <el-button text @click="reset">重置</el-button>
    </section>
    <section class="skill-summary">
      <article class="skill-card"><label>使用过的 SKILL</label><strong>{{ count(Object.keys(skills.bySkill ?? {}).length) }}</strong><small>当前周期识别到</small></article>
      <article class="skill-card"><label>执行次数</label><strong>{{ count(skills.executions) }}</strong><small>当前周期累计执行</small></article>
      <article class="skill-card"><label>涉及工作流</label><strong>{{ count(skills.unique_runs) }}</strong><small>运行过 SKILL 的工作流</small></article>
      <article class="skill-card"><label>时长样本</label><strong>{{ count(skills.measured_executions) }}</strong><small>覆盖 {{ percent(skills.duration_coverage) }}</small></article>
    </section>
    <section class="panel trend-panel">
      <div class="analysis-head"><div><h2>SKILL 使用趋势</h2><p>展示执行次数最多的 5 个 SKILL</p></div></div>
      <EChart v-if="days.length && topSkills.length" :option="trendOption" />
      <div v-else class="empty">当前范围暂无 SKILL 趋势数据</div>
    </section>
    <el-alert v-if="query.isError.value" :title="errorText(query.error.value)" type="error" show-icon style="margin-bottom:16px" />
    <section class="panel">
      <div class="table-head">
        <div><h2>SKILL 明细</h2><p>排序仅作用于下方列表</p></div>
        <div class="table-controls">
          <el-select v-model="search" filterable clearable placeholder="全部 SKILL" style="width:240px" @change="apply">
            <el-option v-for="skill in skillOptions" :key="skill" :label="skill" :value="skill" />
          </el-select>
          <el-select v-model="sortBy" style="width:180px" @change="apply">
            <el-option label="执行次数最多" value="executions" /><el-option label="涉及工作流最多" value="workflows" />
            <el-option label="P90 时长最长" value="duration" /><el-option label="执行失败最多" value="failures" />
            <el-option label="工具失败最多" value="toolFailures" />
          </el-select>
        </div>
      </div>
      <el-table :data="rows" v-loading="query.isLoading.value" row-class-name="clickable" @row-click="openSkill">
        <el-table-column prop="skill" label="SKILL" min-width="190" />
        <el-table-column prop="unique_runs" label="涉及工作流" width="90" />
        <el-table-column prop="executions" label="执行次数" width="80" />
        <el-table-column label="执行结果" width="190"><template #default="{ row }">成功 {{ row.completed }} · 失败 <span :class="row.failed ? 'danger' : ''">{{ row.failed }}</span><br />中断 {{ row.interrupted }} · 未结束 {{ row.open }}</template></el-table-column>
        <el-table-column label="P90 活跃时长" width="150"><template #header>P90 活跃时长 <el-tooltip content="用于发现耗时较长的 SKILL。已扣除可识别的用户回复等待时间，只统计有完整开始和结束标记的执行。"><el-icon class="info-tip"><InfoFilled /></el-icon></el-tooltip></template><template #default="{ row }">{{ duration(row.p90_ms) }}</template></el-table-column>
        <el-table-column label="等待用户" width="90"><template #default="{ row }">{{ duration(row.waiting_for_user_accumulated_ms) }}</template></el-table-column>
        <el-table-column label="工具失败" width="80"><template #default="{ row }"><span :class="row.resources?.tools?.failures ? 'danger' : ''">{{ count(row.resources?.tools?.failures) }}</span></template></el-table-column>
      </el-table>
      <div v-if="!query.isLoading.value && !rows.length" class="empty">当前条件下暂无 SKILL 数据</div>
    </section>

    <el-drawer :model-value="Boolean(selectedSkill)" :title="selectedSkill?.skill" size="70%" @opened="drawerReady = true" @closed="drawerReady = false" @close="selectedSkill = null">
      <template v-if="selectedSkill">
        <div class="drawer-metrics">
          <div><label>执行次数</label><strong>{{ count(selectedSkill.executions) }}</strong></div>
          <div><label>涉及工作流</label><strong>{{ count(selectedSkill.unique_runs) }}</strong></div>
          <div><label>成功 / 失败 / 中断 / 未结束</label><strong>{{ count(selectedSkill.completed) }} / <span class="danger">{{ count(selectedSkill.failed) }}</span> / {{ count(selectedSkill.interrupted) }} / {{ count(selectedSkill.open) }}</strong></div>
          <div><label>活跃时长 P50 / P90</label><strong>{{ duration(selectedSkill.p50_ms) }} / {{ duration(selectedSkill.p90_ms) }}</strong></div>
          <div><label>工具调用 / 失败</label><strong>{{ count(selectedSkill.resources?.tools?.calls) }} / {{ count(selectedSkill.resources?.tools?.failures) }}</strong></div>
          <div><label>等待用户</label><strong>{{ duration(selectedSkill.waiting_for_user_accumulated_ms) }}</strong></div>
          <div><label>交付产物</label><strong>{{ count(selectedSkill.artifact_count) }}</strong></div>
          <div><label>输入 / 输出 Token</label><strong>{{ count(selectedSkill.resources?.tokens?.input_tokens) }} / {{ count(selectedSkill.resources?.tokens?.output_tokens) }}</strong></div>
        </div>
        <h3>执行趋势</h3><EChart v-if="drawerReady && days.length" :option="selectedTrend" />
        <div class="drawer-action"><el-button type="primary" @click="openRuns(selectedSkill.skill)">查看相关工作流</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.global-filters { display:flex; gap:12px; align-items:center; margin-bottom:18px; }
.skill-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:18px; }
.skill-card { background:linear-gradient(145deg,#fff,#f7fbfa); border:1px solid #e1e9e9; border-radius:12px; padding:20px; }
.skill-card label,.skill-card small { color:#7b8991; }.skill-card strong { display:block; font-size:28px; margin:10px 0 5px; }.skill-card small { font-size:12px; }
.trend-panel { margin-bottom:18px; }.trend-panel :deep(.chart) { height:260px; }.analysis-head h2 { margin:0 0 5px; font-size:18px; }.analysis-head p { margin:0; color:#7b8991; font-size:13px; }
.table-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
.table-head h2 { margin:0 0 4px; font-size:17px; }.table-head p { margin:0; color:#7b8991; font-size:12px; }
.table-controls { display:flex; gap:10px; }
.info-tip { margin-left:4px; color:#97a5ac; cursor:help; vertical-align:-2px; }
.drawer-metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }.drawer-metrics div { background:#f6f9f9; border-radius:9px; padding:16px; }.drawer-metrics label { display:block; color:#7b8991; font-size:12px; margin-bottom:7px; }.drawer-metrics strong { font-size:20px; }.drawer-action { text-align:right; margin-top:18px; }
@media(max-width:1200px){.skill-summary{grid-template-columns:repeat(2,1fr)}}
</style>
