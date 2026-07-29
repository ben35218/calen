import React, { useLayoutEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Sharing from 'expo-sharing';
import { RootStackParamList } from '../../navigation/types';

type Rt = RouteProp<RootStackParamList, 'AttachmentPreview'>;
type Nav = NativeStackNavigationProp<RootStackParamList, 'AttachmentPreview'>;

// In-app preview of a decrypted attachment. A WebView (WKWebView on iOS) renders
// both local images AND PDFs inline from a file:// URI — the reliable path, since
// RN's <Image> crashes on the new architecture. The header carries a Share button
// (hands the same file to the OS share sheet).
export default function AttachmentPreviewScreen() {
  const { params } = useRoute<Rt>();
  const navigation = useNavigation<Nav>();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={async () => {
            try {
              if (await Sharing.isAvailableAsync()) {
                await Sharing.shareAsync(params.uri, { mimeType: params.mimeType || undefined });
              }
            } catch (e: any) {
              Alert.alert('Could not share', e?.message || 'Please try again.');
            }
          }}
          accessibilityLabel="Share attachment"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="share-outline" size={24} color="#fff" />
        </TouchableOpacity>
      ),
    });
  }, [navigation, params.uri, params.mimeType]);

  return (
    <View style={styles.root}>
      <WebView
        source={{ uri: params.uri }}
        style={styles.web}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        scalesPageToFit
        onError={() =>
          Alert.alert('Could not preview', 'This file could not be shown. Use Share to open it in another app.')
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
