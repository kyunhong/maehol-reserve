// apps-script/Code.gs 핵심 흐름 테스트. 실행: npm test (또는 node --test test/)
// 기준 시각: 2026-10-19(월) 07:00 서울. 10/19 월, 10/20 화, 10/21 수, 10/22 목, 10/23 금.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./gas-mock');

const MASTER = 'master-pw';
const student = (cls, no, extra = {}) => ({
  cls, studentId: `2${String(cls).padStart(2, '0')}${String(no).padStart(2, '0')}`,
  name: '홍길동', password: '1234', ...extra,
});

function setup() {
  const s = loadServer({ props: { MASTER_PASSWORD: MASTER } });
  s.ok('masterSetPassword', { masterPassword: MASTER, cls: 6, newPassword: 'teacher6' });
  s.ok('masterSetPassword', { masterPassword: MASTER, cls: 7, newPassword: 'teacher7' });
  return s;
}

const slotStatus = (s, cls, date, key) =>
  s.ok('availability', { cls }).days.find((d) => d.date === date).slots.find((x) => x.key === key).status;

test('반끼리 예약이 독립이다: 6반 08:20 과 7반 08:20 은 별개 자리', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(7, 1), date: '2026-10-19', slot: 'MORNING' });

  assert.equal(slotStatus(s, 6, '2026-10-19', 'MORNING'), 'booked');
  assert.equal(slotStatus(s, 7, '2026-10-19', 'MORNING'), 'booked');
  assert.equal(slotStatus(s, 5, '2026-10-19', 'MORNING'), 'open');

  // 시트에 반 열이 들어간다
  const rows = s.sheet('예약').data.slice(1);
  assert.deepEqual(rows.map((r) => r[1]), ['6', '7']);
});

test('같은 반 같은 자리는 중복 예약을 거절한다', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  assert.match(s.err('book', { ...student(6, 2), date: '2026-10-19', slot: 'MORNING' }), /이미 예약된 시간/);
});

test('학번으로 반을 확인해서 다른 반 예약을 막는다', () => {
  const s = setup();
  const at = { date: '2026-10-19', slot: 'LUNCH' };
  assert.match(s.err('book', { ...student(6, 1), studentId: '20701', ...at }), /7반 학생이에요/);
  assert.match(s.err('book', { ...student(6, 1), studentId: '30601', ...at }), /2학년 학번이 아닙니다/);
  assert.match(s.err('book', { ...student(6, 1), studentId: '2061', ...at }), /5자리/);
  assert.match(s.err('book', { ...student(6, 1), studentId: '20600', ...at }), /5자리/);
  assert.match(s.err('book', { ...student(6, 1), cls: 11, ...at }), /반을 다시 선택/);
  s.ok('book', { ...student(6, 1), ...at });
});

test('학생 비밀번호로 조회·변경·취소, 다른 반에서는 조회되지 않는다', () => {
  const s = setup();
  const me = student(6, 3);
  s.ok('book', { ...me, date: '2026-10-20', slot: 'LUNCH' });
  s.ok('book', { ...student(6, 4), date: '2026-10-21', slot: 'LUNCH' });

  const mine = s.ok('myBookings', me);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].cls, 6);
  assert.match(s.err('myBookings', { ...me, password: 'wrong' }), /일치하는 예약이 없습니다/);
  assert.match(s.err('myBookings', { ...me, cls: 7 }), /6반 학생이에요/);

  // 이미 찬 자리로는 못 바꾼다
  assert.match(s.err('modify', { ...me, id: mine[0].id, date: '2026-10-21', slot: 'LUNCH' }), /이미 예약된/);
  s.ok('modify', { ...me, id: mine[0].id, date: '2026-10-22', slot: 'AFTER' });
  assert.equal(slotStatus(s, 6, '2026-10-20', 'LUNCH'), 'open');
  assert.equal(slotStatus(s, 6, '2026-10-22', 'AFTER'), 'booked');

  s.ok('cancel', { ...me, id: mine[0].id });
  assert.equal(slotStatus(s, 6, '2026-10-22', 'AFTER'), 'open');
});

test('학생 비밀번호를 5번 틀리면 잠긴다', () => {
  const s = setup();
  const me = student(6, 5);
  s.ok('book', { ...me, date: '2026-10-20', slot: 'LUNCH' });
  for (let i = 0; i < 5; i++) s.err('myBookings', { ...me, password: 'nope' });
  assert.match(s.err('myBookings', me), /분 동안 조회할 수 없습니다/);
});

test('오늘 이미 지난 시간대는 예약할 수 없다', () => {
  const s = setup();
  s.setNow('2026-10-19T13:40');
  assert.match(s.err('book', { ...student(6, 1), date: '2026-10-19', slot: 'LUNCH' }), /지난 시간대/);
  assert.equal(slotStatus(s, 6, '2026-10-19', 'LUNCH'), 'closed');
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'AFTER_EARLY' });
});

test('담임 비밀번호는 반마다 따로, 해시로만 저장된다', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(7, 1), date: '2026-10-19', slot: 'MORNING' });

  assert.ok(!s.properties.get('ADMIN_HASH_6').includes('teacher6'));

  const list6 = s.ok('adminList', { cls: 6, adminPassword: 'teacher6' });
  assert.deepEqual(list6.map((r) => r.studentId), ['20601']);

  // 다른 반 비밀번호로는 못 들어간다
  assert.match(s.err('adminList', { cls: 6, adminPassword: 'teacher7' }), /6반 관리자 비밀번호가 틀렸습니다/);
  assert.match(s.err('adminGetSettings', { cls: 7, adminPassword: 'teacher6' }), /틀렸습니다/);
  assert.match(s.err('adminSaveSettings', { cls: 7, adminPassword: 'teacher6', settings: {} }), /틀렸습니다/);
  // 마스터 비밀번호도 담임 화면에는 못 쓴다 (보기 + 비밀번호 관리만)
  assert.match(s.err('adminList', { cls: 6, adminPassword: MASTER }), /틀렸습니다/);
  // 아직 비밀번호를 정하지 않은 반
  assert.match(s.err('adminList', { cls: 3, adminPassword: 'anything' }), /아직 정해지지 않았습니다/);
});

test('담임은 자기 반 예약만 취소할 수 있다', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(7, 1), date: '2026-10-19', slot: 'MORNING' });
  const [b6] = s.ok('adminList', { cls: 6, adminPassword: 'teacher6' });
  const [b7] = s.ok('adminList', { cls: 7, adminPassword: 'teacher7' });

  assert.match(s.err('adminCancel', { cls: 6, adminPassword: 'teacher6', id: b7.id }), /찾을 수 없습니다/);
  assert.match(s.err('adminCancel', { cls: 7, adminPassword: 'teacher6', id: b7.id }), /틀렸습니다/);
  s.ok('adminCancel', { cls: 6, adminPassword: 'teacher6', id: b6.id });
  assert.match(s.err('adminCancel', { cls: 6, adminPassword: 'teacher6', id: b6.id }), /이미 취소/);

  assert.equal(slotStatus(s, 6, '2026-10-19', 'MORNING'), 'open');
  assert.equal(slotStatus(s, 7, '2026-10-19', 'MORNING'), 'booked');
  const all = s.ok('adminList', { cls: 6, adminPassword: 'teacher6', all: true });
  assert.equal(all[0].status, '취소');
  assert.match(all[0].updatedAt, /담임 취소/);
});

test('담임이 시간대 한 칸을 막고 다시 열 수 있다 (자기 반만)', () => {
  const s = setup();
  const t6 = { cls: 6, adminPassword: 'teacher6' };
  s.ok('adminBlock', { ...t6, date: '2026-10-22', slot: 'LUNCH' });
  assert.equal(slotStatus(s, 6, '2026-10-22', 'LUNCH'), 'blocked');
  assert.equal(slotStatus(s, 7, '2026-10-22', 'LUNCH'), 'open');
  assert.match(s.err('book', { ...student(6, 1), date: '2026-10-22', slot: 'LUNCH' }), /예약을 받지 않는 시간/);
  s.ok('book', { ...student(7, 1), date: '2026-10-22', slot: 'LUNCH' });

  // 다른 시간으로 변경하는 것도 막힌다
  s.ok('book', { ...student(6, 2), date: '2026-10-21', slot: 'LUNCH' });
  const [mine] = s.ok('myBookings', student(6, 2));
  assert.match(s.err('modify', { ...student(6, 2), id: mine.id, date: '2026-10-22', slot: 'LUNCH' }), /예약을 받지 않는/);

  // 예약 있는 칸·없는 시간·다른 반 비번은 거절
  assert.match(s.err('adminBlock', { ...t6, date: '2026-10-21', slot: 'LUNCH' }), /먼저 예약을 취소/);
  assert.match(s.err('adminBlock', { ...t6, date: '2026-10-20', slot: 'AFTER_EARLY' }), /막을 수 없는/); // 화요일엔 없는 시간대
  assert.match(s.err('adminBlock', { cls: 7, adminPassword: 'teacher6', date: '2026-10-22', slot: 'MORNING' }), /틀렸습니다/);

  // 설정 탭 저장(막은 칸 없이 보냄)에도 막은 칸은 그대로
  const { blocked, ...st } = s.ok('adminGetSettings', t6);
  assert.deepEqual(blocked, [{ date: '2026-10-22', slot: 'LUNCH' }]);
  s.ok('adminSaveSettings', { ...t6, settings: { ...st, title: '바꿈' } });
  assert.equal(slotStatus(s, 6, '2026-10-22', 'LUNCH'), 'blocked');

  // 다시 열기
  s.ok('adminBlock', { ...t6, date: '2026-10-22', slot: 'LUNCH', blocked: false });
  assert.equal(slotStatus(s, 6, '2026-10-22', 'LUNCH'), 'open');
  s.ok('book', { ...student(6, 1), date: '2026-10-22', slot: 'LUNCH' });
});

test('시간대 끝나는 시각은 선택, 있으면 시작보다 늦어야 한다', () => {
  const s = setup();
  const t6 = { cls: 6, adminPassword: 'teacher6' };
  const st = s.ok('adminGetSettings', t6);
  assert.equal(st.slots[0].end, '');
  const withEnd = (end) => ({ ...st, slots: st.slots.map((x) => (x.key === 'MORNING' ? { ...x, end } : x)) });

  assert.match(s.err('adminSaveSettings', { ...t6, settings: withEnd('08:10') }), /끝나는 시각은 시작 시각보다 늦어야/);
  s.ok('adminSaveSettings', { ...t6, settings: withEnd('08:40') });
  assert.deepEqual(s.ok('availability', { cls: 6 }).slots.MORNING, { label: '아침', start: '08:20', end: '08:40' });
  assert.equal(s.ok('availability', { cls: 7 }).slots.MORNING.end, '');

  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(6, 2), date: '2026-10-19', slot: 'LUNCH' });
  const rows = s.sheet('예약').data.slice(1).map((r) => r[4]);
  assert.deepEqual(rows, ['아침 (08:20~08:40)', '점심시간 (13:30~)']);
});

test('담임 비밀번호 변경, 잠금은 반마다 따로', () => {
  const s = setup();
  assert.match(s.err('adminChangePassword', { cls: 6, adminPassword: 'teacher6', newPassword: '123' }), /6~30자/);
  s.ok('adminChangePassword', { cls: 6, adminPassword: 'teacher6', newPassword: 'new-pw-6' });
  s.err('adminList', { cls: 6, adminPassword: 'teacher6' });
  s.ok('adminList', { cls: 6, adminPassword: 'new-pw-6' });

  for (let i = 0; i < 5; i++) s.err('adminList', { cls: 6, adminPassword: 'x' });
  assert.match(s.err('adminList', { cls: 6, adminPassword: 'new-pw-6' }), /분 동안 접속할 수 없습니다/);
  s.ok('adminList', { cls: 7, adminPassword: 'teacher7' }); // 7반은 영향 없음

  // 학년 관리에서 다시 정하면 잠금도 풀린다
  s.ok('masterSetPassword', { masterPassword: MASTER, cls: 6, newPassword: 'reset-pw-6' });
  s.ok('adminList', { cls: 6, adminPassword: 'reset-pw-6' });
});

test('학년 관리: 전 반 현황 보기, 마스터 비밀번호 확인', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(6, 2), date: '2026-10-19', slot: 'LUNCH' });
  s.ok('book', { ...student(1, 9), date: '2026-10-20', slot: 'AFTER' });

  assert.match(s.err('masterOverview', { masterPassword: 'teacher6' }), /학년 관리 비밀번호가 틀렸습니다/);
  assert.match(s.err('masterSetPassword', { masterPassword: 'teacher6', cls: 6, newPassword: 'hijack-pw' }), /틀렸습니다/);

  const o = s.ok('masterOverview', { masterPassword: MASTER });
  assert.equal(o.classes.length, 10);
  const by = Object.fromEntries(o.classes.map((c) => [c.cls, c]));
  assert.equal(by[6].bookings.length, 2);
  assert.equal(by[1].bookings[0].studentId, '20109');
  assert.equal(by[2].bookings.length, 0);
  assert.equal(by[6].hasPassword, true);
  assert.equal(by[2].hasPassword, false);
  assert.equal(by[6].title, '매홀고 2-6 상담 예약');

  const none = loadServer();
  assert.match(none.err('masterOverview', { masterPassword: '' }), /MASTER_PASSWORD/);
});

test('설정 저장: 반마다 따로, 없어지는 예약은 확인 후 취소', () => {
  const s = setup();
  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'MORNING' });
  s.ok('book', { ...student(7, 1), date: '2026-10-19', slot: 'MORNING' });

  const st = s.ok('adminGetSettings', { cls: 6, adminPassword: 'teacher6' });
  const next = {
    ...st,
    title: '6반 담임과 상담',
    slots: st.slots.map((x) => (x.key === 'MORNING' ? { ...x, days: [2, 3, 4, 5] } : x)), // 월요일 아침 없앰
  };

  const first = s.ok('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: next });
  assert.equal(first.saved, false);
  assert.deepEqual(first.conflicts.map((c) => [c.studentId, c.date, c.slotText]), [['20601', '2026-10-19', '아침 08:20~']]);
  assert.equal(s.ok('availability', { cls: 6 }).title, '매홀고 2-6 상담 예약'); // 아직 저장 안 됨

  const second = s.ok('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: next, confirmCancel: true });
  assert.equal(second.saved, true);
  assert.equal(second.cancelled, 1);

  const a6 = s.ok('availability', { cls: 6 });
  assert.equal(a6.title, '6반 담임과 상담');
  assert.ok(!a6.days.find((d) => d.date === '2026-10-19').slots.some((x) => x.key === 'MORNING'));

  // 7반은 그대로
  const a7 = s.ok('availability', { cls: 7 });
  assert.equal(a7.title, '매홀고 2-7 상담 예약');
  assert.equal(slotStatus(s, 7, '2026-10-19', 'MORNING'), 'booked');
  assert.equal(s.ok('adminList', { cls: 7, adminPassword: 'teacher7' }).length, 1);
  assert.equal(s.ok('adminList', { cls: 6, adminPassword: 'teacher6' }).length, 0);

  // 잘못된 설정은 거절
  assert.match(s.err('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: { ...next, slots: [] } }), /하나 이상/);
  const bad = (settings) => s.err('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: { ...next, ...settings } });
  assert.match(bad({ endDate: '' }), /끝 날짜를 정해/);
  assert.match(bad({ startDate: '2026-10-25', endDate: '2026-10-22' }), /시작 날짜보다 빠릅니다/);
  assert.match(bad({ endDate: '2026-10-01' }), /이미 지났습니다/);
  assert.match(bad({ endDate: '2028-01-01' }), /1년 안/);
});

test('예약 기간: 처음엔 오늘부터 4주, 시작·끝 날짜로 정한다', () => {
  const s = setup();
  const st = s.ok('adminGetSettings', { cls: 6, adminPassword: 'teacher6' });
  assert.equal(st.startDate, '2026-10-19');
  assert.equal(st.endDate, '2026-11-16');

  s.ok('book', { ...student(6, 1), date: '2026-10-19', slot: 'LUNCH' });
  // 다음 주부터 받도록 바꾸면 이번 주 예약은 충돌
  const next = { ...st, startDate: '2026-10-26', endDate: '2026-10-30' };
  const res = s.ok('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: next });
  assert.deepEqual(res.conflicts.map((c) => c.date), ['2026-10-19']);
  s.ok('adminSaveSettings', { cls: 6, adminPassword: 'teacher6', settings: next, confirmCancel: true });

  const a6 = s.ok('availability', { cls: 6 });
  assert.equal(a6.days[0].date, '2026-10-26');
  assert.equal(a6.days.at(-1).date, '2026-10-30');
  assert.match(s.err('book', { ...student(6, 1), date: '2026-10-23', slot: 'LUNCH' }), /예약할 수 없는 날짜/);
  s.ok('book', { ...student(6, 1), date: '2026-10-26', slot: 'LUNCH' });

  // 시작 날짜가 지나가면 오늘로 보인다
  const later = loadServer({ now: '2026-10-28T07:00', props: Object.fromEntries(s.properties) });
  assert.equal(later.ok('adminGetSettings', { cls: 6, adminPassword: 'teacher6' }).startDate, '2026-10-28');
});

test('예전 형식(daysAhead·lastDate)으로 저장된 설정도 읽는다', () => {
  const old = { title: '예전', notice: '', daysAhead: 28, lastDate: '2026-11-06', slots: [{ key: 'A', label: '아침', start: '08:20', days: [1] }], closedDates: [] };
  const s = loadServer({ props: { SETTINGS_6: JSON.stringify(old) } });
  const a = s.ok('availability', { cls: 6 });
  assert.equal(a.days[0].date, '2026-10-19');
  assert.equal(a.days.at(-1).date, '2026-11-02'); // 11/6 전 마지막 월요일
});

test('설정의 휴무일·끝 날짜는 그 반에만 적용된다', () => {
  const s = setup();
  const st = s.ok('adminGetSettings', { cls: 6, adminPassword: 'teacher6' });
  s.ok('adminSaveSettings', {
    cls: 6, adminPassword: 'teacher6',
    settings: { ...st, endDate: '2026-10-22', closedDates: [{ date: '2026-10-20', reason: '모의고사' }] },
  });
  const a6 = s.ok('availability', { cls: 6 });
  assert.equal(a6.days.at(-1).date, '2026-10-22');
  assert.equal(a6.days.find((d) => d.date === '2026-10-20').holiday, '모의고사');
  assert.match(s.err('book', { ...student(6, 1), date: '2026-10-20', slot: 'LUNCH' }), /휴무일/);
  assert.match(s.err('book', { ...student(6, 1), date: '2026-10-23', slot: 'LUNCH' }), /예약할 수 없는 날짜/);

  s.ok('book', { ...student(7, 1), date: '2026-10-20', slot: 'LUNCH' });
  s.ok('book', { ...student(7, 1), date: '2026-10-23', slot: 'LUNCH' });
});

test("시트 '휴무일' 탭: 반을 비우면 학년 전체, 적으면 그 반만", () => {
  const s = setup();
  s.ok('availability', { cls: 1 }); // 시트 생성
  const hol = s.sheet('휴무일');
  hol.set(2, 1, '2026-10-21'); hol.set(2, 2, '체험학습'); hol.set(2, 3, '6반');
  hol.set(3, 1, '2026-10-22'); hol.set(3, 2, '학년 행사'); hol.set(3, 3, '');

  const h = (cls, date) => s.ok('availability', { cls }).days.find((d) => d.date === date).holiday;
  assert.equal(h(6, '2026-10-21'), '체험학습');
  assert.equal(h(7, '2026-10-21'), null);
  assert.equal(h(6, '2026-10-22'), '학년 행사');
  assert.equal(h(7, '2026-10-22'), '학년 행사');
});

test('GET 은 빈자리 조회만 허용', () => {
  const s = setup();
  const get = (parameter) => s.context.doGet({ parameter }).text;
  assert.equal(JSON.parse(get({ action: 'availability', cls: '6' })).data.cls, 6);
  assert.match(get({ action: 'adminList', cls: '6', adminPassword: 'teacher6' }), /동작 중/);
});
