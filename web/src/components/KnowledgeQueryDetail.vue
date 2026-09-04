<script setup lang="ts">
defineProps<{ item: any }>();
function text(value: unknown) { return value == null || value === "" ? "未记录" : String(value); }
function retrieval(value: unknown) { return value === "adapter_topk" ? "按相关性检索" : value === "kb_readable" ? "由 Agent 阅读知识库" : text(value); }
function coverage(item: any) { return `${item.detail?.coverage?.covered?.length ?? 0} 已覆盖 · ${item.detail?.coverage?.missing?.length ?? 0} 缺失 · ${item.detail?.coverage?.conflict?.length ?? 0} 冲突`; }
</script>

<template>
  <div class="knowledge-detail">
    <section class="query-block"><label>原始问题</label><p>{{ text(item.detail?.question) }}</p></section>
    <section class="query-block answer"><label>完整回答</label><pre>{{ text(item.detail?.answer) }}</pre></section>
    <div class="meta-grid">
      <div><label>查询方式</label><span>{{ retrieval(item.detail?.retrieval) }}</span></div>
      <div><label>返回上限</label><span>{{ item.detail?.top_k ?? "未记录" }}</span></div>
      <div><label>知识库位置</label><span>{{ text(item.detail?.kb_root) }}</span></div>
      <div><label>查询编号</label><span>{{ text(item.query_id) }}</span></div>
      <div><label>问题覆盖</label><span>{{ coverage(item) }}</span></div>
      <div><label>查询模式</label><span>{{ item.detail?.mode === "benchmark" ? "评测" : "正常查询" }}</span></div>
    </div>
    <section><h3>命中的知识片段（{{ item.detail?.hits?.length ?? 0 }}）</h3>
      <el-collapse v-if="item.detail?.hits?.length">
        <el-collapse-item v-for="(hit,index) in item.detail.hits" :key="`${hit.path}-${index}`" :title="`${hit.rank ? `#${hit.rank} ` : ''}${hit.path}${hit.heading ? ` · ${hit.heading}` : ''}`">
          <pre>{{ text(hit.excerpt) }}</pre><small v-if="hit.startLine">位置：第 {{ hit.startLine }} 至 {{ hit.endLine || hit.startLine }} 行</small>
        </el-collapse-item>
      </el-collapse><div v-else class="empty compact">没有命中片段</div>
    </section>
    <section v-if="item.detail?.retrieval_runs?.length"><h3>分项检索过程（{{ item.detail.retrieval_runs.length }}）</h3>
      <el-collapse><el-collapse-item v-for="(run,index) in item.detail.retrieval_runs" :key="run.obligationId || index" :title="`${run.obligationId || `第 ${index + 1} 项`} · ${run.query || '未记录检索词'}`">
        <p>找到 {{ run.hits?.length ?? 0 }} 个片段，产生 {{ run.warnings?.length ?? 0 }} 条告警</p>
        <ul v-if="run.hits?.length"><li v-for="(hit,hitIndex) in run.hits" :key="hitIndex">{{ hit.path }}<span v-if="hit.heading"> · {{ hit.heading }}</span></li></ul>
      </el-collapse-item></el-collapse>
    </section>
    <section><h3>引用依据（{{ item.detail?.citations?.length ?? 0 }}）</h3>
      <ul v-if="item.detail?.citations?.length"><li v-for="citation in item.detail.citations" :key="citation.id"><strong>{{ citation.id }}</strong>　{{ citation.path }}<span v-if="citation.heading"> · {{ citation.heading }}</span></li></ul>
      <div v-else class="empty compact">没有引用依据</div>
    </section>
    <section><h3>查询告警（{{ item.detail?.warnings?.length ?? 0 }}）</h3>
      <el-alert v-for="(warning,index) in item.detail?.warnings || []" :key="index" :title="warning.message || warning.code" :description="warning.code" type="warning" :closable="false" show-icon />
      <div v-if="!item.detail?.warnings?.length" class="empty compact">没有查询告警</div>
    </section>
    <section v-if="item.detail?.obligations?.length"><h3>问题覆盖情况</h3>
      <el-table :data="item.detail.obligations" size="small"><el-table-column prop="id" label="编号" width="90"/><el-table-column prop="text" label="需要回答的内容" min-width="220"/><el-table-column prop="status" label="覆盖结果" width="110"/><el-table-column prop="answer_fragment" label="回答片段" min-width="240"/></el-table>
    </section>
    <section v-if="item.detail?.evidence_dispositions?.length"><h3>知识片段使用情况</h3>
      <el-table :data="item.detail.evidence_dispositions" size="small"><el-table-column prop="candidate_id" label="片段" width="100"/><el-table-column prop="status" label="是否使用" width="110"/><el-table-column label="对应问题" min-width="150"><template #default="{row}">{{ (row.obligation_ids || []).join("、") || "—" }}</template></el-table-column><el-table-column prop="reason" label="判断说明" min-width="220"/></el-table>
    </section>
  </div>
</template>

<style scoped>
.knowledge-detail{display:grid;gap:20px}.query-block{background:#f6f9f9;border:1px solid #e3ebeb;border-radius:10px;padding:14px 16px}.query-block label,.meta-grid label{display:block;color:#718087;font-size:12px;margin-bottom:7px}.query-block p,.query-block pre{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.65;font:inherit}.query-block.answer{background:#fbfcff}.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.meta-grid>div{border-bottom:1px solid #edf1f1;padding:4px 0 10px}.meta-grid span{word-break:break-all}.knowledge-detail h3{font-size:15px;margin:0 0 10px}.knowledge-detail section{min-width:0}.knowledge-detail ul{padding-left:20px;line-height:1.8}.knowledge-detail :deep(.el-alert)+.el-alert{margin-top:8px}.knowledge-detail :deep(.el-collapse-item__header){line-height:1.4;height:auto;min-height:48px}.knowledge-detail pre{white-space:pre-wrap;word-break:break-word;line-height:1.55}.compact{padding:20px}@media(max-width:700px){.meta-grid{grid-template-columns:1fr}}
</style>
