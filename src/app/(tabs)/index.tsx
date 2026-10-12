import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppHeader,
  Card,
  Countdown,
  PageScaffold,
  RadarChart,
  RankRow,
  ScoreRing,
  SectionHeader,
  SegmentedControl,
  SignalChip,
} from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Brand, Radius, Spacing } from '@/constants/theme';
import { DRAW_META, MODEL_SIGNALS, RADAR_AXES, RANKINGS, TOP_PICK } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { getNextDrawAt } from '@/lib/draw';
import { formatCount } from '@/lib/format';

type Market = 'top' | 'bottom';

const MARKET_OPTIONS = [
  { key: 'top' as const, label: 'Top Position' },
  { key: 'bottom' as const, label: 'Bottom Position' },
];

export default function DashboardScreen() {
  const { colors } = useAppTheme();
  const [market, setMarket] = useState<Market>('top');

  // The next draw instant is stable for the life of the screen; the Countdown
  // component owns the per-second ticking.
  const drawAt = useMemo(() => getNextDrawAt(), []);
  const entries = RANKINGS[market];

  return (
    <PageScaffold>
      <AppHeader
        subtitle="Probability intelligence"
        right={<LiveBadge />}
      />

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
          <MetaItem label="Draws analysed" value={formatCount(DRAW_META.drawsAnalysed)} />
          <MetaItem label="Timezone" value={DRAW_META.timezone} />
        </View>
      </Card>

      {/* Top pick hero */}
      <Card padded={false}>
        <View style={styles.hero}>
          <View style={styles.heroTopRow}>
            <View style={styles.tag}>
              <ThemedText style={[styles.tagText, { color: colors.gold }]}>AI TOP PICK</ThemedText>
            </View>
            <View style={styles.confidencePill}>
              <View style={styles.liveDot} />
              <ThemedText style={styles.confidenceText}>
                {TOP_PICK.confidence.toUpperCase()} CONFIDENCE
              </ThemedText>
            </View>
          </View>

          <View style={styles.heroMain}>
            <View style={styles.heroCodeBlock}>
              <ThemedText style={styles.heroPositional}>2-DIGIT · TOP POSITION</ThemedText>
              <ThemedText style={styles.heroCode}>{TOP_PICK.code}</ThemedText>
              <ThemedText style={styles.heroVerdict}>{TOP_PICK.verdict}</ThemedText>
              <ThemedText style={styles.heroModels}>{TOP_PICK.models.join('  ·  ')}</ThemedText>
            </View>

            <ScoreRing
              score={TOP_PICK.score}
              size={132}
              thickness={4}
              color={Brand.goldBright}
              trackColor="rgba(255,255,255,0.22)"
              textColor="rgba(255,255,255,0.75)"
              label="Heng score"
            />
          </View>

          <View style={styles.heroDivider} />

          <View style={styles.heroFooter}>
            <RadarChart
              values={TOP_PICK.radar}
              size={116}
              color={Brand.goldBright}
              gridColor="rgba(255,255,255,0.24)"
            />
            <View style={styles.heroStats}>
              <HeroStat label="Sample size" value={`${formatCount(TOP_PICK.sampleSize)} draws`} />
              <HeroStat label="Strongest axis" value={RADAR_AXES[1]} />
              <HeroStat
                label="Model agreement"
                value={`${TOP_PICK.models.length}/${MODEL_SIGNALS.length} engines`}
              />
            </View>
          </View>
        </View>
      </Card>

      {/* Rankings */}
      <Card>
        <SectionHeader title="Rankings" subtitle="2-digit position model · top 5" />

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
      </Card>

      {/* Model ensemble */}
      <Card>
        <SectionHeader title="Model ensemble" subtitle="Signals currently feeding the prediction" />
        <View style={styles.chips}>
          {MODEL_SIGNALS.map((signal) => (
            <SignalChip
              key={signal.key}
              label={signal.label}
              detail={signal.detail}
              active={signal.active}
            />
          ))}
        </View>
      </Card>

      <ThemedText type="small" themeColor="textMuted" style={styles.disclaimer}>
        Predictions are statistical estimates from historical draw data. No model can guarantee an
        outcome — play responsibly.
      </ThemedText>
    </PageScaffold>
  );
}

function LiveBadge() {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.liveBadge, { backgroundColor: colors.backgroundElement }]}>
      <View style={[styles.liveDot, { backgroundColor: colors.success }]} />
      <ThemedText type="small" style={[styles.liveText, { color: colors.textSecondary }]}>
        LIVE
      </ThemedText>
    </View>
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
    alignItems: 'center',
    gap: Spacing.three,
  },
  heroStats: {
    flex: 1,
    gap: Spacing.two,
  },
  heroStat: {
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

  // Ensemble -------------------------------------------------------------
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },

  disclaimer: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: Spacing.three,
  },
});
