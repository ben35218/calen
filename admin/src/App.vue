<template>
  <v-app>
    <template v-if="auth.isLoggedIn && showChrome">
      <v-app-bar color="primary" density="comfortable" flat>
        <v-app-bar-title>
          <v-icon icon="mdi-shield-crown" class="mr-2" />
          Calen — Admin
        </v-app-bar-title>
        <v-chip size="small" variant="flat" :color="env.color" class="ml-3 font-weight-bold">{{ env.label }}</v-chip>
        <v-spacer />
        <span class="text-body-2 mr-3 d-none d-sm-inline">{{ auth.user?.email }}</span>
        <v-btn variant="text" prepend-icon="mdi-logout" @click="auth.logout">Sign out</v-btn>
      </v-app-bar>

      <v-navigation-drawer permanent>
        <v-list nav density="comfortable">
          <v-list-subheader>Analytics</v-list-subheader>
          <v-list-item to="/insights" prepend-icon="mdi-chart-box" title="Insights" />
          <v-list-item to="/ai-usage" prepend-icon="mdi-counter" title="AI usage" />

          <v-list-subheader>Revenue</v-list-subheader>
          <v-list-item to="/monetization" prepend-icon="mdi-cash-multiple" title="Monetization" />
          <v-list-item to="/billing" prepend-icon="mdi-credit-card-outline" title="Billing" />
          <v-list-item to="/households" prepend-icon="mdi-home-group" title="Households" />

          <v-list-subheader>Support</v-list-subheader>
          <v-list-item to="/support-inbox" prepend-icon="mdi-face-agent" title="Support inbox">
            <template #append>
              <v-chip v-if="badges.supportUnseen" size="x-small" color="error" variant="flat">{{ badges.supportUnseen }}</v-chip>
            </template>
          </v-list-item>
          <v-list-item to="/moderation" prepend-icon="mdi-flag-outline" title="Content reports">
            <template #append>
              <v-chip v-if="badges.openReports" size="x-small" color="error" variant="flat">{{ badges.openReports }}</v-chip>
            </template>
          </v-list-item>
          <v-list-item to="/feedback" prepend-icon="mdi-comment-question-outline" title="Feedback">
            <template #append>
              <v-chip v-if="badges.newFeedback" size="x-small" color="error" variant="flat">{{ badges.newFeedback }}</v-chip>
            </template>
          </v-list-item>

          <v-list-subheader>Quality</v-list-subheader>
          <v-list-item to="/releases" prepend-icon="mdi-rocket-launch-outline" title="Releases">
            <template #append>
              <v-chip v-if="badges.blockedReleases" size="x-small" color="error" variant="flat">
                {{ badges.blockedReleases }}
              </v-chip>
            </template>
          </v-list-item>
          <v-list-item to="/test-cases" prepend-icon="mdi-clipboard-check-outline" title="Test cases" />

          <v-list-subheader>Operations</v-list-subheader>
          <v-list-item to="/users" prepend-icon="mdi-account-multiple" title="Users" />
          <v-list-item to="/do-not-call" prepend-icon="mdi-phone-off" title="Do-not-call" />
          <v-list-item to="/email-lifecycle" prepend-icon="mdi-email-sync-outline" title="Email lifecycle" />
          <v-list-item to="/email-log" prepend-icon="mdi-email-fast-outline" title="Email log" />
          <v-list-item to="/audit" prepend-icon="mdi-clipboard-text-clock" title="Audit log" />
        </v-list>
      </v-navigation-drawer>
    </template>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { adminApi, emailApi, qaApi } from './services/api';

const auth = useAuthStore();
const route = useRoute();
const showChrome = computed(() => !route.meta.public);

// Guard against editing the wrong environment: the API target decides the
// label, so a local build pointed at prod still screams PRODUCTION.
const env = computed(() => {
  const label = import.meta.env.VITE_ENV_LABEL || (import.meta.env.PROD ? 'PRODUCTION' : 'DEV');
  return { label, color: /prod/i.test(label) ? 'error' : 'grey-darken-1' };
});

// Nav badges double as a to-do list: unseen support mail + open content
// reports, refreshed on a slow poll (the support count hits IMAP, so keep the
// interval generous). Failures are silent — badges are best-effort.
const badges = ref({ supportUnseen: 0, openReports: 0, newFeedback: 0, blockedReleases: 0 });
let badgeTimer = null;

async function loadBadges() {
  const [s, m, f, r] = await Promise.allSettled([
    emailApi.supportStatus(),
    adminApi.moderation({ page: 1, pageSize: 1 }),
    adminApi.feedback({ page: 1, pageSize: 1 }),
    // A release under test that can't sign off is outstanding work, same as an
    // untriaged report — so it gets the same treatment in the nav.
    qaApi.releases({ status: 'testing', page: 1, pageSize: 25 }),
  ]);
  if (s.status === 'fulfilled' && s.value.data.configured !== false) {
    badges.value.supportUnseen = s.value.data.boxes?.find((b) => b.path === 'INBOX')?.unseen || 0;
  }
  if (m.status === 'fulfilled') badges.value.openReports = m.value.data.openCount || 0;
  if (f.status === 'fulfilled') badges.value.newFeedback = f.value.data.newCount || 0;
  if (r.status === 'fulfilled') {
    badges.value.blockedReleases = (r.value.data.items || []).filter((x) => !x.summary?.canSignOff).length;
  }
}

watch(() => auth.isLoggedIn, (loggedIn) => {
  clearInterval(badgeTimer);
  badgeTimer = null;
  if (loggedIn) {
    loadBadges();
    badgeTimer = setInterval(loadBadges, 120_000);
  }
}, { immediate: true });

onMounted(() => auth.init());
onUnmounted(() => clearInterval(badgeTimer));
</script>
