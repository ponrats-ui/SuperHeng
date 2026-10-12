import { Tabs } from 'expo-router';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { Platform, StyleSheet, type ColorValue } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

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
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="house.fill" android="home" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="my-number"
        options={{
          title: 'My Number',
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="magnifyingglass" android="search" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: 'Insights',
          tabBarIcon: ({ color, size }) => (
            <TabIcon ios="square.grid.2x2.fill" android="grid_view" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="performance"
        options={{
          title: 'Performance',
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
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
});
