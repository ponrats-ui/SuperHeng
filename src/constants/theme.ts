/**
 * SuperHeng design system.
 *
 * Designed to read like a financial-analytics app (navy + white surfaces,
 * crimson/gold accents, green/amber/grey data tones) rather than a gambling UI.
 *
 * Every theme exposes the same key set, so `Colors[scheme]` is interchangeable
 * and `ThemeColor` stays a safe union.
 */

import '@/global.css';

import { Platform } from 'react-native';

/** Raw brand + data hues. Use these directly for non-theme colors (charts, badges). */
export const Brand = {
  /** Primary action / brand accent. */
  crimson: '#C8102E',
  /** Slightly brighter crimson, used on dark surfaces for contrast. */
  crimsonBright: '#E8394F',
  crimsonDeep: '#7C0A1B',
  /** Premium accent, used for "heng" quality highlights. */
  gold: '#D4AF37',
  goldBright: '#F0CE63',
  goldDeep: '#8A6A16',
} as const;

/** Semantic data colors shared by both themes. */
export const DataColors = {
  /** High probability (>= 75). */
  high: '#2ECC71',
  /** Medium probability (55 - 74). */
  medium: '#F2C13B',
  /** Low probability (< 55). */
  low: '#E0524A',
  /** Cold / no signal. */
  cold: '#7C8497',
} as const;

export type ProbabilityTone = 'high' | 'medium' | 'low' | 'cold';

/** Maps a 0-100 score to a signal tone. */
export function probabilityTone(score: number): ProbabilityTone {
  if (score >= 75) return 'high';
  if (score >= 55) return 'medium';
  if (score >= 35) return 'low';
  return 'cold';
}

/** Resolves a 0-100 score to its data color. */
export function probabilityColor(score: number): string {
  return DataColors[probabilityTone(score)];
}

export const Colors = {
  light: {
    text: '#0B1220',
    textSecondary: '#5B6478',
    textMuted: '#8A93A6',
    background: '#F4F6FB',
    backgroundElement: '#EBEEF6',
    backgroundSelected: '#DDE2EF',
    card: '#FFFFFF',
    cardBorder: '#E3E7F0',
    tabBar: '#FFFFFF',
    primary: Brand.crimson,
    onPrimary: '#FFFFFF',
    accent: Brand.goldDeep,
    gold: Brand.gold,
    success: DataColors.high,
    warning: DataColors.medium,
    danger: DataColors.low,
    neutral: DataColors.cold,
    overlay: 'rgba(11, 18, 32, 0.45)',
    shadow: '#0B1220',
  },
  dark: {
    text: '#F5F7FC',
    textSecondary: '#A7AFC2',
    textMuted: '#6E7689',
    background: '#070B18',
    backgroundElement: '#101628',
    backgroundSelected: '#1A2138',
    card: '#0E1424',
    cardBorder: '#1D2540',
    tabBar: '#0A0F1E',
    primary: Brand.crimsonBright,
    onPrimary: '#FFFFFF',
    accent: Brand.goldBright,
    gold: Brand.goldBright,
    success: DataColors.high,
    warning: DataColors.medium,
    danger: DataColors.low,
    neutral: DataColors.cold,
    overlay: 'rgba(3, 6, 14, 0.6)',
    shadow: '#000000',
  },
} as const;

export type ColorScheme = keyof typeof Colors;
export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/** Hex/rgba color values for both themes. */
export type Theme = (typeof Colors)[ColorScheme];

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/** Tabular-ish numeric font stack so score columns line up. */
export const NumericFont = Fonts?.mono ?? 'monospace';

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
/** Wider cap for the tablet-optimised Insights screen. */
export const TabletContentWidth = 1100;
