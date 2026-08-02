import React, { useLayoutEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { placeUrl } from '../../lib/chatLinks';
import { RootStackParamList } from '../../navigation/types';

type Rt = RouteProp<RootStackParamList, 'PlacePreview'>;
type Nav = NativeStackNavigationProp<RootStackParamList, 'PlacePreview'>;

// Full-screen in-app preview of a place Calen mentioned in chat: a modal
// WebView on the Google Maps place lookup (map, hours, reviews, photos — no
// Places API key needed). Closing the modal drops the user straight back into
// the conversation where they left off; a header compass hands the same
// lookup to the system (the Google Maps app / default browser) for
// directions-grade interaction.
export default function PlacePreviewScreen() {
  const { params } = useRoute<Rt>();
  const navigation = useNavigation<Nav>();
  const url = placeUrl(params.query);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => Linking.openURL(url).catch(() => {})}
          accessibilityLabel="Open in Maps"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="compass-outline" size={24} color="#fff" />
        </TouchableOpacity>
      ),
    });
  }, [navigation, url]);

  return (
    <View style={styles.root}>
      <WebView
        source={{ uri: url }}
        style={styles.web}
        onError={() =>
          Alert.alert('Could not load', 'The place preview could not be shown. Use the compass to open it in Maps.')
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
