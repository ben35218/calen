import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { API_URL } from '../config';
import { getCachedToken } from '../lib/secureToken';
import { colors, spacing, radius } from '../theme';

// A place's map card: the Google Static Map (with a pin) as the backdrop and a
// Street View thumbnail overlaid, mirroring Apple Calendar's look. Images come
// from the server proxy (/places/staticmap, /places/streetview) which keeps the
// API key server-side; each hides itself if the image is unavailable. Tapping
// opens the address in the device's Maps app.
//
// Shared by every detail view that closes on a location — a calendar event and a
// trip booking are the same card, and a booking's 2 PM museum has no reason to
// look different from Tuesday's 2 PM dentist.
export default function LocationCard({
  location,
  onOpen,
  onUnavailable,
}: {
  location: string;
  onOpen: () => void;
  // Fired when the map imagery can't load, so the screen can fall back (the
  // event view swaps its floating Delete pill for a plain button).
  onUnavailable?: () => void;
}) {
  const [mapOk, setMapOk] = useState(true);
  const [svOk, setSvOk] = useState(true);
  const token = getCachedToken();
  const q = encodeURIComponent(location);
  const mapUri = `${API_URL}/places/staticmap?token=${token}&q=${q}&w=640&h=320`;
  const svUri = `${API_URL}/places/streetview?token=${token}&q=${q}&w=280&h=280`;

  if (!mapOk) return null; // no map imagery → the address row above already shows it
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onOpen} style={styles.mapCard}>
      <Image source={{ uri: mapUri }} style={styles.mapImage} onError={() => { setMapOk(false); onUnavailable?.(); }} />
      {svOk ? (
        <Image source={{ uri: svUri }} style={styles.streetView} onError={() => setSvOk(false)} />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  mapCard: {
    height: 160, borderRadius: radius.lg, overflow: 'hidden',
    marginTop: spacing.lg, backgroundColor: colors.surface,
  },
  mapImage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' },
  streetView: {
    position: 'absolute', left: spacing.md, bottom: spacing.md,
    width: 96, height: 96, borderRadius: radius.md,
    borderWidth: 2, borderColor: '#fff',
  },
});
