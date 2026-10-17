import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppHeader, Card, PageScaffold, SectionHeader, StatTile } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  getBacktest,
  getBasicPredictions,
  type ApiRanking,
  type Backtest,
  type BacktestChannel,
  type BacktestChannelReport,
  type BacktestTimelinePoint,
  type LotteryType,
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
 * How much history the highlights card searches, and in which ledgers.
 *
 * The card answers "is there a *verified* win to lead with?" and the answer has to
 * outlive the six-draw window above it: a real top-five catch from three weeks ago is
 * still a real catch. Thirty draws is the window the Backtest tab publishes rates over,
 * so the card and the tab cannot quote different records for the same ledger. It is
 * also the window in which the server's p-value is computed, which is why the card can
 * put the p-value beside the win instead of leaving it implied.
 */
const HIGHLIGHT_DRAWS = 30;

/** The ledgers the highlights card looks through, in display order. */
const HIGHLIGHT_TYPES: readonly LotteryType[] = ['thai', 'laos', 'vietnam'];

const COUNTRY_LABEL_KEYS: Record<LotteryType, TranslationKey> = {
  thai: 'premium.lotteryThai',
  laos: 'premium.lotteryLaos',
  vietnam: 'premium.lotteryVietnam',
};

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

/**
 * The model's top pick for the *upcoming* draw, with the signal that carried it.
 *
 * This is the only place a "where did this number come from" badge is honest: the
 * payload ships the evidence for the live ranking, and nothing ships evidence for a
 * replayed historical pick. Attaching a provenance tag to a past draw would be
 * inventing the provenance — the number and the reason would both be reconstructions.
 */
type PickEvidence = {
  channel: BacktestChannel;
  code: string;
  labelKey: TranslationKey;
  params: Record<string, string | number>;
};

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; report: Backtest }
  | { status: 'failed'; text: ApiErrorText };

type LatestState =
  | { status: 'loading' }
  | { status: 'ready'; draw: LatestDraw; picks: PickEvidence[] }
  | { status: 'empty' }
  | { status: 'failed' };

/**
 * One draw the service can prove a signal caught.
 *
 * `kind` is the strength of the claim, not decoration: `exact` means the number the
 * model ranked first was the number drawn, `top5` means it sat somewhere in the five
 * codes the model shortlisted. The two are rendered differently because they are
 * different achievements — a top-five catch against a 5% baseline is a real result,
 * but it is not a hit on the ranking's first line.
 *
 * The rate fields come from the same payload as the winning draw, never from a
 * favourite window picked after the fact: `hits / picks` and the p-value are the
 * server's own summary of the ledger this draw belongs to.
 */
type Highlight = {
  lotteryType: LotteryType;
  channel: BacktestChannel;
  drawDate: string;
  actual: string;
  kind: 'exact' | 'top5';
  picks: number;
  hits: number;
  percent: number | null;
  baseline: number | null;
  pValue: number | null;
  significant: boolean;
};

type HighlightState =
  | { status: 'loading' }
  | { status: 'ready'; highlight: Highlight | null }
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
 * The newest draw in one ledger that any scored signal actually caught, if any.
 *
 * Only signals the server scores per draw are considered. The frequency and Markov
 * evidence in `/api/predict/basic` describes the *upcoming* draw and is not stored, so
 * it cannot be checked against a result that already happened; claiming a past draw was
 * "a Heatmap hit" would mean recomputing the heatmap after seeing the number and then
 * calling that a prediction. Top-five membership and the #1 pick are the two claims the
 * replay genuinely holds.
 */
function buildHighlight(lotteryType: LotteryType, report: Backtest): Highlight | null {
  let best: Highlight | null = null;

  for (const channel of HISTORY_CHANNELS) {
    const block = report.channels[channel];
    const timeline = block?.timeline;
    if (!block?.available || !timeline?.length) continue;

    // The timeline is oldest-first, so the first hit walking backwards is the latest.
    const point = [...timeline].reverse().find((row) => row.exact_hit || row.top_5_hit);
    if (!point) continue;

    const candidate: Highlight = {
      lotteryType,
      channel,
      drawDate: point.draw_date,
      actual: point.actual,
      kind: point.exact_hit ? 'exact' : 'top5',
      picks: timeline.length,
      hits: block.ai?.top_5_hits ?? 0,
      percent: block.ai?.top_5_hit_rate_percent ?? null,
      baseline: block.uniform?.top_5_hit_rate_percent ?? null,
      pValue: block.skill?.top_5_p_value ?? null,
      significant: block.skill?.top_5_significant === true,
    };

    if (
      !best ||
      candidate.drawDate > best.drawDate ||
      (candidate.drawDate === best.drawDate &&
        candidate.kind === 'exact' &&
        best.kind !== 'exact')
    ) {
      best = candidate;
    }
  }

  return best;
}

/** The most recent verified win across the ledgers, preferring a stronger claim. */
function newestHighlight(highlights: Highlight[]): Highlight | null {
  const ranked = [...highlights].sort((a, b) => {
    if (a.drawDate !== b.drawDate) return a.drawDate < b.drawDate ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === 'exact' ? -1 : 1;
    return 0;
  });
  return ranked[0] ?? null;
}

/**
 * The single strongest real signal behind a pick.
 *
 * Both evidence records are emitted by the backend for the code it ranked, so the tag
 * quotes the model's own numbers instead of a summary written by hand: `lift` is
 * `count / expected` for frequency and a smoothed conditional/unconditional ratio for
 * Markov. When neither beats the uniform rate the tag says exactly that — a confident
 * badge on a pick with no edge is the same lie in smaller type.
 */
function strongestEvidence(channel: BacktestChannel, ranking: ApiRanking): PickEvidence {
  const frequency = ranking.evidence?.frequency;
  const markov = ranking.evidence?.markov;
  const frequencyLift = frequency?.lift ?? 0;
  const markovLift = markov?.lift ?? 0;

  if (markov && markovLift > Math.max(1, frequencyLift)) {
    return {
      channel,
      code: ranking.code,
      labelKey: 'performance.evidenceMarkov',
      params: { lift: markovLift.toFixed(2) },
    };
  }
  if (frequency && frequencyLift > 1) {
    return {
      channel,
      code: ranking.code,
      labelKey: 'performance.evidenceFrequency',
      params: {
        lift: frequencyLift.toFixed(2),
        count: frequency.count,
        expected: Math.round(frequency.expected),
      },
    };
  }
  return { channel, code: ranking.code, labelKey: 'performance.evidenceUniform', params: {} };
}

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

/**
 * The HIT / TOP-5 / MISS verdict for one replayed draw, as colours and a key.
 *
 * A miss is neutral grey, not red. Red on every row of an honest record reads as an
 * alarm and pushes the reader towards the interpretation the numbers do not support;
 * grey states the same fact without editorialising. Green is reserved for an exact
 * hit and gold for "inside the five picks", because those two are not the same claim.
 */
function verdictOf(
  point: BacktestTimelinePoint,
  colors: { success: string; gold: string; neutral: string }
): { labelKey: TranslationKey; color: string } {
  if (point.exact_hit) return { labelKey: 'performance.hit', color: colors.success };
  if (point.top_5_hit) return { labelKey: 'performance.inTop5', color: colors.gold };
  return { labelKey: 'performance.miss', color: colors.neutral };
}

export default function PerformanceScreen() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const [ticket, setTicket] = useState('');
  const [outcome, setOutcome] = useState<CheckOutcome>(null);
  const [checked, setChecked] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });
  const [latest, setLatest] = useState<LatestState>({ status: 'loading' });
  const [highlights, setHighlights] = useState<HighlightState>({ status: 'loading' });
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

    // The highlights scan the three ledgers for a win the replay can prove. It is its own
    // request pair because it needs a wider window than the six-draw list, and it is
    // allowed to fail on its own: a slow ledger must not take the history card down.
    void Promise.allSettled(
      HIGHLIGHT_TYPES.map((type) => getBacktest(type, HIGHLIGHT_DRAWS))
    ).then((results) => {
      if (cancelled) return;
      const found: Highlight[] = [];
      let answered = 0;
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        answered += 1;
        const highlight = buildHighlight(HIGHLIGHT_TYPES[index], result.value);
        if (highlight) found.push(highlight);
      });
      // No ledger answered at all is a failure, not an empty record — the card must not
      // say "no wins" when it is the network that is missing.
      setHighlights(
        answered === 0
          ? { status: 'failed' }
          : { status: 'ready', highlight: newestHighlight(found) }
      );
    });

    void getBasicPredictions().then(
      (payload) => {
        if (cancelled) return;
        const draw = payload.latest_draw;
        // The ranking rides along in the same response, so the provenance tags cost no
        // extra request — and they are the live ranking's evidence, never the replay's.
        const picks = HISTORY_CHANNELS.map((channel) => {
          const ranking = payload.channels[channel]?.rankings?.[0];
          return ranking ? strongestEvidence(channel, ranking) : null;
        }).filter((pick): pick is PickEvidence => pick !== null);

        setLatest(
          draw
            ? {
                status: 'ready',
                draw: {
                  date: draw.draw_date,
                  firstPrize: draw.first_prize,
                  bottomTwo: draw.bottom_two,
                },
                picks,
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
    setHighlights({ status: 'loading' });
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
          The verified highlight, above the full list. Every number in it comes from the
          replay the rows below are built from — there is no hand-written win here, and
          when the ledgers have none the card says so instead of inventing one.
        */}
        {history.status === 'ready' ? (
          <SuccessHighlights
            state={highlights}
            drawsSearched={HIGHLIGHT_DRAWS}
            language={language}
            t={t}
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

        {latest.status === 'ready' && latest.picks.length > 0 ? (
          <EvidenceStrip picks={latest.picks} t={t} />
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

/**
 * The verified highlight above the list.
 *
 * It is built from the replay the rows below it come from, so the number in it can be
 * checked by scrolling: same ledger, same baselines, same p-value rule. That is the
 * whole point of putting it here rather than in a marketing block — the claim and the
 * evidence sit an inch apart. When no ledger has a catch in the window the card states
 * the count instead of disappearing, because a silent card reads as "nothing to see"
 * while an empty one reads as "we checked".
 */
function SuccessHighlights({
  state,
  drawsSearched,
  language,
  t,
}: {
  state: HighlightState;
  drawsSearched: number;
  language: Language;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const { colors } = useAppTheme();

  if (state.status === 'loading') return null;

  if (state.status === 'failed') {
    return (
      <View style={[styles.highlight, { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement }]}>
        <ThemedText type="small" themeColor="textMuted" style={styles.highlightLine}>
          {t('performance.highlightsFailed')}
        </ThemedText>
      </View>
    );
  }

  const highlight = state.highlight;
  if (!highlight) {
    return (
      <View style={[styles.highlight, { borderColor: colors.cardBorder, backgroundColor: colors.backgroundElement }]}>
        <ThemedText type="smallBold" style={styles.highlightTitle}>
          {t('performance.highlightsTitle')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.highlightLine}>
          {t('performance.highlightsEmpty', { draws: drawsSearched })}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.highlightFootnote}>
          {t('performance.highlightsEmptyBody')}
        </ThemedText>
      </View>
    );
  }

  // Green only for the number the model ranked first; gold for a top-five catch, which is
  // a weaker claim and is labelled as one.
  const tone = highlight.kind === 'exact' ? colors.success : colors.gold;

  return (
    <View style={[styles.highlight, { borderColor: `${tone}59`, backgroundColor: `${tone}12` }]}>
      <ThemedText type="smallBold" style={[styles.highlightTitle, { color: tone }]}>
        {t('performance.highlightsTitle')}
      </ThemedText>

      <View style={styles.highlightBody}>
        <View
          style={[
            styles.highlightNumber,
            { borderColor: `${tone}80`, backgroundColor: `${tone}1F` },
          ]}>
          <ThemedText
            style={[
              styles.highlightDigits,
              { color: tone, textShadowColor: `${tone}99`, textShadowRadius: 14 },
            ]}>
            {highlight.actual}
          </ThemedText>
        </View>

        <View style={styles.highlightText}>
          <View style={styles.highlightTagRow}>
            <View style={[styles.highlightTag, { backgroundColor: `${tone}26` }]}>
              <ThemedText type="small" style={[styles.highlightTagText, { color: tone }]}>
                {t(
                  highlight.kind === 'exact'
                    ? 'performance.sourceTop1'
                    : 'performance.sourceTop5'
                )}
              </ThemedText>
            </View>
            <ThemedText type="small" themeColor="textMuted" style={styles.highlightMeta}>
              {t(COUNTRY_LABEL_KEYS[highlight.lotteryType])} ·{' '}
              {formatLocalizedDate(highlight.drawDate, language)}
            </ThemedText>
          </View>

          <ThemedText type="small" themeColor="textSecondary" style={styles.highlightLine}>
            {t(
              highlight.kind === 'exact'
                ? 'performance.highlightsExactBody'
                : 'performance.highlightsTop5Body',
              { number: highlight.actual }
            )}
          </ThemedText>

          <ThemedText type="small" themeColor="textMuted" style={styles.highlightLine}>
            {t('performance.highlightsChannel', {
              channel: t(CHANNEL_LABEL_KEYS[highlight.channel]),
            })}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textSecondary" style={styles.highlightStats}>
        {t('performance.highlightsRate', {
          hits: highlight.hits,
          draws: highlight.picks,
          rate: percent(highlight.percent),
          baseline: percent(highlight.baseline),
        })}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.highlightStats}>
        {highlight.pValue === null
          ? ''
          : `${t('performance.highlightsP', { p: formatP(highlight.pValue) })} · `}
        {t(
          highlight.significant
            ? 'performance.highlightsSignificant'
            : 'performance.highlightsNotSignificant'
        )}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.highlightFootnote}>
        {t('performance.highlightsReplay')}
      </ThemedText>
    </View>
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
  colors: {
    success: string;
    gold: string;
    neutral: string;
    backgroundElement: string;
    cardBorder: string;
    text: string;
  };
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
          {point.exact_hit || point.top_5_hit ? (
            <ThemedText
              type="small"
              style={[
                styles.latestSource,
                { color: point.exact_hit ? colors.success : colors.gold },
              ]}>
              {t(
                point.exact_hit ? 'performance.sourceTop1' : 'performance.sourceTop5'
              )}
            </ThemedText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Why the model's *upcoming* picks are where they are.
 *
 * This is the provenance badge the design calls for, built from the evidence the API
 * actually emitted for each ranking — not a retrospective label on a finished draw,
 * where the number was rebuilt and the reason was never recorded.
 */
function EvidenceStrip({
  picks,
  t,
}: {
  picks: PickEvidence[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.evidence, { borderColor: `${colors.gold}40`, backgroundColor: `${colors.gold}0A` }]}>
      <ThemedText type="smallBold" style={[styles.evidenceTitle, { color: colors.accent }]}>
        {t('performance.evidenceTitle')}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.evidenceSubtitle}>
        {t('performance.evidenceSubtitle')}
      </ThemedText>

      {picks.map((pick) => (
        <View key={pick.channel} style={styles.evidenceRow}>
          <ThemedText type="small" themeColor="textMuted" style={styles.evidenceChannel}>
            {t(CHANNEL_LABEL_KEYS[pick.channel])}
          </ThemedText>
          <View
            style={[
              styles.evidenceCode,
              { borderColor: `${colors.gold}66`, backgroundColor: `${colors.gold}1A` },
            ]}>
            <ThemedText type="smallBold" style={[styles.evidenceCodeText, { color: colors.accent }]}>
              {pick.code}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.evidenceTag}>
            {t(pick.labelKey, pick.params)}
          </ThemedText>
        </View>
      ))}
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
  const caught = point.exact_hit === 1 || point.top_5_hit === 1;
  const caughtTone = point.exact_hit ? colors.success : colors.gold;

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
        {/*
          A caught draw puts the actual number in the accent colour and names the signal
          underneath: the number on the right is the one a signal found, so this is the
          honest place for "which signal" — attaching the tag to the pick instead would
          claim the pick came from a list it is only one line of.
        */}
        <ThemedText
          type="smallBold"
          style={[styles.actualValue, caught && { color: caughtTone }]}>
          {point.actual}
        </ThemedText>
        <View style={[styles.hitBadge, { backgroundColor: `${verdict.color}22` }]}>
          <ThemedText type="small" style={[styles.hitText, { color: verdict.color }]}>
            {t(verdict.labelKey)}
          </ThemedText>
        </View>
        {caught ? (
          <ThemedText type="small" style={[styles.sourceTagText, { color: caughtTone }]}>
            {t(
              point.exact_hit ? 'performance.sourceTop1' : 'performance.sourceTop5'
            )}
          </ThemedText>
        ) : null}
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
  evidence: {
    marginTop: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  evidenceTitle: {
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  evidenceSubtitle: {
    fontSize: 10,
    lineHeight: 15,
  },
  evidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  evidenceChannel: {
    fontSize: 10,
    flexShrink: 0,
  },
  evidenceCode: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  evidenceCodeText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  evidenceTag: {
    flex: 1,
    fontSize: 10,
    lineHeight: 15,
  },
  highlight: {
    marginTop: Spacing.three,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
  },
  highlightTitle: {
    fontSize: 12,
    letterSpacing: 0.4,
  },
  highlightBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  highlightNumber: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: 1,
    minWidth: 78,
  },
  highlightDigits: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '800',
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
  },
  highlightText: {
    flex: 1,
    gap: 3,
  },
  highlightTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  highlightTag: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  highlightTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  highlightMeta: {
    fontSize: 10,
  },
  highlightLine: {
    fontSize: 11,
    lineHeight: 16,
  },
  highlightStats: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: Spacing.one,
    fontVariant: ['tabular-nums'],
  },
  highlightFootnote: {
    fontSize: 9,
    lineHeight: 14,
    marginTop: Spacing.one,
  },
  latestSource: {
    fontSize: 10,
    fontWeight: '700',
  },
  sourceTagText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
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
