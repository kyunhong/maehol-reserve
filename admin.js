(() => {
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const LOGIN_KEY = 'grade-counsel-admin-login'; // sessionStorage: { cls, password } (탭을 닫으면 사라짐)
  const VIEW_KEY = 'grade-counsel-admin-view';
  const CLASS_KEY = 'grade-counsel-admin-class'; // localStorage: 마지막으로 고른 반
  const $ = (id) => document.getElementById(id);
  const state = { cls: null, password: null, avail: null, rows: [], view: 'calendar', settings: null };
  const DAY_NAMES = ['월', '화', '수', '목', '금'];
  const { CLASS_COUNT } = window.CounselApi;

  // 모든 요청에 지금 관리하는 반 번호를 붙인다 (서버가 그 반 비밀번호인지 확인)
  const api = (action, params = {}) => window.CounselApi.call(action, { cls: state.cls, ...params });

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
    clear(k) { try { sessionStorage.removeItem(k); } catch {} },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dateLabel = (s) => { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`; };
  const shortDate = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const slotLabel = (key) => { const s = state.avail && state.avail.slots[key]; return s ? `${s.label} ${s.start}~` : key; };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = v;
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  async function load() {
    $('listMsg').textContent = '';
    $('refresh').disabled = true;
    try {
      const [avail, rows] = await Promise.all([
        api('availability'),
        api('adminList', { adminPassword: state.password, all: $('showAll').checked }),
      ]);
      state.avail = avail;
      state.rows = rows;
      render();
      return true;
    } catch (err) {
      $('listMsg').textContent = err.message;
      return false;
    } finally {
      $('refresh').disabled = false;
    }
  }

  function render() {
    const { view } = state;
    $('viewCalendar').setAttribute('aria-pressed', view === 'calendar');
    $('viewList').setAttribute('aria-pressed', view === 'list');
    $('viewSettings').setAttribute('aria-pressed', view === 'settings');
    $('showAllWrap').hidden = view !== 'list';
    $('refresh').hidden = view === 'settings';
    $('summary').hidden = view === 'settings';
    $('list').hidden = view === 'settings';
    $('settingsPanel').hidden = view !== 'settings';
    $('pwPanel').hidden = view !== 'settings';
    if (view === 'calendar') renderCalendar();
    else if (view === 'list') renderList();
    else if (!state.settings) loadSettings();
  }

  // ===================== 달력 보기 =====================
  function renderCalendar() {
    const { days, today } = state.avail;
    const active = state.rows.filter((r) => r.status === '예약' && r.date >= today);
    const byKey = new Map(active.map((r) => [`${r.date}|${r.slot}`, r]));
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const total = days.reduce((n, d) => n + d.slots.length, 0);
    const range = days.length ? `${shortDate(days[0].date)} ~ ${shortDate(days[days.length - 1].date)}` : '없음';
    $('summary').textContent = `예약 기간 ${range} · 예약 ${active.length}건 / 전체 ${total}칸`;

    const list = $('list');
    list.innerHTML = '';
    if (!days.length) { list.append(el('div', { class: 'loading' }, '예약 가능한 날짜가 없습니다.')); return; }

    const cal = el('div', { class: 'admin-cal' });
    cal.append(el('div', { class: 'grid head' }, ...['월', '화', '수', '목', '금'].map((d) => el('div', { class: 'dow' }, d))));

    const monday = parse(days[0].date); // 예약 기간 첫날이 있는 주부터
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const last = parse(days[days.length - 1].date);

    for (; monday <= last; monday.setDate(monday.getDate() + 7)) {
      const week = el('div', { class: 'grid week' });
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday); d.setDate(d.getDate() + i);
        const date = fmt(d);
        const info = byDate[date];
        const label = `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
        if (!info) { week.append(el('div', { class: 'day blank' }, el('span', { class: 'date' }, label))); continue; }

        const taken = info.slots.filter((s) => byKey.has(`${date}|${s.key}`)).length;
        const cell = el('div', { class: 'day' + (date === today ? ' today' : '') },
          el('div', { class: 'day-head' },
            el('span', { class: 'date' }, label),
            taken ? el('span', { class: 'count' }, `${taken}건`) : null));
        if (info.holiday) cell.append(el('span', { class: 'note' }, info.holiday));

        for (const s of info.slots) {
          const meta = state.avail.slots[s.key];
          const r = byKey.get(`${date}|${s.key}`);
          const cls = r ? 'taken' : s.status === 'closed' ? 'closed' : 'free';
          cell.append(el('div', { class: `aslot ${cls}`, title: `${dateLabel(date)} ${slotLabel(s.key)}` },
            el('span', { class: 't' }, `${meta.start} ${meta.label}`),
            el('span', { class: 'who' }, r ? `${r.studentId} ${r.name}` : cls === 'closed' ? '마감' : '비어 있음')));
        }
        week.append(cell);
      }
      cal.append(week);
    }
    list.append(cal);
  }

  // ===================== 목록 보기 =====================
  function renderList() {
    const rows = state.rows;
    const list = $('list');
    list.innerHTML = '';
    const active = rows.filter((r) => r.status === '예약').length;
    $('summary').textContent = $('showAll').checked
      ? `전체 ${rows.length}건 (유효 ${active}건)`
      : `다가오는 예약 ${rows.length}건`;
    if (!rows.length) {
      list.append(el('div', { class: 'loading' }, '예약이 없습니다.'));
      return;
    }
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.date)) groups.set(r.date, []);
      groups.get(r.date).push(r);
    }
    for (const [date, items] of groups) {
      const tbody = el('tbody');
      for (const r of items) {
        tbody.append(el('tr', { class: r.status === '예약' ? '' : 'cancelled' },
          el('td', {}, slotLabel(r.slot)),
          el('td', {}, r.studentId),
          el('td', {}, r.name),
          el('td', {}, r.status === '예약' ? el('span', { class: 'tag' }, '예약') : r.status),
          el('td', {}, r.createdAt || ''),
          el('td', {}, r.updatedAt || '')));
      }
      list.append(el('div', { class: 'day-group' },
        el('h3', {}, `${dateLabel(date)} · ${items.length}건`),
        el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, ...['시간', '학번', '이름', '상태', '신청일시', '수정일시'].map((h) => el('th', {}, h)))),
            tbody))));
    }
  }

  // ===================== 설정 =====================
  async function loadSettings() {
    setStMsg('불러오는 중…', '');
    try {
      state.settings = await api('adminGetSettings', { adminPassword: state.password });
      fillSettings(state.settings);
      setStMsg('', '');
    } catch (err) {
      setStMsg(err.message);
    }
  }

  function setStMsg(text, kind = 'err') {
    $('stMsg').className = `msg ${kind}`;
    $('stMsg').textContent = text;
  }

  function fillSettings(st) {
    $('stTitle').value = st.title || '';
    $('stNotice').value = st.notice || '';
    $('stStartDate').value = st.startDate;
    $('stEndDate').value = st.endDate;
    $('stEndDate').min = st.startDate;
    $('stSlots').innerHTML = '';
    st.slots.forEach(addSlotRow);
    $('stClosed').innerHTML = '';
    st.closedDates.forEach(addClosedRow);
  }

  function addSlotRow(s = { key: '', label: '', start: '', days: [1, 2, 3, 4, 5] }) {
    const tr = el('tr', { 'data-key': s.key || '' },
      el('td', {}, el('input', { class: 'st-label', value: s.label, maxlength: 20, placeholder: '예) 점심시간', 'aria-label': '시간대 이름' })),
      el('td', {}, el('input', { class: 'st-start', type: 'time', value: s.start, 'aria-label': '시작 시각' })),
      ...DAY_NAMES.map((name, i) => el('td', { class: 'center' },
        el('input', { type: 'checkbox', class: 'st-day', value: i + 1, checked: s.days.includes(i + 1), 'aria-label': `${name}요일` }))),
      el('td', {}, el('button', { type: 'button', class: 'btn small danger', onclick: () => tr.remove() }, '삭제')));
    $('stSlots').append(tr);
    return tr;
  }

  function addClosedRow(c = { date: '', reason: '' }) {
    const tr = el('tr', {},
      el('td', {}, el('input', { class: 'st-date', type: 'date', value: c.date, 'aria-label': '날짜' })),
      el('td', {}, el('input', { class: 'st-reason', value: c.reason, maxlength: 30, placeholder: '예) 모의고사', 'aria-label': '사유' })),
      el('td', {}, el('button', { type: 'button', class: 'btn small danger', onclick: () => tr.remove() }, '삭제')));
    $('stClosed').append(tr);
    return tr;
  }

  function collectSettings() {
    return {
      title: $('stTitle').value.trim(),
      notice: $('stNotice').value.trim(),
      startDate: $('stStartDate').value,
      endDate: $('stEndDate').value,
      slots: [...$('stSlots').rows].map((tr) => ({
        key: tr.dataset.key,
        label: tr.querySelector('.st-label').value.trim(),
        start: tr.querySelector('.st-start').value,
        days: [...tr.querySelectorAll('.st-day')].filter((c) => c.checked).map((c) => Number(c.value)),
      })),
      closedDates: [...$('stClosed').rows]
        .map((tr) => ({ date: tr.querySelector('.st-date').value, reason: tr.querySelector('.st-reason').value.trim() }))
        .filter((c) => c.date),
    };
  }

  async function saveSettings(confirmCancel) {
    const settings = collectSettings();
    const res = await api('adminSaveSettings', { adminPassword: state.password, settings, confirmCancel });
    if (!res.saved) {
      $('conflictList').innerHTML = '';
      for (const c of res.conflicts) {
        $('conflictList').append(el('li', {},
          el('div', {}, el('div', { class: 'when' }, `${dateLabel(c.date)} ${c.slotText}`),
            el('div', { class: 'who' }, `${c.studentId} ${c.name}`))));
      }
      $('conflictMsg').textContent = '';
      $('conflictDialog').showModal();
      return;
    }
    state.settings = res.settings;
    fillSettings(res.settings);
    setStMsg(res.cancelled
      ? `저장했습니다. 예약 ${res.cancelled}건이 취소되었습니다. 학생 화면에 바로 반영됩니다.`
      : '저장했습니다. 학생 화면에 바로 반영됩니다.', 'ok');
    load(); // 달력·목록도 새 설정으로
  }

  $('settingsPanel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('settingsPanel').querySelector('[type=submit]');
    btn.disabled = true;
    setStMsg('저장하는 중…', '');
    try {
      await saveSettings(false);
      if ($('conflictDialog').open) setStMsg('', '');
    } catch (err) {
      setStMsg(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('conflictOk').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await saveSettings(true);
      $('conflictDialog').close();
    } catch (err) {
      $('conflictMsg').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('addSlot').addEventListener('click', () => addSlotRow().querySelector('.st-label').focus());
  $('addClosed').addEventListener('click', () => addClosedRow().querySelector('.st-date').focus());
  $('stStartDate').addEventListener('change', () => { $('stEndDate').min = $('stStartDate').value; });
  $('stReset').addEventListener('click', () => { state.settings = null; loadSettings(); });

  // ===================== 비밀번호 바꾸기 =====================
  function setPwMsg(text, kind = 'err') {
    $('pwMsg').className = `msg ${kind}`;
    $('pwMsg').textContent = text;
  }

  $('pwPanel').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('newPw').value !== $('newPw2').value) { setPwMsg('두 비밀번호가 서로 다릅니다.'); return; }
    const btn = $('pwPanel').querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('adminChangePassword', { adminPassword: state.password, newPassword: $('newPw').value });
      state.password = $('newPw').value;
      store.set(LOGIN_KEY, JSON.stringify({ cls: state.cls, password: state.password }));
      $('pwPanel').reset();
      setPwMsg('비밀번호를 바꿨습니다. 다음부터 새 비밀번호로 들어오세요.', 'ok');
    } catch (err) {
      setPwMsg(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ===================== 이벤트 =====================
  function showList(on) {
    $('loginCard').hidden = on;
    $('listCard').hidden = !on;
    $('shareRow').hidden = !on;
    const title = on ? `${state.cls}반 상담 예약 관리` : '담임 상담 예약 관리';
    $('adminTitle').textContent = title;
    document.title = title;
    if (on) {
      const link = window.CounselApi.studentLink(state.cls);
      $('shareLink').href = link;
      $('shareLink').textContent = link;
    }
  }

  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('shareLink').textContent);
      $('copyLink').textContent = '복사됨';
    } catch {
      $('copyLink').textContent = '직접 복사해 주세요';
    }
    setTimeout(() => { $('copyLink').textContent = '복사'; }, 1500);
  });

  // 반 고르기: 주소의 ?반=6 → 지난번에 고른 반 → 1반
  for (let c = 1; c <= CLASS_COUNT; c++) $('adminClass').append(el('option', { value: c }, `${c}반`));
  try { $('adminClass').value = window.CounselApi.classFromUrl() || localStorage.getItem(CLASS_KEY) || 1; } catch {}

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginForm').querySelector('[type=submit]');
    btn.disabled = true;
    $('loginMsg').textContent = '';
    state.cls = Number($('adminClass').value);
    state.password = $('adminPw').value;
    state.settings = null;
    showList(true);
    const ok = await load();
    btn.disabled = false;
    if (ok) {
      store.set(LOGIN_KEY, JSON.stringify({ cls: state.cls, password: state.password }));
      try { localStorage.setItem(CLASS_KEY, state.cls); } catch {}
    } else {
      showList(false);
      $('loginMsg').textContent = $('listMsg').textContent;
    }
  });

  function setView(view) {
    state.view = view;
    store.set(VIEW_KEY, view);
    if (state.avail) render();
  }
  $('viewCalendar').addEventListener('click', () => setView('calendar'));
  $('viewList').addEventListener('click', () => setView('list'));
  $('viewSettings').addEventListener('click', () => setView('settings'));
  $('refresh').addEventListener('click', load);
  $('showAll').addEventListener('change', load);
  $('logout').addEventListener('click', () => {
    store.clear(LOGIN_KEY);
    state.password = null;
    state.settings = null;
    $('adminPw').value = '';
    $('loginMsg').textContent = '';
    setPwMsg('', '');
    setStMsg('', '');
    showList(false);
  });

  $('demoNote').hidden = !window.CounselApi.isDemo;
  state.view = ['list', 'settings'].includes(store.get(VIEW_KEY)) ? store.get(VIEW_KEY) : 'calendar';
  let saved = null;
  try { saved = JSON.parse(store.get(LOGIN_KEY)); } catch {}
  const urlCls = window.CounselApi.classFromUrl();
  if (saved && saved.cls && saved.password && (!urlCls || urlCls === saved.cls)) {
    state.cls = saved.cls;
    state.password = saved.password;
    $('adminClass').value = saved.cls;
    showList(true);
    load().then((ok) => { if (!ok) { store.clear(LOGIN_KEY); showList(false); } });
  }
})();
