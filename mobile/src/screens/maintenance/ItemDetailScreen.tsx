import React, { useLayoutEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Linking, Share, ActionSheetIOS, Platform } from 'react-native';
import { Text } from '../../components/Text';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  itemsApi,
  manualsApi,
  receiptsApi,
  tasksApi,
  contactsApi,
  Manual,
  ManualCandidate,
  Receipt,
  ExtractedTask,
  Task,
  Contact,
} from '../../api';
import { loadOdometerData, logOdometerReading } from '../../lib/odometer';
import { createTaskFromManualExtract } from '../../lib/taskTemplates';
import { Button, Card, Screen, Divider, ListRow, Input, RoundIconButton, SkeletonDetail, SkeletonRows, IconAvatar, ScreenTitle, HeaderIconButton, Fab } from '../../components/ui';
import CalenChatIcon from '../../components/CalenChatIcon';
import QuotaBlockedNotice from '../../components/QuotaBlockedNotice';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { recurrenceLabel, formatCalendarDate, mdiName } from '../../lib/recurrence';
import { itemTypeConfig } from '../../lib/itemTypes';
import { resolveTaskIcon } from '../../lib/maintenanceCategories';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { pickDocument, takePhoto, pickImage, PickedFile } from '../../lib/media';
import { uploadFile } from '../../lib/upload';
import { getHDK, newObjectId, openRecord } from '../../lib/e2ee';
import { encryptFileForUpload, decryptDownloadedFile } from '../../lib/attachments';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ItemDetail'>;
type Rt = RouteProp<MaintenanceStackParamList, 'ItemDetail'>;

// Item type → icon/color, mirroring MaintenanceScreen's TYPE_ICONS / TYPE_COLORS
// so the item's avatar here matches the one shown next to its name in the list.
const TYPE_ICONS: Record<string, string> = {
  vehicle: 'car',
  equipment: 'tools',
  appliance: 'washing-machine',
  system: 'cog',
  structure: 'home',
  other: 'package-variant',
};
const TYPE_COLORS: Record<string, string> = {
  vehicle: '#607D8B',
  equipment: '#795548',
  appliance: '#9C27B0',
  system: '#FF9800',
  structure: '#4CAF50',
  other: '#9E9E9E',
};

// The related-tasks list collapses to this many rows until the user expands it.
const TASKS_COLLAPSED_COUNT = 4;

function manualDownloadUrl(id: string) {
  return `${API_URL}/manuals/${id}/download?token=${getCachedToken()}`;
}

function receiptDownloadUrl(id: string) {
  return `${API_URL}/receipts/${id}/download?token=${getCachedToken()}`;
}

// Best-effort extension for the decrypted temp file, from the stored mime type.
function extForType(fileType?: string): string {
  if (fileType?.includes('png')) return 'png';
  if (fileType?.includes('pdf')) return 'pdf';
  if (fileType?.includes('heic')) return 'heic';
  if (fileType?.includes('webp')) return 'webp';
  return 'jpg';
}

export default function ItemDetailScreen() {
  const navigation = useNavigation<Nav>();
  const aiEnabled = useAiEnabled();
  const { id } = useRoute<Rt>().params;
  const accent = useCalendarColors().colors.maintenance;
  const qc = useQueryClient();

  const [odomReading, setOdomReading] = useState('');
  const [odoExpanded, setOdoExpanded] = useState(false);
  const [odoAdding, setOdoAdding] = useState(false);
  const [lookup, setLookup] = useState<{ state: 'idle' | 'searching' | 'done' | 'error'; candidates: ManualCandidate[]; query?: string; error?: string; quota?: boolean }>({
    state: 'idle',
    candidates: [],
  });
  const [extract, setExtract] = useState<{ manualId: string; title: string; tasks: ExtractedTask[]; selected: Set<number> } | null>(null);
  // Manual lookup shows only Claude's top pick by default; "See more options" reveals the rest.
  const [showAllManuals, setShowAllManuals] = useState(false);
  // Related-tasks list collapses to the first few until "Show all" is tapped.
  const [showAllTasks, setShowAllTasks] = useState(false);

  const itemQ = useQuery({
    queryKey: ['items', id],
    queryFn: async () => openRecord('Item', (await itemsApi.get(id)).data),
  });
  const item = itemQ.data;
  const isVehicle = item?.type === 'vehicle';

  const tasksQ = useQuery({
    queryKey: ['tasks', 'forItem', id],
    queryFn: async () => {
      const rows = (await tasksApi.list({ item: id })).data;
      return Promise.all(rows.map((t) => openRecord('MaintenanceTask', t)));
    },
  });

  // Resolve the linked service professional's (decrypted) name from the roster —
  // the item only stores its ref id (Contact names live in the E2EE blob).
  const proId = item?.serviceProId
    ? typeof item.serviceProId === 'object'
      ? item.serviceProId._id
      : item.serviceProId
    : null;
  const contactsQ = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const rows = (await contactsApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Contact', p))) as Promise<Contact[]>;
    },
    enabled: !!proId,
  });
  const servicePro = proId ? contactsQ.data?.find((p) => p._id === proId) : undefined;
  // Decrypted odometer state (Signal-parity D5): readings are sealed content;
  // currentKm/kmPerDay/task estimates all derive on-device.
  const odoQ = useQuery({
    queryKey: ['odometer', id],
    queryFn: () => loadOdometerData(id),
    enabled: isVehicle,
  });

  const refreshItem = () => qc.invalidateQueries({ queryKey: ['items', id] });

  const del = useMutation({
    mutationFn: () => itemsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] });
      navigation.goBack();
    },
  });

  // Client-side log flow (D5): validates against the last decrypted reading,
  // seals the log, refreshes mileage-task estimates, syncs the item field.
  const logOdo = useMutation({
    mutationFn: async () => {
      if (!odoQ.data) throw new Error('Odometer data still loading — try again.');
      await logOdometerReading(id, Number(odomReading), odoQ.data);
    },
    onSuccess: () => {
      setOdomReading('');
      setOdoAdding(false);
      qc.invalidateQueries({ queryKey: ['odometer', id] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      refreshItem();
    },
    onError: (e: any) => Alert.alert('Could not log reading', e?.message || 'Try again.'),
  });

  const upload = useMutation({
    mutationFn: async () => {
      const file = await pickDocument();
      if (!file) return null;
      // E2EE (Phase 4c): when the household key is unlocked, encrypt the file
      // bytes on-device and upload the ciphertext + wrapped file key. Otherwise
      // upload plaintext as before (dual-write / non-E2EE households).
      if (getHDK()) {
        const manualId = await newObjectId();
        const sealed = await encryptFileForUpload('Manual', manualId, file.uri);
        if (sealed) {
          return uploadFile('/manuals/items/' + id + '/upload', { uri: sealed.uri, name: `${manualId}.bin`, type: 'application/octet-stream' }, 'file', {
            encrypted: true,
            _id: manualId,
            wrappedFileKey: sealed.wrappedFileKey,
            keyVersion: sealed.keyVersion,
            fileType: file.type || 'application/pdf',
            title: file.name,
          });
        }
      }
      return uploadFile('/manuals/items/' + id + '/upload', file, 'file');
    },
    onSuccess: (res) => {
      if (res) refreshItem();
    },
    onError: (e: any) => Alert.alert('Upload failed', e.response?.data?.error || 'Could not upload that file.'),
  });

  // Overflow menu for the Manuals card: find a manual online or upload one.
  const openManualsMenu = () => {
    const find = () => runLookup.mutate();
    const upload_ = () => upload.mutate();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Find online', 'Upload', 'Cancel'], cancelButtonIndex: 2 },
        (i) => {
          if (i === 0) find();
          else if (i === 1) upload_();
        }
      );
    } else {
      Alert.alert('Manuals', undefined, [
        { text: 'Find online', onPress: find },
        { text: 'Upload', onPress: upload_ },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  // Open a manual: encrypted ones are downloaded as ciphertext, decrypted
  // on-device to a temp file, and shared/opened; plaintext ones open directly.
  const openManual = useMutation({
    mutationFn: async (m: Manual) => {
      if (!m.encrypted) { await Linking.openURL(manualDownloadUrl(m._id)); return; }
      if (!getHDK() || !m.wrappedFileKey) throw new Error('Unlock your account to open this encrypted manual.');
      const cipherUri = `${cacheDirectory}dl-${m._id}.bin`;
      const dl = await downloadAsync(`${API_URL}/manuals/${m._id}/download`, cipherUri, {
        headers: { Authorization: `Bearer ${getCachedToken()}` },
      });
      const plainUri = await decryptDownloadedFile('Manual', m._id, m.keyVersion, m.wrappedFileKey, dl.uri, `${m.title || 'manual'}.pdf`);
      if (!plainUri) throw new Error('Could not decrypt this manual.');
      await Share.share({ url: plainUri });
    },
    onError: (e: any) => Alert.alert('Could not open manual', e?.message || 'Please try again.'),
  });

  // Preview a found candidate's PDF before committing to save it.
  const viewCandidate = async (c: ManualCandidate) => {
    try {
      await Linking.openURL(c.url);
    } catch {
      Alert.alert('Could not open', 'This link could not be opened. Try saving it instead.');
    }
  };

  const runLookup = useMutation({
    mutationFn: () => manualsApi.autoLookup(id),
    onMutate: () => {
      setShowAllManuals(false);
      setLookup({ state: 'searching', candidates: [] });
    },
    onSuccess: (res) =>
      setLookup({ state: 'done', candidates: res.data.candidates || [], query: res.data.query }),
    onError: (e: any) =>
      setLookup({
        state: 'error',
        candidates: [],
        quota: e.response?.data?.code === 'QUOTA_EXCEEDED',
        error: e.response?.data?.error || 'Search failed',
      }),
  });

  const saveCandidate = useMutation({
    mutationFn: (c: ManualCandidate) => manualsApi.fromUrl(id, { url: c.url, title: c.title || `${item?.name} Manual` }),
    onSuccess: () => {
      setShowAllManuals(false);
      setLookup({ state: 'idle', candidates: [] });
      refreshItem();
    },
    onError: (e: any) => Alert.alert('Could not save', e.response?.data?.error || 'Try another or upload manually.'),
  });

  const delManual = useMutation({
    mutationFn: (mid: string) => manualsApi.delete(mid),
    onSuccess: refreshItem,
  });

  // ---- Receipts (proof-of-purchase images, for the owner's records) --------
  const addReceipt = useMutation({
    mutationFn: async (file: PickedFile) => {
      // Same E2EE path as manuals: encrypt on-device when unlocked, else plaintext.
      if (getHDK()) {
        const receiptId = await newObjectId();
        const sealed = await encryptFileForUpload('Receipt', receiptId, file.uri);
        if (sealed) {
          return uploadFile('/receipts/items/' + id + '/upload', { uri: sealed.uri, name: `${receiptId}.bin`, type: 'application/octet-stream' }, 'file', {
            encrypted: true,
            _id: receiptId,
            wrappedFileKey: sealed.wrappedFileKey,
            keyVersion: sealed.keyVersion,
            fileType: file.type || 'image/jpeg',
            title: file.name,
          });
        }
      }
      return uploadFile('/receipts/items/' + id + '/upload', file, 'file');
    },
    onSuccess: (res) => { if (res) refreshItem(); },
    onError: (e: any) => Alert.alert('Upload failed', e.response?.data?.error || 'Could not upload that image.'),
  });

  const openReceiptsMenu = () => {
    const cam = async () => { const f = await takePhoto(); if (f) addReceipt.mutate(f); };
    const lib = async () => { const f = await pickImage(); if (f) addReceipt.mutate(f); };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Take Photo', 'Choose from Library', 'Cancel'], cancelButtonIndex: 2 },
        (i) => { if (i === 0) cam(); else if (i === 1) lib(); }
      );
    } else {
      Alert.alert('Add receipt', undefined, [
        { text: 'Take Photo', onPress: cam },
        { text: 'Choose from Library', onPress: lib },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const openReceipt = useMutation({
    mutationFn: async (r: Receipt) => {
      if (!r.encrypted) { await Linking.openURL(receiptDownloadUrl(r._id)); return; }
      if (!getHDK() || !r.wrappedFileKey) throw new Error('Unlock your account to open this encrypted receipt.');
      const cipherUri = `${cacheDirectory}dl-${r._id}.bin`;
      const dl = await downloadAsync(`${API_URL}/receipts/${r._id}/download`, cipherUri, {
        headers: { Authorization: `Bearer ${getCachedToken()}` },
      });
      const plainUri = await decryptDownloadedFile('Receipt', r._id, r.keyVersion, r.wrappedFileKey, dl.uri, `${r.title || 'receipt'}.${extForType(r.fileType)}`);
      if (!plainUri) throw new Error('Could not decrypt this receipt.');
      await Share.share({ url: plainUri });
    },
    onError: (e: any) => Alert.alert('Could not open receipt', e?.message || 'Please try again.'),
  });

  const delReceipt = useMutation({
    mutationFn: (rid: string) => receiptsApi.delete(rid),
    onSuccess: refreshItem,
  });

  const runExtract = useMutation({
    mutationFn: (m: Manual) => manualsApi.extractTasks(m._id),
    onSuccess: (res, m) =>
      setExtract({
        manualId: m._id,
        title: res.data.manualTitle || m.title,
        tasks: res.data.tasks || [],
        selected: new Set((res.data.tasks || []).map((_, i) => i)),
      }),
    onError: (e: any) => Alert.alert('Extract failed', e.response?.data?.error || 'Could not extract tasks.'),
  });

  // Extracted tasks are built + sealed on-device now (Signal-parity D4) — the
  // server /create-tasks route (plaintext, no enc) is gone.
  const createTasks = useMutation({
    mutationFn: async () => {
      const tasks = extract!.tasks.filter((_, i) => extract!.selected.has(i));
      for (const t of tasks) {
        await createTaskFromManualExtract(t, { itemId: id, currentKm: odoQ.data?.currentKm ?? undefined });
      }
    },
    onSuccess: () => {
      setExtract(null);
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });

  const confirmDelete = () =>
    Alert.alert('Delete item?', `Permanently delete "${item?.name}" and its manuals and receipts?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Item',
      headerRight: () => (
        <HeaderIconButton icon="pencil" accessibilityLabel="Edit item" onPress={() => navigation.navigate('ItemForm', { id })} />
      ),
    });
  }, [navigation, id]);

  if (itemQ.isLoading || !item) {
    return <SkeletonDetail />;
  }

  const cfg = itemTypeConfig(item.type);
  const hasManuals = !!item.manuals?.length;
  // The manuals card also shows the divider while an AI lookup/extract is active.
  const hasManualContent = hasManuals || !!extract || lookup.state !== 'idle';
  const hasReceipts = !!item.receipts?.length;

  return (
    <View style={styles.root}>
    <Screen>
      <View style={styles.titleRow}>
        <IconAvatar
          mdiIcon={TYPE_ICONS[item.type || 'other'] || 'package-variant'}
          bg={TYPE_COLORS[item.type || 'other'] || '#9E9E9E'}
        />
        <ScreenTitle style={styles.itemTitleFlex}>{item.name}</ScreenTitle>
      </View>

      {/* Specs — hidden for vehicles (vehicle detail info is not shown here) */}
      {!isVehicle ? (
        <Card style={styles.infoCard}>
          {item.propertyId && typeof item.propertyId === 'object' ? (
            <ListRow icon="home-outline" title="Property" subtitle={item.propertyId.name} />
          ) : item.location ? (
            <ListRow icon="home-outline" title="Property" subtitle={item.location} />
          ) : null}
          {item.manufacturer ? <ListRow icon="business-outline" title="Manufacturer" subtitle={item.manufacturer} /> : null}
          {item.modelNumber ? <ListRow icon="barcode-outline" title="Model" subtitle={item.modelNumber} /> : null}
          {item.serialNumber ? <ListRow icon="finger-print-outline" title="Serial" subtitle={item.serialNumber} /> : null}
          {(item.customFields ?? []).filter((f) => f.value).map((f) => (
            <ListRow key={f.key} icon="ellipse-outline" title={f.key} subtitle={f.value} />
          ))}
        </Card>
      ) : null}

      {/* Service professional — a linked contact who maintains this item */}
      {servicePro ? (
        <Card style={styles.infoCard}>
          <ListRow
            icon="briefcase-outline"
            title="Service Professional"
            subtitle={servicePro.businessName ? `${servicePro.name} · ${servicePro.businessName}` : servicePro.name}
            onPress={() => navigation.navigate('ContactDetail', { id: servicePro._id })}
          />
        </Card>
      ) : null}

      {item.notes ? (
        <Card style={styles.textCard}>
          <Text style={styles.overline}>Notes</Text>
          <Text style={styles.body}>{item.notes}</Text>
        </Card>
      ) : null}

      {/* Odometer (vehicles) */}
      {isVehicle ? (
        <Card style={styles.odoCard}>
          <View style={styles.odoHeader}>
            <TouchableOpacity style={styles.odoHeaderTitle} onPress={() => setOdoExpanded((v) => !v)}>
              <Text style={styles.odoTitle}>
                Odometer{odoQ.data?.currentKm != null ? ` · ${odoQ.data.currentKm.toLocaleString()} km` : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setOdoExpanded(true);
                setOdoAdding((v) => !v);
              }}
              style={styles.odoHeaderBtn}
              accessibilityLabel="Add odometer reading"
            >
              <Ionicons name="add-circle-outline" size={24} color={accent} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setOdoExpanded((v) => !v)} style={styles.odoHeaderBtn}>
              <Ionicons name={odoExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          {odoExpanded ? (
            <>
              <Divider />
              {odoAdding ? (
                <View style={styles.odoForm}>
                  <View style={styles.odoInputWrap}>
                    <Input
                      placeholder="Current reading (km)"
                      keyboardType="numeric"
                      value={odomReading}
                      onChangeText={setOdomReading}
                      autoFocus
                      style={styles.odoInput}
                    />
                    {/* Dimmed + disabled until the decrypted readings resolve —
                        logging validates against them, so a premature tap used
                        to surface as the "still loading" error alert. */}
                    <RoundIconButton
                      icon="add"
                      size={32}
                      bg={accent}
                      disabled={!odomReading || logOdo.isPending || !odoQ.data}
                      onPress={() => logOdo.mutate()}
                      style={[styles.odoLogBtn, !odoQ.data && styles.odoLogPending]}
                    />
                  </View>
                </View>
              ) : null}
              {odoQ.data?.logs?.length ? (
                <>
                  {odoQ.data.logs.slice(0, 5).map((log) => (
                    <ListRow
                      key={log._id}
                      icon="speedometer-outline"
                      title={`${Number(log.reading).toLocaleString()} km`}
                      subtitle={log.notes}
                      right={<Text style={styles.odoLogDate}>{formatCalendarDate(log.recordedAt)}</Text>}
                    />
                  ))}
                </>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      {/* Manuals */}
      <Card style={styles.sectionCard}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Manuals</Text>
          <View style={styles.manualActions}>
            {runLookup.isPending || upload.isPending ? (
              <ActivityIndicator size="small" color="#fff" style={styles.iconBtn} />
            ) : (
              <TouchableOpacity onPress={openManualsMenu} style={styles.iconBtn} accessibilityLabel="Manual options">
                <Ionicons name="ellipsis-vertical" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        </View>
        {hasManualContent ? <Divider /> : null}
        {item.manuals?.map((m) => (
          <View key={m._id} style={styles.manualRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.manualTitle}>{m.encrypted ? '🔒 ' : ''}{m.title}</Text>
              <Text style={styles.manualSub}>
                {(m.fileSizeBytes / 1024 / 1024).toFixed(1)} MB · {m.source}
              </Text>
            </View>
            <TouchableOpacity onPress={() => openManual.mutate(m)} style={styles.iconBtn}>
              {openManual.isPending && openManual.variables?._id === m._id ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name={m.encrypted ? 'lock-open-outline' : 'eye-outline'} size={20} color="#fff" />
              )}
            </TouchableOpacity>
            {aiEnabled ? (
              <TouchableOpacity
                onPress={() => runExtract.mutate(m)}
                style={styles.iconBtn}
                accessibilityLabel="Extract maintenance tasks with AI"
              >
                {runExtract.isPending && runExtract.variables?._id === m._id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="download-outline" size={20} color="#fff" />
                )}
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={() => delManual.mutate(m._id)} style={styles.iconBtn}>
              <Ionicons name="trash-outline" size={20} color={colors.error} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Extracted tasks review */}
        {extract ? (
          <View style={styles.pad}>
            <Text style={styles.overline}>Tasks from {extract.title}</Text>

            {extract.tasks.length === 0 ? (
              <Text style={styles.body}>No maintenance schedule found.</Text>
            ) : (
              extract.tasks.map((t, i) => {
                const on = extract.selected.has(i);
                return (
                  <TouchableOpacity
                    key={i}
                    style={styles.extractRow}
                    onPress={() =>
                      setExtract((e) => {
                        if (!e) return e;
                        const sel = new Set(e.selected);
                        on ? sel.delete(i) : sel.add(i);
                        return { ...e, selected: sel };
                      })
                    }
                  >
                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? colors.primary : colors.textMuted} />
                    <View style={{ flex: 1, marginLeft: spacing.sm }}>
                      <Text style={styles.body}>{t.title}</Text>
                      <Text style={styles.manualSub}>{recurrenceLabel(t.recurrence)}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
            {extract.tasks.length > 0 ? (
              <View style={styles.row}>
                <Button title="Cancel" color={accent} onPress={() => setExtract(null)} />
                <View style={{ flex: 1 }}>
                  <Button
                    title={`Create ${extract.selected.size} Task${extract.selected.size === 1 ? '' : 's'}`}
                    color={accent}
                    loading={createTasks.isPending}
                    disabled={extract.selected.size === 0}
                    onPress={() => createTasks.mutate()}
                  />
                </View>
              </View>
            ) : (
              <Button title="Close" color={accent} onPress={() => setExtract(null)} />
            )}
          </View>
        ) : null}

        {/* Lookup — shimmer where the candidate rows (title + domain) will land. */}
        {lookup.state === 'searching' ? (
          <View style={styles.pad}>
            <SkeletonRows count={4} />
          </View>
        ) : null}
        {lookup.state === 'done' && lookup.candidates.length > 0 ? (
          <View style={styles.pad}>
            <Text style={styles.overline}>Found for {lookup.query}</Text>
            {/* Claude ranks its best pick to index 0; show only that until the user asks for more. */}
            {(showAllManuals ? lookup.candidates : lookup.candidates.slice(0, 1)).map((c, i) => (
              <View key={i} style={styles.manualRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.manualTitle} numberOfLines={2}>{c.title || c.domain}</Text>
                  {i === 0 && c.recommended ? <Text style={[styles.recommendedTag, { color: accent }]}>Recommended</Text> : null}
                  <Text style={styles.manualSub} numberOfLines={1}>{c.domain}</Text>
                </View>
                <View style={styles.candidateActions}>
                  <TouchableOpacity onPress={() => viewCandidate(c)} style={styles.iconBtn} accessibilityLabel="Preview manual">
                    <Ionicons name="eye-outline" size={20} color={accent} />
                  </TouchableOpacity>
                  <Button title="Save" color={accent} loading={saveCandidate.isPending && saveCandidate.variables === c} onPress={() => saveCandidate.mutate(c)} />
                </View>
              </View>
            ))}
            {!showAllManuals && lookup.candidates.length > 1 ? (
              <Button title="See more options" color={accent} onPress={() => setShowAllManuals(true)} />
            ) : null}
          </View>
        ) : null}
        {lookup.state === 'done' && lookup.candidates.length === 0 ? (
          <Text style={[styles.body, styles.pad]}>No manuals found for {lookup.query}. Try uploading one instead.</Text>
        ) : null}
        {lookup.state === 'error' && lookup.quota ? (
          <View style={styles.pad}>
            <QuotaBlockedNotice message={lookup.error} />
          </View>
        ) : null}
        {lookup.state === 'error' && !lookup.quota ? <Text style={[styles.body, styles.pad]}>{lookup.error}</Text> : null}
      </Card>

      {/* Receipts */}
      <Card style={styles.sectionCard}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Receipts</Text>
          {addReceipt.isPending ? (
            <ActivityIndicator size="small" color={accent} />
          ) : (
            <TouchableOpacity onPress={openReceiptsMenu} accessibilityLabel="Add receipt">
              <Ionicons name="add-circle-outline" size={24} color={accent} />
            </TouchableOpacity>
          )}
        </View>
        {hasReceipts ? <Divider /> : null}
        {hasReceipts ? (
          item.receipts!.map((r) => (
            <View key={r._id} style={styles.manualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.manualTitle}>{r.encrypted ? '🔒 ' : ''}{r.title}</Text>
                <Text style={styles.manualSub}>
                  {r.fileSizeBytes ? `${(r.fileSizeBytes / 1024 / 1024).toFixed(1)} MB` : ''}
                  {r.createdAt ? `${r.fileSizeBytes ? ' · ' : ''}${formatCalendarDate(r.createdAt)}` : ''}
                </Text>
              </View>
              <TouchableOpacity onPress={() => openReceipt.mutate(r)} style={styles.iconBtn}>
                {openReceipt.isPending && openReceipt.variables?._id === r._id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name={r.encrypted ? 'lock-open-outline' : 'eye-outline'} size={20} color="#fff" />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => delReceipt.mutate(r._id)} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              </TouchableOpacity>
            </View>
          ))
        ) : null}
      </Card>

      {/* Related tasks */}
      <Card style={styles.sectionCard}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Maintenance Tasks</Text>
          <TouchableOpacity
            onPress={() =>
              navigation.navigate('TaskForm', {
                itemId: id,
                categoryId:
                  item.categoryId && typeof item.categoryId === 'object'
                    ? item.categoryId._id
                    : (item.categoryId as string) || undefined,
              })
            }
          >
            <Ionicons name="add-circle-outline" size={24} color={accent} />
          </TouchableOpacity>
        </View>
        {tasksQ.data?.length ? (
          <>
            <Divider />
            {(showAllTasks ? tasksQ.data : tasksQ.data.slice(0, TASKS_COLLAPSED_COUNT)).map((t: Task) => (
              <ListRow
                key={t._id}
                mdiIcon={resolveTaskIcon(
                  t.icon,
                  typeof t.categoryId === 'object' ? t.categoryId?.name : null,
                )}
                title={t.title}
                subtitle={recurrenceLabel(t.recurrence)}
                onPress={() => navigation.navigate('TaskDetail', { id: t._id })}
              />
            ))}
            {tasksQ.data.length > TASKS_COLLAPSED_COUNT ? (
              <TouchableOpacity style={styles.showAllRow} onPress={() => setShowAllTasks((v) => !v)}>
                <Text style={[styles.showAllText, { color: accent }]}>
                  {showAllTasks ? 'Show less' : `Show all ${tasksQ.data.length} tasks`}
                </Text>
                <Ionicons name={showAllTasks ? 'chevron-up' : 'chevron-down'} size={16} color={accent} />
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}
      </Card>

      <View style={styles.deleteWrap}>
        <Button title="Delete item" variant="danger" loading={del.isPending} onPress={confirmDelete} />
      </View>
    </Screen>
    {aiEnabled && (
      <Fab bg={accent} onPress={() => navigation.navigate('MaintenanceChat', { itemId: id, itemName: item?.name })}>
        <CalenChatIcon size={26} color="#fff" />
      </Fab>
    )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md, paddingLeft: spacing.md },
  itemTitleFlex: { flex: 1 },
  deleteWrap: { marginTop: spacing.sm, marginBottom: 96 },
  infoCard: { padding: 0, paddingVertical: spacing.xs, marginBottom: spacing.md },
  textCard: { marginBottom: spacing.md },
  sectionCard: { padding: 0, marginBottom: spacing.md },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, paddingHorizontal: spacing.md },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: spacing.md, paddingVertical: spacing.md },
  overline: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginBottom: spacing.sm },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  pad: { padding: spacing.md, gap: spacing.sm },
  odoCard: { padding: 0, marginBottom: spacing.md },
  odoHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md },
  odoHeaderTitle: { flex: 1 },
  odoHeaderBtn: { paddingLeft: spacing.md },
  odoTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  odoForm: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  odoInputWrap: { position: 'relative' },
  // Leave room on the right so the numeric reading never slides under the button.
  odoInput: { paddingRight: 48 },
  // top ≈ (field height ~45 − button 32) / 2 to vertically centre on the field.
  odoLogBtn: { position: 'absolute', right: 8, top: 7 },
  // The pending look while the sealed readings are still decrypting.
  odoLogPending: { opacity: 0.4 },
  odoLogDate: { fontSize: 13, color: colors.textMuted },
  manualRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 4 },
  manualTitle: { fontSize: 15, fontWeight: '500', color: colors.text },
  manualSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  recommendedTag: { fontSize: 11, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', marginTop: 2 },
  candidateActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  manualActions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  showAllRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: spacing.md },
  showAllText: { fontSize: 14, fontWeight: '600' },
  iconBtn: { padding: 6 },
  extractRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
});
