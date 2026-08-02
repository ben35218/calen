import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Image, StyleSheet, Alert, TouchableOpacity, ScrollView, Platform } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay, Easing } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { peopleApi, ecardsApi, ecardPhotoUploadPath, ecardPhotoPath, Person, OccasionKind, ECardPhoto } from '../../api';
import { API_URL } from '../../config';
import { getCachedToken } from '../../lib/secureToken';
import { pickImage, PickedFile } from '../../lib/media';
import { uploadFile } from '../../lib/upload';
import { openRecord, sealUpdate } from '../../lib/e2ee';
import { PERSON_ENC } from '../../lib/encSubsets';
import * as replica from '../../lib/replica';
import { normalizePerson, denormalizeForSave, DEFAULT_EMAIL_LABEL } from '../../lib/personFields';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { useAuth } from '../../store/auth';
import {
  Input, Select, Screen, useHeaderCheckButton, CenteredLoader, SectionHeader, InfoCard, ListRow, Hint, BottomSheet, Button,
} from '../../components/ui';
import { form as fs, GroupCard } from '../../components/formStyles';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { colors, spacing, radius } from '../../theme';
import { ECARD_GALLERY, resolveTemplate, ECardTemplateMeta, ECardDeco } from '../../lib/ecardTemplates';
import type { CalendarStackParamList } from '../../navigation/CalendarNavigator';

type Nav = NativeStackNavigationProp<CalendarStackParamList>;
type Rt = RouteProp<CalendarStackParamList, 'ECardForm'>;

// The card faces preview an *email*, so their surfaces are the email's own
// palette (template washes/gradients + a white body), not the app theme.
const CARD_WHITE = '#FFFFFF';
const CARD_TEXT = '#374151';
const CARD_MUTED = '#9CA3AF';
const SERIF_FONT = Platform.select({ ios: 'Georgia', default: 'serif' });

// Native stand-ins for the email renderer's font stacks (ecardTemplates.js
// FONTS). Key '' = the template's own default face.
const FONT_NATIVE: Record<string, string | undefined> = {
  sans: undefined,
  serif: SERIF_FONT,
  elegant: Platform.select({ ios: 'Palatino', default: 'serif' }),
  script: Platform.select({ ios: 'Snell Roundhand', default: 'cursive' }),
};
const FONT_OPTIONS: { key: string; label: string }[] = [
  { key: '', label: 'Auto' },
  { key: 'sans', label: 'Modern' },
  { key: 'serif', label: 'Serif' },
  { key: 'elegant', label: 'Elegant' },
  { key: 'script', label: 'Script' },
];
const MAX_PHOTOS = 3;

const DEFAULT_MESSAGE: Record<OccasionKind, string> = {
  birthday: 'Wishing you a wonderful birthday!',
  anniversary: 'Congratulations on your anniversary!',
  marriage: 'Wishing you a lifetime of happiness together.',
  death: 'Thinking of you and holding you in my heart today.',
  custom: '',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The year the card will send: this year if the occasion's month/day hasn't
// passed yet (today counts), otherwise next year. Cards are one-time — they
// send on the NEXT occurrence and don't recur.
function nextOccurrenceYear(month: number, day: number): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const candidate = new Date(now.getFullYear(), month - 1, day);
  return candidate < today ? now.getFullYear() + 1 : now.getFullYear();
}

// 'HH:mm' → '9:00 AM'
function to12h(hhmm: string): string {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
// E-cards are sent hour-granular (the scheduler reads only the hour), so the
// send time is a whole-hour picker, not a free minute field.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ label: to12h(`${h}:00`), value: h }));

// Reconstruct a full Person save payload (mirrors PersonFormScreen.save) with an
// added primary email — so we can add a missing email to a contact in place.
function personPayloadWithEmail(person: Person, email: string): Record<string, unknown> {
  const norm = normalizePerson(person);
  return {
    type: person.type,
    name: person.name,
    relationship: person.relationship || undefined,
    birthday: person.birthday || undefined,
    notes: person.notes || undefined,
    occasionsHidden: person.occasionsHidden || undefined,
    accountId: person.accountId || undefined,
    deviceContactId: person.deviceContactId || undefined,
    ...denormalizeForSave({ ...norm, emails: [{ label: DEFAULT_EMAIL_LABEL, value: email }, ...norm.emails] }),
  };
}

// ── Card-face preview pieces ─────────────────────────────────────────────────
// Native approximations of the email renderer's cover art (see
// server/src/services/ecardTemplates.js): an SVG gradient stands in for the
// CSS linear-gradient, and Reanimated stands in for the @keyframes motion the
// recipient's mail client plays.

// The cover gradient behind a card's hero area.
function CoverGradient({ from, to, id }: { from: string; to: string; id: string }) {
  return (
    <Svg style={StyleSheet.absoluteFill}>
      <Defs>
        <SvgLinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

// One gently bobbing cover-art piece, staggered by index (like the email's
// staggered animation-delays). `slow` calms the motion for condolence cards.
function BobbingPiece({ index, slow, children }: { index: number; slow?: boolean; children: React.ReactNode }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(
      index * 450,
      withRepeat(withTiming(1, { duration: slow ? 2600 : 1500, easing: Easing.inOut(Easing.quad) }), -1, true),
    );
  }, [index, slow, t]);
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateY: -6 * t.value }],
    opacity: 0.55 + 0.45 * t.value,
  }));
  return <Animated.View style={anim}>{children}</Animated.View>;
}

// The animated art row above the heading: emoji pieces, or confetti dots.
function DecoRow({ deco, slow }: { deco: ECardDeco; slow?: boolean }) {
  const items = (deco.type === 'confetti' ? deco.colors : deco.pieces) ?? [];
  return (
    <View style={styles.decoRow}>
      {items.map((it, i) => (
        <BobbingPiece key={`${it}-${i}`} index={i} slow={slow}>
          {deco.type === 'confetti'
            ? <View style={[styles.confetti, { backgroundColor: it }]} />
            : <Text style={styles.decoEmoji}>{it}</Text>}
        </BobbingPiece>
      ))}
    </View>
  );
}

// A card-style swatch in the horizontal gallery.
function TemplateThumb({ v, selected, accent, onPress }: {
  v: ECardTemplateMeta; selected: boolean; accent: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.thumbWrap} accessibilityLabel={`${v.name} card style`}>
      <View style={[styles.thumb, selected && { borderColor: accent }]}>
        <CoverGradient from={v.g1} to={v.g2} id={`th-${v.key}`} />
        <Text style={styles.thumbEmoji}>{v.emoji}</Text>
        <Text
          style={[styles.thumbHeading, { color: v.heroText }, v.serif && { fontFamily: SERIF_FONT }]}
          numberOfLines={2}
        >
          {v.heading}
        </Text>
      </View>
      <View style={styles.thumbLabelRow}>
        {selected ? <Ionicons name="checkmark-circle" size={14} color={accent} /> : null}
        <Text style={[styles.thumbName, selected && { color: accent, fontWeight: '600' }]}>{v.name}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Schedule an occasion e-card. The occasion context (person, kind, month/day)
// arrives via route params from the Occasions list. Recipients are scoped to the
// occasion's contact plus anyone LINKED to them (their related names). A contact
// missing an email can have one added inline (saved to their card). PRIVACY: the
// recipient emails + message are sent to Calen's servers in the clear (a
// documented E2EE exception) so the card can be delivered while the app is closed.
export default function ECardFormScreen() {
  const nav = useNavigation<Nav>();
  const qc = useQueryClient();
  const route = useRoute<Rt>();
  const { personId, personName, kind, occasionLabel, month, day, ecardId } = route.params;
  const { colors: calColors } = useCalendarColors();
  const { user } = useAuth();
  const accent = calColors.birthdays;
  // This occasion kind's card styles; `template` is the chosen style's key.
  const variants = ECARD_GALLERY[kind] ?? ECARD_GALLERY.custom;

  // Existing scheduled card (edit mode) — matched from the household's cards.
  const { data: ecards } = useQuery({ queryKey: ['ecards'], queryFn: () => ecardsApi.list().then((r) => r.data) });
  const existing = ecardId ? (ecards ?? []).find((c) => c._id === ecardId) : undefined;

  const [message, setMessage] = useState<string>(DEFAULT_MESSAGE[kind] ?? '');
  const [template, setTemplate] = useState<string>(() => resolveTemplate(kind).key);
  const [font, setFont] = useState<string>('');
  // Card framing-line overrides; '' = the defaults (per-recipient greeting /
  // the style's sign-off phrase / the author's first name), shown as
  // placeholders in the editable card.
  const [greeting, setGreeting] = useState('');
  const [signoff, setSignoff] = useState('');
  const [signature, setSignature] = useState('');
  // Card photos: already-uploaded ones (edit mode) + ones picked this session
  // (uploaded after save, once the card has an id).
  const [serverPhotos, setServerPhotos] = useState<ECardPhoto[]>([]);
  const [localPhotos, setLocalPhotos] = useState<PickedFile[]>([]);
  const [sendTime, setSendTime] = useState<string>('09:00');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Emails added in this session (instant UI; also persisted to the contact).
  const [emailOverrides, setEmailOverrides] = useState<Record<string, string>>({});
  // Which of a multi-email contact's addresses this card goes to (defaults to
  // their primary). One address per recipient, switchable — like Apple Mail.
  const [chosenEmail, setChosenEmail] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [editingFor, setEditingFor] = useState<string | null>(null);
  const [draftEmail, setDraftEmail] = useState('');
  // The greeting is the first editable card line; the "Tap to edit" badge focuses
  // it with the cursor at the very start (transient controlled selection, then
  // released so the user can move the caret freely).
  const greetingRef = useRef<TextInput>(null);
  const [greetSel, setGreetSel] = useState<{ start: number; end: number } | undefined>(undefined);
  const focusGreeting = () => {
    setGreetSel({ start: 0, end: 0 });
    greetingRef.current?.focus();
  };

  const { data: people, isLoading } = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      try {
        const rows = (await peopleApi.list()).data;
        replica.upsert('Person', rows as any).catch(() => {});
        return Promise.all(rows.map((p) => openRecord('Person', p)));
      } catch (e) {
        const cached = await replica.getAll<Person>('Person');
        if (cached.length) return Promise.all(cached.map((p) => openRecord('Person', p)));
        throw e;
      }
    },
  });

  // A contact's labeled emails (a session-added one first), deduped by address.
  const emailEntriesOf = (p: Person): { label: string; value: string }[] => {
    const norm = normalizePerson(p).emails;
    const ov = emailOverrides[p._id];
    const list = ov ? [{ label: DEFAULT_EMAIL_LABEL, value: ov }, ...norm] : norm;
    const seen = new Set<string>();
    return list.filter((e) => {
      if (!e.value || seen.has(e.value)) return false;
      seen.add(e.value);
      return true;
    });
  };
  // The address this card goes to for a contact: the explicitly chosen one, else
  // their primary (first).
  const chosenEmailOf = (p: Person): string => chosenEmail[p._id] ?? emailEntriesOf(p)[0]?.value ?? '';

  // Candidate recipients: the occasion's own contact first, then everyone linked
  // to them (related names that resolve to a real person in the roster).
  const candidates: Person[] = useMemo(() => {
    if (!people) return [];
    const byId = new Map(people.map((p) => [p._id, p]));
    const occ = personId ? byId.get(personId) : undefined;
    const out: Person[] = [];
    const seen = new Set<string>();
    const push = (p?: Person) => { if (p && !seen.has(p._id)) { seen.add(p._id); out.push(p); } };
    push(occ);
    for (const rel of normalizePerson(occ ?? ({} as Person)).relatedNames) {
      if (rel.personId) push(byId.get(rel.personId));
    }
    return out;
  }, [people, personId]);

  // Seed once loaded. Edit mode: prefill message/time and re-select the card's
  // recipients (match each saved email back to a candidate + its address). New
  // card: pre-select the occasion's contact when they have an email.
  const seeded = useRef(false);
  // State mirror of the ref, so the discard guard's baseline effect re-runs once
  // seeding is done (a ref change alone wouldn't trigger it).
  const [seededReady, setSeededReady] = useState(false);
  useEffect(() => {
    if (seeded.current || !people) return;
    if (ecardId && !existing) return; // wait for the cards list before seeding an edit
    seeded.current = true;
    setSeededReady(true);
    if (existing) {
      setMessage(existing.message ?? '');
      // Unknown/legacy keys (old rows stored `template: <kind>`) fall back to
      // the kind's default style, matching the server's send-time resolution.
      setTemplate(resolveTemplate(kind, existing.template).key);
      setFont(existing.font ?? '');
      setGreeting(existing.greeting ?? '');
      setSignoff(existing.signoff ?? '');
      setSignature(existing.signature ?? '');
      setServerPhotos(existing.photos ?? []);
      setSendTime(existing.sendTime || '09:00');
      const sel = new Set<string>();
      const chosen: Record<string, string> = {};
      for (const r of existing.recipients ?? []) {
        const match = candidates.find((c) => emailEntriesOf(c).some((e) => e.value === r.email));
        if (match) { sel.add(match._id); chosen[match._id] = r.email; }
      }
      setSelected(sel);
      setChosenEmail(chosen);
      return;
    }
    const occ = personId ? people.find((p) => p._id === personId) : undefined;
    if (occ && chosenEmailOf(occ)) setSelected(new Set([occ._id]));
  }, [people, personId, existing, ecardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addEmail = useMutation({
    mutationFn: async ({ person, email }: { person: Person; email: string }) => {
      const payload = personPayloadWithEmail(person, email);
      await peopleApi.update(person._id, await sealUpdate('Person', person._id, payload, PERSON_ENC({ ...person, ...payload })));
    },
    onSuccess: (_data, vars) => {
      setEmailOverrides((prev) => ({ ...prev, [vars.person._id]: vars.email }));
      setChosenEmail((prev) => ({ ...prev, [vars.person._id]: vars.email }));
      setSelected((prev) => new Set(prev).add(vars.person._id));
      setEditingFor(null);
      setDraftEmail('');
      qc.invalidateQueries({ queryKey: ['people'] });
    },
    onError: () => Alert.alert('Could not save email', 'Please try again.'),
  });

  const save = useMutation({
    mutationFn: async () => {
      const byId = new Map(candidates.map((p) => [p._id, p]));
      const recipients = [...selected]
        .map((id) => byId.get(id))
        .filter((p): p is Person => Boolean(p))
        .map((p) => ({ email: chosenEmailOf(p), name: p.name }))
        .filter((r) => r.email);
      const body = {
        personId, kind, occasionLabel, month, day, sendTime, template, font,
        message, greeting, signoff, signature, recipients,
      };
      const res = existing ? await ecardsApi.update(existing._id, body) : await ecardsApi.create(body);
      // Photos picked this session upload once the card has an id. A failed
      // photo never loses the card — it can be re-added from the edit screen.
      for (const f of localPhotos) {
        try { await uploadFile(ecardPhotoUploadPath(res.data._id), f, 'photo'); } catch { /* keep going */ }
      }
      return res;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ecards'] }); allowLeave(); nav.goBack(); },
    onError: () => Alert.alert('Could not schedule', 'Please check your connection and try again.'),
  });

  // Removing an already-uploaded photo edits the card in place (author-only).
  const removeServerPhoto = useMutation({
    mutationFn: (photoId: string) => ecardsApi.removePhoto(existing!._id, photoId),
    onSuccess: (res) => {
      setServerPhotos(res.data.photos ?? []);
      qc.invalidateQueries({ queryKey: ['ecards'] });
    },
    onError: () => Alert.alert('Could not remove photo', 'Please try again.'),
  });

  const addPhoto = async () => {
    if (serverPhotos.length + localPhotos.length >= MAX_PHOTOS) {
      Alert.alert('Photo limit', `A card can hold up to ${MAX_PHOTOS} photos.`);
      return;
    }
    const file = await pickImage();
    if (file) setLocalPhotos((prev) => [...prev, file]);
  };

  const cancelCard = useMutation({
    mutationFn: () => ecardsApi.remove(existing!._id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ecards'] }); allowLeave(); nav.goBack(); },
    onError: () => Alert.alert('Could not cancel', 'Please try again.'),
  });

  const confirmCancel = () => {
    Alert.alert('Cancel this e-card?', 'It will no longer be sent on the occasion.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel card', style: 'destructive', onPress: () => cancelCard.mutate() },
    ]);
  };

  const onSave = () => {
    const hasRecipient = [...selected].some((id) => {
      const p = candidates.find((c) => c._id === id);
      return p && chosenEmailOf(p);
    });
    if (!hasRecipient) {
      Alert.alert('Pick a recipient', 'Choose at least one contact with an email to send this card to.');
      return;
    }
    save.mutate();
  };

  useHeaderCheckButton(nav, { onPress: onSave, loading: save.isPending, color: accent });
  useEffect(() => { nav.setOptions({ title: existing ? 'Edit E-Card' : 'Schedule E-Card' }); }, [nav, existing]);

  // Discard guard: prompt before leaving with unsaved edits to the card (style,
  // font, its editable lines, send time, recipients, or newly-picked photos).
  // Server photos and inline-added contact emails persist immediately, so they
  // aren't part of the dirty check. Baseline is taken once seeding completes.
  const baselineRef = useRef<string | null>(null);
  const snapshot = JSON.stringify({
    message, template, font, greeting, signoff, signature, sendTime,
    selected: [...selected].sort(), chosenEmail, localPhotos: localPhotos.map((f) => f.uri),
  });
  useEffect(() => {
    if (seededReady && baselineRef.current === null) baselineRef.current = snapshot;
  }, [seededReady, snapshot]);
  const dirty = seededReady && baselineRef.current !== null && snapshot !== baselineRef.current;
  const allowLeave = useUnsavedChangesGuard(nav, dirty);

  if (isLoading) return <CenteredLoader color={accent} />;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startAddEmail = (id: string) => { setEditingFor(id); setDraftEmail(''); };
  const confirmAddEmail = (person: Person) => {
    const email = draftEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { Alert.alert('Enter a valid email', 'That doesn’t look like an email address.'); return; }
    addEmail.mutate({ person, email });
  };

  // Live EDITABLE card: every line of the card face is a text input — blank
  // framing lines show their defaults as placeholders (greeting personalizes
  // per recipient at send time). Mirrors server/src/services/ecardTemplates.js
  // renderECard (cover art + heading, white body, photos, signoff, footer).
  const tpl = resolveTemplate(kind, template);
  // Default greeting addresses the recipient by FIRST name only (mirrors the
  // renderer: contacts store full names, cards speak familiarly).
  const previewRecipient =
    ([...selected].map((id) => candidates.find((c) => c._id === id)).find(Boolean)?.name || personName || 'friend')
      .trim().split(/\s+/)[0];
  const senderName = user?.firstName || 'Me';
  const heading = kind === 'custom' && occasionLabel ? occasionLabel : tpl.heading;
  // Condolence cards move slowly and gently, in the email and here.
  const slow = kind === 'death';
  // Effective typeface (mirrors the renderer: chosen font, else the template's).
  const effFontKey = font || (tpl.serif ? 'serif' : 'sans');
  const cardFont = FONT_NATIVE[effFontKey];
  const bodySize = effFontKey === 'script' ? 16 : 14;
  const greetItalic = font ? ['serif', 'elegant'].includes(font) : tpl.serif;
  // All photos on the card, in display order (uploaded first, then new picks).
  const photoEntries = [
    ...serverPhotos.map((p) => ({
      key: p._id,
      localIdx: -1,
      source: {
        uri: `${API_URL}${ecardPhotoPath(existing?._id ?? '', p._id)}`,
        headers: { Authorization: `Bearer ${getCachedToken() ?? ''}` },
      },
    })),
    ...localPhotos.map((f, i) => ({ key: `local-${i}`, localIdx: i, source: { uri: f.uri } })),
  ];

  return (
    <Screen>
      <SectionHeader>Card style</SectionHeader>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.gallery} contentContainerStyle={styles.galleryContent}>
        {variants.map((v) => (
          <TemplateThumb key={v.key} v={v} selected={v.key === template} accent={accent} onPress={() => setTemplate(v.key)} />
        ))}
      </ScrollView>

      <SectionHeader>Font</SectionHeader>
      <View style={styles.fontRow}>
        {FONT_OPTIONS.map((f) => {
          const sel = font === f.key;
          // The Auto chip previews the template's own face.
          const fam = f.key ? FONT_NATIVE[f.key] : (tpl.serif ? SERIF_FONT : undefined);
          return (
            <TouchableOpacity
              key={f.key || 'auto'}
              style={[styles.fontChip, sel && { borderColor: accent }]}
              onPress={() => setFont(f.key)}
              accessibilityLabel={`${f.label} font`}
            >
              <Text style={[styles.fontChipAa, fam ? { fontFamily: fam } : null]}>Aa</Text>
              <Text style={[styles.fontChipLabel, sel && { color: accent, fontWeight: '600' }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <SectionHeader>Your card</SectionHeader>
      <View style={[styles.preview, { backgroundColor: tpl.wash }]}>
        <View style={styles.previewCard}>
          <View style={styles.previewCover}>
            <CoverGradient from={tpl.g1} to={tpl.g2} id={`cover-${tpl.key}`} />
            <DecoRow deco={tpl.deco} slow={slow} />
            <BobbingPiece index={1} slow={slow}>
              <Text style={styles.previewEmoji}>{tpl.emoji}</Text>
            </BobbingPiece>
            <Text style={[styles.previewHeading, { color: tpl.heroText }, cardFont ? { fontFamily: cardFont } : null, tpl.serif && !font && styles.serifSpacing]}>{heading}</Text>
          </View>
          {/* Every card line is directly editable; placeholders are the send-time
              defaults. A pencil badge + dashed underlines make that tappability
              obvious (the lines otherwise read as finished card text). */}
          <View style={styles.previewBody}>
            <TouchableOpacity
              style={styles.editBadge}
              onPress={focusGreeting}
              accessibilityRole="button"
              accessibilityLabel="Edit card text"
            >
              <Ionicons name="pencil" size={11} color={CARD_MUTED} />
              <Text style={styles.editBadgeText}>Tap to edit</Text>
            </TouchableOpacity>
            <TextInput
              ref={greetingRef}
              value={greeting}
              onChangeText={setGreeting}
              selection={greetSel}
              onSelectionChange={() => { if (greetSel) setGreetSel(undefined); }}
              placeholder={`Dear ${previewRecipient},`}
              placeholderTextColor={CARD_MUTED}
              style={[styles.previewGreeting, styles.editableLine, { fontSize: bodySize }, cardFont ? { fontFamily: cardFont } : null, greetItalic && styles.italic]}
            />
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Write a personal note…"
              placeholderTextColor={CARD_MUTED}
              multiline
              style={[styles.previewMessage, styles.editableLine, { fontSize: bodySize }, cardFont ? { fontFamily: cardFont } : null]}
            />
            {photoEntries.map((p) => (
              <Image key={p.key} source={p.source} style={styles.previewPhoto} resizeMode="cover" />
            ))}
            <TextInput
              value={signoff}
              onChangeText={setSignoff}
              placeholder={tpl.signoff}
              placeholderTextColor={CARD_MUTED}
              style={[styles.previewSignoff, styles.editableLine, { fontSize: bodySize }, cardFont ? { fontFamily: cardFont } : null, effFontKey !== 'script' && styles.italic]}
            />
            <TextInput
              value={signature}
              onChangeText={setSignature}
              placeholder={senderName}
              placeholderTextColor={CARD_MUTED}
              style={[styles.previewSign, styles.editableLine, { fontSize: bodySize }, cardFont ? { fontFamily: cardFont } : null]}
            />
          </View>
          <Text style={styles.previewFooter}>Sent with ♥ through Calen</Text>
        </View>
      </View>
      <Hint>Tap any line on the card to edit it — blank lines use the defaults, and the greeting personalizes to each recipient&apos;s name. The art animates in mail apps that support motion (like Apple Mail).</Hint>

      <SectionHeader>Photos</SectionHeader>
      <View style={styles.photoRow}>
        {photoEntries.map((p) => (
          <View key={p.key} style={styles.photoThumbWrap}>
            <Image source={p.source} style={styles.photoThumb} resizeMode="cover" />
            <TouchableOpacity
              style={styles.photoRemove}
              onPress={() =>
                p.localIdx >= 0
                  ? setLocalPhotos((prev) => prev.filter((_, j) => j !== p.localIdx))
                  : removeServerPhoto.mutate(p.key)
              }
              accessibilityLabel="Remove photo"
            >
              <Ionicons name="close" size={13} color={CARD_WHITE} />
            </TouchableOpacity>
          </View>
        ))}
        {photoEntries.length < MAX_PHOTOS ? (
          <TouchableOpacity style={[styles.photoAdd, { borderColor: accent }]} onPress={addPhoto} accessibilityLabel="Add photo">
            <Ionicons name="add" size={26} color={accent} />
          </TouchableOpacity>
        ) : null}
      </View>
      <Hint>Up to {MAX_PHOTOS} photos, shown on the card between your message and sign-off.</Hint>

      <SectionHeader>Send at</SectionHeader>
      <GroupCard>
        <Select
          inlineLabel="Time on the day"
          value={Number((sendTime || '09:00').split(':')[0])}
          options={HOUR_OPTIONS}
          // Open scrolled to noon: cards are usually sent in daytime, and an
          // AM-first list invites picking "2:00 AM" when "2:00 PM" was meant.
          initialScrollValue={12}
          onChange={(v) => setSendTime(`${String(v).padStart(2, '0')}:00`)}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />
      </GroupCard>
      <Hint>Sends once on {MONTHS[month - 1]} {day}, {nextOccurrenceYear(month, day)} at {to12h(sendTime)} — nothing goes out until then.</Hint>

      <SectionHeader>Recipients</SectionHeader>
      {candidates.length === 0 ? (
        <Hint>This occasion isn&apos;t linked to a contact, so there&apos;s no one to send a card to.</Hint>
      ) : (
        <InfoCard>
          {candidates.map((p) => {
            const entries = emailEntriesOf(p);
            const email = chosenEmailOf(p);
            const isSelected = selected.has(p._id);
            if (editingFor === p._id) {
              return (
                <View key={p._id} style={styles.editRow}>
                  <Text style={styles.editName}>{p.name}</Text>
                  <View style={styles.editInputRow}>
                    <Input
                      value={draftEmail}
                      onChangeText={setDraftEmail}
                      placeholder="name@email.com"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      autoFocus
                      containerStyle={styles.editInput}
                      onSubmitEditing={() => confirmAddEmail(p)}
                    />
                    <TouchableOpacity onPress={() => confirmAddEmail(p)} disabled={addEmail.isPending} style={styles.editSave} accessibilityLabel="Save email">
                      <Ionicons name="checkmark" size={20} color={accent} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { setEditingFor(null); setDraftEmail(''); }} style={styles.editSave} accessibilityLabel="Cancel">
                      <Ionicons name="close" size={20} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }
            if (!email) {
              return (
                <ListRow
                  key={p._id}
                  title={p.name}
                  subtitle="No email — tap to add"
                  onPress={() => startAddEmail(p._id)}
                  iconColor={accent}
                  icon="mail-outline"
                  right={<Ionicons name="add" size={20} color={accent} />}
                />
              );
            }
            return (
              <ListRow
                key={p._id}
                title={p.name}
                subtitle={email}
                onPress={() => toggle(p._id)}
                iconColor={accent}
                icon={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                right={
                  entries.length > 1 ? (
                    // Multiple addresses: a tap-to-switch pill showing the chosen
                    // one's label (doesn't toggle selection).
                    <TouchableOpacity
                      onPress={() => setPickerFor(p._id)}
                      hitSlop={8}
                      style={styles.switchPill}
                      accessibilityLabel={`Change email for ${p.name}`}
                    >
                      <Text style={[styles.switchPillText, { color: accent }]}>{entries.find((e) => e.value === email)?.label || 'Change'}</Text>
                      <Ionicons name="chevron-down" size={14} color={accent} />
                    </TouchableOpacity>
                  ) : isSelected ? (
                    <Ionicons name="checkmark" size={18} color={accent} />
                  ) : undefined
                }
              />
            );
          })}
          {/* Add another recipient by linking a related contact — managed in the
              contact itself. Opens the occasion contact scrolled to Related
              names; anyone linked there becomes a candidate here on return (the
              recipient list = the occasion contact + their related names). */}
          {personId ? (
            <ListRow
              title="Add a related contact"
              subtitle="Opens this contact to link someone related"
              onPress={() => nav.navigate('PersonForm', { id: personId, focus: 'related' })}
              iconColor={accent}
              icon="person-add-outline"
              right={<Ionicons name="chevron-forward" size={18} color={colors.textMuted} />}
            />
          ) : null}
        </InfoCard>
      )}

      {/* Which address a multi-email contact's card goes to. */}
      {pickerFor ? (() => {
        const person = candidates.find((c) => c._id === pickerFor);
        if (!person) return null;
        const entries = emailEntriesOf(person);
        const current = chosenEmailOf(person);
        return (
          <BottomSheet visible onClose={() => setPickerFor(null)} title={`Send to ${person.name}`}>
            {entries.map((e) => (
              <TouchableOpacity
                key={e.value}
                style={styles.pickRow}
                onPress={() => {
                  setChosenEmail((prev) => ({ ...prev, [person._id]: e.value }));
                  setSelected((prev) => new Set(prev).add(person._id));
                  setPickerFor(null);
                }}
              >
                <View style={styles.pickText}>
                  <Text style={styles.pickEmail}>{e.value}</Text>
                  {e.label ? <Text style={styles.pickLabel}>{e.label}</Text> : null}
                </View>
                {e.value === current ? <Ionicons name="checkmark" size={20} color={accent} /> : null}
              </TouchableOpacity>
            ))}
          </BottomSheet>
        );
      })() : null}

      {/* E2EE plaintext-exception disclosure — shown at CREATE time only (a
          deliberate privacy notice; see crypto-e2ee.md). The edit view drops it
          once the card already exists. */}
      {!existing ? (
        <Hint>To deliver this card on the day, the message, photos, and recipient emails are sent to Calen&apos;s servers — this occasion card leaves your device&apos;s encryption, like an email invite.</Hint>
      ) : null}

      {existing ? (
        <View style={styles.cancelWrap}>
          <Button variant="danger" title="Cancel scheduled card" onPress={confirmCancel} loading={cancelCard.isPending} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Gallery of card styles.
  gallery: { marginBottom: spacing.md },
  galleryContent: { gap: spacing.sm, paddingRight: spacing.md },
  thumbWrap: { width: 108 },
  thumb: {
    height: 120, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8, borderWidth: 2, borderColor: 'transparent',
  },
  thumbEmoji: { fontSize: 30, marginBottom: 6 },
  thumbHeading: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  thumbLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 6 },
  thumbName: { fontSize: 12, color: colors.textMuted },

  // Card-face preview. Face colours are the *email's* palette (deliberately
  // not the app theme) — see CARD_WHITE above.
  preview: {
    borderRadius: radius.lg, marginBottom: spacing.sm, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  previewCard: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: CARD_WHITE },
  previewCover: { paddingVertical: spacing.lg, paddingHorizontal: spacing.md, alignItems: 'center', overflow: 'hidden' },
  decoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, height: 26, marginBottom: 6 },
  decoEmoji: { fontSize: 16 },
  confetti: { width: 8, height: 8, borderRadius: 2 },
  previewEmoji: { fontSize: 42, textAlign: 'center', marginBottom: 8 },
  previewHeading: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  serifSpacing: { letterSpacing: 0.5 },
  italic: { fontStyle: 'italic' },
  previewBody: { paddingVertical: spacing.lg, paddingHorizontal: spacing.md },
  // "Tap to edit" affordance pinned to the card body's top-right corner.
  editBadge: {
    position: 'absolute', top: 6, right: spacing.md, zIndex: 1,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#F1F2F4', borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2,
  },
  editBadgeText: { fontSize: 10, fontWeight: '600', color: CARD_MUTED },
  // A faint dashed underline signalling each card line is a tappable field.
  editableLine: { borderBottomWidth: 1, borderBottomColor: '#E5E7EB', borderStyle: 'dashed', paddingBottom: 3 },
  // The card lines are bare TextInputs styled as card text (padding zeroed so
  // they sit exactly where static text would).
  previewGreeting: { color: CARD_TEXT, marginBottom: 8, padding: 0 },
  previewMessage: { color: CARD_TEXT, lineHeight: 20, marginBottom: spacing.md, padding: 0, minHeight: 40, textAlignVertical: 'top' },
  previewPhoto: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, marginBottom: spacing.md },
  previewSignoff: { color: CARD_TEXT, padding: 0 },
  previewSign: { color: CARD_TEXT, fontWeight: '700', marginTop: 2, padding: 0 },
  previewFooter: {
    fontSize: 11, color: CARD_MUTED, textAlign: 'center', paddingVertical: 8, paddingHorizontal: spacing.md,
    borderTopWidth: 1, borderTopColor: '#F1F2F4', backgroundColor: CARD_WHITE,
  },

  // Font chips (custom, not the filter Chip: each swatch renders in its face).
  fontRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  fontChip: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.md,
    borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface,
  },
  fontChipAa: { fontSize: 20, color: colors.text },
  fontChipLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  // Photo strip.
  photoRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  photoThumbWrap: { position: 'relative' },
  photoThumb: { width: 76, height: 76, borderRadius: radius.md },
  photoRemove: {
    position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  photoAdd: {
    width: 76, height: 76, borderRadius: radius.md, borderWidth: 2, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  cancelWrap: { marginTop: spacing.md },
  editRow: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  editName: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 6 },
  editInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  editInput: { flex: 1, marginBottom: 0 },
  editSave: { padding: 4 },
  switchPill: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  switchPillText: { fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, gap: spacing.md },
  pickText: { flex: 1 },
  pickEmail: { fontSize: 15, color: colors.text },
  pickLabel: { fontSize: 12, color: colors.textMuted, marginTop: 2, textTransform: 'capitalize' },
});
