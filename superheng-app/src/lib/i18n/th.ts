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

  // ข้อผิดพลาดจากการเรียก API: ข้อความดิบใน ApiError เป็นภาษาอังกฤษสำหรับนักพัฒนา
  // ส่วนที่ผู้ใช้เห็นคือชุดคำด้านล่าง โดยคงรหัส HTTP ไว้เพราะเป็นข้อมูลชิ้นเดียวที่
  // ผู้ดูแลระบบต้องใช้ และไม่ขึ้นกับภาษา
  'apiError.network': 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
  'apiError.timeout': 'เซิร์ฟเวอร์ไม่ตอบสนองในเวลาที่กำหนด กรุณาลองใหม่',
  'apiError.unauthorized': 'เซสชันนี้ใช้ไม่ได้แล้ว ({status}) กรุณาเข้าสู่ระบบใหม่',
  'apiError.forbidden': 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงข้อมูลนี้ ({status})',
  'apiError.server': 'เซิร์ฟเวอร์รายงานข้อผิดพลาด ({status}) กรุณาลองใหม่ภายหลัง',
  'apiError.unexpected': 'คำขอล้มเหลว ({status}) กรุณาลองใหม่ภายหลัง',
  'apiError.malformed': 'เซิร์ฟเวอร์ส่งข้อมูลที่แอปอ่านไม่ได้',

  // Navigation + headers
  'nav.dashboard': 'หน้าหลัก',
  'nav.myNumber': 'เลขของฉัน',
  'nav.insights': 'เจาะลึก',
  'nav.performance': 'ความแม่นยำ',
  'nav.backtest': 'ทดสอบย้อนหลัง',

  'header.dashboardSubtitle': 'วิเคราะห์ความน่าจะเป็น',
  'header.insightsSubtitle': 'เจาะลึกสถิติ',
  'header.myNumberSubtitle': 'วิเคราะห์เลขใดก็ได้',
  'header.performanceSubtitle': 'ผลงานและความโปร่งใส',
  'header.backtestSubtitle': 'พิสูจน์ได้ ไม่ใช่แค่คำโฆษณา',
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
  'premium.unlockHint': 'เปิดแบบฟอร์มเข้าสู่ระบบ Premium',
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
  'premium.signOut': 'ออกจากระบบ',
  'premium.accessTitle': 'สิทธิ์การเข้าถึง Premium',
  'premium.accessSubtitle':
    'เข้าสู่ระบบเพื่อสมัครสมาชิก หรือเพื่อเปิดการวิเคราะห์ที่คุณชำระเงินไว้แล้ว',

  // --- บัญชี (แทนประตูรหัสผ่านเดิม) ---------------------------------------
  'premium.modeSignIn': 'เข้าสู่ระบบ',
  'premium.modeRegister': 'สมัครสมาชิก',
  'premium.email': 'อีเมล',
  'premium.newPassword': 'รหัสผ่าน',
  'premium.passwordHint': 'อย่างน้อย 6 ตัวอักษร',
  'premium.checkEmail':
    'สร้างบัญชีแล้ว กรุณาตรวจสอบอีเมลเพื่อยืนยันที่อยู่ แล้วเข้าสู่ระบบอีกครั้ง',
  'premium.signedInAs': 'เข้าสู่ระบบในชื่อ {email}',
  'premium.activeUntil': 'ใช้งานได้ถึง {date}',

  // --- สถานะสมาชิก ------------------------------------------------------------
  // "หมดอายุ" กับ "ยังไม่เคยสมัคร" เป็นคำขอที่ต่างกัน (ต่ออายุ กับ สมัคร) จึงใช้
  // คำคนละชุด ไม่รวมเป็น "ใช้งานไม่ได้" คำเดียว
  'premium.noSubscriptionTitle': 'ยังไม่มีสมาชิกที่ใช้งานได้',
  'premium.noSubscriptionBody':
    'บัญชีนี้เข้าสู่ระบบแล้วแต่ยังไม่มีสมาชิก Premium ที่ใช้งานได้ การวิเคราะห์รายตำแหน่งจะถูกล็อกไว้จนกว่าจะมี',
  'premium.lapsedTitle': 'สมาชิกหมดอายุแล้ว',
  'premium.lapsedBody':
    'สมาชิก Premium ของบัญชีนี้สิ้นสุดลงแล้ว ต่ออายุเพื่อเปิดการวิเคราะห์รายตำแหน่งอีกครั้ง',
  'premium.planTitle': 'เลือกแพ็กเกจ',
  'premium.perMonth': 'เดือน',
  'premium.perYear': 'ปี',
  'premium.checkout': 'อัปเกรด',
  'premium.checkoutFor': '{plan} — {price}',
  'premium.checkoutMethods': 'บัตร หรือ พร้อมเพย์',
  'premium.upgradeCta': 'อัปเกรดเป็น Premium (บัตร · พร้อมเพย์)',
  'premium.upgradeCtaComingSoon': 'อัปเกรดเป็น Premium',
  'premium.checkoutUnavailable':
    'ยังไม่เปิดรับชำระเงิน ยังไม่มีการเรียกเก็บเงินและยังไม่มีการเริ่มสมาชิก ปุ่มนี้เชื่อมต่อกับปลายทางจริงแล้ว และจะใช้งานได้ทันทีเมื่อเชื่อมต่อผู้ให้บริการชำระเงิน',
  'premium.checkoutCharged':
    'ผู้ให้บริการชำระเงินยอมรับรายการนี้แล้ว สมาชิกของคุณจะปรากฏที่นี่เมื่อเซิร์ฟเวอร์ได้รับการยืนยัน',
  'premium.checkoutOpening': 'กำลังเปิดหน้าชำระเงินที่ปลอดภัยของ Stripe…',
  'premium.checkoutCreated':
    'กำลังเปิดหน้าชำระเงินที่ปลอดภัยของ Stripe ยังไม่มีการเรียกเก็บเงิน — สมาชิกของคุณจะเริ่มเมื่อ Stripe ยืนยันการชำระเงิน ไม่ใช่เมื่อกลับมาที่หน้านี้',
  'premium.checkoutRedirectFailed':
    'Stripe สร้างหน้าชำระเงินแล้ว แต่อุปกรณ์นี้เปิดหน้านั้นไม่ได้ ยังไม่มีการเรียกเก็บเงิน — หากเปิดตัวบล็อกป๊อปอัปอยู่ กรุณาอนุญาตเว็บไซต์นี้แล้วลองใหม่',
  'premium.alreadyPremium': 'บัญชีนี้มีสมาชิก Premium ที่ใช้งานได้อยู่แล้ว',
  'premium.accountUnreadable':
    'เข้าสู่ระบบแล้ว แต่ตรวจสอบสถานะสมาชิกไม่ได้ในขณะนี้ เป็นปัญหาของระบบ ไม่ใช่ข้อสรุปเกี่ยวกับบัญชีของคุณ',
  'premium.profileMissing':
    'ยังไม่มีข้อมูลโปรไฟล์สำหรับบัญชีนี้ จึงยังผูกสมาชิกกับบัญชีไม่ได้ ผู้ดูแลระบบต้องรัน backend/schema_profiles.sql',
  'premium.refusedHint':
    'เซิร์ฟเวอร์ปฏิเสธคำขอนี้ กรุณาเข้าสู่ระบบด้านล่าง หรือสมัครสมาชิกหากยังไม่ได้สมัคร — การลองใหม่จะไม่ได้คำตอบที่ต่างออกไป',
  'premium.notConfiguredTitle': 'บิลด์นี้ยังไม่ได้ตั้งค่าระบบบัญชี',
  'premium.notConfiguredBody':
    'บิลด์นี้ไม่มีการตั้งค่า Supabase จึงเข้าสู่ระบบไม่ได้ ส่วนแดชบอร์ด ผลรางวัล และการทดสอบย้อนหลังยังใช้งานได้ตามปกติ',

  // --- ข้อผิดพลาดในการเข้าสู่ระบบ ------------------------------------------
  'premium.authError.unconfigured': 'บิลด์นี้ไม่มีการตั้งค่าระบบบัญชี',
  'premium.authError.invalidCredentials': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'premium.authError.emailNotConfirmed':
    'ที่อยู่นี้ยังไม่ได้รับการยืนยัน กรุณาตรวจสอบอีเมลเพื่อกดลิงก์ยืนยัน',
  'premium.authError.alreadyRegistered': 'มีบัญชีที่ใช้ที่อยู่นี้อยู่แล้ว กรุณาเข้าสู่ระบบแทน',
  'premium.authError.weakPassword': 'รหัสผ่านสั้นเกินไป ต้องมีอย่างน้อย 6 ตัวอักษร',
  'premium.authError.rateLimited': 'พยายามหลายครั้งเกินไปในขณะนี้ กรุณารอสักครู่แล้วลองใหม่',
  'premium.authError.invalidEmail': 'กรุณากรอกอีเมลและรหัสผ่านให้ถูกต้อง',
  'premium.authError.network': 'เชื่อมต่อระบบบัญชีไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่',
  'premium.authError.unknown': 'เข้าสู่ระบบไม่สำเร็จ',
  // คุณค่าที่แสดงบนการ์ดล็อก เหนือช่องรหัสผ่าน — ชื่อโมเดลคงไว้เป็น Latin
  // ตามตารางคำศัพท์ในหัวไฟล์ (ARIMA, Markov, Bayesian) เพราะทับศัพท์แล้วจำยากกว่า
  'premium.benefitsTitle': 'สิทธิประโยชน์ Premium',
  'premium.valueMarkets': 'ปลดล็อกครบ 3 ตลาด (ไทย, ลาว, ฮานอย)',
  'premium.valueModels': 'ดูการวิเคราะห์เชิงลึก AI ครบ 4 โมเดล (ARIMA, Markov, Bayesian, Frequency)',
  'premium.valuePositions': 'เจาะจงความน่าจะเป็นรายตำแหน่ง (หลักแสนถึงหลักหน่วย)',
  'premium.valueRealtime': 'อัปเดตผลและเทรนด์แบบ Real-time',
  'premium.lockedPill': '🔒 Premium',
  'premium.gateNote':
    'บัญชีของคุณใช้เพียงเพื่อตรวจสอบสถานะสมาชิกเท่านั้น แดชบอร์ด ผลรางวัล และการทดสอบย้อนหลังยังฟรีและไม่ต้องใช้บัญชี',
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
  // --- ความแม่นยำงวดล่าสุด (ตรวจการบ้าน AI) ---------------------------------
  // ชื่อสองหน้าของปุ่มสลับมุมมองในการ์ด Premium — สั้น เพราะอยู่ข้าง ๆ ปุ่มเลือก
  // ประเทศที่ใช้คอนโทรลตัวเดียวกัน
  'premium.viewAnalysis': 'การวิเคราะห์',
  'premium.viewAccuracy': 'ความแม่นยำงวดล่าสุด',
  'premium.viewFilter': 'มุมมองการวิเคราะห์ หรือความแม่นยำงวดล่าสุด',
  'premium.accuracy.title': 'ความแม่นยำงวดล่าสุด',
  'premium.accuracy.subtitle': 'คำทำนายของโมเดลในแต่ละงวด เทียบกับผลรางวัลที่ออกจริง',
  // บอกก่อนตัวเลข ไม่ใช่ต่อท้าย: ระบบไม่ได้บันทึกคำทำนายไว้ จึงต้องพูดให้ชัดว่า
  // ที่เห็นคือการคำนวณย้อนหลัง
  'premium.accuracy.replayTitle': 'คำนวณย้อนหลัง ไม่ใช่คำทำนายที่บันทึกไว้',
  'premium.accuracy.replayBody':
    'ระบบไม่ได้บันทึกคำทำนายไว้ตอนที่คำนวณ จึงคำนวณคำทำนายของแต่ละงวดใหม่โดยใช้เฉพาะงวดที่เกิดก่อนหน้านั้นเท่านั้น ผลที่ได้จึงเทียบเท่ากับสิ่งที่โมเดลน่าจะตอบ แต่ไม่ใช่หลักฐานว่าได้รันจริงตอนนั้น',
  'premium.accuracy.loading': 'กำลังโหลดรายงานความแม่นยำ…',
  'premium.accuracy.loadFailed': 'โหลดรายงานความแม่นยำไม่สำเร็จ',
  'premium.accuracy.empty':
    'ยังไม่มีงวดใดที่มีประวัติย้อนหลังเพียงพอสำหรับสร้างคำทำนาย',
  'premium.accuracy.latestDraw': 'งวดล่าสุด',
  'premium.accuracy.aiPredicted': 'AI ทำนาย',
  'premium.accuracy.actualResult': 'ผลที่ออกจริง',
  'premium.accuracy.hit': 'ถูก',
  'premium.accuracy.miss': 'ไม่ถูก',
  'premium.accuracy.nearMiss': 'ติด 3 อันดับ',
  'premium.accuracy.rankOf': 'อันดับ {rank}',
  'premium.accuracy.positionsHit': 'ถูก {hits}/{total} ตำแหน่ง',
  'premium.accuracy.trainedOn': 'เทรนจาก {count} งวด',
  'premium.accuracy.overWindow': 'จาก {draws} งวดล่าสุด',
  'premium.accuracy.hitRate': 'อัตราถูก {rate} เทียบฐาน {baseline}',
  'premium.accuracy.pValue': 'p = {p}',
  'premium.accuracy.significant': 'ดีกว่าการเดาในตัวอย่างนี้',
  'premium.accuracy.notSignificant': 'ยังแยกจากการเดาไม่ได้ที่ขนาดตัวอย่างนี้',
  'premium.accuracy.channels': 'รางวัลเลขท้าย 2 ตัว',
  'premium.accuracy.channelTop': 'สองตัวท้ายรางวัลที่ 1',
  'premium.accuracy.channelBottom': 'เลขท้าย 2 ตัว',
  'premium.accuracy.exact': 'ตรงตัว',
  'premium.accuracy.inTop5': 'อยู่ใน 5 อันดับ',
  'premium.accuracy.recentDraws': 'งวดที่เทียบ',
  'premium.accuracy.limitsTitle': 'สิ่งที่รายงานนี้ยังยืนยันไม่ได้',
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
  'paywall.livePill': 'บัตร · พร้อมเพย์',
  'paywall.authTitle': 'เข้าสู่ระบบ หรือ สมัครสมาชิก',
  'paywall.authBody':
    'สมาชิกผูกกับบัญชีผู้ใช้ กรุณาเข้าสู่ระบบ หรือสมัครสมาชิกใหม่ — ราคาและช่องทางชำระเงินเหมือนกันทั้งสองทาง',
  'paywall.signInRequired':
    'กรุณาเข้าสู่ระบบหรือสมัครสมาชิกด้านบนก่อน แล้วปุ่มนี้จะเปิดขั้นตอนชำระเงิน',
  'paywall.checkoutUnavailable':
    'ยังไม่เปิดรับชำระเงิน จึงยังไม่มีการเรียกเก็บเงินและยังไม่มีการเริ่มสมาชิก ดูสถานะทั้งหมดได้ที่การ์ด Premium บนแดชบอร์ด',
  'paywall.checkoutFailed':
    'เริ่มขั้นตอนชำระเงินไม่สำเร็จ ยังไม่มีการเรียกเก็บเงิน กรุณาลองใหม่อีกครั้ง',
  'paywall.checkoutRedirectFailed':
    'Stripe สร้างหน้าชำระเงินแล้ว แต่อุปกรณ์นี้เปิดหน้านั้นไม่ได้ ยังไม่มีการเรียกเก็บเงิน — หากเปิดตัวบล็อกป๊อปอัปอยู่ กรุณาอนุญาตเว็บไซต์นี้แล้วลองใหม่',
  'paywall.paymentReturning':
    'Stripe กำลังยืนยันการชำระเงินของคุณ หน้านี้จะอัปเดตเองโดยอัตโนมัติ ปกติใช้เวลาไม่กี่วินาที',
  'paywall.paymentCancelled': 'ยกเลิกการชำระเงินแล้ว ยังไม่มีการเรียกเก็บเงิน',
  'paywall.methodsTitle': 'ช่องทางชำระเงิน',
  'paywall.methodsCard': 'บัตรเครดิตหรือบัตรเดบิต — Visa, Mastercard, JCB, Amex',
  'paywall.methodsPromptPay': 'พร้อมเพย์ (QR) — สแกนด้วยแอปธนาคารไทย',
  'paywall.benefitsTitle': 'สิ่งที่คุณจะได้รับ',
  'paywall.benefit1': 'เลข 3 ตัว (3-Digit) — อันดับและคะแนน Heng รายตำแหน่ง',
  'paywall.benefit2': 'เลข 6 ตัว (รางวัลที่ 1) — เปิดให้บริการเมื่อโมเดลขั้นสูงพร้อมใช้งาน',
  'paywall.benefit3': 'ประวัติการวิเคราะห์ย้อนหลังแบบเต็ม ไม่จำกัดการเรียกดู',
  'paywall.price': 'เพียง 99 บาท/เดือน',
  'paywall.priceSub': 'ชำระครั้งเดียว · ใช้งาน 30 วัน',
  'paywall.subscribe': 'อัปเกรดด้วยบัตรหรือพร้อมเพย์',
  'paywall.subscribeHint': 'อัปเกรดด้วยบัตรเครดิตหรือพร้อมเพย์',
  'paywall.subscribeComingSoon': 'สมัครสมาชิก',
  'paywall.subscribeComingSoonHint': 'สมัครสมาชิก (ยังไม่เปิดให้บริการ)',
  'paywall.noCharge':
    'ยังไม่มีการเรียกเก็บเงิน จนกว่าคุณจะชำระเงินเสร็จสิ้นบนหน้าของ Stripe',
  'paywall.noChargeComingSoon':
    'ยังไม่มีค่าใช้จ่ายใดๆ ในขณะนี้ — การกดสมัครจะยังไม่ถูกเรียกเก็บเงิน',
  'paywall.dismiss': 'ไว้ก่อน — กลับไปหน้าหลัก',
  'paywall.dismissHint': 'ย้อนกลับ',
  'paywall.disclaimer':
    'การวิเคราะห์ทั้งหมดเป็นค่าประมาณทางสถิติจากข้อมูลย้อนหลัง ไม่มีโมเดลใดรับประกันผลรางวัลได้',

  // Backtest — หน้านี้มีไว้ให้ “เชื่อได้” คำจึงต้องไม่ปัดผลที่ยังสรุปไม่ได้ให้กลายเป็น
  // ชัยชนะ: "ยังพิสูจน์ไม่ได้" ไม่ใช่ "ไม่เก่ง" และทุกอัตราต้องมีอัตราฐานกำกับข้างๆ เสมอ
  // เพราะอัตราทายถูกที่ลอยอยู่เดี่ยวๆ คือสิ่งที่หน้านี้ตั้งใจไม่ทำ
  'backtest.title': 'ทดสอบย้อนหลัง',
  'backtest.subtitle': 'ทดสอบทุกโมเดลกับงวดที่ยังไม่เคยเห็น',
  'backtest.windowDraws': 'ล่าสุด {count}',
  'backtest.loading': 'กำลังทดสอบย้อนหลัง {count} งวด โดยแต่ละงวดใช้เฉพาะข้อมูลก่อนหน้านั้น…',
  'backtest.waking': 'กำลังปลุกเซิร์ฟเวอร์… (เครื่องฟรีจะหลับ และอาจใช้เวลาถึงหนึ่งนาที)',
  'backtest.loadFailed': 'โหลดผลทดสอบย้อนหลังไม่สำเร็จ',
  'backtest.ledgerMismatch':
    'บริการตอบกลับด้วยหวยคนละประเภทกับที่เลือก ตัวเลขที่แสดงจึงไม่ใช่ของหวยที่เลือกไว้',
  'backtest.sampleLine': 'ทดสอบ {done} จาก {requested} งวด · {from}–{to}',
  'backtest.channelUnavailable':
    'หวยนี้ทดสอบเกม 2 ตัวย้อนหลังไม่ได้ เพราะรางวัลที่ 1 มี 5 หลัก จึงไม่มีหลัก 2 ตัวท้ายให้เทียบ ส่วนโมเดลรายตำแหน่งด้านล่างไม่ได้รับผลกระทบ',

  // คำตัดสิน
  'backtest.significant': 'สูงกว่าการเดา',
  'backtest.noEdge': 'ยังพิสูจน์ไม่ได้',
  'backtest.notSignificant': 'ไม่มีนัยสำคัญ',
  'backtest.pValue': 'p = {p} · n = {count}',
  'backtest.pShort': 'p {p}',
  'backtest.testPositional': 'ความแม่นยำรายตำแหน่ง',
  'backtest.testTop5': 'อัตราถูกใน {count} อันดับสูงสุด',
  'backtest.verdictSource': 'จาก{test} · ทดสอบนัยสำคัญ {count} รายการ',
  'backtest.verdictSignificantTitle': 'โมเดลทำได้ดีกว่าการเดาในงวดชุดนี้',
  'backtest.verdictChanceTitle': 'ยังแยกจากความบังเอิญไม่ได้',
  'backtest.verdictSignificantBody':
    'ผลนี้ผ่านเกณฑ์ 0.05 ในงวดชุดนี้ ถือเป็นหลักฐานว่าโมเดลจับได้บางอย่างจริง ไม่ใช่หลักประกันว่าจะทำได้ต่อเนื่อง และไม่ได้รับประกันรางวัลใดๆ',
  'backtest.verdictChanceBody':
    'ผลที่ใกล้เคียงอัตราฐานขนาดนี้เกิดขึ้นจากความบังเอิญได้บ่อยพอที่งวดชุดนี้จะยังสรุปว่าได้เปรียบไม่ได้ แอปจึงไม่สรุปเช่นนั้น ต้องมีงวดมากขึ้นก่อนจึงจะพูดเป็นอย่างอื่นได้',
  'backtest.verdictEmptyTitle': 'ข้อมูลย้อนหลังไม่พอยืนยัน',
  'backtest.verdictEmptyBody':
    'งวดในระบบน้อยเกินกว่าจะทดสอบได้ จึงไม่มีการสรุปความแม่นยำ จำนวนงวดและเหตุผลอยู่ในหมายเหตุด้านล่าง',

  // ตัวเลขหลัก
  'backtest.metricWinRate': 'อัตราทายถูก',
  'backtest.metricTop5': 'อัตราถูกใน 5 อันดับ',
  'backtest.metricRoi': 'ผลตอบแทน (ROI)',
  'backtest.metricBreakEven': 'จุดคุ้มทุน',
  'backtest.breakEvenHint': 'อัตราทายถูกที่ต้องได้จึงจะกำไร',
  'backtest.metricDigitAccuracy': 'ความแม่นยำรายหลัก',
  'backtest.metricPredictions': 'จำนวนการทาย',
  'backtest.metricPValue': 'ค่า p',
  'backtest.metricHitsNeeded': 'จำนวนที่ต้องถูก',
  'backtest.metricHitsNeededHint': 'จึงจะมีนัยสำคัญ',
  'backtest.vsUniformHint': 'อัตราฐาน {uniform} · สุ่ม {random}',
  'backtest.vsUniformSimple': 'อัตราฐาน {uniform}',
  'backtest.roiHint': 'จ่าย {payout} เท่า · สุ่ม {random}',
  'backtest.drawsHint': '{count} งวด',
  'backtest.channelLine': 'ช่อง{channel} · {draws} งวด',
  'backtest.hitsNeededLine': 'ต้องถูก {count} ครั้งจึงมีนัยสำคัญ',
  'backtest.positionCount': '{hits}/{total}',

  // กราฟ
  'backtest.aiLabel': 'AI',
  'backtest.randomLabel': 'สุ่ม',
  'backtest.uniformLabel': 'อัตราฐาน',
  'backtest.zeroLine': 'จุดคุ้มทุน',
  'backtest.rateChartTitle': 'อัตราถูกใน 5 อันดับ (สะสม)',
  'backtest.rateChartSubtitle': 'สะสมไปเรื่อยๆ งวดเดียวที่ฟลุ๊กจึงทำให้กราฟพุ่งไม่ได้',
  'backtest.bankrollTitle': 'เงินทุน เทียบเดิมพันต่อเดิมพัน',
  'backtest.bankrollSubtitle':
    'เดิมพัน 1 หน่วยที่เลขอันดับหนึ่งทุกงวด ช่องว่างระหว่างเส้นคือความได้เปรียบ',
  'backtest.bankrollAxis': 'ถึง {date}: AI {last} หน่วย, สุ่ม {random}',
  'backtest.roiTitle': 'ผลตอบแทนการลงทุนที่อัตราจ่าย {payout} เท่า',
  'backtest.roiSubtitle': 'เส้นกลางคือจุดคุ้มทุน · ต้องทายถูก {breakEven}%',
  'backtest.roiAxis': 'ขาดทุน −{lose}% ← 0 → กำไร +{win}%',
  'backtest.roiExactAi': 'AI · เลขอันดับหนึ่ง',
  'backtest.roiExactRandom': 'สุ่ม · เลขอันดับหนึ่ง',
  'backtest.roiCoverAi': 'AI · ทั้ง 5 เลข',
  'backtest.roiCoverRandom': 'สุ่ม · ทั้ง 5 เลข',

  // รายตำแหน่ง
  'backtest.positionalTitle': 'โมเดลรายตำแหน่ง (Premium)',
  'backtest.positionalSubtitle': 'ทายหนึ่งหลักต่อหนึ่งตำแหน่งต่อหนึ่งงวด · {count} การทาย',
  'backtest.positionChartTitle': 'ความแม่นยำรายหลัก (สะสม)',
  'backtest.positionChartSubtitle': 'เทียบอัตราฐาน 10%',
  'backtest.positionNote':
    'ขีดบนแท่งคืออัตราฐาน 10% ของตำแหน่งนั้น ซึ่งคืออัตราที่การเดาสุ่มจะได้ สีเขียวหมายความว่าผลของตำแหน่งนั้นผ่านเกณฑ์ 0.05 ในงวดชุดนี้',

  // หมายเหตุวิธีวัด
  'backtest.notesTitle': 'วิธีวัดผลนี้',
  'backtest.notesSubtitle': 'วิธีวัด ข้อสมมติ และสิ่งที่ไม่ได้ทดสอบ',
  'backtest.leakageTitle': 'ไม่มีการรั่วไหลของข้อมูล',
  'backtest.payoutTitle': 'ข้อสมมติเรื่องอัตราจ่าย',
  'backtest.methodTitle': 'วิธีการ',
  'backtest.excludedTitle': 'ไม่ได้ทดสอบในหน้านี้',
  'backtest.disclaimer':
    'การทดสอบย้อนหลังเป็นการวัดอดีต ไม่ใช่การพยากรณ์อนาคต การชนะอัตราฐานในงวดเหล่านี้ไม่ได้บอกอะไรเกี่ยวกับงวดถัดไป เพราะการออกรางวัลที่เป็นธรรมย่อมเป็นอิสระจากงวดก่อนหน้าทั้งหมด',

  // การ์ดชวนอัปเกรด — ผลทดสอบชุดเดิม ย่อเหลือบรรทัดเดียวต่อตลาด
  'backtest.hookTitle': 'หลักฐาน พร้อมอัตราฐานกำกับทุกบรรทัด',
  'backtest.hookSubtitle': 'ทั้งสามตลาด ย้อนทดสอบด้วยงวดที่โมเดลยังไม่เคยเห็น',
  'backtest.hookPromise':
    'เราตีพิมพ์ทุกผลไว้ที่นี่ รวมถึงตลาดที่ไม่ได้ทำให้โมเดลดูดี อัตราทายถูกที่ลอยอยู่เดี่ยวๆ คือการตลาด เราจึงแสดงผลของผู้เล่นสุ่มที่ใช้เมล็ดเดียวกันกำกับไว้ทุกบรรทัด',
  'backtest.hookCaption':
    'แต่ละบรรทัดคืออัตราถูกใน {count} อันดับสูงสุด เทียบกับผู้เล่นสุ่มคนเดียวกัน และค่า p เทียบกับการเดา',
  'backtest.hookP': 'p',
  'backtest.hookDraws': '{done} จาก {requested} งวด',
  'backtest.hookMethod':
    'ไม่มีการรั่วไหลของข้อมูล แต่ละงวดพยากรณ์จากงวดก่อนหน้าเท่านั้น ในช่วงสั้นขนาดนี้ ค่า p ที่มากกว่า 0.05 แปลว่าแยกโมเดลออกจากการเดาไม่ได้ และการ์ดนี้ก็บอกตามนั้น ไม่ได้สื่อเป็นอย่างอื่น',
  'backtest.hookCta': 'ดูการย้อนทดสอบทั้งหมด',
  'backtest.hookCtaSub': 'ทุกงวด ทุกอัตราฐาน ทุกค่า p',
  'backtest.hookLoading': 'กำลังย้อนทดสอบทุกตลาด…',
  'backtest.hookFailed': 'โหลดผลการย้อนทดสอบไม่สำเร็จ',
  'backtest.hookNoChannel': 'ตลาดนี้ไม่เผยแพร่ช่องนี้',

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
  'insights.subtitle': 'เจาะลึกเชิงสถิติ',
  'insights.gridBadge': 'ตาราง 00–99',
  'insights.trendTitle': 'แนวโน้ม',
  'insights.trendSubtitle': 'สัดส่วนเลขคู่และเลขสูงตามช่วงเวลา',
  'insights.parity': 'คู่ / คี่',
  'insights.range': 'สูง / ต่ำ',
  'insights.heatmapTitle': 'แผนความถี่',
  'insights.heatmapSubtitle': 'ทุกเลข 2 หลัก · สีเข้มคือออกบ่อยกว่า',
  'insights.heatmapHint': 'แตะช่องเพื่อวิเคราะห์เลขนั้น',
  'insights.legendLow': 'ต่ำ',
  'insights.legendHigh': 'สูง',
  'insights.parityNote': 'สัดส่วนเลขคี่ในแต่ละงวด ค่าที่เกิน 50% บ่งชี้ว่าช่วงนั้นเอียงไปทางเลขคี่',
  'insights.rangeNote': 'สัดส่วนเลขสูง (5–9) ในแต่ละงวด ใช้ประกอบการเลือกช่วงเลข',
  'insights.aiLogTitle': 'บันทึกเหตุผล AI',
  'insights.aiLogSubtitle': 'ทำไมโมเดลจึงทำนายเช่นนั้น',
  // ต้องบอกให้ชัด: ข้อความสี่รายการนี้เป็นตัวอย่างที่เขียนขึ้นเอง ยังไม่มีโมเดลไหน
  // ส่งบันทึกเหตุผลออกมา และตัวเลขจริงใน backend ขัดกับบางข้อความข้างล่าง
  'insights.aiLogSample': 'ตัวอย่างประกอบ — แผงนี้ยังไม่ได้สร้างจากผลการรันโมเดลจริง',
  'insights.logGenerated': 'สร้างบันทึกเมื่อ {date} · อัปเดตทุกงวด',
  'insights.odd': 'คี่ %',
  'insights.high': 'สูง (5–9) %',
  'confidence.high': 'สูง',
  'confidence.medium': 'ปานกลาง',
  'confidence.low': 'ต่ำ',
  // ชื่อแท็ก (Seasonal/Markov/Monte Carlo/ARIMA) คงไว้เป็นภาษาอังกฤษตามตารางคำศัพท์
  // ในหัวไฟล์ ส่วนหัวข้อและคำอธิบายแปลเป็นไทย
  'insights.log.log1.headline': 'พบการเอียงเชิงฤดูกาลช่วงไตรมาส 4 ในกลุ่มเลขลงท้าย 4',
  'insights.log.log1.detail':
    'เลขที่ลงท้ายด้วย 4 ทำผลได้ดีกว่าค่าฐาน 12 งวดอยู่ 24% ในไตรมาสสุดท้าย ผลชัดที่สุดในตำแหน่งบนและต่อเนื่องกันสามรอบ',
  'insights.log.log2.headline': 'การเปลี่ยนสถานะ 93 → 48 มีน้ำหนักสูงกว่าปกติ',
  'insights.log.log2.detail':
    'เมทริกซ์การเปลี่ยนสถานะให้ความน่าจะเป็นแบบมีเงื่อนไข 0.31 กับ 48 เมื่อ 93 ออก คิดเป็นราว 1.9 เท่าของอัตราปกติ',
  'insights.log.log3.headline': 'จำลอง 10,000 ครั้ง กระจุกที่คู่เลขต่ำ-กลาง',
  'insights.log.log3.detail':
    'จากการจำลอง 10,000 งวด กลุ่มต่ำ-กลาง (10–59) ปรากฏในผลตำแหน่งบน 58% เทียบกับ 50% ที่คาดจากการกระจายสม่ำเสมอ',
  'insights.log.log4.headline': 'ความผันผวนลดลงก่อนวันออกรางวัล',
  'insights.log.log4.detail':
    'เศษที่เหลือจากแบบจำลอง (1,1,1) มีความแปรปรวนแคบลงใน 5 งวดล่าสุด ซึ่งในอดีตมักนำไปสู่คำทำนายที่มั่นใจขึ้น',

  'myNumber.title': 'ตรวจเลข',
  'myNumber.subtitle': 'พิมพ์เลข 2 หลักเพื่อดูว่าแบบจำลองว่าอย่างไร',
  'myNumber.inputLabel': 'เลข 2 หลัก',
  'myNumber.inputHint': 'กรอกตัวเลขระหว่าง 00 ถึง 99',
  'myNumber.invalid': 'ไม่ใช่เลข 2 หลัก',
  'myNumber.notFound': 'ไม่พบเลขนี้ในงวดล่าสุด',
  'myNumber.lastWon': 'ออกล่าสุด {date}',
  'myNumber.noRecent': 'ยังไม่เคยออกล่าสุด',

  // Performance (/performance) — คะแนน ตรวจรางวัล และประวัติการทายผล
  'performance.title': 'ผลงานและความโปร่งใส',
  'performance.scorecardTitle': 'คะแนน AI',
  'performance.scorecardSubtitle': 'ตลาดไทย · ทายย้อนหลัง {draws} งวด',
  'performance.scorecardSubtitleFallback': 'ตลาดไทย · ทายย้อนหลังแบบเดินหน้า',
  'performance.hitRate': 'อัตราทายถูก',
  'performance.top5Rate': 'อัตราติด 5 อันดับ',
  'performance.uniformBaseline': 'ฐานสุ่ม {rate}',
  'performance.drawsScored': 'งวดที่ตรวจ',
  'performance.drawsRequested': 'จากที่ขอ {requested} งวด',
  'performance.pValue': 'ค่า p',
  'performance.significant': 'มีนัยสำคัญ',
  'performance.notSignificant': 'ยังไม่มีนัยสำคัญ',
  'performance.replaying': 'กำลังทายย้อนหลังงวดล่าสุด…',
  'performance.scoring': 'กำลังตรวจผลงวดล่าสุด…',
  'performance.replayFailed': 'คำขอทายย้อนหลังล้มเหลว',
  'performance.requestFailed': 'คำขอล้มเหลว ({status})',
  'performance.channelUnavailable': 'ตลาดนี้ไม่มีช่องเลขท้าย 2 ตัวในช่วงเวลานี้',
  'performance.notEnoughHistory': 'ยังมีข้อมูลย้อนหลังไม่พอสำหรับตรวจผล',
  'performance.retry': 'ลองใหม่',
  'performance.prizeChecker': 'ตรวจรางวัล',
  'performance.latestResult': 'ผลล่าสุด · {date}',
  'performance.latestResultWithPrize': 'ผลล่าสุด · {date} · {prize}',
  'performance.latestResultLoading': 'กำลังโหลดผลล่าสุด…',
  'performance.latestResultUnavailable': 'โหลดผลล่าสุดไม่สำเร็จ',
  'performance.ticketLabel': 'หมายเลขสลาก',
  'performance.ticketPlaceholder': 'กรอกหมายเลขสลาก',
  'performance.check': 'ตรวจสอบ',
  'performance.winner': 'ถูกรางวัล — {label}',
  'performance.noPrize': 'ไม่ถูกรางวัลในงวดนี้',
  'performance.tierAllSix': 'ครบ 6 หลัก',
  'performance.tierFirstPrize': 'รางวัลที่ 1',
  'performance.tierLastTwoDigits': '2 หลักท้าย',
  'performance.tierLastTwo': 'เลขท้าย 2 ตัว',
  'performance.amountFirstPrize': '฿ 6,000,000',
  'performance.amountLastTwo': '฿ 2,000',
  'performance.matchFirstPrize': 'ตรงรางวัลที่ 1 · {prize}',
  'performance.matchLastTwo': 'ตรงเลขท้าย 2 ตัว · {digits}',
  'performance.noPrizeDetail': 'เทียบกับงวด {date}: รางวัลที่ 1 {first} · เลขท้าย 2 ตัว {bottom}',
  'performance.noPrizePending': 'ยังโหลดผลรางวัลล่าสุดไม่เสร็จ',
  'performance.prizeScope':
    'ตรวจเฉพาะสองรางวัลที่ตลาดนี้เผยแพร่ คือ รางวัลที่ 1 (6 หลักตรงตัว) และเลขท้าย 2 ตัว ซึ่งออกรางวัลแยกจากกัน',
  'performance.historyTitle': 'ประวัติการทายผล AI',
  'performance.historySubtitle': 'ทายย้อนหลัง · {from} → {to}',
  'performance.historySubtitleFallback': 'คำทำนายของ AI เทียบผลออกรางวัล',
  'performance.latestDraw': 'งวดล่าสุด',
  // “ที่มาของเลข” แนบกับ “งวดถัดไป” เท่านั้น: ระบบไม่ได้เก็บหลักฐานของคำทำนายย้อนหลัง
  // การติดป้ายให้คำทำนายที่ replay ขึ้นมาใหม่จึงเป็นการกุที่มา
  'performance.evidenceTitle': 'งวดถัดไป · ที่มาของเลข',
  'performance.evidenceSubtitle': 'สัญญาณที่แรงที่สุดของเลขอันดับ 1 ในแต่ละช่อง จากข้อมูลชุดเดียวกับคำทำนาย',
  'performance.evidenceFrequency': 'ความถี่ {lift}× ค่าฐาน · ออก {count} จากที่คาด {expected}',
  'performance.evidenceMarkov': 'Markov {lift}× ค่าฐาน',
  'performance.evidenceUniform': 'ไม่ต่างจากอัตราฐาน',
  // การ์ดผลงานเด่น: เติมจากผล replay จริงเท่านั้น และระบุให้ชัดว่าเป็นการ “ติด 5 อันดับ”
  // ซึ่งเป็นข้อกล่าวอ้างที่อ่อนกว่า “ทายถูก”
  'performance.highlightsTitle': '🔥 ผลงานเด่นที่ตรวจสอบได้ล่าสุด',
  'performance.highlightsExactBody': 'งวดนี้ออกเลข {number} ตรงกับเลขอันดับ 1 ที่โมเดลเลือก',
  'performance.highlightsTop5Body': 'งวดนี้ออกเลข {number} และอยู่ใน 5 อันดับแรกที่โมเดลจัดอันดับไว้',
  'performance.highlightsChannel': 'ช่อง: {channel}',
  'performance.highlightsRate': 'ติด 5 อันดับ {hits} จาก {draws} งวด ({rate}) · ฐานสุ่ม {baseline}',
  'performance.highlightsP': 'p = {p}',
  'performance.highlightsSignificant': 'ต่างจากโอกาสสุ่มอย่างมีนัยสำคัญ',
  'performance.highlightsNotSignificant': 'ยังไม่ต่างจากโอกาสสุ่มอย่างมีนัยสำคัญ',
  'performance.highlightsReplay':
    'คำนวณย้อนหลังด้วยข้อมูลชุดเดียวกับรายการด้านล่าง ไม่ใช่บันทึกคำทำนายที่เก็บไว้ ผลในอดีตไม่ทำนายงวดถัดไป',
  'performance.highlightsEmpty': 'ยังไม่มีสัญญาณใดจับเลขที่ออกได้ใน {draws} งวดล่าสุดของทุกตลาดที่เราตรวจ',
  'performance.highlightsEmptyBody':
    'การ์ดนี้จะขึ้นเมื่อผลที่ประกาศตรงกับสัญญาณที่เราคำนวณย้อนกลับได้เท่านั้น คือเลขอันดับ 1 หรือ 5 อันดับแรก ไม่มีตัวเลขใดถูกเขียนขึ้นเอง',
  'performance.highlightsFailed': 'ยังดึงผลงานเด่นไม่ได้ในตอนนี้ ระบบคำนวณย้อนหลังไม่ตอบสนอง',
  'performance.sourceTop5': 'จาก Top 5',
  'performance.sourceTop1': 'จาก AI อันดับ 1',
  'performance.aiPredicted': 'AI ทำนาย',
  'performance.actualResult': 'ผลออกรางวัล',
  'performance.hit': 'ถูกรางวัล',
  'performance.miss': 'ไม่ถูก',
  'performance.inTop5': 'ติด 5 อันดับ',
  'performance.actual': 'ผลจริง',
  'performance.channelBottom': 'เลขท้าย 2 ตัว',
  'performance.channelTop': 'สองตัวท้ายรางวัลที่ 1',
  'performance.historyRowNote': 'แต่ละแถวคือคำทำนายช่อง {channel} ของโมเดล เทียบกับเลขที่ออกจริง เรียงจากใหม่ไปเก่า',
  'performance.historyReplayNote':
    'นี่คือการคำนวณย้อนหลัง ไม่ใช่บันทึกคำทำนาย: ระบบไม่ได้เก็บคำทำนายไว้ตอนที่คำนวณ ทุกคำทำนายจึงคำนวณจากงวดก่อนหน้าแล้วนำมาเทียบกับผลที่ประกาศจริง ด้วยกฎเดียวกับการทดสอบย้อนหลังในแท็บ Backtest',
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

  // Legal notice — ข้อความตามที่ฝ่ายกฎหมายกำหนด ใช้คำต่อคำ ไม่ปรับสำนวน
  // (ดูคำอธิบายใน en.ts ว่าทำไมข้อความนี้ต้องไม่ถูกแก้ไข)
  //
  // ประโยคนี้ค่อนข้างยาวและมีช่องว่างสองจุด จึงตัดบรรทัดในซอร์สไม่ได้
  // แต่ lineHeight ที่ใช้แสดงผลเผื่อสระและวรรณยุกต์ไทยไว้แล้ว
  'legal.disclaimer':
    'แอปพลิเคชันนี้จัดทำขึ้นเพื่อการวิเคราะห์ทางสถิติและความบันเทิงเท่านั้น ไม่สนับสนุนให้เล่นการพนันที่ผิดกฎหมาย และไม่รับประกันผลลัพธ์ของการคำนวณใดๆ',
};
