<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { telemetryQueries, type RunItem } from "../api";
import EChart from "../components/EChart.vue";
import RunDetailView from "./RunDetailView.vue";
import TimeRangeFilter from "../components/TimeRangeFilter.vue";
import RefreshButton from "../components/RefreshButton.vue";
import { presetRange, type DatePreset } from "../date-range";
import {
  copyText,
  count,
  datetime,
  errorText,
  percent,
  shortId,
} from "../format";
const route = useRoute(),
  router = useRouter(),
  limit = 20;
const keys = [
  "from",
  "to",
  "workflowKind",
  "workflowStatus",
  "agentType",
  "employeeId",
  "proposerDept",
] as const;
const filters = reactive(
  Object.fromEntries(
    keys.map((k) => [k, String(route.query[k] ?? "")]),
  ) as Record<(typeof keys)[number], string>,
);
const initialRange = !filters.from || !filters.to ? presetRange("week") : null;
if (initialRange) {
  filters.from = initialRange[0].toISOString();
  filters.to = initialRange[1].toISOString();
}
const requestedPreset = String(route.query.period ?? "") as DatePreset;
const validPresets: DatePreset[] = [
  "today",
  "week",
  "month",
  "last24h",
  "last7",
  "last30",
  "custom",
];
const timePreset = ref<DatePreset>(
  initialRange
    ? "week"
    : validPresets.includes(requestedPreset)
      ? requestedPreset
      : "custom",
);
const timeDates = ref<string[]>([filters.from, filters.to].filter(Boolean));
const page = ref(Math.max(1, Number(route.query.page) || 1));
const selectedRunId = ref("");
const detailOpen = ref(false);
const queryFilters = computed(
  () =>
    Object.fromEntries(
      keys.map((k) => [k, filters[k]]).filter(([, v]) => v),
    ) as Record<string, string>,
);
const offset = computed(() => (page.value - 1) * limit);
const query = useQuery({
  queryKey: computed(() => ["runs", offset.value, queryFilters.value]),
  queryFn: () =>
    telemetryQueries.listRuns(limit, offset.value, queryFilters.value),
  placeholderData: (old) => old,
});
const summaryFilters = computed(() =>
  Object.fromEntries(
    ["from", "to"]
      .map((key) => [key, filters[key as keyof typeof filters]])
      .filter(([, value]) => value),
  ),
);
const summaryQuery = useQuery({
  queryKey: computed(() => ["workflow-analysis", summaryFilters.value]),
  queryFn: () => telemetryQueries.getWorkflowSummary(summaryFilters.value),
});
const summary = computed(() => summaryQuery.data.value ?? {});
const days = computed(() => Object.keys(summary.value.by_day ?? {}));
const ended = computed(() =>
  ["completed", "failed", "interrupted"].reduce(
    (total, key) => total + Number(summary.value.by_status?.[key] ?? 0),
    0,
  ),
);
const statusTrend = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0 },
  grid: { left: 42, right: 18, top: 48, bottom: 30 },
  xAxis: { type: "category", data: days.value },
  yAxis: { type: "value", minInterval: 1 },
  series: ["completed", "failed", "interrupted", "running"].map(
    (key, index) => ({
      name: statusLabel[key],
      type: "bar",
      stack: "status",
      data: days.value.map(
        (day) => summary.value.by_day[day].by_status[key] ?? 0,
      ),
      itemStyle: { color: ["#35a779", "#df5a63", "#e7a33e", "#78909c"][index] },
    }),
  ),
}));
watch(
  () => route.query,
  (v) => {
    for (const k of keys) filters[k] = String(v[k] ?? "");
    page.value = Math.max(1, Number(v.page) || 1);
  },
);
watch(timePreset, (value) => {
  const range = presetRange(value);
  if (!range) return;
  filters.from = range[0].toISOString();
  filters.to = range[1].toISOString();
  timeDates.value = [filters.from, filters.to];
  apply();
});
watch(
  timeDates,
  (value) => {
    if (timePreset.value !== "custom" || value.length !== 2) return;
    filters.from = value[0];
    filters.to = value[1];
    apply();
  },
  { deep: true },
);
function apply() {
  page.value = 1;
  void router.replace({
    query: { ...queryFilters.value, period: timePreset.value },
  });
}
function reset() {
  for (const k of keys) filters[k] = "";
  apply();
}
function pageChanged(v: number) {
  page.value = v;
  void router.replace({
    query: { ...queryFilters.value, ...(v === 1 ? {} : { page: String(v) }) },
  });
}
async function copy(v: string) {
  await copyText(v);
  ElMessage.success("Run ID 已复制");
}
function open(row: RunItem) {
  selectedRunId.value = row.runId;
  detailOpen.value = true;
}
const kindLabel: Record<string, string> = {
  large: "大需求",
  small: "小需求",
  custom: "自定义",
};
const statusLabel: Record<string, string> = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  interrupted: "中断",
};
</script>
<template>
  <div>
    <header class="page-head">
      <div>
        <h1>工作流分析</h1>
        <p>查看工作流推进、交付情况并下钻到具体运行记录</p>
      </div>
      <RefreshButton
        :loading="query.isFetching.value || summaryQuery.isFetching.value"
        @click="
          query.refetch();
          summaryQuery.refetch();
        "
      />
    </header>
    <section class="panel timebar">
      <TimeRangeFilter v-model:preset="timePreset" v-model:dates="timeDates" />
    </section>
    <section class="summary-grid">
      <article class="summary-card">
        <label>工作流</label><strong>{{ count(summary.total) }}</strong
        ><small
          >大 {{ summary.by_kind?.large ?? 0 }} · 小
          {{ summary.by_kind?.small ?? 0 }} · 自定义
          {{ summary.by_kind?.custom ?? 0 }}</small
        >
      </article>
      <article class="summary-card">
        <label>当前状态</label
        ><strong
          >{{ count(summary.by_status?.running ?? 0) }} <em>进行中</em></strong
        ><small
          >完成 {{ summary.by_status?.completed ?? 0 }} · 失败
          {{ summary.by_status?.failed ?? 0 }} · 中断
          {{ summary.by_status?.interrupted ?? 0 }}</small
        >
      </article>
      <article class="summary-card">
        <label>已结束完成率</label
        ><strong>{{ percent(summary.completion_rate) }}</strong
        ><small
          >完成 {{ summary.by_status?.completed ?? 0 }} / 已结束
          {{ ended }}</small
        >
      </article>
      <article class="summary-card">
        <label>有正式产物</label
        ><strong>{{
          count(summary.artifacts?.runs_with_artifacts ?? 0)
        }}</strong
        ><small>覆盖 {{ percent(summary.artifacts?.run_coverage) }}</small>
      </article>
    </section>
    <section class="panel trend-panel">
      <div class="analysis-head">
        <div>
          <h2>工作流结果趋势</h2>
          <p>按工作流启动日期查看其当前状态；不是当天完成数量</p>
        </div>
      </div>
      <EChart v-if="days.length" :option="statusTrend" />
      <div v-else class="empty">当前范围暂无趋势数据</div>
    </section>
    <section class="panel filters">
      <el-select
        v-model="filters.workflowKind"
        clearable
        placeholder="工作流类型"
        style="width: 145px"
        ><el-option label="大需求" value="large" /><el-option
          label="小需求"
          value="small" /><el-option label="自定义" value="custom" /></el-select
      ><el-select
        v-model="filters.workflowStatus"
        clearable
        placeholder="状态"
        style="width: 130px"
        ><el-option label="进行中" value="running" /><el-option
          label="完成"
          value="completed" /><el-option
          label="失败"
          value="failed" /><el-option
          label="中断"
          value="interrupted" /></el-select
      ><el-select
        v-model="filters.employeeId"
        filterable
        clearable
        placeholder="全部用户"
        style="width: 210px"
        ><el-option
          v-for="person in summary.filter_options?.people ?? []"
          :key="person.employee_id"
          :label="person.display_name"
          :value="person.employee_id"
      /></el-select>
      <el-select
        v-model="filters.proposerDept"
        filterable
        clearable
        placeholder="全部产线"
        style="width: 220px"
        ><el-option
          v-for="department in summary.filter_options?.proposer_depts ?? []"
          :key="department"
          :label="department"
          :value="department"
      /></el-select>
      <el-select
        v-model="filters.agentType"
        clearable
        placeholder="全部 Agent"
        style="width: 145px"
        ><el-option label="Codex" value="codex" /><el-option
          label="Claude Code"
          value="claude_code" /></el-select
      ><el-button type="primary" @click="apply">筛选工作流</el-button
      ><el-button text @click="reset">重置</el-button>
    </section>
    <el-alert
      v-if="query.isError.value"
      :title="errorText(query.error.value)"
      type="error"
      show-icon
      style="margin-bottom: 16px"
    />
    <section class="panel">
      <el-table
        :data="query.data.value?.items ?? []"
        v-loading="query.isLoading.value"
        @row-click="open"
        row-class-name="clickable"
        ><el-table-column label="工作流类型" width="120"
          ><template #default="{ row }"
            ><el-tag v-if="row.workflowKind" effect="plain">{{
              kindLabel[row.workflowKind] ?? row.workflowKind
            }}</el-tag
            ><span v-else>未标记</span></template
          ></el-table-column
        ><el-table-column label="状态" width="100"
          ><template #default="{ row }"
            ><el-tag
              :type="
                row.workflowStatus === 'completed'
                  ? 'success'
                  : row.workflowStatus === 'failed'
                    ? 'danger'
                    : row.workflowStatus === 'interrupted'
                      ? 'warning'
                      : 'info'
              "
              effect="light"
              >{{
              statusLabel[row.workflowStatus] ?? row.workflowStatus
            }}</el-tag></template
          ></el-table-column
        ><el-table-column label="人员 / 产线" min-width="210"
          ><template #default="{ row }"
            ><div>
              {{ row.displayName ?? "身份未知" }}
            </div>
            <small>{{ row.proposerDept ?? "产线未知" }}</small>
            </template
          ></el-table-column
        ><el-table-column label="Agent" width="120"
          ><template #default="{ row }">{{
            row.agentType === "claude_code" ? "Claude Code" : "Codex"
          }}</template></el-table-column
        ><el-table-column label="SKILL" min-width="220"
          ><template #default="{ row }"
            ><span v-if="!row.skills.length" class="muted">未识别到</span
            ><el-tag
              v-for="skill in row.skills.slice(0, 2)"
              :key="skill"
              size="small"
              effect="plain"
              >{{ skill }}</el-tag
            ><span v-if="row.skills.length > 2">
              +{{ row.skills.length - 2 }}</span
            ></template
          ></el-table-column
        ><el-table-column label="交付产物" width="90"
          ><template #default="{ row }"
            >{{ row.artifactCount }}</template
          ></el-table-column
        ><el-table-column label="工具失败" width="90"
          ><template #default="{ row }"
            ><span :class="row.toolFailureCount ? 'danger' : ''">{{
              row.toolFailureCount
            }}</span></template
          ></el-table-column
        ><el-table-column label="最后接收" min-width="170"
          ><template #default="{ row }">{{
            datetime(row.lastReceivedAt)
          }}</template></el-table-column
        ><el-table-column label="运行编号" width="155"
          ><template #default="{ row }"
            ><span class="mono">{{ shortId(row.runId) }}</span
            ><el-button text size="small" @click.stop="copy(row.runId)"
              >复制</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <div
        v-if="!query.isLoading.value && !query.data.value?.items.length"
        class="empty"
      >
        没有符合条件的工作流
      </div>
      <el-pagination
        v-if="query.data.value?.total"
        :current-page="page"
        :page-size="limit"
        :total="query.data.value.total"
        layout="total, prev, pager, next"
        style="margin-top: 18px; justify-content: flex-end"
        @update:current-page="pageChanged"
      />
    </section>
    <el-drawer
      v-model="detailOpen"
      title="工作流详情"
      size="86%"
      destroy-on-close
    >
      <RunDetailView v-if="selectedRunId" :run-id="selectedRunId" embedded />
    </el-drawer>
  </div>
</template>
<style scoped>
.timebar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.timebar > span {
  font-size: 13px;
  color: #66757d;
  font-weight: 600;
  margin-right: 4px;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 16px;
}
.summary-card {
  background: #fff;
  border: 1px solid #e7ebee;
  border-radius: 14px;
  padding: 17px 19px;
  box-shadow: 0 4px 18px #16343a08;
}
.summary-card label,
.summary-card small {
  display: block;
  color: #718089;
}
.summary-card strong {
  display: block;
  font-size: 28px;
  margin: 7px 0;
}
.summary-card em {
  font-size: 12px;
  font-style: normal;
  font-weight: 500;
}
.trend-panel {
  margin-bottom: 16px;
}
.trend-panel .chart {
  height: 270px;
}
.analysis-head h2 {
  margin: 0 0 5px;
  font-size: 18px;
}
.analysis-head p {
  margin: 0;
  color: #829098;
  font-size: 12px;
}
@media (max-width: 1100px) {
  .summary-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
.filters {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 16px;
}
.danger {
  color: #c45656;
  font-weight: 700;
}
.el-tag + .el-tag {
  margin-left: 4px;
}
</style>
