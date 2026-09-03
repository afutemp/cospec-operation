<script setup lang="ts">
import { ref, watch } from "vue";
import type { DatePreset } from "../date-range";

const preset = defineModel<DatePreset>("preset", { required: true });
const dates = defineModel<string[]>("dates", { required: true });
const selected = ref<DatePreset>(preset.value);
const draftDates = ref<string[]>([...dates.value]);
const customVisible = ref(false);
watch(preset, (value) => (selected.value = value));
watch(dates, (value) => (draftDates.value = [...value]), { deep: true });
function selectPeriod(value: DatePreset) {
  if (value === "custom") {
    draftDates.value = [...dates.value];
    customVisible.value = true;
  } else {
    customVisible.value = false;
    preset.value = value;
  }
}
function cancelCustom() {
  customVisible.value = false;
  selected.value = preset.value;
}
function applyCustom() {
  if (draftDates.value.length !== 2) return;
  dates.value = [...draftDates.value];
  preset.value = "custom";
  selected.value = "custom";
  customVisible.value = false;
}
</script>

<template>
  <div class="time-range-filter">
    <el-popover
      v-model:visible="customVisible"
      trigger="manual"
      placement="bottom-start"
      :width="680"
    >
      <template #reference
        ><el-select
          v-model="selected"
          class="range-select"
          @change="selectPeriod"
        >
          <el-option-group label="自然周期">
            <el-option label="当天" value="today" />
            <el-option label="本周" value="week" />
            <el-option label="本月" value="month" />
          </el-option-group>
          <el-option-group label="滚动周期">
            <el-option label="最近 24 小时" value="last24h" />
            <el-option label="最近 7 天" value="last7" />
            <el-option label="最近 30 天" value="last30" />
          </el-option-group>
          <el-option-group label="其他">
            <el-option label="自定义" value="custom" />
          </el-option-group> </el-select
      ></template>
      <div class="custom-panel">
        <strong>自定义时间范围</strong
        ><el-date-picker
          v-model="draftDates"
          type="datetimerange"
          value-format="YYYY-MM-DDTHH:mm:ss.sssZ"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
        />
        <div class="actions">
          <el-button @click="cancelCustom">取消</el-button
          ><el-button
            type="primary"
            :disabled="draftDates.length !== 2"
            @click="applyCustom"
            >应用</el-button
          >
        </div>
      </div>
    </el-popover>
  </div>
</template>

<style scoped>
.time-range-filter {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.range-select {
  width: 170px;
}
.custom-panel {
  display: grid;
  gap: 14px;
  padding: 4px;
}
.custom-panel strong {
  font-size: 14px;
}
.custom-panel :deep(.el-date-editor) {
  width: 100%;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
