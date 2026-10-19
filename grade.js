(() => {
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const LOGIN_KEY = 'grade-counsel-master-pw'; // sessionStorage (탭을 닫으면 사라짐)
  const $ = (id) => document.getElementById(id);
  const state = { password: null, data: null, pwClass: null };
  const { CLASS_COUNT } = window.CounselApi;
  const api = window.CounselApi.call;

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
    clear(k) { try { sessionStorage.removeItem(k); } catch {} },
  };

  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dateLabel = (s) => { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`; };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  async function load() {
    $('mainMsg').textContent = '';
    $('refresh').disabled = true;
    try {
      state.data = await api('masterOverview', { masterPassword: state.password });
      render();
      return true;
    } catch (err) {
      $('mainMsg').textContent = err.message;
      return false;
    } finally {
      $('refresh').disabled = false;
    }
  }

  function render() {
    renderClasses();
    renderBookings();
  }

  // ===================== 반별 현황 =====================
  function renderClasses() {
    const { classes } = state.data;
    const total = classes.reduce((n, c) => n + c.bookings.length, 0);
    const missing = classes.filter((c) => !c.hasPassword).map((c) => `${c.cls}반`);
    $('summary').textContent = `다가오는 예약 ${total}건` +
      (missing.length ? ` · 담임 비밀번호를 아직 정하지 않은 반: ${missing.join(', ')}` : ' · 모든 반 담임 비밀번호 설정 완료');

    const tbody = $('classRows');
    tbody.innerHTML = '';
    for (const c of classes) {
      const link = window.CounselApi.studentLink(c.cls);
      tbody.append(el('tr', {},
        el('td', {}, el('b', {}, `${c.cls}반`)),
        el('td', {}, c.title),
        el('td', {}, c.bookings.length
          ? el('button', { type: 'button', class: 'link-btn', onclick: () => { $('filterClass').value = c.cls; renderBookings(); $('bookings').scrollIntoView({ behavior: 'smooth' }); } }, `${c.bookings.length}건`)
          : '0건'),
        el('td', {},
          c.hasPassword ? el('span', { class: 'tag' }, '정해짐') : el('span', { class: 'tag warn' }, '아직'),
          ' ',
          el('button', { type: 'button', class: 'btn small', onclick: () => openPwDialog(c) }, c.hasPassword ? '다시 정하기' : '정하기')),
        el('td', {},
          el('a', { href: link, target: '_blank', rel: 'noopener' }, `?반=${c.cls}`),
          ' ',
          el('button', { type: 'button', class: 'btn small', onclick: (e) => copy(link, e.currentTarget) }, '복사'))));
    }
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '복사됨';
    } catch {
      btn.textContent = '직접 복사해 주세요';
    }
    setTimeout(() => { btn.textContent = '복사'; }, 1500);
  }

  // ===================== 다가오는 예약 =====================
  function renderBookings() {
    const filter = Number($('filterClass').value) || null;
    const rows = [];
    for (const c of state.data.classes) {
      if (filter && c.cls !== filter) continue;
      for (const b of c.bookings) {
        const s = c.slots[b.slot];
        rows.push({ ...b, start: s ? s.start : '', slotText: s ? `${s.label} ${s.start}~${s.end || ''}` : b.slot });
      }
    }
    rows.sort((a, b) => (a.date + a.start + String(a.cls).padStart(2, '0')).localeCompare(b.date + b.start + String(b.cls).padStart(2, '0')));

    const root = $('bookings');
    root.innerHTML = '';
    if (!rows.length) { root.append(el('div', { class: 'loading' }, '다가오는 예약이 없습니다.')); return; }
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.date)) groups.set(r.date, []);
      groups.get(r.date).push(r);
    }
    for (const [date, items] of groups) {
      root.append(el('div', { class: 'day-group' },
        el('h3', {}, `${dateLabel(date)} · ${items.length}건`),
        el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, ...['반', '시간', '학번', '이름', '신청일시'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...items.map((r) => el('tr', {},
              el('td', {}, `${r.cls}반`),
              el('td', {}, r.slotText),
              el('td', {}, r.studentId),
              el('td', {}, r.name),
              el('td', {}, r.createdAt || ''))))))));
    }
  }

  // ===================== 담임 비밀번호 정하기 =====================
  function openPwDialog(c) {
    state.pwClass = c.cls;
    $('pwTitle').textContent = `${c.cls}반 담임 비밀번호 ${c.hasPassword ? '다시 정하기' : '정하기'}`;
    $('pwForm').reset();
    $('pwMsg').textContent = '';
    $('pwDialog').showModal();
    $('newPw').focus();
  }

  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('pwForm').querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('masterSetPassword', { masterPassword: state.password, cls: state.pwClass, newPassword: $('newPw').value });
      $('pwDialog').close();
      await load();
      $('summary').textContent = `${state.pwClass}반 담임 비밀번호를 정했습니다. 담임 선생님께 알려 주세요. · ` + $('summary').textContent;
    } catch (err) {
      $('pwMsg').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ===================== 로그인 =====================
  function showMain(on) {
    $('loginCard').hidden = on;
    $('mainCard').hidden = !on;
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginForm').querySelector('[type=submit]');
    btn.disabled = true;
    $('loginMsg').textContent = '';
    state.password = $('masterPw').value;
    showMain(true);
    const ok = await load();
    btn.disabled = false;
    if (ok) {
      store.set(LOGIN_KEY, state.password);
    } else {
      showMain(false);
      $('loginMsg').textContent = $('mainMsg').textContent;
    }
  });

  $('refresh').addEventListener('click', load);
  $('filterClass').addEventListener('change', renderBookings);
  $('logout').addEventListener('click', () => {
    store.clear(LOGIN_KEY);
    state.password = null;
    state.data = null;
    $('masterPw').value = '';
    showMain(false);
  });

  for (let c = 1; c <= CLASS_COUNT; c++) $('filterClass').append(el('option', { value: c }, `${c}반`));
  $('demoNote').hidden = !window.CounselApi.isDemo;
  const saved = store.get(LOGIN_KEY);
  if (saved) {
    state.password = saved;
    showMain(true);
    load().then((ok) => { if (!ok) { store.clear(LOGIN_KEY); showMain(false); } });
  }
})();
