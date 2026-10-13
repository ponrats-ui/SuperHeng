import { StyleSheet, View } from 'react-native';

import { Card, ModalScaffold } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

/** Framing sentence that leads into the model list. */
const INTRO =
  'เราใช้ข้อมูลสถิติผลการออกรางวัลย้อนหลังจาก "สำนักงานสลากกินแบ่งรัฐบาล (GLO)" มาประมวลผลผ่านโมเดลคณิตศาสตร์และ AI ขั้นสูง ดังนี้:';

/**
 * The four models the ensemble actually runs.
 *
 * Names deliberately match the engine labels on the dashboard's model panel so
 * the explainer and the product tell the same story.
 */
const MODELS = [
  {
    key: 'time-series',
    emoji: '📈',
    name: 'Time Series (ARIMA & Prophet):',
    body: 'วิเคราะห์ความสัมพันธ์ของตัวเลขตามเวลา และจับ "ฤดูกาล" เช่น เลขที่มักออกบ่อยในช่วงเดือนหรือวันหยุดนี้',
  },
  {
    key: 'markov-chains',
    emoji: '🔗',
    name: 'Markov Chains:',
    body: 'สร้างตารางความน่าจะเป็น เพื่อดูว่าถ้างวดที่แล้วออกเลขนี้ โอกาสงวดถัดไปจะเปลี่ยนสถานะไปที่เลขกลุ่มใดมากที่สุด',
  },
  {
    key: 'monte-carlo',
    emoji: '🎲',
    name: 'Monte Carlo Simulation:',
    body: 'ให้คอมพิวเตอร์จำลองการสุ่มออกรางวัลล่วงหน้านับแสนครั้ง โดยอิงน้ำหนักจากสถิติ 20 ปี เลขที่ชนะบ่อยที่สุดจะได้รับคะแนนสูงสุด',
  },
  {
    key: 'deep-learning',
    emoji: '🧠',
    name: 'Deep Learning (LSTM):',
    body: 'ใช้โครงข่ายประสาทเทียมเรียนรู้แพทเทิร์นที่ซับซ้อนเกินกว่ามนุษย์จะมองเห็น เช่น ความเชื่อมโยงระหว่างรางวัลที่ 1 และเลขท้าย 2 ตัวในอดีต',
  },
] as const;

/** Caveat shown at the foot of the explainer. */
const DISCLAIMER =
  'คำเตือน: ข้อมูลและคะแนนในแอปพลิเคชันเป็นการวิเคราะห์เชิงสถิติจากข้อมูลย้อนหลัง ไม่ใช่การรับประกันผลการออกรางวัล';

/** Legal footer asserting ownership of the algorithms and data. */
const COPYRIGHT =
  '© 2026 SuperHeng. All Rights Reserved. ห้ามคัดลอก ดัดแปลง หรือทำซ้ำอัลกอริทึมและข้อมูลโดยเด็ดขาด';

/**
 * "How SuperHeng works" explainer.
 *
 * Presented as a modal from the dashboard header. Native platforms get a real
 * modal (swipe down to dismiss); web renders it as a `transparentModal` overlay
 * with a tappable backdrop, because Expo Router renders `modal` as a plain
 * stack route on web.
 */
export default function AboutScreen() {
  const { colors } = useAppTheme();

  const content = (
    <>
      <View style={styles.titleBlock}>
        <ThemedText style={styles.titleEmoji}>💡</ThemedText>
        <View style={styles.titleText}>
          <ThemedText style={styles.titleThai}>เบื้องหลังการคำนวณความน่าจะเป็น</ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.titleEn}>
            How SuperHeng Works
          </ThemedText>
        </View>
      </View>

      <Card>
        <ThemedText style={styles.intro}>{INTRO}</ThemedText>

        <View style={styles.list}>
          {MODELS.map((model) => (
            <View key={model.key} style={styles.listItem}>
              <View style={[styles.divider, { backgroundColor: colors.cardBorder }]} />
              <View style={styles.modelHead}>
                <ThemedText style={styles.modelEmoji}>{model.emoji}</ThemedText>
                <ThemedText style={styles.modelName}>{model.name}</ThemedText>
              </View>
              <ThemedText style={styles.modelBody}>{model.body}</ThemedText>
            </View>
          ))}
        </View>
      </Card>

      <View
        style={[
          styles.note,
          { backgroundColor: colors.backgroundElement, borderColor: colors.warning },
        ]}>
        <ThemedText style={styles.noteEmoji}>⚠️</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.noteText}>
          {DISCLAIMER}
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textMuted" style={styles.copyright}>
        {COPYRIGHT}
      </ThemedText>
    </>
  );

  return <ModalScaffold eyebrow="HOW IT WORKS">{content}</ModalScaffold>;
}

const styles = StyleSheet.create({
  // Title -----------------------------------------------------------------
  titleBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  titleEmoji: {
    fontSize: 32,
    lineHeight: 40,
  },
  titleText: {
    flexShrink: 1,
    gap: 2,
  },
  titleThai: {
    // Thai stacks tone marks above and vowel marks below the baseline, so the
    // default line box clips them; this needs a taller line height than Latin.
    fontSize: 20,
    lineHeight: 34,
    fontWeight: '800',
  },
  titleEn: {
    fontSize: 12,
    letterSpacing: 0.4,
  },

  // Model list ------------------------------------------------------------
  intro: {
    fontSize: 14,
    lineHeight: 26,
  },
  list: {
    marginTop: Spacing.three,
    gap: Spacing.three,
  },
  listItem: {
    gap: Spacing.two,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  modelHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + 2,
  },
  modelEmoji: {
    fontSize: 18,
    lineHeight: 28,
  },
  modelName: {
    // Bold label for each algorithm; `flex: 1` keeps long names wrapping
    // inside the row instead of pushing past the card edge.
    flex: 1,
    fontSize: 15,
    lineHeight: 28,
    fontWeight: '700',
  },
  modelBody: {
    fontSize: 14,
    lineHeight: 26,
  },

  // Disclaimer ------------------------------------------------------------
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noteEmoji: {
    fontSize: 14,
    lineHeight: 22,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 22,
  },
  copyright: {
    // Muted legal footer. Line height stays tall enough that Thai tone marks
    // are not clipped at this small size.
    fontSize: 11,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
});
