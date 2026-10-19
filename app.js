(() => {
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const $ = (id) => document.getElementById(id);

  const state = {
    data: null,        // availability 응답
    picked: null,      // { date, slot }
    creds: null,       // 내 예약 조회에 쓴 { studentId, password }
    modifying: null,   // 변경 중인 예약
  };

  const { GRADE, CLASS_COUNT } = window.CounselApi;
  const cls = window.CounselApi.classFromUrl(); // ?반=6. 없으면 반 고르기 화면
  // 모든 요청에 반 번호를 붙인다
  const api = (action, params = {}) => window.CounselApi.call(action, { cls, ...params });
  const TITLE_KEY = `grade-counsel-title-${cls}`;
  const NOTICE_KEY = `grade-counsel-notice-${cls}`;

  // ===================== 표시 도우미 =====================
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dateLabel = (s) => { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`; };
  const timeText = (s) => `${s.start}~${s.end || ''}`; // 08:20~08:40 또는 08:20~
  const slotLabel = (key) => {
    const s = state.data && state.data.slots[key];
    return s ? `${s.label} ${timeText(s)}` : key;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function openDialog(d) { d.querySelectorAll('.msg').forEach((m) => { m.textContent = ''; }); d.showModal(); }
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  async function busy(button, fn) {
    button.disabled = true;
    try { return await fn(); } finally { button.disabled = false; }
  }

  // ===================== 탭 =====================
  function showTab(which) {
    const book = which === 'book';
    $('tabBook').setAttribute('aria-selected', book);
    $('tabMine').setAttribute('aria-selected', !book);
    $('panelBook').hidden = !book;
    $('panelMine').hidden = book;
  }
  $('tabBook').addEventListener('click', () => showTab('book'));
  $('tabMine').addEventListener('click', () => showTab('mine'));

  // ===================== 달력 =====================
  async function loadCalendar() {
    try {
      const data = await api('availability');
      state.data = data;
      // 제목·안내 문구는 관리자 페이지 > 설정 에서 바꾼다
      if (data.title) { $('title').textContent = data.title; document.title = data.title; }
      if (data.notice != null) $('notice').textContent = data.notice;
      // 다음에 열 때 바로 보여 주도록 기억 (index.html 의 인라인 스크립트가 읽음)
      try {
        if (data.title) localStorage.setItem(TITLE_KEY, data.title);
        if (data.notice != null) localStorage.setItem(NOTICE_KEY, data.notice);
      } catch {}
      renderCalendar();
    } catch (err) {
      $('calendar').innerHTML = `<div class="loading">${esc(err.message)}<br><button class="btn small" id="retry">다시 시도</button></div>`;
      $('retry').addEventListener('click', loadCalendar);
    }
  }

  function renderCalendar() {
    const { days, today, slots } = state.data;
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const root = $('calendar');
    root.innerHTML = '';
    if (!days.length) { root.innerHTML = '<div class="loading">예약 가능한 날짜가 없습니다.</div>'; return; }

    root.append(el('div', { class: 'grid' }, ...['월', '화', '수', '목', '금'].map((d) => el('div', { class: 'dow' }, d))));

    const start = parse(days[0].date); // 예약 기간 첫날이 있는 주부터
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 이번 주 월요일
    const last = parse(days[days.length - 1].date);

    for (const monday = start; monday <= last; monday.setDate(monday.getDate() + 7)) {
      const week = el('div', { class: 'grid week' });
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday); d.setDate(d.getDate() + i);
        const key = fmt(d);
        const info = byDate[key];
        const label = `${d.getMonth() + 1}/${d.getDate()}`;
        // '휴무일' 탭에 적힌 날은 선택할 시간대 없이 빈칸으로 둔다
        if (!info || info.holiday) { week.append(el('div', { class: 'day blank' }, el('span', { class: 'date' }, label))); continue; }
        const cell = el('div', { class: 'day' + (key === today ? ' today' : '') }, el('span', { class: 'date' }, label));
        for (const s of info.slots) {
          const meta = slots[s.key];
          const text = s.status === 'open' ? meta.label : s.status === 'booked' ? '예약됨' : '마감';
          cell.append(el('button', {
            class: `slot ${s.status}`,
            type: 'button',
            disabled: s.status !== 'open',
            title: `${dateLabel(key)} ${slotLabel(s.key)}`,
            onclick: () => pickSlot(key, s.key),
          }, text, el('small', {}, timeText(meta))));
        }
        week.append(cell);
      }
      root.append(week);
    }
  }

  function pickSlot(date, slot) {
    state.picked = { date, slot };
    const when = `${dateLabel(date)} ${slotLabel(slot)}`;
    if (state.modifying) {
      confirmAction('예약 변경', `${dateLabel(state.modifying.date)} ${slotLabel(state.modifying.slot)}\n→ ${when} 으로 바꿀까요?`, async () => {
        await api('modify', { ...state.creds, id: state.modifying.id, date, slot });
        stopModify();
        await Promise.all([loadCalendar(), refreshMine()]);
        showTab('mine');
        setLookupMsg('예약을 변경했습니다.', 'ok');
      });
      return;
    }
    $('bookPicked').textContent = when;
    openDialog($('bookDialog'));
    $('bkId').focus();
  }

  $('bookForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('bookForm').querySelector('[type=submit]');
    await busy(btn, async () => {
      try {
        await api('book', {
          ...state.picked,
          studentId: $('bkId').value.trim(),
          name: $('bkName').value.trim(),
          password: $('bkPw').value,
        });
        $('bookDialog').close();
        $('bkPw').value = '';
        await loadCalendar();
        alert(`예약되었습니다!\n${dateLabel(state.picked.date)} ${slotLabel(state.picked.slot)}`);
      } catch (err) {
        $('bookMsg').textContent = err.message;
        loadCalendar(); // 그 사이 다른 사람이 예약했을 수 있으니 갱신
      }
    });
  });

  // ===================== 확인 창 =====================
  let confirmFn = null;
  function confirmAction(title, text, fn) {
    $('confirmTitle').textContent = title;
    $('confirmText').innerText = text;
    confirmFn = fn;
    openDialog($('confirmDialog'));
  }
  $('confirmOk').addEventListener('click', async (e) => {
    await busy(e.currentTarget, async () => {
      try {
        await confirmFn();
        $('confirmDialog').close();
      } catch (err) {
        $('confirmMsg').textContent = err.message;
      }
    });
  });

  // ===================== 내 예약 =====================
  function setLookupMsg(text, kind = 'err') {
    $('lookupMsg').className = `msg ${kind}`;
    $('lookupMsg').textContent = text;
  }

  $('lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.creds = { studentId: $('lkId').value.trim(), password: $('lkPw').value };
    await busy(e.submitter || $('lookupForm').querySelector('[type=submit]'), refreshMine);
  });

  async function refreshMine() {
    const list = $('myList');
    list.innerHTML = '';
    setLookupMsg('');
    if (!state.creds) return;
    let items;
    try {
      items = await api('myBookings', state.creds);
    } catch (err) {
      setLookupMsg(err.message);
      return;
    }
    if (!state.data) await loadCalendar();
    for (const b of items) {
      list.append(el('li', {},
        el('div', {},
          el('div', { class: 'when' }, `${dateLabel(b.date)} ${slotLabel(b.slot)}`),
          el('div', { class: 'who' }, `${b.studentId} ${b.name}`)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn small', type: 'button', onclick: () => startModify(b) }, '변경'),
          el('button', {
            class: 'btn small danger', type: 'button',
            onclick: () => confirmAction('예약 취소', `${dateLabel(b.date)} ${slotLabel(b.slot)} 예약을 취소할까요?`, async () => {
              await api('cancel', { ...state.creds, id: b.id });
              await Promise.all([loadCalendar(), refreshMine()]);
              setLookupMsg('예약을 취소했습니다.', 'ok');
            }),
          }, '취소'))));
    }
  }

  function startModify(b) {
    state.modifying = b;
    $('modifyText').textContent = `${dateLabel(b.date)} ${slotLabel(b.slot)} 예약을 바꿀 새 시간을 선택하세요.`;
    $('modifyBanner').hidden = false;
    showTab('book');
  }

  function stopModify() {
    state.modifying = null;
    $('modifyBanner').hidden = true;
  }
  $('modifyStop').addEventListener('click', () => { stopModify(); showTab('mine'); });

  // ===================== 시작 =====================
  $('demoNote').hidden = !window.CounselApi.isDemo;
  if (cls) {
    // 학번 예시: 2학년 6반 1번 → 20601
    const example = `${GRADE}${pad(cls)}01`;
    document.querySelectorAll('.student-id').forEach((i) => { i.placeholder = `예) ${example}`; });
    $('bkIdHint').textContent = `${GRADE}학년 ${cls}반 학번 5자리 (학년 1자리 + 반 2자리 + 번호 2자리)`;
    loadCalendar();
  } else {
    for (let c = 1; c <= CLASS_COUNT; c++) {
      $('classGrid').append(el('a', { class: 'class-btn', href: `?반=${c}` }, `${c}반`));
    }
  }
})();
