// Single source of truth for how the weather view is tinted by the current WMO
// weather code + local time of day. Both the full-screen sky gradient
// (SkyBackground) and the solid forecast cards (WeatherScreen, plus the header
// edit button) read from here so they always match.

export function isNight(d: Date = new Date()): boolean {
  const h = d.getHours();
  return h < 6 || h >= 20;
}

// Broad visual category driving which animated overlay SkyBackground draws.
export type SkyKind = 'clear' | 'clouds' | 'fog' | 'rain' | 'snow' | 'storm';

export function skyKind(code: number | undefined): SkyKind {
  if (code === undefined || code <= 2) return 'clear'; // clear / partly cloudy
  if (code === 3) return 'clouds'; // overcast
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'clouds';
}

// top → horizon gradient colors, kept dark enough at the horizon that the
// app's light text stays readable on the translucent cards above it.
export function skyPalette(code: number | undefined, night: boolean = isNight()): [string, string] {
  if (night) {
    if (code === undefined || code <= 2) return ['#0B1430', '#27395E']; // clear night
    return ['#0F141D', '#28303C']; // any weather at night
  }
  if (code === undefined || code <= 1) return ['#2E71C9', '#8FBBE8']; // clear
  if (code === 2 || code === 3) return ['#4A7CB8', '#96B4D2']; // partly cloudy / overcast
  if (code === 45 || code === 48) return ['#5B6672', '#98A3AE']; // fog
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return ['#39485D', '#6A7B8F']; // rain
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['#6E7F94', '#ABB9C7']; // snow
  if (code >= 95) return ['#2A3242', '#4E586B']; // thunderstorm
  return ['#4A7CB8', '#96B4D2'];
}

// Solid fill + border for the forecast cards, chosen ≈ the gradient where the
// cards sit (a little above the horizon) so they read as part of the same sky.
export function weatherCardColors(
  code: number | undefined,
  night: boolean = isNight(),
): { bg: string; border: string } {
  const border = 'rgba(255,255,255,0.22)';
  if (night) {
    if (code === undefined || code <= 2) return { bg: '#1E2E52', border }; // clear night
    return { bg: '#232B37', border }; // any weather at night
  }
  if (code === undefined || code <= 1) return { bg: '#5089D2', border }; // clear
  if (code === 2 || code === 3) return { bg: '#5A83B3', border }; // partly cloudy / overcast
  if (code === 45 || code === 48) return { bg: '#727C88', border }; // fog
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return { bg: '#4C5C71', border }; // rain
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { bg: '#828FA0', border }; // snow
  if (code >= 95) return { bg: '#3B4456', border }; // thunderstorm
  return { bg: '#5A83B3', border };
}
