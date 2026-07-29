<template>
  <svg :width="width" :height="height" class="d-inline-block align-middle" role="img" :aria-label="`trend: ${values.join(', ')}`">
    <template v-if="max > 0">
      <polyline :points="points" fill="none" :stroke="color" stroke-width="1.5"
        stroke-linejoin="round" stroke-linecap="round" />
      <circle :cx="lastX" :cy="lastY" r="2" :fill="color" />
    </template>
    <!-- Neutral mid-gray so the flat baseline reads on both light and dark themes. -->
    <line v-else :x1="0" :y1="height - 1" :x2="width" :y2="height - 1" stroke="rgba(128,128,128,0.5)" stroke-width="1" />
  </svg>
</template>

<script setup>
import { computed } from 'vue';

// Dependency-free sparkline. `values` are plotted left→right; a flat baseline is
// drawn when everything is zero.
const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 90 },
  height: { type: Number, default: 22 },
  color: { type: String, default: '#1976d2' },
});

const max = computed(() => Math.max(0, ...props.values));

const coords = computed(() => {
  const n = props.values.length;
  if (n === 0 || max.value === 0) return [];
  const pad = 2;
  const w = props.width - pad * 2;
  const h = props.height - pad * 2;
  const stepX = n > 1 ? w / (n - 1) : 0;
  return props.values.map((v, i) => ({
    x: pad + i * stepX,
    y: pad + h - (v / max.value) * h,
  }));
});

const points = computed(() => coords.value.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '));
const lastX = computed(() => (coords.value.at(-1)?.x ?? 0));
const lastY = computed(() => (coords.value.at(-1)?.y ?? 0));
</script>
