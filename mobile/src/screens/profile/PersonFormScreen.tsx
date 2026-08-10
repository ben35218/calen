import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  relatedNameRemovalsOnDelete,
  reciprocalLabelFor,
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
  BottomSheet, useHeaderCheckButton, SwitchRow, ScrollToSection, SetupCallout, Hint,
} from '../../components/ui';
import { MultiValueField, LabelChip } from '../../components/MultiValueField';
import { form as fs, GroupCard, CardDivider } from '../../components/formStyles';
import FormAssist from '../../components/FormAssist';
import { useFormAssist } from '../../hooks/useFormAssist';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { addPersonToDeviceContacts, ContactsPermissionError } from '../../lib/deviceContacts';
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
  const { id, isSelf, type: initialType, prefills, queueIndex = 0, focus, aiReview } = params || {};

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
    notes: src?.notes ?? '',
  });

  // The composed display name persisted as `name`: personal contacts join
  // first + last; self/service keep their single `name` field.
  const composedName = isService || isSelf ? form.name.trim() : composeName(form.firstName, form.lastName);
  const [phones, setPhones] = useState<LabeledValue[]>(norm.phones);
  const [emails, setEmails] = useState<LabeledValue[]>(norm.emails);
  const [addresses, setAddresses] = useState<LabeledValue[]>(norm.addresses);
  // Birthday is presented as the first "Occasion date" row (label "Birthday"),
  // seeded from the dedicated `Person.birthday` field; on save it splits back out
  // to that field (see save()). Personal contacts always get the row so it's the
  // default on a new contact; service (business) contacts don't.
  const [dates, setDates] = useState<LabeledValue[]>(() => {
    if (isService) return norm.dates;
    const bday = src?.birthday ? String(src.birthday).slice(0, 10) : '';
    return [{ label: 'birthday', value: bday }, ...norm.dates];
  });
  const [occasionsHidden, setOccasionsHidden] = useState<boolean>(Boolean((src as Person | undefined)?.occasionsHidden));
  const [urls, setUrls] = useState<LabeledValue[]>(norm.urls);
  const [relatedNames, setRelatedNames] = useState<RelatedName[]>(norm.relatedNames);
  const [linkIndex, setLinkIndex] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  // Opt-in "Also save to iPhone Contacts" — offered only when creating a brand-new
  // Calen contact (not editing, not a device import, not the self card, since an
  // imported contact already exists on the phone).
  const showSaveToDevice = !isSelf && !editing && !inQueue;
  const [saveToDevice, setSaveToDevice] = useState(false);
  const assist = useFormAssist();

  // Hide the "Ask Calen" form-assist panel in a Direct-import review queue (the
  // contact's details came straight from the phone — nothing to re-derive). It
  // stays for a normal add/edit and for an AI-assisted review.
  const showAssist = !isSelf && (!inQueue || !!aiReview);

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
      // Birthday isn't a scalar form field anymore — it's the "Birthday" row of
      // the occasion dates. Route an assistant-filled birthday into that row.
      if (k === 'birthday') {
        if (val) {
          setDates((ds) => {
            const i = ds.findIndex((d) => d.label.trim().toLowerCase() === 'birthday');
            return i >= 0
              ? ds.map((d, idx) => (idx === i ? { ...d, value: val } : d))
              : [{ label: 'birthday', value: val }, ...ds];
          });
          changed.push('birthday');
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
    // Save→next and "Skip this contact" both leave the current review copy
    // intentionally — bypass the discard guard.
    allowLeave();
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
      // Split the "Birthday" occasion-date row back out to the dedicated
      // `birthday` field (the first birthday-labeled row with a value wins); the
      // remaining rows persist as labeled `dates[]`.
      const bdayIdx = dates.findIndex((d) => d.label.trim().toLowerCase() === 'birthday' && d.value.trim());
      const birthday = bdayIdx >= 0 ? dates[bdayIdx].value.trim() : undefined;
      const datesToSave = bdayIdx >= 0 ? dates.filter((_, i) => i !== bdayIdx) : dates;
      // Opt-in: also add a copy to the device address book (best-effort — a
      // permission denial or write error must not block the Calen save). Writing
      // decrypted data to the user's OWN device is outside the E2EE boundary.
      let deviceContactId = prefill?.deviceContactId || undefined;
      if (showSaveToDevice && saveToDevice && !deviceContactId) {
        try {
          deviceContactId = await addPersonToDeviceContacts({
            name: composedName,
            firstName: isService || isSelf ? undefined : form.firstName,
            lastName: isService || isSelf ? undefined : form.lastName,
            type,
            company: form.company,
            jobTitle: form.jobTitle,
            birthday,
            phones,
            emails,
            addresses,
            urls,
          });
        } catch (e) {
          Alert.alert(
            'Not saved to iPhone',
            e instanceof ContactsPermissionError
              ? 'Contacts permission is off, so this contact was saved in Calen only. You can allow Contacts access in Settings.'
              : "This contact was saved in Calen, but couldn't be added to your iPhone Contacts."
          );
        }
      }
      const payload: Record<string, unknown> = {
        type,
        name: composedName,
        relationship: form.relationship.trim() || undefined,
        birthday: birthday || undefined,
        notes: form.notes.trim() || undefined,
        // Only persist the exclusion when set; absent = shown (default).
        occasionsHidden: occasionsHidden || undefined,
        deviceContactId: deviceContactId || undefined,
        // Emits the structured names + labeled arrays + company/jobTitle and
        // clears the legacy single phone/email/address/businessName fields.
        ...denormalizeForSave({
          ...structured,
          phones, emails, addresses, dates: datesToSave, urls, relatedNames,
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
      // label (spouse↔spouse, mother→child, …), keeping the mirror in sync with a
      // rename, a relabel, or a REMOVAL on this card — see
      // personFields.reciprocalUpdates. `norm.relatedNames` is this contact's
      // previously-saved links, letting the mirror tell an intentional relabel
      // from an unrelated re-save and spot dropped links. Best-effort:
      // this person is already saved, so a failed back-link write must not surface
      // as a save failure.
      if (savedId) {
        for (const u of reciprocalUpdates({ id: savedId, name: composedName }, relatedNames, people, norm.relatedNames)) {
          try {
            const patch = { relatedNames: u.relatedNames };
            await peopleApi.update(u.person._id, await sealUpdate('Person', u.person._id, patch, PERSON_ENC({ ...u.person, ...patch })));
          } catch {
            // best-effort mirror; the next save of either card can retry
          }
        }
      }
      qc.invalidateQueries({ queryKey: ['people'] });
      if (inQueue) advance();
      else { allowLeave(); nav.goBack(); }
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
          // Clear any related-name links that pointed at this now-deleted contact
          // so the other cards don't keep a dangling relationship. Best-effort:
          // a failed cleanup write must not block the delete.
          for (const u of relatedNameRemovalsOnDelete(editing._id, people)) {
            try {
              const patch = { relatedNames: u.relatedNames };
              await peopleApi.update(u.person._id, await sealUpdate('Person', u.person._id, patch, PERSON_ENC({ ...u.person, ...patch })));
            } catch {
              // best-effort; the next save of that card can retry
            }
          }
          qc.invalidateQueries({ queryKey: ['people'] });
          allowLeave();
          nav.goBack();
        },
      },
    ]);
  }

  // Non-accented area, so the save check is normally a transparent-white ✕-match
  // (mobile/CLAUDE.md). Exception: in the import review queue the light header
  // makes that check hard to see and easy to miss while stepping through many
  // contacts, so we tint it the app primary here (review-import flow only).
  useHeaderCheckButton(nav, {
    onPress: save,
    loading: saving,
    disabled: !composedName,
    color: inQueue ? colors.primary : undefined,
  });

  // Discard guard. Every field is seeded synchronously from `src`, so the form
  // is ready on first render — snapshot it once as the clean baseline. Dirty =
  // any scalar or labeled-array edit since. The self ("You") card is read-only
  // here (managed in Account), so it never prompts.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({ type, form, phones, emails, addresses, dates, occasionsHidden, urls, relatedNames });
  useEffect(() => {
    if (baselineRef.current === null) baselineRef.current = snapshot;
  }, [snapshot]);
  const dirty = !isSelf && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(nav, dirty);

  useLayoutEffect(() => {
    if (inQueue) nav.setOptions({ title: `Review ${queueIndex + 1} of ${prefills!.length}` });
  }, [nav, inQueue, queueIndex, prefills]);

  // The flush editors dropped into a MultiValueField row: transparent, no border.
  const editorField = fs.headInput;

  return (
    <Screen>
      {showAssist ? (
        <FormAssist
          formType="person / contact"
          placeholder={'Describe the person, e.g. "my sister Sarah, birthday June 3, lives at 12 Elm St"'}
          fields={assistFields}
          current={{ ...form, name: composedName, phone: phones[0]?.value ?? '', email: emails[0]?.value ?? '', birthday: dates.find((d) => d.label.trim().toLowerCase() === 'birthday')?.value ?? '' }}
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
            autoCapitalize="words"
            textContentType="organizationName"
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
              autoCapitalize="words"
              textContentType="givenName"
              containerStyle={fs.headField}
              style={[fs.headInput, assist.changed.has('firstName') && fs.headInputHighlight]}
            />
            <CardDivider />
            <Input
              value={form.lastName}
              onChangeText={set('lastName')}
              placeholder="Last name"
              autoCapitalize="words"
              textContentType="familyName"
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
          </>
        ) : null}
      </GroupCard>

      {isSelf ? (
        <Text style={styles.hint}>Your name, birthday and home address are managed in Account.</Text>
      ) : (
        <>
          {/* Opened from a Calen "Add this contact" setup chip (`focus: 'phone'`):
              scroll to the phone section and say why, so Calen can call/text them. */}
          <ScrollToSection active={focus === 'phone'}>
          <SectionHeader>Phone</SectionHeader>
          {focus === 'phone' ? (
            <SetupCallout icon="call">Add a phone number so Calen can call or text this contact for you.</SetupCallout>
          ) : null}
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
          </ScrollToSection>

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
            {dates.some((d) => d.value.trim()) ? (
              <SwitchRow
                label="Show on Occasions calendar"
                value={!occasionsHidden}
                onValueChange={(v) => setOccasionsHidden(!v)}
                color={CALENDAR_COLORS.birthdays}
              />
            ) : null}
            {/* Birthday is the first row (label "Birthday", defaulted on a new
                contact); every date row has a clear-✕ on its value, and the
                red-minus removes the row entirely. */}
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
                  clearable
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

          {/* Opened from the e-card recipients card (`focus: 'related'`): scroll
              this section to the top so the user can link a related contact —
              anyone linked here becomes a candidate recipient back in the card. */}
          <ScrollToSection active={focus === 'related'}>
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
                // Typing a name by hand detaches any linked contact (and its
                // now-moot reciprocal label).
                onChangeText={(v) => patch({ value: v, personId: undefined, reciprocalLabel: undefined })}
                placeholder="Name"
                autoCapitalize="words"
                textContentType="name"
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
            // For a linked contact with a CUSTOM label (no derivable inverse),
            // let the user set what THIS contact is called on the other's card —
            // e.g. link "daughter-in-law", set the reciprocal to "father-in-law".
            // Preset labels derive their inverse automatically, so no control.
            renderBelow={(entry, patch) => {
              if (!entry.personId) return null;
              const isPreset = RELATED_LABELS.some((l) => l.toLowerCase() === entry.label.trim().toLowerCase());
              if (isPreset) return null;
              return (
                <View style={styles.reciprocalRow}>
                  <Text style={styles.reciprocalHint}>
                    Who {splitName(composedName).firstName || 'this contact'} is to {splitName(entry.value).firstName || 'them'}:
                  </Text>
                  <LabelChip
                    value={reciprocalLabelFor(entry)}
                    presets={RELATED_LABELS}
                    onChange={(label) => patch({ reciprocalLabel: label })}
                  />
                </View>
              );
            }}
          />
          </ScrollToSection>

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

          {showSaveToDevice ? (
            <>
              <SectionHeader>iPhone Contacts</SectionHeader>
              <SwitchRow
                label="Also save to iPhone Contacts"
                value={saveToDevice}
                onValueChange={setSaveToDevice}
              />
              <Hint>
                Adds a copy to your phone's address book when you save. Your Calen contacts
                stay private either way.
              </Hint>
            </>
          ) : null}
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
  reciprocalRow: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm,
    paddingLeft: 12, paddingRight: 14, paddingBottom: 10,
  },
  reciprocalHint: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  linkList: { maxHeight: 320 },
  linkRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  linkName: { fontSize: 16, color: colors.text },
  linkEmpty: { fontSize: 14, color: colors.textMuted, paddingVertical: spacing.md },
});
