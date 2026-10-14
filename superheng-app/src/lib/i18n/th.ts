import type { TranslationKey } from './en';

/**
 * Thai strings.
 *
 * Typed as `Record<TranslationKey, string>`, which is the whole safety net: a key
 * added to `en.ts` and forgotten here fails `tsc`, and a key that exists here but
 * not in English also fails. Neither language can silently drift.
 *
 * ## Fixed terminology
 *
 * Technical wording is decided once, here, so the app never says two things for one
 * concept — the failure mode the mixed-language UI already had:
 *
 * | English | Thai | Note |
 * |---|---|---|
 * | conditional probability | ความน่าจะเป็นแบบมีเงื่อนไข | the standard Thai statistical phrasing |
 * | marginal probability | ความน่าจะเป็นส่วนขอบ | "ส่วนขอบ" is the established term for *marginal* |
 * | posterior / prior | ภายหลัง / ก่อนหน้า | as in การแจกแจงภายหลัง (posterior distribution) |
 * | probability density | ความหนาแน่นของโอกาส | for continuous densities |
 * | support (sample size) | จำนวนตัวอย่าง | never "support" transliterated |
 * | lift | อัตราเพิ่ม | expressed as "เทียบฐาน" when shown against the uniform rate |
 * | uniform (rate) | อัตราฐาน | the base rate every digit would have if the draw were flat |
 * | ensemble | แบบจำลองผสม | not "ensemble" transliterated |
 * | Bayesian | เบย์เซียน | |
 * | Markov chain | ลูกโซ่มาร์คอฟ | |
 * | Monte Carlo | มอนติคาร์โล | |
 * | Dirichlet | ดิริชเลต์ | |
 * | frequency | ความถี่ | |
 * | transition (state) | การเปลี่ยนสถานะ | |
 * | draw (a lottery draw) | งวด | the everyday Thai word, not "การจับรางวัล" |
 * | hit rate | อัตราทายถูก | |
 * | ARIMA, MC, Premium, AI | kept in Latin | acronyms and brand terms; transliterating them hurts recognition |
 *
 * Thai has no plural forms, so the `_one` variants English uses are simply the same
 * wording here rather than a separate singular form.
 */
export const th: Record<TranslationKey, string> = {
  // Shared
  'common.retry': 'ลองอีกครั้ง',
  'common.loading': 'กำลังโหลด…',
  'common.close': 'ปิด',
  'common.dismiss': 'ปิด',
  'common.draws': '{count} งวด',
  'common.draws_one': '{count} งวด',
  'common.draw': 'งวด',
  'common.today': 'วันนี้',
  'common.daysAgo_one': '1 วันที่แล้ว',
  'common.daysAgo': '{count} วันที่แล้ว',
  'common.of': '{part} จาก {whole}',
  'common.uniform': 'อัตราฐาน',
  'common.weight': 'น้ำหนัก {percent}%',
  'common.language': 'ภาษา',
  'common.switchToEnglish': 'เปลี่ยนเป็นภาษาอังกฤษ',
  'common.switchToThai': 'เปลี่ยนเป็นภาษาไทย',

  // Navigation + headers
  'nav.dashboard': 'หน้าหลัก',
  'nav.myNumber': 'เลขของฉัน',
  'nav.insights': 'เจาะลึก',
  'nav.performance': 'ความแม่นยำ',

  'header.dashboardSubtitle': 'วิเคราะห์ความน่าจะเป็น',
  'header.insightsSubtitle': 'เจาะลึกสถิติ',
  'header.myNumberSubtitle': 'วิเคราะห์เลขใดก็ได้',
  'header.performanceSubtitle': 'ผลงานและความโปร่งใส',
  'header.gridBadge': 'ตาราง 00–99',

  // Dashboard — hero + tiles
  'dashboard.tagline': 'วิเคราะห์เพื่อประกอบการตัดสินใจ',
  'dashboard.drawDateLabel': 'งวดวันที่: {date}',
  'dashboard.resetNotice':
    'ระบบจะรีเซ็ตและคำนวณสถิติใหม่โดยอัตโนมัติหลังหวยออก เพื่อเตรียมพร้อมสำหรับงวดถัดไป',
  'dashboard.dataThrough': 'ข้อมูลถึงงวด {date} · {count} งวด',
  'dashboard.nextDraw': 'งวดถัดไป',
  'dashboard.governmentLottery': 'สลากกินแบ่งรัฐบาล',
  'dashboard.days': 'วัน',
  'dashboard.hrs': 'ชม.',
  'dashboard.min': 'นาที',
  'dashboard.sec': 'วินาที',
  'dashboard.jackpot': 'รางวัลใหญ่',
  'dashboard.drawsAnalysed': 'งวดที่วิเคราะห์',
  'dashboard.latestDraw': 'งวดล่าสุด',
  'dashboard.aiTopPick': 'เลขเด่นจาก AI',
  'dashboard.highConfidence': 'ความเชื่อมั่นสูง',
  'dashboard.coldConfidence': 'ไม่มีความเชื่อมั่น',
  'dashboard.positionModelFallback': 'แบบจำลอง 2 ตัว',
  'dashboard.lowConfidence': 'ความเชื่อมั่นต่ำ',
  'dashboard.mediumConfidence': 'ความเชื่อมั่นปานกลาง',
  'dashboard.topPosition2Digit': '2 ตัวท้าย · รางวัลที่ 1',
  'dashboard.bottomPosition2Digit': '2 ตัวล่าง · เลขท้าย 2 ตัว',
  'dashboard.hengScore': 'คะแนนเฮง',
  'dashboard.sampleSize': 'ขนาดตัวอย่าง',
  'dashboard.boardState': 'สถานะบนกระดาน',
  'dashboard.markovSupport': 'ตัวอย่างมาร์คอฟ',
  'dashboard.frequencyLift': 'ความถี่เทียบฐาน',
  'dashboard.topPosition': 'ฝั่งบน',
  'dashboard.bottomPosition': 'ฝั่งล่าง',
  'dashboard.modelEnsembleTitle': 'แบบจำลองผสม',
  'dashboard.signalsFeeding': 'สัญญาณที่ใช้คำนวณอยู่ตอนนี้',
  'dashboard.dataConditions': 'สภาพข้อมูล',
  'dashboard.modelStatus': 'สถานะแบบจำลอง: {status}',
  'dashboard.unknownError': 'เกิดข้อผิดพลาดระหว่างโหลดผลวิเคราะห์',
  'dashboard.rankings': 'อันดับ',
  'dashboard.rankingsSubtitle': '2 ตัวท้ายของรางวัลที่ 1 · {count} งวด',
  'dashboard.rankingsSubtitleBottom': 'เลขท้าย 2 ตัว · {count} งวด',
  'dashboard.transitions_one': '{count} การเปลี่ยนสถานะ',
  'dashboard.transitions': '{count} การเปลี่ยนสถานะ',
  'dashboard.vsUniform': '{lift}× อัตราฐาน',
  'dashboard.analysedState': '{label} · วิเคราะห์ {count} งวด · สถานะ {state}',
  'dashboard.modelEnsemble': 'แบบจำลองทั้งสี่ · องค์ประกอบของชุด{market}',
  'dashboard.marketTop': 'ฝั่งบน',
  'dashboard.marketBottom': 'ฝั่งล่าง',
  'dashboard.behindTheMath': 'เบื้องหลังการคำนวณ',
  'dashboard.barIsScore':
    'ความยาวแท่งคือคะแนนเฮง (0–100) ตัวเลขในป้ายคือความน่าจะเป็นต่องวดของเลขนั้น โดย 1.0% คืออัตราฐานเมื่อมี 100 เลข ป้ายแบบจำลองทั้งสี่จะแสดงทุกตัวเลข ป้ายสีเทาคือแบบจำลองที่ไม่ได้ให้หลักฐานที่วัดได้ในตัวเลขนั้น แตะที่ป้ายเพื่อดูเหตุผล',
  'dashboard.donateCta': '💸 ถูกรางวัล? เลี้ยงกาแฟทีมงาน',
  'dashboard.donateSub': 'สนับสนุนนักพัฒนา',
  'dashboard.disclaimer':
    'ผลวิเคราะห์เป็นค่าประมาณทางสถิติจากข้อมูลย้อนหลัง ไม่มีแบบจำลองใดยืนยันผลลัพธ์ได้ — เล่นอย่างมีสติ',
  'dashboard.confidence': 'ความเชื่อมั่น {percent}',

  // Dashboard — states
  'dashboard.waking':
    'กำลังปลุกเซิร์ฟเวอร์… (เซิร์ฟเวอร์สลีปอยู่ อาจใช้เวลาถึง 1 นาที)',
  'dashboard.loadingPredictions': 'กำลังโหลดผลวิเคราะห์จากเซิร์ฟเวอร์…',
  'dashboard.connectFailed': 'โหลดข้อมูลไม่สำเร็จ',
  'dashboard.connectFailedBody':
    'บริการวิเคราะห์ไม่ตอบสนอง หากรันในเครื่อง ให้เริ่ม backend ที่ {url} ก่อน — uvicorn main:app --reload',
  'dashboard.emptyTitle': 'ยังไม่มีข้อมูลเพียงพอ',
  'dashboard.emptyBody':
    'ฐานข้อมูลมี {count} งวด ระบบจึงยังไม่สร้างอันดับ การจัดอันดับจากข้อมูลเท่านี้จะเป็นตัวเลขเดาสุ่ม และแอปไม่แสดงตัวเลขที่อ้างอิงไม่ได้',
  'dashboard.live': 'ออนไลน์',
  'dashboard.offline': 'ออฟไลน์',
  'dashboard.connecting': 'กำลังเชื่อมต่อ',
  'dashboard.wakingLabel': 'กำลังปลุกเซิร์ฟเวอร์',
  // The endpoint's `status` values, as words.
  'status.ok': 'ปกติ',
  'status.limited': 'จำกัด',
  'status.insufficientData': 'ไม่มีข้อมูล',

  // Premium
  'premium.title': 'ข้อมูลเชิงลึก Premium',
  // ชื่อประเทศ ไม่ใช้ตัวย่อ: "TH/LA/VN" จะไปซ้ำกับปุ่มสลับภาษา TH/EN ที่หัวแอป
  // ซึ่งคนละความหมายกันโดยสิ้นเชิง
  'premium.lotteryThai': 'ไทย',
  'premium.lotteryLaos': 'ลาว',
  'premium.lotteryVietnam': 'เวียดนาม',
  'premium.lotteryFilter': 'เลือกหวยที่ต้องการวิเคราะห์',
  'premium.lotteryMismatch':
    'บริการตอบกลับด้วยหวยคนละประเภทกับที่เลือก — ตัวกรองประเภทหวยยังไม่ทำงานบนเซิร์ฟเวอร์ ตัวเลขที่แสดงจึงไม่ใช่ของหวยที่เลือกไว้',
  'premium.subtitle': 'แบบจำลองเบย์เซียนรายตำแหน่ง · รางวัลที่ 1',
  'premium.modePill': '✨ โหมด Premium',
  'premium.loginPill': '🔒 เข้าสู่ระบบ Premium',
  'premium.unlockHint': 'เปิดแบบฟอร์มเข้าสู่ระบบ Premium (ต้องใช้รหัสผ่าน)',
  'premium.analysisLoading': 'กำลังโหลดการวิเคราะห์รายตำแหน่ง…',
  'premium.analysisWaking':
    'กำลังปลุกเซิร์ฟเวอร์… (เซิร์ฟเวอร์สลีปอยู่ อาจใช้เวลาถึง 1 นาที)',
  'premium.loadFailed': 'โหลดข้อมูลเชิงลึก Premium ไม่สำเร็จ',
  'premium.unknownError': 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ',
  'premium.emptyState':
    'ยังมีข้อมูลไม่พอสำหรับการวิเคราะห์รายตำแหน่ง — ต้องมีประวัติการออกรางวัลอย่างน้อย 5 งวด',
  'premium.downloading': 'กำลังดาวน์โหลด…',
  'premium.railTitle': 'Premium',
  'premium.railSubtitle': 'เข้าสู่ระบบเพื่อเปิดแบบจำลองรายตำแหน่ง',
  'premium.username': 'ชื่อผู้ใช้',
  'premium.password': 'รหัสผ่าน',
  'premium.signIn': 'เข้าสู่ระบบ',
  'premium.signOut': '🔒 ล็อกโหมด Premium',
  'premium.accessTitle': 'สิทธิ์การเข้าถึง Premium',
  'premium.accessSubtitle':
    'โหมด Premium สำหรับทดสอบเบต้า — เข้าสู่ระบบเพื่อดูการวิเคราะห์รายตำแหน่ง',
  'premium.lockedPill': '🔒 Premium',
  'premium.wrongCredentials': 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  'premium.gateNote':
    'ประตูทดลองสำหรับแผง Premium ไม่ใช่ระบบรักษาความปลอดภัยบัญชี ตัวเลขมาจาก endpoint สาธารณะ จึงควรถือเป็นข้อมูลสาธารณะ',
  'premium.lockedTitle': 'ล็อกอยู่',
  'premium.lockedCta': 'ปลดล็อกเพื่อดูการวิเคราะห์',
  'premium.unlockWithPremium': '{title} — ปลดล็อกด้วย Premium',
  'premium.openSignInForm': 'เปิดแบบฟอร์มเข้าสู่ระบบ Premium',
  'premium.basisConditional': 'มีเงื่อนไข',
  'premium.basisMarginal': 'ส่วนขอบ',
  'premium.basisThinRow': 'ตัวอย่างน้อย',
  'premium.leadingDigit': 'หลักนำ · ใช้ส่วนขอบ',
  'premium.marginalOnly': 'ใช้ส่วนขอบเท่านั้น',
  'premium.givenState': 'เมื่อ {position} = {digit}',
  'premium.positionHundredThousands': 'หลักแสน',
  'premium.positionTenThousands': 'หลักหมื่น',
  'premium.positionThousands': 'หลักพัน',
  'premium.positionHundreds': 'หลักร้อย',
  'premium.positionTens': 'หลักสิบ',
  'premium.positionUnits': 'หลักหน่วย',
  'premium.vsMarginal': 'x{lift} เทียบส่วนขอบ · {count}/{support}',
  'premium.metaRow': '{count} งวด · ล่าสุด {prize} ({date})',
  'premium.thinRowPillHint':
    'สถานะที่ใช้เงื่อนไขของหลักนี้มีงวดในอดีตน้อยเกินไป จึงถอยไปใช้ความน่าจะเป็นส่วนขอบ',

  // Paywall (/premium) — the marketing copy the Founder supplied, now keyed per
  // language instead of a Thai headline with an English parenthetical under it.
  'paywall.eyebrow': 'สมาชิก Premium',
  'paywall.title': 'ปลดล็อกความแม่นยำขั้นสุด!',
  'paywall.features':
    'รับการวิเคราะห์เจาะลึกเลข 3 ตัว และเลข 6 ตัว (รางวัลที่ 1) ด้วยโมเดล AI ระดับสูง',
  'paywall.comingSoonPill': '🔒 เร็วๆ นี้',
  'paywall.comingSoon': 'ฟีเจอร์นี้กำลังเปิดให้บริการเร็วๆ นี้ (Coming Soon)',
  'paywall.benefitsTitle': 'สิ่งที่คุณจะได้รับ',
  'paywall.benefit1': 'เลข 3 ตัว (3-Digit) — อันดับและคะแนน Heng รายตำแหน่ง',
  'paywall.benefit2': 'เลข 6 ตัว (รางวัลที่ 1) — เปิดให้บริการเมื่อโมเดลขั้นสูงพร้อมใช้งาน',
  'paywall.benefit3': 'ประวัติการวิเคราะห์ย้อนหลังแบบเต็ม ไม่จำกัดการเรียกดู',
  'paywall.price': 'เพียง 99 บาท/เดือน',
  'paywall.priceSub': 'ยกเลิกได้ตลอดเวลา · ชำระด้วยบัตรเครดิต',
  'paywall.subscribe': 'สมัครเลย',
  'paywall.subscribeHint': 'สมัครสมาชิก (ยังไม่เปิดให้บริการ)',
  'paywall.noCharge': 'ยังไม่มีค่าใช้จ่ายใดๆ ในขณะนี้ — การกดสมัครจะยังไม่ถูกเรียกเก็บเงิน',
  'paywall.dismiss': 'ไว้ก่อน — กลับไปหน้าหลัก',
  'paywall.dismissHint': 'ย้อนกลับ',
  'paywall.disclaimer':
    'การวิเคราะห์ทั้งหมดเป็นค่าประมาณทางสถิติจากข้อมูลย้อนหลัง ไม่มีโมเดลใดรับประกันผลรางวัลได้',

  // Models
  'models.frequency': 'ความถี่',
  'models.markov': 'มาร์คอฟ',
  'models.timeseries': 'ARIMA',
  'models.montecarlo': 'มอนติคาร์โล',
  'models.frequencyShort': 'ความถี่',
  'models.markovShort': 'มาร์คอฟ',
  'models.timeseriesShort': 'ARIMA',
  'models.montecarloShort': 'MC',
  'models.lstm': 'LSTM',
  'models.detailTimeseries': 'แนวโน้มอนุกรมเวลา',
  'models.detailMontecarlo': 'จำลอง 10,000 รอบ',
  'models.detailLstm': 'โครงข่ายลำดับ',
  'models.planned': '{detail} · วางแผนไว้',
  'models.applied': 'ใช้จริง',
  'models.weightedZero': 'น้ำหนักศูนย์',
  'models.insufficientSupport': 'ข้อมูลไม่พอ',
  'models.notInBlend': 'ไม่อยู่ในผลรวม',
  'models.noObservedTransition': 'ไม่พบรูปแบบ',
  'models.noArimaFit': 'ไม่พบรูปแบบ',
  'models.notReported': 'ไม่มีรายงาน',
  'models.neutral': 'เป็นกลาง',
  'models.skipped': 'ข้าม',
  'models.stateActive': 'ใช้งาน',
  'models.stateNeutral': 'เป็นกลาง',
  'models.neutralReason': 'เป็นกลาง, {reason}',
  'models.activeTag': '{label} · น้ำหนัก {percent}%',
  'models.neutralTag': '{label} · {reason}',
  'models.chipA11y': '{label}: {state} {detail}',
  'models.collapsedHint': 'แตะป้ายแบบจำลองเพื่อดูเหตุผลที่ใช้หรือข้าม',

  // Signal tones
  'tone.high': 'สัญญาณชัดเจน',
  'tone.medium': 'สัญญาณเชิงบวก',
  'tone.low': 'สัญญาณอ่อน',
  'tone.cold': 'ไม่พบสัญญาณที่มีนัย',

  // Ranking rows
  'rank.meta': 'คะแนนเฮง {score} · {seen}',
  'rank.uniformLift': '{lift}× อัตราฐาน',

  // Other screens
  'insights.trendTitle': 'แนวโน้ม',
  'insights.trendSubtitle': 'สัดส่วนเลขคู่และเลขสูงตามช่วงเวลา',
  'insights.parity': 'คู่ / คี่',
  'insights.range': 'สูง / ต่ำ',
  'insights.heatmapTitle': 'แผนความถี่',
  'insights.heatmapSubtitle': 'ทุกเลข 2 หลัก · สีเข้มคือออกบ่อยกว่า',
  'insights.aiLogTitle': 'บันทึก AI',
  'insights.logGenerated': 'สร้างบันทึกเมื่อ {date} · อัปเดตทุกงวด',
  'insights.odd': 'คี่ %',
  'insights.high': 'สูง (5–9) %',

  'myNumber.title': 'ตรวจเลข',
  'myNumber.subtitle': 'พิมพ์เลข 2 หลักเพื่อดูว่าแบบจำลองว่าอย่างไร',
  'myNumber.inputLabel': 'เลข 2 หลัก',
  'myNumber.inputHint': 'กรอกตัวเลขระหว่าง 00 ถึง 99',
  'myNumber.invalid': 'ไม่ใช่เลข 2 หลัก',
  'myNumber.notFound': 'ไม่พบเลขนี้ในงวดล่าสุด',
  'myNumber.lastWon': 'ออกล่าสุด {date}',
  'myNumber.noRecent': 'ยังไม่เคยออกล่าสุด',

  'performance.hitRate': 'อัตราทายถูก',
  'performance.top5Rate': 'อัตราติด 5 อันดับ',
  'performance.prizeChecker': 'ตรวจรางวัล',
  'performance.latestResult': 'ผลล่าสุด · {date}',
  'performance.historyTitle': 'งวดล่าสุด',
  'performance.disclaimer': 'ผลในอดีตไม่ทำนายงวดถัดไป ทุกงวดเป็นอิสระต่อกัน',

  // About (/about)
  'about.eyebrow': 'วิธีการทำงาน',
  'about.title': 'เบื้องหลังการคำนวณความน่าจะเป็น',
  'about.intro':
    'เราใช้ข้อมูลสถิติผลการออกรางวัลย้อนหลังจาก "สำนักงานสลากกินแบ่งรัฐบาล (GLO)" มาประมวลผลผ่านโมเดลคณิตศาสตร์และ AI ขั้นสูง ดังนี้:',
  'about.modelTimeseriesName': 'อนุกรมเวลา (ARIMA & Prophet)',
  'about.modelTimeseriesBody':
    'วิเคราะห์ความสัมพันธ์ของตัวเลขตามเวลา และจับ "ฤดูกาล" เช่น เลขที่มักออกบ่อยในช่วงเดือนหรือวันหยุดนี้',
  'about.modelMarkovName': 'ลูกโซ่มาร์คอฟ',
  'about.modelMarkovBody':
    'สร้างตารางความน่าจะเป็น เพื่อดูว่าถ้างวดที่แล้วออกเลขนี้ โอกาสงวดถัดไปจะเปลี่ยนสถานะไปที่เลขกลุ่มใดมากที่สุด',
  'about.modelMontecarloName': 'การจำลองมอนติคาร์โล',
  'about.modelMontecarloBody':
    'ให้คอมพิวเตอร์จำลองการสุ่มออกรางวัลล่วงหน้านับแสนครั้ง โดยอิงน้ำหนักจากสถิติ 20 ปี เลขที่ชนะบ่อยที่สุดจะได้รับคะแนนสูงสุด',
  'about.modelLstmName': 'ดีปเลิร์นนิง (LSTM)',
  'about.modelLstmBody':
    'ใช้โครงข่ายประสาทเทียมเรียนรู้แพทเทิร์นที่ซับซ้อนเกินกว่ามนุษย์จะมองเห็น เช่น ความเชื่อมโยงระหว่างรางวัลที่ 1 และเลขท้าย 2 ตัวในอดีต',
  'about.disclaimer':
    'คำเตือน: ข้อมูลและคะแนนในแอปพลิเคชันเป็นการวิเคราะห์เชิงสถิติจากข้อมูลย้อนหลัง ไม่ใช่การรับประกันผลการออกรางวัล',
  'about.copyright':
    '© 2026 SuperHeng. All Rights Reserved. ห้ามคัดลอก ดัดแปลง หรือทำซ้ำอัลกอริทึมและข้อมูลโดยเด็ดขาด',

  // Donate (/donate)
  'donate.eyebrow': 'สนับสนุนนักพัฒนา',
  'donate.title': 'สนับสนุนนักพัฒนา',
  'donate.subtitle': 'ขอบคุณสำหรับการสนับสนุน',
  'donate.thanks':
    'ทุกการสนับสนุนของท่านช่วยให้ทีมงานพัฒนาระบบวิเคราะห์ และปรับปรุงโมเดลให้ดียิ่งขึ้น ขอบคุณจากใจจริง 🙏',
  'donate.qrCaption': 'สแกน QR เพื่อเลี้ยงกาแฟทีมงาน',
  'donate.qrA11y': 'QR code สำหรับสนับสนุนนักพัฒนา',
  'donate.note': 'การสนับสนุนเป็นไปโดยความสมัครใจ และไม่มีผลต่อผลการออกรางวัลหรือคะแนน Heng Score',
};
