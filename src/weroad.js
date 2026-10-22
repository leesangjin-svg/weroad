
(function () {
  'use strict';
  if (window.__WF_DCAL__) return;
  window.__WF_DCAL__ = true;

  const VERSION = '1.3.0';
  const CHANNEL = window.__WEROAD_CHANNEL__ || 'local';   // stable(일반) | dev(개발자) | local(직접 설치)
  const DAY_VER = 2;                       // 일자 캐시 구조 버전 (업무현황 추가)
  const SERVICES = ['스낵24', '조식24', '커피24'];
  const CFG_KEY = 'wf-dcal-cfg';
  const AFF_KEY = 'wf-dcal-aff';           // 기사명 -> 소속
  const DRV_KEY = 'wf-dcal-drivers';       // 위펀오피스 배송기사 관리 캐시
  const DEFAULT_CFG = {
    excludeExact: ['주간15', '주간19', '주간20', '주간21', '주간22'],
    excludeContains: ['야간스낵본사', '위펀용차', '부산간선'],
    affOptions: ['핫픽스', '대산물류', '창호통운', '개별지입', '사업소득자', '위풀정직원', '용차'],
    recentDays: 3,
    autoRefreshMin: 10,
    concurrency: 5,
  };
  const AFF_NONE = '미지정';

  // ---------------------------------------------------------------- utils
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const won = (n) => (n == null ? '-' : '₩' + Math.round(n).toLocaleString('ko-KR'));
  const num = (n) => Math.round(n || 0).toLocaleString('ko-KR');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shortName = (cl) => {
    let b = cl.includes(' - ') ? cl.split(' - ').slice(1).join(' - ') : cl;
    b = b.replace(/\[SNF\]|\((스낵|조식|음료|커피)\)/g, '').trim();
    return b || cl;
  };
  // "6시간 49분 55초" -> 초
  const durSec = (s) => {
    if (!s) return null;
    const h = s.match(/(\d+)\s*시간/), m = s.match(/(\d+)\s*분/), x = s.match(/(\d+)\s*초/);
    if (!h && !m && !x) return null;
    return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (x ? +x[1] : 0);
  };
  const hm = (sec) => (sec == null || isNaN(sec) ? '-' : `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}`);
  const clockSec = (t) => { const m = (t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) : null; };
  const clock = (sec) => (sec == null || isNaN(sec) ? '-' : `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}`);
  const avg = (arr) => { const v = arr.filter((x) => x != null && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  let CFG = Object.assign({}, DEFAULT_CFG, lsGet(CFG_KEY, {}));
  let AFF = lsGet(AFF_KEY, {});
  let DRV = lsGet(DRV_KEY, { at: 0, list: [] });
  const affOf = (name) => AFF[name] || AFF_NONE;
  const isExcluded = (course) =>
    CFG.excludeExact.includes(course) || CFG.excludeContains.some((k) => k && course.includes(k));

  // ---------------------------------------------------------------- cache (IndexedDB)
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve();
      return new Promise((res, rej) => {
        const r = indexedDB.open('wf-dcal', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('days', { keyPath: 'date' });
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    },
    tx(mode) { return this.db.transaction('days', mode).objectStore('days'); },
    get(date) { return new Promise((res) => { const q = this.tx('readonly').get(date); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); },
    put(o) { return new Promise((res) => { const q = this.tx('readwrite').put(o); q.onsuccess = () => res(); q.onerror = () => res(); }); },
    clear() { return new Promise((res) => { const q = this.tx('readwrite').clear(); q.onsuccess = () => res(); q.onerror = () => res(); }); },
  };

  // ---------------------------------------------------------------- 위펀오피스 수집
  const parseHTML = (h) => new DOMParser().parseFromString(h, 'text/html');
  async function getHTML(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (/\/login/i.test(r.url)) throw new Error('위펀오피스 로그인이 필요합니다');
    return r.text();
  }
  const totalCount = (doc) => {
    const m = (doc.body ? doc.body.textContent : '').match(/총\s*([\d,]+)\s*건/);
    return m ? +m[1].replace(/,/g, '') : null;
  };
  // 원문 HTML에서 "총 N건" (태그가 끼어 있어도 인식)
  const rawTotal = (h) => { const m = h.match(/총\s*(?:<[^>]*>\s*)*([\d,]+)\s*(?:<[^>]*>\s*)*건/); return m ? +m[1].replace(/,/g, '') : null; };
  // 큰 페이지에서 결과 표 부분만 잘라 파싱 (메뉴·검색필터·상품표를 건너뛰어 파싱 시간 단축)
  const sliceTable = (h, marker) => {
    const i = typeof marker === 'string' ? h.indexOf(marker) : h.search(marker);
    if (i < 0) return null;
    const st = h.lastIndexOf('<table', i);
    if (st < 0) return h;
    let en = h.indexOf('pagination', i);
    if (en < 0) en = h.length;
    return '<!doctype html><html><body>' + h.slice(st, en) + '</body></html>';
  };
  const norm = (s) => s.replace(/\s+/g, '');
  const findTable = (doc, ...words) => [...doc.querySelectorAll('table')].find((t) => t.rows[0] && words.every((w) => norm(t.rows[0].textContent).includes(norm(w))));
  const headerIndex = (t) => { const hd = [...t.rows[0].cells].map((c) => norm(c.textContent)); return { hd, ix: (n) => hd.indexOf(norm(n)), find: (p) => hd.findIndex((h) => h.startsWith(norm(p))) }; };
  const cellText = (r, i) => (i >= 0 && r.cells[i] ? r.cells[i].textContent.replace(/\s+/g, ' ').trim() : '');

  // 배송일정 등록
  async function fetchSchedules(date) {
    const out = [];
    for (let p = 1; p <= 30; p++) {
      const qs = new URLSearchParams({ size: 1000, page: p, searchYN: 'Y', startDate: date, endDate: date,
        address1: '', address2: '', status: '', stockSurveyYN: '', examineYN: '', coffeeMachineYN: '', searchKeyword: '' });
      SERVICES.forEach((s) => qs.append('serviceTypes', s));
      const html = await getHTML('/office/delivery-manager/v2/schedules?' + qs);
      const tot = rawTotal(html);
      const part = sliceTable(html, /onclick\s*=\s*["']\s*goDetail\(/);
      if (part === null && !tot) break;               // 결과 0건
      const doc = parseHTML(part || html);
      let t = findTable(doc, '배송코스', '거래명세');
      if (!t) t = findTable(parseHTML(html), '배송코스', '거래명세');   // 잘라내기 실패 시 전체 파싱
      if (!t) throw new Error('배송일정 표 구조를 찾지 못했습니다');
      const { hd, ix } = headerIndex(t);
      const I = { date: ix('배송일'), course: ix('배송코스'), driver: ix('배송기사'), seq: ix('배송순번'),
        client: ix('기업-거래처'), svc: ix('서비스'), order: ix('거래명세'), status: ix('작업상태') };
      let n = 0;
      for (const r of [...t.rows].slice(1)) {
        if (r.cells.length < hd.length - 2) continue;
        const oa = I.order >= 0 && r.cells[I.order] ? r.cells[I.order].querySelector('a') : null;
        out.push({ d: cellText(r, I.date) || date, co: cellText(r, I.course), dr: cellText(r, I.driver) || '(미지정)', sq: +cellText(r, I.seq) || 0,
          cl: cellText(r, I.client), sv: cellText(r, I.svc), o: oa ? oa.textContent.trim() : cellText(r, I.order), st: cellText(r, I.status) });
        n++;
      }
      if (n === 0 || (tot != null ? out.length >= tot : n < 1000)) break;
    }
    return out;
  }

  // 주문 목록 → 거래명세 합계(VAT 포함)
  async function fetchAmounts(date) {
    const m = {};
    for (let p = 1; p <= 30; p++) {
      const qs = new URLSearchParams({ size: 1000, page: p, searchYN: 'Y', deliveryDateBegin: date, deliveryDateEnd: date });
      SERVICES.forEach((s) => qs.append('serviceTypes', s));
      const html = await getHTML('/office/order/order?' + qs);
      const tot = rawTotal(html);
      const part = sliceTable(html, 'orderSearchTable');
      let t = part ? parseHTML(part).querySelector('table.orderSearchTable') : null;
      if (!t) t = parseHTML(html).querySelector('table.orderSearchTable');
      if (!t) throw new Error('주문 표 구조를 찾지 못했습니다');
      const { ix, find } = headerIndex(t);
      const iId = ix('#'), iSum = find('합계');
      let n = 0;
      for (const r of [...t.rows].slice(1)) {
        const id = r.cells[iId] ? r.cells[iId].textContent.trim() : '';
        const a = r.cells[iSum] ? r.cells[iSum].textContent.match(/₩\s*(-?[\d,]+)/) : null;
        if (/^\d+$/.test(id) && a) { m[id] = +a[1].replace(/,/g, ''); n++; }
      }
      if (n === 0 || (tot != null ? p * 1000 >= tot : n < 1000)) break;
    }
    return m;
  }

  async function fetchOrderAmount(id) {
    try {
      const h = await getHTML('/office/order/order/' + id);
      const m = h.match(/id="order-item-price"\s+data-supply_price="(-?\d+)"\s+data-vat="(-?\d+)"/);
      return m ? +m[1] + +m[2] : null;
    } catch (e) { return null; }
  }

  // 기사 업무현황 (코스·기사·일자별 업무시간/작업수/완료율)
  async function fetchTasks(date) {
    const out = [];
    for (let p = 1; p <= 10; p++) {
      const qs = new URLSearchParams({ size: 1000, page: p, searchYN: 'Y', startDate: date, endDate: date, searchKeyword: '' });
      SERVICES.forEach((s) => qs.append('serviceTypes', s));
      const doc = parseHTML(await getHTML('/office/delivery-manager/v2/manager-tasks?' + qs));
      const t = findTable(doc, '배송기사', '총 주문액');
      if (!t) throw new Error('기사 업무현황 표 구조를 찾지 못했습니다');
      const { hd, ix, find } = headerIndex(t);
      const I = { course: ix('배송코스'), driver: ix('배송기사'), date: ix('배송일'), jobs: find('총작업수'), photo: find('사진이등록된'),
        rate: ix('작업완료율'), order: ix('총주문액'), start: ix('업무시작시간'), end: ix('업무완료시간'),
        work: ix('총근무시간'), move: ix('총이동시간'), task: ix('총업무시간') };
      let n = 0;
      for (const r of [...t.rows].slice(1)) {
        if (r.cells.length < hd.length - 2) continue;
        const jobs = cellText(r, I.jobs);
        out.push({ d: cellText(r, I.date) || date, co: cellText(r, I.course), dr: cellText(r, I.driver),
          jobs: jobs, jobN: parseInt(jobs, 10) || 0, photo: cellText(r, I.photo), rate: parseFloat(cellText(r, I.rate)) || null,
          ord: +(cellText(r, I.order).replace(/[^\d-]/g, '')) || 0, start: cellText(r, I.start), end: cellText(r, I.end),
          work: durSec(cellText(r, I.work)), move: durSec(cellText(r, I.move)), task: durSec(cellText(r, I.task)) });
        n++;
      }
      const tot = totalCount(doc);
      if (n === 0 || tot == null || out.length >= tot) break;
    }
    return out;
  }

  // 배송기사 관리 (기사마스터 원본: 차량·기본코스·재직)
  async function fetchDrivers() {
    const out = [];
    for (let p = 1; p <= 10; p++) {
      const qs = new URLSearchParams({ size: 1000, page: p, searchYN: 'Y', searchKeyword: '', inOfficeYN: '', locationAgreeYN: '', minAverageScore: '', maxAverageScore: '' });
      qs.append('departmentIds', '2'); qs.append('departmentIds', '22');
      const doc = parseHTML(await getHTML('/office/delivery-manager/v2/driver?' + qs));
      const t = findTable(doc, '배송담당자', '배송 코스');
      if (!t) throw new Error('배송기사 표 구조를 찾지 못했습니다');
      const { hd, ix } = headerIndex(t);
      const I = { id: ix('#'), dept: ix('부서'), name: ix('배송담당자'), vehicle: ix('차량정보'), course: ix('배송코스'),
        inOffice: ix('재직여부'), start: ix('재직시작일'), end: ix('재직종료일') };
      let n = 0;
      for (const r of [...t.rows].slice(1)) {
        if (r.cells.length < hd.length - 2) continue;
        const name = cellText(r, I.name);
        if (!name) continue;
        out.push({ id: cellText(r, I.id), dept: cellText(r, I.dept), name, vehicle: cellText(r, I.vehicle), course: cellText(r, I.course),
          inOffice: cellText(r, I.inOffice), start: cellText(r, I.start).replace(/^-$/, ''), end: cellText(r, I.end).replace(/^-$/, '') });
        n++;
      }
      const tot = totalCount(doc);
      if (n === 0 || tot == null || out.length >= tot) break;
    }
    DRV = { at: Date.now(), list: out };
    lsSet(DRV_KEY, DRV);
    return DRV;
  }
  const drvInfo = () => { const m = {}; for (const d of DRV.list) if (!m[d.name] || d.inOffice === '재직') m[d.name] = d; return m; };

  // 1단계: 배송일정 + 업무현황 (빠름) — 금액은 기존 값을 임시로 유지하고 2단계에서 채움
  async function syncBase(date) {
    const [rows, tasks] = await Promise.all([fetchSchedules(date), fetchTasks(date).catch(() => [])]);
    const prev = {};
    if (S.days[date]) for (const r of S.days[date].rows) if (r.o && r.a != null) prev[r.o] = r.a;
    rows.forEach((r) => { r.a = r.o in prev ? prev[r.o] : undefined; });
    const rec = { date, v: DAY_VER, fetchedAt: Date.now(), rows, tasks, partial: true };
    S.days[date] = rec;
    return rec;
  }
  // 2단계: 주문 목록 금액 (느림)
  async function syncAmounts(date) {
    const amts = await fetchAmounts(date);
    const rec = S.days[date];
    if (!rec) return;
    const missing = [...new Set(rec.rows.filter((r) => r.o && !(r.o in amts)).map((r) => r.o))].slice(0, 40);
    for (const id of missing) amts[id] = await fetchOrderAmount(id);
    rec.rows.forEach((r) => { r.a = r.o in amts ? amts[r.o] : null; });
    rec.partial = false;
    await DB.put(rec);
  }

  // ---------------------------------------------------------------- state
  const S = {
    month: today().slice(0, 7), days: {}, driver: null, date: null,
    view: 'cal',           // cal | matrix | master
    filter: 'all',         // all | day | night
    aff: 'all',            // 소속 필터
    q: '', sort: { k: 'amt', dir: -1 },
    mq: '', mOnlyActive: true, mOnlyNone: false, mSort: 'name',
    syncing: false, progress: '', lastSync: null, error: '',
  };
  let autoTimer = null;

  function monthDates(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const out = [];
    for (let d = 1; d <= last; d++) out.push(`${month}-${pad(d)}`);
    return out;
  }

  async function loadMonth(month, { force = false, onlyRecent = false } = {}) {
    await DB.open();
    if (!DRV.list.length || Date.now() - DRV.at > 12 * 3600e3) fetchDrivers().then(render).catch(() => {});
    const t = today();
    const limit = addDays(t, 1);
    const recentFrom = addDays(t, -(CFG.recentDays - 1));
    const dates = monthDates(month).filter((d) => d <= limit);
    const need = [];
    for (const d of dates) {
      let c = await DB.get(d);
      if (c && c.v !== DAY_VER) c = null;
      if (c) S.days[d] = c;
      const recent = d >= recentFrom;
      if (force || !c || recent) { if (!onlyRecent || recent || !c) need.push(d); }
    }
    render();
    if (!need.length) return;
    S.syncing = true; S.error = '';
    // 1단계(방문·업무현황) 전체를 먼저, 이어서 2단계(금액) — 화면은 1단계만 끝나도 채워짐
    const order = need.slice().sort().reverse();
    const queue = [...order.map((d) => ({ k: 'base', d })), ...order.map((d) => ({ k: 'amt', d }))];
    const baseP = {};
    let b = 0, a = 0;
    const prog = () => { S.progress = b < need.length ? `방문 수집 ${b}/${need.length}일` : `금액 수집 ${a}/${need.length}일`; };
    const worker = async () => {
      while (queue.length) {
        const j = queue.shift();
        try {
          if (j.k === 'base') { baseP[j.d] = syncBase(j.d); await baseP[j.d]; b++; }
          else { await baseP[j.d]; await syncAmounts(j.d); a++; }
        } catch (e) {
          if (j.k === 'base') b++; else a++;
          S.error = `${j.d}: ${e.message}`;
          if (/로그인/.test(e.message)) queue.length = 0;
        }
        prog();
        if (S.month === month) renderSoon();
      }
    };
    prog(); render();
    await Promise.all(Array.from({ length: Math.min(Math.max(CFG.concurrency, 5), queue.length) }, worker));
    S.syncing = false; S.progress = ''; S.lastSync = new Date();
    render();
  }

  // ---------------------------------------------------------------- aggregation
  function monthRows() {
    const out = [];
    for (const d of monthDates(S.month)) {
      const rec = S.days[d];
      if (!rec) continue;
      for (const r of rec.rows) if (!isExcluded(r.co)) out.push(r);
    }
    return out;
  }
  function monthTasks() {
    const out = [];
    for (const d of monthDates(S.month)) {
      const rec = S.days[d];
      if (!rec || !rec.tasks) continue;
      for (const t of rec.tasks) if (!isExcluded(t.co)) out.push(t);
    }
    return out;
  }
  // 기사·일자별 업무현황 묶음 (코스가 여럿이면 시작=최소, 완료=최대, 시간=합)
  function taskIndex(tasks) {
    const m = {};
    for (const t of tasks) {
      const k = t.dr + '|' + t.d;
      const a = m[k] || (m[k] = { list: [], start: null, end: null, work: 0, move: 0, task: 0, jobs: 0, rates: [] });
      a.list.push(t);
      const s = clockSec(t.start), e = clockSec(t.end);
      if (s != null) a.start = a.start == null ? s : Math.min(a.start, s);
      if (e != null) a.end = a.end == null ? e : Math.max(a.end, e);
      a.work += t.work || 0; a.move += t.move || 0; a.task += t.task || 0; a.jobs += t.jobN;
      if (t.rate != null) a.rates.push(t.rate);
    }
    return m;
  }
  function driverStats(rows, tIdx) {
    const m = new Map();
    for (const r of rows) {
      let s = m.get(r.dr);
      if (!s) { s = { dr: r.dr, cnt: 0, amt: 0, dates: new Set(), courses: new Set(), snack: 0, josik: 0, missing: 0 }; m.set(r.dr, s); }
      s.cnt++; s.amt += r.a || 0; s.dates.add(r.d); s.courses.add(r.co);
      if (r.a === null) s.missing++;
      if (r.sv === '조식24') s.josik++; else s.snack++;
    }
    const info = drvInfo();
    return [...m.values()].map((s) => {
      const cs = [...s.courses];
      const night = cs.some((c) => c.includes('야간')), day = cs.some((c) => !c.includes('야간'));
      const td = [...s.dates].map((d) => tIdx[s.dr + '|' + d]).filter(Boolean);
      return Object.assign(s, { work: s.dates.size, avg: s.dates.size ? s.cnt / s.dates.size : 0,
        courseText: cs.sort().join(', '), type: night && day ? '주야' : night ? '야간' : '주간',
        aff: affOf(s.dr), info: info[s.dr] || null,
        avgWork: avg(td.map((x) => x.work || null)), avgStart: avg(td.map((x) => x.start)), avgEnd: avg(td.map((x) => x.end)),
        avgRate: avg(td.flatMap((x) => x.rates)) });
    });
  }

  // ---------------------------------------------------------------- UI
  const host = document.createElement('div');
  host.id = 'wf-dcal-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="launch" title="위로드 열기">위로드</button>
    <div class="ov" hidden><div class="app"></div></div>`;
  const launch = root.querySelector('.launch');
  const ov = root.querySelector('.ov');
  const app = root.querySelector('.app');

  function openPanel() {
    ov.hidden = false; launch.hidden = true;
    document.documentElement.style.overflow = 'hidden';
    render();
    loadMonth(S.month);
    clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      if (!ov.hidden && !S.syncing && S.month === today().slice(0, 7)) loadMonth(S.month, { onlyRecent: true });
    }, CFG.autoRefreshMin * 60000);
  }
  function closePanel() {
    ov.hidden = true; launch.hidden = false;
    document.documentElement.style.overflow = '';
    clearInterval(autoTimer);
    if (/^#(weroad|driver-calendar)$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }
  launch.onclick = openPanel;
  if (/^#(weroad|driver-calendar)$/.test(location.hash)) openPanel();
  window.addEventListener('hashchange', () => { if (/^#(weroad|driver-calendar)$/.test(location.hash)) openPanel(); });

  function shiftMonth(n) {
    const [y, m] = S.month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    S.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    S.date = null;
    loadMonth(S.month);
  }

  const affTag = (a) => `<span class="aff ${a === AFF_NONE ? 'none' : ''}" style="${a === AFF_NONE ? '' : affColor(a)}">${esc(a)}</span>`;
  function affColor(a) {
    const P = [['#dbeafe', '#1e40af'], ['#dcfce7', '#166534'], ['#fce7f3', '#9d174d'], ['#fef3c7', '#92400e'], ['#ede9fe', '#5b21b6'], ['#cffafe', '#155e75'], ['#fee2e2', '#991b1b'], ['#e2e8f0', '#334155']];
    let i = CFG.affOptions.indexOf(a);
    if (i < 0) { i = 0; for (const ch of a) i = (i * 31 + ch.charCodeAt(0)) % P.length; }
    const [bg, fg] = P[i % P.length];
    return `background:${bg};color:${fg}`;
  }

  let renderTimer = null;
  function renderSoon() { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; render(); }, 500); }
  function render() {
    if (ov.hidden) return;
    const rows = monthRows();
    const tIdx = taskIndex(monthTasks());
    const stats = driverStats(rows, tIdx);
    const total = { cnt: rows.length, amt: rows.reduce((s, r) => s + (r.a || 0), 0), drivers: stats.length,
      snack: rows.filter((r) => r.sv !== '조식24').length, josik: rows.filter((r) => r.sv === '조식24').length };
    const loadedDays = monthDates(S.month).filter((d) => S.days[d] && S.days[d].rows.length).length;
    // 소속별 요약
    const affSum = {};
    for (const s of stats) {
      const a = affSum[s.aff] || (affSum[s.aff] = { n: 0, cnt: 0, amt: 0, days: 0 });
      a.n++; a.cnt += s.cnt; a.amt += s.amt; a.days += s.work;
    }
    const affKeys = [...CFG.affOptions.filter((a) => affSum[a]), ...Object.keys(affSum).filter((a) => !CFG.affOptions.includes(a) && a !== AFF_NONE), ...(affSum[AFF_NONE] ? [AFF_NONE] : [])];
    let list = stats.filter((s) => (S.filter === 'all' || (S.filter === 'day' ? s.type !== '야간' : s.type !== '주간'))
      && (S.aff === 'all' || s.aff === S.aff)
      && (!S.q || s.dr.includes(S.q) || s.courseText.includes(S.q) || s.aff.includes(S.q)));
    const k = S.sort.k, dir = S.sort.dir;
    list.sort((a, b) => { const x = a[k], y = b[k]; if (typeof x === 'string') return x.localeCompare(y, 'ko') * dir; return ((x ?? -1) - (y ?? -1)) * dir; });
    if ((!S.driver || !list.some((x) => x.dr === S.driver)) && list.length) S.driver = list[0].dr;
    const [y, m] = S.month.split('-');
    const missingAll = rows.filter((r) => r.a === null).length;
    const pendingAll = rows.filter((r) => r.a === undefined).length;

    app.innerHTML = `
      <header>
        <div class="title"><b>위로드</b><span class="en">WeRoad</span>${CHANNEL === 'dev' ? '<span class="dev">DEV</span>' : ''}<span class="sub">배송일정등록·기사업무현황·배송기사관리 기준 · 금액=거래명세 합계(부가세 포함) · v${VERSION}${CHANNEL === 'dev' ? ' (개발)' : ''}</span></div>
        <div class="nav">
          <button data-act="prev">◀</button><span class="mon">${y}년 ${+m}월</span><button data-act="next">▶</button>
          <button data-act="thism">이번달</button>
        </div>
        <div class="tools">
          <span class="status ${S.error ? 'err' : ''}">${S.syncing ? '<i class="spin"></i>' + esc(S.progress) : S.error ? '오류 ' + esc(S.error) : S.lastSync ? '갱신 ' + S.lastSync.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ` · ${CFG.autoRefreshMin}분마다 자동` : ''}</span>
          <button data-act="refresh" ${S.syncing ? 'disabled' : ''}>↻ 새로고침</button>
          <button data-act="reload" ${S.syncing ? 'disabled' : ''} title="이 달 전체를 위펀오피스에서 다시 수집">전체 재수집</button>
          <button data-act="csv">엑셀(CSV)</button>
          <button data-act="cfg">설정</button>
          <button data-act="close" class="x">✕</button>
        </div>
      </header>
      <div class="summary">
        <div><b>${+m}월 합계</b> (${loadedDays}일 집계) · 기사 <b>${total.drivers}</b>명 · 착지 <b>${num(total.cnt)}</b>
        (스낵 ${num(total.snack)} / 조식 ${num(total.josik)}) · 금액 <b class="amt">${won(total.amt)}</b>
        ${pendingAll ? `<span class="muted2">· 금액 수집 중 ${num(pendingAll)}건</span>` : ''}${missingAll ? `<span class="warn">· 금액 미확인 ${missingAll}건</span>` : ''}
        <span class="excl">제외 코스: ${esc([...CFG.excludeExact, ...CFG.excludeContains.map((x) => x + '*')].join(', '))}</span></div>
        <div class="chips">
          <button class="chip ${S.aff === 'all' ? 'on' : ''}" data-aff="all">전체</button>
          ${affKeys.map((a) => { const v = affSum[a]; return `<button class="chip ${S.aff === a ? 'on' : ''}" data-aff="${esc(a)}">${affTag(a)} 기사 ${v.n} · 착지 ${num(v.cnt)} · ${won(v.amt)} · 기사당 일평균 ${(v.days ? v.cnt / v.days : 0).toFixed(1)}착</button>`; }).join('')}
        </div>
      </div>
      <div class="body">
        <aside>
          <div class="filters">
            <input class="q" placeholder="기사·코스·소속 검색" value="${esc(S.q)}">
            <div class="seg">${[['all', '전체'], ['day', '주간'], ['night', '야간']].map(([v, l]) => `<button data-filter="${v}" class="${S.filter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          </div>
          <div class="dlist"><table>
            <thead><tr>${[['aff', '소속'], ['dr', '기사'], ['courseText', '코스'], ['cnt', '착지'], ['amt', '금액'], ['work', '근무일'], ['avg', '일평균'], ['avgWork', '평균근무']].map(([kk, l]) => `<th data-sort="${kk}" class="${S.sort.k === kk ? 'sorted' : ''}">${l}${S.sort.k === kk ? (S.sort.dir < 0 ? '▾' : '▴') : ''}</th>`).join('')}</tr></thead>
            <tbody>${list.map((s) => `<tr data-driver="${esc(s.dr)}" class="${s.dr === S.driver ? 'sel' : ''}">
              <td>${affTag(s.aff)}</td><td>${esc(s.dr)}</td><td class="co" title="${esc(s.courseText)}">${esc(s.courseText)}</td>
              <td class="r">${num(s.cnt)}</td><td class="r amt">${won(s.amt)}</td><td class="r">${s.work}</td><td class="r">${s.avg.toFixed(1)}</td><td class="r">${hm(s.avgWork)}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">${S.syncing ? '수집 중…' : '데이터 없음'}</td></tr>`}</tbody>
          </table></div>
        </aside>
        <main>
          <div class="tabs">
            <button data-view="cal" class="${S.view === 'cal' ? 'on' : ''}">기사 월력</button>
            <button data-view="matrix" class="${S.view === 'matrix' ? 'on' : ''}">전체 기사 × 일자</button>
            <button data-view="master" class="${S.view === 'master' ? 'on' : ''}">기사마스터 (소속)</button>
          </div>
          ${S.view === 'cal' ? calView(rows, stats, tIdx) : S.view === 'matrix' ? matrixView(rows, list) : masterView(stats)}
        </main>
      </div>
      <div class="modal" hidden></div>`;
  }

  function calView(rows, stats, tIdx) {
    const st = stats.find((s) => s.dr === S.driver);
    if (!st) return `<div class="empty pad">왼쪽에서 기사를 선택하세요</div>`;
    const mine = rows.filter((r) => r.dr === S.driver).sort((a, b) => a.d.localeCompare(b.d) || a.sq - b.sq);
    const byDate = {};
    mine.forEach((r) => (byDate[r.d] = byDate[r.d] || []).push(r));
    const dates = monthDates(S.month);
    const first = new Date(dates[0] + 'T00:00:00').getDay();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(null);
    dates.forEach((d) => cells.push(d));
    while (cells.length % 7) cells.push(null);
    const t = today();
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    const cal = weeks.map((w) => {
      const wsum = w.reduce((s, d) => s + (d && byDate[d] ? byDate[d].reduce((x, r) => x + (r.a || 0), 0) : 0), 0);
      return `<tr>${w.map((d, i) => {
        if (!d) return `<td class="blank"></td>`;
        const list = byDate[d] || [];
        const sum = list.reduce((s, r) => s + (r.a || 0), 0);
        const loaded = !!S.days[d];
        const tk = tIdx[S.driver + '|' + d];
        return `<td class="day ${list.length ? 'has' : ''} ${d === S.date ? 'sel' : ''} ${d === t ? 'today' : ''}" data-date="${d}">
          <div class="dh"><span class="dn ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${+d.slice(8)}</span>${list.length ? `<span class="dc">${list.length}곳</span>` : !loaded && d <= t ? '<span class="dc muted">미수집</span>' : ''}</div>
          ${list.length ? `<div class="dsum">${won(sum)}</div>` : ''}
          ${tk && (tk.start != null || tk.work) ? `<div class="dtime" title="업무시작~완료 · 총 근무시간">${clock(tk.start)}~${clock(tk.end)} · ${hm(tk.work)}</div>` : ''}
          ${list.length ? `<ul>${list.map((r) => `<li title="${esc(r.cl)} · ${esc(r.co)} · ${esc(r.st)}" class="${r.st !== '완료' ? 'pending' : ''}"><span class="cn">${esc(shortName(r.cl))}</span><span class="ca">${r.a === undefined ? '…' : r.a === null ? '?' : num(r.a)}</span></li>`).join('')}</ul>` : ''}
        </td>`;
      }).join('')}<td class="wk">${wsum ? won(wsum) : ''}</td></tr>`;
    }).join('');

    const cm = new Map();
    mine.forEach((r) => { const c = cm.get(r.cl) || { cl: r.cl, cnt: 0, amt: 0 }; c.cnt++; c.amt += r.a || 0; cm.set(r.cl, c); });
    const clients = [...cm.values()].sort((a, b) => b.amt - a.amt);
    const dayList = S.date ? byDate[S.date] || [] : [];
    const dayTask = S.date ? tIdx[S.driver + '|' + S.date] : null;
    const info = st.info;

    return `
      <div class="dhead">
        <div>
          <div><span class="dname">${esc(st.dr)}</span>${affTag(st.aff)}<span class="tag ${st.type}">${st.type}</span></div>
          <div class="dmeta">
            <span>운행 코스: <b>${esc(st.courseText)}</b></span>
            ${info ? `<span>차량: <b>${esc(info.vehicle || '-')}</b></span><span>기본코스: <b>${esc(info.course || '-')}</b></span><span>${esc(info.inOffice || '')}${info.start ? ' · 입사 ' + esc(info.start) : ''}${info.end ? ' · 퇴사 ' + esc(info.end) : ''}</span>`
              : '<span class="muted2">배송기사 관리에 없는 이름</span>'}
          </div>
        </div>
        <div class="kpis">
          <div><label>월 금액</label><b class="amt">${won(st.amt)}</b></div>
          <div><label>착지</label><b>${num(st.cnt)}</b><small>스낵 ${st.snack} · 조식 ${st.josik}</small></div>
          <div><label>근무일</label><b>${st.work}</b></div>
          <div><label>일평균 착지</label><b>${st.avg.toFixed(1)}</b></div>
          <div><label>일평균 금액</label><b>${won(st.work ? st.amt / st.work : 0)}</b></div>
          <div><label>평균 업무시간</label><b>${clock(st.avgStart)}~${clock(st.avgEnd)}</b><small>근무 ${hm(st.avgWork)}</small></div>
          <div><label>평균 완료율</label><b>${st.avgRate == null ? '-' : st.avgRate.toFixed(1) + '%'}</b></div>
        </div>
      </div>
      <table class="cal"><thead><tr>${['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `<th class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</th>`).join('')}<th>주간 합계</th></tr></thead><tbody>${cal}</tbody></table>
      <p class="hint">날짜를 누르면 아래에 그날 업무현황·방문 상세가 나옵니다. 칸의 시간 = 업무시작~완료 · 총 근무시간 · 주황 = 작업상태 '완료' 아님 · ? = 금액 미확인</p>
      <div class="bottom">
        <section>
          <h4>${S.date ? `${S.date} 방문 상세 <small>${dayList.length}곳 · ${won(dayList.reduce((s, r) => s + (r.a || 0), 0))}</small>` : '날짜를 선택하세요'}</h4>
          ${S.date && dayTask ? `<table class="grid task"><thead><tr><th>코스</th><th>총 작업 수<br><small>배송/재고/커피</small></th><th>사진 등록</th><th class="r">완료율</th><th class="r">총 주문액</th><th>업무시작</th><th>업무완료</th><th class="r">총 근무</th><th class="r">이동</th><th class="r">업무</th></tr></thead><tbody>
            ${dayTask.list.map((x) => `<tr><td>${esc(x.co)}</td><td>${esc(x.jobs)}</td><td>${esc(x.photo)}</td><td class="r">${x.rate == null ? '-' : x.rate.toFixed(1) + '%'}</td><td class="r">${won(x.ord)}</td><td>${esc(x.start || '-')}</td><td>${esc(x.end || '-')}</td><td class="r">${hm(x.work)}</td><td class="r">${hm(x.move)}</td><td class="r">${hm(x.task)}</td></tr>`).join('')}
          </tbody></table>` : S.date ? '<p class="hint">기사 업무현황 기록 없음</p>' : ''}
          ${S.date ? `<table class="grid"><thead><tr><th>순번</th><th>코스</th><th>거래처</th><th>서비스</th><th>상태</th><th class="r">금액</th><th>거래명세</th></tr></thead><tbody>
            ${dayList.map((r) => `<tr><td class="c">${r.sq}</td><td>${esc(r.co)}</td><td title="${esc(r.cl)}">${esc(shortName(r.cl))}</td><td>${esc(r.sv)}</td><td class="${r.st !== '완료' ? 'pending' : ''}">${esc(r.st)}</td><td class="r">${r.a === undefined ? '수집 중' : won(r.a)}</td><td>${r.o ? `<a href="/office/order/order/${encodeURIComponent(r.o)}" target="_blank">${esc(r.o)}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">방문 없음</td></tr>'}
          </tbody></table>` : ''}
        </section>
        <section>
          <h4>거래처별 월 합계 <small>${clients.length}곳</small></h4>
          <table class="grid"><thead><tr><th>거래처</th><th class="r">방문</th><th class="r">금액</th><th class="r">회당 평균</th></tr></thead><tbody>
            ${clients.map((c) => `<tr><td title="${esc(c.cl)}">${esc(shortName(c.cl))}</td><td class="r">${c.cnt}</td><td class="r">${won(c.amt)}</td><td class="r">${won(c.amt / c.cnt)}</td></tr>`).join('')}
          </tbody></table>
        </section>
      </div>`;
  }

  function matrixView(rows, list) {
    const dates = monthDates(S.month).filter((d) => S.days[d] && S.days[d].rows.length);
    const agg = {};
    rows.forEach((r) => { const k = r.dr + '|' + r.d; const a = agg[k] || (agg[k] = { c: 0, a: 0 }); a.c++; a.a += r.a || 0; });
    let max = 0;
    Object.values(agg).forEach((v) => (max = Math.max(max, v.a)));
    const show = new Set(list.map((s) => s.dr));
    const dayTot = dates.map((d) => rows.filter((r) => r.d === d && show.has(r.dr)).reduce((s, r) => s + (r.a || 0), 0));
    return `<p class="hint">단위: 만원 (칸 위에 마우스 = 착지 수) · 칸을 누르면 해당 기사 월력으로 이동 · 왼쪽 목록의 필터(소속·주야·검색)가 그대로 적용</p>
      <div class="mx"><table>
        <thead><tr><th class="stick">기사</th>${dates.map((d) => { const w = new Date(d + 'T00:00:00').getDay(); return `<th class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}">${+d.slice(8)}<br><small>${'일월화수목금토'[w]}</small></th>`; }).join('')}<th>합계</th></tr></thead>
        <tbody>${list.map((s) => `<tr><td class="stick" title="${esc(s.courseText)}">${affTag(s.aff)} ${esc(s.dr)}<small> ${esc([...s.courses].sort().slice(0, 2).join(', ') + (s.courses.size > 2 ? ' 외 ' + (s.courses.size - 2) : ''))}</small></td>${dates.map((d) => {
          const v = agg[s.dr + '|' + d];
          if (!v) return '<td></td>';
          const a = max ? v.a / max : 0;
          return `<td class="mc" data-driver="${esc(s.dr)}" data-date="${d}" title="${v.c}곳 · ${won(v.a)}" style="background:rgba(37,99,235,${(0.08 + a * 0.6).toFixed(2)});color:${a > 0.6 ? '#fff' : '#0f172a'}">${(v.a / 10000).toFixed(0)}</td>`;
        }).join('')}<td class="r b">${(s.amt / 10000).toFixed(0)}</td></tr>`).join('')}
        <tr class="tot"><td class="stick">일 합계</td>${dayTot.map((v) => `<td>${(v / 10000).toFixed(0)}</td>`).join('')}<td class="r b">${(dayTot.reduce((a, b) => a + b, 0) / 10000).toFixed(0)}</td></tr>
        </tbody></table></div>`;
  }

  // ---------------------------------------------------------------- 기사마스터
  function masterRows(stats) {
    const byName = new Map();
    for (const d of DRV.list) {
      const prev = byName.get(d.name);
      if (!prev || d.inOffice === '재직') byName.set(d.name, Object.assign({}, d));
    }
    // 배송일정에는 있는데 배송기사 관리에 없는 이름도 포함
    for (const s of stats) if (!byName.has(s.dr)) byName.set(s.dr, { id: '', dept: '', name: s.dr, vehicle: '', course: '', inOffice: '(목록에 없음)', start: '', end: '' });
    const sm = new Map(stats.map((s) => [s.dr, s]));
    return [...byName.values()].map((d) => Object.assign(d, { aff: affOf(d.name), mCnt: sm.get(d.name) ? sm.get(d.name).cnt : 0, mCourses: sm.get(d.name) ? sm.get(d.name).courseText : '' }));
  }
  function masterView(stats) {
    let rows = masterRows(stats);
    const nNone = rows.filter((r) => r.aff === AFF_NONE && (r.inOffice === '재직' || r.mCnt)).length;
    rows = rows.filter((r) => (!S.mOnlyActive || r.inOffice === '재직' || r.mCnt)
      && (!S.mOnlyNone || r.aff === AFF_NONE)
      && (!S.mq || [r.name, r.vehicle, r.course, r.aff, r.mCourses].some((x) => (x || '').includes(S.mq))));
    const sk = S.mSort;
    rows.sort((a, b) => sk === 'mCnt' ? b.mCnt - a.mCnt : (a[sk] || '').localeCompare(b[sk] || '', 'ko'));
    const opts = CFG.affOptions;
    return `
      <div class="mtool">
        <input class="mq" placeholder="기사·차량·코스·소속 검색" value="${esc(S.mq)}">
        <label><input type="checkbox" data-mchk="mOnlyActive" ${S.mOnlyActive ? 'checked' : ''}> 재직 또는 이번달 운행만</label>
        <label><input type="checkbox" data-mchk="mOnlyNone" ${S.mOnlyNone ? 'checked' : ''}> 소속 미지정만 <b class="warn">${nNone}</b></label>
        <span class="sp"></span>
        <span class="muted2">배송기사 관리 ${DRV.list.length}명 · ${DRV.at ? new Date(DRV.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 조회' : '미조회'}</span>
        <button data-act="drv-refresh">↻ 기사목록 다시 불러오기</button>
        <button data-act="aff-paste">엑셀 붙여넣기</button>
        <button data-act="aff-export">소속 내보내기(CSV)</button>
      </div>
      <p class="hint">기사 정보(차량·기본코스·재직)는 위펀오피스 '배송기사 관리'에서 자동으로 가져옵니다. 소속만 여기서 지정하면 기사 목록·월력·요약에 바로 반영됩니다. (소속은 이 브라우저에 저장 — 다른 PC는 내보내기/붙여넣기로 옮기세요)</p>
      <datalist id="affl">${opts.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>
      <div class="mlist"><table class="grid">
        <thead><tr>${[['aff', '소속'], ['name', '기사'], ['dept', '부서'], ['vehicle', '차량정보'], ['course', '기본코스'], ['mCourses', '이번달 운행코스'], ['mCnt', '이번달 착지'], ['inOffice', '재직'], ['start', '입사일']].map(([k, l]) => `<th data-msort="${k}" class="${S.mSort === k ? 'sorted' : ''}">${l}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><select data-affsel="${esc(r.name)}" class="${r.aff === AFF_NONE ? 'none' : ''}">
            <option value="">${AFF_NONE}</option>${opts.map((o) => `<option ${r.aff === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
            ${r.aff !== AFF_NONE && !opts.includes(r.aff) ? `<option selected>${esc(r.aff)}</option>` : ''}
          </select></td>
          <td><a href="#" data-goto="${esc(r.name)}">${esc(r.name)}</a></td><td>${esc(r.dept)}</td><td>${esc(r.vehicle)}</td><td>${esc(r.course)}</td>
          <td class="co2" title="${esc(r.mCourses)}">${esc(r.mCourses)}</td><td class="r">${r.mCnt || ''}</td><td>${esc(r.inOffice)}</td><td>${esc(r.start)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">기사 없음</td></tr>'}
        </tbody></table></div>`;
  }

  function showModal(html) { const box = app.querySelector('.modal'); box.hidden = false; box.innerHTML = `<div class="card">${html}</div>`; }
  const hideModal = () => { app.querySelector('.modal').hidden = true; };

  function showCfg() {
    showModal(`
      <h3>설정</h3>
      <label>제외 코스 (정확히 일치, 쉼표로 구분)<input name="ex" value="${esc(CFG.excludeExact.join(', '))}"></label>
      <label>제외 코스 (이 글자가 포함되면 제외)<input name="ec" value="${esc(CFG.excludeContains.join(', '))}"></label>
      <label>소속 목록 (쉼표로 구분, 순서대로 표시)<input name="ao" value="${esc(CFG.affOptions.join(', '))}"></label>
      <label>열 때마다 다시 수집할 최근 일수<input name="rd" type="number" min="1" max="31" value="${CFG.recentDays}"></label>
      <label>자동 갱신 주기(분)<input name="ar" type="number" min="1" max="120" value="${CFG.autoRefreshMin}"></label>
      <div class="btns"><button data-act="cfg-reset">기본값</button><button data-act="cache-clear">캐시 비우기</button><span></span><button data-act="modal-cancel">취소</button><button data-act="cfg-save" class="pri">저장</button></div>`);
  }
  function showPaste() {
    showModal(`
      <h3>소속 엑셀 붙여넣기</h3>
      <p class="hint">엑셀에서 <b>기사명 | 소속</b> 두 열을 복사해 붙여넣으세요 (한 줄에 한 명, 탭/쉼표 구분). 기존 값은 덮어씁니다. 처음 보는 소속명은 소속 목록에 자동 추가됩니다.</p>
      <textarea name="paste" rows="12" placeholder="홍길동&#9;대산물류&#10;김철수&#9;창호통운"></textarea>
      <div class="btns"><span></span><button data-act="modal-cancel">취소</button><button data-act="paste-apply" class="pri">적용</button></div>`);
  }

  function setAff(name, val) {
    if (!val || val === AFF_NONE) delete AFF[name]; else AFF[name] = val;
    lsSet(AFF_KEY, AFF);
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const csvLine = (l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

  function exportCSV() {
    const info = drvInfo();
    const rows = monthRows().sort((a, b) => a.d.localeCompare(b.d) || a.dr.localeCompare(b.dr, 'ko') || a.sq - b.sq);
    const head = ['배송일', '배송코스', '배송기사', '소속', '차량정보', '순번', '서비스', '작업상태', '거래처', '거래처(표시명)', '금액(VAT포함)', '거래명세'];
    download(`위로드_기사일별_${S.month}.csv`, [head, ...rows.map((r) => [r.d, r.co, r.dr, affOf(r.dr), info[r.dr] ? info[r.dr].vehicle : '', r.sq, r.sv, r.st, r.cl, shortName(r.cl), r.a ?? '', r.o])].map(csvLine).join('\r\n'));
  }
  function exportAff() {
    const rows = masterRows(driverStats(monthRows(), {}));
    download('위로드_기사마스터_소속.csv', [['기사명', '소속', '부서', '차량정보', '기본코스', '재직', '입사일'], ...rows.map((r) => [r.name, r.aff === AFF_NONE ? '' : r.aff, r.dept, r.vehicle, r.course, r.inOffice, r.start])].map(csvLine).join('\r\n'));
  }

  // ---------------------------------------------------------------- events
  app.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act],[data-filter],[data-sort],[data-driver],[data-date],[data-view],[data-aff],[data-msort],[data-goto]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return closePanel();
    if (act === 'prev') return shiftMonth(-1);
    if (act === 'next') return shiftMonth(1);
    if (act === 'thism') { S.month = today().slice(0, 7); S.date = null; return loadMonth(S.month); }
    if (act === 'refresh') return loadMonth(S.month);
    if (act === 'reload') return loadMonth(S.month, { force: true });
    if (act === 'csv') return exportCSV();
    if (act === 'cfg') return showCfg();
    if (act === 'modal-cancel') return hideModal();
    if (act === 'cfg-reset') { CFG = Object.assign({}, DEFAULT_CFG); lsSet(CFG_KEY, CFG); render(); return; }
    if (act === 'cache-clear') { await DB.open(); await DB.clear(); S.days = {}; hideModal(); return loadMonth(S.month); }
    if (act === 'cfg-save') {
      const v = (n) => app.querySelector(`.modal [name=${n}]`).value;
      const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
      CFG = Object.assign({}, CFG, { excludeExact: list(v('ex')), excludeContains: list(v('ec')), affOptions: list(v('ao')),
        recentDays: Math.max(1, +v('rd') || 3), autoRefreshMin: Math.max(1, +v('ar') || 10) });
      lsSet(CFG_KEY, CFG); S.driver = null; render(); return;
    }
    if (act === 'drv-refresh') { b.disabled = true; b.textContent = '불러오는 중…'; try { await fetchDrivers(); } catch (err) { S.error = '기사목록: ' + err.message; } return render(); }
    if (act === 'aff-paste') return showPaste();
    if (act === 'aff-export') return exportAff();
    if (act === 'paste-apply') {
      const txt = app.querySelector('.modal [name=paste]').value;
      let n = 0;
      for (const line of txt.split(/\r?\n/)) {
        const [name, aff] = line.split(/\t|,/).map((x) => (x || '').trim());
        if (!name || name === '기사명') continue;
        setAff(name, aff); n++;
        if (aff && aff !== AFF_NONE && !CFG.affOptions.includes(aff)) CFG.affOptions.push(aff);
      }
      lsSet(CFG_KEY, CFG); hideModal(); render();
      return;
    }
    if (b.dataset.goto) { e.preventDefault(); S.driver = b.dataset.goto; S.view = 'cal'; S.date = null; S.aff = 'all'; S.q = ''; return render(); }
    if (b.dataset.aff) { S.aff = b.dataset.aff; return render(); }
    if (b.dataset.msort) { S.mSort = b.dataset.msort; return render(); }
    if (b.dataset.filter) { S.filter = b.dataset.filter; return render(); }
    if (b.dataset.view) { S.view = b.dataset.view; return render(); }
    if (b.dataset.sort) {
      const k = b.dataset.sort;
      S.sort = S.sort.k === k ? { k, dir: -S.sort.dir } : { k, dir: ['dr', 'courseText', 'aff'].includes(k) ? 1 : -1 };
      return render();
    }
    if (b.classList.contains('mc')) { S.driver = b.dataset.driver; S.date = b.dataset.date; S.view = 'cal'; return render(); }
    if (b.dataset.driver && b.tagName === 'TR') { S.driver = b.dataset.driver; S.date = null; if (S.view === 'master') S.view = 'cal'; return render(); }
    if (b.dataset.date && b.classList.contains('day')) { S.date = S.date === b.dataset.date ? null : b.dataset.date; render();
      const sec = app.querySelector('.bottom'); if (S.date && sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.affsel != null) { setAff(t.dataset.affsel, t.value); render(); return; }
    if (t.dataset.mchk) { S[t.dataset.mchk] = t.checked; render(); }
  });
  app.addEventListener('input', (e) => {
    const t = e.target;
    const cls = t.classList.contains('q') ? 'q' : t.classList.contains('mq') ? 'mq' : null;
    if (!cls) return;
    S[cls] = t.value.trim();
    const pos = t.selectionStart;
    render();
    const q = app.querySelector('.' + cls); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) { if (!app.querySelector('.modal').hidden) hideModal(); else closePanel(); } });

  // ---------------------------------------------------------------- styles
  function CSS() {
    return `
    :host{all:initial}
    *{box-sizing:border-box;font-family:'Noto Sans KR','Malgun Gothic','맑은 고딕',sans-serif}
    .launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#0f1b33;color:#fff;border:0;border-radius:22px;padding:10px 16px;font-size:13px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer}
    .launch:hover{background:#1d3461}
    .ov{position:fixed;inset:0;z-index:2147483001;background:#f4f6fa}
    .ov[hidden],.launch[hidden],.modal[hidden]{display:none}
    .app{position:relative;height:100%;display:flex;flex-direction:column;color:#0f172a;font-size:12px}
    header{display:flex;align-items:center;gap:16px;background:#0f1b33;color:#fff;padding:10px 16px;flex-wrap:wrap}
    .title b{font-size:17px;letter-spacing:.5px}.title .dev{margin-left:6px;background:#f59e0b;color:#111;font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:4px}.title .en{margin-left:6px;color:#7dd3fc;font-size:11px;font-weight:700;letter-spacing:1px}.title .sub{margin-left:10px;color:#9fb3d9;font-size:11px}
    .nav{display:flex;align-items:center;gap:6px}.mon{font-size:15px;font-weight:700;min-width:96px;text-align:center}
    .tools{margin-left:auto;display:flex;align-items:center;gap:6px}
    button{border:1px solid #cfd8e6;background:#fff;color:#0f172a;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}
    header button{background:#1d2c4d;color:#fff;border-color:#33466f}header button:hover{background:#2a3f6b}
    button:disabled{opacity:.5;cursor:default}
    header .x{font-size:14px;padding:4px 10px}
    .status{color:#cbd8f0;font-size:11px;margin-right:6px}.status.err{color:#fca5a5}
    .spin{display:inline-block;width:10px;height:10px;border:2px solid #9fb3d9;border-top-color:transparent;border-radius:50%;margin-right:6px;animation:sp 1s linear infinite;vertical-align:-1px}
    @keyframes sp{to{transform:rotate(360deg)}}
    .summary{padding:8px 16px;background:#fff;border-bottom:1px solid #e3e8f0;font-size:12.5px}
    .summary .amt,.amt{color:#0b7a3b;font-weight:700}.warn{color:#c2410c;margin-left:6px}
    .excl{float:right;color:#64748b;font-size:11px}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
    .chip{font-size:11px;padding:3px 8px;border-radius:14px;background:#f8fafc}
    .chip.on{border-color:#2563eb;background:#eff6ff;box-shadow:0 0 0 1px #2563eb inset}
    .aff{display:inline-block;padding:1px 7px;border-radius:9px;font-size:10.5px;font-weight:600;white-space:nowrap;margin-right:4px}
    .aff.none{background:#f1f5f9;color:#94a3b8;font-weight:400}
    .body{flex:1;display:flex;min-height:0}
    aside{width:560px;min-width:420px;border-right:1px solid #e3e8f0;background:#fff;display:flex;flex-direction:column}
    .filters{display:flex;gap:8px;padding:8px}
    .q,.mq{flex:1;border:1px solid #cfd8e6;border-radius:6px;padding:5px 8px;font-size:12px}
    .seg{display:flex}.seg button{border-radius:0;margin-left:-1px}.seg button:first-child{border-radius:6px 0 0 6px}.seg button:last-child{border-radius:0 6px 6px 0}
    .seg button.on,.tabs button.on{background:#0f1b33;color:#fff;border-color:#0f1b33}
    .dlist{overflow:auto;flex:1}
    table{border-collapse:collapse;width:100%}
    .dlist th{position:sticky;top:0;background:#f1f4f9;font-weight:600;text-align:left;padding:6px;border-bottom:1px solid #dfe5ee;cursor:pointer;white-space:nowrap}
    th.sorted{color:#1d4ed8}
    .dlist td{padding:6px;border-bottom:1px solid #eef1f6;white-space:nowrap}
    .dlist td.co{color:#64748b;max-width:100px;overflow:hidden;text-overflow:ellipsis}
    .dlist tr{cursor:pointer}.dlist tbody tr:hover{background:#f5f8ff}.dlist tr.sel{background:#e0eaff}
    .r{text-align:right}.c{text-align:center}.b{font-weight:700}
    .empty{color:#94a3b8;text-align:center;padding:20px}.pad{padding:40px}
    main{flex:1;overflow:auto;padding:10px 14px}
    .tabs{display:flex;gap:6px;margin-bottom:8px}
    .dhead{display:flex;justify-content:space-between;align-items:flex-end;background:#fff;border:1px solid #e3e8f0;border-radius:8px;padding:10px 14px;margin-bottom:8px;flex-wrap:wrap;gap:10px}
    .dname{font-size:18px;font-weight:700;margin-right:8px}
    .dmeta{margin-top:4px;color:#475569;display:flex;gap:12px;flex-wrap:wrap}.muted2{color:#94a3b8}
    .tag{margin-left:4px;padding:2px 8px;border-radius:10px;font-size:11px;background:#e0f2fe;color:#0369a1}.tag.야간{background:#ede9fe;color:#6d28d9}.tag.주야{background:#fef3c7;color:#92400e}
    .kpis{display:flex;gap:16px;flex-wrap:wrap}.kpis div{display:flex;flex-direction:column}.kpis label{color:#64748b;font-size:11px}.kpis b{font-size:15px}.kpis small{color:#94a3b8;font-size:10.5px}
    .cal{table-layout:fixed;background:#fff;border:1px solid #dfe5ee}
    .cal th{background:#0f1b33;color:#fff;padding:5px;font-weight:600}.cal th.sun{background:#9b1c1c}.cal th.sat{background:#1e40af}
    .cal th:last-child{width:110px}
    .cal td{border:1px solid #e3e8f0;vertical-align:top;padding:4px 5px;height:96px}
    .cal td.blank{background:#f8fafc}
    .cal td.day{cursor:pointer}.cal td.day:hover{background:#f8fbff}.cal td.sel{outline:2px solid #2563eb;outline-offset:-2px;background:#f0f6ff}
    .cal td.today .dn{background:#2563eb;color:#fff;border-radius:10px;padding:0 6px}
    .dh{display:flex;justify-content:space-between;align-items:center}
    .dn{font-weight:700}.dn.sun{color:#b91c1c}.dn.sat{color:#1d4ed8}
    .dc{font-size:10.5px;color:#475569}.muted{color:#cbd5e1}
    .dsum{font-weight:700;color:#0b7a3b;margin:2px 0 1px;font-size:12.5px}
    .dtime{font-size:10.5px;color:#6d28d9;margin-bottom:2px}
    .cal ul{list-style:none;margin:0;padding:0;max-height:210px;overflow:auto}
    .cal li{display:flex;justify-content:space-between;gap:4px;font-size:10.5px;line-height:1.45;border-top:1px dotted #edf0f5}
    .cal li .cn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155}
    .cal li .ca{color:#0f172a;white-space:nowrap}
    .cal li.pending .cn{color:#c2410c}
    .cal td.wk{background:#f1f5f9;text-align:right;font-weight:700;vertical-align:middle}
    .hint{color:#64748b;font-size:11px;margin:6px 2px}
    .bottom{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin-top:6px}
    .bottom section{background:#fff;border:1px solid #e3e8f0;border-radius:8px;padding:10px;min-width:0}
    h4{margin:0 0 8px;font-size:13px}h4 small{color:#64748b;font-weight:400;margin-left:6px}
    .grid th{background:#f1f4f9;padding:5px;text-align:left;font-weight:600;border-bottom:1px solid #dfe5ee;white-space:nowrap}
    .grid th small{font-weight:400;color:#64748b}
    .grid td{padding:5px;border-bottom:1px solid #eef1f6}
    .grid.task{margin-bottom:10px}.grid.task th{background:#f3effe}
    .grid a{color:#1d4ed8}
    .pending{color:#c2410c}
    .mx{overflow:auto;background:#fff;border:1px solid #dfe5ee;max-height:calc(100vh - 230px)}
    .mx table{width:auto}
    .mx th{position:sticky;top:0;background:#f1f4f9;padding:4px 6px;font-weight:600;border-bottom:1px solid #dfe5ee;z-index:1}
    .mx th.sun{color:#b91c1c}.mx th.sat{color:#1d4ed8}
    .mx td{padding:4px 6px;text-align:right;border:1px solid #f1f4f9;min-width:42px}
    .mx .stick{position:sticky;left:0;background:#fff;text-align:left;white-space:nowrap;z-index:2}
    .mx th.stick{z-index:3;background:#f1f4f9}
    .mx .stick small{color:#94a3b8}
    .mx td.mc{cursor:pointer}
    .mx tr.tot td{font-weight:700;background:#f8fafc}
    .mtool{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #e3e8f0;border-radius:8px;padding:8px}
    .mtool .mq{flex:0 0 220px}.mtool .sp{flex:1}.mtool label{display:flex;align-items:center;gap:4px;color:#334155}
    .mlist{background:#fff;border:1px solid #e3e8f0;border-radius:8px;overflow:auto;max-height:calc(100vh - 290px)}
    .mlist th{position:sticky;top:0;cursor:pointer;z-index:1}
    .mlist select{font-size:12px;padding:2px 4px;border:1px solid #cfd8e6;border-radius:5px;min-width:96px}
    .mlist select.none{color:#94a3b8;border-color:#fdba74}
    .mlist td.co2{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b}
    .modal{position:absolute;inset:0;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:5}
    .modal .card{background:#fff;border-radius:10px;padding:18px;width:500px;display:flex;flex-direction:column;gap:10px}
    .modal h3{margin:0}.modal label{display:flex;flex-direction:column;gap:4px;color:#334155}
    .modal input,.modal textarea{border:1px solid #cfd8e6;border-radius:6px;padding:6px 8px;font-size:12px}
    .modal .btns{display:flex;gap:6px}.modal .btns span{flex:1}.pri{background:#0f1b33;color:#fff;border-color:#0f1b33}
    `;
  }
})();
