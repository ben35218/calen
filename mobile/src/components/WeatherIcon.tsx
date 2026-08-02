import React from 'react';
import { StyleProp, TextStyle, View, ViewStyle } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// One weather icon for a WMO code. MCI's weather-* glyphs draw clouds as
// outlines, so anything with a cloud uses Ionicons' solid-fill glyphs instead
// (Apple Weather look); the gold MCI sun and fog stay because those look right.
// `night` swaps clear/partly-cloudy for moon variants.

const GOLD = '#F4C542';
const WHITE = '#FFFFFF';
const MOON = '#EDEFF5';
const RAIN = '#4FA3E3';

// Partly cloudy is two-tone (icon fonts are single-colour): gold sun / pale
// moon peeking out top-right behind a solid white cloud.
function PartlyCloudy({ night, size, style }: { night: boolean; size: number; style?: StyleProp<TextStyle> }) {
  return (
    <View style={[{ width: size, height: size }, style as StyleProp<ViewStyle>]}>
      <Ionicons
        name={night ? 'moon' : 'sunny'}
        size={size * 0.62}
        color={night ? MOON : GOLD}
        style={{ position: 'absolute', top: 0, right: 0 }}
      />
      <Ionicons name="cloud" size={size * 0.78} color={WHITE} style={{ position: 'absolute', bottom: 0, left: 0 }} />
    </View>
  );
}

// Rain intensity from the WMO code: drizzle + "light" codes → light, "heavy"
// codes → heavy, the rest moderate. Exported for tests.
export type RainIntensity = 'light' | 'moderate' | 'heavy';
export function rainIntensity(code: number): RainIntensity {
  if (code === 65 || code === 67 || code === 82) return 'heavy';
  if (code === 55 || code === 57 || code === 63 || code === 66 || code === 81) return 'moderate';
  return 'light'; // 51, 53, 56, 61, 80
}

// Rain is the classic two-tone composite: blue rain streaks under a solid
// white cloud (Apple Weather look). Only the streaks (drops) vary with
// intensity — the cloud is identical every time. We render just the LOWER
// band of the `rainy` glyph so its own (blue) cloud is never shown; the white
// cloud on top is the only cloud, always full and never peeking blue. Lighter
// rain clips that streak band's width from the right, revealing fewer of the
// same streaks; heavy shows them all (the original icon).
const STREAK_BAND_TOP = 0.62; // below the glyph's cloud; the white cloud covers down to ~0.78
function Rainy({ size, style, intensity }: { size: number; style?: StyleProp<TextStyle>; intensity: RainIntensity }) {
  const streakCut = intensity === 'light' ? 0.55 : intensity === 'moderate' ? 0.78 : 1;
  const bandTop = size * STREAK_BAND_TOP;
  return (
    <View style={[{ width: size, height: size }, style as StyleProp<ViewStyle>]}>
      {/* Streak band: only the glyph's rain streaks, clipped to the left
          `streakCut` fraction so fewer streaks show for lighter rain. */}
      <View style={{ position: 'absolute', top: bandTop, left: 0, width: size * streakCut, height: size - bandTop, overflow: 'hidden' }}>
        <Ionicons name="rainy" size={size} color={RAIN} style={{ position: 'absolute', top: -bandTop, left: 0 }} />
      </View>
      {/* Consistent white cloud — identical for every intensity, drawn on top
          so any blue cloud bottom inside the band is covered. */}
      <Ionicons
        name="cloud"
        size={size * 0.74}
        color={WHITE}
        style={{ position: 'absolute', top: size * 0.04, left: size * 0.13 }}
      />
    </View>
  );
}

// Thunderstorm: white cloud, blue rain drops, gold bolt. Like Rainy, only the
// LOWER band of the glyph is ever rendered, so the glyph's own cloud can never
// peek past the white overlay. Within that band the glyph is drawn twice: blue
// for the drops, and gold clipped to the centre strip for the bolt. Geometry is
// measured from the Ionicons TTF (advance = exactly 1em, so fractions of `size`
// are exact): the glyph's cloud bottoms out at y 0.65; drops sit at x
// 0.154–0.299 / 0.703–0.844 (y ≥ 0.662); the bolt (one contour with the cloud)
// spans x 0.344–0.662 below the cloud. CRITICAL: every clipped inner glyph
// needs an explicit `width: size` — an RN Text measures at most its parent's
// width and iOS clips the glyph to the Text's OWN bounds, so inside a narrow
// clip wrapper an auto-width glyph shows only its leftmost slice (or, offset
// negatively, nothing at all) no matter where the wrapper's window sits.
const THUNDER_BAND_TOP = 0.65; // just below the glyph cloud's bottom edge
function Thunderstorm({ size, style }: { size: number; style?: StyleProp<TextStyle> }) {
  const bandTop = size * THUNDER_BAND_TOP;
  const boltLeft = size * 0.34;
  const boltWidth = size * 0.33; // x 0.34–0.67 window: the bolt, clear of both drop pairs
  return (
    <View style={[{ width: size, height: size }, style as StyleProp<ViewStyle>]}>
      {/* Lower band, blue: the rain drops (and the bolt, re-coloured below). */}
      <View style={{ position: 'absolute', top: bandTop, left: 0, width: size, height: size - bandTop, overflow: 'hidden' }}>
        <Ionicons name="thunderstorm" size={size} color={RAIN} style={{ position: 'absolute', top: -bandTop, left: 0, width: size }} />
      </View>
      {/* Centre strip of the lower band, gold: the bolt only. */}
      <View style={{ position: 'absolute', top: bandTop, left: boltLeft, width: boltWidth, height: size - bandTop, overflow: 'hidden' }}>
        <Ionicons name="thunderstorm" size={size} color={GOLD} style={{ position: 'absolute', top: -bandTop, left: -boltLeft, width: size }} />
      </View>
      {/* Consistent white cloud on top — the only cloud ever drawn. */}
      <Ionicons
        name="cloud"
        size={size * 0.74}
        color={WHITE}
        style={{ position: 'absolute', top: size * 0.04, left: size * 0.13 }}
      />
    </View>
  );
}

type Spec = { ion?: React.ComponentProps<typeof Ionicons>['name']; mci?: string; color: string };

function spec(code: number, night: boolean): Spec {
  if (code <= 1) return night ? { ion: 'moon', color: MOON } : { mci: 'weather-sunny', color: GOLD };
  if (code === 3) return { ion: 'cloudy', color: WHITE };
  if (code === 45 || code === 48) return { mci: 'weather-fog', color: '#E8EEF4' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { ion: 'snow', color: '#EAF7FF' };
  return { ion: 'cloudy', color: WHITE };
}

export default function WeatherIcon({
  code,
  night = false,
  size,
  style,
}: {
  code: number;
  night?: boolean;
  size: number;
  style?: StyleProp<TextStyle>;
}) {
  if (code === 2) return <PartlyCloudy night={night} size={size} style={style} />;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return <Rainy size={size} style={style} intensity={rainIntensity(code)} />;
  if (code >= 95) return <Thunderstorm size={size} style={style} />;
  const s = spec(code, night);
  if (s.ion) return <Ionicons name={s.ion} size={size} color={s.color} style={style} />;
  return <MaterialCommunityIcons name={s.mci as any} size={size} color={s.color} style={style} />;
}
