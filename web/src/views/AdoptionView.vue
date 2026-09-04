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
import { count, errorText, percent } from "../format";

const route = useRoute();
const router = useRouter();
const filters = reactive({
  from: String(route.query.from ?? ""),
  to: String(route.query.to ?? ""),
  proposerDept: String(route.query.proposerDept ?? ""),
});
const initialRange = !filters.from || !filters.to ? presetRange("week") : null;
if (initialRange) [filters.from, filters.to] = initialRange.map((item) => item.toISOString());
const validPresets: DatePreset[] = ["today", "week", "month", "last24h", "last7", "last30", "custom"];
const requestedPreset = String(route.query.period ?? "") as DatePreset;
const timePreset = ref<DatePreset>(initialRange ? "week" : validPresets.includes(requestedPreset) ? requestedPreset : "custom");
const timeDates = ref<string[]>([filters.from, filters.to]);
const selectedDepartment = ref<any>(null);

const queryFilters = computed(() => Object.fromEntries(Object.entries(filters).filter(([, value]) => value)));
const summaryQuery = useQuery({
  queryKey: computed(() => ["adoption-summary", queryFilters.value]),
  queryFn: () => telemetryQueries.getWorkflowSummary(queryFilters.value),
});
const usageQuery = useQuery({
  queryKey: computed(() => ["adoption-usage", queryFilters.value]),
  queryFn: () => telemetryQueries.getRunUsage(queryFilters.value),
});
const optionQuery = useQuery({ queryKey: ["workflow-filter-options"], queryFn: () => telemetryQueries.getWorkflowSummary({}) });
const summary = computed(() => summaryQuery.data.value ?? {});
const usage = computed(() => usageQuery.data.value ?? {});
const days = computed(() => Object.keys(summary.value.by_day ?? {}).sort());
const people = computed<any[]>(() => summary.value.people?.items ?? []);
const activeDepartments = computed(() => Object.keys(summary.value.by_proposer_dept ?? {}).filter((name) => name !== "unknown"));
const departmentRows = computed(() => activeDepartments.value.map((name) => ({
  name,
  runs: Number(summary.value.by_proposer_dept?.[name] ?? 0),
  people: people.value.filter((person) => person.proposer_dept === name),
})).map((item) => ({ ...item, userCount: item.people.length })).sort((a, b) => b.runs - a.runs));
const identityCoverage = computed(() => summary.value.people?.coverage);
const adoptionTrend = computed(() => ({
  tooltip: { trigger: "axis" }, legend: { top: 0 },
  grid: { left: 44, right: 18, top: 48, bottom: 30 },
  xAxis: { type: "category", data: days.value }, yAxis: { type: "value", minInterval: 1 },
  series: [
    { name: "已识别人员", type: "bar", stack: "users", barMaxWidth: 34, itemStyle: { color: "#2f8f78" }, data: days.value.map((day) => summary.value.by_day[day].unique_people ?? 0) },
    { name: "匿名终端", type: "bar", stack: "users", barMaxWidth: 34, itemStyle: { color: "#e7a33e" }, data: days.value.map((day) => summary.value.by_day[day].anonymous_terminals ?? 0) },
  ],
}));
const agentVersionRows = computed(() => Object.entries(usage.value.runs?.byAgentVersion ?? {}).map(([key, runs]) => {
  const separator = key.lastIndexOf("@");
  return { agent: separator < 0 ? key : key.slice(0, separator), version: separator < 0 ? "未上报版本" : key.slice(separator + 1), runs: Number(runs) };
}).sort((a, b) => b.runs - a.runs));
const cospecVersionRows = computed(() => Object.entries(usage.value.runs?.byCospecPluginVersion ?? {}).map(([version, runs]) => ({
  version: version === "<missing>" ? "未上报版本" : version, runs: Number(runs),
})).sort((a, b) => b.runs - a.runs));
const osName: Record<string, string> = { linux: "Linux", win32: "Windows", darwin: "macOS", "<missing>": "未上报" };
const operatingSystemRows = computed(() => Object.entries(usage.value.runs?.byOperatingSystem ?? {}).map(([platform, runs]) => ({
  platform: osName[platform] ?? platform, runs: Number(runs),
})).sort((a, b) => b.runs - a.runs));

function syncRoute() {
  void router.replace({ query: {
    period: timePreset.value, from: filters.from, to: filters.to,
    ...(filters.proposerDept ? { proposerDept: filters.proposerDept } : {}),
  }});
}
function reset() {
  filters.proposerDept = "";
  timePreset.value = "week";
  const range = presetRange("week")!;
  filters.from = range[0].toISOString(); filters.to = range[1].toISOString();
  timeDates.value = [filters.from, filters.to]; syncRoute();
}
function openDepartment(row: any) { selectedDepartment.value = row; }
function openRuns(extra: Record<string, string>) {
  void router.push({ path: "/workflows", query: { from: filters.from, to: filters.to, period: timePreset.value, ...extra } });
}
watch(timePreset, (value) => {
  const range = presetRange(value); if (!range) return;
  filters.from = range[0].toISOString(); filters.to = range[1].toISOString();
  timeDates.value = [filters.from, filters.to]; syncRoute();
});
watch(timeDates, (value) => {
  if (value.length !== 2 || timePreset.value !== "custom") return;
  [filters.from, filters.to] = value; syncRoute();
}, { deep: true });
watch(() => filters.proposerDept, syncRoute);
</script>

<template>
  <div>
    <header class="page-head">
      <div><h1>推广使用</h1><p>了解 Cospec 的人员覆盖、产线推广和版本使用情况</p></div>
      <RefreshButton :loading="summaryQuery.isFetching.value || usageQuery.isFetching.value" @click="summaryQuery.refetch(); usageQuery.refetch()" />
    </header>
    <section class="panel global-filters">
      <TimeRangeFilter v-model:preset="timePreset" v-model:dates="timeDates" />
      <el-select v-model="filters.proposerDept" filterable clearable placeholder="全部产线" style="width:240px">
        <el-option v-for="department in optionQuery.data.value?.filter_options?.proposer_depts ?? []" :key="department" :label="department" :value="department" />
      </el-select>
      <el-button text @click="reset">重置</el-button>
    </section>
    <el-alert v-if="summaryQuery.isError.value || usageQuery.isError.value" :title="errorText(summaryQuery.error.value || usageQuery.error.value)" type="error" show-icon style="margin-bottom:16px" />
    <section class="adoption-summary">
      <article class="adoption-card primary"><label>活跃用户（估算） <el-tooltip content="已识别人员与尚未关联人员的匿名终端去重相加。"><el-icon class="info-tip"><InfoFilled /></el-icon></el-tooltip></label><strong>{{ count(summary.active_users?.estimated) }}</strong><small>已识别 {{ count(summary.active_users?.identified_people) }} · 匿名终端 {{ count(summary.active_users?.anonymous_terminals) }}</small></article>
      <article class="adoption-card"><label>覆盖产线</label><strong>{{ count(activeDepartments.length) }}</strong><small>仅统计已取得产线信息的用户</small></article>
      <article class="adoption-card"><label>身份信息覆盖</label><strong>{{ percent(identityCoverage) }}</strong><small>{{ count(summary.people?.identified_runs) }} 个工作流已关联人员</small></article>
    </section>
    <section class="panel trend-panel">
      <div class="section-head"><div><h2>活跃用户趋势</h2><p>按天查看已识别人员和匿名终端</p></div></div>
      <EChart v-if="days.length" :option="adoptionTrend" />
      <div v-else class="empty">当前范围暂无活跃用户数据</div>
    </section>
    <section class="content-grid">
      <div class="panel">
        <div class="section-head"><div><h2>产线覆盖</h2><p>点击产线查看使用人员</p></div></div>
        <el-table :data="departmentRows" v-loading="summaryQuery.isLoading.value" row-class-name="clickable" @row-click="openDepartment">
          <el-table-column prop="name" label="产线" min-width="220" />
          <el-table-column prop="userCount" label="使用人员" width="100" />
          <el-table-column prop="runs" label="工作流" width="90" />
        </el-table>
        <div v-if="!summaryQuery.isLoading.value && !departmentRows.length" class="empty compact">当前范围暂无已识别产线</div>
        <div v-if="summary.active_users?.anonymous_terminals" class="anonymous-note"><span>尚未关联人员的终端</span><strong>{{ count(summary.active_users.anonymous_terminals) }}</strong></div>
      </div>
      <div class="panel">
        <div class="section-head"><div><h2>Agent 使用情况</h2><p>实际运行工作流的客户端及版本</p></div></div>
        <el-table :data="agentVersionRows" v-loading="usageQuery.isLoading.value">
          <el-table-column prop="agent" label="Agent" min-width="110" />
          <el-table-column prop="version" label="版本" min-width="100" />
          <el-table-column prop="runs" label="工作流" width="90" />
        </el-table>
        <div v-if="!usageQuery.isLoading.value && !agentVersionRows.length" class="empty compact">当前范围暂无 Agent 数据</div>
      </div>
      <div class="panel">
        <div class="section-head"><div><h2>操作系统分布</h2><p>工作流实际运行所在的操作系统</p></div></div>
        <el-table :data="operatingSystemRows" v-loading="usageQuery.isLoading.value">
          <el-table-column prop="platform" label="操作系统" min-width="130" />
          <el-table-column prop="runs" label="工作流" width="90" />
        </el-table>
        <div v-if="!usageQuery.isLoading.value && !operatingSystemRows.length" class="empty compact">当前范围暂无操作系统数据</div>
      </div>
      <div class="panel">
        <div class="section-head"><div><h2>Cospec 版本使用情况</h2><p>实际运行工作流的 Cospec 版本</p></div></div>
        <el-table :data="cospecVersionRows" v-loading="usageQuery.isLoading.value">
          <el-table-column prop="version" label="版本" min-width="130" />
          <el-table-column prop="runs" label="工作流" width="90" />
        </el-table>
        <div v-if="!usageQuery.isLoading.value && !cospecVersionRows.length" class="empty compact">当前范围暂无 Cospec 版本数据</div>
      </div>
    </section>
    <el-drawer :model-value="Boolean(selectedDepartment)" :title="selectedDepartment?.name" size="560px" @close="selectedDepartment = null">
      <template v-if="selectedDepartment">
        <div class="drawer-overview"><div><label>使用人员</label><strong>{{ count(selectedDepartment.userCount) }}</strong></div><div><label>工作流</label><strong>{{ count(selectedDepartment.runs) }}</strong></div></div>
        <h3>使用人员</h3>
        <el-table :data="selectedDepartment.people">
          <el-table-column prop="display_name" label="姓名" min-width="180" />
          <el-table-column prop="runs" label="工作流" width="90" />
          <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="primary" @click="openRuns({ employeeId: row.employee_id })">查看</el-button></template></el-table-column>
        </el-table>
        <div v-if="!selectedDepartment.people.length" class="empty compact">暂无已识别人员</div>
        <div class="drawer-action"><el-button type="primary" @click="openRuns({ proposerDept: selectedDepartment.name })">查看该产线工作流</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.global-filters{display:flex;gap:12px;align-items:center;margin-bottom:18px}.adoption-summary{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:16px;margin-bottom:18px}.adoption-card{background:#fff;border:1px solid #e1e9e9;border-radius:13px;padding:21px;box-shadow:0 2px 12px rgba(16,42,45,.035)}.adoption-card.primary{background:linear-gradient(140deg,#173f41,#26635d);color:#fff;border:0}.adoption-card label{font-size:13px;color:#718087}.adoption-card.primary label,.adoption-card.primary small{color:#c4ddda}.adoption-card strong{display:block;font-size:30px;margin:10px 0 5px}.adoption-card small{color:#8a979e}.info-tip{margin-left:3px;cursor:help;vertical-align:-2px}.trend-panel{margin-bottom:18px}.trend-panel :deep(.chart){height:280px}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.section-head h2{font-size:18px;margin:0 0 5px}.section-head p{font-size:13px;color:#7b8991;margin:0}.content-grid{display:grid;grid-template-columns:1.2fr .9fr .75fr;gap:18px}.anonymous-note{display:flex;justify-content:space-between;align-items:center;background:#fff7e8;color:#8a5a14;border-radius:9px;padding:13px 15px;margin-top:14px}.anonymous-note strong{font-size:19px}.compact{padding:32px}.drawer-overview{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:22px}.drawer-overview div{background:#f4f8f7;border-radius:10px;padding:16px}.drawer-overview label{display:block;color:#7b8991;font-size:12px;margin-bottom:7px}.drawer-overview strong{font-size:24px}.drawer-action{text-align:right;margin-top:18px}@media(max-width:1300px){.content-grid{grid-template-columns:1fr 1fr}.content-grid>.panel:first-child{grid-column:span 2}}@media(max-width:1200px){.adoption-summary{grid-template-columns:1fr 1fr}.adoption-card.primary{grid-column:span 2}}
</style>
