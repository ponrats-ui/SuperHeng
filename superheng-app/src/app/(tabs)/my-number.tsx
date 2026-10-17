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
import {
  DRAW_META,
  RADAR_AXES,
  analyzeNumber,
  type AnalysisAdvice,
  type AnalysisAdviceId,
  type AnalysisParity,
  type AnalysisPrize,
  type AnalysisVerdict,
  type NumberAnalysis,
} from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatCount, formatLocalizedDate } from '@/lib/format';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

const SAMPLES = ['48', '512', '093'];

/**
 * Where each piece of generated copy lives.
 *
 * The data layer returns ids, not sentences (see `analysis` in `data/mock.ts`): a
 * Thai screen reading English advice would be the same class of bug as a hardcoded
 * label, only harder to spot, because the surrounding chrome would be translated.
 * Every map below is `satisfies`-checked, so adding a verdict, a parity shape or a
 * prize without a dictionary entry is a type error rather than a missing sentence.
 */
const VERDICT_KEYS = {
  favourable: 'myNumber.verdictFavourable',
  mild: 'myNumber.verdictMild',
  neutral: 'myNumber.verdictNeutral',
} as const satisfies Record<AnalysisVerdict, TranslationKey>;

const PARITY_KEYS = {
  allEven: 'myNumber.parityAllEven',
  allOdd: 'myNumber.parityAllOdd',
  mixed: 'myNumber.parityMixed',
} as const satisfies Record<AnalysisParity, TranslationKey>;

const PRIZE_KEYS = {
  bottomTwo: 'myNumber.prizeBottomTwo',
  firstPrize: 'myNumber.prizeFirstPrize',
} as const satisfies Record<AnalysisPrize, TranslationKey>;

const AXIS_KEYS = {
  frequency: 'myNumber.axisFrequency',
  recency: 'myNumber.axisRecency',
  seasonality: 'myNumber.axisSeasonality',
  balance: 'myNumber.axisBalance',
  momentum: 'myNumber.axisMomentum',
} as const satisfies Record<(typeof RADAR_AXES)[number], TranslationKey>;

const ADVICE_TITLE_KEYS = {
  consensus: 'myNumber.adviceConsensus',
  positioning: 'myNumber.advicePositioning',
  risk: 'myNumber.adviceRisk',
} as const satisfies Record<AnalysisAdviceId, TranslationKey>;

const CONFIDENCE_KEYS = {
  High: 'confidence.high',
  Medium: 'confidence.medium',
  Low: 'confidence.low',
} as const satisfies Record<string, TranslationKey>;

/** The body sentence for one advice card, including the branch the data chose. */
function adviceBodyKey(advice: AnalysisAdvice): TranslationKey {
  if (advice.id === 'consensus') return 'myNumber.adviceConsensusBody';
  if (advice.id === 'risk') return 'myNumber.adviceRiskBody';
  return advice.variant === 'spread'
    ? 'myNumber.advicePositioningSpread'
    : 'myNumber.advicePositioningConcentrated';
}

/**
 * The placeholders each body sentence needs.
 *
 * Every sentence gets all four, so the templates can reference whichever they use
 * without the screen having to know which one that is. A card printing a number it
 * did not name would be the failure worth avoiding here.
 */
function adviceParams(analysis: NumberAnalysis): Record<string, string | number> {
  return {
    code: analysis.code.slice(-2),
    probability: analysis.probability.toFixed(1),
    sum: analysis.digitSum,
    odd: analysis.oddDigits,
    // Drives the `_one` variant of the risk sentence, where English inflects.
    count: analysis.oddDigits,
    appearances: analysis.appearances,
    draws: formatCount(DRAW_META.drawsAnalysed),
  };
}

export default function MyNumberScreen() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
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

  const axisLabels = RADAR_AXES.map((axis) => t(AXIS_KEYS[axis]));

  return (
    <PageScaffold>
      <AppHeader subtitle={t('header.myNumberSubtitle')} />

      <Card>
        <SectionHeader title={t('myNumber.title')} subtitle={t('myNumber.subtitle')} />

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
            accessibilityLabel={t('myNumber.inputLabel')}
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
            <ThemedText style={[styles.buttonText, { color: colors.onPrimary }]}>
              {t('myNumber.analyse')}
            </ThemedText>
          </Pressable>
        </View>

        <View style={styles.samples}>
          <ThemedText type="small" themeColor="textMuted" style={styles.samplesLabel}>
            {t('myNumber.try')}
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
                  {t(VERDICT_KEYS[analysis.verdict])}
                </ThemedText>
                <ThemedText type="small" themeColor="textMuted">
                  {t('myNumber.confidenceLine', {
                    level: t(CONFIDENCE_KEYS[analysis.confidence]),
                  })}
                </ThemedText>
              </View>
              <ScoreRing
                score={analysis.score}
                size={124}
                color={probabilityColor(analysis.score)}
                label={t('myNumber.hengScore')}
              />
            </View>

            <View style={styles.statGrid}>
              <StatBox
                label={t('myNumber.appearances')}
                value={`${analysis.appearances}×`}
              />
              <StatBox
                label={t('myNumber.lastWon')}
                value={analysis.lastWon ? t(PRIZE_KEYS[analysis.lastWon.prize]) : '—'}
                hint={
                  analysis.lastWon
                    ? formatLocalizedDate(analysis.lastWon.date, language)
                    : t('myNumber.noRecentHit')
                }
              />
              <StatBox label={t('myNumber.parity')} value={t(PARITY_KEYS[analysis.parity])} />
              <StatBox label={t('myNumber.digitSum')} value={`${analysis.digitSum}`} />
            </View>
          </Card>

          <Card>
            <SectionHeader
              title={t('myNumber.signalProfile')}
              subtitle={axisLabels.join(' · ')}
            />
            <View style={styles.radarRow}>
              <RadarChart
                values={analysis.radar}
                size={140}
                color={Brand.crimson}
                labels={axisLabels}
              />
              <View style={styles.radarLegend}>
                {RADAR_AXES.map((axis, index) => (
                  <View key={axis} style={styles.legendItem}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.legendLabel}>
                      {t(AXIS_KEYS[axis])}
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
            <SectionHeader
              title={t('myNumber.aiAdvice')}
              subtitle={t('myNumber.aiAdviceSubtitle')}
            />
            <View style={styles.adviceList}>
              {analysis.advice.map((item) => (
                <View key={item.id} style={[styles.advice, { borderLeftColor: DataColors[item.tone] }]}>
                  <ThemedText type="smallBold">{t(ADVICE_TITLE_KEYS[item.id])}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.adviceBody}>
                    {t(adviceBodyKey(item), adviceParams(analysis))}
                  </ThemedText>
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : (
        <Card>
          <View style={styles.empty}>
            <ThemedText type="smallBold">{t('myNumber.emptyTitle')}</ThemedText>
            <ThemedText type="small" themeColor="textMuted" style={styles.emptyText}>
              {t('myNumber.emptyBody')}
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
