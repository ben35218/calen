<template>
  <span :title="abs">{{ rel }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { fmtDateTime, fmtRelative } from '../lib/format';

// Relative time for scanability, absolute on hover for precision.
const props = defineProps({ date: { type: [String, Date, Number], default: null } });
const abs = computed(() => fmtDateTime(props.date));
const rel = computed(() => fmtRelative(props.date));
</script>
