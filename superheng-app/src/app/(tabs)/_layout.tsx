import { Tabs } from 'expo-router';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { Platform, StyleSheet, type ColorValue } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useTranslation } from '@/lib/i18n';

type TabIconProps = {
  ios: SFSymbol;
  android: AndroidSymbol;
  color: ColorValue;
  size: number;
};

/** Cross-platform tab icon using SF Symbols (iOS) and Material Symbols. */
function TabIcon({ ios, android, color, size }: TabIconProps) {
  return (
    <SymbolView name={{ ios, android, web: android }} tintColor={color} size={size} />
  );
}

export default function TabsLayout() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: colors.background },
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.cardBorder,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: Platform.select({ ios: 84, default: 68 }),
          paddingTop: Spacing.two,
          paddingBottom: Platform.select({ ios: Spacing.five, default: Spacing.two }),
        },
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: { paddingTop: Spacing.one },
        tabBarActiveBackgroundColor: 'transparent',
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.dashboard'),
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="house.fill" android="home" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="my-number"
        options={{
          title: t('nav.myNumber'),
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="magnifyingglass" android="search" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: t('nav.insights'),
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="square.grid.2x2.fill" android="grid_view" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="performance"
        options={{
          title: t('nav.performance'),
          tabBarIcon: ({ color, size }) => (
            <TabIcon
              ios="chart.line.uptrend.xyaxis"
              android="monitoring"
              color={color}
              size={size}
            />
          ),
        }}
      />
      {/*
        Fifth and last tab. A clock-with-arrow rather than another chart icon:
        this screen is specifically the *replay* of past draws, and reusing a
        line-chart glyph eight pixels from the performance tab's own line chart
        would make the two indistinguishable at a glance.
      */}
      <Tabs.Screen
        name="backtest"
        options={{
          title: t('nav.backtest'),
          tabBarIcon: ({ color, size }) => (
            <TabIcon
              ios="clock.arrow.circlepath"
              android="history"
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
});
