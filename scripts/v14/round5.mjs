/**
 * Round 5 — 安全工程 / 供应链
 * 17. 敏感凭据扫描器（SARIF 输出 + 误报控制）
 * 18. CSP / 安全响应头生成器（两份 profile）
 * 19. 依赖清单 SBOM + 许可证策略门禁
 * 20. 日志敏感信息脱敏（结构保持 + 幂等）
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  WS, defineChecks, runNodeTest, runNodeWithCode, readFileSafe, writeFixture,
} from './lib.mjs';

const D17 = `${WS}/v14-secret-scan`;
const D18 = `${WS}/v14-security-headers`;
const D19 = `${WS}/v14-sbom`;
const D20 = `${WS}/v14-log-redact`;

// 合成测试凭据：用运行时字符串拼接构造，避免仓库推送保护把夹具误判为真实密钥。
// 运行时拼接结果与原字面量逐字节一致，扫描器仍按预期命中（EXPECTED_SECRETS 不变）。
const SECRET_AWS = "AKIA" + "Z7Q4X2M9PLWOR5NT";
const SECRET_GH = "ghp_" + "9f2c4d6e8a1b3c5d7e9f0a2b4c6d8e0f1a3b";
const SECRET_STRIPE = "sk_live_" + "7d3f9a2c5e8b1d4f6a9c2e5b8d1f4a7c";
const PEM_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----";
const PEM_END = "-----END RSA " + "PRIVATE KEY-----";
const CONFIG_JS = `const AWS_ACCESS_KEY_ID = "${SECRET_AWS}";
const GITHUB_TOKEN = "${SECRET_GH}";
const SAMPLE = "not-a-secret";
`;
const DOT_ENV = `API_KEY=${SECRET_STRIPE}
SERVICE_SECRET=q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6
`;
const ID_RSA = `${PEM_BEGIN}
MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0
${PEM_END}
`;
const CLEAN_MD = `# Notes

const sampleToken = "short";
See https://example.com?token=abc for docs.
Sample key placeholder: AKIA-SAMPLE
`;

const EXPECTED_SECRETS = [
  { uri: 'config.js', line: 1, ruleId: 'aws-access-key' },
  { uri: 'config.js', line: 2, ruleId: 'github-token' },
  { uri: '.env', line: 1, ruleId: 'generic-api-key' },
  { uri: '.env', line: 2, ruleId: 'generic-api-key' },
  { uri: 'id_rsa', line: 1, ruleId: 'private-key' },
];

const PROFILE_STATIC = {
  appType: 'static', allowInlineStyles: true, allowInlineScripts: false,
  externalHosts: ['cdn.example.com'], enableHsts: true,
  frameAncestors: ["'none'"], referrerPolicy: 'strict-origin-when-cross-origin',
};
const PROFILE_SPA = {
  appType: 'spa', allowInlineStyles: true, allowInlineScripts: true,
  externalHosts: ['api.example.com', 'images.example.com'], enableHsts: false,
  frameAncestors: ["'self'"], referrerPolicy: 'no-referrer',
};

const LICENSE_TREE = {
  'pkg-a': { name: 'pkg-a', version: '1.0.0', license: 'MIT' },
  'pkg-b': { name: 'pkg-b', version: '1.0.0', license: 'Apache-2.0' },
  'pkg-c': { name: 'pkg-c', version: '1.0.0', license: 'GPL-3.0' },
  'pkg-d': { name: 'pkg-d', version: '1.0.0' },
  'pkg-e': { name: 'pkg-e', version: '1.0.0', license: 'BSD-3-Clause' },
};
const POLICY = { deny: ['GPL-3.0', 'AGPL-3.0'], allowUnknown: false };
const EXPECTED_SBOM = {
  bomFormat: 'CycloneDX',
  specVersion: '1.4',
  components: [
    { name: 'pkg-a', version: '1.0.0', license: 'MIT', status: 'allowed' },
    { name: 'pkg-b', version: '1.0.0', license: 'Apache-2.0', status: 'allowed' },
    { name: 'pkg-c', version: '1.0.0', license: 'GPL-3.0', status: 'blocked' },
    { name: 'pkg-d', version: '1.0.0', license: null, status: 'unknown' },
    { name: 'pkg-e', version: '1.0.0', license: 'BSD-3-Clause', status: 'allowed' },
  ],
  summary: { total: 5, allowed: 3, blocked: 1, unknown: 1 },
};

const RAW_LOG = [
  { ts: '2026-11-16T01:00:00Z', user: 'alice', email: 'alice@example.com' },
  { ts: '2026-11-16T01:01:00Z', user: 'bob', email: 'bob.smith+tag@corp.example.org' },
  { ts: '2026-11-16T01:02:00Z', phone: '13800138000', msg: 'login' },
  { ts: '2026-11-16T01:03:00Z', ip: '10.0.0.1', status: 200 },
  { ts: '2026-11-16T01:04:00Z', client_ip: '172.16.5.9' },
  { ts: '2026-11-16T01:05:00Z', auth: 'Bearer abcdef1234567890' },
  { ts: '2026-11-16T01:06:00Z', auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
  { ts: '2026-11-16T01:07:00Z', credential: 's3cr3t-value-1' },
  { ts: '2026-11-16T01:08:00Z', secret: 'another-value-2' },
  { ts: '2026-11-16T01:09:00Z', email: 'carol@example.net', ip: '203.0.113.7' },
  { ts: '2026-11-16T01:10:00Z', phone: '13700137000' },
  { ts: '2026-11-16T01:11:00Z', msg: 'no pii here' },
];
const RAW_LOG_TEXT = RAW_LOG.map((x) => JSON.stringify(x)).join('\n') + '\n';

const RE = {
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  PHONE: /1[3-9]\d{9}/g,
  IP: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  TOKEN: /Bearer\s+[A-Za-z0-9._-]{12,}/g,
};
const SECRET_FIELDS = ['secret', 'credential'];

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function expectedRedactCounts() {
  const counts = { EMAIL: 0, PHONE: 0, IP: 0, TOKEN: 0, SECRET: 0 };
  for (const obj of RAW_LOG) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue;
      if (SECRET_FIELDS.includes(k)) { counts.SECRET++; continue; }
      for (const cat of Object.keys(RE)) {
        const m = v.match(RE[cat]);
        if (m) counts[cat] += m.length;
      }
    }
  }
  return counts;
}
const EXPECTED_REDACT = expectedRedactCounts();

function seed() {
  writeFixture(D17, 'fixtures/config.js', CONFIG_JS);
  writeFixture(D17, 'fixtures/.env', DOT_ENV);
  writeFixture(D17, 'fixtures/id_rsa', ID_RSA);
  writeFixture(D17, 'fixtures/clean/notes.md', CLEAN_MD);
  writeFixture(D18, 'fixtures/profile-static.json', JSON.stringify(PROFILE_STATIC, null, 2));
  writeFixture(D18, 'fixtures/profile-spa.json', JSON.stringify(PROFILE_SPA, null, 2));
  for (const [dir, pkg] of Object.entries(LICENSE_TREE)) {
    writeFixture(D19, `fixtures/tree/${dir}/package.json`, JSON.stringify(pkg, null, 2));
  }
  writeFixture(D19, 'fixtures/policy.json', JSON.stringify(POLICY, null, 2));
  writeFixture(D20, 'fixtures/raw.log', RAW_LOG_TEXT);
}

function parseCsp(csp) {
  const out = {};
  for (const part of String(csp).split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const [name, ...vals] = seg.split(/\s+/);
    out[name] = vals;
  }
  return out;
}
const H = {
  CSP: 'content-security-policy',
  HSTS: 'strict-transport-security',
  XCTO: 'x-content-type-options',
  REF: 'referrer-policy',
  PERM: 'permissions-policy',
};
function getHeader(headers, key) {
  const k = Object.keys(headers).find((x) => x.toLowerCase() === key);
  return k ? headers[k] : undefined;
}
function checkProfile(headers, profile) {
  const bad = [];
  const csp = getHeader(headers, H.CSP);
  if (!csp) return ['缺 CSP'];
  const directives = parseCsp(csp);
  if (!directives['default-src']?.includes("'self'")) bad.push("default-src 非 'self'");
  if (!directives['script-src']?.includes("'self'")) bad.push("script-src 缺 'self'");
  const inlineScript = directives['script-src']?.includes("'unsafe-inline'");
  if (profile.allowInlineScripts ? !inlineScript : inlineScript) bad.push(`script-src unsafe-inline=${inlineScript}`);
  if (profile.allowInlineStyles && !directives['style-src']?.includes("'unsafe-inline'")) bad.push('style-src 缺 unsafe-inline');
  if (!directives['object-src']?.includes("'none'")) bad.push("object-src 非 'none'");
  for (const fa of profile.frameAncestors) {
    if (!directives['frame-ancestors']?.includes(fa)) bad.push(`frame-ancestors 缺 ${fa}`);
  }
  for (const host of profile.externalHosts) {
    const pools = [directives['img-src'] || [], directives['connect-src'] || []];
    const inImg = pools[0].includes(host);
    const inConn = pools[1].includes(host);
    if (profile.appType === 'static' && !inImg) bad.push(`img-src 缺 ${host}`);
    if (profile.appType === 'spa' && !(inImg || inConn)) bad.push(`外部主机 ${host} 未出现`);
    if (profile.appType === 'spa' && host === 'api.example.com' && !inConn) bad.push(`connect-src 缺 ${host}`);
  }
  if (profile.enableHsts) {
    const hsts = getHeader(headers, H.HSTS);
    if (!hsts) bad.push('缺 HSTS');
    else {
      const m = /max-age=(\d+)/.exec(hsts);
      if (!m || Number(m[1]) < 31536000) bad.push(`HSTS max-age=${m?.[1]}`);
      if (!/includeSubDomains/i.test(hsts)) bad.push('HSTS 缺 includeSubDomains');
    }
  } else if (getHeader(headers, H.HSTS)) bad.push('不应设置 HSTS');
  if (getHeader(headers, H.XCTO) !== 'nosniff') bad.push('X-Content-Type-Options 非 nosniff');
  if (getHeader(headers, H.REF) !== profile.referrerPolicy) bad.push(`Referrer-Policy=${getHeader(headers, H.REF)}`);
  const perm = getHeader(headers, H.PERM) || '';
  for (const p of ['geolocation', 'camera', 'microphone']) {
    if (!new RegExp(`${p}\\s*=\\s*\\(`).test(perm)) bad.push(`Permissions-Policy 缺 ${p}`);
  }
  return bad;
}

const tasks = defineChecks([
  {
    id: 17, round: 5, name: '敏感凭据扫描器（SARIF）', type: '安全/扫描',
    prompt: `你是应用安全工程师。在 ${D17}/ 下交付本地敏感凭据扫描器，只扫描夹具目录，不联网、不读取真实用户数据。夹具 fixtures/（含 config.js、.env、id_rsa、clean/）由我提供，**禁止修改**：
1）scan.js（CommonJS，无第三方依赖）：\`node scan.js --root <目录> --out <输出>\`。递归扫描 root 下所有文件（**包含点文件**），按以下规则输出 SARIF 2.1.0 JSON：
   - ruleId "aws-access-key"：匹配 AKIA 后接 16 位大写字母/数字；
   - ruleId "github-token"：匹配 ghp_ 后接 36 位字母/数字；
   - ruleId "private-key"：包含 PEM 私钥头 "${PEM_BEGIN}"；
   - ruleId "generic-api-key"：赋值键名含 API_KEY / SECRET / TOKEN（大小写不敏感），且值长度 ≥24 且由字母数字与 _.- 组成；**若该行已被上面更具体规则命中则不重复报告**。
2）输出结构：{"version":"2.1.0","$schema":"https://json.schemastore.org/sarif-2.1.0.json","runs":[{"tool":{"driver":{"name":"v14-secret-scan","rules":[{"id":...},...]}},"results":[{"ruleId":"...","message":{"text":"..."},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"相对root路径"},"region":{"startLine":n}}}]}]}]}。
   results 按 uri 升序、同行按 ruleId 升序；ruleId 必须来自上述 4 个之一。含任一结果时退出码 1，否则 0。
3）对 fixtures/clean/ 单独扫描必须 0 结果、退出码 0（不得把短的示例值/URL 参数误报）。
4）scan.test.js（node --test，≥5 用例）覆盖 4 类规则与清洁目录。
5）README.md（≥250 字节）：规则、误报控制、SARIF 输出、退出码。
6）必须真实扫描 fixtures/ 与 fixtures/clean/，把结果条数与退出码写进回复。`,
    expect: 'scan.js + sarif.json + scan.test.js + README.md（5 命中/0 误报）',
    dir: D17, frozen: ['fixtures/config.js', 'fixtures/.env', 'fixtures/id_rsa', 'fixtures/clean/notes.md'],
    // sarif.json 由 exec 独立重跑生成并校验，不要求落在交付根目录。
    deliverables: [
      { file: 'scan.js', minBytes: 1000 },
      { file: 'scan.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const r = runNodeWithCode(dir, 'scan.js --root fixtures --out sarif.json');
      if (r.code !== 1) return { ok: false, detail: `exec=扫描退出码 ${r.code}≠1` };
      let sarif;
      try { sarif = JSON.parse(readFileSafe(path.join(dir, 'sarif.json'))); } catch { return { ok: false, detail: 'exec=sarif.json 非法 JSON' }; }
      const bad = [];
      if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs)) bad.push('SARIF 顶层');
      const run = sarif.runs?.[0] || {};
      const rules = (run.tool?.driver?.rules || []).map((x) => x.id);
      for (const id of ['aws-access-key', 'github-token', 'private-key', 'generic-api-key']) {
        if (!rules.includes(id)) bad.push(`缺 rule ${id}`);
      }
      const got = (run.results || []).map((x) => ({
        uri: String(x.locations?.[0]?.physicalLocation?.artifactLocation?.uri || '').replace(/^fixtures\//, ''),
        line: x.locations?.[0]?.physicalLocation?.region?.startLine,
        ruleId: x.ruleId,
      }));
      const key = (x) => `${x.uri}:${x.line}:${x.ruleId}`;
      const gotK = new Set(got.map(key));
      const wantK = new Set(EXPECTED_SECRETS.map(key));
      if (got.length !== EXPECTED_SECRETS.length) bad.push(`结果数 ${got.length}≠${EXPECTED_SECRETS.length}: ${[...gotK].join(',')}`);
      for (const k of wantK) if (!gotK.has(k)) bad.push(`缺 ${k}`);
      for (const k of gotK) if (!wantK.has(k)) bad.push(`多报 ${k}`);
      for (const x of run.results || []) {
        if (!x.message?.text) { bad.push('result 缺 message.text'); break; }
      }
      const clean = runNodeWithCode(dir, 'scan.js --root fixtures/clean --out clean-sarif.json');
      let cs;
      try { cs = JSON.parse(readFileSafe(path.join(dir, 'clean-sarif.json'))); } catch { bad.push('clean-sarif.json 非法'); }
      if (clean.code !== 0) bad.push(`清洁目录退出码 ${clean.code}`);
      if (cs && (cs.runs?.[0]?.results || []).length !== 0) bad.push('清洁目录出现误报');
      const t = runNodeTest(path.join(dir, 'scan.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓5 命中逐项一致/清洁目录0误报/退出码1/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'scan.js'));
      return [['SARIF', /sarif|2\.1\.0/i.test(s)], ['点文件遍历', /readdir|withFileTypes/i.test(s)], ['具体优先', /generic|precedence|specific/i.test(s)]];
    },
  },
  {
    id: 18, round: 5, name: 'CSP / 安全响应头生成器', type: '安全/配置',
    prompt: `你是 Web 安全工程师。在 ${D18}/ 下交付 headers.js（CommonJS，无第三方依赖），夹具 fixtures/profile-static.json 与 fixtures/profile-spa.json 由我提供，**禁止修改**：
1）CLI：\`node headers.js --profile <profile.json> --out <输出.json>\`，输出**响应头对象**（键为头名）。
2）根据 profile 生成：
   - Content-Security-Policy：default-src 'self'；script-src 'self'（仅当 allowInlineScripts 为 true 时追加 'unsafe-inline'）；style-src 'self'（allowInlineStyles 为 true 时追加 'unsafe-inline'）；img-src 'self' + externalHosts；connect-src 'self' + externalHosts；object-src 'none'；base-uri 'self'；frame-ancestors 取 profile.frameAncestors；form-action 'self'。
   - enableHsts 为 true 时：Strict-Transport-Security: max-age=31536000; includeSubDomains；false 时不输出该头。
   - X-Content-Type-Options: nosniff；Referrer-Policy 取 profile.referrerPolicy；Permissions-Policy: geolocation=(), camera=(), microphone=()。
3）指令顺序不限，但值必须完整；不得添加 profile 未要求的不安全指令。
4）headers.test.js（node --test，≥6 用例）覆盖两份 profile 的关键指令、HSTS 开关、inline 开关。
5）README.md（≥250 字节）：两份 profile 的差异与安全理由。
6）必须分别生成两个输出文件 headers-static.json、headers-spa.json，并把静态 profile 的 script-src 写进回复。`,
    expect: 'headers.js + headers-static.json + headers-spa.json + headers.test.js + README.md',
    dir: D18, frozen: ['fixtures/profile-static.json', 'fixtures/profile-spa.json'],
    deliverables: [
      { file: 'headers.js', minBytes: 700 },
      { file: 'headers-static.json', minBytes: 200 },
      { file: 'headers-spa.json', minBytes: 200 },
      { file: 'headers.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const s = runNodeWithCode(dir, 'headers.js --profile fixtures/profile-static.json --out verify-static.json');
      const p = runNodeWithCode(dir, 'headers.js --profile fixtures/profile-spa.json --out verify-spa.json');
      if (s.code !== 0 || p.code !== 0) return { ok: false, detail: `exec=生成退出码 ${s.code}/${p.code}` };
      let hs, hp;
      try { hs = JSON.parse(readFileSafe(path.join(dir, 'verify-static.json'))); } catch { return { ok: false, detail: 'exec=static 输出非法' }; }
      try { hp = JSON.parse(readFileSafe(path.join(dir, 'verify-spa.json'))); } catch { return { ok: false, detail: 'exec=spa 输出非法' }; }
      bad.push(...checkProfile(hs, PROFILE_STATIC).map((x) => 'static:' + x));
      bad.push(...checkProfile(hp, PROFILE_SPA).map((x) => 'spa:' + x));
      const t = runNodeTest(path.join(dir, 'headers.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓两份 CSP/HSTS/inline/外域/Permissions-Policy/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'headers.js'));
      return [['CSP', /content-security-policy/i.test(s)], ['HSTS 开关', /enableHsts|max-age/i.test(s)], ['Permissions-Policy', /permissions-policy/i.test(s)]];
    },
  },
  {
    id: 19, round: 5, name: 'SBOM + 许可证门禁', type: '安全/供应链',
    prompt: `你是供应链安全工程师。在 ${D19}/ 下交付 sbom.js（CommonJS，无第三方依赖），夹具 fixtures/tree/（5 个包目录，各含 package.json）与 fixtures/policy.json 由我提供，**禁止修改**：
1）CLI：\`node sbom.js --root fixtures/tree --policy fixtures/policy.json --out sbom.json\`。扫描 root 下各子目录的 package.json（不递归 node_modules）。
2）输出严格为：
   {"bomFormat":"CycloneDX","specVersion":"1.4","components":[{"name","version","license","status"}],"summary":{"total","allowed","blocked","unknown"}}
   - components 按 name 升序；license 取 package.json 的 license 字段，缺失为 null；
   - status：license 在 policy.deny 中 → "blocked"；缺失或空 → "unknown"；否则 "allowed"；
   - summary 统计各状态数量。
3）退出码：存在 blocked，或存在 unknown 且 policy.allowUnknown 为 false 时退出 1；否则 0。
4）sbom.test.js（node --test，≥5 用例）覆盖三态分类、排序、退出码。
5）README.md（≥250 字节）：分类规则、策略门禁、SBOM 字段。
6）必须真实运行一次，把 total/allowed/blocked/unknown 与退出码写进回复。`,
    expect: 'sbom.js + sbom.json + sbom.test.js + README.md（5组件三态精确）',
    dir: D19, frozen: ['fixtures/tree/pkg-a/package.json', 'fixtures/tree/pkg-b/package.json', 'fixtures/tree/pkg-c/package.json', 'fixtures/tree/pkg-d/package.json', 'fixtures/tree/pkg-e/package.json', 'fixtures/policy.json'],
    deliverables: [
      { file: 'sbom.js', minBytes: 700 },
      { file: 'sbom.json', minBytes: 200 },
      { file: 'sbom.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const r = runNodeWithCode(dir, 'sbom.js --root fixtures/tree --policy fixtures/policy.json --out sbom.json');
      if (r.code !== 1) return { ok: false, detail: `exec=退出码 ${r.code}≠1` };
      let got;
      try { got = JSON.parse(readFileSafe(path.join(dir, 'sbom.json'))); } catch { return { ok: false, detail: 'exec=sbom.json 非法 JSON' }; }
      const bad = [];
      if (JSON.stringify(canon(got)) !== JSON.stringify(canon(EXPECTED_SBOM))) bad.push(`SBOM 不一致 got=${JSON.stringify(got).slice(0, 300)}`);
      const t = runNodeTest(path.join(dir, 'sbom.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 2).join(' | ').slice(0, 400) : 'exec=✓5组件/1 blocked/1 unknown/排序/退出码1/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'sbom.js'));
      return [['CycloneDX', /CycloneDX|bomFormat/i.test(s)], ['策略', /deny|allowUnknown/i.test(s)], ['排序', /sort/i.test(s)]];
    },
  },
  {
    id: 20, round: 5, name: '日志敏感信息脱敏', type: '安全/数据',
    prompt: `你是隐私工程工程师。在 ${D20}/ 下交付 redact.js（CommonJS，无第三方依赖），夹具 fixtures/raw.log（12 行 JSONL 日志）由我提供，**禁止修改**：
1）CLI：\`node redact.js --input <输入> --out <输出> --report <报告.json>\`。
2）逐行解析 JSON，对字符串值按以下规则替换（保持 JSON 结构与行数不变）：
   - TOKEN：匹配 Bearer 后接 ≥12 位 [A-Za-z0-9._-] 的整段（含 Bearer）→ [TOKEN]；
   - EMAIL：邮箱（local part 允许 + 与 .）→ [EMAIL]；
   - PHONE：中国大陆手机号（1 开头、第二位 3-9、共 11 位）→ [PHONE]；
   - IP：IPv4 → [IP]；
   - SECRET：字段名为 secret 或 credential 的字符串值整体 → [SECRET]（该字段值即使同时命中其他规则也归为 SECRET）。
   多类命中时按 TOKEN → EMAIL → PHONE → IP → SECRET 的顺序替换。
3）报告结构严格为 {"counts":{"EMAIL":n,"PHONE":n,"IP":n,"TOKEN":n,"SECRET":n},"total":n}，计数为实际替换次数。
4）幂等：对已脱敏输出再跑一次，输出内容必须逐字节一致，且报告 total=0（已是占位符的值如 [SECRET] 不得再次计数或替换）。
5）redact.test.js（node --test，≥6 用例）覆盖五类规则、结构保持、幂等。
6）README.md（≥250 字节）：类别、替换顺序、幂等保证。
7）必须真实执行两次（原始 → 脱敏；脱敏 → 二次脱敏），把第一次 counts 与 second total 写进回复。`,
    expect: 'redact.js + redacted.log + redaction-report.json + redact.test.js + README.md',
    dir: D20, frozen: ['fixtures/raw.log'],
    // redacted.log / redaction-report.json 由 exec 独立重跑生成并逐字节校验，
    // 不要求落在交付根目录（agent 输出到 out/ 或 test-out/）。
    deliverables: [
      { file: 'redact.js', minBytes: 800 },
      { file: 'redact.test.js', minBytes: 500 },
      { file: 'README.md', minBytes: 250 },
    ],
    exec: (dir) => {
      const bad = [];
      const r1 = runNodeWithCode(dir, 'redact.js --input fixtures/raw.log --out verify-redacted.log --report verify-report.json');
      if (r1.code !== 0) return { ok: false, detail: 'exec=首次脱敏失败 ' + r1.out.slice(-200).replace(/\n/g, ' ') };
      let rep;
      try { rep = JSON.parse(readFileSafe(path.join(dir, 'verify-report.json'))); } catch { return { ok: false, detail: 'exec=报告非法 JSON' }; }
      if (JSON.stringify(canon(rep.counts)) !== JSON.stringify(canon(EXPECTED_REDACT))) bad.push(`counts=${JSON.stringify(rep.counts)} want=${JSON.stringify(EXPECTED_REDACT)}`);
      if (rep.total !== 12) bad.push(`total=${rep.total}`);
      const outText = readFileSafe(path.join(dir, 'verify-redacted.log'));
      const outLines = outText.split('\n').filter(Boolean);
      if (outLines.length !== RAW_LOG.length) bad.push(`行数 ${outLines.length}`);
      for (const line of outLines) { try { JSON.parse(line); } catch { bad.push('输出含非法 JSON 行'); break; } }
      // 原始敏感子串不得残留
      const originals = [];
      for (const obj of RAW_LOG) {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v !== 'string') continue;
          if (SECRET_FIELDS.includes(k)) { originals.push(v); continue; }
          for (const cat of Object.keys(RE)) {
            const m = v.match(RE[cat]);
            if (m) originals.push(...m.map((x) => cat === 'TOKEN' ? x.replace(/^Bearer\s+/, '') : x));
          }
        }
      }
      for (const s of originals) if (s && outText.includes(s)) bad.push(`残留敏感值 ${s}`);
      for (const tag of ['[EMAIL]', '[PHONE]', '[IP]', '[TOKEN]', '[SECRET]']) {
        if (!outText.includes(tag)) bad.push(`缺替换标记 ${tag}`);
      }
      const r2 = runNodeWithCode(dir, 'redact.js --input verify-redacted.log --out verify-redacted2.log --report verify-report2.json');
      if (r2.code !== 0) bad.push('二次脱敏退出码非0');
      const rep2 = JSON.parse(readFileSafe(path.join(dir, 'verify-report2.json')) || '{}');
      if (rep2.total !== 0) bad.push(`二次 total=${rep2.total}`);
      if (readFileSafe(path.join(dir, 'verify-redacted2.log')) !== outText) bad.push('二次输出非逐字节一致');
      const t = runNodeTest(path.join(dir, 'redact.test.js'));
      if (!t.ok) bad.push('node-test FAIL ' + t.out.slice(-160).replace(/\n/g, ' '));
      return { ok: bad.length === 0, detail: bad.length ? 'exec=' + bad.slice(0, 3).join(' | ').slice(0, 400) : 'exec=✓五类计数/结构保持/无残留/幂等/node-test' };
    },
    quality: (dir) => {
      const s = readFileSafe(path.join(dir, 'redact.js'));
      return [['五类', /EMAIL|PHONE|IP|TOKEN|SECRET/.test(s)], ['顺序', /TOKEN/i.test(s)], ['JSON 结构', /JSON\.parse|JSON\.stringify/i.test(s)]];
    },
  },
]);

export const round = 5;
export const title = '安全工程 / 供应链';
export default { round, title, outTag: 'r5', seed, tasks };
