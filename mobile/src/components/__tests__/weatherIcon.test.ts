import { rainIntensity } from '../WeatherIcon';

describe('rainIntensity', () => {
  it('maps drizzle and light codes to light', () => {
    for (const code of [51, 53, 56, 61, 80]) expect(rainIntensity(code)).toBe('light');
  });

  it('maps moderate codes to moderate', () => {
    for (const code of [55, 57, 63, 66, 81]) expect(rainIntensity(code)).toBe('moderate');
  });

  it('maps heavy codes to heavy', () => {
    for (const code of [65, 67, 82]) expect(rainIntensity(code)).toBe('heavy');
  });
});
