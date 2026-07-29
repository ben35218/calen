import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

// Shared plumbing for the admin list views: server-side pagination state, a
// debounced type-to-search reload, and URL ↔ state sync so search/filters/page
// survive a refresh and can be deep-linked (e.g. /users?q=jane@example.com —
// which is also how cross-view links pre-fill a search).
//
//   const list = usePagedList({
//     pageSize: 50,
//     filters: { q: '', status: null },        // synced to query params by key
//     fetch: ({ page, pageSize, filters }) => api.get(...),  // → { items, total }
//     onError: (e) => fromError(e, 'Failed to load'),
//   });
//
// Bind `v-model="list.page"` on <v-pagination> (the page watcher reloads —
// don't also wire @update:model-value). Call `reload()` after a filter change
// (resets to page 1); use `onSearch` for text inputs (debounced reload).
export function usePagedList({ fetch, pageSize = 50, filters: filterDefaults = {}, onError }) {
  const route = useRoute();
  const router = useRouter();

  const loading = ref(true);
  const items = ref([]);
  const total = ref(0);
  const page = ref(Math.max(1, Number(route.query.page) || 1));
  const filters = ref({ ...filterDefaults });
  for (const k of Object.keys(filterDefaults)) {
    if (route.query[k] != null && route.query[k] !== '') filters.value[k] = route.query[k];
  }

  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
  const rangeLabel = computed(() => {
    const start = (page.value - 1) * pageSize + 1;
    const end = Math.min(page.value * pageSize, total.value);
    return `${start}–${end} of ${total.value}`;
  });

  // Reflect the current state into the URL without polluting history.
  function syncQuery() {
    const query = { ...route.query };
    for (const [k, v] of Object.entries(filters.value)) {
      if (v == null || v === '') delete query[k];
      else query[k] = String(v);
    }
    if (page.value > 1) query.page = String(page.value);
    else delete query.page;
    router.replace({ query });
  }

  async function load() {
    loading.value = true;
    try {
      const { data } = await fetch({ page: page.value, pageSize, filters: filters.value });
      items.value = data.items;
      total.value = data.total;
      syncQuery();
    } catch (e) {
      if (onError) onError(e);
      else throw e;
    } finally {
      loading.value = false;
    }
  }

  // Filter changed → back to page 1. Setting page triggers the watcher's load;
  // when already on page 1 the watcher won't fire, so load directly.
  function reload() {
    if (page.value !== 1) page.value = 1;
    else load();
  }

  let searchTimer = null;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(reload, 300);
  }

  watch(page, load);
  onMounted(load);

  return { loading, items, total, page, pageCount, rangeLabel, filters, load, reload, onSearch };
}
