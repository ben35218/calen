// Type declarations for @household/weather.

export interface WeatherHour {
  time: string;
  hour: number;
  temperature: number;
  precipProbability: number;
  precipitation: number;
  weatherCode: number;
  description: string;
}

export interface WeatherDay {
  date: string;
  weatherCode: number;
  description: string;
  tempMax: number;
  tempMin: number;
  precipSum: number;
  precipProbability: number;
  windMax: number;
  goodWeather: boolean;
  sunrise?: string;
  sunset?: string;
  hours: WeatherHour[];
}

export interface WeatherForecast {
  current: {
    temperature: number;
    weatherCode: number;
    description: string;
    precipitation: number;
    humidity: number;
    windSpeed: number;
  } | null;
  forecast: WeatherDay[];
  units: { temperature: string; precipitation: string; wind: string };
}

// Calendar overlay record (a day of weather, forecast or archived).
export interface WeatherRangeRecord {
  date: string;
  weatherCode: number;
  description: string;
  tempMax: number;
  tempMin: number;
  precipSum: number;
  precipProbability: number | null;
  windMax: number;
  goodWeather: boolean;
  hours?: WeatherHour[];
}

export interface OutlookWeek {
  startDate: string;
  endDate: string;
  avgTempMax: number;
  avgTempMin: number;
  totalPrecip: number;
  rainyDays: number;
  yearsInSample: number;
}

// Per-day historical average (trip "typical weather").
export interface ClimateDay {
  date: string;
  avgTempMax: number | null;
  avgTempMin: number | null;
  avgPrecip: number | null;
  rainYears: number;
  yearsInSample: number;
}

export const WMO_DESCRIPTIONS: Record<number, string>;
export function isMowingDay(precipSum: number, precipProb: number | null, prevPrecipSum: number): boolean;
export function buildForecast(raw: any): WeatherForecast;
export function geocode(address: string): Promise<{ lat: number; lon: number }>;
export function geocodePlace(place: string): Promise<{ lat: number; lon: number }>;
export function placeCandidates(place: string): string[];
export function fetchWeather(lat: number, lon: number): Promise<any>;
export function timezoneForCoords(lat: number, lon: number): Promise<string | null>;
export function locationTimezone(address: string, opts?: { geocoder?: (address: string) => Promise<{ lat: number; lon: number }> }): Promise<string | null>;
export function regionForAddress(address: string): Promise<{ countryCode: string | null; state: string | null } | null>;
export function loadWeatherForAddress(address: string, opts?: { geocoder?: (address: string) => Promise<{ lat: number; lon: number }> }): Promise<WeatherForecast>;
export function loadWeatherForCoords(lat: number, lon: number): Promise<WeatherForecast>;
export function fetchWeatherArchive(lat: number, lon: number, startDate: string, endDate: string): Promise<any>;
export function buildRangeRecords(args: { archiveRaw: any; forecast?: WeatherDay[]; from: string; to: string }): WeatherRangeRecord[];
export function loadWeatherRange(address: string, from: string, to: string): Promise<{ records: WeatherRangeRecord[] }>;
export function buildOutlook(archiveResults: any[], opts?: { today?: Date; days?: number }): { weeks: OutlookWeek[] };
export function loadOutlook(address: string, opts?: { today?: Date; days?: number; geocoder?: (address: string) => Promise<{ lat: number; lon: number }> }): Promise<{ weeks: OutlookWeek[] }>;
export function loadOutlookForCoords(lat: number, lon: number, opts?: { today?: Date; days?: number }): Promise<{ weeks: OutlookWeek[] }>;
export function buildDailyClimate(archiveResults: any[], opts: { dates: string[] }): ClimateDay[];
export function loadDailyClimate(address: string, from: string, to: string, opts?: { years?: number; geocoder?: (address: string) => Promise<{ lat: number; lon: number }> }): Promise<{ days: ClimateDay[] }>;
