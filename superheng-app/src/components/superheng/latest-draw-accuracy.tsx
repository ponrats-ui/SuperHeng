import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import {
  LOTTERY_LABEL_KEYS,
  POSITION_LABEL_KEYS,
  STATUS_KEYS,
} from '@/components/superheng/premium-shared';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  getAccuracyReport,
  isApiError,
  type AccuracyComparison,
  type AccuracyPosition,
  type AccuracyRate,
  type AccuracyReport,
  type ChannelKey,
  type LotteryType,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatCount, formatLocalizedDate } from '@/lib/format';
import { useTranslation, type Language } from '@/lib/i18n';

/**
 * Formats one of the report's rates.
 *
 * The payload's rates are already percentages (`hit_rate_percent`), so
 * `formatPercent` — which takes a 0-1 ratio — would multiply them by 100 again. A
 * missing rate renders as a dash rather than "0%", which would read as a model that
 * failed instead of a number the server did not send.
 */
function percentText(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

/**
 * Post-draw accuracy — the model's picks for each completed draw, marked against the
 * numbers that were actually drawn.
 *
 * **It is a replay, and the card says so before it shows a single number.** The
 * service stores no prediction when it makes one, so the server re-runs the model for
 * each target draw using only the draws before it. Reporting that as "what the AI
 * predicted" would be a fabricated claim about the past, so the notice is the first
 * thing on the card rather than a footnote — and the endpoint's own `limitations`
 * are rendered under it, in the server's words, because softening them into the
 * client's copy would be the client editing a caveat.
 *
 * The country comes from the panel's country switcher rather than being chosen here:
 * there is one ledger selector in the card, and it filters both views.
 *
 * Self-contained like `PremiumInsightsPanel`: it owns its request and every loading,
 * error and empty state, so the panel only has to decide whether to render it. An
 * entitlement refusal (401/402/403) is rendered as an answer, not as a failure — the
 * gate above resolves it, so offering Retry for one would be a lie.
 */
export function LatestDrawAccuracy({ lotteryType }: { lotteryType: LotteryType }) {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const { accessToken } = useAuth();
  const [report, setReport] = useState<AccuracyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void getAccuracyReport(lotteryType, undefined, {
      accessToken: accessToken ?? undefined,
    }).then(
      (result) => {
        if (cancelled) return;
        // A response for another ledger is refused rather than rendered: the country
        // tabs exist precisely so one country's numbers are never shown under another
        // country's heading. The effect refetches on every change, so this cannot
        // normally fire — which is why it is worth keeping as a check.
        if (result.lottery_type !== lotteryType) {
          setReport(null);
          setError(t('premium.lotteryMismatch'));
          setLoading(false);
          return;
        }
        setReport(result);
        setError(null);
        setErrorStatus(undefined);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setReport(null);
        setError(
          isApiError(caught) ? caught.message : t('premium.accuracy.loadFailed')
        );
        setErrorStatus(isApiError(caught) ? caught.status : undefined);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [reloadKey, lotteryType, accessToken, t]);

  if (loading) {
    return (
      <View style={styles.stateBody}>
        <ActivityIndicator color={colors.primary} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.stateText}>
          {t('premium.accuracy.loading')}
        </ThemedText>
      </View>
    );
  }

  if (error || !report) {
    const refused = errorStatus === 401 || errorStatus === 402 || errorStatus === 403;
    return (
      <View style={styles.errorWrap}>
        <View style={styles.errHeader}>
          <View style={[styles.errRule, { backgroundColor: colors.danger }]} />
          <ThemedText type="smallBold" style={[styles.errTitle, { color: colors.danger }]}>
            {t('premium.accuracy.loadFailed')}
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
          {error ?? t('premium.unknownError')}
        </ThemedText>
        {refused ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.errHint}>
            {t('premium.refusedHint')}
          </ThemedText>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            onPress={() => {
              setLoading(true);
              setReloadKey((key) => key + 1);
            }}
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="smallBold" style={[styles.retryText, { color: colors.onPrimary }]}>
              {t('common.retry')}
            </ThemedText>
          </Pressable>
        )}
      </View>
    );
  }

  const latest = report.comparisons[0];

  return (
    <View style={styles.container}>
      <View style={styles.titleBlock}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          {t('premium.accuracy.title')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.cardSubtitle}>
          {t('premium.accuracy.subtitle')}
        </ThemedText>
      </View>

      {/*
        First, before any number: what this report is. An accuracy card is read as
        evidence, so the sentence about what kind of evidence it is cannot be the
        small print at the bottom.

        The endpoint's own `replay_notice` is preferred to the local copy above it. It
        is the server describing the replay it actually performed, so it stays accurate
        if the server ever stops replaying — where the client's fixed sentence would
        quietly become a lie. The local string is the fallback for a deployment that
        sends none.
      */}
      <View
        style={[
          styles.replayBox,
          { borderColor: `${colors.warning}66`, backgroundColor: `${colors.warning}14` },
        ]}>
        <ThemedText type="smallBold" style={[styles.replayTitle, { color: colors.warning }]}>
          {t('premium.accuracy.replayTitle')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.replayBody}>
          {report.replay_notice || t('premium.accuracy.replayBody')}
        </ThemedText>
      </View>

      <View style={styles.metaRow}>
        <View
          style={[
            styles.statusPill,
            {
              borderColor:
                report.status === 'ok'
                  ? colors.success
                  : report.status === 'limited'
                    ? colors.warning
                    : colors.neutral,
            },
          ]}>
          <ThemedText
            type="small"
            style={[
              styles.statusText,
              {
                color:
                  report.status === 'ok'
                    ? colors.success
                    : report.status === 'limited'
                      ? colors.warning
                      : colors.neutral,
              },
            ]}>
            {t(STATUS_KEYS[report.status])}
          </ThemedText>
        </View>
        <ThemedText type="small" themeColor="textMuted" style={styles.metaText}>
          {t('premium.accuracy.overWindow', { draws: formatCount(report.draws_evaluated) })}
          {report.comparisons.length > 0
            ? ` · ${t('premium.accuracy.trainedOn', {
                count: formatCount(latest?.train_size ?? 0),
              })}`
            : ''}
        </ThemedText>
      </View>

      {report.warnings.length > 0 ? (
        <View
          style={[
            styles.warnBox,
            { borderColor: `${colors.warning}55`, backgroundColor: `${colors.warning}14` },
          ]}>
          {report.warnings.map((warning) => (
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

      {!latest ? (
        <View style={styles.emptyBox}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
            {t('premium.accuracy.empty')}
          </ThemedText>
        </View>
      ) : (
        <>
          <LatestDraw
            comparison={latest}
            ledger={report.lottery_type}
            language={language}
          />
          <PositionBreakdown positions={latest.positions} />
          <WindowSummary report={report} />
          <ChannelSummary report={report} />
          <DrawsCompared comparisons={report.comparisons} language={language} />
        </>
      )}

      {report.limitations.length > 0 ? (
        <View style={styles.limits}>
          <ThemedText type="small" themeColor="textMuted" style={styles.sectionTitle}>
            {t('premium.accuracy.limitsTitle')}
          </ThemedText>
          {report.limitations.map((item) => (
            <ThemedText
              key={item}
              type="small"
              themeColor="textMuted"
              style={styles.limitItem}>
              — {item}
            </ThemedText>
          ))}
        </View>
      ) : null}

      {report.methodology ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.methodology}>
          {report.methodology}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** The headline: the completed draw, with every matched position picked out. */
function LatestDraw({
  comparison,
  ledger,
  language,
}: {
  comparison: AccuracyComparison;
  /** Which lottery this draw came from, so the result is never unattributed. */
  ledger: LotteryType;
  language: Language;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  // Which positions the model got right, as indices into the prize string. Derived
  // from the server's `hit` flags rather than by comparing digits again here: one
  // definition of "a hit", in the place that computed it.
  const matched = new Set(
    comparison.positions.filter((position) => position.hit).map((position) => position.index)
  );

  return (
    <View style={styles.headline}>
      <View style={styles.headlineHead}>
        <ThemedText type="smallBold" style={styles.sectionTitle}>
          {t('premium.accuracy.latestDraw')} ·{' '}
          {formatLocalizedDate(comparison.draw_date, language)}
        </ThemedText>
        <ThemedText type="small" style={[styles.hits, { color: colors.success }]}>
          {t('premium.accuracy.positionsHit', {
            hits: formatCount(comparison.position_hits),
            total: formatCount(comparison.position_predictions),
          })}
        </ThemedText>
      </View>

      <View style={styles.prizeRow}>
        {comparison.first_prize.split('').map((digit, index) => {
          const hit = matched.has(index);
          return (
            <View
              key={`${index}-${digit}`}
              accessibilityLabel={
                hit ? `${digit} ${t('premium.accuracy.hit')}` : digit
              }
              style={[
                styles.digitBox,
                hit
                  ? { borderColor: colors.success, backgroundColor: `${colors.success}22` }
                  : { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement },
              ]}>
              <ThemedText
                style={[styles.digit, { color: hit ? colors.success : colors.text }]}>
                {digit}
              </ThemedText>
            </View>
          );
        })}
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.prizeMeta}>
        {t('premium.accuracy.actualResult')} · {t(LOTTERY_LABEL_KEYS[ledger])}
      </ThemedText>
    </View>
  );
}

/** One row per position: the model's top three, and the digit that was drawn. */
function PositionBreakdown({ positions }: { positions: AccuracyPosition[] }) {
  const { t } = useTranslation();

  if (positions.length === 0) return null;

  return (
    <View style={styles.breakdown}>
      <ThemedText type="small" themeColor="textMuted" style={styles.sectionTitle}>
        {t('premium.accuracy.aiPredicted')} · {t('premium.accuracy.actualResult')}
      </ThemedText>
      {positions.map((position) => (
        <PositionRow key={position.name} position={position} />
      ))}
    </View>
  );
}

function PositionRow({ position }: { position: AccuracyPosition }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  /*
   * Three states, three colours, and the middle one matters: the actual digit being
   * somewhere in the model's top three is a near miss, not a hit. Colouring it green
   * would claim a hit the model did not make; colouring it grey would hide the fact
   * that it was close. Amber says what happened.
   */
  const tone = position.hit
    ? colors.success
    : position.in_top
      ? colors.warning
      : colors.textMuted;
  const fill = position.hit
    ? `${colors.success}22`
    : position.in_top
      ? `${colors.warning}1A`
      : 'transparent';
  const tag = position.hit
    ? t('premium.accuracy.hit')
    : position.in_top && position.actual_rank !== null
      ? `${t('premium.accuracy.nearMiss')} · ${t('premium.accuracy.rankOf', {
          rank: position.actual_rank,
        })}`
      : t('premium.accuracy.miss');

  return (
    <View style={[styles.positionRow, { borderTopColor: colors.cardBorder }]}>
      <View style={styles.positionHead}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.positionLabel}>
          {t(POSITION_LABEL_KEYS[position.name])}
        </ThemedText>
        <View style={[styles.tag, { backgroundColor: fill === 'transparent' ? undefined : fill }]}>
          <ThemedText type="small" style={[styles.tagText, { color: tone }]}>
            {tag}
          </ThemedText>
        </View>
      </View>

      <View style={styles.positionBody}>
        <View style={styles.chips}>
          {position.top.length === 0 ? (
            <ThemedText type="small" themeColor="textMuted" style={styles.noPicks}>
              {t('premium.accuracy.miss')}
            </ThemedText>
          ) : (
            position.top.map((entry, rank) => {
              const isActual = entry.digit === position.actual;
              return (
                <View
                  key={entry.digit}
                  style={[
                    styles.chip,
                    {
                      borderColor: isActual ? tone : colors.cardBorder,
                      backgroundColor: isActual
                        ? fill === 'transparent'
                          ? undefined
                          : fill
                        : colors.backgroundElement,
                    },
                    rank === 0 && !isActual && { borderColor: `${colors.primary}88` },
                  ]}>
                  <ThemedText
                    type="small"
                    style={[
                      styles.chipText,
                      { color: isActual ? tone : colors.textSecondary },
                    ]}>
                    {entry.digit}
                  </ThemedText>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.actualWrap}>
          <ThemedText type="small" themeColor="textMuted">
            →
          </ThemedText>
          <View
            style={[
              styles.actualBox,
              {
                borderColor: tone,
                backgroundColor: fill === 'transparent' ? undefined : fill,
              },
            ]}>
            <ThemedText type="smallBold" style={[styles.actualDigit, { color: tone }]}>
              {position.actual}
            </ThemedText>
          </View>
        </View>
      </View>
    </View>
  );
}

/** The window's positional rate, its baseline and the p-value verdict. */
function WindowSummary({ report }: { report: AccuracyReport }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const overall = report.accuracy.positional.overall;
  const verdictColor = overall.significant ? colors.success : colors.textMuted;

  /*
    Nothing was scored in this window, so there is no rate to publish.

    The parser is deliberately tolerant — it reads a missing `accuracy` block as
    zeroes — so without this guard a malformed payload would render "0.0% against a
    10.0% baseline, p = 0.0000": a fabricated measurement, and the one number on this
    card that must never be invented.
  */
  if (overall.predictions === 0) return null;

  return (
    <View style={styles.summary}>
      <RateLine
        label={t('premium.accuracy.hitRate', {
          rate: percentText(overall.hit_rate_percent),
          baseline: percentText(overall.baseline_percent),
        })}
        rate={overall}
      />
      <View style={styles.verdictRow}>
        <ThemedText type="small" style={[styles.verdict, { color: verdictColor }]}>
          {overall.significant
            ? t('premium.accuracy.significant')
            : t('premium.accuracy.notSignificant')}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.pValue}>
          {t('premium.accuracy.pValue', { p: overall.p_value.toFixed(4) })}
        </ThemedText>
      </View>
    </View>
  );
}

/** The 2-digit channels: exact, and inside the top five. */
function ChannelSummary({ report }: { report: AccuracyReport }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const channels: ChannelKey[] = ['top', 'bottom'];
  // Built by `flatMap` rather than `map` + `filter` so the absent channel is dropped
  // *and* the type stops being optional at the same point: a filtered tuple array
  // still types the block as possibly missing, and the rows below would each need a
  // guard that the filter has already applied.
  const rows = channels.flatMap((channel) => {
    const block = report.accuracy.channels[channel];
    return block ? [{ channel, block }] : [];
  });

  if (rows.length === 0) return null;

  return (
    <View style={styles.summary}>
      <ThemedText type="small" themeColor="textMuted" style={styles.sectionTitle}>
        {t('premium.accuracy.channels')}
      </ThemedText>
      {rows.map(({ channel, block }) => (
        <View key={channel} style={styles.channelRow}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.channelLabel}>
            {channel === 'top'
              ? t('premium.accuracy.channelTop')
              : t('premium.accuracy.channelBottom')}
          </ThemedText>
          {block.available && block.exact && block.in_top_5 ? (
            <View style={styles.channelRates}>
              <ThemedText type="small" themeColor="textSecondary">
                {t('premium.accuracy.exact')} {percentText(block.exact.hit_rate_percent, 0)} ·{' '}
                {t('premium.accuracy.inTop5')}{' '}
                {percentText(block.in_top_5.hit_rate_percent, 0)}
              </ThemedText>
              <ThemedText type="small" themeColor="textMuted" style={styles.channelBaseline}>
                {percentText(block.exact.baseline_percent, 0)} /{' '}
                {percentText(block.in_top_5.baseline_percent, 0)} ·{' '}
                {t('premium.accuracy.pValue', { p: block.exact.p_value.toFixed(2) })}
              </ThemedText>
            </View>
          ) : (
            <ThemedText type="small" themeColor="textMuted" style={styles.channelReason}>
              {block.reason ?? t('premium.accuracy.empty')}
            </ThemedText>
          )}
        </View>
      ))}
      <View style={[styles.rule, { backgroundColor: colors.cardBorder }]} />
    </View>
  );
}

function RateLine({ label, rate }: { label: string; rate: AccuracyRate }) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.rateRow}>
      <ThemedText style={[styles.rateValue, { color: colors.text }]}>
        {percentText(rate.hit_rate_percent)}
      </ThemedText>
      <View style={styles.rateSide}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.rateLabel}>
          {label}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.rateMeta}>
          {formatCount(rate.hits)}/{formatCount(rate.predictions)} ·{' '}
          {rate.lift_vs_uniform === null ? '—' : `x${rate.lift_vs_uniform.toFixed(2)}`}
        </ThemedText>
      </View>
    </View>
  );
}

/** Every draw compared, so a single lucky result cannot stand in for a record. */
function DrawsCompared({
  comparisons,
  language,
}: {
  comparisons: AccuracyComparison[];
  language: Language;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  if (comparisons.length <= 1) return null;

  return (
    <View style={styles.summary}>
      <ThemedText type="small" themeColor="textMuted" style={styles.sectionTitle}>
        {t('premium.accuracy.recentDraws')}
      </ThemedText>
      {comparisons.map((comparison) => {
        const hit = comparison.position_hits > 0;
        return (
          <View key={comparison.draw_date} style={styles.drawRow}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.drawDate}>
              {formatLocalizedDate(comparison.draw_date, language)}
            </ThemedText>
            <ThemedText style={[styles.drawPrize, { color: colors.text }]}>
              {comparison.first_prize}
            </ThemedText>
            <ThemedText
              type="small"
              style={[styles.drawHits, { color: hit ? colors.success : colors.textMuted }]}>
              {t('premium.accuracy.positionsHit', {
                hits: formatCount(comparison.position_hits),
                total: formatCount(comparison.position_predictions),
              })}
            </ThemedText>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },

  // Title -----------------------------------------------------------------
  titleBlock: {
    gap: Spacing.half,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
  },
  cardSubtitle: {
    fontSize: 11,
    lineHeight: 16,
  },

  // The replay notice -----------------------------------------------------
  replayBox: {
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  replayTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  replayBody: {
    fontSize: 11,
    lineHeight: 16,
  },

  // Status line -----------------------------------------------------------
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 11,
    flexShrink: 1,
  },
  statusPill: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },

  // Headline --------------------------------------------------------------
  headline: {
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  headlineHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  hits: {
    fontSize: 12,
    fontWeight: '800',
  },
  prizeRow: {
    flexDirection: 'row',
    gap: Spacing.one,
    flexWrap: 'wrap',
  },
  digitBox: {
    width: 34,
    height: 40,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digit: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  prizeMeta: {
    fontSize: 10,
  },

  // Per-position breakdown ------------------------------------------------
  breakdown: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  positionRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    gap: Spacing.one,
  },
  positionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  positionLabel: {
    fontSize: 11,
    flexShrink: 1,
  },
  positionBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  chips: {
    flexDirection: 'row',
    gap: Spacing.one,
    flex: 1,
  },
  chip: {
    minWidth: 30,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.half,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  noPicks: {
    fontSize: 11,
  },
  actualWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  actualBox: {
    width: 30,
    height: 30,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actualDigit: {
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  tag: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
  },
  tagText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },

  // Summary ---------------------------------------------------------------
  summary: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  rateValue: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  rateSide: {
    flex: 1,
    gap: Spacing.half,
  },
  rateLabel: {
    fontSize: 11,
    lineHeight: 16,
  },
  rateMeta: {
    fontSize: 10,
  },
  verdictRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  verdict: {
    fontSize: 11,
    fontWeight: '700',
    flexShrink: 1,
  },
  pValue: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },

  // Channels --------------------------------------------------------------
  channelRow: {
    gap: Spacing.half,
  },
  channelLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  channelRates: {
    gap: Spacing.half,
  },
  channelBaseline: {
    fontSize: 10,
  },
  channelReason: {
    fontSize: 10,
    lineHeight: 15,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginTop: Spacing.one,
  },

  // Draws compared --------------------------------------------------------
  drawRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  drawDate: {
    fontSize: 11,
    width: 96,
  },
  drawPrize: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    fontVariant: ['tabular-nums'],
    flex: 1,
  },
  drawHits: {
    fontSize: 11,
    fontWeight: '700',
  },

  // Limits, warnings and states ------------------------------------------
  limits: {
    gap: Spacing.one,
    paddingTop: Spacing.two,
  },
  limitItem: {
    fontSize: 10,
    lineHeight: 15,
  },
  methodology: {
    fontSize: 10,
    lineHeight: 16,
    marginTop: Spacing.one,
  },
  warnBox: {
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  warnItem: {
    fontSize: 11,
    lineHeight: 16,
  },
  emptyBox: {
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 12,
    lineHeight: 20,
    textAlign: 'center',
  },
  stateBody: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  stateText: {
    fontSize: 13,
    lineHeight: 22,
  },
  errorWrap: {
    paddingTop: Spacing.two,
  },
  errHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  errRule: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  errTitle: {
    letterSpacing: 0.4,
  },
  errBody: {
    fontSize: 12,
    lineHeight: 20,
    marginTop: Spacing.two,
  },
  errHint: {
    fontSize: 11,
    lineHeight: 18,
    marginTop: Spacing.two,
    fontStyle: 'italic',
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
  },
  retryText: {
    fontSize: 13,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
