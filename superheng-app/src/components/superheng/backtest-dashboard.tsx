import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/superheng/card';
import { Segment, type Point } from '@/components/superheng/chart-primitives';
import { SegmentedControl } from '@/components/superheng/segmented-control';
import { SectionHeader } from '@/components/superheng/section-header';
import { StatTile } from '@/components/superheng/signal-chip';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  LOTTERY_TYPES,
  getBacktest,
  isApiError,
  type Backtest,
  type BacktestChannel,
  type BacktestChannelReport,
  type BacktestPosition,
  type BacktestRoi,
  type LotteryType,
  type PositionKey,
} from '@/lib/api';
import { formatP, percent, signedPercent } from '@/lib/backtest-format';
import { formatCount, formatLocalizedDate } from '@/lib/format';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/** Reasons to look at each channel, in the order the panel prefers them. */
const CHANNEL_ORDER: readonly BacktestChannel[] = ['top', 'bottom'];

/**
 * Chart x-axis anchor dates. Two labels plus the ends, because `TrendChart`
 * renders one label per point and 60 dates would overlap into a smear.
 */
const X_LABEL_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

/**
 * Sparse x labels for a chart: those five fractions of the series, nothing else.
 *
 * Indices rather than fractions compared with `===`, which would depend on the
 * division landing exactly on 0.25 — it does not, and the labels silently vanish
 * when it misses.
 */
function xLabelsFor(dates: readonly string[]): string[] {
  const last = Math.max(1, dates.length - 1);
  const marks = new Set(X_LABEL_FRACTIONS.map((fraction) => Math.round(fraction * last)));
  return dates.map((date, index) => (marks.has(index) ? date.slice(5) : ''));
}

/** The replay windows the switcher offers, per the request of 30/60. */
const WINDOWS: readonly number[] = [30, 60];

const POSITION_KEYS_ORDER: readonly PositionKey[] = [
  'hundred_thousands',
  'ten_thousands',
  'thousands',
  'hundreds',
  'tens',
  'units',
];

const POSITION_LABEL_KEYS: Record<PositionKey, TranslationKey> = {
  hundred_thousands: 'premium.positionHundredThousands',
  ten_thousands: 'premium.positionTenThousands',
  thousands: 'premium.positionThousands',
  hundreds: 'premium.positionHundreds',
  tens: 'premium.positionTens',
  units: 'premium.positionUnits',
};

const LOTTERY_LABEL_KEYS: Record<LotteryType, TranslationKey> = {
  thai: 'premium.lotteryThai',
  laos: 'premium.lotteryLaos',
  vietnam: 'premium.lotteryVietnam',
};

/**
 * The walk-forward backtest dashboard.
 *
 * Self-contained like `PremiumInsightsPanel`: it owns its request and every
 * loading, error and empty state, so a screen only has to drop it into a card.
 *
 * **It is deliberately public.** The panel is the argument for the paid tier, so it
 * must be readable before paying — which is also why it is built to be believed
 * rather than impressive: every rate is rendered next to the baseline it must beat,
 * the sample size is on screen beside the verdict, and the verdict says "not
 * distinguishable from chance" whenever the p-value says so. On the real Thai
 * ledger that is what it says, and a panel that hid that would be selling a claim
 * the data does not support.
 *
 * The one part that is *not* public is the positional model's detail — the same
 * per-position numbers live behind `PremiumGate` in the insights panel.
 */
export function BacktestDashboard() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const [lotteryType, setLotteryType] = useState<LotteryType>('thai');
  const [draws, setDraws] = useState(WINDOWS[0]);
  const [result, setResult] = useState<Backtest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** True once the transport is retrying, i.e. the instance is probably booting. */
  const [waking, setWaking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void getBacktest(lotteryType, draws, {
      onRetry: () => {
        if (cancelled) return;
        setWaking(true);
      },
    }).then(
      (payload) => {
        if (cancelled) return;
        // Guard the tab against a late answer for another country, exactly as the
        // premium panel does: the endpoint echoes the ledger, so a mismatched
        // response is refused rather than rendered under the wrong heading.
        if (payload.lottery_type !== lotteryType) {
          setResult(null);
          setError(t('backtest.ledgerMismatch'));
          setLoading(false);
          return;
        }
        setResult(payload);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(
          isApiError(caught) ? caught.message : t('backtest.loadFailed')
        );
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [lotteryType, draws, reloadKey, t]);

  function retry() {
    setLoading(true);
    setWaking(false);
    setReloadKey((key) => key + 1);
  }

  function selectLottery(next: LotteryType) {
    if (next === lotteryType) return;
    // Clear first: leaving the previous country's numbers under the new heading
    // would attribute one ledger's accuracy to another.
    setResult(null);
    setError(null);
    setWaking(false);
    setLoading(true);
    setLotteryType(next);
  }

  function selectWindow(next: number) {
    if (next === draws) return;
    setResult(null);
    setError(null);
    setWaking(false);
    setLoading(true);
    setDraws(next);
  }

  /**
   * Controls, rendered above every state including the error one — a failed replay
   * must not strand the reader on the ledger that failed.
   */
  const controls = (
    <View style={styles.controls}>
      <SegmentedControl
        options={LOTTERY_TYPES.map((kind) => ({
          key: kind,
          label: t(LOTTERY_LABEL_KEYS[kind]),
        }))}
        value={lotteryType}
        onChange={selectLottery}
      />
      <SegmentedControl
        options={WINDOWS.map((count) => ({
          key: String(count),
          label: t('backtest.windowDraws', { count }),
        }))}
        value={String(draws)}
        onChange={(key) => selectWindow(Number(key))}
      />
    </View>
  );

  if (loading) {
    return (
      <Card>
        <SectionHeader title={t('backtest.title')} subtitle={t('backtest.subtitle')} />
        {controls}
        <View style={styles.stateBody}>
          <ActivityIndicator color={colors.primary} />
          <ThemedText type="small" themeColor="textSecondary" style={styles.stateText}>
            {waking ? t('backtest.waking') : t('backtest.loading', { count: draws })}
          </ThemedText>
        </View>
      </Card>
    );
  }

  if (error || !result) {
    return (
      <Card>
        <SectionHeader title={t('backtest.title')} subtitle={t('backtest.subtitle')} />
        {controls}
        <View style={styles.errorWrap}>
          <View style={[styles.errRule, { backgroundColor: colors.danger }]} />
          <ThemedText type="smallBold" style={[styles.errTitle, { color: colors.danger }]}>
            {t('backtest.loadFailed')}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
            {error ?? t('backtest.loadFailed')}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            onPress={retry}
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="smallBold" style={[styles.retryText, { color: colors.onPrimary }]}>
              {t('common.retry')}
            </ThemedText>
          </Pressable>
        </View>
      </Card>
    );
  }

  const channelKey = CHANNEL_ORDER.find((key) => result.channels[key]?.available);
  const channel = channelKey ? result.channels[channelKey] : undefined;
  const positional = result.positional.overall;
  const hasPositional = positional.predictions > 0;

  /**
   * Reasons for channels this ledger does not publish.
   *
   * Shown separately from the whole-section fallback below, because a ledger can
   * publish one channel and not the other — Vietnam does, since its five-digit
   * first prize has no derivable six-digit `top` — and the reader still deserves to
   * know why the other is absent. Without this the screen silently shows one
   * channel and says nothing about the missing one, which reads as an omission
   * rather than as a property of the lottery.
   */
  const unavailableReasons = CHANNEL_ORDER.map((key) => result.channels[key])
    .filter(
      (report): report is BacktestChannelReport => Boolean(report && !report.available)
    )
    .map((report) => report.reason)
    .filter((reason): reason is string => Boolean(reason));

  return (
    <View style={styles.stack}>
      <Card>
        <SectionHeader title={t('backtest.title')} subtitle={t('backtest.subtitle')} />
        {controls}

        {/*
          The window actually replayed, stated before any rate. `draws_evaluated`
          can be smaller than requested on a short ledger, and a reader comparing
          two runs needs to see the sample before the score.
        */}
        <View style={styles.sampleRow}>
          <ThemedText type="small" themeColor="textMuted" style={styles.sampleText}>
            {t('backtest.sampleLine', {
              done: formatCount(result.draws_evaluated),
              requested: formatCount(result.draws_requested),
              from: result.date_range.from
                ? formatLocalizedDate(result.date_range.from, language)
                : '—',
              to: result.date_range.to
                ? formatLocalizedDate(result.date_range.to, language)
                : '—',
            })}
          </ThemedText>
        </View>

        <Verdict result={result} />


        {channelKey && channel?.available ? (
          <TwoDigitSection channelKey={channelKey} report={channel} result={result} />
        ) : (
          <ThemedText type="small" themeColor="textSecondary" style={styles.unavailable}>
            {t('backtest.channelUnavailable')}
          </ThemedText>
        )}

        {unavailableReasons.map((reason) => (
          <ThemedText
            key={reason}
            type="small"
            themeColor="textMuted"
            style={styles.unavailable}>
            {reason}
          </ThemedText>
        ))}
      </Card>

      {hasPositional ? <PositionalSection result={result} /> : null}

      <Card>
        <SectionHeader
          title={t('backtest.notesTitle')}
          subtitle={t('backtest.notesSubtitle')}
        />
        <Note label={t('backtest.leakageTitle')} body={result.leakage_guard} />
        <Note label={t('backtest.payoutTitle')} body={result.economy.payout_basis} />
        <Note label={t('backtest.methodTitle')} body={result.methodology} />
        {result.models_excluded.length > 0 ? (
          <Note
            label={t('backtest.excludedTitle')}
            body={result.models_excluded
              .map((entry) => `${entry.model} — ${entry.reason}`)
              .join('\n\n')}
          />
        ) : null}
        {result.warnings.length > 0 ? (
          <View
            style={[
              styles.warnBox,
              { borderColor: `${colors.warning}55`, backgroundColor: `${colors.warning}14` },
            ]}>
            {result.warnings.map((warning) => (
              <ThemedText
                key={warning}
                type="small"
                themeColor="textSecondary"
                style={styles.warnItem}>
                • {warning}
              </ThemedText>
            ))}
          </View>
        ) : null}
        <ThemedText type="small" themeColor="textMuted" style={styles.disclaimer}>
          {t('backtest.disclaimer')}
        </ThemedText>
      </Card>
    </View>
  );
}

/**
 * The honest headline.
 *
 * Reads the strongest available evidence — the positional model first, because 180
 * predictions against a 10% baseline resolves far more than 30 predictions against
 * a 1% one — and states the p-value and the sample beside it. There is no "score"
 * here on purpose: the number a reader takes away is whether the model beat chance,
 * and on a small sample the truthful answer is usually that it did not.
 */
function Verdict({ result }: { result: Backtest }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  /**
   * Every significance test this response publishes, so the verdict can be drawn
   * from all of them rather than one arbitrarily chosen.
   *
   * The first version of this panel always read the positional test, on the
   * grounds that it has the most resolving power. On the Lao ledger that produced
   * a real inconsistency: the top-5 tile showed 18.2% against a 5% baseline at
   * p = 0.022 — a significant result — while the verdict directly above it said
   * "not proven", because the positional test happened not to clear the bound.
   * Two parts of one screen disagreeing about the same run is worse than either
   * answer, so the verdict now takes the strongest evidence there is and names it.
   */
  const positional = result.positional.overall;
  const channel = CHANNEL_ORDER.map((key) => result.channels[key]).find(
    (report): report is BacktestChannelReport => Boolean(report?.available)
  );

  const tests: { label: string; p: number; n: number; significant: boolean }[] = [];
  if (positional.predictions > 0) {
    tests.push({
      label: t('backtest.testPositional'),
      p: positional.p_value,
      n: positional.predictions,
      significant: positional.significant,
    });
  }
  if (channel?.skill) {
    tests.push({
      label: t('backtest.testTop5', { count: result.top_k }),
      p: channel.skill.top_5_p_value,
      n: channel.draws ?? 0,
      significant: channel.skill.top_5_significant,
    });
  }

  // The best result when anything cleared the bound — the reader is entitled to
  // the strongest thing the data shows — otherwise the test with the most
  // observations, which is the one most able to speak.
  const evidence = tests.length
    ? tests.some((test) => test.significant)
      ? tests.reduce((best, test) => (test.p < best.p ? test : best))
      : tests.reduce((best, test) => (test.n > best.n ? test : best))
    : null;

  if (!evidence) {
    return (
      <View
        style={[
          styles.verdict,
          { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement },
        ]}>
        <ThemedText type="smallBold" style={styles.verdictTitle}>
          {t('backtest.verdictEmptyTitle')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.verdictBody}>
          {t('backtest.verdictEmptyBody')}
        </ThemedText>
      </View>
    );
  }

  const tone = evidence.significant ? colors.success : colors.neutral;
  return (
    <View
      style={[
        styles.verdict,
        { borderColor: tone, backgroundColor: `${tone}14` },
      ]}>
      <View style={styles.verdictHead}>
        <View style={[styles.verdictPill, { backgroundColor: `${tone}26` }]}>
          <ThemedText type="small" style={[styles.verdictPillText, { color: tone }]}>
            {evidence.significant ? t('backtest.significant') : t('backtest.noEdge')}
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textMuted" style={styles.verdictP}>
          {t('backtest.pValue', { p: formatP(evidence.p), count: formatCount(evidence.n) })}
        </ThemedText>
      </View>
      <ThemedText type="smallBold" style={[styles.verdictTitle, { color: tone }]}>
        {evidence.significant ? t('backtest.verdictSignificantTitle') : t('backtest.verdictChanceTitle')}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.verdictBody}>
        {evidence.significant
          ? t('backtest.verdictSignificantBody')
          : t('backtest.verdictChanceBody')}
      </ThemedText>
      {/* Which test the verdict came from, and how many were run. Without this the
          headline is unattributable; with several tests, one clearing p<0.05 by
          chance alone is unsurprising, and saying how many were run is the honest
          way to present that. */}
      <ThemedText type="small" themeColor="textMuted" style={styles.verdictSource}>
        {t('backtest.verdictSource', {
          test: evidence.label,
          count: formatCount(tests.length),
        })}
      </ThemedText>
    </View>
  );
}

/** The 2-digit game: win rate, ROI and the bankroll, each against its baseline. */
function TwoDigitSection({
  channelKey,
  report,
  result,
}: {
  channelKey: BacktestChannel;
  report: BacktestChannelReport;
  result: Backtest;
}) {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const ai = report.ai;
  const random = report.random;
  const uniform = report.uniform;
  const skill = report.skill;
  const timeline = report.timeline ?? [];
  const equity = report.equity ?? [];

  const series = timeline
    .map((point) => point.ai_top_5_rate_percent)
    .filter((value): value is number => value !== null);
  const randomSeries = timeline
    .map((point) => point.random_top_5_rate_percent)
    .filter((value): value is number => value !== null);

  // A baseline drawn flat across the plot: the same value at every x, so it reads
  // as the reference line it is rather than as a series that happens to be flat.
  const baselineSeries = series.map(() => uniform?.top_5_hit_rate_percent ?? 5);

  const xLabels = xLabelsFor(timeline.map((point) => point.draw_date));

  return (
    <View style={styles.section}>
      <View style={styles.tiles}>
        <StatTile
          label={t('backtest.metricWinRate')}
          value={percent(ai?.exact_hit_rate_percent)}
          hint={t('backtest.vsUniformHint', {
            uniform: percent(uniform?.exact_hit_rate_percent, 0),
            random: percent(random?.exact_hit_rate_percent),
          })}
          color={colors.accent}
        />
        <StatTile
          label={t('backtest.metricTop5')}
          value={percent(ai?.top_5_hit_rate_percent)}
          hint={t('backtest.vsUniformHint', {
            uniform: percent(uniform?.top_5_hit_rate_percent, 0),
            random: percent(random?.top_5_hit_rate_percent),
          })}
          color={colors.accent}
        />
        <StatTile
          label={t('backtest.metricRoi')}
          value={signedPercent(report.roi?.exact.ai.roi_percent)}
          hint={t('backtest.roiHint', {
            payout: report.roi?.payout_multiple ?? result.economy.payout_multiple,
            random: signedPercent(report.roi?.exact.random.roi_percent),
          })}
          color={
            (report.roi?.exact.ai.roi_percent ?? 0) >= 0 ? colors.success : colors.danger
          }
        />
        <StatTile
          label={t('backtest.metricBreakEven')}
          value={percent(report.roi?.break_even_hit_rate_percent)}
          hint={t('backtest.breakEvenHint')}
        />
      </View>

      <View style={styles.metaRow}>
        <ThemedText type="small" themeColor="textMuted" style={styles.metaText}>
          {t('backtest.channelLine', {
            channel:
              channelKey === 'top' ? t('dashboard.marketTop') : t('dashboard.marketBottom'),
            draws: formatCount(report.draws ?? 0),
          })}
        </ThemedText>
        {skill ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.metaText}>
            {t('backtest.hitsNeededLine', {
              count:
                skill.top_5_hits_needed === null
                  ? '—'
                  : formatCount(skill.top_5_hits_needed),
            })}
          </ThemedText>
        ) : null}
      </View>

      {timeline.length > 1 ? (
        <View style={styles.chartBlock}>
          <ThemedText type="smallBold" style={styles.chartTitle}>
            {t('backtest.rateChartTitle', { count: result.top_k })}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.chartSubtitle}>
            {t('backtest.rateChartSubtitle')}
          </ThemedText>
          <RateChart
            series={[
              { label: t('backtest.aiLabel'), color: colors.accent, values: series },
              {
                label: t('backtest.randomLabel'),
                color: colors.neutral,
                values: randomSeries,
              },
              {
                label: t('backtest.uniformLabel'),
                color: colors.textMuted,
                values: baselineSeries,
              },
            ]}
            xLabels={xLabels}
            height={180}
          />
        </View>
      ) : null}

      {equity.length > 1 ? (
        <View style={styles.chartBlock}>
          <ThemedText type="smallBold" style={styles.chartTitle}>
            {t('backtest.bankrollTitle')}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.chartSubtitle}>
            {t('backtest.bankrollSubtitle')}
          </ThemedText>
          <BankrollChart equity={equity} />
          <ThemedText type="small" themeColor="textMuted" style={styles.axisNote}>
            {t('backtest.bankrollAxis', {
              last: formatCount(equity[equity.length - 1].ai_net_units),
              random: formatCount(equity[equity.length - 1].random_net_units),
              date: formatLocalizedDate(equity[equity.length - 1].draw_date, language),
            })}
          </ThemedText>
        </View>
      ) : null}

      {report.roi ? <RoiBars roi={report.roi} /> : null}
    </View>
  );
}

/** One plotted series: a label, a colour and its values in draw order. */
type RateSeries = { label: string; color: string; values: number[] };

/**
 * A percentage line chart whose Y axis is scaled to the data.
 *
 * `TrendChart` is fixed to a 0-100 domain, which suits a share-of-draws series and
 * is wrong for a hit rate: a 1% win rate, a 5% baseline and a 10% positional
 * accuracy all land in the bottom tenth of a 0-100 plot and render as one flat
 * line on the floor. That is precisely the shape a reader must be able to
 * interpret — "no edge" — so the chart would be unreadable in the case it exists
 * to show. Here the domain runs from zero to just above the highest value, rounded
 * up to a friendly step, and every tick is labelled with the percentage it marks.
 *
 * A shared `domainMax` across the call sites' series is deliberate: an AI line and
 * its baseline are drawn on one axis so their vertical gap is the difference in
 * rates, which is the whole comparison.
 */
function RateChart({
  series,
  xLabels,
  height = 170,
}: {
  series: RateSeries[];
  xLabels: string[];
  height?: number;
}) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);

  const padding = { top: 10, bottom: 18, left: 34, right: 8 };
  const plotWidth = Math.max(0, width - padding.left - padding.right);
  const plotHeight = Math.max(0, height - padding.top - padding.bottom);
  const count = Math.max(1, series[0]?.values.length ?? 1);

  // 15% of headroom, rounded up to a multiple of five so the top tick is a round
  // number a reader can hold onto. The floor of 10 keeps a 5% baseline from being
  // drawn against a 5% domain, where it would sit on the ceiling as if it were a
  // maximum rather than a reference line.
  const peak = Math.max(0, ...series.flatMap((item) => item.values));
  const domainMax = Math.max(10, Math.ceil((peak * 1.15) / 5) * 5);

  const toPoint = (value: number, index: number): Point => ({
    x: padding.left + (plotWidth * index) / Math.max(1, count - 1),
    y: padding.top + plotHeight * (1 - Math.max(0, Math.min(1, value / domainMax))),
  });

  const ticks = [0.25, 0.5, 0.75, 1].map((fraction) => fraction * domainMax);

  return (
    <View style={styles.bankroll}>
      <View style={styles.legend}>
        {series.map((item) => (
          <LegendItem key={item.label} color={item.color} label={item.label} />
        ))}
      </View>

      <View
        style={[styles.plot, { height }]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <>
            {ticks.map((tick) => {
              const y = toPoint(tick, 0).y;
              return (
                <View key={tick} style={styles.tickRow}>
                  <View
                    style={{
                      position: 'absolute',
                      left: padding.left,
                      right: padding.right,
                      top: y,
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: colors.cardBorder,
                    }}
                  />
                  <ThemedText
                    type="small"
                    themeColor="textMuted"
                    style={[styles.yLabel, { top: y - 6 }]}>
                    {/* One decimal only where the tick actually has one, so the axis
                        reads 3.8 / 7.5 / 11.3 / 15 rather than mixing a rounded
                        11% in beside 3.8%. */}
                    {percent(tick, Number.isInteger(tick) ? 0 : 1)}
                  </ThemedText>
                </View>
              );
            })}

            {series.map((item) => {
              const points = item.values.map((value, index) => toPoint(value, index));
              return (
                <View key={item.label}>
                  {points.slice(0, -1).map((point, index) => (
                    <Segment
                      key={`${item.label}-${index}`}
                      x1={point.x}
                      y1={point.y}
                      x2={points[index + 1].x}
                      y2={points[index + 1].y}
                      color={item.color}
                      thickness={2}
                    />
                  ))}
                  {points.map((point, index) => (
                    <View
                      key={`${item.label}-dot-${index}`}
                      style={{
                        position: 'absolute',
                        left: point.x - 3,
                        top: point.y - 3,
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.card,
                        borderWidth: 2,
                        borderColor: item.color,
                      }}
                    />
                  ))}
                </View>
              );
            })}

            {xLabels.map((label, index) =>
              label ? (
                <ThemedText
                  key={`${label}-${index}`}
                  type="small"
                  themeColor="textMuted"
                  style={[styles.xLabel, { left: toPoint(0, index).x - 14 }]}>
                  {label}
                </ThemedText>
              ) : null
            )}
          </>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Cumulative bankroll for the AI and the random player, on one axis.
 *
 * Drawn as a centred chart rather than reusing `TrendChart`, which is fixed to a
 * 0-100 domain: a bankroll is negative most of the time (that is the house edge), so
 * it needs an axis through zero. The zero line is what makes the two series
 * comparable — the gap between them is the only edge there is.
 */
function BankrollChart({
  equity,
}: {
  equity: { draw_date: string; ai_net_units: number; random_net_units: number }[];
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);

  const values = equity.flatMap((point) => [point.ai_net_units, point.random_net_units]);
  const floor = Math.min(0, ...values);
  const ceiling = Math.max(0, ...values);
  const span = ceiling - floor || 1;
  const height = 140;
  const padding = { top: 8, bottom: 18, left: 34, right: 8 };
  const plotHeight = height - padding.top - padding.bottom;
  const plotWidth = Math.max(0, width - padding.left - padding.right);

  const toY = (value: number) =>
    padding.top + plotHeight * (1 - (value - floor) / span);
  const toX = (index: number) =>
    padding.left + (plotWidth * index) / Math.max(1, equity.length - 1);

  const zeroY = toY(0);
  const ticks = [ceiling, (ceiling + floor) / 2, floor];

  /** The two bankrolls, paired so each line and its legend swatch cannot drift. */
  const lines: {
    key: string;
    color: string;
    read: (point: (typeof equity)[number]) => number;
  }[] = [
    { key: 'ai', color: colors.accent, read: (point) => point.ai_net_units },
    { key: 'random', color: colors.neutral, read: (point) => point.random_net_units },
  ];

  return (
    <View style={styles.bankroll}>
      <View style={styles.legend}>
        <LegendItem color={colors.accent} label={t('backtest.aiLabel')} />
        <LegendItem color={colors.neutral} label={t('backtest.randomLabel')} />
        <LegendItem color={colors.cardBorder} label={t('backtest.zeroLine')} />
      </View>
      <View
        style={[styles.plot, { height }]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <>
            {ticks.map((tick) => (
              <View key={tick} style={styles.tickRow}>
                <View
                  style={{
                    position: 'absolute',
                    left: padding.left,
                    right: padding.right,
                    top: toY(tick),
                    height: StyleSheet.hairlineWidth,
                    backgroundColor: colors.cardBorder,
                  }}
                />
                <ThemedText
                  type="small"
                  themeColor="textMuted"
                  style={[styles.yLabel, { top: toY(tick) - 6 }]}>
                  {formatCount(tick)}
                </ThemedText>
              </View>
            ))}

            {/* Zero: the break-even line, so a losing run is unmistakable. */}
            <View
              style={{
                position: 'absolute',
                left: padding.left,
                right: padding.right,
                top: zeroY,
                height: 1,
                backgroundColor: colors.textMuted,
                opacity: 0.5,
              }}
            />

            {lines.map((line) => (
              <View key={line.key}>
                {equity.slice(0, -1).map((point, index) => {
                  const next = equity[index + 1];
                  return (
                    <Segment
                      key={`${line.key}-${index}`}
                      x1={toX(index)}
                      y1={toY(line.read(point))}
                      x2={toX(index + 1)}
                      y2={toY(line.read(next))}
                      color={line.color}
                      thickness={2}
                    />
                  );
                })}
              </View>
            ))}
          </>
        ) : null}
      </View>
    </View>
  );
}

/** One legend swatch. */
function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.legendLabel}>
        {label}
      </ThemedText>
    </View>
  );
}

/**
 * ROI as diverging bars around a zero axis.
 *
 * Diverging rather than a plain bar because ROI is signed and negative most of the
 * time: the length of a bar to the left of zero is a loss, and a chart that only
 * grew to the right would render the model's best strategy as nothing at all.
 * Break-even is the centre line, so "profit" and "loss" are read by direction.
 */
function RoiBars({ roi }: { roi: BacktestRoi }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  const rows = [
    { label: t('backtest.roiCoverAi'), value: roi.cover.ai.roi_percent, tone: colors.accent },
    {
      label: t('backtest.roiCoverRandom'),
      value: roi.cover.random.roi_percent,
      tone: colors.neutral,
    },
    { label: t('backtest.roiExactAi'), value: roi.exact.ai.roi_percent, tone: colors.accent },
    {
      label: t('backtest.roiExactRandom'),
      value: roi.exact.random.roi_percent,
      tone: colors.neutral,
    },
  ];
  const magnitude = Math.max(10, ...rows.map((row) => Math.abs(row.value ?? 0)));

  return (
    <View style={styles.chartBlock}>
      <ThemedText type="smallBold" style={styles.chartTitle}>
        {t('backtest.roiTitle', { payout: roi.payout_multiple })}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.chartSubtitle}>
        {t('backtest.roiSubtitle', {
          breakEven: roi.break_even_hit_rate_percent.toFixed(1),
        })}
      </ThemedText>

      {rows.map((row) => {
        const value = row.value ?? 0;
        const widthFraction = Math.min(50, (Math.abs(value) / magnitude) * 50);
        return (
          <View key={row.label} style={styles.roiRow}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.roiLabel}>
              {row.label}
            </ThemedText>
            <View style={styles.roiTrack}>
              <View
                style={[
                  styles.roiBar,
                  value >= 0
                    ? { left: '50%', width: `${widthFraction}%` }
                    : { right: '50%', width: `${widthFraction}%` },
                  { backgroundColor: value >= 0 ? colors.success : row.tone },
                ]}
              />
            </View>
            <ThemedText
              type="small"
              style={[
                styles.roiValue,
                { color: value >= 0 ? colors.success : colors.danger },
              ]}>
              {signedPercent(row.value)}
            </ThemedText>
          </View>
        );
      })}

      <View style={styles.roiAxis}>
        {/*
          The magnitude, not the signed value: the template already carries the
          minus sign, and passing `-magnitude` renders "−−100%" on screen.
        */}
        <ThemedText type="small" themeColor="textMuted" style={styles.axisNote}>
          {t('backtest.roiAxis', { lose: formatCount(magnitude), win: formatCount(magnitude) })}
        </ThemedText>
      </View>
    </View>
  );
}

/** The premium positional model: per-position accuracy against its 10% baseline. */
function PositionalSection({ result }: { result: Backtest }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const { overall, positions, timeline } = result.positional;

  const ordered = POSITION_KEYS_ORDER.filter((key) => positions[key]);

  const series = timeline
    .map((point) => point.hit_rate_percent)
    .filter((value): value is number => value !== null);
  const baseline = series.map(() => overall.baseline_percent);
  const xLabels = xLabelsFor(timeline.map((point) => point.draw_date));

  return (
    <Card>
      <SectionHeader
        title={t('backtest.positionalTitle')}
        subtitle={t('backtest.positionalSubtitle', {
          count: formatCount(overall.predictions),
        })}
      />

      <View style={styles.tiles}>
        <StatTile
          label={t('backtest.metricDigitAccuracy')}
          value={percent(overall.hit_rate_percent)}
          hint={t('backtest.vsUniformSimple', {
            uniform: percent(overall.baseline_percent, 0),
          })}
          color={colors.accent}
        />
        <StatTile
          label={t('backtest.metricPredictions')}
          value={formatCount(overall.predictions)}
          hint={t('backtest.drawsHint', { count: formatCount(result.positional.draws) })}
        />
        <StatTile
          label={t('backtest.metricPValue')}
          value={formatP(overall.p_value)}
          hint={
            overall.significant ? t('backtest.significant') : t('backtest.notSignificant')
          }
          color={overall.significant ? colors.success : colors.neutral}
        />
        <StatTile
          label={t('backtest.metricHitsNeeded')}
          value={overall.hits_needed === null ? '—' : formatCount(overall.hits_needed)}
          hint={t('backtest.metricHitsNeededHint')}
        />
      </View>

      {timeline.length > 1 ? (
        <View style={styles.chartBlock}>
          <ThemedText type="smallBold" style={styles.chartTitle}>
            {t('backtest.positionChartTitle')}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.chartSubtitle}>
            {t('backtest.positionChartSubtitle')}
          </ThemedText>
          <RateChart
            series={[
              { label: t('backtest.aiLabel'), color: colors.accent, values: series },
              {
                label: t('backtest.uniformLabel'),
                color: colors.textMuted,
                values: baseline,
              },
            ]}
            xLabels={xLabels}
            height={160}
          />
        </View>
      ) : null}

      <View style={styles.positionList}>
        {ordered.map((key) => (
          <PositionRow key={key} name={key} position={positions[key] as BacktestPosition} />
        ))}
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.chartSubtitle}>
        {t('backtest.positionNote')}
      </ThemedText>
    </Card>
  );
}

/** One position: its accuracy against the shared 10% baseline. */
function PositionRow({ name, position }: { name: PositionKey; position: BacktestPosition }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const rate = position.hit_rate_percent ?? 0;
  // Both the bar and the baseline marker share one 0-100% scale, so their lengths
  // are directly comparable and the baseline cannot be drawn at a different scale
  // than the value it is being compared with.
  const scale = 100;

  return (
    <View style={styles.positionRow}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.positionLabel}>
        {t(POSITION_LABEL_KEYS[name])}
      </ThemedText>
      <View style={styles.positionTrack}>
        <View
          style={[
            styles.positionBar,
            {
              width: `${Math.min(100, (rate / scale) * 100)}%`,
              backgroundColor: position.significant ? colors.success : colors.accent,
            },
          ]}
        />
        <View
          style={[
            styles.positionBaseline,
            { left: `${(position.baseline_percent / scale) * 100}%`, backgroundColor: colors.textMuted },
          ]}
        />
      </View>
      <View style={styles.positionMeta}>
        <ThemedText type="small" style={styles.positionValue}>
          {percent(position.hit_rate_percent)}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.positionN}>
          {t('backtest.positionCount', {
            hits: formatCount(position.hits),
            total: formatCount(position.predictions),
          })}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textMuted"
          style={[
            styles.positionP,
            position.significant ? { color: colors.success } : undefined,
          ]}>
          {t('backtest.pShort', { p: formatP(position.p_value) })}
        </ThemedText>
      </View>
    </View>
  );
}

/** One labelled paragraph of backend prose. */
function Note({ label, body }: { label: string; body: string }) {
  if (!body) return null;
  return (
    <View style={styles.note}>
      <ThemedText type="small" style={styles.noteLabel}>
        {label}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.noteBody}>
        {body}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: Spacing.three,
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  section: {
    marginTop: Spacing.three,
    gap: Spacing.three,
  },

  sampleRow: {
    marginTop: Spacing.two,
  },
  sampleText: {
    fontSize: 11,
    lineHeight: 17,
  },

  // Verdict ---------------------------------------------------------------
  verdict: {
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: Spacing.one,
  },
  verdictHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  verdictPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  verdictPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  verdictP: {
    fontSize: 10,
    flexShrink: 1,
    textAlign: 'right',
  },
  verdictTitle: {
    fontSize: 14,
    lineHeight: 24,
  },
  verdictBody: {
    fontSize: 11,
    lineHeight: 18,
  },
  verdictSource: {
    fontSize: 9,
    lineHeight: 14,
    marginTop: Spacing.half,
  },

  // Tiles -----------------------------------------------------------------
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 10,
  },
  unavailable: {
    marginTop: Spacing.three,
    fontSize: 11,
    lineHeight: 17,
  },

  // Charts ----------------------------------------------------------------
  chartBlock: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  chartTitle: {
    fontSize: 12,
    letterSpacing: 0.3,
  },
  chartSubtitle: {
    fontSize: 10,
    lineHeight: 15,
  },
  axisNote: {
    fontSize: 9,
    lineHeight: 14,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
  },
  bankroll: {
    gap: Spacing.two,
  },
  plot: {
    width: '100%',
    borderRadius: Radius.sm,
  },
  tickRow: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  yLabel: {
    position: 'absolute',
    left: 0,
    width: 30,
    textAlign: 'right',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  xLabel: {
    position: 'absolute',
    bottom: 0,
    width: 28,
    textAlign: 'center',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },

  // ROI -------------------------------------------------------------------
  roiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  roiLabel: {
    width: 104,
    fontSize: 10,
  },
  roiTrack: {
    flex: 1,
    height: 14,
    minWidth: 0,
    position: 'relative',
    justifyContent: 'center',
  },
  roiBar: {
    position: 'absolute',
    height: 14,
    borderRadius: 3,
  },
  roiValue: {
    width: 58,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  roiAxis: {
    marginTop: Spacing.half,
  },

  // Positional ------------------------------------------------------------
  positionList: {
    marginTop: Spacing.two,
    gap: Spacing.two,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  positionLabel: {
    width: 92,
    fontSize: 10,
  },
  positionTrack: {
    flex: 1,
    height: 10,
    minWidth: 0,
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  positionBar: {
    height: 10,
    borderRadius: 3,
    opacity: 0.85,
  },
  positionBaseline: {
    position: 'absolute',
    width: 2,
    height: 14,
  },
  positionMeta: {
    width: 96,
    alignItems: 'flex-end',
  },
  positionValue: {
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  positionN: {
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  positionP: {
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },

  // Notes -----------------------------------------------------------------
  note: {
    marginTop: Spacing.three,
    gap: Spacing.half,
  },
  noteLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  noteBody: {
    fontSize: 10,
    lineHeight: 16,
  },
  warnBox: {
    marginTop: Spacing.three,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  warnItem: {
    fontSize: 10,
    lineHeight: 15,
  },
  disclaimer: {
    marginTop: Spacing.three,
    fontSize: 10,
    lineHeight: 15,
  },

  // Load / error ----------------------------------------------------------
  stateBody: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  stateText: {
    fontSize: 12,
    lineHeight: 20,
  },
  errorWrap: {
    paddingTop: Spacing.two,
  },
  errRule: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  errTitle: {
    letterSpacing: 0.4,
    marginTop: Spacing.one,
  },
  errBody: {
    fontSize: 11,
    lineHeight: 18,
    marginTop: Spacing.one,
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
