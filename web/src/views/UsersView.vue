<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { ElMessage } from "element-plus";
import { CopyDocument, InfoFilled, Plus } from "@element-plus/icons-vue";
import { ApiError, telemetryQueries } from "../api";
import RefreshButton from "../components/RefreshButton.vue";

const currentUser = useQuery({ queryKey: ["current-user"], queryFn: telemetryQueries.getCurrentUser });
const usersQuery = useQuery({ queryKey: ["dashboard-users"], queryFn: telemetryQueries.listDashboardUsers, enabled: computed(() => currentUser.data.value?.role === "admin") });
const createOpen = ref(false);
const creating = ref(false);
const issuedToken = ref("");
const createdName = ref("");
const form = reactive({ displayName: "", role: "viewer" as "viewer" | "admin" });
const rows = computed(() => usersQuery.data.value?.items ?? []);

function beginCreate() { form.displayName = ""; form.role = "viewer"; issuedToken.value = ""; createOpen.value = true; }
async function createUser() {
  if (!form.displayName.trim()) return;
  creating.value = true;
  try {
    const result = await telemetryQueries.createDashboardUser(form.displayName.trim(), form.role);
    issuedToken.value = result.access_token; createdName.value = result.user.display_name;
    await usersQuery.refetch();
  } catch (error) { ElMessage.error(message(error)); }
  finally { creating.value = false; }
}
async function changeRole(row: any, role: "viewer" | "admin") {
  const before = row.role; row.role = role;
  try { await telemetryQueries.updateDashboardUser(row.user_id, { role }); ElMessage.success("权限已更新"); }
  catch (error) { row.role = before; ElMessage.error(message(error)); }
}
async function changeStatus(row: any, active: boolean) {
  const before = row.status; row.status = active ? "active" : "disabled";
  try { await telemetryQueries.updateDashboardUser(row.user_id, { status: row.status }); ElMessage.success(active ? "账号已启用" : "账号已停用"); }
  catch (error) { row.status = before; ElMessage.error(message(error)); }
}
async function copyToken() {
  try { await navigator.clipboard.writeText(issuedToken.value); ElMessage.success("Token 已复制"); }
  catch { ElMessage.error("复制失败，请手动复制"); }
}
function closeCreate() { createOpen.value = false; issuedToken.value = ""; }
function message(error: unknown) { return error instanceof ApiError && error.status === 403 ? "仅管理员可以管理用户" : "操作失败，请稍后重试"; }
function date(value: string) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
</script>

<template>
  <div>
    <header class="page-head">
      <div><h1>用户管理</h1><p>管理 SSO 接入前使用运营看板的本地账号</p></div>
      <div class="head-actions"><RefreshButton :loading="usersQuery.isFetching.value" @click="usersQuery.refetch()" /><el-button v-if="currentUser.data.value?.role === 'admin'" type="primary" :icon="Plus" @click="beginCreate">新建账号</el-button></div>
    </header>
    <el-alert v-if="currentUser.isSuccess.value && currentUser.data.value?.role !== 'admin'" title="仅管理员可以访问用户管理" type="warning" show-icon />
    <template v-else>
      <section class="account-summary">
        <article class="summary-card"><label>本地账号</label><strong>{{ rows.length }}</strong><small>通过独立 Token 登录</small></article>
        <article class="summary-card"><label>已启用</label><strong>{{ rows.filter((item) => item.status === 'active').length }}</strong><small>当前可以访问看板</small></article>
        <article class="summary-card"><label>管理员</label><strong>{{ rows.filter((item) => item.status === 'active' && item.role === 'admin').length }}</strong><small>不含部署管理员</small></article>
      </section>
      <section class="panel notice"><el-icon><InfoFilled /></el-icon><div><strong>部署管理员仍由服务端配置维护</strong><p>这里创建的是过渡期本地账号。接入 SSO 后可整体替换，不影响运营数据。</p></div></section>
      <section class="panel">
        <div class="table-head"><div><h2>本地账号</h2><p>Token 明文只在创建成功时显示一次</p></div></div>
        <el-table :data="rows" v-loading="usersQuery.isLoading.value">
          <el-table-column prop="display_name" label="名称" min-width="200" />
          <el-table-column label="权限" width="150"><template #default="{ row }"><el-select :model-value="row.role" @change="changeRole(row, $event)"><el-option label="只读用户" value="viewer" /><el-option label="管理员" value="admin" /></el-select></template></el-table-column>
          <el-table-column label="状态" width="130"><template #default="{ row }"><el-switch :model-value="row.status === 'active'" inline-prompt active-text="启用" inactive-text="停用" @change="changeStatus(row, Boolean($event))" /></template></el-table-column>
          <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ date(row.created_at) }}</template></el-table-column>
          <el-table-column label="更新时间" min-width="180"><template #default="{ row }">{{ date(row.updated_at) }}</template></el-table-column>
          <template #empty><div class="empty">还没有本地账号，可以点击右上角新建</div></template>
        </el-table>
      </section>
    </template>

    <el-dialog v-model="createOpen" title="新建本地账号" width="520px" :close-on-click-modal="!issuedToken" @closed="issuedToken = ''">
      <template v-if="!issuedToken">
        <el-form label-position="top">
          <el-form-item label="账号名称"><el-input v-model="form.displayName" maxlength="100" placeholder="例如：运营同事" /></el-form-item>
          <el-form-item label="权限"><el-radio-group v-model="form.role"><el-radio-button value="viewer">只读用户</el-radio-button><el-radio-button value="admin">管理员</el-radio-button></el-radio-group><p class="permission-help">管理员可以管理账号并下载原始 JSONL；只读用户只能查看运营数据。</p></el-form-item>
        </el-form>
      </template>
      <template v-else>
        <el-alert :title="`${createdName} 创建成功`" type="success" show-icon :closable="false" />
        <p class="token-warning">请立即复制并安全交给使用者。关闭窗口后无法再次查看。</p>
        <div class="token-box"><code>{{ issuedToken }}</code><el-button :icon="CopyDocument" circle @click="copyToken" /></div>
      </template>
      <template #footer><el-button v-if="!issuedToken" @click="createOpen = false">取消</el-button><el-button v-if="!issuedToken" type="primary" :loading="creating" :disabled="!form.displayName.trim()" @click="createUser">创建账号</el-button><el-button v-else type="primary" @click="closeCreate">我已保存</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions{display:flex;gap:10px}.account-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:18px}.summary-card{background:#fff;border:1px solid #e1e9e9;border-radius:12px;padding:20px}.summary-card label{color:#73808b;font-size:13px}.summary-card strong{display:block;font-size:29px;margin:9px 0 4px}.summary-card small{color:#929da4}.notice{display:flex;gap:12px;align-items:flex-start;margin-bottom:18px;background:#f6fbfa}.notice .el-icon{color:#2f8f78;font-size:18px;margin-top:2px}.notice p{margin:5px 0 0;color:#73808b;font-size:13px}.table-head{margin-bottom:14px}.table-head h2{margin:0 0 5px;font-size:18px}.table-head p{margin:0;color:#7b8991;font-size:13px}.permission-help{color:#7b8991;font-size:12px;margin:10px 0 0}.token-warning{color:#9a671c;margin:18px 0 10px}.token-box{display:flex;gap:10px;align-items:center;background:#f3f6f7;border:1px solid #dde5e7;border-radius:9px;padding:12px}.token-box code{flex:1;word-break:break-all;font-size:13px}
</style>
