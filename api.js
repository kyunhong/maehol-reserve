// 예약 화면(app.js), 담임 관리(admin.js), 학년 관리(grade.js)가 함께 쓰는 서버 호출.
// config.js 에 API_URL 이 없으면 브라우저 localStorage 에 저장하는 데모 서버를 쓴다.
(() => {
  const CFG = window.APP_CONFIG || {};
  const GRADE = CFG.GRADE || 2;
  const CLASS_COUNT = CFG.CLASS_COUNT || 10;

  async function remoteApi(action, params = {}) {
    // Content-Type 을 지정하지 않아 text/plain 으로 전송 → CORS preflight 없이 Apps Script 호출 가능
    const res = await fetch(CFG.API_URL, {
      method: 'POST',
      body: JSON.stringify({ action, ...params }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '요청에 실패했습니다.');
    return json.data;
  }

  // ===================== 데모 서버 =====================
  // apps-script/Code.gs 와 같은 규칙으로 동작한다 (비밀번호 확인만 생략)
  const defaultSettings = (cls) => ({
    title: `매홀고 ${GRADE}-${cls} 상담 예약`,
    notice: '비어 있는 시간을 눌러 예약하세요. 예약할 때 정한 비밀번호로 취소·변경할 수 있어요.',
    startDate: addDays(0),
    endDate: addDays(28),
    slots: [
      { key: 'MORNING', label: '아침', start: '08:20', days: [1, 2, 3, 4, 5] },
      { key: 'LUNCH', label: '점심시간', start: '13:30', days: [1, 2, 3, 4, 5] },
      { key: 'AFTER_EARLY', label: '방과후', start: '16:10', days: [1, 5] },
      { key: 'AFTER', label: '방과후', start: '17:10', days: [2, 3, 4] },
    ],
    closedDates: [],
  });
  const BOOKINGS_KEY = 'grade-counsel-demo-bookings';
  const SETTINGS_KEY = (cls) => `grade-counsel-demo-settings-${cls}`;
  const PASSWORDS_KEY = 'grade-counsel-demo-admin';
  const ACTIVE = '예약';

  const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch { return fallback; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stamp = () => { const d = new Date(); return `${fmt(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const weekdayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
  const fail = (m) => { throw new Error(m); };
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); }

  function demoServer() {
    const cleanClass = (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > CLASS_COUNT) fail('반을 다시 선택해 주세요.');
      return n;
    };
    const cleanStudentId = (v, cls) => {
      const s = String(v || '').trim();
      const example = `${GRADE}${pad(cls)}01`;
      if (!/^\d{5}$/.test(s) || Number(s.slice(3)) < 1) fail(`학번은 숫자 5자리로 입력해 주세요. (예: ${example})`);
      if (Number(s[0]) !== GRADE) fail(`${GRADE}학년 학번이 아닙니다. (예: ${example})`);
      const own = Number(s.slice(1, 3));
      if (own !== cls) {
        fail(own >= 1 && own <= CLASS_COUNT
          ? `학번을 보면 ${own}반 학생이에요. ${own}반 예약 화면에서 예약해 주세요.`
          : `학번을 다시 확인해 주세요. (예: ${example})`);
      }
      return s;
    };
    const settings = (cls) => {
      const st = { ...defaultSettings(cls), ...read(SETTINGS_KEY(cls), {}) };
      if (!st.endDate) st.endDate = defaultSettings(cls).endDate; // 예전 형식 데모 설정
      if (!st.startDate || st.startDate < addDays(0)) st.startDate = addDays(0);
      return st;
    };
    const slotMap = (st) => Object.fromEntries(st.slots.map((s) => [s.key, { label: s.label, start: s.start, end: s.end || '' }]));
    const isBlocked = (st, date, slot) => (st.blocked || []).some((b) => b.date === date && b.slot === slot);
    const daySlots = (st, wd) => st.slots.filter((s) => s.days.includes(wd)).map((s) => s.key);
    const holidays = (st) => Object.fromEntries(st.closedDates.map((c) => [c.date, c.reason]));
    const now = () => { const d = new Date(); return { today: fmt(d), nowHm: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
    const dates = (st) => {
      const out = [];
      for (let i = 0; i <= 365; i++) {
        const d = new Date(); d.setDate(d.getDate() + i);
        const date = fmt(d);
        if (date > st.endDate) break;
        if (date < st.startDate) continue;
        out.push({ date, weekday: d.getDay() });
      }
      return out;
    };
    const classRows = (rows, cls) => rows.filter((r) => r.cls === cls);
    const check = (cls, date, slot, rows, exceptId) => {
      const st = settings(cls); const map = slotMap(st);
      if (!map[slot]) fail('시간대를 다시 선택해 주세요.');
      const day = dates(st).find((d) => d.date === date) || fail('예약할 수 없는 날짜입니다.');
      if (!daySlots(st, day.weekday).includes(slot)) fail('해당 요일에는 그 시간대 상담이 없습니다.');
      if (holidays(st)[date]) fail('휴무일에는 예약할 수 없습니다.');
      if (isBlocked(st, date, slot)) fail('예약을 받지 않는 시간입니다. 다른 시간을 선택해 주세요.');
      const { today, nowHm } = now();
      if (date === today && nowHm >= map[slot].start) fail('이미 지난 시간대입니다.');
      if (classRows(rows, cls).some((r) => r.status === ACTIVE && r.date === date && r.slot === slot && r.id !== exceptId)) {
        fail('이미 예약된 시간입니다. 다른 시간을 선택해 주세요.');
      }
    };
    const sortRows = (rows) => {
      const key = (r) => { const map = slotMap(settings(r.cls)); return r.date + (map[r.slot] ? map[r.slot].start : r.slot); };
      return rows.sort((a, b) => key(a).localeCompare(key(b)));
    };
    const mine = (p, rows) => {
      const cls = cleanClass(p.cls);
      const studentId = cleanStudentId(p.studentId, cls);
      const list = classRows(rows, cls).filter((r) => r.studentId === studentId && r.password === p.password
        && r.status === ACTIVE && r.date >= now().today);
      if (!list.length) fail('학번과 비밀번호가 일치하는 예약이 없습니다.');
      return sortRows(list);
    };
    const strip = ({ password, ...r }) => ({ createdAt: '', updatedAt: '', ...r });
    const adminPw = (pw) => { if (String(pw || '').length < 6) fail('관리자 비밀번호는 6~30자로 정해 주세요.'); };

    return {
      availability(p) {
        const cls = cleanClass(p.cls);
        const st = settings(cls); const map = slotMap(st); const hol = holidays(st);
        const rows = classRows(read(BOOKINGS_KEY, []), cls); const { today, nowHm } = now();
        const days = dates(st).map((d) => ({
          date: d.date, weekday: d.weekday, holiday: hol[d.date] || null,
          slots: daySlots(st, d.weekday).map((key) => ({
            key,
            status: hol[d.date] || (d.date === today && nowHm >= map[key].start) ? 'closed'
              : rows.some((r) => r.status === ACTIVE && r.date === d.date && r.slot === key) ? 'booked'
                : isBlocked(st, d.date, key) ? 'blocked' : 'open',
          })),
        })).filter((d) => d.slots.length);
        return { cls, today, title: st.title, notice: st.notice, slots: map, days };
      },
      book(p) {
        const cls = cleanClass(p.cls);
        const studentId = cleanStudentId(p.studentId, cls);
        if (!/^[가-힣a-zA-Z ]{1,20}$/.test(String(p.name).trim())) fail('이름은 한글/영문 20자 이내로 입력해 주세요.');
        if (String(p.password).length < 4) fail('비밀번호는 4~20자로 입력해 주세요.');
        const rows = read(BOOKINGS_KEY, []); check(cls, p.date, p.slot, rows, null);
        const id = Math.random().toString(36).slice(2, 12);
        rows.push({ id, cls, date: p.date, slot: p.slot, studentId, name: String(p.name).trim(),
          password: p.password, status: ACTIVE, createdAt: stamp(), updatedAt: '' });
        write(BOOKINGS_KEY, rows); return { id };
      },
      myBookings(p) { return mine(p, read(BOOKINGS_KEY, [])).map(strip); },
      cancel(p) {
        const rows = read(BOOKINGS_KEY, []);
        const t = mine(p, rows).find((r) => r.id === p.id) || fail('예약을 찾을 수 없습니다.');
        t.status = '취소'; t.updatedAt = stamp(); write(BOOKINGS_KEY, rows); return { id: t.id };
      },
      modify(p) {
        const rows = read(BOOKINGS_KEY, []);
        const t = mine(p, rows).find((r) => r.id === p.id) || fail('예약을 찾을 수 없습니다.');
        check(t.cls, p.date, p.slot, rows, t.id);
        t.date = p.date; t.slot = p.slot; t.updatedAt = stamp(); write(BOOKINGS_KEY, rows); return { id: t.id };
      },
      // 데모에서는 관리자 비밀번호를 검사하지 않는다
      adminList(p) {
        const cls = cleanClass(p.cls);
        const { today } = now();
        return sortRows(classRows(read(BOOKINGS_KEY, []), cls)
          .filter((r) => p.all || (r.status === ACTIVE && r.date >= today))).map(strip);
      },
      adminBlockMany(p) {
        const cls = cleanClass(p.cls);
        const st = settings(cls);
        const block = p.blocked !== false;
        if (!p.slots.length) fail('시간대를 하나 이상 골라 주세요.');
        if (!p.days.length) fail('요일을 하나 이상 골라 주세요.');
        if (p.from && p.to && p.to < p.from) fail('기간의 끝 날짜가 시작 날짜보다 빠릅니다.');
        const hol = holidays(st);
        const booked = new Map(classRows(read(BOOKINGS_KEY, []), cls).filter((r) => r.status === ACTIVE).map((r) => [`${r.date}|${r.slot}`, r]));
        const target = new Set();
        const skipped = [];
        for (const d of dates(st)) {
          if ((p.from && d.date < p.from) || (p.to && d.date > p.to) || !p.days.includes(d.weekday) || hol[d.date]) continue;
          for (const k of daySlots(st, d.weekday).filter((x) => p.slots.includes(x))) {
            const key = `${d.date}|${k}`;
            if (block && booked.has(key)) skipped.push(strip(booked.get(key)));
            else target.add(key);
          }
        }
        const before = new Set((st.blocked || []).map((b) => `${b.date}|${b.slot}`));
        const changed = [...target].filter((key) => before.has(key) !== block).length;
        st.blocked = (st.blocked || []).filter((b) => !target.has(`${b.date}|${b.slot}`));
        if (block) target.forEach((key) => { const [date, slot] = key.split('|'); st.blocked.push({ date, slot }); });
        write(SETTINGS_KEY(cls), st);
        return { blocked: block, changed, skipped };
      },
      adminBlock(p) {
        const cls = cleanClass(p.cls);
        const st = settings(cls);
        const block = p.blocked !== false;
        st.blocked = (st.blocked || []).filter((b) => !(b.date === p.date && b.slot === p.slot));
        if (block) {
          const day = dates(st).find((d) => d.date === p.date);
          if (!day || !daySlots(st, day.weekday).includes(p.slot)) fail('막을 수 없는 시간입니다. 새로고침해 주세요.');
          if (classRows(read(BOOKINGS_KEY, []), cls).some((r) => r.status === ACTIVE && r.date === p.date && r.slot === p.slot)) {
            fail('예약이 있는 시간입니다. 먼저 예약을 취소해 주세요.');
          }
          st.blocked.push({ date: p.date, slot: p.slot });
        }
        write(SETTINGS_KEY(cls), st);
        return { date: p.date, slot: p.slot, blocked: block };
      },
      adminCancel(p) {
        const cls = cleanClass(p.cls);
        const rows = read(BOOKINGS_KEY, []);
        const t = classRows(rows, cls).find((r) => r.id === p.id && r.status === ACTIVE)
          || fail('예약을 찾을 수 없습니다. 이미 취소되었을 수 있어요. 새로고침해 주세요.');
        t.status = '취소'; t.updatedAt = `${stamp()} (담임 취소)`; write(BOOKINGS_KEY, rows); return { id: t.id };
      },
      adminGetSettings(p) { return settings(cleanClass(p.cls)); },
      adminSaveSettings(p) {
        const cls = cleanClass(p.cls);
        const next = JSON.parse(JSON.stringify(p.settings));
        if (!Array.isArray(next.blocked)) next.blocked = settings(cls).blocked || []; // 설정 탭은 막은 칸을 보내지 않음
        if (!next.slots.length) fail('상담 시간대를 하나 이상 만들어 주세요.');
        const today = addDays(0);
        if (!next.startDate || next.startDate < today) next.startDate = today;
        if (!next.endDate) fail('예약 끝 날짜를 정해 주세요.');
        if (next.endDate < next.startDate) fail(next.endDate < today ? '예약 끝 날짜가 이미 지났습니다.' : '예약 끝 날짜가 시작 날짜보다 빠릅니다.');
        if (next.endDate > addDays(365)) fail('예약 끝 날짜는 오늘부터 1년 안으로 정해 주세요.');
        delete next.daysAhead; delete next.lastDate;
        next.title = next.title || defaultSettings(cls).title;
        next.slots.forEach((s, i) => {
          if (!s.label) fail(`${i + 1}번째 시간대의 이름을 입력해 주세요.`);
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start)) fail(`${s.label} 시간대의 시작 시각을 다시 확인해 주세요.`);
          s.end = s.end || '';
          if (s.end && s.end <= s.start) fail(`${s.label} 시간대의 끝나는 시각은 시작 시각보다 늦어야 합니다.`);
          if (!s.key) s.key = 'S' + Math.random().toString(16).slice(2, 10);
        });
        next.slots.sort((a, b) => a.start.localeCompare(b.start));
        next.closedDates = next.closedDates.filter((c) => c.date)
          .map((c) => ({ date: c.date, reason: c.reason || '휴무' }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const closed = new Set(next.closedDates.map((c) => c.date));
        const rows = read(BOOKINGS_KEY, []);
        const conflicts = classRows(rows, cls).filter((r) => {
          if (r.status !== ACTIVE || r.date < today) return false;
          const s = next.slots.find((x) => x.key === r.slot);
          return !s || !s.days.includes(weekdayOf(r.date)) || r.date < next.startDate || r.date > next.endDate || closed.has(r.date);
        });
        if (conflicts.length && !p.confirmCancel) {
          const old = slotMap(settings(cls));
          return { saved: false, conflicts: conflicts.map((r) => ({ ...strip(r), slotText: old[r.slot] ? `${old[r.slot].label} ${old[r.slot].start}~${old[r.slot].end}` : r.slot })) };
        }
        conflicts.forEach((r) => { r.status = '취소'; r.updatedAt = `${stamp()} (설정 변경으로 취소)`; });
        write(BOOKINGS_KEY, rows);
        write(SETTINGS_KEY(cls), next);
        return { saved: true, cancelled: conflicts.length, settings: next };
      },
      adminChangePassword(p) { return this.masterSetPassword(p); },
      masterOverview() {
        const { today } = now();
        const rows = read(BOOKINGS_KEY, []);
        const hasPw = read(PASSWORDS_KEY, []);
        return {
          today,
          classes: Array.from({ length: CLASS_COUNT }, (_, i) => i + 1).map((cls) => {
            const st = settings(cls);
            return {
              cls, title: st.title, startDate: st.startDate, endDate: st.endDate, hasPassword: hasPw.includes(cls), slots: slotMap(st),
              bookings: sortRows(classRows(rows, cls).filter((r) => r.status === ACTIVE && r.date >= today)).map(strip),
            };
          }),
        };
      },
      masterSetPassword(p) {
        const cls = cleanClass(p.cls);
        adminPw(p.newPassword);
        write(PASSWORDS_KEY, [...new Set([...read(PASSWORDS_KEY, []), cls])]);
        return { cls };
      },
    };
  }

  const demo = demoServer();
  async function demoApi(action, params = {}) {
    await new Promise((r) => setTimeout(r, 150));
    if (!demo[action]) throw new Error('알 수 없는 요청입니다.');
    return demo[action](params);
  }

  /** 주소의 ?반=6 (또는 ?class=6) 을 읽는다. 없거나 잘못되면 null */
  function classFromUrl() {
    const q = new URLSearchParams(location.search);
    const n = Number(q.get('반') || q.get('class'));
    return Number.isInteger(n) && n >= 1 && n <= CLASS_COUNT ? n : null;
  }

  /** 학생용 예약 링크 (예: https://…/?반=6) */
  function studentLink(cls) {
    return decodeURI(new URL(`./?반=${cls}`, location.href).href); // 공유할 때 %EB%B0%98 대신 '반'이 보이도록
  }

  window.CounselApi = {
    isDemo: !CFG.API_URL,
    call: CFG.API_URL ? remoteApi : demoApi,
    GRADE,
    CLASS_COUNT,
    classFromUrl,
    studentLink,
  };
})();
