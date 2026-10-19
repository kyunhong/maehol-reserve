/**
 * 2학년 반별 상담 예약 - Apps Script 백엔드
 *
 * 구글 시트 하나에 연결된(컨테이너 바인딩) 스크립트 하나로 1~10반을 모두 처리합니다.
 * 반끼리는 완전히 독립: 예약은 '반' 열로 구분하고, 설정은 반마다 스크립트 속성 SETTINGS_<반> 에 저장합니다.
 * 시트 > 확장 프로그램 > Apps Script 에 이 파일을 붙여넣고 웹 앱으로 배포하세요. 자세한 방법은 README.md 참고.
 *
 * 스크립트 속성
 *   MASTER_PASSWORD  학년 관리 비밀번호 (직접 입력). 전 반 현황 보기 + 반별 담임 비밀번호 정하기
 *   ADMIN_HASH_<반>  담임 비밀번호 해시 (학년 관리 화면에서 정하면 자동 저장. 직접 고치지 마세요)
 *   SETTINGS_<반>    반 설정 (담임 관리 화면에서 저장하면 자동 저장)
 */

// ===================== 설정 =====================
const CONFIG = {
  SCHOOL: '매홀고',
  GRADE: 2,
  CLASS_COUNT: 10,
  SHEET_NAME: '예약',
  HOLIDAY_SHEET_NAME: '휴무일',

  // 비밀번호를 연속으로 틀리면 잠시 막음
  MAX_FAILS: 5,
  LOCK_MINUTES: 10,

  DEFAULT_WEEKS: 4, // 반 설정을 저장하기 전: 오늘부터 4주 뒤까지 예약 받기
  MAX_DAYS_AHEAD: 365, // 예약 끝 날짜는 오늘부터 1년 안
};

/** 아직 한 번도 설정을 저장하지 않은 반이 쓰는 처음 값 */
function defaultSettings_(cls) {
  return {
    title: CONFIG.SCHOOL + ' ' + CONFIG.GRADE + '-' + cls + ' 상담 예약',
    notice: '비어 있는 시간을 눌러 예약하세요. 예약할 때 정한 비밀번호로 취소·변경할 수 있어요.',
    startDate: now_().today, // 예약 기간 시작 (지난 날짜면 오늘로 본다)
    endDate: addDays_(CONFIG.DEFAULT_WEEKS * 7), // 예약 기간 끝 (이 날까지 상담)
    // 시간대: days 는 요일 (1=월 … 5=금). start 시각이 지나면 그날 예약 마감.
    slots: [
      { key: 'MORNING', label: '아침', start: '08:20', days: [1, 2, 3, 4, 5] },
      { key: 'LUNCH', label: '점심시간', start: '13:30', days: [1, 2, 3, 4, 5] },
      { key: 'AFTER_EARLY', label: '방과후', start: '16:10', days: [1, 5] },
      { key: 'AFTER', label: '방과후', start: '17:10', days: [2, 3, 4] },
    ],
    // 예약을 받지 않는 날 (시트의 '휴무일' 탭에 적은 날도 함께 적용)
    closedDates: [],
  };
}

const HEADERS = ['예약ID', '반', '날짜', '요일', '시간대', '학번', '이름', '상태',
  '시간대코드', '비번해시', '솔트', '신청일시', '수정일시'];
const COL = {}; HEADERS.forEach((h, i) => { COL[h] = i + 1; });
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const ACTIVE = '예약';
const CANCELLED = '취소';

class UserError extends Error {}

// ===================== 진입점 =====================
function doGet(e) {
  const p = (e && e.parameter) || {};
  // GET 은 빈자리 조회만 허용 (비밀번호가 URL 에 남지 않도록)
  if (p.action !== 'availability') {
    return ContentService.createTextOutput('2학년 상담 예약 API 가 동작 중입니다.');
  }
  return handle_(p);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '잘못된 요청입니다.' });
  }
  return handle_(body);
}

const ACTIONS = {
  // 학생
  availability: apiAvailability_,
  book: apiBook_,
  myBookings: apiMyBookings_,
  cancel: apiCancel_,
  modify: apiModify_,
  // 담임 (자기 반만)
  adminList: apiAdminList_,
  adminGetSettings: apiAdminGetSettings_,
  adminSaveSettings: apiAdminSaveSettings_,
  adminChangePassword: apiAdminChangePassword_,
  adminCancel: apiAdminCancel_,
  adminBlock: apiAdminBlock_,
  // 학년 관리 (전 반 보기 + 담임 비밀번호 정하기)
  masterOverview: apiMasterOverview_,
  masterSetPassword: apiMasterSetPassword_,
};

function handle_(p) {
  try {
    const fn = ACTIONS[p.action];
    if (!fn) throw new UserError('알 수 없는 요청입니다.');
    return json_({ ok: true, data: fn(p) });
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message });
    console.error(err);
    return json_({ ok: false, error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 처음 한 번 편집기에서 실행: 권한 승인 + 시트 생성 */
function setup() {
  sheet_();
  holidaySheet_();
}

// ===================== 학생 API =====================
function apiAvailability_(p) {
  const cls = cleanClass_(p.cls);
  const booked = new Set(classRows_(cls).filter(r => r.status === ACTIVE).map(r => r.date + '|' + r.slot));
  const holidays = holidays_(cls);
  const { today, nowHm } = now_();

  const st = settings_(cls);
  const slotMap = slotMap_(st);
  const blocked = blockedSet_(st);
  const days = calendarDates_(st).map(d => {
    const keys = daySlots_(st, d.weekday);
    const holiday = holidays[d.date] || null;
    return {
      date: d.date,
      weekday: d.weekday,
      holiday,
      slots: keys.map(key => {
        let status = 'open';
        if (holiday) status = 'closed';
        else if (d.date === today && nowHm >= slotMap[key].start) status = 'closed';
        else if (booked.has(d.date + '|' + key)) status = 'booked';
        else if (blocked[d.date + '|' + key]) status = 'blocked'; // 담임이 막아 둔 칸 (학생에게는 '마감')
        return { key, status };
      }),
    };
  }).filter(d => d.slots.length > 0);

  return { cls, today, title: st.title, notice: st.notice, slots: slotMap, days };
}

function apiBook_(p) {
  const cls = cleanClass_(p.cls);
  const studentId = cleanStudentId_(p.studentId, cls);
  const name = cleanName_(p.name);
  const password = cleanPassword_(p.password);
  const date = String(p.date || '');
  const slot = String(p.slot || '');

  return withLock_(() => {
    assertSlotAvailable_(cls, date, slot, classRows_(cls), null);

    const salt = Utilities.getUuid();
    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    const record = {};
    record['예약ID'] = id;
    record['반'] = String(cls);
    record['날짜'] = date;
    record['요일'] = WEEKDAYS[weekdayOf_(date)];
    record['시간대'] = slotText_(cls, slot);
    record['학번'] = studentId;
    record['이름'] = name;
    record['상태'] = ACTIVE;
    record['시간대코드'] = slot;
    record['비번해시'] = hash_(password, salt);
    record['솔트'] = salt;
    record['신청일시'] = stamp_();
    record['수정일시'] = '';
    const sh = sheet_();
    sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length)
      .setValues([HEADERS.map(h => record[h])]);
    return { id, date, slot };
  });
}

function apiMyBookings_(p) {
  const cls = cleanClass_(p.cls);
  return verify_(cls, p.studentId, p.password, classRows_(cls)).map(publicView_);
}

function apiCancel_(p) {
  return withLock_(() => {
    const target = findMine_(p);
    const sh = sheet_();
    sh.getRange(target.row, COL['상태']).setValue(CANCELLED);
    sh.getRange(target.row, COL['수정일시']).setValue(stamp_());
    return { id: target.id };
  });
}

function apiModify_(p) {
  const date = String(p.date || '');
  const slot = String(p.slot || '');
  return withLock_(() => {
    const target = findMine_(p);
    assertSlotAvailable_(target.cls, date, slot, classRows_(target.cls), target.id);
    const sh = sheet_();
    sh.getRange(target.row, COL['날짜'], 1, 3).setValues([[date, WEEKDAYS[weekdayOf_(date)], slotText_(target.cls, slot)]]);
    sh.getRange(target.row, COL['시간대코드']).setValue(slot);
    sh.getRange(target.row, COL['수정일시']).setValue(stamp_());
    return { id: target.id, date, slot };
  });
}

// ===================== 담임 API (자기 반만) =====================
/** 담임: 자기 반 예약 목록. all=true 면 취소·지난 예약도 포함 */
function apiAdminList_(p) {
  const cls = verifyAdmin_(p.cls, p.adminPassword);
  const { today } = now_();
  return classRows_(cls)
    .filter(r => p.all || (r.status === ACTIVE && r.date >= today))
    .sort((a, b) => sortKey_(a).localeCompare(sortKey_(b)))
    .map(adminView_);
}

/** 담임: 자기 반 현재 설정 */
function apiAdminGetSettings_(p) {
  return settings_(verifyAdmin_(p.cls, p.adminPassword));
}

/**
 * 담임: 자기 반 설정 저장.
 * 바꾼 설정 때문에 달력에서 사라지는 다가오는 예약이 있으면 저장하지 않고 그 목록을 돌려준다.
 * confirmCancel=true 로 다시 보내면 그 예약들을 취소하고 저장한다.
 */
function apiAdminSaveSettings_(p) {
  const cls = verifyAdmin_(p.cls, p.adminPassword);
  const input = Object.assign({}, p.settings || {});
  if (!Array.isArray(input.blocked)) input.blocked = settings_(cls).blocked; // 설정 탭은 막은 칸을 보내지 않으니 그대로 둔다
  const next = normalizeSettings_(cls, input, true);
  return withLock_(() => {
    const { today } = now_();
    const closed = {};
    next.closedDates.forEach(c => { closed[c.date] = true; });
    const conflicts = classRows_(cls).filter(r => {
      if (r.status !== ACTIVE || r.date < today) return false;
      const s = next.slots.find(x => x.key === r.slot);
      return !s || !s.days.includes(weekdayOf_(r.date)) ||
        r.date < next.startDate || r.date > next.endDate || Boolean(closed[r.date]);
    });
    if (conflicts.length && !p.confirmCancel) {
      const old = slotMap_(settings_(cls));
      return {
        saved: false,
        conflicts: conflicts.map(r => Object.assign(publicView_(r), {
          slotText: old[r.slot] ? old[r.slot].label + ' ' + timeText_(old[r.slot]) : r.slot,
        })),
      };
    }
    const sh = sheet_();
    conflicts.forEach(r => {
      sh.getRange(r.row, COL['상태']).setValue(CANCELLED);
      sh.getRange(r.row, COL['수정일시']).setValue(stamp_() + ' (설정 변경으로 취소)');
    });
    saveSettings_(cls, next);
    return { saved: true, cancelled: conflicts.length, settings: next };
  });
}

function saveSettings_(cls, st) {
  PropertiesService.getScriptProperties().setProperty('SETTINGS_' + cls, JSON.stringify(st));
  settingsCache_[cls] = st;
}

/** 담임: 자기 반 학생 예약 취소 (장난 예약 등). 기록은 남기고 상태만 '취소'로 */
function apiAdminCancel_(p) {
  const cls = verifyAdmin_(p.cls, p.adminPassword);
  return withLock_(() => {
    const target = classRows_(cls).find(r => r.id === String(p.id || '') && r.status === ACTIVE);
    if (!target) throw new UserError('예약을 찾을 수 없습니다. 이미 취소되었을 수 있어요. 새로고침해 주세요.');
    const sh = sheet_();
    sh.getRange(target.row, COL['상태']).setValue(CANCELLED);
    sh.getRange(target.row, COL['수정일시']).setValue(stamp_() + ' (담임 취소)');
    return { id: target.id };
  });
}

/**
 * 담임: 특정 날짜의 특정 시간대 한 칸 막기 / 다시 열기 (blocked=false).
 * 예약이 있는 칸은 막을 수 없다 (먼저 예약을 취소).
 */
function apiAdminBlock_(p) {
  const cls = verifyAdmin_(p.cls, p.adminPassword);
  const date = String(p.date || '');
  const slot = String(p.slot || '');
  const block = p.blocked !== false;
  return withLock_(() => {
    const st = settings_(cls);
    const key = date + '|' + slot;
    let blocked = st.blocked.filter(b => b.date + '|' + b.slot !== key);
    if (block) {
      const day = calendarDates_(st).find(d => d.date === date);
      if (!day || !daySlots_(st, day.weekday).includes(slot)) throw new UserError('막을 수 없는 시간입니다. 새로고침해 주세요.');
      const taken = classRows_(cls).some(r => r.status === ACTIVE && r.date === date && r.slot === slot);
      if (taken) throw new UserError('예약이 있는 시간입니다. 먼저 예약을 취소해 주세요.');
      blocked = blocked.concat([{ date, slot }]);
    }
    const next = normalizeSettings_(cls, Object.assign({}, st, { blocked }), false);
    saveSettings_(cls, next);
    return { date, slot, blocked: block };
  });
}

/** 담임: 자기 반 관리자 비밀번호 바꾸기 */
function apiAdminChangePassword_(p) {
  const cls = verifyAdmin_(p.cls, p.adminPassword);
  setAdminPassword_(cls, p.newPassword);
  return { cls };
}

// ===================== 학년 관리 API =====================
/** 학년 관리: 반별 제목·담임 비밀번호 설정 여부·다가오는 예약 */
function apiMasterOverview_(p) {
  verifyMaster_(p.masterPassword);
  const { today } = now_();
  const props = PropertiesService.getScriptProperties();
  const upcoming = rows_().filter(r => r.status === ACTIVE && r.date >= today);
  return {
    today,
    classes: classList_().map(cls => {
      const st = settings_(cls);
      return {
        cls,
        title: st.title,
        startDate: st.startDate,
        endDate: st.endDate,
        hasPassword: Boolean(props.getProperty('ADMIN_HASH_' + cls)),
        slots: slotMap_(st),
        bookings: upcoming.filter(r => r.cls === cls)
          .sort((a, b) => sortKey_(a).localeCompare(sortKey_(b)))
          .map(adminView_),
      };
    }),
  };
}

/** 학년 관리: 담임 비밀번호 정하기 (처음 설정 또는 잊었을 때 다시 정하기) */
function apiMasterSetPassword_(p) {
  verifyMaster_(p.masterPassword);
  const cls = cleanClass_(p.cls);
  setAdminPassword_(cls, p.newPassword);
  return { cls };
}

// ===================== 설정 =====================
const settingsCache_ = {};

function settings_(cls) {
  if (settingsCache_[cls]) return settingsCache_[cls];
  const raw = PropertiesService.getScriptProperties().getProperty('SETTINGS_' + cls);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (err) { console.error(err); }
  settingsCache_[cls] = normalizeSettings_(cls, parsed || defaultSettings_(cls), false);
  return settingsCache_[cls];
}

/** 설정 값 검사·정리. strict=true 면 잘못된 값에 오류를 낸다 (담임 저장 시). */
function normalizeSettings_(cls, input, strict) {
  const bad = (msg) => { if (strict) throw new UserError(msg); };
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00:00'));
  const defaults = defaultSettings_(cls);

  const title = str(input.title, 60) || defaults.title;
  const notice = str(input.notice, 200);

  // 예약 기간: 시작·끝 날짜. 시작이 지난 날짜면 오늘로 맞춘다 (지난날은 어차피 예약할 수 없음)
  const { today } = now_();
  const maxDate = addDays_(CONFIG.MAX_DAYS_AHEAD);
  let startDate = str(input.startDate, 10);
  let endDate = str(input.endDate, 10);
  if (!isDate(startDate)) {
    if (startDate) bad('예약 시작 날짜를 다시 확인해 주세요.');
    startDate = today;
  }
  if (startDate < today) startDate = today;
  if (!isDate(endDate)) {
    if (strict) bad('예약 끝 날짜를 정해 주세요.');
    endDate = legacyEndDate_(input) || defaults.endDate;
  }
  if (endDate < startDate) {
    bad(endDate < today ? '예약 끝 날짜가 이미 지났습니다.' : '예약 끝 날짜가 시작 날짜보다 빠릅니다.');
  }
  if (endDate > maxDate) { bad('예약 끝 날짜는 오늘부터 1년 안으로 정해 주세요.'); endDate = maxDate; }

  const keys = {};
  const slots = [];
  (Array.isArray(input.slots) ? input.slots : []).forEach((x, i) => {
    const label = str(x && x.label, 20);
    const start = str(x && x.start, 5);
    let end = str(x && x.end, 5); // 끝나는 시각 (선택, '' 이면 표시 안 함)
    const days = [...new Set((Array.isArray(x && x.days) ? x.days : []).map(Number))]
      .filter(d => d >= 1 && d <= 5).sort();
    if (!label) return bad((i + 1) + '번째 시간대의 이름을 입력해 주세요.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return bad(label + ' 시간대의 시작 시각을 다시 확인해 주세요.');
    if (end && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || end <= start)) {
      bad(label + ' 시간대의 끝나는 시각은 시작 시각보다 늦어야 합니다.');
      end = '';
    }
    let key = str(x && x.key, 20);
    if (!/^[A-Za-z0-9_]+$/.test(key) || keys[key]) key = 'S' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    keys[key] = true;
    slots.push({ key, label, start, end, days });
  });
  if (!slots.length) {
    bad('상담 시간대를 하나 이상 만들어 주세요.');
    return normalizeSettings_(cls, defaults, false);
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));

  const seen = {};
  const closedDates = [];
  (Array.isArray(input.closedDates) ? input.closedDates : []).forEach(c => {
    const date = str(c && c.date, 10);
    if (!date) return;
    if (!isDate(date)) return bad('휴무일 날짜를 다시 확인해 주세요: ' + date);
    if (seen[date]) return;
    seen[date] = true;
    closedDates.push({ date, reason: str(c.reason, 30) || '휴무' });
  });
  closedDates.sort((a, b) => a.date.localeCompare(b.date));

  // 담임이 막아 둔 칸: 지금 있는 시간대이고 지나지 않은 날짜만 남긴다
  const slotKeys = {};
  slots.forEach(x => { slotKeys[x.key] = true; });
  const blockedSeen = {};
  const blocked = [];
  (Array.isArray(input.blocked) ? input.blocked : []).forEach(b => {
    const date = str(b && b.date, 10);
    const slot = str(b && b.slot, 20);
    if (!isDate(date) || date < today || !slotKeys[slot] || blockedSeen[date + '|' + slot]) return;
    blockedSeen[date + '|' + slot] = true;
    blocked.push({ date, slot });
  });
  blocked.sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));

  return { title, notice, startDate, endDate, slots, closedDates, blocked };
}

/** 예전 형식(daysAhead: 오늘부터 며칠, lastDate: 마지막 날)으로 저장된 설정의 끝 날짜 */
function legacyEndDate_(input) {
  const n = Number(input.daysAhead);
  if (!Number.isInteger(n) || n < 1) return '';
  const end = addDays_(Math.min(n, CONFIG.MAX_DAYS_AHEAD));
  const last = String(input.lastDate || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(last) && last < end ? last : end;
}

/** { key: { label, start, end } } */
function slotMap_(st) {
  const map = {};
  st.slots.forEach(s => { map[s.key] = { label: s.label, start: s.start, end: s.end }; });
  return map;
}

/** { 'date|slot': true } 담임이 막아 둔 칸 */
function blockedSet_(st) {
  const set = {};
  st.blocked.forEach(b => { set[b.date + '|' + b.slot] = true; });
  return set;
}

/** '08:20~08:40' 또는 끝나는 시각이 없으면 '08:20~' */
function timeText_(s) {
  return s.start + '~' + (s.end || '');
}

/** 해당 요일에 열리는 시간대 key 목록 (시작 시각 순) */
function daySlots_(st, weekday) {
  return st.slots.filter(s => s.days.includes(weekday)).map(s => s.key);
}

function classList_() {
  const out = [];
  for (let c = 1; c <= CONFIG.CLASS_COUNT; c++) out.push(c);
  return out;
}

// ===================== 검증 =====================
function cleanClass_(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > CONFIG.CLASS_COUNT) throw new UserError('반을 다시 선택해 주세요.');
  return n;
}

/** 학번 5자리: 학년 1자리 + 반 2자리 + 번호 2자리 (예: 20601 = 2학년 6반 1번). 다른 반 학번은 거절. */
function cleanStudentId_(v, cls) {
  const s = String(v || '').trim();
  const example = CONFIG.GRADE + pad2_(cls) + '01';
  if (!/^\d{5}$/.test(s) || Number(s.slice(3)) < 1) {
    throw new UserError('학번은 숫자 5자리로 입력해 주세요. (예: ' + example + ')');
  }
  if (Number(s[0]) !== CONFIG.GRADE) throw new UserError(CONFIG.GRADE + '학년 학번이 아닙니다. (예: ' + example + ')');
  const own = Number(s.slice(1, 3));
  if (own !== cls) {
    throw new UserError(own >= 1 && own <= CONFIG.CLASS_COUNT
      ? '학번을 보면 ' + own + '반 학생이에요. ' + own + '반 예약 화면에서 예약해 주세요.'
      : '학번을 다시 확인해 주세요. (예: ' + example + ')');
  }
  return s;
}

function cleanName_(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (!/^[가-힣a-zA-Z ]{1,20}$/.test(s)) throw new UserError('이름은 한글/영문 20자 이내로 입력해 주세요.');
  return s;
}

function cleanPassword_(v) {
  const s = String(v || '');
  if (s.length < 4 || s.length > 20) throw new UserError('비밀번호는 4~20자로 입력해 주세요.');
  return s;
}

/** 예약 가능한 날짜·시간대인지, 그 반에서 이미 찬 자리인지 확인 (exceptId: 수정 중인 본인 예약) */
function assertSlotAvailable_(cls, date, slot, rows, exceptId) {
  const st = settings_(cls);
  const slotMap = slotMap_(st);
  if (!slotMap[slot]) throw new UserError('시간대를 다시 선택해 주세요.');
  const day = calendarDates_(st).find(d => d.date === date);
  if (!day) throw new UserError('예약할 수 없는 날짜입니다.');
  if (!daySlots_(st, day.weekday).includes(slot)) {
    throw new UserError(WEEKDAYS[day.weekday] + '요일에는 해당 시간대 상담이 없습니다.');
  }
  if (holidays_(cls)[date]) throw new UserError('휴무일에는 예약할 수 없습니다.');
  if (blockedSet_(st)[date + '|' + slot]) throw new UserError('예약을 받지 않는 시간입니다. 다른 시간을 선택해 주세요.');
  const { today, nowHm } = now_();
  if (date === today && nowHm >= slotMap[slot].start) {
    throw new UserError('이미 지난 시간대입니다.');
  }
  const taken = rows.some(r => r.cls === cls && r.status === ACTIVE && r.date === date && r.slot === slot && r.id !== exceptId);
  if (taken) throw new UserError('이미 예약된 시간입니다. 다른 시간을 선택해 주세요.');
}

/** 학번+비밀번호가 맞는 다가오는 예약 목록. 연속으로 틀리면 잠시 잠금. */
function verify_(cls, studentIdRaw, password, rows) {
  const studentId = cleanStudentId_(studentIdRaw, cls);
  const cache = CacheService.getScriptCache();
  const key = 'fail_' + studentId;
  const fails = Number(cache.get(key) || 0);
  if (fails >= CONFIG.MAX_FAILS) {
    throw new UserError('비밀번호를 여러 번 틀려 ' + CONFIG.LOCK_MINUTES + '분 동안 조회할 수 없습니다.');
  }
  const { today } = now_();
  const pw = String(password || '');
  const mine = rows.filter(r =>
    r.cls === cls && r.studentId === studentId && r.status === ACTIVE && r.date >= today &&
    hash_(pw, r.salt) === r.hash);
  if (!mine.length) {
    cache.put(key, String(fails + 1), CONFIG.LOCK_MINUTES * 60);
    throw new UserError('학번과 비밀번호가 일치하는 예약이 없습니다.');
  }
  cache.remove(key);
  return mine.sort((a, b) => sortKey_(a).localeCompare(sortKey_(b)));
}

function findMine_(p) {
  const cls = cleanClass_(p.cls);
  const mine = verify_(cls, p.studentId, p.password, classRows_(cls));
  const target = mine.find(r => r.id === String(p.id || ''));
  if (!target) throw new UserError('예약을 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
  return target;
}

/** 비밀번호 확인 공통: 연속으로 MAX_FAILS 번 틀리면 LOCK_MINUTES 동안 막는다 */
function checkWithLockout_(failKey, isCorrect, wrongMessage) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_FAILS) {
    throw new UserError('비밀번호를 여러 번 틀려 ' + CONFIG.LOCK_MINUTES + '분 동안 접속할 수 없습니다.');
  }
  if (!isCorrect()) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCK_MINUTES * 60);
    throw new UserError(wrongMessage);
  }
  cache.remove(failKey);
}

/** 담임 비밀번호 확인. 반마다 따로 (스크립트 속성 ADMIN_HASH_<반>). 맞으면 반 번호를 돌려준다. */
function verifyAdmin_(clsRaw, password) {
  const cls = cleanClass_(clsRaw);
  const raw = PropertiesService.getScriptProperties().getProperty('ADMIN_HASH_' + cls);
  if (!raw) throw new UserError(cls + '반 관리자 비밀번호가 아직 정해지지 않았습니다. 학년 관리 화면에서 먼저 정해 주세요.');
  const saved = JSON.parse(raw);
  checkWithLockout_('fail_admin_' + cls,
    () => hash_(String(password || ''), saved.salt) === saved.hash,
    cls + '반 관리자 비밀번호가 틀렸습니다.');
  return cls;
}

/** 학년 관리 비밀번호는 코드가 아니라 스크립트 속성 MASTER_PASSWORD 에 저장 (README 참고) */
function verifyMaster_(password) {
  const expected = PropertiesService.getScriptProperties().getProperty('MASTER_PASSWORD');
  if (!expected) throw new UserError('학년 관리 비밀번호가 설정되지 않았습니다. (스크립트 속성 MASTER_PASSWORD)');
  checkWithLockout_('fail_master', () => String(password || '') === expected, '학년 관리 비밀번호가 틀렸습니다.');
}

function setAdminPassword_(cls, password) {
  const s = String(password || '');
  if (s.length < 6 || s.length > 30) throw new UserError('관리자 비밀번호는 6~30자로 정해 주세요.');
  const salt = Utilities.getUuid();
  PropertiesService.getScriptProperties()
    .setProperty('ADMIN_HASH_' + cls, JSON.stringify({ salt, hash: hash_(s, salt) }));
  CacheService.getScriptCache().remove('fail_admin_' + cls);
}

// ===================== 시트 =====================
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@'); // 날짜·학번이 자동 변환되지 않도록 텍스트로
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideColumns(COL['시간대코드'], 3); // 시간대코드, 비번해시, 솔트
  }
  return sh;
}

function holidaySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.HOLIDAY_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.HOLIDAY_SHEET_NAME);
    sh.getRange(1, 1, sh.getMaxRows(), 3).setNumberFormat('@');
    sh.getRange(1, 1, 1, 3).setValues([['날짜 (예: 2026-10-20)', '사유', '반 (비우면 학년 전체)']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 예약 시트 전체 (1~10반 모두) */
function rows_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues().map((r, i) => ({
    row: i + 2,
    id: String(r[COL['예약ID'] - 1]),
    cls: Number(r[COL['반'] - 1]),
    date: toDateStr_(r[COL['날짜'] - 1]),
    slot: String(r[COL['시간대코드'] - 1]),
    studentId: String(r[COL['학번'] - 1]),
    name: String(r[COL['이름'] - 1]),
    status: String(r[COL['상태'] - 1]),
    hash: String(r[COL['비번해시'] - 1]),
    salt: String(r[COL['솔트'] - 1]),
    createdAt: String(r[COL['신청일시'] - 1]),
    updatedAt: String(r[COL['수정일시'] - 1]),
  }));
}

function classRows_(cls) {
  return rows_().filter(r => r.cls === cls);
}

/** { 'yyyy-MM-dd': '사유' } — 그 반 설정의 휴무일 + 시트 '휴무일' 탭 (반이 비었거나 같은 반인 줄) */
function holidays_(cls) {
  const map = {};
  settings_(cls).closedDates.forEach(c => { map[c.date] = c.reason; });
  const sh = holidaySheet_();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return map;
  sh.getRange(2, 1, n, 3).getValues().forEach(([d, reason, forClass]) => {
    const date = toDateStr_(d);
    const target = String(forClass == null ? '' : forClass).replace(/반/g, '').trim();
    if (date && (!target || Number(target) === cls)) map[date] = String(reason || '휴무');
  });
  return map;
}

function publicView_(r) {
  return { id: r.id, cls: r.cls, date: r.date, slot: r.slot, name: r.name, studentId: r.studentId };
}

function adminView_(r) {
  return Object.assign(publicView_(r), { status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt });
}

// ===================== 유틸 =====================
function tz_() { return Session.getScriptTimeZone() || 'Asia/Seoul'; }

function now_() {
  const d = new Date();
  return {
    today: Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'),
    nowHm: Utilities.formatDate(d, tz_(), 'HH:mm'),
  };
}

/** 오늘부터 n일 뒤 'yyyy-MM-dd' */
function addDays_(n) {
  return Utilities.formatDate(new Date(new Date().getTime() + n * 86400000), tz_(), 'yyyy-MM-dd');
}

function stamp_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }

/** 예약 기간(startDate~endDate) 가운데 오늘 이후 날짜 [{date, weekday}] */
function calendarDates_(st) {
  const out = [];
  const base = new Date();
  for (let i = 0; i <= CONFIG.MAX_DAYS_AHEAD; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const date = Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
    if (date > st.endDate) break;
    if (date < st.startDate) continue;
    out.push({
      date,
      weekday: Number(Utilities.formatDate(d, tz_(), 'u')) % 7, // u: 1=월 … 7=일
    });
  }
  return out;
}

function weekdayOf_(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function toDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return String(v || '').trim();
}

function pad2_(n) { return String(n).padStart(2, '0'); }

function slotText_(cls, key) {
  const s = slotMap_(settings_(cls))[key];
  return s.label + ' (' + timeText_(s) + ')';
}

function sortKey_(r) {
  const s = slotMap_(settings_(r.cls))[r.slot];
  return r.date + ' ' + (s ? s.start : r.slot);
}

function hash_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + password, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new UserError('접속자가 많습니다. 잠시 후 다시 시도해 주세요.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
