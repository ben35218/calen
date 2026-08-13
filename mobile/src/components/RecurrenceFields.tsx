import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { Input, Select, SegmentedControl, Chip, SectionTitle } from './ui';
import { form as fs, GroupCard, CardDivider } from './formStyles';
import {
  RecurrenceForm,
  MonthlyMode,
  RECURRENCE_TYPE_OPTIONS,
  INTERVAL_UNIT_OPTIONS,
  WEEK_OF_MONTH_OPTIONS,
  MONTH_OPTIONS,
  WEEKDAYS,
  recurrencePreview,
} from '../lib/recurrence';
import { colors, spacing } from '../theme';

// The recurrence builder shared by TaskFormScreen and ChoreFormScreen — mirrors
// the interval/calendar/one-time editor from the web TaskFormView/ChoreFormView,
// rendered as one iOS-style grouped card.
export default function RecurrenceFields({
  form,
  monthlyMode,
  onChange,
  onChangeMonthlyMode,
}: {
  form: RecurrenceForm;
  monthlyMode: MonthlyMode;
  onChange: (patch: Partial<RecurrenceForm>) => void;
  onChangeMonthlyMode: (m: MonthlyMode) => void;
}) {
  const preview = recurrencePreview(form, monthlyMode);

  return (
    <View>
      <SectionTitle>Recurrence</SectionTitle>

      <GroupCard>
        <Select
          inlineLabel="Type"
          value={form.type}
          options={RECURRENCE_TYPE_OPTIONS}
          onChange={(v) => onChange({ type: (v as RecurrenceForm['type']) ?? 'interval' })}
          containerStyle={fs.dtFieldWrap}
          fieldStyle={fs.rowField}
          valueStyle={fs.dtValue}
          chevronIcon="chevron-expand"
        />

        {form.type === 'interval' ? (
          <>
            <CardDivider />
            <View style={fs.dtRow}>
              <Text style={fs.dtLabel}>Every</Text>
              <Input
                keyboardType="numeric"
                clearable={false}
                value={String(form.intervalValue ?? '')}
                onChangeText={(v) => onChange({ intervalValue: Number(v) || 1 })}
                containerStyle={[fs.headField, styles.everyInputWrap]}
                style={[fs.headInput, styles.everyInput]}
              />
              <Select
                value={form.intervalUnit}
                options={INTERVAL_UNIT_OPTIONS}
                onChange={(v) => onChange({ intervalUnit: (v as RecurrenceForm['intervalUnit']) ?? 'weeks' })}
                containerStyle={fs.dtFieldWrap}
                fieldStyle={fs.dtField}
                valueStyle={fs.dtValue}
                chevronIcon="chevron-expand"
              />
            </View>

            {form.intervalUnit === 'weeks' ? (
              <>
                <CardDivider />
                <WeekdayChips
                  value={form.dayOfWeek}
                  onChange={(d) => onChange({ dayOfWeek: form.dayOfWeek === d ? null : d })}
                  label="On (optional)"
                />
              </>
            ) : null}

            {form.intervalUnit === 'months' ? (
              <>
                <CardDivider />
                <View style={styles.padSection}>
                  <Text style={styles.fieldLabel}>On (optional)</Text>
                  <SegmentedControl<MonthlyMode>
                    value={monthlyMode}
                    onChange={onChangeMonthlyMode}
                    options={[
                      { label: 'Specific day', value: 'day' },
                      { label: 'Day of week', value: 'weekday' },
                    ]}
                  />
                </View>
                {monthlyMode === 'day' ? (
                  <>
                    <CardDivider />
                    <View style={fs.dtRow}>
                      <Text style={fs.dtLabel}>Day of month</Text>
                      <Input
                        keyboardType="numeric"
                        clearable={false}
                        value={form.dayOfMonth != null ? String(form.dayOfMonth) : ''}
                        onChangeText={(v) => onChange({ dayOfMonth: v ? Number(v) : null })}
                        containerStyle={[fs.headField, fs.rowInputWrap]}
                        style={[fs.headInput, fs.rowInput]}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <CardDivider />
                    <Select
                      inlineLabel="Which occurrence"
                      value={form.weekOfMonth ?? undefined}
                      options={WEEK_OF_MONTH_OPTIONS}
                      onChange={(v) => onChange({ weekOfMonth: (v as number) ?? null })}
                      containerStyle={fs.dtFieldWrap}
                      fieldStyle={fs.rowField}
                      valueStyle={fs.dtValue}
                      chevronIcon="chevron-expand"
                    />
                    <CardDivider />
                    <WeekdayChips
                      value={form.dayOfWeek}
                      onChange={(d) => onChange({ dayOfWeek: d })}
                      label="Weekday"
                    />
                  </>
                )}
              </>
            ) : null}

            {form.intervalUnit === 'years' ? (
              <>
                <CardDivider />
                <Select
                  inlineLabel="In month (optional)"
                  clearable
                  placeholder="Any"
                  value={form.months?.[0] ?? undefined}
                  options={MONTH_OPTIONS}
                  onChange={(v) => onChange({ months: v ? [v as number] : [] })}
                  containerStyle={fs.dtFieldWrap}
                  fieldStyle={fs.rowField}
                  valueStyle={fs.dtValue}
                  chevronIcon="chevron-expand"
                />
                <CardDivider />
                <View style={fs.dtRow}>
                  <Text style={fs.dtLabel}>On day (optional)</Text>
                  <Input
                    keyboardType="numeric"
                    clearable={false}
                    value={form.dayOfMonth != null ? String(form.dayOfMonth) : ''}
                    onChangeText={(v) => onChange({ dayOfMonth: v ? Number(v) : null })}
                    containerStyle={[fs.headField, fs.rowInputWrap]}
                    style={[fs.headInput, fs.rowInput]}
                  />
                </View>
              </>
            ) : null}
          </>
        ) : null}

        {form.type === 'calendar' ? (
          <>
            <CardDivider />
            <Select
              inlineLabel="Months"
              multiple
              values={form.months}
              options={MONTH_OPTIONS}
              onChangeMultiple={(v) => onChange({ months: (v as number[]).sort((a, b) => a - b) })}
              containerStyle={fs.dtFieldWrap}
              fieldStyle={fs.rowField}
              valueStyle={fs.dtValue}
              chevronIcon="chevron-expand"
            />
            <CardDivider />
            <View style={fs.dtRow}>
              <Text style={fs.dtLabel}>On day of month</Text>
              <Input
                keyboardType="numeric"
                clearable={false}
                value={form.dayOfMonth != null ? String(form.dayOfMonth) : ''}
                onChangeText={(v) => onChange({ dayOfMonth: v ? Number(v) : null })}
                containerStyle={[fs.headField, fs.rowInputWrap]}
                style={[fs.headInput, fs.rowInput]}
              />
            </View>
          </>
        ) : null}
      </GroupCard>

      {preview ? (
        <View style={styles.preview}>
          <Text style={styles.previewText}>{preview}</Text>
        </View>
      ) : null}
    </View>
  );
}

function WeekdayChips({
  value,
  onChange,
  label,
}: {
  value: number | null;
  onChange: (d: number) => void;
  label: string;
}) {
  return (
    <View style={styles.padSection}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {WEEKDAYS.map((d, i) => (
          <Chip key={i} label={d} selected={value === i} onPress={() => onChange(i)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  padSection: { paddingHorizontal: 14, paddingVertical: spacing.sm },
  fieldLabel: { fontSize: 13, color: colors.textMuted, marginBottom: 6, fontWeight: '500' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  // "Every N" — a compact right-aligned number before the unit pill.
  everyInputWrap: { flex: 1 },
  everyInput: { textAlign: 'right', paddingHorizontal: 0, minWidth: 48 },
  preview: {
    backgroundColor: colors.primary + '14',
    borderRadius: 8,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  previewText: { color: colors.primaryDark, fontSize: 14, fontWeight: '500' },
});
