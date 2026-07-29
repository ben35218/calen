import React, { useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Alert, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { peopleApi, placesApi, Person, FormAssistField, PlacePrediction } from '../../api';
import { sealNew, sealUpdate } from '../../lib/e2ee';
import { PERSON_ENC } from '../../lib/encSubsets';
import { CALENDAR_COLORS } from '../../lib/calendar';
import {
  normalizePerson,
  denormalizeForSave,
  reciprocalUpdates,
  composeName,
  splitName,
  LabeledValue,
  RelatedName,
  PHONE_LABELS,
  EMAIL_LABELS,
  ADDRESS_LABELS,
  DATE_LABELS,
  URL_LABELS,
  RELATED_LABELS,
  DEFAULT_PHONE_LABEL,
  DEFAULT_EMAIL_LABEL,
  DEFAULT_ADDRESS_LABEL,
  DEFAULT_DATE_LABEL,
  DEFAULT_URL_LABEL,
  DEFAULT_RELATED_LABEL,
} from '../../lib/personFields';
import {
  Button, Input, DateField, Screen, SectionTitle, SectionHeader, Select, PhoneTextField,
  BottomSheet, useHeaderCheckButton, SwitchRow, ScrollToSection,
} from '../../components/ui';
import { MultiValueField } from '../../components/MultiValueField';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import { useFormAssist } from '../../hooks/useFormAssist';
import PlacesAutocomplete from '../../components/PlacesAutocomplete';
import { colors, spacing } from '../../theme';
import type { ProfileStackParamList } from '../../navigation/ProfileNavigator';

type R = RouteProp<ProfileStackParamList, 'PersonForm'>;

// Set/replace the "primary" (first) entry of a labeled list — used when the AI
// form assistant fills a single phone/email.
function setPrimary(list: LabeledValue[], value: string, label: string): LabeledValue[] {
  if (!list.length) return [{ label, value }];
  return list.map((e, i) => (i === 0 ? { ...e, value } : e));
}

// Add/edit a person or review an imported contact. The "You" card is edited
// entirely in Account; the only remaining isSelf entry point is the Birthdays
// list, where the form just points back to Account (nothing editable).
export default function PersonFormScreen() {
  const nav = useNavigation();
  const qc = useQueryClient();
  const { params } = useRoute<R>();
  const { id, isSelf, type: initialType, prefills, queueIndex = 0, focus } = params || {};

  const people = qc.getQueryData<Person[]>(['people']) || [];
  const editing = id ? people.find((p) => p._id === id) : undefined;

  // Review-mode import: the contact currently being reviewed, and whether more
  // follow it in the queue.
  const prefill = prefills?.[queueIndex];
  const inQueue = !!prefills && prefills.length > 0;
  const hasNext = inQueue && queueIndex + 1 < prefills!.length;
  const multiInQueue = inQueue && prefills!.length > 1;
  const src = editing || prefill; // shared field source for initial values

  const [type, setType] = useState<'family' | 'friend' | 'service'>(
    (src?.type as 'family' | 'friend' | 'service') || initialType || 'family'
  );
  const isService = type === 'service';

  // Fold the source (a decrypted Person or an import prefill, either shape) into
  // the multi-value form model, migrating any legacy single fields.
  const norm = useMemo(() => normalizePerson((src ?? {}) as Person), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scalar fields the AI form assistant fills (kept in `form`); the labeled
  // arrays live in their own state below.
  const [form, setForm] = useState({
    // `name` is the single field used by self + service (business) contacts;
    // firstName/lastName are the structured fields personal contacts edit (norm
    // seeds them from the record's structured fields, or splits a legacy name).
    name: src?.name ?? '',
    firstName: norm.firstName,
    lastName: norm.lastName,
    relationship: src?.relationship ?? '',
    company: norm.company,
    jobTitle: norm.jobTitle,
    birthday: src?.birthday ? String(src.birthday).slice(0, 10) : '',
    notes: src?.notes ?? '',
  });

  // The composed display name persisted as `name`: personal contacts join
  // first + last; self/service keep their single `name` field.
  const composedName = isService || isSelf ? form.name.trim() : composeName(form.firstName, form.lastName);
  const [phones, setPhones] = useState<LabeledValue[]>(norm.phones);
  const [emails, setEmails] = useState<LabeledValue[]>(norm.emails);
  const [addresses, setAddresses] = useState<LabeledValue[]>(norm.addresses);
  const [dates, setDates] = useState<LabeledValue[]>(norm.dates);
  const [occasionsHidden, setOccasionsHidden] = useState<boolean>(Boolean((src as Person | undefined)?.occasionsHidden));
  const [urls, setUrls] = useState<LabeledValue[]>(norm.urls);
  const [relatedNames, setRelatedNames] = useState<RelatedName[]>(norm.relatedNames);
  const [linkIndex, setLinkIndex] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const assist = useFormAssist();

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    assist.clear([k]);
  };
  const canDelete = !!editing?._id && !editing.accountId;

  // Household people the current contact can link a related name to (exclude
  // self and the person being edited).
  const linkablePeople = useMemo(
    () => people.filter((p) => !p.accountId && p._id !== editing?._id),
    [people, editing]
  );

  // Schema the AI form assistant fills. `phone`/`email` map onto the primary
  // (first) entry of their arrays; the rest are plain scalar keys.
  const assistFields: FormAssistField[] = [
    { name: 'name', type: 'text', label: 'Name' },
    { name: 'relationship', type: 'text', label: 'Relationship / how you know them' },
    { name: 'company', type: 'text', label: 'Company / business' },
    { name: 'jobTitle', type: 'text', label: 'Job title' },
    { name: 'birthday', type: 'date', label: 'Birthday' },
    { name: 'notes', type: 'text', label: 'Notes' },
    { name: 'phone', type: 'text', label: 'Phone' },
    { name: 'email', type: 'text', label: 'Email' },
  ];

  const applyPatch = (patch: Record<string, unknown>) => {
    const nextForm: Partial<typeof form> = {};
    const changed: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const val = v == null ? '' : String(v);
      if (k === 'phone') {
        if (val) { setPhones((p) => setPrimary(p, val, DEFAULT_PHONE_LABEL)); changed.push('phone'); }
        continue;
      }
      if (k === 'email') {
        if (val) { setEmails((e) => setPrimary(e, val, DEFAULT_EMAIL_LABEL)); changed.push('email'); }
        continue;
      }
      // The assistant fills a single "name"; route it into the structured
      // first/last inputs (personal) or the single name field (service).
      if (k === 'name') {
        if (isService) {
          setForm((f) => ({ ...f, name: val }));
          changed.push('name');
        } else {
          const s = splitName(val);
          setForm((f) => ({ ...f, firstName: s.firstName, lastName: s.lastName }));
          changed.push('firstName', 'lastName');
        }
        continue;
      }
      if (!(k in form)) continue;
      if ((form as any)[k] !== val) changed.push(k);
      (nextForm as any)[k] = val;
    }
    setForm((f) => ({ ...f, ...nextForm }));
    assist.mark(changed);
  };

  // For service contacts, picking a business from the first address dropdown
  // pulls its phone number from Google Places and adds it as a phone.
  async function onServiceSelect(p: PlacePrediction) {
    try {
      const { data } = await placesApi.getDetails(p.place_id);
      const phone = data?.result?.formatted_phone_number || data?.result?.international_phone_number;
      if (!phone) return;
      setPhones((prev) => {
        const empty = prev.findIndex((e) => !e.value.trim());
        if (empty >= 0) return prev.map((e, i) => (i === empty ? { ...e, value: phone } : e));
        return [...prev, { label: 'main', value: phone }];
      });
      assist.mark(['phone']);
    } catch {
      // Details lookup is best-effort; leave phones untouched on failure.
    }
  }

  function advance() {
    if (hasNext) (nav as any).replace('PersonForm', { prefills, queueIndex: queueIndex + 1 });
    else nav.goBack();
  }

  async function save() {
    if (!composedName) return;
    setSaving(true);
    try {
      // Structured names apply to personal contacts; service/self carry only the
      // single `name`, so their first/last stay empty.
      const structured = isService || isSelf ? { firstName: '', lastName: '' } : { firstName: form.firstName, lastName: form.lastName };
      const payload: Record<string, unknown> = {
        type,
        name: composedName,
        relationship: form.relationship.trim() || undefined,
        birthday: form.birthday || undefined,
        notes: form.notes.trim() || undefined,
        // Only persist the exclusion when set; absent = shown (default).
        occasionsHidden: occasionsHidden || undefined,
        deviceContactId: prefill?.deviceContactId || undefined,
        // Emits the structured names + labeled arrays + company/jobTitle and
        // clears the legacy single phone/email/address/businessName fields.
        ...denormalizeForSave({
          ...structured,
          phones, emails, addresses, dates, urls, relatedNames,
          jobTitle: form.jobTitle, company: form.company,
        }),
      };
      // The opaque store keeps no content columns, so every listed field must
      // ride inside `enc` via the shared subset. On edit, spread the decrypted
      // record under the form payload so sealed-only fields the form never shows
      // (accountId, deviceContactId) survive the re-seal.
      let savedId = editing?._id;
      if (savedId) {
        await peopleApi.update(savedId, await sealUpdate('Person', savedId, payload, PERSON_ENC({ ...editing, ...payload })));
      } else {
        const body = await sealNew('Person', payload, PERSON_ENC(payload));
        const res = await peopleApi.create(body);
        savedId = (body._id as string | undefined) || res?.data?._id;
      }
      // Mirror linked related names onto the other contact with the inverse
      // label (spouse↔spouse, mother→child, …; add-only — see personFields).
      // Best-effort: this person is already saved, so a failed back-link write
      // must not surface as a save failure.
      if (savedId) {
        for (const u of reciprocalUpdates({ id: savedId, name: composedName }, relatedNames, people)) {
          try {
            const patch = { relatedNames: u.relatedNames };
            await peopleApi.update(u.person._id, await sealUpdate('Person', u.person._id, patch, PERSON_ENC({ ...u.person, ...patch })));
          } catch {
            // add-only mirror; the next save of either card can retry
          }
        }
      }
      qc.invalidateQueries({ queryKey: ['people'] });
      if (inQueue) advance();
      else nav.goBack();
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function remove() {
    if (!editing?._id) return;
    Alert.alert(`Remove ${editing.name}?`, 'This will permanently remove them from your list.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await peopleApi.delete(editing._id);
          qc.invalidateQueries({ queryKey: ['people'] });
          nav.goBack();
        },
      },
    ]);
  }

  useHeaderCheckButton(nav, { onPress: save, loading: saving, disabled: !composedName });

  useLayoutEffect(() => {
    if (inQueue) nav.setOptions({ title: `Review ${queueIndex + 1} of ${prefills!.length}` });
  }, [nav, inQueue, queueIndex, prefills]);

  // The flush editors dropped into a MultiValueField row: transparent, no border.
  const editorField = fs.headInput;

  return (
    <Screen>
      {!isSelf ? (
        <FormAssist
          formType="person / contact"
          placeholder={'Describe the person, e.g. "my sister Sarah, birthday June 3, lives at 12 Elm St"'}
          fields={assistFields}
          current={{ ...form, name: composedName, phone: phones[0]?.value ?? '', email: emails[0]?.value ?? '' }}
          onApply={applyPatch}
        />
      ) : null}

      <GroupCard>
        {isSelf || isService ? (
          // Self ("You", read-only here) + service/business contacts keep a
          // single name field. Service names ("Joe's Plumbing") don't split
          // into first/last; the self record's name is managed in Account.
          <Input
            value={form.name}
            onChangeText={set('name')}
            placeholder="Name"
            editable={!isSelf}
            containerStyle={fs.headField}
            style={[fs.headInput, assist.changed.has('name') && fs.headInputHighlight]}
          />
        ) : (
          // Personal contacts: Apple-Contacts-style First name / Last name.
          <>
            <Input
              value={form.firstName}
              onChangeText={set('firstName')}
              placeholder="First name"
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('firstName') && fs.headInputHighlight]}
            />
            <CardDivider />
            <Input
              value={form.lastName}
              onChangeText={set('lastName')}
              placeholder="Last name"
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('lastName') && fs.headInputHighlight]}
            />
          </>
        )}
        {!isSelf ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Type"
              value={type}
              options={[
                { label: 'Family', value: 'family' },
                { label: 'Friend', value: 'friend' },
                { label: 'Professional', value: 'service' },
              ]}
              onChange={(v) => v && setType(v as 'family' | 'friend' | 'service')}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
            <CardDivider />
            <Input
              value={form.relationship}
              onChangeText={set('relationship')}
              placeholder={
                isService
                  ? 'Service (e.g. plumber, dentist)'
                  : type === 'family'
                  ? 'Relationship (e.g. spouse, daughter)'
                  : 'How you know them (e.g. neighbor)'
              }
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('relationship') && fs.headInputHighlight]}
            />
            <CardDivider />
            <Input
              value={form.company}
              onChangeText={set('company')}
              placeholder={isService ? "Business name (e.g. Joe's Plumbing)" : 'Company (optional)'}
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('company') && fs.headInputHighlight]}
            />
            <CardDivider />
            <Input
              value={form.jobTitle}
              onChangeText={set('jobTitle')}
              placeholder="Job title (optional)"
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('jobTitle') && fs.headInputHighlight]}
            />
            {!isService ? (
              <>
                <CardDivider />
                <DateField
                  inlineLabel="Birthday"
                  clearable
                  placeholder="None"
                  value={form.birthday}
                  onChange={set('birthday')}
                  highlight={assist.changed.has('birthday')}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.rowField}
                  valueStyle={fs.dtValue}
                  hideIcon
                />
              </>
            ) : null}
          </>
        ) : null}
      </GroupCard>

      {isSelf ? (
        <Text style={styles.hint}>Your name, birthday and home address are managed in Account.</Text>
      ) : (
        <>
          <SectionHeader>Phone</SectionHeader>
          <MultiValueField
            entries={phones}
            onChange={setPhones}
            presets={PHONE_LABELS}
            defaultLabel={DEFAULT_PHONE_LABEL}
            addLabel="add phone"
            renderEditor={(entry, patch) => (
              <PhoneTextField
                value={entry.value}
                onChangeText={(v) => patch({ value: v })}
                placeholder="Phone"
                containerStyle={fs.headField}
                style={editorField}
              />
            )}
          />

          <SectionHeader>Email</SectionHeader>
          <MultiValueField
            entries={emails}
            onChange={setEmails}
            presets={EMAIL_LABELS}
            defaultLabel={DEFAULT_EMAIL_LABEL}
            addLabel="add email"
            renderEditor={(entry, patch) => (
              <Input
                value={entry.value}
                onChangeText={(v) => patch({ value: v })}
                placeholder="Email"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                containerStyle={fs.headField}
                style={editorField}
              />
            )}
          />

          <SectionHeader>Address</SectionHeader>
          <MultiValueField
            entries={addresses}
            onChange={setAddresses}
            presets={ADDRESS_LABELS}
            defaultLabel={DEFAULT_ADDRESS_LABEL}
            addLabel="add address"
            stacked
            renderEditor={(entry, patch, i) => (
              <PlacesAutocomplete
                value={entry.value}
                onChangeText={(v) => patch({ value: v })}
                placeholder={isService ? 'Business address' : 'Address or city'}
                type={isService ? 'business' : 'addressCity'}
                onSelect={isService && i === 0 ? onServiceSelect : undefined}
                containerStyle={fs.headField}
                inputStyle={editorField}
              />
            )}
          />

          {/* Opened from the Occasions list (`focus: 'dates'`): the screen
              opens with this section's title at the top of the viewport. */}
          <ScrollToSection active={focus === 'dates'}>
            <SectionHeader>Occasion dates</SectionHeader>
            {(form.birthday || dates.some((d) => d.value.trim())) ? (
              <SwitchRow
                label="Show on Occasions calendar"
                value={!occasionsHidden}
                onValueChange={(v) => setOccasionsHidden(!v)}
                color={CALENDAR_COLORS.birthdays}
              />
            ) : null}
            <MultiValueField
              entries={dates}
              onChange={setDates}
              presets={DATE_LABELS}
              defaultLabel={DEFAULT_DATE_LABEL}
              addLabel="add date"
              renderEditor={(entry, patch) => (
                <DateField
                  value={entry.value}
                  onChange={(v) => patch({ value: v })}
                  placeholder="Date"
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={styles.dateEditor}
                  hideIcon
                />
              )}
            />
          </ScrollToSection>

          <SectionHeader>Website</SectionHeader>
          <MultiValueField
            entries={urls}
            onChange={setUrls}
            presets={URL_LABELS}
            defaultLabel={DEFAULT_URL_LABEL}
            addLabel="add URL"
            renderEditor={(entry, patch) => (
              <Input
                value={entry.value}
                onChangeText={(v) => patch({ value: v })}
                placeholder="URL"
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                containerStyle={fs.headField}
                style={editorField}
              />
            )}
          />

          <SectionHeader>Related names</SectionHeader>
          <MultiValueField<RelatedName>
            entries={relatedNames}
            onChange={setRelatedNames}
            presets={RELATED_LABELS}
            defaultLabel={DEFAULT_RELATED_LABEL}
            addLabel="add related name"
            renderEditor={(entry, patch) => (
              <Input
                value={entry.value}
                // Typing a name by hand detaches any linked contact.
                onChangeText={(v) => patch({ value: v, personId: undefined })}
                placeholder="Name"
                containerStyle={fs.headField}
                style={editorField}
              />
            )}
            renderTrailing={(entry, _patch, i) => (
              <TouchableOpacity
                onPress={() => setLinkIndex(i)}
                hitSlop={8}
                accessibilityLabel="Link to a contact"
                style={styles.linkBtn}
              >
                <Ionicons
                  name={entry.personId ? 'person' : 'person-add-outline'}
                  size={20}
                  color={entry.personId ? colors.primary : colors.textMuted}
                />
              </TouchableOpacity>
            )}
          />

          <SectionTitle>Notes</SectionTitle>
          <Input
            value={form.notes}
            onChangeText={set('notes')}
            multiline
            numberOfLines={3}
            placeholder="Anything you want to remember about them…"
            style={styles.notes}
            highlight={assist.changed.has('notes')}
          />
        </>
      )}

      {multiInQueue ? (
        <View style={fs.footer}>
          <Button title={hasNext ? 'Skip this contact' : 'Skip & finish'} variant="ghost" onPress={advance} />
        </View>
      ) : null}

      {canDelete ? (
        <View style={fs.footer}>
          <Button title="Delete" variant="danger" onPress={remove} />
        </View>
      ) : null}

      {/* Shared link-to-contact picker for the related-names field. */}
      <BottomSheet visible={linkIndex != null} onClose={() => setLinkIndex(null)} title="Link to a contact">
        <ScrollView style={styles.linkList}>
          {linkablePeople.length === 0 ? (
            <Text style={styles.linkEmpty}>No other contacts to link yet.</Text>
          ) : (
            linkablePeople.map((p) => (
              <TouchableOpacity
                key={p._id}
                style={styles.linkRow}
                onPress={() => {
                  setRelatedNames((rn) =>
                    rn.map((e, idx) => (idx === linkIndex ? { ...e, value: p.name, personId: p._id } : e))
                  );
                  setLinkIndex(null);
                }}
              >
                <Text style={styles.linkName}>{p.name}</Text>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </BottomSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: colors.textMuted, marginTop: -spacing.sm, marginBottom: spacing.md },
  notes: { height: 80, textAlignVertical: 'top' },
  dateEditor: { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0 },
  linkBtn: { paddingLeft: 8, paddingRight: 12, paddingVertical: 12 },
  linkList: { maxHeight: 320 },
  linkRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  linkName: { fontSize: 16, color: colors.text },
  linkEmpty: { fontSize: 14, color: colors.textMuted, paddingVertical: spacing.md },
});
