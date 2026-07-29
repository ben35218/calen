<template>
  <div>
    <svg :width="width" :height="height" role="img" :aria-label="ariaLabel">
      <g v-for="(v, i) in values" :key="i">
        <rect
          :x="x(i)" :y="y(v)" :width="barWidth" :height="barHeight(v)"
          :fill="color" rx="2">
          <title>{{ labels[i] }}: {{ v }}</title>
        </rect>
      </g>
      <!-- Neutral mid-gray so the axis reads on both light and dark themes. -->
      <line :x1="0" :y1="height - axis" :x2="width" :y2="height - axis" stroke="rgba(128,128,128,0.5)" stroke-width="1" />
    </svg>
    <div class="d-flex" :style="{ width: width + 'px' }">
      <div v-for="(l, i) in labels" :key="i" class="text-center text-caption text-medium-emphasis"
        :style="{ width: (100 / labels.length) + '%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }">
        {{ l }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

// Minimal dependency-free bar chart. `values` and `labels` are parallel arrays.
const props = defineProps({
  values: { type: Array, default: () => [] },
  labels: { type: Array, default: () => [] },
  width: { type: Number, default: 520 },
  height: { type: Number, default: 140 },
  color: { type: String, default: '#1976d2' },
  ariaLabel: { type: String, default: 'bar chart' },
});

const axis = 1;
const gap = 6;
const max = computed(() => Math.max(1, ...props.values));
const slot = computed(() => props.values.length ? props.width / props.values.length : props.width);
const barWidth = computed(() => Math.max(2, slot.value - gap));
const plotH = computed(() => props.height - axis - 4);

function x(i) { return i * slot.value + gap / 2; }
function barHeight(v) { return Math.max(0, (v / max.value) * plotH.value); }
function y(v) { return props.height - axis - barHeight(v); }
</script>
