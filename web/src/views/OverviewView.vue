<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import EChart from "../components/EChart.vue";
import { telemetryQueries } from "../api";
import { count, duration, errorText, percent } from "../format";
import { presetRange, type DatePreset } from "../date-range";

const filters = reactive({ dates: [] as string[], agentType: "", agentVersion: "", model: "" });
const rangePreset = ref<DatePreset>("week");
const effectiveRange = computed(() => {
  const preset = presetRange(rangePreset.value);
  if (preset) return { from: preset[0].toISOString(), to: preset[1].toISOString() };
  return {
    from: filters.dates[0] ? new Date(`${filters.dates[0]}T00:00:00`).toISOString() : "",
    to: filters.dates[1] ? new Date(`${filters.dates[1]}T23:59:59.999`).toISOString() : "",
  };
});
const queryFilters = computed(() => Object.fromEntries(Object.entries({
  from: effectiveRange.value.from, to: effectiveRange.value.to,
  agentType: filters.agentType, agentVersion: filters.agentVersion, model: filters.model,
}).filter(([, value]) => value)) as Record<string, string>);
const query = useQuery({ queryKey: computed(() => ["run-usage", queryFilters.value]), queryFn: () => telemetryQueries.getRunUsage(queryFilters.value), placeholderData: (old) => old });
const data = computed(() => query.data.value ?? {});
const agentOption = computed(() => ({ tooltip: { trigger: "item" }, legend: { bottom: 0 }, series: [{ type: "pie", radius: ["46%", "72%"], itemStyle: { borderRadius: 5, borderColor: "#fff", borderWidth: 3 }, label: { show: false }, data: Object.entries(data.value.runs?.byAgent ?? {}).map(([name, value]) => ({ name, value })) }] }));
const trendOption = computed(() => { const entries = Object.entries(data.value.runs?.byDay ?? {}); return { tooltip: { trigger: "axis" }, grid: { left: 44, right: 18, top: 20, bottom: 38 }, xAxis: { type: "category", data: entries.map(([day]) => day) }, yAxis: { type: "value", minInterval: 1 }, series: [{ type: "bar", barMaxWidth: 34, itemStyle: { color: "#268f7d", borderRadius: [5, 5, 0, 0] }, data: entries.map(([, value]) => value) }] }; });
function reset() { rangePreset.value = "week"; filters.dates = []; filters.agentType = ""; filters.agentVersion = ""; filters.model = ""; }
</script>
<template><div><header class="page-head"><div><h1>运营总览</h1><p>查看 Cospec 工作流的使用规模和资源分布</p></div><div class="refresh"><span class="muted">更新于 {{ query.dataUpdatedAt.value ? new Date(query.dataUpdatedAt.value).toLocaleTimeString('zh-CN', {hour12:false}) : '—' }}</span><el-button :loading="query.isFetching.value" @click="query.refetch()">刷新数据</el-button></div></header>
  <section class="panel filters"><el-select v-model="rangePreset" aria-label="时间范围" style="width:135px"><el-option label="今天" value="today"/><el-option label="本周" value="week"/><el-option label="本月" value="month"/><el-option label="最近 7 天" value="last7"/><el-option label="最近 30 天" value="last30"/><el-option label="最近 90 天" value="last90"/><el-option label="自定义" value="custom"/></el-select><el-date-picker v-if="rangePreset === 'custom'" v-model="filters.dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" /><el-select v-model="filters.agentType" clearable placeholder="Agent 类型" style="width:150px"><el-option label="Codex" value="codex"/><el-option label="Claude Code" value="claude_code"/></el-select><el-input v-model="filters.agentVersion" clearable placeholder="精确 Agent 版本" style="width:175px"/><el-input v-model="filters.model" clearable placeholder="精确模型名称" style="width:190px"/><el-button text @click="reset">重置</el-button></section>
  <el-alert v-if="query.isError.value" :title="errorText(query.error.value)" type="error" show-icon class="mb" />
  <div class="metric-grid"><section class="panel metric"><label>活跃匿名终端</label><strong>{{ count(data.terminals?.active_anonymous_terminals) }}</strong><small>Run 覆盖 {{ percent(data.terminals?.run_coverage) }}</small></section><section class="panel metric"><label>Run 数量</label><strong>{{ count(data.runs?.total) }}</strong><small>{{ count(data.runs?.with_parser_facts) }} 个已有解析事实</small></section><section class="panel metric"><label>输入 Token</label><strong>{{ count(data.tokens?.input_tokens) }}</strong><small>覆盖 {{ percent(data.tokens?.field_run_coverage?.input_tokens?.run_coverage) }}</small></section><section class="panel metric"><label>输出 Token</label><strong>{{ count(data.tokens?.output_tokens) }}</strong><small>覆盖 {{ percent(data.tokens?.field_run_coverage?.output_tokens?.run_coverage) }}</small></section><section class="panel metric"><label>使用子代理的 Run</label><strong>{{ count(data.subagents?.runs_with_subagents) }}</strong><small>使用比例 {{ percent(data.subagents?.usage_rate) }}</small></section></div>
  <div class="grid-2"><section class="panel"><h2 class="section-title">Agent 分布</h2><EChart v-if="data.runs?.total" :option="agentOption"/><div v-else class="empty">暂无 Run 数据</div></section><section class="panel"><h2 class="section-title">每日 Run 趋势</h2><EChart v-if="Object.keys(data.runs?.byDay ?? {}).length" :option="trendOption"/><div v-else class="empty">暂无趋势数据</div></section></div>
  <section class="panel"><h2 class="section-title">单次 Run 资源分布</h2><div class="facts-grid"><div class="fact"><label>Run 时间跨度 P50</label><strong>{{ duration(data.resourceDistribution?.overall?.run_span_ms?.p50) }}</strong></div><div class="fact"><label>Run 时间跨度 P90</label><strong>{{ duration(data.resourceDistribution?.overall?.run_span_ms?.p90) }}</strong></div><div class="fact"><label>消息数 P50</label><strong>{{ count(data.resourceDistribution?.overall?.messages_per_run?.p50) }}</strong></div><div class="fact"><label>输入 Token P50</label><strong>{{ count(data.resourceDistribution?.overall?.input_tokens_per_run?.p50) }}</strong></div><div class="fact"><label>工具调用 P50</label><strong>{{ count(data.resourceDistribution?.overall?.tool_calls_per_run?.p50) }}</strong></div><div class="fact"><label>工具经过时间 P90</label><strong>{{ duration(data.resourceDistribution?.overall?.tool_wall_clock_ms_per_run?.p90) }}</strong></div></div><p class="muted">P50 表示约一半 Run 不超过该数值；P90 表示约九成 Run 不超过该数值。Run 时间跨度包含用户停顿。</p></section>
</div></template>
<style scoped>.mb{margin-bottom:16px}.refresh{display:flex;align-items:center;gap:12px;font-size:12px}</style>
