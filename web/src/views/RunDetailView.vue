<script setup lang="ts">
import { computed, ref } from "vue";
import { useQueries } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { InfoFilled } from "@element-plus/icons-vue";
import KnowledgeQueryDetail from "../components/KnowledgeQueryDetail.vue";
import { telemetryQueries } from "../api";
import {
  bytes,
  copyText,
  count,
  datetime,
  duration,
  percent,
  shortId,
} from "../format";
const route = useRoute();
const router = useRouter();
const props = withDefaults(
  defineProps<{ runId?: string; embedded?: boolean }>(),
  { runId: "", embedded: false },
);
const runId = String(props.runId || route.params.runId);
const tab = ref("workflow");
const detailTabs = [
  { value: "workflow", label: "执行概览" },
  { value: "skills", label: "SKILL 执行" },
  { value: "knowledge", label: "知识库查询" },
  { value: "tools", label: "工具调用" },
  { value: "artifacts", label: "交付产物" },
  { value: "resources", label: "资源消耗" },
  { value: "collection", label: "数据诊断" },
];
const queries = useQueries({
  queries: [
    { queryKey: ["run", runId], queryFn: () => telemetryQueries.getRun(runId) },
    {
      queryKey: ["run-facts", runId],
      queryFn: () => telemetryQueries.getRunFacts(runId),
    },
    {
      queryKey: ["run-chunks", runId],
      queryFn: () => telemetryQueries.getRunChunks(runId),
    },
    {
      queryKey: ["run-replays", runId],
      queryFn: () => telemetryQueries.getRunReplays(runId),
    },
    {
      queryKey: ["run-events", runId],
      queryFn: () => telemetryQueries.getRunEvents(runId),
    },
    {
      queryKey: ["run-artifacts", runId],
      queryFn: () => telemetryQueries.getRunArtifacts(runId),
    },
    {
      queryKey: ["current-user"],
      queryFn: () => telemetryQueries.getCurrentUser(),
    },
    {
      queryKey: ["run-raw-sources", runId],
      queryFn: () => telemetryQueries.getRunRawSources(runId),
    },
  ],
});
const detail = computed(() => queries.value[0]?.data);
const facts = computed(() => queries.value[1]?.data ?? {});
const chunks = computed(() => queries.value[2]?.data?.items ?? []);
const replays = computed(() => queries.value[3]?.data?.items ?? []);
const events = computed(() => queries.value[4]?.data?.items ?? []);
const knowledgeEvents = computed(() => events.value.filter((item:any) => item.event_type === "knowledge_query_finished"));
const selectedKnowledge = ref<any>(null);
const workflowEvents = computed(() => events.value.filter((item:any) => item.event_type !== "knowledge_query_finished"));
const artifacts = computed(() => queries.value[5]?.data?.items ?? []);
const isAdmin = computed(() => queries.value[6]?.data?.role === "admin");
const rawSources = computed(() => queries.value[7]?.data?.items ?? []);
type ArtifactTreeNode = {
  id: string;
  label: string;
  directory: boolean;
  children?: ArtifactTreeNode[];
  artifact?: any;
};
const artifactTree = computed<ArtifactTreeNode[]>(() => {
  const root: ArtifactTreeNode = {
    id: "outputs",
    label: "outputs",
    directory: true,
    children: [],
  };
  for (const artifact of artifacts.value) {
    const parts = String(
      artifact.logical_path ||
        `outputs/${artifact.skill}/${artifact.file_name}`,
    )
      .split("/")
      .filter(Boolean);
    let parent = root;
    for (const part of parts.slice(1, -1)) {
      let child = parent.children!.find(
        (item) => item.directory && item.label === part,
      );
      if (!child) {
        child = {
          id: `${parent.id}/${part}`,
          label: part,
          directory: true,
          children: [],
        };
        parent.children!.push(child);
      }
      parent = child;
    }
    parent.children!.push({
      id: artifact.upload_id,
      label: parts.at(-1) || artifact.file_name,
      directory: false,
      artifact,
    });
  }
  const sort = (nodes: ArtifactTreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.label.localeCompare(b.label),
    );
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(root.children!);
  return artifacts.value.length ? [root] : [];
});
const skillRows = computed(() =>
  Array.isArray(facts.value.skills?.items) ? facts.value.skills.items : [],
);
const loading = computed(() => queries.value.some((query) => query.isLoading));
const failed = computed(() => queries.value[0]?.isError);
async function copy() {
  await copyText(runId);
  ElMessage.success("Run ID 已复制");
}
async function downloadArtifact(row: any) {
  try {
    await telemetryQueries.downloadArtifact(row.upload_id, row.file_name);
  } catch {
    ElMessage.error("产物下载失败");
  }
}
async function downloadRawSource(row: any) {
  try {
    const role = row.sessionRole === "subagent" ? "subagent" : "main";
    await telemetryQueries.downloadRunRawSource(
      runId,
      row.sourceFileId,
      row.generation,
      `cospec-${shortId(runId).replace("…", "-")}-${role}-g${row.generation}.jsonl`,
    );
  } catch {
    ElMessage.error("原始 JSONL 下载失败或当前账号没有管理员权限");
  }
}
function skillStatus(value: unknown) {
  return (
    (
      {
        ok: "成功",
        failed: "失败",
        interrupted: "中断",
        open: "未结束",
        orphan: "缺少开始标记",
        invalid: "时间异常",
      } as Record<string, string>
    )[String(value)] ?? "未知"
  );
}
const workflowKindLabel: Record<string, string> = {
  large: "大需求",
  small: "小需求",
  custom: "自定义",
};
const workflowStatusLabel: Record<string, string> = {
  running: "进行中",
  completed: "完成",
  failed: "失败",
  interrupted: "中断",
};
const knowledgeStatusLabel: Record<string, string> = { completed: "正常完成", degraded: "降级完成", failed: "失败", incomplete: "记录不完整" };
const answerabilityLabel: Record<string, string> = { answerable: "可回答", partially_answerable: "部分可回答", unanswerable: "无法回答", conflicted: "知识冲突" };
</script>
<template>
  <div>
    <header v-if="!props.embedded" class="page-head">
      <div>
        <el-button
          v-if="!props.embedded"
          text
          @click="router.push('/workflows')"
          >← 返回工作流分析</el-button
        >
        <h1>工作流详情</h1>
      </div>
    </header>
    <el-alert
      v-if="failed"
      title="Run 不存在或无法读取"
      type="error"
      show-icon
    />
    <section v-if="detail" class="workflow-summary">
      <div class="summary-title">
        <div>
          <div class="summary-tags">
            <el-tag effect="plain">{{
              workflowKindLabel[detail.workflowKind ?? ""] ?? "类型未标记"
            }}</el-tag
            ><el-tag
              :type="
                detail.workflowStatus === 'completed'
                  ? 'success'
                  : detail.workflowStatus === 'failed'
                    ? 'danger'
                    : detail.workflowStatus === 'interrupted'
                      ? 'warning'
                      : 'info'
              "
              >{{
                workflowStatusLabel[detail.workflowStatus] ??
                detail.workflowStatus
              }}</el-tag
            >
          </div>
          <h2>{{ detail.workflowName ?? "未命名工作流" }}</h2>
          <p>
            {{ detail.displayName ?? "身份未知" }}<span>·</span
            >{{ detail.proposerDept ?? "产线未知" }}
          </p>
        </div>
        <div class="summary-id">
          <label>运行编号</label><span class="mono">{{ shortId(runId) }}</span
          ><el-button text size="small" @click="copy">复制</el-button>
        </div>
      </div>
      <div class="summary-facts">
        <div>
          <label>开始时间</label
          ><strong>{{
            datetime(detail.firstTimestamp ?? detail.firstReceivedAt)
          }}</strong>
        </div>
        <div>
          <label>最近活动</label
          ><strong>{{
            datetime(detail.lastTimestamp ?? detail.lastReceivedAt)
          }}</strong>
        </div>
        <div>
          <label>运行环境</label
          ><strong
            >{{
              detail.agentType === "claude_code" ? "Claude Code" : "Codex"
            }}
            · {{ detail.sourceVersion }}</strong
          >
        </div>
        <div>
          <label>交付产物</label><strong>{{ detail.artifactCount }} 个</strong>
        </div>
        <div>
          <label>执行 SKILL</label
          ><strong>{{ detail.skills.length }} 个</strong>
        </div>
      </div>
    </section>
    <section v-if="!failed" class="panel" v-loading="loading">
      <nav class="detail-tabs" aria-label="工作流详情分类">
        <button
          v-for="item in detailTabs"
          :key="item.value"
          type="button"
          :class="{ active: tab === item.value }"
          @click="tab = item.value"
        >
          {{ item.label }}
        </button>
      </nav>
      <el-tabs v-model="tab" class="detail-tab-content">
        <el-tab-pane label="交付产物" name="artifacts"
          ><el-tree
            v-if="artifactTree.length"
            class="artifact-tree"
            :data="artifactTree"
            node-key="id"
            default-expand-all
            :expand-on-click-node="false"
            ><template #default="{ data }"
              ><div class="artifact-node">
                <strong v-if="data.directory">📁 {{ data.label }}</strong
                ><template v-else
                  ><span class="artifact-name">📄 {{ data.label }}</span
                  ><span class="muted">{{ data.artifact.skill }}</span
                  ><span class="muted">{{
                    bytes(data.artifact.size_bytes)
                  }}</span
                  ><span class="muted">{{
                    datetime(data.artifact.uploaded_at)
                  }}</span
                  ><el-button
                    text
                    type="primary"
                    @click.stop="downloadArtifact(data.artifact)"
                    >下载</el-button
                  ></template
                >
              </div></template
            ></el-tree
          >
          <div v-else class="empty">
            当前 Run 没有已上传的正式产物
          </div></el-tab-pane
        >
        <el-tab-pane label="执行概览" name="workflow"
          ><el-table :data="workflowEvents" size="small"
            ><el-table-column label="时间"
              ><template #default="{ row }">{{
                datetime(row.occurred_at)
              }}</template></el-table-column
            ><el-table-column prop="event_type" label="事件" /><el-table-column
              prop="workflow_kind"
              label="类型" /><el-table-column
              prop="workflow_name"
              label="工作流"
              min-width="220" /><el-table-column label="人员"
              ><template #default="{ row }">{{
                row.actor
                  ? `${row.actor.display_name}（${row.actor.employee_id}）`
                  : "—"
              }}</template></el-table-column
            ><el-table-column
              prop="stage"
              label="阶段"
              min-width="180" /><el-table-column prop="status" label="结果"
          /></el-table>
          <div v-if="!workflowEvents.length" class="empty">
            当前 Run 没有工作流进度事件
          </div></el-tab-pane
        >
        <el-tab-pane label="知识库查询" name="knowledge">
          <el-table :data="knowledgeEvents" size="small">
            <el-table-column label="时间" width="175"><template #default="{ row }">{{ datetime(row.occurred_at) }}</template></el-table-column>
            <el-table-column prop="kb_name" label="知识库" min-width="150" />
            <el-table-column prop="kb_version" label="发布版本" min-width="120" />
            <el-table-column prop="consumer_skill" label="消费位置" min-width="190" />
            <el-table-column label="执行状态" width="110"><template #default="{ row }">{{ knowledgeStatusLabel[row.query_status] || "未记录" }}</template></el-table-column>
            <el-table-column label="回答情况" width="120"><template #default="{ row }">{{ answerabilityLabel[row.answerability] || "未记录" }}</template></el-table-column>
            <el-table-column prop="hit_count" label="命中" width="75" />
            <el-table-column prop="citation_count" label="引用" width="75" />
            <el-table-column prop="warning_count" label="告警" width="75" />
            <el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" :disabled="!row.query_detail" @click="selectedKnowledge = { ...row, detail: row.query_detail }">查看详情</el-button></template></el-table-column>
          </el-table>
          <div v-if="!knowledgeEvents.length" class="empty">当前 Run 没有知识库查询记录</div>
        </el-tab-pane>
        <el-drawer v-model="selectedKnowledge" title="知识查询详情" size="min(760px, 92vw)" append-to-body destroy-on-close><KnowledgeQueryDetail v-if="selectedKnowledge" :item="selectedKnowledge" /></el-drawer>
        <el-tab-pane label="资源消耗" name="resources"
          ><h3>消息与 Token</h3>
          <div class="facts-grid">
            <div class="fact">
              <label>消息记录</label
              ><strong>{{ count(facts.messages?.total) }}</strong>
            </div>
            <div class="fact">
              <label>输入 Token</label
              ><strong>{{ count(facts.tokens?.input_tokens) }}</strong>
            </div>
            <div class="fact">
              <label>输出 Token</label
              ><strong>{{ count(facts.tokens?.output_tokens) }}</strong>
            </div>
            <div class="fact">
              <label>缓存读取 Token</label
              ><strong>{{
                count(facts.tokens?.cache_read_input_tokens)
              }}</strong>
            </div>
            <div class="fact">
              <label>缓存写入 Token</label
              ><strong>{{
                count(facts.tokens?.cache_write_or_creation_input_tokens)
              }}</strong>
            </div>
            <div class="fact">
              <label>宿主记录跨度</label
              ><strong>{{
                detail?.firstTimestamp && detail?.lastTimestamp
                  ? duration(
                      Date.parse(detail.lastTimestamp) -
                        Date.parse(detail.firstTimestamp),
                    )
                  : "暂无数据"
              }}</strong>
            </div>
          </div>
          <h3>上下文压缩</h3>
          <div class="facts-grid">
            <div class="fact">
              <label>压缩总次数</label
              ><strong>{{ count(facts.context?.compactions?.total) }}</strong>
            </div>
            <div class="fact">
              <label>自动 / 手动 / 未知</label
              ><strong
                >{{ count(facts.context?.compactions?.byTrigger?.auto) }} /
                {{ count(facts.context?.compactions?.byTrigger?.manual) }} /
                {{
                  count(facts.context?.compactions?.byTrigger?.unknown)
                }}</strong
              >
            </div>
            <div class="fact">
              <label>上下文上限</label
              ><strong
                :class="facts.context?.window?.observed ? '' : 'unknown'"
                >{{
                  facts.context?.window?.observed
                    ? count(facts.context.window.latestTokens) + " Token"
                    : "当前数据源未提供"
                }}</strong
              >
            </div>
          </div></el-tab-pane
        >
        <el-tab-pane label="SKILL 执行" name="skills"
          ><div class="facts-grid">
            <div class="fact">
              <label>执行次数</label
              ><strong>{{ count(facts.skills?.executions) }}</strong>
            </div>
            <div class="fact">
              <label>成功 / 失败</label
              ><strong
                >{{ count(facts.skills?.completed) }} /
                <span class="danger">{{
                  count(facts.skills?.failed)
                }}</span></strong
              >
            </div>
            <div class="fact">
              <label>中断 / 未结束</label
              ><strong
                >{{ count(facts.skills?.interrupted) }} /
                {{ count(facts.skills?.open) }}</strong
              >
            </div>
            <div class="fact">
              <label>时长覆盖率</label
              ><strong>{{ percent(facts.skills?.duration_coverage) }}</strong>
            </div>
            <div class="fact">
              <label
                >活跃时长 P50 / P90
                <el-tooltip
                  content="活跃时长为 SKILL 从开始到结束的总历时，扣除等待用户回复的时间；未正常结束的执行不参与统计。"
                  placement="top"
                  ><el-icon class="info-tip"><InfoFilled /></el-icon
                ></el-tooltip></label
              ><strong
                >{{ duration(facts.skills?.p50_ms) }} /
                {{ duration(facts.skills?.p90_ms) }}</strong
              >
            </div>
            <div class="fact">
              <label>累计活跃 / 等待用户</label
              ><strong
                >{{ duration(facts.skills?.accumulated_ms) }} /
                {{
                  duration(facts.skills?.waiting_for_user_accumulated_ms)
                }}</strong
              >
            </div>
            <div class="fact">
              <label>等待次数</label
              ><strong>{{
                count(facts.skills?.waiting_for_user_interactions)
              }}</strong>
            </div>
            <div class="fact">
              <label>单次等待 P50 / P90</label
              ><strong
                >{{ duration(facts.skills?.waiting_for_user_p50_ms) }} /
                {{ duration(facts.skills?.waiting_for_user_p90_ms) }}</strong
              >
            </div>
            <div class="fact">
              <label>免等待执行比例</label
              ><strong>{{ percent(facts.skills?.no_user_wait_rate) }}</strong>
            </div>
            <div class="fact">
              <label>等待占总历时</label
              ><strong>{{
                percent(facts.skills?.waiting_share_of_elapsed)
              }}</strong>
            </div>
          </div>
          <el-table v-if="skillRows.length" :data="skillRows" size="small"
            ><el-table-column type="expand"
              ><template #default="{ row }"
                ><div class="facts-grid">
                  <div class="fact">
                    <label>自身输入 / 输出 Token</label
                    ><strong
                      >{{ count(row.resources?.self?.tokens?.input_tokens) }} /
                      {{
                        count(row.resources?.self?.tokens?.output_tokens)
                      }}</strong
                    >
                  </div>
                  <div class="fact">
                    <label>包含子 Skill 的输入 / 输出</label
                    ><strong
                      >{{
                        count(row.resources?.inclusive?.tokens?.input_tokens)
                      }}
                      /
                      {{
                        count(row.resources?.inclusive?.tokens?.output_tokens)
                      }}</strong
                    >
                  </div>
                  <div class="fact">
                    <label>自身工具调用 / 明确失败</label
                    ><strong
                      >{{ count(row.resources?.self?.tools?.calls) }} /
                      {{ count(row.resources?.self?.tools?.failures) }}</strong
                    >
                  </div>
                  <div class="fact">
                    <label>包含子 Skill 的工具 / 失败</label
                    ><strong
                      >{{ count(row.resources?.inclusive?.tools?.calls) }} /
                      {{
                        count(row.resources?.inclusive?.tools?.failures)
                      }}</strong
                    >
                  </div>
                  <div class="fact">
                    <label>自身 / 包含子 Skill 的子代理</label
                    ><strong
                      >{{ count(row.resources?.self?.subagents) }} /
                      {{ count(row.resources?.inclusive?.subagents) }}</strong
                    >
                  </div>
                </div></template
              ></el-table-column
            ><el-table-column
              prop="skill"
              min-width="220"
              ><template #header
                >SKILL
                <el-tooltip
                  content="展开一行可对比自身资源和包含嵌套子 SKILL 的资源；汇总采用自身资源，避免重复累计。"
                  placement="top"
                  ><el-icon class="info-tip"><InfoFilled /></el-icon
                ></el-tooltip></template></el-table-column
            ><el-table-column label="状态" width="100"
              ><template #default="{ row }">{{
                skillStatus(row.status)
              }}</template></el-table-column
            ><el-table-column label="总历时" width="110"
              ><template #default="{ row }">{{
                duration(row.elapsedMs)
              }}</template></el-table-column
            ><el-table-column label="等待用户" width="110"
              ><template #default="{ row }">{{
                duration(row.waitingForUserMs)
              }}</template></el-table-column
            ><el-table-column label="活跃时长" width="110"
              ><template #default="{ row }">{{
                duration(row.durationMs)
              }}</template></el-table-column
            ><el-table-column label="自身输入 Token" width="130"
              ><template #default="{ row }">{{
                count(row.resources?.self?.tokens?.input_tokens)
              }}</template></el-table-column
            ><el-table-column label="自身工具" width="100"
              ><template #default="{ row }">{{
                count(row.resources?.self?.tools?.calls)
              }}</template></el-table-column
            ><el-table-column label="明确失败" width="100"
              ><template #default="{ row }">{{
                count(row.resources?.self?.tools?.failures)
              }}</template></el-table-column
            ></el-table
          >
          <div v-else class="empty">
            暂无 SKILL 数据
            <el-tooltip
              content="当前 Run 的原始数据中没有识别到 SKILL 开始或结束标记。"
              placement="top"
              ><el-icon class="info-tip"><InfoFilled /></el-icon
            ></el-tooltip>
          </div></el-tab-pane
        >
        <el-tab-pane label="工具调用" name="tools"
          ><h3>工具调用</h3>
          <div class="facts-grid">
            <div class="fact">
              <label>调用次数</label
              ><strong>{{ count(facts.tools?.calls) }}</strong>
            </div>
            <div class="fact">
              <label>明确成功 / 失败</label
              ><strong
                >{{ count(facts.tools?.successes) }} /
                <span class="danger">{{
                  count(facts.tools?.failures)
                }}</span></strong
              >
            </div>
            <div class="fact">
              <label>不可判定</label
              ><strong>{{ count(facts.tools?.unknown_results) }}</strong>
            </div>
            <div class="fact">
              <label
                >状态覆盖率
                <el-tooltip
                  content="只有带有明确结果的工具调用才计入成功或失败；因此明确失败数是实际失败数的下界。"
                  placement="top"
                  ><el-icon class="info-tip"><InfoFilled /></el-icon
                ></el-tooltip></label
              ><strong>{{ percent(facts.tools?.status_coverage) }}</strong>
            </div>
            <div class="fact">
              <label>工具耗时 P50 / P90</label
              ><strong
                >{{ duration(facts.tools?.duration?.p50_ms) }} /
                {{ duration(facts.tools?.duration?.p90_ms) }}</strong
              >
            </div>
            <div class="fact">
              <label>去除并发后的经过时间</label
              ><strong>{{
                duration(facts.tools?.duration?.wall_clock_ms)
              }}</strong>
            </div>
          </div>
          <el-table
            :data="
              Object.entries(facts.tools?.byTool ?? {}).map(
                ([name, value]) => ({ name, ...value }),
              )
            "
            size="small"
            ><el-table-column prop="name" label="工具" /><el-table-column
              prop="calls"
              label="调用"
            /><el-table-column
              prop="successes"
              label="明确成功"
            /><el-table-column
              prop="failures"
              label="明确失败"
            /><el-table-column label="覆盖率"
              ><template #default="{ row }">{{
                percent(row.status_coverage)
              }}</template></el-table-column
            ></el-table
          >
          <h3>子代理</h3>
          <div class="facts-grid">
            <div class="fact">
              <label>子代理数量</label
              ><strong>{{ count(facts.subagents?.count) }}</strong>
            </div>
            <div class="fact">
              <label>最大层级</label
              ><strong>{{ count(facts.subagents?.max_depth) }}</strong>
            </div>
            <div class="fact">
              <label>子代理消息</label
              ><strong>{{ count(facts.subagents?.messages?.total) }}</strong>
            </div>
            <div class="fact">
              <label>子代理输入 Token</label
              ><strong>{{
                count(facts.subagents?.tokens?.input_tokens)
              }}</strong>
            </div>
            <div class="fact">
              <label>子代理工具调用</label
              ><strong>{{ count(facts.subagents?.tools?.calls) }}</strong>
            </div>
          </div>
          <el-table
            v-if="facts.subagents?.sessions?.length"
            :data="facts.subagents.sessions"
            size="small"
            style="margin-top: 16px"
            ><el-table-column label="Session"
              ><template #default="{ row }"
                ><span class="mono">{{
                  shortId(row.agentSessionId)
                }}</span></template
              ></el-table-column
            ><el-table-column label="父 Session"
              ><template #default="{ row }"
                ><span class="mono">{{
                  row.parentAgentSessionId
                    ? shortId(row.parentAgentSessionId)
                    : "主会话"
                }}</span></template
              ></el-table-column
            ><el-table-column
              prop="messages.total"
              label="消息" /><el-table-column
              prop="tools.calls"
              label="工具调用" /></el-table
        ></el-tab-pane>
        <el-tab-pane label="数据诊断" name="collection"
          ><h3>原始 JSONL</h3>
          <el-table :data="rawSources" size="small"
            ><el-table-column label="来源" min-width="140"
              ><template #default="{ row }">{{
                row.sessionRole === "subagent" ? "子代理会话" : "主会话"
              }}</template></el-table-column
            ><el-table-column label="Agent Session" min-width="150"
              ><template #default="{ row }"
                ><span class="mono">{{ shortId(row.agentSessionId) }}</span></template
              ></el-table-column
            ><el-table-column prop="generation" label="代次" width="70"
            /><el-table-column prop="chunkCount" label="数据块" width="80"
            /><el-table-column label="已采集大小" width="110"
              ><template #default="{ row }">{{ bytes(row.byteCount) }}</template></el-table-column
            ><el-table-column label="最近采集" min-width="170"
              ><template #default="{ row }">{{ datetime(row.lastReceivedAt) }}</template></el-table-column
            ><el-table-column label="操作" width="130"
              ><template #default="{ row }"
                ><el-button v-if="isAdmin" text type="primary" @click="downloadRawSource(row)"
                  >下载 JSONL</el-button
                ><span v-else class="muted">仅管理员可下载</span></template
              ></el-table-column
            ></el-table
          >
          <div v-if="!rawSources.length" class="empty">没有已保存的原始 JSONL</div>
          <h3>原始数据块</h3>
          <el-table :data="chunks" size="small"
            ><el-table-column
              prop="generation"
              label="代次"
              width="70"
            /><el-table-column
              prop="startOffset"
              label="起点"
            /><el-table-column prop="endOffset" label="终点" /><el-table-column
              label="大小"
              ><template #default="{ row }">{{
                bytes(row.byteCount)
              }}</template></el-table-column
            ><el-table-column
              prop="parserStatus"
              label="解析状态"
            /><el-table-column label="原始文件"
              ><template #default="{ row }">{{
                row.rawPresent ? "存在" : "缺失"
              }}</template></el-table-column
            ></el-table
          >
          <h3>重放历史</h3>
          <el-table :data="replays" size="small"
            ><el-table-column
              prop="targetVersion"
              label="目标版本" /><el-table-column
              prop="status"
              label="状态" /><el-table-column
              prop="totalChunks"
              label="数据块" /><el-table-column label="开始时间"
              ><template #default="{ row }">{{
                datetime(row.startedAt)
              }}</template></el-table-column
            ><el-table-column prop="failureCode" label="失败原因"
          /></el-table>
          <div v-if="!replays.length" class="empty">
            没有重放记录
          </div></el-tab-pane
        >
      </el-tabs>
    </section>
  </div>
</template>
<style scoped>
.workflow-summary {
  background: linear-gradient(145deg, #f8fbfb, #fff);
  border: 1px solid #e2e9ea;
  border-radius: 14px;
  padding: 20px 22px;
  margin-bottom: 16px;
}
.summary-title {
  display: flex;
  justify-content: space-between;
  gap: 24px;
}
.summary-tags {
  display: flex;
  gap: 8px;
  margin-bottom: 9px;
}
.summary-title h2 {
  font-size: 22px;
  margin: 0 0 7px;
}
.summary-title p {
  margin: 0;
  color: #728087;
}
.summary-title p span {
  margin: 0 8px;
}
.summary-id {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #68777f;
}
.summary-id label {
  font-size: 12px;
}
.summary-facts {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  border-top: 1px solid #e8eeee;
  margin-top: 18px;
  padding-top: 16px;
}
.summary-facts div {
  display: grid;
  gap: 6px;
}
.summary-facts label {
  font-size: 12px;
  color: #829098;
}
.summary-facts strong {
  font-size: 13px;
  color: #263943;
}
@media (max-width: 1100px) {
  .summary-facts {
    grid-template-columns: repeat(3, 1fr);
  }
}
.detail-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 12px;
  border-bottom: 1px solid #e4eaec;
}
.detail-tabs button {
  flex: 0 0 auto;
  appearance: none;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #61727b;
  cursor: pointer;
  font: inherit;
  padding: 8px 14px;
  white-space: nowrap;
}
.detail-tabs button:hover {
  background: #f1f6f6;
  color: #294b4b;
}
.detail-tabs button.active {
  background: #e6f2f0;
  color: #176b63;
  font-weight: 600;
}
.detail-tab-content :deep(.el-tabs__header) {
  display: none;
}
h3 {
  margin: 24px 0 14px;
}
.el-tab-pane > h3:first-child {
  margin-top: 8px;
}
.artifact-tree {
  padding: 8px 0;
}
.artifact-node {
  display: flex;
  align-items: center;
  gap: 18px;
  width: 100%;
  min-height: 34px;
}
.artifact-name {
  min-width: 280px;
}
.artifact-node .el-button {
  margin-left: auto;
}
.info-tip {
  margin-left: 4px;
  color: #97a5ac;
  cursor: help;
  vertical-align: -2px;
}
</style>
