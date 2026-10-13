import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type HeaderIconButtonProps = {
  ios: SFSymbol;
  android: AndroidSymbol;
  /** Accessibility label — the button renders an icon with no visible text. */
  label: string;
  onPress: () => void;
};

/**
 * Compact circular icon button sized to match the header monogram.
 *
 * Uses `expo-symbols` rather than an icon font so the glyph is a real platform
 * symbol (SF Symbols on iOS, Material Symbols on Android and web) that inherits
 * the theme tint.
 */
export function HeaderIconButton({ ios, android, label, onPress }: HeaderIconButtonProps) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={Spacing.two}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.backgroundElement },
        pressed && styles.pressed,
      ]}>
      <SymbolView
        name={{ ios, android, web: android }}
        tintColor={colors.textSecondary}
        size={18}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
