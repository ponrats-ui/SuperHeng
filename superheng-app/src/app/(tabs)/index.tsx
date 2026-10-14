import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import {
  AppHeader,
  Card,
  Countdown,
  HeaderIconButton,
  MODEL_REASON_TAGS,
  PageScaffold,
  PremiumGate,
  PremiumInsightsPanel,
  RankRow,
  ScoreRing,
  SectionHeader,
  SegmentedControl,
  SignalChip,
} from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Brand, Radius, Spacing } from '@/constants/theme';
import { DRAW_META, type SignalTone } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  BASE_URL,
  getBasicPredictions,
  isApiError,
  toRankings,
  type BasicPredictions,
  type ChannelKey,
} from '@/lib/api';
import { getNextDrawAt } from '@/lib/draw';
import { formatCount, formatDate, formatThaiDate } from '@/lib/format';

/** The two independently drawn 2-digit positions the backend ranks. */
type Market = ChannelKey;

/**
 * What the header badge is allowed to claim.
 *
 * Four states, because a boolean conflated three different situations and named
 * all of them "offline": nothing answered *yet*, the server is being woken, and
 * the request actually failed.
 */
type ConnectionState = 'live' | 'connecting' | 'waking' | 'offline';

/** Badge wording per state. Static, so it lives outside the component. */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: 'LIVE',
  connecting: 'CONNECTING',
  waking: 'WAKING',
  offline: 'OFFLINE',
};

const MARKET_OPTIONS = [
  { key: 'top' as const, label: 'Top Position' },
  { key: 'bottom' as const, label: 'Bottom Position' },
];

/** Display names for the signals the backend can actually apply today. */
const SIGNAL_LABELS: Record<string, string> = {
  frequency: 'Frequency',
  markov: 'Markov Chain',
};

/**
 * Models named in the roadmap that Day 3 does not implement yet.
 *
 * Listed inactive so the ensemble panel states what really feeds the score. The
 * mock layer this screen used to read claimed ARIMA and Monte Carlo were live,
 * which stopped being true the moment real data arrived.
 */
const PLANNED_SIGNALS = [
  { key: 'arima', label: 'ARIMA', detail: 'Time-series drift' },
  { key: 'monte', label: 'Monte Carlo', detail: '10k simulations' },
  { key: 'lstm', label: 'LSTM', detail: 'Sequence net' },
] as const;

/** Verdict wording per signal tone. Mirrors the backend's `tone` field. */
const TONE_VERDICT: Record<SignalTone, string> = {
  high: 'Strong signal',
  medium: 'Positive signal',
  low: 'Weak signal',
  cold: 'No meaningful signal',
};

export default function DashboardScreen() {
  const { colors } = useAppTheme();
  const [market, setMarket] = useState<Market>('top');

  const [predictions, setPredictions] = useState<BasicPredictions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * True once the transport has started retrying — i.e. the first attempt did
   * not answer and the server is probably booting. Distinct from `loading` so the
   * wait can be explained instead of merely endured.
   */
  const [waking, setWaking] = useState(false);
  /** Bumped by Retry; the fetch effect keys off it. */
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * The mount fetch, and every later retry.
   *
   * The request is started with `.then` rather than `await` so that no state is
   * written synchronously inside the effect body. Writing state there schedules a
   * cascading render before the request has even been sent, which is what the
   * `set-state-in-effect` rule exists to catch; the initial `loading: true`
   * already covers the first paint.
   *
   * `cancelled` is the ordering guarantee: re-running this effect (a retry) or
   * unmounting flips the previous closure's flag, so a slow response from a
   * superseded request can never overwrite the newer result.
   */
  useEffect(() => {
    let cancelled = false;

    void getBasicPredictions(undefined, {
      onRetry: () => {
        if (cancelled) return;
        setWaking(true);
      },
    }).then(
      (result) => {
        if (cancelled) return;
        setPredictions(result);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        // Drop the stale numbers rather than leaving them on screen beside an
        // error: the previous run's picks are no longer what the server says.
        setPredictions(null);
        setError(
          isApiError(caught) ? caught.message : 'Something went wrong while loading predictions.'
        );
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** Retry is an explicit user action, so it may flip straight back to loading. */
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setWaking(false);
    setReloadKey((key) => key + 1);
  }, []);

  // The API may declare the next draw date; Day 3's payload does not, so fall
  // back to the locally computed GLO schedule (1st/16th, verified against GLO).
  const scheduledDrawAt = useMemo(() => getNextDrawAt(), []);
  const drawAt = useMemo(() => {
    const declared = predictions?.next_draw_date;
    if (!declared) return scheduledDrawAt;
    const parsed = new Date(declared);
    return Number.isNaN(parsed.getTime()) ? scheduledDrawAt : parsed;
  }, [predictions?.next_draw_date, scheduledDrawAt]);

  const rankings = useMemo(() => (predictions ? toRankings(predictions) : null), [predictions]);
  const entries = rankings?.[market] ?? [];

  const channel = predictions?.channels[market] ?? null;
  const topChannel = predictions?.channels.top ?? null;
  const pick = topChannel?.rankings[0] ?? null;

  const weights = useMemo(() => topChannel?.weights ?? {}, [topChannel]);
  const modelNames = useMemo(
    () =>
      Object.keys(weights)
        .filter((key) => weights[key] > 0)
        .map((key) => SIGNAL_LABELS[key] ?? key),
    [weights]
  );

  /**
   * The ensemble chips.
   *
   * Preferred source is the API's own per-model statuses, which list all four
   * models whether or not they contributed — so a skipped model is shown greyed
   * with its reason instead of vanishing from the panel. The local fallback
   * exists only for a payload that predates the field (a stale backend or the
   * dev stub): it reports the applied weights and marks the rest "planned",
   * which was the best available statement before the backend could answer.
   */
  const signals = useMemo(() => {
    const reported = channel?.modelStatuses ?? [];
    if (reported.length > 0) {
      return reported.map((status) => ({
        key: status.key as string,
        label: status.label,
        detail:
          status.status === 'active'
            ? `${Math.round(status.weight * 100)}% weight`
            : (MODEL_REASON_TAGS[status.reason] ?? 'Neutral'),
        active: status.status === 'active',
      }));
    }

    return [
      ...Object.entries(weights)
        .filter(([, weight]) => weight > 0)
        .map(([key, weight]) => ({
          key,
          label: SIGNAL_LABELS[key] ?? key,
          detail: `${Math.round(weight * 100)}% weight`,
          active: true,
        })),
      ...PLANNED_SIGNALS.map((signal) => ({
        key: signal.key as string,
        label: signal.label,
        detail: `${signal.detail} · planned`,
        active: false,
      })),
    ];
  }, [channel, weights]);

  const dataLine = predictions?.latest_draw
    ? `ข้อมูลถึงงวด ${formatThaiDate(new Date(predictions.latest_draw.draw_date))} · ` +
      `${formatCount(predictions.draws_analyzed)} งวด`
    : null;

  /**
   * The header badge.
   *
   * Only a rejection earns "OFFLINE". While a request is still in flight the
   * honest words are "connecting" or, once retries have begun, "waking" — a free
   * Render instance that has spun down can take a minute to answer, and calling
   * that offline made a working backend look dead.
   */
  const connection: ConnectionState = (() => {
    if (predictions !== null && error === null) return 'live';
    if (error !== null) return 'offline';
    return waking ? 'waking' : 'connecting';
  })();

  return (
    <PageScaffold>
      <AppHeader
        subtitle="Probability intelligence"
        right={
          <View style={styles.headerActions}>
            <LiveBadge state={connection} />
            <HeaderIconButton
              ios="info.circle"
              android="info"
              label="เบื้องหลังการคำนวณ"
              onPress={() => router.push('/about')}
            />
          </View>
        }
      />

      {/*
        Draw-date notice. Sits above everything else so the analysed period is
        never ambiguous, and explains the automatic post-draw reset.
      */}
      <View style={[styles.notice, { backgroundColor: colors.card, borderColor: colors.gold }]}>
        <View style={[styles.noticeRule, { backgroundColor: colors.gold }]} />
        <View style={styles.noticeBody}>
          <ThemedText style={styles.noticeText}>
            วิเคราะห์เพื่อประกอบการตัดสินใจ งวดวันที่:{' '}
            <ThemedText style={[styles.noticeDate, { color: colors.gold }]}>
              {formatThaiDate(drawAt)}
            </ThemedText>
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.noticeSub}>
            ระบบจะรีเซ็ตและคำนวณสถิติใหม่โดยอัตโนมัติหลังหวยออก เพื่อเตรียมพร้อมสำหรับงวดถัดไป
          </ThemedText>
          {dataLine ? (
            <ThemedText type="small" themeColor="textMuted" style={styles.noticeSub}>
              {dataLine}
            </ThemedText>
          ) : null}
        </View>
      </View>

      {/* Draw countdown strip */}
      <Card>
        <View style={styles.drawHeader}>
          <View style={styles.drawTitle}>
            <ThemedText type="small" themeColor="textMuted" style={styles.eyebrow}>
              NEXT DRAW
            </ThemedText>
            <ThemedText type="smallBold">{DRAW_META.title}</ThemedText>
          </View>
          <Countdown target={drawAt} compact />
        </View>

        <View style={styles.metaRow}>
          <MetaItem label="Jackpot" value={DRAW_META.jackpot} color={colors.gold} />
          <MetaItem
            label="Draws analysed"
            value={predictions ? formatCount(predictions.draws_analyzed) : '—'}
          />
          <MetaItem
            label="Latest draw"
            value={predictions?.latest_draw ? formatDate(predictions.latest_draw.draw_date) : '—'}
          />
        </View>
      </Card>

      {/*
        Data-dependent region. Loading, failure and "not enough history" are three
        distinct states, and only the middle one is an error.
      */}
      {loading ? <LoadingCard waking={waking} /> : null}

      {!loading && error ? <ErrorCard message={error} onRetry={retry} /> : null}

      {!loading && !error && predictions && !pick ? (
        <InsufficientCard predictions={predictions} />
      ) : null}

      {!loading && !error && predictions && pick && topChannel ? (
        <>
          {/* Top pick hero */}
          <Card padded={false}>
            <View style={styles.hero}>
              <View style={styles.heroTopRow}>
                <View style={styles.tag}>
                  <ThemedText style={[styles.tagText, { color: colors.gold }]}>
                    AI TOP PICK
                  </ThemedText>
                </View>
                <View style={styles.confidencePill}>
                  <View style={styles.liveDot} />
                  <ThemedText style={styles.confidenceText}>
                    {pick.tone.toUpperCase()} CONFIDENCE
                  </ThemedText>
                </View>
              </View>

              <View style={styles.heroMain}>
                <View style={styles.heroCodeBlock}>
                  <ThemedText style={styles.heroPositional}>2-DIGIT · TOP POSITION</ThemedText>
                  <ThemedText style={styles.heroCode}>{pick.code}</ThemedText>
                  <ThemedText style={styles.heroVerdict}>{TONE_VERDICT[pick.tone]}</ThemedText>
                  <ThemedText style={styles.heroModels}>{modelNames.join('  ·  ')}</ThemedText>
                </View>

                <ScoreRing
                  score={pick.score}
                  size={132}
                  thickness={4}
                  color={Brand.goldBright}
                  trackColor="rgba(255,255,255,0.22)"
                  textColor="rgba(255,255,255,0.75)"
                  label="Heng score"
                />
              </View>

              <View style={styles.heroDivider} />

              {/*
                Real evidence instead of the mock radar. The radar chart needs five
                axis values and the API supplies two — filling the rest would mean
                inventing data, which is exactly what this app must not do.
              */}
              <View style={styles.heroFooter}>
                <HeroStat
                  label="Sample size"
                  value={`${formatCount(predictions.draws_analyzed)} draws`}
                />
                <HeroStat label="Board state" value={topChannel.current_state} />
                <HeroStat
                  label="Markov support"
                  value={`${topChannel.markov.support} transitions`}
                />
                <HeroStat
                  label="Frequency lift"
                  value={`${pick.evidence.frequency.lift.toFixed(2)}× uniform`}
                />
              </View>
            </View>
          </Card>

          {/* Rankings */}
          <Card>
            <SectionHeader
              title="Rankings"
              subtitle={
                channel
                  ? `${channel.label} · ${formatCount(channel.draws)} draws analysed · state ${channel.current_state}`
                  : '2-digit position model'
              }
            />

            <View style={styles.controlRow}>
              <SegmentedControl options={MARKET_OPTIONS} value={market} onChange={setMarket} />
            </View>

            <View style={styles.list}>
              {entries.map((entry, index) => (
                <View key={entry.code} style={styles.listItem}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: colors.cardBorder }]} />
                  ) : null}
                  <RankRow rank={index + 1} entry={entry} />
                </View>
              ))}
            </View>

            <ThemedText type="small" themeColor="textMuted" style={styles.listNote}>
              Bar length is the Heng score (0–100). The pill is the model&apos;s literal per-draw
              probability, where 1.0% is the uniform baseline across 100 codes. All four model
              badges are shown on every pick — a greyed badge is a model that contributed no
              measured evidence there; tap it for the reason.
            </ThemedText>
          </Card>

          {/* Model ensemble */}
          <Card>
            <SectionHeader
              title="Model ensemble"
              subtitle={
                channel
                  ? `All four models · what feeds the ${market}-position blend`
                  : 'Signals currently feeding the prediction'
              }
            />
            <View style={styles.chips}>
              {signals.map((signal) => (
                <SignalChip
                  key={signal.key}
                  label={signal.label}
                  detail={signal.detail}
                  active={signal.active}
                />
              ))}
            </View>
          </Card>

          {/*
            The backend reports every limitation it knows about (thin Markov
            support, a short window). Rendering them keeps a low-confidence
            ranking from reading like a confident one.
          */}
          {predictions.warnings.length > 0 ? (
            <Card>
              <SectionHeader title="Data conditions" subtitle={`Model status: ${predictions.status}`} />
              <View style={styles.warnList}>
                {predictions.warnings.map((warning) => (
                  <ThemedText
                    key={warning}
                    type="small"
                    themeColor="textMuted"
                    style={styles.warnItem}>
                    • {warning}
                  </ThemedText>
                ))}
              </View>
            </Card>
          ) : null}
        </>
      ) : null}

      {/*
        Premium insights — Bayesian positional model over the 6-digit first
        prize, rendered live.

        PREMIUM MODE: gated behind `PremiumGate` for the beta, so the math and
        layout can still be tested without handing them to every tester. The gate
        is a beta door, not access control — this is a static build and the
        endpoint is public — so a paid tier still needs a server-side entitlement
        check rather than a client flag.
      */}
      <Card>
        <SectionHeader
          title="Premium insights"
          subtitle="Bayesian positional model · รางวัลที่ 1"
          action={
            <View style={[styles.premiumPill, { borderColor: `${colors.gold}80` }]}>
              <ThemedText type="small" style={[styles.premiumPillText, { color: colors.accent }]}>
                ✨ PREMIUM MODE
              </ThemedText>
            </View>
          }
        />
        <PremiumGate>
          <PremiumInsightsPanel />
        </PremiumGate>
      </Card>

      {/*
        Support entry point. Deliberately a button rather than the QR itself —
        the code is only rendered inside the donate modal.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="สนับสนุนนักพัฒนา"
        onPress={() => router.push('/donate')}
        style={({ pressed }) => [
          styles.donate,
          { borderColor: colors.gold, backgroundColor: colors.backgroundElement },
          pressed && styles.pressed,
        ]}>
        <ThemedText style={styles.donateTitle}>💸 ถูกรางวัล? เลี้ยงกาแฟทีมงาน</ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.donateSub}>
          สนับสนุนนักพัฒนา (Donate)
        </ThemedText>
      </Pressable>

      <ThemedText type="small" themeColor="textMuted" style={styles.disclaimer}>
        Predictions are statistical estimates from historical draw data. No model can guarantee an
        outcome — play responsibly.
      </ThemedText>
    </PageScaffold>
  );
}

/**
 * Header badge.
 *
 * Reports whether the live model actually answered, rather than always claiming
 * "LIVE" — a permanently lit badge above an error card is a lie the user cannot
 * see through. Equally, it does not claim "OFFLINE" on a server that simply has
 * not answered yet: see `ConnectionState`.
 */
function LiveBadge({ state }: { state: ConnectionState }) {
  const { colors } = useAppTheme();
  const dot = {
    live: colors.success,
    connecting: colors.neutral,
    waking: colors.warning,
    offline: colors.danger,
  }[state];

  return (
    <View style={[styles.liveBadge, { backgroundColor: colors.backgroundElement }]}>
      <View style={[styles.liveDot, { backgroundColor: dot }]} />
      <ThemedText type="small" style={[styles.liveText, { color: colors.textSecondary }]}>
        {CONNECTION_LABEL[state]}
      </ThemedText>
    </View>
  );
}

/**
 * Shown while the request is in flight.
 *
 * `waking` is the second half of that wait: the first attempt already timed out,
 * which on this deployment almost always means the free instance spun down and is
 * booting. Naming it turns an unexplained hang into a wait the user can decide to
 * sit through.
 */
function LoadingCard({ waking }: { waking: boolean }) {
  const { colors } = useAppTheme();
  return (
    <Card>
      <View style={styles.stateBody}>
        <ActivityIndicator color={colors.primary} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.stateText}>
          {waking
            ? 'กำลังปลุกเซิร์ฟเวอร์… (เซิร์ฟเวอร์สลีปอยู่ อาจใช้เวลาถึง 1 นาที)'
            : 'กำลังโหลดผลวิเคราะห์จากเซิร์ฟเวอร์…'}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.stateHint}>
          {BASE_URL}/api/predict/basic
        </ThemedText>
      </View>
    </Card>
  );
}

/** Shown when the call failed — the one state that is genuinely an error. */
function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Card>
      <View style={styles.errHeader}>
        <View style={[styles.errRule, { backgroundColor: colors.danger }]} />
        <ThemedText type="smallBold" style={[styles.errTitle, { color: colors.danger }]}>
          โหลดข้อมูลไม่สำเร็จ
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
        {message}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.errHint}>
        ต้องรัน backend ที่ {BASE_URL} ก่อน — uvicorn main:app --reload
      </ThemedText>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="ลองอีกครั้ง"
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retry,
          { backgroundColor: colors.primary },
          pressed && styles.pressed,
        ]}>
        <ThemedText type="smallBold" style={[styles.retryText, { color: colors.onPrimary }]}>
          ลองอีกครั้ง (Retry)
        </ThemedText>
      </Pressable>
    </Card>
  );
}

/**
 * Shown when the request succeeded but there is not enough history to rank.
 *
 * A distinct state from `ErrorCard` on purpose: an empty ledger is a successful
 * call, and the backend answers it with HTTP 200 and a `status` rather than a
 * failure so the client can render this instead of an error.
 */
function InsufficientCard({ predictions }: { predictions: BasicPredictions }) {
  return (
    <Card>
      <SectionHeader
        title="ยังไม่มีข้อมูลเพียงพอ"
        subtitle={`Model status: ${predictions.status}`}
      />
      <ThemedText type="small" themeColor="textSecondary" style={styles.errBody}>
        ฐานข้อมูลมี {formatCount(predictions.draws_analyzed)} งวด ระบบจึงยังไม่สร้างอันดับ —
        การจัดอันดับจากข้อมูลเท่านี้จะเป็นตัวเลขเดาสุ่ม ไม่ใช่ผลวิเคราะห์
      </ThemedText>
      {predictions.warnings[0] ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.errHint}>
          {predictions.warnings[0]}
        </ThemedText>
      ) : null}
    </Card>
  );
}

function MetaItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.metaItem}>
      <ThemedText type="small" themeColor="textMuted" style={styles.metaLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={[styles.metaValue, color ? { color } : undefined]}>
        {value}
      </ThemedText>
    </View>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.heroStat}>
      <ThemedText style={styles.heroStatLabel}>{label}</ThemedText>
      <ThemedText style={styles.heroStatValue}>{value}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  // Header ---------------------------------------------------------------
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Brand.goldBright,
  },

  // Draw-date notice -----------------------------------------------------
  notice: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.two + 2,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noticeRule: {
    width: 3,
    borderRadius: 2,
  },
  noticeBody: {
    flex: 1,
    gap: Spacing.one,
  },
  noticeText: {
    // Thai needs a taller line box than the Latin default would give it.
    fontSize: 14,
    lineHeight: 26,
    fontWeight: '700',
  },
  noticeDate: {
    fontSize: 14,
    lineHeight: 26,
    fontWeight: '800',
  },
  noticeSub: {
    fontSize: 11,
    lineHeight: 20,
  },

  // Donate ---------------------------------------------------------------
  donate: {
    alignItems: 'center',
    gap: Spacing.half,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.xl,
    borderWidth: 1,
  },
  donateTitle: {
    fontSize: 15,
    lineHeight: 26,
    fontWeight: '700',
  },
  donateSub: {
    fontSize: 11,
    letterSpacing: 0.4,
  },
  pressed: {
    opacity: 0.7,
  },

  // Draw strip -----------------------------------------------------------
  drawHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  drawTitle: {
    gap: 2,
    flexShrink: 1,
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: 1.2,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginTop: Spacing.three,
    flexWrap: 'wrap',
  },
  metaItem: {
    flex: 1,
    minWidth: 84,
    gap: 2,
  },
  metaLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  metaValue: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },

  // Hero -----------------------------------------------------------------
  hero: {
    padding: Spacing.four,
    gap: Spacing.three,
    // Solid crimson is the cross-platform base; the gradient layers on top on
    // native. `experimental_backgroundImage` is not applied by React Native Web,
    // so without this the hero would fall back to the neutral card surface.
    backgroundColor: Brand.crimson,
    experimental_backgroundImage: `linear-gradient(140deg, ${Brand.crimsonBright} 0%, ${Brand.crimson} 42%, ${Brand.crimsonDeep} 100%)`,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  tag: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(240, 206, 99, 0.5)',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  tagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  confidencePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  confidenceText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  heroMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  heroCodeBlock: {
    flexShrink: 1,
    gap: Spacing.half,
  },
  heroPositional: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  heroCode: {
    color: '#FFFFFF',
    fontSize: 66,
    lineHeight: 70,
    fontWeight: '900',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  heroVerdict: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  heroModels: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    marginTop: Spacing.half,
  },
  heroDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  heroFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
  },
  heroStat: {
    minWidth: 100,
    flexGrow: 1,
    gap: 1,
  },
  heroStatLabel: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  heroStatValue: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  // Rankings -------------------------------------------------------------
  controlRow: {
    marginTop: Spacing.two,
    alignItems: 'flex-start',
  },
  list: {
    marginTop: Spacing.three,
    gap: Spacing.three,
  },
  listItem: {
    gap: Spacing.three,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  listNote: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: Spacing.three,
  },

  // Data conditions ------------------------------------------------------
  warnList: {
    marginTop: Spacing.three,
    gap: Spacing.two,
  },
  warnItem: {
    fontSize: 11,
    lineHeight: 16,
  },

  // Premium teasers ------------------------------------------------------
  premiumPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  premiumPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  // Ensemble -------------------------------------------------------------
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },

  // Load / error / empty states ------------------------------------------
  stateBody: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  stateText: {
    fontSize: 13,
    lineHeight: 22,
  },
  stateHint: {
    fontSize: 10,
    letterSpacing: 0.3,
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
    fontSize: 10,
    lineHeight: 16,
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
    fontSize: 13,
    fontWeight: '700',
  },

  disclaimer: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: Spacing.three,
  },
});
