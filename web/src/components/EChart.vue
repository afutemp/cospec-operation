<script setup lang="ts">
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
echarts.use([LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);
const props = defineProps<{ option: EChartsCoreOption }>();
const root = ref<HTMLElement>(); let chart: echarts.ECharts | undefined;
const resize = () => chart?.resize();
onMounted(() => { chart = echarts.init(root.value!); chart.setOption(props.option); window.addEventListener("resize", resize); });
watch(() => props.option, (option) => chart?.setOption(option, true), { deep: true });
onBeforeUnmount(() => { window.removeEventListener("resize", resize); chart?.dispose(); });
</script>
<template><div ref="root" class="chart" /></template>
