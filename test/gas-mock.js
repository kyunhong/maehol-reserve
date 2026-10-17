// Apps Script 서비스(SpreadsheetApp, PropertiesService, CacheService, LockService, Utilities …)를
// 흉내 내서 apps-script/Code.gs 를 Node 에서 그대로 실행한다.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const TZ = 'Asia/Seoul';

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.data[this.row - 1 + r] || [];
      const vals = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = line[this.col - 1 + c];
        vals.push(v === undefined ? '' : v);
      }
      out.push(vals);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  getLastRow() { return this.data.length; }
  getMaxRows() { return 1000; }
  getRange(row, col, numRows, numCols) { return new FakeRange(this, row, col, numRows, numCols); }
  setFrozenRows() {}
  hideColumns() {}
}

function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const u = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return pattern
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
    .replace(/^u$/, String(u));
}

/**
 * Code.gs 를 새 환경에 불러온다.
 * now: 'YYYY-MM-DDTHH:mm' (서울 시각). 이 시각으로 고정된 Date 를 쓴다.
 */
function loadServer({ now = '2026-10-19T07:00', props = {} } = {}) {
  const sheets = new Map();
  const properties = new Map(Object.entries(props));
  const cache = new Map();
  let fixedMs = Date.parse(now + ':00+09:00');

  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets.get(n) || null,
        insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => TZ },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => [...crypto.createHash(alg).update(str, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate,
    },
  };
  vm.createContext(context);
  vm.runInContext(CODE, context, { filename: 'Code.gs' });
  // 인자 없는 new Date() 만 고정 시각으로
  context.__now = () => fixedMs;
  vm.runInContext(`
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(__now()); }
      static now() { return __now(); }
    };`, context);

  /** doPost 로 요청하고 { ok, data, error } 를 돌려준다 */
  function call(action, params = {}) {
    const out = context.doPost({ postData: { contents: JSON.stringify({ action, ...params }) } });
    return JSON.parse(out.text);
  }
  /** 성공해야 하는 요청: data 를 돌려주고, 실패면 예외 */
  function ok(action, params) {
    const res = call(action, params);
    if (!res.ok) throw new Error(`${action} 실패: ${res.error}`);
    return res.data;
  }
  /** 실패해야 하는 요청: 오류 메시지를 돌려주고, 성공이면 예외 */
  function err(action, params) {
    const res = call(action, params);
    if (res.ok) throw new Error(`${action} 가 성공하면 안 됨: ${JSON.stringify(res.data)}`);
    return res.error;
  }

  return {
    call, ok, err, context, properties, cache, sheets,
    setNow(s) { fixedMs = Date.parse(s + ':00+09:00'); },
    sheet: (n) => sheets.get(n),
  };
}

module.exports = { loadServer };
