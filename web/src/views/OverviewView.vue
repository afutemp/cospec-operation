<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRouter } from "vue-router";
import EChart from "../components/EChart.vue";
import TimeRangeFilter from "../components/TimeRangeFilter.vue";
import RefreshButton from "../components/RefreshButton.vue";
import { telemetryQueries } from "../api";
import { count, percent } from "../format";
import { presetRange, type DatePreset } from "../date-range";

const router = useRouter();
const preset = ref<DatePreset>("week");
const filters = reactive({ dates: [] as string[], proposerDept: "" });
const range = computed(() => {
  const value = presetRange(preset.value);
  if (value)
    return { from: value[0].toISOString(), to: value[1].toISOString() };
  return {
    from: filters.dates[0] ? new Date(filters.dates[0]).toISOString() : "",
    to: filters.dates[1] ? new Date(filters.dates[1]).toISOString() : "",
  };
});
const queryFilters = computed(
  () =>
    Object.fromEntries(
      Object.entries({
        ...range.value,
        proposerDept: filters.proposerDept,
      }).filter(([, v]) => v),
    ) as Record<string, string>,
);
const previous = computed(() => {
  const from = Date.parse(range.value.from),
    to = Date.parse(range.value.to),
    span = to - from;
  return Number.isFinite(span)
    ? {
        from: new Date(from - span).toISOString(),
        to: new Date(from - 1).toISOString(),
        ...(filters.proposerDept ? { proposerDept: filters.proposerDept } : {}),
      }
    : {};
});
const workflowQuery = useQuery({
  queryKey: computed(() => ["overview", queryFilters.value]),
  queryFn: () => telemetryQueries.getWorkflowSummary(queryFilters.value),
});
const previousWorkflow = useQuery({
  queryKey: computed(() => ["overview-previous", previous.value]),
  queryFn: () => telemetryQueries.getWorkflowSummary(previous.value),
});
const data = computed(() => workflowQuery.data.value ?? {}),
  prior = computed(() => previousWorkflow.data.value ?? {});
const days = computed(() => Object.keys(data.value.by_day ?? {}));
const activeDepartmentCount = computed(
  () =>
    Object.keys(data.value.by_proposer_dept ?? {}).filter(
      (name) => name !== "unknown",
    ).length,
);
const departmentRows = computed(() =>
  Object.entries(data.value.by_proposer_dept ?? {})
    .filter(([name]) => name !== "unknown")
    .map(([name, runs]) => ({ name, runs: Number(runs) }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 4),
);
const userTrend = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: {
    top: 0,
    data: ["活跃用户（估算）", "已识别人员", "匿名终端"],
  },
  grid: { left: 46, right: 20, top: 52, bottom: 34 },
  xAxis: { type: "category", data: days.value },
  yAxis: { type: "value", minInterval: 1 },
  series: [
    {
      name: "活跃用户（估算）",
      type: "line",
      smooth: true,
      data: days.value.map((d) => data.value.by_day[d].estimated_active_users),
      itemStyle: { color: "#6558d3" },
      lineStyle: { width: 3 },
    },
    {
      name: "已识别人员",
      type: "line",
      smooth: true,
      data: days.value.map((d) => data.value.by_day[d].unique_people),
      itemStyle: { color: "#2f8f78" },
      lineStyle: { width: 2, type: "dashed" },
    },
    {
      name: "匿名终端",
      type: "line",
      smooth: true,
      data: days.value.map((d) => data.value.by_day[d].anonymous_terminals),
      itemStyle: { color: "#e69b3a" },
      lineStyle: { width: 2, type: "dashed" },
    },
  ],
}));
const workflowTrend = computed(() => ({
  tooltip: {
    trigger: "axis",
    formatter: (parameters: any[]) => {
      const rows = Array.isArray(parameters) ? parameters : [];
      const total = rows.reduce(
        (sum, item) => sum + Number(item.value ?? 0),
        0,
      );
      return [
        `<strong>${rows[0]?.axisValue ?? ""}</strong>`,
        ...rows.map(
          (item) => `${item.marker}${item.seriesName}：${item.value}`,
        ),
        `<strong>总计：${total}</strong>`,
      ].join("<br>");
    },
  },
  legend: { top: 0 },
  grid: { left: 46, right: 20, top: 52, bottom: 34 },
  xAxis: { type: "category", data: days.value },
  yAxis: { type: "value", minInterval: 1 },
  series: [
    ["large", "大需求", "#287f70"],
    ["small", "小需求", "#6558d3"],
    ["custom", "自定义", "#e7a33e"],
    ["unknown", "未标记", "#9aa6ad"],
  ].map(([key, name, color]) => ({
    name,
    type: "bar",
    stack: "workflow-kind",
    barMaxWidth: 32,
    data: days.value.map((d) => data.value.by_day[d].by_kind[key] ?? 0),
    itemStyle: { color },
  })),
}));
function delta(now: unknown, before: unknown) {
  const a = Number(now ?? 0),
    b = Number(before ?? 0);
  const difference = a - b;
  if (!b) return a ? `较上期新增 ${a}` : "本期、上期均为 0";
  if (!difference) return "与上期持平（0）";
  const percentage = (difference / b) * 100;
  return `较上期 ${percentage > 0 ? "+" : ""}${percentage.toFixed(0)}%（${difference > 0 ? "+" : ""}${difference}）`;
}
function go(path: string, extra: Record<string, string> = {}) {
  void router.push({
    path,
    query: { ...queryFilters.value, period: preset.value, ...extra },
  });
}
function chartDrill(event: any) {
  const day = String(event?.name ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  go("/workflows", {
    period: "custom",
    from: new Date(`${day}T00:00:00`).toISOString(),
    to: new Date(`${day}T23:59:59.999`).toISOString(),
  });
}
const rangeLabel = computed(
  () =>
    `${new Date(range.value.from).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} — ${new Date(range.value.to).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
);
</script>
<template>
  <div class="overview">
    <header class="page-head">
      <div>
        <p class="eyebrow">COSPEC OPERATIONS</p>
        <h1>运营概览</h1>
        <p>推广规模、工作流运行与交付进展</p>
      </div>
      <div class="head-actions">
        <span>{{ rangeLabel }}</span
        ><RefreshButton
          :loading="workflowQuery.isFetching.value"
          @click="workflowQuery.refetch()"
        />
      </div>
    </header>
    <section class="toolbar">
      <TimeRangeFilter v-model:preset="preset" v-model:dates="filters.dates" />
      <el-select
        v-model="filters.proposerDept"
        filterable
        clearable
        placeholder="全部产线"
        style="width: 240px"
        ><el-option
          v-for="dept in data.filter_options?.proposer_depts ?? []"
          :key="dept"
          :label="dept"
          :value="dept"
      /></el-select>
    </section>
    <section class="hero-grid">
      <article class="hero teal" @click="go('/workflows')">
        <div class="hero-summary">
          <div class="hero-heading">
            <div class="hero-icon">
              <el-icon><UserFilled /></el-icon>
            </div>
            <label class="help-title"
              >活跃用户（估算）<el-tooltip
                content="能确认身份的用户按工号计算；暂时无法确认身份的用户按电脑计算，因此人数是估算值。"
                placement="top"
                ><el-icon class="metric-help" @click.stop
                  ><InfoFilled /></el-icon></el-tooltip
            ></label>
          </div>
          <div class="hero-value">
            <strong>{{ count(data.active_users?.estimated) }}</strong
            ><small>{{
              delta(data.active_users?.estimated, prior.active_users?.estimated)
            }}</small>
          </div>
        </div>
        <div class="hero-details">
          <span
            >已识别<strong
              >{{ count(data.active_users?.identified_people ?? 0) }} 人</strong
            ></span
          >
          <span
            >匿名终端<strong
              >{{
                count(data.active_users?.anonymous_terminals ?? 0)
              }}
              台</strong
            ></span
          >
          <span
            >覆盖产线<strong
              >{{ count(activeDepartmentCount) }} 条</strong
            ></span
          >
        </div>
      </article>
      <article class="hero violet" @click="go('/workflows')">
        <div class="hero-summary">
          <div class="hero-heading">
            <div class="hero-icon">
              <el-icon><Promotion /></el-icon>
            </div>
            <label class="help-title"
              >启动工作流<el-tooltip
                content="每启动一个工作流计一次，重复上报不会重复计算。工作流类型以用户启动时的选择为准。"
                placement="top"
                ><el-icon class="metric-help" @click.stop
                  ><InfoFilled /></el-icon></el-tooltip
            ></label>
          </div>
          <div class="hero-value">
            <strong>{{ count(data.total) }}</strong
            ><small>{{ delta(data.total, prior.total) }}</small>
          </div>
        </div>
        <div class="hero-details workflow-details">
          <span
            >类型<strong
              >大 {{ data.by_kind?.large ?? 0 }} · 小
              {{ data.by_kind?.small ?? 0 }} · 自定义
              {{ data.by_kind?.custom ?? 0 }}</strong
            ></span
          >
          <span
            >运行结果<strong
              >完成 {{ count(data.by_status?.completed ?? 0) }} · 中断
              {{ count(data.by_status?.interrupted ?? 0) }}</strong
            ></span
          >
          <span
            >有产出<strong
              >{{ count(data.artifacts?.runs_with_artifacts ?? 0) }} 个</strong
            ></span
          >
        </div>
      </article>
    </section>
    <section class="chart-grid">
      <article class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2 class="help-title">
              活跃用户趋势<el-tooltip
                content="按日期展示当天启动过工作流的活跃用户估算值，并拆分已识别人员和匿名终端。"
                placement="top"
                ><el-icon class="metric-help"><InfoFilled /></el-icon
              ></el-tooltip>
            </h2>
            <p>估算总数及已识别、匿名构成</p>
          </div>
        </div>
        <EChart
          v-if="days.length"
          :option="userTrend"
          @chart-click="chartDrill"
        />
        <div v-else class="empty">当前范围暂无趋势数据</div>
      </article>
      <article class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2 class="help-title">
              工作流启动趋势<el-tooltip
                content="每天一根柱子，整根柱子的高度是当天启动总数，不同颜色表示工作流类型。"
                placement="top"
                ><el-icon class="metric-help"><InfoFilled /></el-icon
              ></el-tooltip>
            </h2>
            <p>每天的启动总数及类型分布</p>
          </div>
        </div>
        <EChart
          v-if="days.length"
          :option="workflowTrend"
          @chart-click="chartDrill"
        />
        <div v-else class="empty">当前范围暂无趋势数据</div>
      </article>
    </section>
    <section class="lower-grid">
      <article class="panel coverage">
        <div class="section-head">
          <div>
            <h2 class="help-title">
              推广覆盖<el-tooltip
                content="产线根据工作流关联的人员信息自动获取；暂时无法确认产线的工作流，不计入覆盖产线数量。"
                placement="top"
                ><el-icon class="metric-help"><InfoFilled /></el-icon
              ></el-tooltip>
            </h2>
            <p>本期活跃产线及工作流分布</p>
          </div>
          <button
            class="icon-button"
            aria-label="查看工作流明细"
            @click="go('/workflows')"
          >
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="coverage-number">
          {{ count(departmentRows.length) }}<span>条活跃产线</span>
        </div>
        <div v-if="departmentRows.length" class="department-list">
          <div
            v-for="dept in departmentRows"
            :key="dept.name"
            class="department-row"
          >
            <div>
              <span>{{ dept.name }}</span
              ><strong>{{ dept.runs }}</strong>
            </div>
            <div class="track">
              <i
                :style="{
                  width: `${data.total ? (dept.runs / data.total) * 100 : 0}%`,
                }"
              ></i>
            </div>
          </div>
        </div>
        <div v-else class="empty compact-empty">当前范围没有已识别产线</div>
      </article>
    </section>
  </div>
</template>
<script lang="ts">
import {
  ArrowRight,
  CircleCheckFilled,
  FolderChecked,
  InfoFilled,
  Promotion,
  UserFilled,
} from "@element-plus/icons-vue";
export default {
  components: {
    ArrowRight,
    CircleCheckFilled,
    FolderChecked,
    InfoFilled,
    Promotion,
    UserFilled,
  },
};
</script>
<style scoped>
.overview {
  max-width: 1560px;
  margin: auto;
}
.eyebrow {
  font-size: 11px !important;
  font-weight: 800;
  letter-spacing: 1.8px;
  color: #2f8f78 !important;
  margin-bottom: 8px !important;
}
.page-head h1 {
  font-size: 30px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #849099;
  font-size: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #e7ebee;
  border-radius: 14px;
  padding: 12px 14px;
  margin-bottom: 18px;
  box-shadow: 0 4px 18px #16343a08;
}
.help-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.metric-help {
  cursor: help;
  opacity: 0.72;
  font-size: 14px;
}
.hero-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
  margin-bottom: 18px;
}
.hero {
  position: relative;
  min-height: 112px;
  border-radius: 16px;
  padding: 16px 20px;
  color: #fff;
  overflow: hidden;
  cursor: pointer;
  transition: 0.2s;
  box-shadow: 0 10px 26px #173c4020;
}
.hero:hover {
  transform: translateY(-3px);
  box-shadow: 0 15px 30px #173c4030;
}
.hero.teal {
  background: linear-gradient(145deg, #12564e, #238a76);
}
.hero.violet {
  background: linear-gradient(145deg, #4d429e, #7668df);
}
.hero.green {
  background: linear-gradient(145deg, #176044, #35a779);
}
.hero.amber {
  background: linear-gradient(145deg, #9a5a17, #e19a35);
}
.hero.blue {
  background: linear-gradient(145deg, #26547e, #4388b7);
}
.hero-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: #ffffff22;
  display: grid;
  place-items: center;
  font-size: 16px;
}
.hero-summary {
  min-width: 175px;
}
.hero-heading {
  display: flex;
  align-items: center;
  gap: 9px;
}
.hero-value {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-top: 8px;
}
.hero label {
  font-size: 13px;
  opacity: 0.83;
}
.hero strong {
  font-size: 32px;
  line-height: 1.2;
}
.hero small {
  font-size: 11px;
  opacity: 0.72;
}
.hero-details {
  position: absolute;
  inset: 16px 20px 16px 48%;
  display: grid;
  align-content: center;
  gap: 8px;
  border-left: 1px solid #ffffff2d;
  padding-left: 22px;
  pointer-events: none;
}
.hero-details span {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  opacity: 0.72;
}
.hero-details strong {
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  opacity: 1;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 18px;
  margin-bottom: 18px;
}
.chart-panel {
  min-height: 390px;
}
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.section-head h2 {
  font-size: 17px;
  margin: 0 0 5px;
}
.section-head p {
  font-size: 12px;
  color: #8a969e;
  margin: 0;
}
.chart-panel .chart {
  height: 310px;
  margin-top: 8px;
}
.lower-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}
.icon-button {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid #e5eaed;
  background: #fafcfc;
  color: #577078;
  display: inline-grid;
  place-items: center;
  padding: 0;
  line-height: 1;
  font-size: 15px;
  cursor: pointer;
}
.icon-button .el-icon {
  margin: 0;
}
.track {
  height: 7px;
  background: #eef1f3;
  border-radius: 8px;
  flex: 1;
  overflow: hidden;
}
.track i {
  display: block;
  height: 100%;
  border-radius: 8px;
}
.coverage-number {
  font-size: 38px;
  font-weight: 750;
  margin: 28px 0;
}
.coverage-number span {
  font-size: 13px;
  color: #829098;
  font-weight: 400;
  margin-left: 7px;
}
.department-list {
  display: grid;
  gap: 17px;
}
.department-row > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  margin-bottom: 7px;
}
.department-row span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #617078;
}
.department-row .track i {
  background: #2f8f78;
}
.compact-empty {
  padding: 35px 0;
}
.coverage-line {
  display: flex;
  justify-content: space-between;
  margin: 17px 0 7px;
  font-size: 13px;
}
.coverage-line span {
  color: #7b8991;
}
@media (max-width: 1300px) {
  .hero-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .lower-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 1050px) {
  .chart-grid {
    grid-template-columns: 1fr;
  }
  .hero-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
