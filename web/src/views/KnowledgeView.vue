<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { telemetryQueries } from "../api";
import EChart from "../components/EChart.vue";
import RefreshButton from "../components/RefreshButton.vue";
import TimeRangeFilter from "../components/TimeRangeFilter.vue";
import { presetRange, type DatePreset } from "../date-range";
import { count, datetime, errorText } from "../format";

const route = useRoute(); const router = useRouter();
const validPresets: DatePreset[] = ["today", "week", "month", "last24h", "last7", "last30", "custom"];
const requested = String(route.query.period ?? "week") as DatePreset;
const preset = ref<DatePreset>(validPresets.includes(requested) ? requested : "week");
const initial = presetRange(preset.value) ?? [new Date(String(route.query.from)), new Date(String(route.query.to))];
const dates = ref(initial.map((value) => value.toISOString()));
const filters = computed(() => ({ from: dates.value[0]!, to: dates.value[1]! }));
const query = useQuery({ queryKey: computed(() => ["knowledge-summary", filters.value]), queryFn: () => telemetryQueries.getKnowledgeSummary(filters.value) });
const summary = computed(() => query.data.value ?? {});
const answerLabels: Record<string,string> = { answerable: "可回答", partially_answerable: "部分可回答", unanswerable: "无法回答", conflicted: "知识冲突", unknown: "未记录" };
const statusLabels: Record<string,string> = { completed: "正常完成", degraded: "降级完成", failed: "失败", incomplete: "记录不完整" };
const answerability = computed(() => Object.entries(summary.value.by_answerability ?? {}).map(([name, value]) => ({ name: answerLabels[name] ?? name, value })));
const answerChart = computed(() => ({ tooltip: { trigger: "item" }, legend: { bottom: 0 }, series: [{ type: "pie", radius: ["48%", "72%"], center: ["50%", "44%"], label: { formatter: "{b}  {c}" }, data: answerability.value }] }));
const kbRows = computed(() => Object.entries(summary.value.by_kb ?? {}).map(([name, queries]) => ({ name, queries, versions: [...new Set((summary.value.items ?? []).filter((item:any) => item.kb_name === name).map((item:any) => item.kb_version).filter(Boolean))].join("、") || "未记录" })).sort((a:any,b:any) => Number(b.queries)-Number(a.queries)));
const items = computed(() => [...(summary.value.items ?? [])].reverse());
function sync() { void router.replace({ query: { period: preset.value, from: dates.value[0], to: dates.value[1] } }); }
watch(preset, (value) => { const range = presetRange(value); if (range) { dates.value = range.map((item) => item.toISOString()); sync(); } });
watch(dates, () => { if (preset.value === "custom") sync(); }, { deep: true });
</script>

<template><div>
  <header class="page-head"><div><h1>知识库分析</h1><p>了解知识库在产品规划中的实际使用和回答情况</p></div><RefreshButton :loading="query.isFetching.value" @click="query.refetch()" /></header>
  <section class="panel kb-filters"><TimeRangeFilter v-model:preset="preset" v-model:dates="dates" /></section>
  <el-alert v-if="query.isError.value" :title="errorText(query.error.value)" type="error" show-icon style="margin-bottom:16px" />
  <section class="kb-cards">
    <article><label>知识查询</label><strong>{{ count(summary.total) }}</strong><small>发生在 {{ count(summary.runs) }} 个工作流</small></article>
    <article><label>知识命中</label><strong>{{ count(summary.hits) }}</strong><small>查询实际找到的知识片段</small></article>
    <article><label>实际引用</label><strong>{{ count(summary.citations) }}</strong><small>最终回答引用的知识依据</small></article>
    <article><label>查询告警</label><strong>{{ count(summary.warnings) }}</strong><small>无命中、来源缺失或越界等问题</small></article>
  </section>
  <section class="kb-grid">
    <div class="panel"><div class="section-head"><div><h2>查询结果</h2><p>这些查询最终能否从知识库得到所需信息</p></div></div><EChart v-if="answerability.length" :option="answerChart" /><div v-else class="empty">当前范围暂无知识查询</div></div>
    <div class="panel"><div class="section-head"><div><h2>使用的知识库</h2><p>查询发生时固定记录知识库及其版本</p></div></div><el-table :data="kbRows"><el-table-column prop="name" label="知识库" min-width="170"/><el-table-column prop="versions" label="发布版本" min-width="130"/><el-table-column prop="queries" label="查询" width="80"/></el-table><div v-if="!kbRows.length" class="empty compact">暂无数据</div></div>
  </section>
  <section class="panel"><div class="section-head"><div><h2>最近查询</h2><p>不采集问题和答案正文，只保留运营统计</p></div></div><el-table :data="items" v-loading="query.isLoading.value"><el-table-column label="时间" width="175"><template #default="{row}">{{ datetime(row.occurred_at) }}</template></el-table-column><el-table-column prop="kb_name" label="知识库" min-width="140"/><el-table-column label="消费位置" min-width="190"><template #default="{row}">{{ row.consumer_skill || (row.query_source === 'user' ? '用户主动查询' : '工作流内查询') }}</template></el-table-column><el-table-column label="执行状态" width="110"><template #default="{row}">{{ statusLabels[row.query_status] || '未记录' }}</template></el-table-column><el-table-column label="回答情况" width="120"><template #default="{row}">{{ answerLabels[row.answerability] || '未记录' }}</template></el-table-column><el-table-column prop="hit_count" label="命中" width="75"/><el-table-column prop="citation_count" label="引用" width="75"/><el-table-column prop="warning_count" label="告警" width="75"/></el-table><div v-if="!items.length && !query.isLoading.value" class="empty compact">当前范围暂无知识查询</div></section>
</div></template>

<style scoped>.kb-filters{margin-bottom:18px}.kb-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:18px}.kb-cards article{background:#fff;border:1px solid #e1e9e9;border-radius:13px;padding:20px}.kb-cards label,.kb-cards small{display:block;color:#74848a}.kb-cards strong{display:block;font-size:30px;margin:9px 0 5px}.kb-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:18px;margin-bottom:18px}.kb-grid :deep(.chart){height:300px}.section-head{margin-bottom:14px}.section-head h2{margin:0 0 5px;font-size:18px}.section-head p{margin:0;color:#7b8991;font-size:13px}.compact{padding:32px}@media(max-width:1100px){.kb-cards{grid-template-columns:1fr 1fr}.kb-grid{grid-template-columns:1fr}}</style>
