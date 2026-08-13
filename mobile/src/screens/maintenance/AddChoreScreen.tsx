import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Text } from '../../components/Text';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Screen } from '../../components/ui';
import { GroupCard, CardDivider } from '../../components/formStyles';
import { useCalendarColors } from '../../lib/calendarPrefs';
import { MaintenanceStackParamList } from '../../navigation/MaintenanceNavigator';
import { colors, spacing } from '../../theme';

type Nav = NativeStackNavigationProp<MaintenanceStackParamList, 'AddChore'>;

// Chooser shown when tapping "+" on the Chores list — mirrors the item form's
// "What would you like to add?" scope step: create a chore by hand, or start
// from the template catalog.
export default function AddChoreScreen() {
  const navigation = useNavigation<Nav>();
  const accent = useCalendarColors().colors.chores;

  return (
    <Screen>
      <Text style={styles.intro}>What would you like to add?</Text>
      <GroupCard>
        <TouchableOpacity
          style={styles.typeRow}
          activeOpacity={0.7}
          onPress={() => navigation.replace('ChoreForm', {})}
        >
          <View style={[styles.typeAvatar, { backgroundColor: accent }]}>
            <MaterialCommunityIcons name="broom" size={24} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.typeLabel}>Add a chore</Text>
            <Text style={styles.typeDesc}>Create one chore and set its schedule yourself.</Text>
          </View>
        </TouchableOpacity>
        <CardDivider />
        <TouchableOpacity
          style={styles.typeRow}
          activeOpacity={0.7}
          onPress={() => navigation.replace('ChoreTemplates')}
        >
          <View style={[styles.typeAvatar, { backgroundColor: '#7C4DFF' }]}>
            <MaterialCommunityIcons name="clipboard-list-outline" size={24} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.typeLabel}>Use a template</Text>
            <Text style={styles.typeDesc}>Pick a ready-made chore from the catalog and tweak it.</Text>
          </View>
        </TouchableOpacity>
      </GroupCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, color: colors.textMuted, marginBottom: spacing.md },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: 14, paddingVertical: 10 },
  typeAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  typeLabel: { fontSize: 16, fontWeight: '700', color: colors.text },
  typeDesc: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
});
