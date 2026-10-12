import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  AppHeader,
  Card,
  PageScaffold,
  RadarChart,
  ScoreRing,
  SectionHeader,
} from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Brand, DataColors, Radius, Spacing, probabilityColor } from '@/constants/theme';
import { RADAR_AXES, analyzeNumber, type NumberAnalysis } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatDate } from '@/lib/format';

const SAMPLES = ['48', '512', '093'];

export default function MyNumberScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ code?: string }>();

  const paramCode = params.code ?? '';
  const [input, setInput] = useState(paramCode);
  const [analysis, setAnalysis] = useState<NumberAnalysis | null>(() =>
    paramCode ? analyzeNumber(paramCode) : null,
  );

  // Deep links from the Insights heatmap change the route param. Adjust state
  // during render rather than in an effect:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [syncedCode, setSyncedCode] = useState(paramCode);
  if (paramCode && paramCode !== syncedCode) {
    setSyncedCode(paramCode);
    setInput(paramCode);
    setAnalysis(analyzeNumber(paramCode));
  }

  const run = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 3);
    if (digits.length < 2) return;
    setAnalysis(analyzeNumber(digits));
  };

  return (
    <PageScaffold>
      <AppHeader subtitle="Analyse any number" />

      <Card>
        <SectionHeader title="Your number" subtitle="2 or 3 digits — e.g. a licence plate" />

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={(text) => setInput(text.replace(/\D/g, '').slice(0, 3))}
            onSubmitEditing={() => run(input)}
            placeholder="000"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={3}
            returnKeyType="search"
            accessibilityLabel="Number to analyse"
            style={[
              styles.input,
              { color: colors.text, backgroundColor: colors.backgroundElement, borderColor: colors.cardBorder },
            ]}
          />
          <Pressable
            onPress={() => run(input)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText style={[styles.buttonText, { color: colors.onPrimary }]}>Analyse</ThemedText>
          </Pressable>
        </View>

        <View style={styles.samples}>
          <ThemedText type="small" themeColor="textMuted" style={styles.samplesLabel}>
            Try
          </ThemedText>
          {SAMPLES.map((sample) => (
            <Pressable
              key={sample}
              onPress={() => {
                setInput(sample);
                run(sample);
              }}
              style={({ pressed }) => [
                styles.sampleChip,
                { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement },
                pressed && styles.pressed,
              ]}>
              <ThemedText type="small" style={styles.sampleText}>
                {sample}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      </Card>

      {analysis ? (
        <>
          <Card>
            <View style={styles.resultRow}>
              <View style={styles.resultInfo}>
                <ThemedText style={styles.resultCode}>{analysis.code}</ThemedText>
                <ThemedText type="small" style={[styles.verdict, { color: probabilityColor(analysis.score) }]}>
                  {analysis.verdict}
                </ThemedText>
                <ThemedText type="small" themeColor="textMuted">
                  {analysis.confidence} confidence
                </ThemedText>
              </View>
              <ScoreRing
                score={analysis.score}
                size={124}
                color={probabilityColor(analysis.score)}
                label="Heng score"
              />
            </View>

            <View style={styles.statGrid}>
              <StatBox label="Appearances" value={`${analysis.appearances}x`} />
              <StatBox
                label="Last won"
                value={analysis.lastWon ? analysis.lastWon.prize : '—'}
                hint={analysis.lastWon ? formatDate(analysis.lastWon.date) : 'No recent hit'}
              />
              <StatBox label="Parity" value={analysis.parity} />
              <StatBox label="Digit sum" value={`${analysis.digitSum}`} />
            </View>
          </Card>

          <Card>
            <SectionHeader title="Signal profile" subtitle={RADAR_AXES.join(' · ')} />
            <View style={styles.radarRow}>
              <RadarChart
                values={analysis.radar}
                size={140}
                color={Brand.crimson}
                labels={RADAR_AXES}
              />
              <View style={styles.radarLegend}>
                {RADAR_AXES.map((axis, index) => (
                  <View key={axis} style={styles.legendItem}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.legendLabel}>
                      {axis}
                    </ThemedText>
                    <ThemedText type="smallBold" style={styles.legendValue}>
                      {Math.round(analysis.radar[index] * 100)}
                    </ThemedText>
                  </View>
                ))}
              </View>
            </View>
          </Card>

          <Card>
            <SectionHeader title="AI advice" subtitle="Model-derived recommendations" />
            <View style={styles.adviceList}>
              {analysis.advice.map((item) => (
                <View key={item.title} style={[styles.advice, { borderLeftColor: DataColors[item.tone] }]}>
                  <ThemedText type="smallBold">{item.title}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.adviceBody}>
                    {item.body}
                  </ThemedText>
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : (
        <Card>
          <View style={styles.empty}>
            <ThemedText type="smallBold">No analysis yet</ThemedText>
            <ThemedText type="small" themeColor="textMuted" style={styles.emptyText}>
              Enter a 2 or 3-digit number to see its Heng score, history and model advice.
            </ThemedText>
          </View>
        </Card>
      )}
    </PageScaffold>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.statBox, { backgroundColor: colors.backgroundElement }]}>
      <ThemedText type="small" themeColor="textMuted" style={styles.statLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.statValue} numberOfLines={1}>
        {value}
      </ThemedText>
      {hint ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.statHint}>
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
    alignItems: 'stretch',
  },
  input: {
    flex: 1,
    // Text inputs keep an intrinsic min-content width on web; without this the
    // field (and the Analyse button beside it) overflows the row.
    minWidth: 0,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  button: {
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    borderRadius: Radius.md,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '800',
  },
  samples: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  samplesLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sampleChip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sampleText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.6,
  },

  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  resultInfo: {
    flexShrink: 1,
    gap: Spacing.half,
  },
  resultCode: {
    fontSize: 52,
    lineHeight: 56,
    fontWeight: '900',
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
  },
  verdict: {
    fontWeight: '700',
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  statBox: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '46%',
    padding: Spacing.two,
    borderRadius: Radius.md,
    gap: 2,
  },
  statLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  statHint: {
    fontSize: 10,
  },

  radarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  radarLegend: {
    flex: 1,
    gap: Spacing.two,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.2)',
    paddingBottom: Spacing.one,
  },
  legendLabel: {
    fontSize: 12,
  },
  legendValue: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },

  adviceList: {
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  advice: {
    borderLeftWidth: 3,
    paddingLeft: Spacing.two,
    gap: 2,
  },
  adviceBody: {
    lineHeight: 19,
  },
  empty: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.four,
  },
  emptyText: {
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 19,
  },
});
