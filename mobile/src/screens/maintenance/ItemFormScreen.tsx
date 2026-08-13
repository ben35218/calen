import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, Platform, ActionSheetIOS } from 'react-native';
import { Text } from '../../components/Text';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MaterialCommunityIcons, Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { itemsApi, propertiesApi, contactsApi, Item, Property, Contact, CustomField, FormAssistField } from '../../api';
import { loadCategories } from '../../lib/categories';
import { ITEM_ENC } from '../../lib/encSubsets';
import { sealNew, sealUpdate, openRecord } from '../../lib/e2ee';
import { useAiEnabled } from '../../lib/privacyPrefs';
import { ASSISTANT_NAME } from '../../config';
import { takePhoto, pickImage } from '../../lib/media';
import { uploadFile } from '../../lib/upload';

// Encrypted item content (categoryId/type/dates stay plaintext).
import { Input, Select, Screen, SectionTitle, SwitchRow, DateField, useHeaderCheckButton, FormError, CenteredLoader, Button, Skeleton } from '../../components/ui';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import { useCalendarColors } from '../../lib/calendarPrefs';
import FormAssist from '../../components/FormAssist';
import HouseholdItemIcon from '../../components/HouseholdItemIcon';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { mdiName } from '../../lib/recurrence';
import { ITEM_TYPES, itemTypeConfig, TYPE_CATEGORY_MATCH, VEHICLE_CATEGORY, ItemField } from '../../lib/itemTypes';
import { popPastDetail } from '../../navigation/rebindDetailBelow';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'ItemForm'>;
type Rt = RouteProp<MaintenanceStackParamList, 'ItemForm'>;

// Core (non-custom) form fields written by `field.model`.
interface CoreForm {
  name: string;
  type: string;
  categoryId: string | null;
  propertyId: string | null;
  serviceProId: string | null;
  location: string;
  manufacturer: string;
  modelNumber: string;
  serialNumber: string;
  notes: string;
  autoLookupManual: boolean;
}

const EMPTY: CoreForm = {
  name: '',
  type: 'other',
  categoryId: null,
  propertyId: null,
  serviceProId: null,
  location: 'Home',
  manufacturer: '',
  modelNumber: '',
  serialNumber: '',
  notes: '',
  autoLookupManual: true,
};

export default function ItemFormScreen() {
  const navigation = useNavigation<Nav>();
  const { id, prefill } = useRoute<Rt>().params || {};
  const isEdit = !!id;
  const qc = useQueryClient();
  const accent = useCalendarColors().colors.maintenance;
  const aiEnabled = useAiEnabled();

  // Staged add wizard: scope → mode → branch → (property → category) → form.
  // Editing or a photo prefill jumps straight to the form. The scope step lets
  // the user pick single-item vs. the bulk task-template flow; "single" then
  // continues to the photo/manual choice (or branch, when AI is off).
  type Step = 'scope' | 'mode' | 'branch' | 'property' | 'category' | 'form';
  const initialStep: Step = isEdit || prefill ? 'form' : 'scope';
  const [step, setStep] = useState<Step>(initialStep);
  const [scanning, setScanning] = useState(false);
  const [form, setForm] = useState<CoreForm>(EMPTY);
  const [customMap, setCustomMap] = useState<Record<string, string>>({});
  const [userFields, setUserFields] = useState<CustomField[]>([]);
  const [error, setError] = useState('');
  // A new item's form is ready immediately; an edit waits for the item to load
  // and seed below before the discard guard snapshots its clean baseline.
  const [seeded, setSeeded] = useState(!isEdit);
  const assist = useFormAssist();

  const set = (patch: Partial<CoreForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    assist.clear(Object.keys(patch));
  };
  const cfg = itemTypeConfig(form.type);

  // Keys this type renders as preset slots (so loaded customFields split correctly).
  const presetKeys = useMemo(
    () => new Set(cfg.fieldGroups.flatMap((g) => g.fields.filter((f) => f.customKey).map((f) => f.customKey!))),
    [cfg]
  );

  // Decrypted (names are sealed content — Signal-parity D5).
  const categoriesQ = useQuery({ queryKey: ['categories', 'topLevel'], queryFn: () => loadCategories({ topLevel: 'true' }) });
  const propertiesQ = useQuery({ queryKey: ['properties'], queryFn: async () => (await propertiesApi.list()).data });
  // Item counts per property (propertyId is plaintext, so no decryption needed).
  // Drives the "delete empty property" affordance in the picker.
  const itemsCountQ = useQuery({ queryKey: ['items', 'list'], queryFn: async () => (await itemsApi.list()).data });
  const propItemCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of itemsCountQ.data ?? []) {
      const pid = it.propertyId && typeof it.propertyId === 'object' ? it.propertyId._id : (it.propertyId as string) || null;
      if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    return counts;
  }, [itemsCountQ.data]);
  const selectedProperty = useMemo(
    () => propertiesQ.data?.find((p) => p._id === form.propertyId),
    [propertiesQ.data, form.propertyId]
  );

  // Category options: vehicles are locked to the "Vehicles" category (so keep it
  // available to render the value); property items can't be filed under it.
  const isVehicle = form.type === 'vehicle';
  const categoryOptions = useMemo(() => {
    const cats = categoriesQ.data ?? [];
    return (isVehicle ? cats : cats.filter((c) => c.name !== VEHICLE_CATEGORY)).map((c) => ({
      label: c.name,
      value: c._id,
    }));
  }, [categoriesQ.data, isVehicle]);

  const assistFields: FormAssistField[] = useMemo(
    () => [
      { name: 'name', type: 'text', label: 'Item name' },
      { name: 'type', type: 'select', label: 'Type', options: ITEM_TYPES.map((t) => ({ label: t.label, value: t.value })) },
      // Vehicles are locked to their category; only property items can change it
      // (and never to the vehicle-only category).
      ...(isVehicle
        ? []
        : [{ name: 'categoryId', type: 'select' as const, label: 'Category', options: categoryOptions }]),
      // Vehicles stand alone (no location); only property items carry one.
      ...(isVehicle ? [] : [{ name: 'location', type: 'text' as const, label: 'Location' }]),
      { name: 'manufacturer', type: 'text', label: 'Manufacturer / brand' },
      { name: 'modelNumber', type: 'text', label: 'Model number' },
      { name: 'serialNumber', type: 'text', label: 'Serial number' },
      { name: 'notes', type: 'text', label: 'Notes' },
    ],
    [categoryOptions, isVehicle]
  );

  const applyPatch = (patch: Record<string, unknown>) => {
    const next: Partial<CoreForm> = {};
    const changedKeys: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in EMPTY)) continue;
      const val = v == null ? '' : v;
      if ((form as any)[k] !== val) changedKeys.push(k);
      (next as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...next }));
    assist.mark(changedKeys);
  };

  const applyCustomFields = (fields: CustomField[] | undefined, keys: Set<string>) => {
    const map: Record<string, string> = {};
    const extra: CustomField[] = [];
    for (const cf of fields || []) {
      if (keys.has(cf.key)) map[cf.key] = cf.value;
      else extra.push(cf);
    }
    setCustomMap(map);
    setUserFields(extra);
  };

  // Apply photo-scan (or route-param) extracted fields, infer the branch from the
  // detected type, match a property by location name, and drop the user on the form.
  const applyPrefill = (data: Partial<Item>) => {
    const typeValue = ITEM_TYPES.some((t) => t.value === data.type) ? data.type! : 'other';
    const patch: Partial<CoreForm> = {
      name: data.name ?? '',
      type: typeValue,
      location: data.location || 'Home',
      manufacturer: data.manufacturer ?? '',
      modelNumber: data.modelNumber ?? '',
      serialNumber: data.serialNumber ?? '',
      notes: data.notes ?? '',
    };
    // Non-vehicles belong to a property; match the detected location to one.
    if (typeValue !== 'vehicle') {
      const match = propertiesQ.data?.find(
        (p) => p.name.toLowerCase() === (data.location || '').trim().toLowerCase()
      );
      if (match) {
        patch.propertyId = match._id;
        patch.location = match.name;
      }
    }
    set(patch);
    const keys = new Set(
      itemTypeConfig(typeValue).fieldGroups.flatMap((g) => g.fields.filter((f) => f.customKey).map((f) => f.customKey!))
    );
    applyCustomFields(data.customFields, keys);
    setStep('form');
  };

  // Prefill from a photo scan handed in via route param — review-and-save flow.
  useEffect(() => {
    if (prefill) applyPrefill(prefill);
  }, [prefill]);

  // Editing an existing item: fold detected fields into the current form rather
  // than resetting it — fill non-empty values, don't touch type/property, and
  // merge custom fields into empty slots. Highlights what changed for review.
  const applyScan = (data: Partial<Item>) => {
    const patch: Partial<CoreForm> = {};
    for (const k of ['name', 'manufacturer', 'modelNumber', 'serialNumber', 'notes', 'location'] as const) {
      const v = data[k];
      if (v != null && v !== '') (patch as any)[k] = v;
    }
    applyPatch(patch);
    if (data.customFields?.length) {
      setCustomMap((m) => {
        const next = { ...m };
        for (const cf of data.customFields!) if (presetKeys.has(cf.key) && !next[cf.key]) next[cf.key] = cf.value;
        return next;
      });
      setUserFields((arr) => {
        const have = new Set(arr.map((f) => f.key));
        const add = data.customFields!.filter((cf) => !presetKeys.has(cf.key) && cf.value && !have.has(cf.key));
        return add.length ? [...arr, ...add] : arr;
      });
    }
  };

  const scan = async (mode: 'camera' | 'library') => {
    const file = mode === 'camera' ? await takePhoto() : await pickImage();
    if (!file) return;
    setScanning(true);
    try {
      const data = await uploadFile<Item>('/items/from-photo', file, 'photo');
      isEdit ? applyScan(data) : applyPrefill(data);
    } catch (e: any) {
      Alert.alert('Scan failed', e.response?.data?.error || 'Could not extract details from that photo.');
    } finally {
      setScanning(false);
    }
  };

  const onAddPhoto = () =>
    Alert.alert('Add from Photo', 'Take a photo of a label or nameplate — AI fills in the details.', [
      { text: 'Take Photo', onPress: () => scan('camera') },
      { text: 'Choose from Library', onPress: () => scan('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  // Select a property and keep `location` in sync (so the items-list grouping
  // stays meaningful). Callers decide whether to also advance the wizard.
  const applyProperty = (prop: Property) => set({ propertyId: prop._id, location: prop.name });

  const addProperty = (onDone?: () => void) => {
    Alert.prompt?.('New property', 'Name this property (e.g. Cabin, Rental)', async (name?: string) => {
      const trimmed = (name || '').trim();
      if (!trimmed) return;
      try {
        const { data } = await propertiesApi.create({ name: trimmed });
        qc.invalidateQueries({ queryKey: ['properties'] });
        applyProperty(data);
        onDone?.();
      } catch (e: any) {
        Alert.alert('Could not add property', e.response?.data?.error || 'Please try again.');
      }
    });
  };

  // Delete a property. When it has items the server cascades — items and their
  // maintenance tasks go too — so warn accordingly. Clears the form's selection
  // if it pointed at the deleted property.
  const deleteProperty = (prop: Property) => {
    const n = propItemCount.get(prop._id) ?? 0;
    const msg =
      n > 0
        ? `Delete “${prop.name}” and its ${n} item${n === 1 ? '' : 's'}, including their maintenance tasks? This can’t be undone.`
        : `Delete “${prop.name}”?`;
    Alert.alert('Delete property', msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await propertiesApi.delete(prop._id);
            qc.invalidateQueries({ queryKey: ['properties'] });
            qc.invalidateQueries({ queryKey: ['items'] });
            qc.invalidateQueries({ queryKey: ['tasks'] });
            qc.invalidateQueries({ queryKey: ['maintenance'] });
            qc.invalidateQueries({ queryKey: ['calendar'] });
            if (form.propertyId === prop._id) set({ propertyId: null, location: '' });
          } catch (e: any) {
            Alert.alert('Could not delete property', e.response?.data?.error || 'Please try again.');
          }
        },
      },
    ]);
  };

  // Sentinel option that turns "Add property…" into a create action inside the
  // in-form property Select (keeps creation in the same sheet as the choices).
  const ADD_PROPERTY = '__add_property__';

  // Service professionals are type:'service' contacts from the user's contacts.
  // Decrypt over plaintext (dual-write); the roster refreshes automatically when
  // ContactForm/ContactImport invalidate ['contacts'] after an add/import.
  const contactsQ = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const rows = (await contactsApi.list()).data;
      return Promise.all(rows.map((p) => openRecord('Contact', p))) as Promise<Contact[]>;
    },
  });
  const serviceContacts = useMemo(
    () => (contactsQ.data ?? []).filter((p) => p.type === 'service'),
    [contactsQ.data]
  );

  // After launching the add/import flow, auto-select the one new service pro that
  // appears in the roster on return (so "add from the form" actually links it).
  const awaitingNewPro = useRef(false);
  const preAddServiceIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!awaitingNewPro.current) return;
    const newIds = serviceContacts.map((p) => p._id).filter((pid) => !preAddServiceIds.current.has(pid));
    if (newIds.length === 1) set({ serviceProId: newIds[0] });
    if (newIds.length >= 1) awaitingNewPro.current = false; // ambiguous (>1): let the user pick
  }, [serviceContacts]);

  const openAddServicePro = () => {
    awaitingNewPro.current = true;
    preAddServiceIds.current = new Set(serviceContacts.map((p) => p._id));
    const addManually = () => navigation.navigate('ContactForm', { type: 'service' });
    const importContacts = () => navigation.navigate('ContactImport');
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Add', 'Import from Contacts', 'Cancel'], cancelButtonIndex: 2 },
        (i) => {
          if (i === 0) addManually();
          else if (i === 1) importContacts();
        }
      );
    } else {
      Alert.alert('Service professional', undefined, [
        { text: 'Add', onPress: addManually },
        { text: 'Import from Contacts', onPress: importContacts },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const itemQ = useQuery({
    queryKey: ['items', id],
    queryFn: async () => (await itemsApi.get(id!)).data,
    enabled: isEdit,
  });

  useEffect(() => {
    if (!itemQ.data) return;
    let cancelled = false;
    (async () => {
    const it = await openRecord('Item', itemQ.data); // decrypt content over plaintext
    if (cancelled) return;
    const catId = it.categoryId && typeof it.categoryId === 'object' ? it.categoryId._id : (it.categoryId as string) || null;
    const propId = it.propertyId && typeof it.propertyId === 'object' ? it.propertyId._id : (it.propertyId as string) || null;
    const proId = it.serviceProId && typeof it.serviceProId === 'object' ? it.serviceProId._id : (it.serviceProId as string) || null;
    set({
      name: it.name ?? '',
      type: it.type ?? 'other',
      categoryId: catId,
      propertyId: propId,
      serviceProId: proId,
      location: it.location ?? 'Home',
      manufacturer: it.manufacturer ?? '',
      modelNumber: it.modelNumber ?? '',
      serialNumber: it.serialNumber ?? '',
      notes: it.notes ?? '',
    });
    const keys = new Set(
      itemTypeConfig(it.type).fieldGroups.flatMap((g) => g.fields.filter((f) => f.customKey).map((f) => f.customKey!))
    );
    applyCustomFields(it.customFields, keys);
    setSeeded(true);
    })();
    return () => { cancelled = true; };
  }, [itemQ.data]);

  useEffect(() => {
    navigation.setOptions({ title: isEdit ? 'Edit Item' : 'Add Item' });
  }, [navigation, isEdit]);

  const selectType = (typeValue: string) => {
    set({ type: typeValue });
    const catName = TYPE_CATEGORY_MATCH[typeValue];
    if (catName && !form.categoryId) {
      const cat = categoriesQ.data?.find((c) => c.name === catName);
      if (cat) set({ type: typeValue, categoryId: cat._id });
    }
    setStep('form');
  };

  // Branch picker: Vehicle stands alone; Property continues to the property picker.
  const selectBranch = (branch: 'vehicle' | 'property') => {
    if (branch === 'vehicle') {
      set({ propertyId: null });
      selectType('vehicle');
    } else {
      setStep('property');
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const presetFields = Object.entries(customMap)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([key, value]) => ({ key, value }));
      const extra = userFields.filter((f) => f.key.trim());
      const payload: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        notes: form.notes,
        autoLookupManual: form.autoLookupManual,
        customFields: [...presetFields, ...extra],
      };
      if (form.categoryId) payload.categoryId = form.categoryId;
      // Vehicles stand alone (no location/property); only property items carry
      // a location (kept in sync with the chosen property) and a propertyId.
      if (form.type !== 'vehicle') {
        payload.location = form.location;
        if (form.propertyId) payload.propertyId = form.propertyId;
      }
      // Null (rather than omit) so clearing the service pro persists on edit.
      payload.serviceProId = form.serviceProId || null;
      if (form.manufacturer) payload.manufacturer = form.manufacturer;
      if (form.modelNumber) payload.modelNumber = form.modelNumber;
      if (form.serialNumber) payload.serialNumber = form.serialNumber;
      return isEdit
        ? itemsApi.update(id!, await sealUpdate('Item', id!, payload, ITEM_ENC(payload)))
        : itemsApi.create(await sealNew('Item', payload, ITEM_ENC(payload)));
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['items'] });
      const newId = (res.data as Item)?._id;
      allowLeave();
      if (!isEdit && newId) navigation.replace('ItemDetail', { id: newId });
      else navigation.goBack();
    },
    onError: (e: any) => setError(e.response?.data?.error || 'Save failed'),
  });

  const onSave = () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');
    save.mutate();
  };

  // Delete from the edit form — the same control the item's detail page carries.
  // An item has no occurrences to scope against, so this is the plain confirm,
  // worded like ItemDetail's because the server cascade is the same: the item
  // takes its manuals and receipts with it.
  const del = useMutation({
    mutationFn: () => itemsApi.delete(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] });
      // Tasks hang off the item and go with it.
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      allowLeave();
      // Past the detail below, which is bound to what was just deleted.
      popPastDetail(navigation, 'ItemDetail');
    },
    onError: (e: any) => Alert.alert("Couldn't delete item", e.response?.data?.error || 'Delete failed'),
  });

  const onDelete = () =>
    Alert.alert('Delete item?', `Permanently delete “${form.name}” and its manuals and receipts?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate() },
    ]);

  // No save during the add wizard — only once the form itself is shown.
  useHeaderCheckButton(navigation, { onPress: onSave, loading: save.isPending, color: accent, enabled: step === 'form' });

  // Discard guard: only meaningful once the form itself is shown (the wizard
  // steps carry no typed-in data to lose). Baseline is the form as it enters the
  // 'form' step — for a manual add that already includes the wizard's type/
  // property picks — so only edits made on the form count as unsaved.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ form, customMap, userFields });
  useEffect(() => {
    if (step === 'form' && seeded && baselineRef.current === null) baselineRef.current = snapshot;
  }, [step, seeded, snapshot]);
  const dirty = step === 'form' && seeded && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(navigation, dirty);

  if (isEdit && itemQ.isLoading) {
    return (
      <CenteredLoader color={accent} />
    );
  }

  // Wizard step 0: one item, or many maintenance tasks at once?
  if (step === 'scope') {
    return (
      <Screen>
        <Text style={styles.intro}>What would you like to add?</Text>
        <GroupCard>
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => setStep(aiEnabled ? 'mode' : 'branch')}>
            <View style={[styles.typeAvatar, { backgroundColor: accent }]}>
              <HouseholdItemIcon size={26} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Add a single item</Text>
              <Text style={styles.typeDesc}>Add one appliance, vehicle, system, or structure.</Text>
            </View>
          </TouchableOpacity>
          <CardDivider />
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => navigation.navigate('TaskTemplates', { mode: 'multi' })}>
            <View style={[styles.typeAvatar, { backgroundColor: '#FF9800' }]}>
              <MaterialCommunityIcons name="clipboard-list-outline" size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Add multiple tasks</Text>
              <Text style={styles.typeDesc}>Pick maintenance tasks from templates — items are created for you.</Text>
            </View>
          </TouchableOpacity>
          {aiEnabled ? (
            <>
              <CardDivider />
              <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => navigation.navigate('Assistant', { initial: 'maintenance' })}>
                <View style={[styles.typeAvatar, { backgroundColor: '#7C4DFF' }]}>
                  <MaterialCommunityIcons name="creation" size={24} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.typeLabel}>Add tasks with {ASSISTANT_NAME} AI</Text>
                  <Text style={styles.typeDesc}>Chat with {ASSISTANT_NAME} to build a maintenance plan — tasks are created once you're done.</Text>
                </View>
              </TouchableOpacity>
            </>
          ) : null}
        </GroupCard>
      </Screen>
    );
  }

  // Wizard step 1: how do you want to add this item?
  if (step === 'mode') {
    return (
      <Screen>
        <Text style={styles.intro}>How would you like to add this item?</Text>
        <GroupCard>
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={onAddPhoto} disabled={scanning}>
            <View style={[styles.typeAvatar, { backgroundColor: accent }]}>
              {scanning ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Ionicons name="camera-outline" size={24} color="#fff" />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Add from photo</Text>
              <Text style={styles.typeDesc}>Snap a label or nameplate — AI fills in the details.</Text>
            </View>
          </TouchableOpacity>
          <CardDivider />
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => setStep('branch')} disabled={scanning}>
            <View style={[styles.typeAvatar, { backgroundColor: colors.textMuted }]}>
              <MaterialCommunityIcons name="pencil" size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Enter manually</Text>
              <Text style={styles.typeDesc}>Fill in the details yourself.</Text>
            </View>
          </TouchableOpacity>
        </GroupCard>
      </Screen>
    );
  }

  // Wizard step 2: Vehicle or Property?
  if (step === 'branch') {
    return (
      <Screen>
        <Text style={styles.intro}>What kind of item is this?</Text>
        <GroupCard>
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => selectBranch('vehicle')}>
            <View style={[styles.typeAvatar, { backgroundColor: '#607D8B' }]}>
              <MaterialCommunityIcons name="car" size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Vehicle</Text>
              <Text style={styles.typeDesc}>Car, truck, tractor, ATV, snowblower…</Text>
            </View>
          </TouchableOpacity>
          <CardDivider />
          <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => selectBranch('property')}>
            <View style={[styles.typeAvatar, { backgroundColor: '#4CAF50' }]}>
              <MaterialCommunityIcons name="home" size={24} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.typeLabel}>Property item</Text>
              <Text style={styles.typeDesc}>Appliance, system, structure, or equipment.</Text>
            </View>
          </TouchableOpacity>
        </GroupCard>
      </Screen>
    );
  }

  // Wizard step 3 (property branch): which property is this item at?
  if (step === 'property') {
    return (
      <Screen>
        <Text style={styles.intro}>Which property is this item at?</Text>
        {propertiesQ.isLoading ? (
          // Shimmer the property rows' shape (avatar disc + name) so the card
          // loads in place rather than popping in after a bare spinner.
          <GroupCard>
            {[0, 1].map((i) => (
              <React.Fragment key={i}>
                {i > 0 ? <CardDivider /> : null}
                <View style={styles.typeRow}>
                  <Skeleton width={44} height={44} radius={22} />
                  <Skeleton width={i ? '38%' : '52%'} height={15} />
                </View>
              </React.Fragment>
            ))}
          </GroupCard>
        ) : (
          <GroupCard>
            {(propertiesQ.data ?? []).map((p, i) => (
              <React.Fragment key={p._id}>
                {i > 0 ? <CardDivider /> : null}
                <TouchableOpacity
                  style={styles.typeRow}
                  activeOpacity={0.7}
                  onPress={() => { applyProperty(p); setStep('category'); }}
                  onLongPress={() => deleteProperty(p)}
                >
                  <View style={[styles.typeAvatar, { backgroundColor: p.color || '#4CAF50' }]}>
                    <MaterialCommunityIcons name={mdiName(p.icon || 'mdi-home') as any} size={24} color="#fff" />
                  </View>
                  <Text style={[styles.typeLabel, { flex: 1 }]}>{p.name}</Text>
                  {form.propertyId === p._id ? (
                    <Ionicons name="checkmark" size={20} color={accent} />
                  ) : (
                    <TouchableOpacity onPress={() => deleteProperty(p)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                      <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              </React.Fragment>
            ))}
            <CardDivider />
            <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => addProperty(() => setStep('category'))}>
              <View style={[styles.typeAvatar, { backgroundColor: colors.border }]}>
                <Ionicons name="add" size={24} color={colors.textMuted} />
              </View>
              <Text style={[styles.typeLabel, { flex: 1, color: colors.primary }]}>Add a property</Text>
            </TouchableOpacity>
          </GroupCard>
        )}
      </Screen>
    );
  }

  // Wizard step 4 (property branch): pick a category. Vehicle is its own branch.
  if (step === 'category') {
    return (
      <Screen>
        <Text style={styles.intro}>What type of item is it?</Text>
        <GroupCard>
          {ITEM_TYPES.filter((t) => t.value !== 'vehicle').map((t, i) => (
            <React.Fragment key={t.value}>
              {i > 0 ? <CardDivider /> : null}
              <TouchableOpacity style={styles.typeRow} activeOpacity={0.7} onPress={() => selectType(t.value)}>
                <View style={[styles.typeAvatar, { backgroundColor: t.color }]}>
                  <MaterialCommunityIcons name={mdiName(t.icon) as any} size={24} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.typeLabel}>{t.label}</Text>
                  <Text style={styles.typeDesc}>{t.description}</Text>
                </View>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </GroupCard>
      </Screen>
    );
  }

  // Final step: type-specific form
  return (
    <Screen>
      {!isEdit ? (
        <View style={styles.typeChipRow}>
          <View style={[styles.typeChip, { backgroundColor: cfg.color }]}>
            <MaterialCommunityIcons name={mdiName(cfg.icon) as any} size={16} color="#fff" />
            <Text style={styles.typeChipText}>{cfg.label}</Text>
          </View>
          {!isVehicle && selectedProperty ? (
            <View style={[styles.typeChip, { backgroundColor: selectedProperty.color || '#4CAF50' }]}>
              <MaterialCommunityIcons name={mdiName(selectedProperty.icon || 'mdi-home') as any} size={16} color="#fff" />
              <Text style={styles.typeChipText}>{selectedProperty.name}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <FormAssist
        accent={accent}
        formType={`${cfg.label.toLowerCase()} (home item)`}
        placeholder={'Describe the item, e.g. "Samsung fridge, model RF28R, bought last March, 2-year warranty"'}
        fields={assistFields}
        // Custom/preset fields and user-added fields live outside `form`; fold
        // their filled values in so Calen sees them (context only — applyPatch
        // ignores keys not in the core form, so these can't be overwritten).
        current={{
          ...form,
          ...Object.fromEntries(Object.entries(customMap).filter(([, v]) => v)),
          ...Object.fromEntries(userFields.filter((f) => f.key.trim() && f.value).map((f) => [f.key, f.value])),
        }}
        onApply={applyPatch}
      />

      <SectionTitle>Basic Info</SectionTitle>
      <GroupCard>
        <Input
          value={form.name}
          onChangeText={(v) => set({ name: v })}
          placeholder={cfg.namePlaceholder || `${cfg.label} Name`}
          containerStyle={fs.headField}
          style={[fs.headInput, assist.changed.has('name') && fs.headInputHighlight]}
        />
        {/* Vehicles stand alone (no location); property items pick a property. */}
        {!isVehicle ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Property"
              placeholder="Select…"
              value={form.propertyId ?? undefined}
              options={[
                ...(propertiesQ.data ?? []).map((p) => ({ label: p.name, value: p._id })),
                { label: '＋ Add property…', value: ADD_PROPERTY },
              ]}
              onChange={(v) => {
                if (v === ADD_PROPERTY) return addProperty();
                const p = propertiesQ.data?.find((x) => x._id === v);
                if (p) applyProperty(p);
              }}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
          </>
        ) : null}
        <CardDivider />
        {/* Vehicles are locked to the "Vehicles" category; property items pick
            any category except the vehicle-only one. */}
        <Select
          clearable={!isVehicle}
          disabled={isVehicle}
          placeholder="Category"
          value={form.categoryId ?? undefined}
          options={categoryOptions}
          onChange={(v) => set({ categoryId: (v as string) ?? null })}
          highlight={assist.changed.has('categoryId')}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        {/* Photo-scan enrichment for an existing item (e.g. a placeholder created
            by the bulk task flow): AI fills the details from a label/nameplate. */}
        {isEdit && aiEnabled ? (
          <>
            <CardDivider />
            <TouchableOpacity style={styles.addProRow} activeOpacity={0.7} onPress={onAddPhoto} disabled={scanning}>
              {scanning ? (
                <ActivityIndicator color={accent} size="small" />
              ) : (
                <Ionicons name="camera-outline" size={18} color={accent} />
              )}
              <Text style={[styles.addProText, { color: accent }]}>Scan a photo to fill details</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </GroupCard>

      {cfg.fieldGroups.map((group) => (
        <View key={group.title}>
          <SectionTitle>{group.title}</SectionTitle>
          <GroupCard>
            {group.fields.map((field, i) => (
              <React.Fragment key={field.model || field.customKey}>
                {i > 0 ? <CardDivider /> : null}
                <FieldRenderer
                  field={field}
                  coreValue={field.model ? (form as any)[field.model] : undefined}
                  customValue={field.customKey ? customMap[field.customKey] : undefined}
                  highlight={!!field.model && assist.changed.has(field.model)}
                  onChangeCore={(v) => field.model && set({ [field.model]: v } as any)}
                  onChangeCustom={(v) => field.customKey && setCustomMap((m) => ({ ...m, [field.customKey!]: v }))}
                />
              </React.Fragment>
            ))}
          </GroupCard>
        </View>
      ))}

      <SectionTitle>Service Professional</SectionTitle>
      <GroupCard>
        <Select
          inlineLabel="Contact"
          clearable
          placeholder="None"
          value={form.serviceProId ?? undefined}
          options={serviceContacts.map((p) => ({
            label: p.businessName ? `${p.name} · ${p.businessName}` : p.name,
            value: p._id,
          }))}
          onChange={(v) => set({ serviceProId: (v as string) ?? null })}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
        <CardDivider />
        {/* Separate row (not a Select option) so the action sheet / navigation
            isn't fired from inside the Select's dismissing modal. */}
        <TouchableOpacity style={styles.addProRow} activeOpacity={0.7} onPress={openAddServicePro}>
          <Ionicons name="person-add-outline" size={18} color={accent} />
          <Text style={[styles.addProText, { color: accent }]}>Add or import from Contacts</Text>
        </TouchableOpacity>
      </GroupCard>

      <SectionTitle>Notes</SectionTitle>
      <Input
        value={form.notes}
        onChangeText={(v) => set({ notes: v })}
        multiline
        placeholder="Add any notes…"
        style={fs.notes}
        highlight={assist.changed.has('notes')}
      />
      {userFields.length > 0 ? (
        <GroupCard>
          {userFields.map((f, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <CardDivider /> : null}
              <View style={styles.customRow}>
                <Input
                  placeholder="Field Name"
                  value={f.key}
                  onChangeText={(v) => setUserFields((arr) => arr.map((x, j) => (j === i ? { ...x, key: v } : x)))}
                  containerStyle={[fs.headField, styles.customCol]}
                  style={fs.headInput}
                />
                <Input
                  placeholder="Value"
                  value={f.value}
                  onChangeText={(v) => setUserFields((arr) => arr.map((x, j) => (j === i ? { ...x, value: v } : x)))}
                  containerStyle={[fs.headField, styles.customCol]}
                  style={fs.headInput}
                />
                <TouchableOpacity
                  onPress={() => setUserFields((arr) => arr.filter((_, j) => j !== i))}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.removeBtn}
                >
                  <MaterialCommunityIcons name="close-circle" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            </React.Fragment>
          ))}
        </GroupCard>
      ) : null}

      {!isEdit ? (
        <GroupCard>
          <View style={fs.groupPad}>
            <SwitchRow
              label="Search for the product manual after saving"
              value={form.autoLookupManual}
              onValueChange={(v) => set({ autoLookupManual: v })}
            />
          </View>
        </GroupCard>
      ) : null}

      <FormError>{error}</FormError>

      {isEdit ? (
        <View style={fs.footer}>
          <Button title="Delete Item" variant="danger" loading={del.isPending} onPress={onDelete} />
        </View>
      ) : null}
    </Screen>
  );
}

function FieldRenderer({
  field,
  coreValue,
  customValue,
  highlight,
  onChangeCore,
  onChangeCustom,
}: {
  field: ItemField;
  coreValue?: string;
  customValue?: string;
  highlight?: boolean;
  onChangeCore: (v: string) => void;
  onChangeCustom: (v: string) => void;
}) {
  const value = field.model ? coreValue : customValue;
  const onChange = field.model ? onChangeCore : onChangeCustom;

  if (field.type === 'date') {
    return (
      <DateField
        inlineLabel={field.label}
        clearable
        placeholder="None"
        value={value ?? ''}
        onChange={onChange}
        highlight={highlight}
        containerStyle={fs.dtFieldWrap}
        fieldStyle={fs.rowField}
        valueStyle={fs.dtValue}
        hideIcon
      />
    );
  }
  if ((field.type === 'select' || field.type === 'autocomplete') && field.options) {
    return (
      <Select
        inlineLabel={field.label}
        clearable
        placeholder="None"
        value={value || undefined}
        options={field.options.map((o) => ({ label: o, value: o }))}
        onChange={(v) => onChange((v as string) ?? '')}
        highlight={highlight}
        containerStyle={fs.dtFieldWrap}
        fieldStyle={fs.rowField}
        valueStyle={fs.dtValue}
        chevronIcon="chevron-expand"
      />
    );
  }
  if (field.type === 'textarea') {
    return (
      <Input
        value={value ?? ''}
        onChangeText={onChange}
        placeholder={field.placeholder || field.label}
        multiline
        containerStyle={fs.headField}
        style={[fs.headInput, highlight && fs.headInputHighlight]}
      />
    );
  }
  return (
    <View style={fs.dtRow}>
      <Text style={fs.dtLabel}>{field.label}</Text>
      <Input
        value={value ?? ''}
        onChangeText={onChange}
        placeholder={field.placeholder}
        keyboardType={field.type === 'number' ? 'numeric' : 'default'}
        clearable={false}
        containerStyle={[fs.headField, fs.rowInputWrap]}
        style={[fs.headInput, fs.rowInput, highlight && fs.headInputHighlight]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, color: colors.textMuted, marginBottom: spacing.md },
  addProRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 14, paddingVertical: 12 },
  addProText: { fontSize: 15, fontWeight: '600' },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: 14, paddingVertical: 10 },
  typeAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  typeLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  typeDesc: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  typeChipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  typeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  typeChipText: { color: '#fff', fontWeight: '600' },
  customRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 14 },
  customCol: { flex: 1 },
  removeBtn: { marginLeft: spacing.sm },
});
