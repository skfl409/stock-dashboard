// 원재료 재고알림 대시보드 — 정적 웹페이지 생성기
// 1) 넥스트고 ERP(MCP)에서 데이터를 가져오고  2) 대시보드와 같은 계산을 돌려  3) dist/index.html 한 장으로 만든다.
// 실행: ERP_MCP_URL=<넥스트고 ERP 연결 주소> node build.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ERP = process.env.ERP_MCP_URL;
if (!ERP) { console.error('ERP_MCP_URL 환경변수가 필요합니다'); process.exit(1); }

// ── MCP(JSON-RPC over HTTP) 클라이언트
let sid = null, seq = 0;
async function rpc(method, params, notify) {
  const body = { jsonrpc: '2.0', method, params };
  if (!notify) body.id = ++seq;
  const res = await fetch(ERP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body),
  });
  sid = res.headers.get('mcp-session-id') || sid;
  if (notify) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  let msg = null;
  if (/^\s*[{[]/.test(text)) msg = JSON.parse(text);
  else {
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    for (const d of datas) { try { const j = JSON.parse(d); if (j.id === body.id) msg = j; } catch (e) { /* skip */ } }
  }
  if (!msg) throw new Error(`${method}: 응답을 읽지 못했습니다`);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
async function call(tool, args) {
  const r = await rpc('tools/call', { name: tool, arguments: args || {} });
  const text = (r.content || []).map((c) => c.text || '').join('');
  if (r.isError) throw new Error(`${tool}: ${text.slice(0, 200)}`);
  return text;
}

// ── 대시보드의 데이터 출처(같은 호출)
const SOURCES = {
  raw_stock: ['inventory_status', { category: 'RAW', includeZero: true, limit: 500 }],
  fg_stock: ['inventory_status', { category: 'FINISHED', includeZero: true, limit: 500 }],
  bom: ['inventory_status', { category: 'FINISHED', includeZero: true, limit: 500 }],
  flow: ['inventory_status', { category: 'FINISHED', includeZero: true, limit: 500 }],
  pkg: ['inventory_status', { category: 'PACKAGING', includeZero: false, limit: 500 }],
};

async function main() {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stock-dashboard', version: '1.0' } });
  await rpc('notifications/initialized', {}, true);

  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const s0 = tpl.indexOf('<script>'), s1 = tpl.indexOf('</script>', s0);
  const dataScript = tpl.slice(s0 + 8, s1);
  const pageWithoutData = tpl.slice(0, s0) + tpl.slice(s1 + 9);

  // 대시보드 계산 코드를 그대로 돌리기 위한 작은 dash 흉내
  const loaders = {}, calcs = {};
  const dash = {
    loader: (id, o) => { loaders[id] = o; },
    calc: (id, o) => { calcs[id] = o; },
    params: () => ({ made_ov: '{}' }),
  };
  vm.runInNewContext(dataScript, { dash, console, Date, Math, JSON, Promise, Object, Array, String, Number, Set, Map, encodeURIComponent });

  const data = {};
  const answers = {};
  for (const [id, [tool, args]] of Object.entries(SOURCES)) {
    const key = tool + JSON.stringify(args);
    if (!answers[key]) answers[key] = await call(tool, args);
    const L = loaders[id];
    let out = L ? await L.fn({ answer: answers[key], call }) : JSON.parse(answers[key]);
    if (out && Array.isArray(out.rows)) out = out.rows;
    data[id] = out;
    console.log(id, Array.isArray(out) ? out.length + ' rows' : typeof out);
  }
  data.ad_spend = []; // NX Ads(광고 순위)는 웹페이지 버전에 없음

  const busy = new Set();
  const get = (id) => {
    if (id in data) return data[id];
    const c = calcs[id];
    if (!c) return [];
    if (busy.has(id)) throw new Error('순환 계산: ' + id);
    busy.add(id);
    const v = c.fn(...c.inputs.map(get));
    busy.delete(id);
    data[id] = v;
    return v;
  };
  Object.keys(calcs).forEach(get);

  const builtAt = new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const shim = fs.readFileSync(path.join(__dirname, 'shim.html'), 'utf8')
    .replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'))
    .replace(/__BUILT_AT__/g, builtAt);
  const html = shim.replace('__PAGE__', () => pageWithoutData);
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html);
  console.log('완료: dist/index.html', (html.length / 1024).toFixed(0) + 'KB', builtAt);
}

main().catch((e) => { console.error(e); process.exit(1); });
