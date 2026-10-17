import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppHeader, Card, PageScaffold, SectionHeader, StatTile } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  getBacktest,
  getBasicPredictions,
  type Backtest,
  type BacktestChannel,
  type BacktestChannelReport,
  type BacktestTimelinePoint,
} from '@/lib/api';
import { apiErrorText, type ApiErrorText } from '@/lib/api-error';
import { formatP, percent } from '@/lib/backtest-format';
import { formatLocalizedDate } from '@/lib/format';
import { useTranslation, type Language, type TranslationKey } from '@/lib/i18n';

/**
 * How many recent draws the history card replays.
 *
 * Six is a deliberate compromise: it is three months of Thai draws (the 1st and the
 * 16th), so the card always contains the draw that just happened, and the replay costs
 * roughly a second per draw on the live ledger. The dedicated Backtest tab replays 30
 * for the rates; this card is about *which* draws are in the window, not about the
 * statistics, which is why it is fed by the same endpoint rather than by a second
 * implementation of the same arithmetic.
 */
const HISTORY_DRAWS = 6;

/**
 * Channel preference for the history rows.
 *
 * `bottom` (เลขท้าย 2 ตัว) first because that is the number the dashboard's ranking and
 * a 2-digit ticket are both about; `top` is the fallback for a ledger whose bottom
 * channel the server cannot derive. The card names whichever one it is showing rather
 * than leaving the reader to assume.
 */
const HISTORY_CHANNELS: readonly BacktestChannel[] = ['bottom', 'top'];

/**
 * The two prizes this ledger can actually verify, and no others.
 *
 * Both are checked against numbers the service really holds: the first prize is the
 * `first_prize` column itself, and เลขท้าย 2 ตัว is the separately drawn `bottom_two` —
 * `backend/data_ingestion.py` documents at length that the two are *not* related by
 * digits, so a checker that derived one from the other would mark tickets against
 * numbers that were never drawn.
 *
 * The amounts follow the sources this project already cites: ฿6,000,000 for รางวัลที่ 1
 * on an ฿80 ticket, and ฿2,000 for เลขท้าย 2 ตัว — the latter is the payout
 * `backend/backtest.py` documents as "verified" and the source of the 25× ROI multiple
 * the backtest computes with. No 2nd/3rd/4th/5th tier is listed, because the ledger
 * holds no digits for them and a tier table nobody can check is decoration.
 */
const PRIZE_TIERS: readonly {
  match: TranslationKey;
  label: TranslationKey;
  amount: TranslationKey;
}[] = [
  {
    match: 'performance.tierAllSix',
    label: 'performance.tierFirstPrize',
    amount: 'performance.amountFirstPrize',
  },
  {
    match: 'performance.tierLastTwoDigits',
    label: 'performance.tierLastTwo',
    amount: 'performance.amountLastTwo',
  },
];

/** Which tier a ticket hit, if any — an outcome the card translates, not a sentence. */
type CheckOutcome = { tier: 'first'; prize: string } | { tier: 'lastTwo'; digits: string } | null;

/** The latest published result, as `/api/predict/basic` reports it. */
type LatestDraw = { date: string; firstPrize: string; bottomTwo: string };

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; report: Backtest }
  | { status: 'failed'; text: ApiErrorText };

type LatestState =
  | { status: 'loading' }
  | { status: 'ready'; draw: LatestDraw }
  | { status: 'empty' }
  | { status: 'failed' };

/** The channel this card will show, preferring the bottom two. */
function historyChannel(report: Backtest): BacktestChannelReport | undefined {
  return HISTORY_CHANNELS.map((key) => report.channels[key]).find((row) => row?.available);
}

/** Which channel the rows are from, for the card's own copy. */
function channelKey(report: Backtest): BacktestChannel | null {
  return HISTORY_CHANNELS.find((key) => report.channels[key]?.available) ?? null;
}

const CHANNEL_LABEL_KEYS: Record<BacktestChannel, TranslationKey> = {
  bottom: 'performance.channelBottom',
  top: 'performance.channelTop',
};

/**
 * Checks a ticket against the *published* result.
 *
 * Two outcomes, both of which the ledger can prove: an exact รางวัลที่ 1 match on the six
 * digits, and a เลขท้าย 2 ตัว match on the last two. Anything shorter that matches neither
 * is reported as no prize rather than being mapped onto a tier whose digits the service
 * never received — the previous version of this screen matched a user's number against
 * mock "2nd" and "3rd" prize numbers that no draw ever produced.
 */
function checkTicket(input: string, draw: LatestDraw | null): CheckOutcome {
  const digits = input.replace(/\D/g, '');
  if (!digits || !draw) return null;

  if (digits === draw.firstPrize) return { tier: 'first', prize: draw.firstPrize };
  if (digits.length >= 2 && digits.endsWith(draw.bottomTwo)) {
    return { tier: 'lastTwo', digits: draw.bottomTwo };
  }
  return null;
}

/** The HIT / TOP-5 / MISS verdict for one replayed draw, as colours and a key. */
function verdictOf(point: BacktestTimelinePoint, colors: {
  success: string;
  gold: string;
  danger: string;
}): { labelKey: TranslationKey; color: string } {
  if (point.exact_hit) return { labelKey: 'performance.hit', color: colors.success };
  if (point.top_5_hit) return { labelKey: 'performance.inTop5', color: colors.gold };
  return { labelKey: 'performance.miss', color: colors.danger };
}

export default function PerformanceScreen() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const [ticket, setTicket] = useState('');
  const [outcome, setOutcome] = useState<CheckOutcome>(null);
  const [checked, setChecked] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });
  const [latest, setLatest] = useState<LatestState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // The history and the latest result are independent requests, so they are fired
    // together and each card fills in as its own answer arrives — the checker must not
    // wait on the replay, which is the slower of the two.
    void getBacktest('thai', HISTORY_DRAWS).then(
      (report) => {
        if (cancelled) return;
        setHistory({ status: 'ready', report });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setHistory({ status: 'failed', text: apiErrorText(caught) });
      }
    );

    void getBasicPredictions().then(
      (payload) => {
        if (cancelled) return;
        const draw = payload.latest_draw;
        setLatest(
          draw
            ? {
                status: 'ready',
                draw: {
                  date: draw.draw_date,
                  firstPrize: draw.first_prize,
                  bottomTwo: draw.bottom_two,
                },
              }
            : { status: 'empty' }
        );
      },
      () => {
        if (cancelled) return;
        setLatest({ status: 'failed' });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const latestDraw = latest.status === 'ready' ? latest.draw : null;
  const report = history.status === 'ready' ? history.report : null;
  const channel = report ? historyChannel(report) : undefined;
  const key = report ? channelKey(report) : null;
  const rows = channel?.timeline ? [...channel.timeline].reverse() : [];
  // The newest draw is promoted into its own comparison block, so it is not repeated
  // as the first row of the list underneath.
  const [headline, ...earlier] = rows;

  const onCheck = () => {
    setOutcome(checkTicket(ticket, latestDraw));
    setChecked(true);
  };

  function retry() {
    setHistory({ status: 'loading' });
    setLatest({ status: 'loading' });
    setReloadKey((value) => value + 1);
  }

  function prizeSubtitle(): string {
    if (latest.status === 'ready') {
      return t('performance.latestResultWithPrize', {
        date: formatLocalizedDate(latest.draw.date, language),
        prize: latest.draw.firstPrize,
      });
    }
    if (latest.status === 'failed') return t('performance.latestResultUnavailable');
    if (latest.status === 'empty') return t('performance.latestResultUnavailable');
    return t('performance.latestResultLoading');
  }

  function outcomeDetail(): string {
    if (!outcome) {
      if (latestDraw) {
        return t('performance.noPrizeDetail', {
          date: formatLocalizedDate(latestDraw.date, language),
          first: latestDraw.firstPrize,
          bottom: latestDraw.bottomTwo,
        });
      }
      return t('performance.noPrizePending');
    }
    if (outcome.tier === 'first') {
      return `${t('performance.amountFirstPrize')} · ${t('performance.matchFirstPrize', {
        prize: outcome.prize,
      })}`;
    }
    return `${t('performance.amountLastTwo')} · ${t('performance.matchLastTwo', {
      digits: outcome.digits,
    })}`;
  }

  function outcomeLabel(): string {
    if (!outcome) return t('performance.noPrize');
    return t('performance.winner', {
      label: t(outcome.tier === 'first' ? 'performance.tierFirstPrize' : 'performance.tierLastTwo'),
    });
  }

  return (
    <PageScaffold>
      <AppHeader subtitle={t('performance.title')} />

      {/* Accuracy summary — the replay's own numbers, each beside its baseline. */}
      <Card>
        <SectionHeader
          title={t('performance.scorecardTitle')}
          subtitle={
            report
              ? t('performance.scorecardSubtitle', { draws: report.draws_evaluated })
              : t('performance.scorecardSubtitleFallback')
          }
        />

        {history.status === 'loading' ? <StateRow label={t('performance.replaying')} /> : null}

        {history.status === 'failed' ? (
          <Failure
            message={t(history.text.key, history.text.params)}
            onRetry={retry}
            retryLabel={t('performance.retry')}
          />
        ) : null}

        {report && !channel ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.note}>
            {report.status === 'ok'
              ? t('performance.channelUnavailable')
              : (report.warnings[0] ?? t('performance.notEnoughHistory'))}
          </ThemedText>
        ) : null}

        {report && channel ? (
          <>
            <View style={styles.tiles}>
              <StatTile
                label={t('performance.hitRate')}
                value={percent(channel.ai?.exact_hit_rate_percent)}
                hint={t('performance.uniformBaseline', {
                  rate: percent(channel.uniform?.exact_hit_rate_percent),
                })}
                color={colors.success}
              />
              <StatTile
                label={t('performance.top5Rate')}
                value={percent(channel.ai?.top_5_hit_rate_percent)}
                hint={t('performance.uniformBaseline', {
                  rate: percent(channel.uniform?.top_5_hit_rate_percent),
                })}
                color={colors.gold}
              />
              <StatTile
                label={t('performance.drawsScored')}
                value={`${report.draws_evaluated}`}
                hint={t('performance.drawsRequested', { requested: report.draws_requested })}
              />
              <StatTile
                label={t('performance.pValue')}
                value={channel.skill ? formatP(channel.skill.top_5_p_value) : '—'}
                hint={t(
                  channel.skill?.top_5_significant
                    ? 'performance.significant'
                    : 'performance.notSignificant'
                )}
              />
            </View>

            {/*
              The server's own caveat, rendered rather than paraphrased. On the live Thai
              ledger it says the window is indistinguishable from chance, which is the
              number a reader is entitled to see next to the rates above it.
            */}
            {report.warnings[0] ? (
              <ThemedText type="small" themeColor="textMuted" style={styles.warning}>
                {report.warnings[0]}
              </ThemedText>
            ) : null}
          </>
        ) : null}
      </Card>

      {/* Prize checker — against the draw that was actually published. */}
      <Card>
        <SectionHeader title={t('performance.prizeChecker')} subtitle={prizeSubtitle()} />
        <View style={styles.inputRow}>
          <TextInput
            value={ticket}
            onChangeText={(text) => setTicket(text.replace(/\D/g, '').slice(0, 6))}
            onSubmitEditing={onCheck}
            placeholder={t('performance.ticketPlaceholder')}
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={6}
            returnKeyType="search"
            accessibilityLabel={t('performance.ticketLabel')}
            style={[
              styles.input,
              { color: colors.text, backgroundColor: colors.backgroundElement, borderColor: colors.cardBorder },
            ]}
          />
          <Pressable
            onPress={onCheck}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}>
            <ThemedText style={[styles.buttonText, { color: colors.onPrimary }]}>
              {t('performance.check')}
            </ThemedText>
          </Pressable>
        </View>

        {checked ? (
          <View
            style={[
              styles.result,
              {
                backgroundColor: outcome ? `${colors.success}1A` : colors.backgroundElement,
                borderColor: outcome ? `${colors.success}66` : colors.cardBorder,
              },
            ]}>
            <ThemedText type="smallBold" style={outcome ? { color: colors.success } : undefined}>
              {outcomeLabel()}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.resultNote}>
              {outcomeDetail()}
            </ThemedText>
          </View>
        ) : null}

        <View style={styles.tiers}>
          {PRIZE_TIERS.map((tier) => (
            <View key={tier.label} style={[styles.tierRow, { borderTopColor: colors.cardBorder }]}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.tierMatch}>
                {t(tier.match)}
              </ThemedText>
              <ThemedText type="smallBold">{t(tier.label)}</ThemedText>
              <ThemedText type="smallBold" style={[styles.tierAmount, { color: colors.gold }]}>
                {t(tier.amount)}
              </ThemedText>
            </View>
          ))}
        </View>

        <ThemedText type="small" themeColor="textMuted" style={styles.footnote}>
          {t('performance.prizeScope')}
        </ThemedText>
      </Card>

      {/* Prediction history */}
      <Card>
        <SectionHeader
          title={t('performance.historyTitle')}
          subtitle={
            report
              ? t('performance.historySubtitle', {
                  from: formatLocalizedDate(report.date_range.from ?? '', language),
                  to: formatLocalizedDate(report.date_range.to ?? '', language),
                })
              : t('performance.historySubtitleFallback')
          }
        />

        {history.status === 'loading' ? <StateRow label={t('performance.scoring')} /> : null}

        {history.status === 'failed' ? (
          <Failure
            message={t(history.text.key, history.text.params)}
            onRetry={retry}
            retryLabel={t('performance.retry')}
          />
        ) : null}

        {/*
          The draw that just happened, promoted out of the list: it is the one a reader
          opens this screen for, and "AI ทำนาย vs ผลออกรางวัล" side by side is the whole
          question. The verdict below it is the server's (`exact_hit` / `top_5_hit`), not
          the client's arithmetic.
        */}
        {headline ? (
          <LatestDrawComparison
            point={headline}
            language={language}
            t={t}
            colors={colors}
          />
        ) : null}

        {report && channel && rows.length === 0 ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.note}>
            {t('performance.notEnoughHistory')}
          </ThemedText>
        ) : null}

        {earlier.length > 0 ? (
          <View style={styles.history}>
            {earlier.map((point) => (
              <HistoryRow key={point.draw_date} point={point} language={language} t={t} />
            ))}
          </View>
        ) : null}

        <ThemedText type="small" themeColor="textMuted" style={styles.footnote}>
          {key
            ? `${t('performance.historyRowNote', { channel: t(CHANNEL_LABEL_KEYS[key]) })} `
            : ''}
          {t('performance.historyReplayNote')}
        </ThemedText>
      </Card>
    </PageScaffold>
  );
}

/** The newest draw, as a side-by-side prediction / result comparison. */
function LatestDrawComparison({
  point,
  language,
  t,
  colors,
}: {
  point: BacktestTimelinePoint;
  language: Language;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  colors: { success: string; gold: string; danger: string; backgroundElement: string; cardBorder: string; text: string };
}) {
  const verdict = verdictOf(point, colors);

  return (
    <View
      style={[
        styles.latestCard,
        {
          borderColor: `${verdict.color}55`,
          backgroundColor: `${verdict.color}0F`,
        },
      ]}>
      <View style={styles.latestHead}>
        <View style={styles.latestHeadText}>
          <ThemedText type="small" themeColor="textMuted" style={styles.latestEyebrow}>
            {t('performance.latestDraw')}
          </ThemedText>
          <ThemedText type="smallBold" style={styles.latestDate}>
            {formatLocalizedDate(point.draw_date, language)}
          </ThemedText>
        </View>
        <View style={[styles.verdictBadge, { backgroundColor: `${verdict.color}26` }]}>
          <ThemedText type="small" style={[styles.verdictText, { color: verdict.color }]}>
            {t(verdict.labelKey)}
          </ThemedText>
        </View>
      </View>

      <View style={styles.latestCompare}>
        <View style={styles.latestSide}>
          <ThemedText type="small" themeColor="textMuted" style={styles.latestLabel}>
            {t('performance.aiPredicted')}
          </ThemedText>
          <View
            style={[
              styles.latestValue,
              {
                borderColor: point.exact_hit ? `${colors.success}66` : colors.cardBorder,
                backgroundColor: point.exact_hit ? `${colors.success}1F` : colors.backgroundElement,
              },
            ]}>
            <ThemedText style={styles.latestDigits}>{point.pick}</ThemedText>
          </View>
        </View>

        <ThemedText type="small" themeColor="textMuted" style={styles.latestVs}>
          vs
        </ThemedText>

        <View style={styles.latestSide}>
          <ThemedText type="small" themeColor="textMuted" style={styles.latestLabel}>
            {t('performance.actualResult')}
          </ThemedText>
          <View
            style={[
              styles.latestValue,
              { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement },
            ]}>
            <ThemedText style={[styles.latestDigits, { color: colors.text }]}>
              {point.actual}
            </ThemedText>
          </View>
        </View>
      </View>
    </View>
  );
}

/** One earlier replayed draw: the model's pick, the actual result, and the verdict. */
function HistoryRow({
  point,
  language,
  t,
}: {
  point: BacktestTimelinePoint;
  language: Language;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const { colors } = useAppTheme();
  const verdict = verdictOf(point, colors);

  return (
    <View style={[styles.historyRow, { borderTopColor: colors.cardBorder }]}>
      <View style={styles.historyLeft}>
        <ThemedText type="small" themeColor="textMuted" style={styles.historyDate}>
          {formatLocalizedDate(point.draw_date, language)}
        </ThemedText>
        <View style={styles.picks}>
          <View
            style={[
              styles.pick,
              {
                backgroundColor: point.exact_hit
                  ? `${colors.success}22`
                  : colors.backgroundElement,
              },
            ]}>
            <ThemedText type="small" style={styles.pickText}>
              {point.pick}
            </ThemedText>
          </View>
        </View>
      </View>

      <View style={styles.historyRight}>
        <ThemedText type="small" themeColor="textMuted" style={styles.actualLabel}>
          {t('performance.actual')}
        </ThemedText>
        <ThemedText type="smallBold" style={styles.actualValue}>
          {point.actual}
        </ThemedText>
        <View style={[styles.hitBadge, { backgroundColor: `${verdict.color}22` }]}>
          <ThemedText type="small" style={[styles.hitText, { color: verdict.color }]}>
            {t(verdict.labelKey)}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

/** A one-line loading state, so a slow replay does not look like an empty card. */
function StateRow({ label }: { label: string }) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.stateRow}>
      <ActivityIndicator size="small" color={colors.primary} />
      <ThemedText type="small" themeColor="textMuted" style={styles.stateText}>
        {label}
      </ThemedText>
    </View>
  );
}

function Failure({
  message,
  onRetry,
  retryLabel,
}: {
  message: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.failure}>
      <ThemedText type="small" themeColor="textMuted" style={styles.note}>
        {message}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={retryLabel}
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
        <ThemedText type="small" style={[styles.retryText, { color: colors.accent }]}>
          {retryLabel}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  stateText: {
    fontSize: 11,
  },
  failure: {
    marginTop: Spacing.three,
  },
  note: {
    marginTop: Spacing.three,
    fontSize: 11,
    lineHeight: 17,
  },
  warning: {
    marginTop: Spacing.three,
    fontSize: 10,
    lineHeight: 15,
  },
  retry: {
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
    paddingVertical: Spacing.one,
  },
  retryText: {
    fontSize: 11,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  inputRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  input: {
    flex: 1,
    // See my-number: keeps the field from overflowing its row on web.
    minWidth: 0,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 3,
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
  result: {
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  resultNote: {
    lineHeight: 18,
  },
  tiers: {
    marginTop: Spacing.three,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tierMatch: {
    flex: 1,
  },
  tierAmount: {
    fontVariant: ['tabular-nums'],
  },
  latestCard: {
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
  },
  latestHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  latestHeadText: {
    gap: 1,
  },
  latestEyebrow: {
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  latestDate: {
    fontSize: 13,
  },
  verdictBadge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  verdictText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  latestCompare: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  latestSide: {
    flex: 1,
    gap: Spacing.one,
  },
  latestLabel: {
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  latestValue: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  latestDigits: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '800',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  latestVs: {
    fontSize: 11,
    paddingBottom: Spacing.four,
  },
  history: {
    marginTop: Spacing.two,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  historyLeft: {
    flex: 1,
    gap: Spacing.one,
  },
  historyDate: {
    fontSize: 11,
  },
  picks: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  pick: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.sm,
  },
  pickText: {
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  historyRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  actualLabel: {
    fontSize: 9,
    letterSpacing: 0.8,
  },
  actualValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  hitBadge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  hitText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  footnote: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: Spacing.three,
  },
});
