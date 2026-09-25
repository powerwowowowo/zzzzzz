#!/usr/bin/env node
'use strict';

/**
 * B站扫码登录 → 自动同步到 GitHub Secrets
 * ===============================================================
 * 为什么是扫码而不是账号密码：
 *   B 站密码登录强制人机验证（极验 GeeTest），必须在浏览器里手动拖滑块，
 *   无人值守环境无法完成。扫码登录不需要人机验证，是唯一可行的自动化路径。
 *
 * 用法：
 *   node scripts/bili-login.js                     # 扫码并更新 BILI_COOKIES
 *   node scripts/bili-login.js --dry-run           # 只登录，把 Cookie 打印出来
 *   node scripts/bili-login.js --secret MY_SECRET  # 写入指定的 Secret 名
 *   node scripts/bili-login.js --repo owner/name   # 指定仓库（默认从 git remote 推断）
 *   node scripts/bili-login.js --token ghp_xxx     # 显式指定 GitHub 凭据
 *   node scripts/bili-login.js --extra "其他账号Cookie"  # 追加为第二账号
 *   node scripts/bili-login.js --no-open           # 不自动弹出二维码图片
 *   node scripts/bili-login.js --timeout 300       # 等待扫码的秒数，默认 180
 *
 * 凭据来源优先级：--token > 环境变量 GITHUB_TOKEN/GH_TOKEN > git 凭据管理器
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tls = require('tls');
const { execSync, exec } = require('child_process');
const QRCode = require('qrcode');
const sodium = require('tweetsodium');
const { HttpsProxyAgent } = require('https-proxy-agent');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 解析代理地址。
 * 注意：Node 不会像 curl 那样自动读取 HTTPS_PROXY，访问 GitHub 必须显式挂代理。
 */
function resolveProxy(cliProxy) {
  return (
    cliProxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  );
}

/**
 * 让 Node 同时信任操作系统证书库。
 *
 * 背景：Watt Toolkit / Steamcommunity302 这类加速工具会对 GitHub 做 TLS 中间人，
 * 它们的根证书只安装在系统证书库里，Node 自带的 CA 清单不认识，于是报
 * "unable to get local issuer certificate"。这里把系统 CA 合并进信任链，
 * 免去手工配置 NODE_EXTRA_CA_CERTS 的麻烦。
 */
let caAgent = null;
let systemCaCount = -1;

function getCaList() {
  try {
    if (typeof tls.getCACertificates === 'function') {
      const sys = tls.getCACertificates('system') || [];
      if (sys.length) {
        systemCaCount = sys.length;
        return [...(tls.rootCertificates || []), ...sys];
      }
    }
  } catch {
    /* 老版本 Node 没有该 API，保持默认行为 */
  }
  systemCaCount = 0;
  return null;
}

function buildAgent(proxy) {
  const ca = getCaList();
  if (proxy) {
    return new HttpsProxyAgent(proxy, ca ? { ca } : {});
  }
  if (!caAgent) caAgent = new https.Agent(ca ? { ca } : {});
  return caAgent;
}

// ============================================================
// 参数解析
// ============================================================
function parseArgs(argv) {
  // GitHub Actions 里没有图形界面，默认不尝试打开图片
  const inCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const args = {
    repo: '',
    secret: 'BILI_COOKIES',
    token: '',
    extra: '',
    proxy: '',
    qrOut: '',
    dryRun: false,
    noOpen: inCI,
    logQr: false,
    timeout: 180,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--repo') args.repo = next();
    else if (a === '--secret') args.secret = next();
    else if (a === '--token') args.token = next();
    else if (a === '--extra') args.extra = next();
    else if (a === '--proxy') args.proxy = next();
    else if (a === '--qr-out') args.qrOut = next();
    else if (a === '--timeout') args.timeout = parseInt(next(), 10) || 180;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-open') args.noOpen = true;
    else if (a === '--log-qr') args.logQr = true;
    else if (a === '--open') args.noOpen = false;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          '',
          '用法：node scripts/bili-login.js [选项]',
          '',
          '  --dry-run            只登录，把 Cookie 打印出来，不写 Secret',
          '  --secret <名称>       要写入的 Secret 名，默认 BILI_COOKIES',
          '  --repo <owner/name>  仓库，默认从 git remote 推断',
          '  --token <PAT>        GitHub 凭据，默认读取环境变量或 git 凭据管理器',
          '  --proxy <地址>        访问 GitHub 的代理，默认读 HTTPS_PROXY 环境变量',
          '  --extra <Cookie>     追加为第二个账号（多账号用 ||| 连接）',
          '  --no-open            不自动弹出二维码图片',
          '  --log-qr             在 CI 日志里也输出字符二维码（默认关闭，日志会渲染成色块）',
          '  --qr-out <路径>      把二维码另存为 PNG（GitHub Actions 里作备份用）',
          '  --timeout <秒>        等待扫码的超时，默认 180',
          '',
        ].join('\n')
      );
      process.exit(0);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = (m) => console.log(m);
const warn = (m) => console.warn(m);
const die = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

// ============================================================
// HTTP 请求（仅用 Node 内置 https，无第三方依赖）
// ============================================================
function request(url, { method = 'GET', headers = {}, cookie = '', body = '', proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const finalHeaders = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };
    if (cookie) finalHeaders.Cookie = cookie;
    if (body) {
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    let agent;
    try {
      agent = buildAgent(proxy);
    } catch (e) {
      return reject(new Error(`代理地址无法解析：${proxy}（${e.message}）`));
    }

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: finalHeaders,
        timeout: 20000,
        agent,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================
// Cookie 处理
// ============================================================
/** 把 Set-Cookie 响应头数组压成 `k=v; k=v` 形式 */
function setCookieToPairs(setCookieHeaders) {
  const pairs = [];
  for (const line of setCookieHeaders || []) {
    const first = String(line).split(';')[0].trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  return pairs;
}

/** 合并多组 Cookie，同名后者覆盖前者 */
function mergeCookiePairs(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list) {
      const idx = item.indexOf('=');
      if (idx > 0) map.set(item.slice(0, idx).trim(), item);
    }
  }
  return Array.from(map.values());
}

/** 掩码展示，避免日志泄露凭据 */
function maskCookie(cookieStr) {
  const uid = (cookieStr.match(/DedeUserID=(\d+)/) || [])[1] || '未知';
  return `UID:${uid}，含 ${cookieStr.split(';').length} 个字段`;
}

// ============================================================
// 二维码展示
// ============================================================
function openFile(p) {
  try {
    if (process.platform === 'win32') exec(`start "" "${p}"`, { shell: 'cmd.exe' });
    else if (process.platform === 'darwin') exec(`open "${p}"`);
    else exec(`xdg-open "${p}"`);
  } catch {
    /* 打不开就算了，终端二维码仍然可用 */
  }
}

/**
 * 渲染一份「纯字符」二维码（不含 ANSI 转义），专供 GitHub Actions 的
 * Job Summary 使用 —— 那里没有日志的时间戳前缀，代码块又是等宽字体。
 *
 * 用半块符号（▀▄█）把上下两个模块并成一个字符，这样在等宽字体下
 * 每个模块仍是正方形，整张码只有 40 多字符宽，不会被窄窗口裁掉。
 */
function renderPlainQr(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'L' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quiet = 4; // 规范要求 4 模块静默区，少了会明显影响识别

  const at = (x, y) => (x >= 0 && x < size && y >= 0 && y < size ? data[y * size + x] : 0);

  const lines = [];
  const blank = ' '.repeat(size + quiet * 2);
  for (let i = 0; i < quiet; i++) lines.push(blank);

  for (let y = 0; y < size; y += 2) {
    let line = ' '.repeat(quiet);
    for (let x = 0; x < size; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    line += ' '.repeat(quiet);
    lines.push(line);
  }

  for (let i = 0; i < quiet; i++) lines.push(blank);
  return lines.join('\n');
}

/** 往 Actions Summary 追加一段 Markdown（不在 Actions 环境下静默跳过） */
function appendSummary(md) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, md + '\n', 'utf8');
  } catch {
    /* Summary 写不进去不影响主流程 */
  }
}

/** 把二维码写进 Actions 的 Summary 区域（顶部那块，最显眼也最清晰） */
function writeToSummary(url, { overwrite = false } = {}) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return false;
  try {
    let plain = '';
    try {
      plain = renderPlainQr(url);
    } catch (e) {
      warn(`纯字符二维码渲染失败：${e.message}`);
    }

    // 图片版交给公开的二维码渲染服务，GitHub 会通过 camo 代理加载，
    // 尺寸远大于字符版，手机上更好扫。
    const qrImg = (px) =>
      `https://api.qrserver.com/v1/create-qr-code/?size=${px}x${px}&margin=12&data=` +
      encodeURIComponent(url);

    const parts = [
      '## 请用「哔哩哔哩」App 扫描下方二维码',
      '',
      '扫码后请在手机上点击确认，本工作流会自动把登录态写入 `BILI_COOKIES`。',
      '',
      `![B站登录二维码](${qrImg(420)})`,
      '',
    ];

    if (plain) {
      parts.push(
        `如果上面的图片没加载出来，[点这里在新标签页打开大图](${qrImg(600)})，或者扫下面这份字符版（手机凑近屏幕、或把浏览器缩放调大些）：`,
        '',
        '```',
        plain,
        '```',
        ''
      );
    }

    parts.push(
      '> 二维码有效期约 3 分钟，过期后会自动换新的一张，以本区域最新的为准。',
      '> 若都扫不出来，可直接在手机上打开这个原始链接自行生成二维码：',
      '>',
      `> ${url}`,
      ''
    );

    const md = parts.join('\n') + '\n';
    // 首次追加，换码时覆盖 —— 保证 Summary 里始终只有一张最新二维码
    if (overwrite) fs.writeFileSync(summaryPath, md, 'utf8');
    else fs.appendFileSync(summaryPath, md, 'utf8');
    return true;
  } catch (e) {
    warn(`写入 Summary 失败：${e.message}`);
    return false;
  }
}

async function showQrCode(
  url,
  { noOpen, outPath, quiet = false, overwrite = false, logQr = false }
) {
  const inCI = Boolean(process.env.GITHUB_STEP_SUMMARY);

  // GitHub Actions 场景不依赖 Summary 做实时扫码：
  // 官方文档写明 summary 要等 job 结束后才聚合渲染，而本步骤一直在等扫码。
  // Summary 仍然写一份，留作运行结束后回看。
  if (writeToSummary(url, { overwrite })) {
    if (!quiet && inCI) info('（Summary 面板要等运行结束才会显示，实时扫码请用下方图片链接）');
  }

  if (!quiet) {
    if (logQr || !inCI) {
      // 本地终端：直接渲染字符二维码（终端对 ANSI 支持正常）
      const terminal = await QRCode.toString(url, { type: 'terminal', small: true });
      console.log('');
      console.log('=============== 用「哔哩哔哩」App 扫描下方二维码 ===============');
      console.log('');
      console.log(terminal);
      console.log('==============================================================');
      console.log('');
    } else {
      // GitHub Actions 环境。
      //
      // 为什么不用 Job Summary：官方文档写明 summary 要等 job 结束后才会
      // 聚合渲染，而本步骤要一直等扫码，用户根本看不到。
      // 也用不了终端二维码：日志视图不做 ANSI 反色渲染，会糊成一整块色块。
      //
      // 所以这里给一个「图片直链」—— 日志是实时流式的，链接一出现就能点，
      // 点开是一张干净的二维码图片，手机扫屏幕即可。
      const imgLink =
        'https://api.qrserver.com/v1/create-qr-code/?size=520x520&margin=14&data=' +
        encodeURIComponent(url);
      const bar = '='.repeat(72);
      console.log('');
      console.log(bar);
      console.log('  请点开下面的链接查看二维码（新标签页会显示一张干净的图片）');
      console.log('');
      console.log(`  ${imgLink}`);
      console.log('');
      console.log('  手机用「哔哩哔哩」App 扫屏幕上那张图，然后点确认。');
      console.log('  二维码约 3 分钟过期，过期后本日志会立即出现新的链接。');
      console.log(bar);
      console.log('');
      console.log(`::notice title=点开链接看二维码::${imgLink}`);
    }
  }

  // 另存一张 PNG：本地便于直接查看，CI 里供 artifact 与 qr 分支使用
  const pngPath = outPath
    ? path.resolve(outPath)
    : path.join(os.tmpdir(), 'bili-login-qrcode.png');
  try {
    await QRCode.toFile(pngPath, url, { width: 480, margin: 2 });
    if (!quiet) {
      info(`二维码图片：${pngPath}`);
      if (!noOpen) {
        openFile(pngPath);
        info('已尝试用系统默认程序打开该图片');
      }
    }
  } catch (e) {
    warn(`生成二维码图片失败（不影响扫码）：${e.message}`);
  }
}

// ============================================================
// GitHub Secrets
// ============================================================
function inferRepo() {
  // 直接读 .git/config，不依赖 git 子进程（更健壮，也避免某些环境的进程创建限制）
  const candidates = [
    path.join(process.cwd(), '.git', 'config'),
    path.join(__dirname, '..', '.git', 'config'),
  ];
  for (const cfgPath of candidates) {
    try {
      const text = fs.readFileSync(cfgPath, 'utf8');
      const m = text.match(/^\s*url\s*=\s*(.+)$/m);
      if (!m) continue;
      const url = m[1].trim().replace(/\.git$/, '');
      const mm = url.match(/github\.com[/:]([^/]+)\/([^/]+)$/);
      if (mm) return `${mm[1]}/${mm[2]}`;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return '';
}

function resolveToken(cliToken) {
  if (cliToken) return cliToken;
  // GitHub Actions 场景：gh 自动注入的 GITHUB_TOKEN 没有 Secrets 写权限，
  // 必须用单独配置的 GH_PAT，所以它的优先级排在前面
  if (process.env.GH_PAT) return process.env.GH_PAT;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      // 凭据管理器有时会卡住（等待 GUI 弹窗、或进程锁冲突），
      // 超时就当作没有凭据，走"打印 Cookie 手动配置"的降级路径
      timeout: 8000,
    });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* 忽略 */
  }
  return '';
}

async function updateGitHubSecret({ repo, name, value, token, proxy = '' }) {
  const api = `https://api.github.com/repos/${repo}/actions/secrets`;
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  const keyRes = await request(`${api}/public-key`, { headers: auth, proxy }).catch((e) => {
    if (/certificate|issuer/i.test(e.message)) {
      throw new Error(
        `访问 GitHub 失败（${e.message}）。\n` +
          `  国内环境通常需要代理：设置环境变量 HTTPS_PROXY，或用 --proxy http://127.0.0.1:端口 指定。`
      );
    }
    throw e;
  });
  if (keyRes.status !== 200) {
    throw new Error(
      `获取仓库公钥失败（HTTP ${keyRes.status}）。请确认凭据有 repo 权限、且仓库名正确：${repo}`
    );
  }
  const { key, key_id: keyId } = JSON.parse(keyRes.body);

  // GitHub 要求用 libsodium sealed box 加密后上传，明文永远不会离开本机。
  // 注意 tweetsodium.seal 的参数顺序是 (消息, 公钥)，写反会报 bad public key size。
  const publicKey = Buffer.from(key, 'base64');
  if (publicKey.length !== 32) {
    throw new Error(`GitHub 返回的公钥长度异常（${publicKey.length} 字节，预期 32）`);
  }
  const encrypted = Buffer.from(
    sodium.seal(Buffer.from(value, 'utf8'), publicKey)
  ).toString('base64');

  const putRes = await request(`${api}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ encrypted_value: encrypted, key_id: keyId }),
    proxy,
  });

  if (putRes.status !== 201 && putRes.status !== 204) {
    throw new Error(`写入 Secret 失败（HTTP ${putRes.status}）：${putRes.body}`);
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const args = parseArgs(process.argv.slice(2));

  info('');
  info('=== B站扫码登录 ===');
  if (process.env.GITHUB_STEP_SUMMARY) {
    info('提示：稍等片刻，下方会输出一个二维码图片链接 —— 点开就是二维码，手机扫屏幕即可。');
  } else {
    info('提示：用「哔哩哔哩」App 的扫一扫，扫描下方二维码并在手机上确认。');
  }
  info('');

  // ---- 1. 申请二维码 ----
  const gen = await request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  let genData;
  try {
    genData = JSON.parse(gen.body).data;
  } catch {
    die(`二维码接口返回异常：${gen.body.slice(0, 200)}`);
  }
  if (!genData || !genData.qrcode_key) die('未能获取 qrcode_key，B站接口可能已变更');
  let qrcodeKey = genData.qrcode_key;
  let qrUrl = genData.url;

  await showQrCode(qrUrl, {
    noOpen: args.noOpen,
    outPath: args.qrOut,
    logQr: args.logQr,
  });

  // ---- 2. 轮询扫码结果 ----
  info('');
  info(`等待扫码中（最长 ${args.timeout} 秒）...`);

  const deadline = Date.now() + args.timeout * 1000;
  const startedAt = Date.now();
  let lastBeat = startedAt;
  let qrRefreshCount = 0;
  let cookiePairs = [];
  let refreshToken = '';
  let lastState = '';

  while (Date.now() < deadline) {
    await sleep(2000);
    const poll = await request(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`
    );

    let pd;
    try {
      pd = JSON.parse(poll.body);
    } catch {
      continue;
    }
    const stateCode = pd && pd.data ? pd.data.code : undefined;

    if (stateCode === 86101) {
      if (lastState !== 'wait') {
        info('  · 尚未扫描');
        lastState = 'wait';
      }
      continue;
    }
    if (stateCode === 86090) {
      if (lastState !== 'scanned') {
        info('  · 已扫描，请在手机上点击确认');
        lastState = 'scanned';
      }
      continue;
    }
    if (stateCode === 86038) {
      // B站侧二维码约 3 分钟过期，这里自动换一张新的继续等，用户不用抢时间
      qrRefreshCount++;
      if (qrRefreshCount > 5) die('二维码连续失效多次，请稍后重试');
      info(`  · 二维码已过期，已自动换新（第 ${qrRefreshCount + 1} 张，请以 Summary 里最新的为准）`);

      const again = await request(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
      );
      let againData = null;
      try {
        againData = JSON.parse(again.body).data;
      } catch {
        /* 交给下面统一报错 */
      }
      if (!againData || !againData.qrcode_key) die('刷新二维码失败，请重新运行');
      qrcodeKey = againData.qrcode_key;
      qrUrl = againData.url;

      // 覆盖 Summary 与 PNG，并重新给出图片直链（旧链接对应的二维码已失效）
      await showQrCode(qrUrl, {
        noOpen: true,
        outPath: args.qrOut,
        overwrite: true,
      });
      lastState = '';
      continue;
    }
    if (stateCode === 0) {
      cookiePairs = setCookieToPairs(poll.headers['set-cookie']);
      refreshToken = (pd.data && pd.data.refresh_token) || '';
      info('  · 手机已确认登录');
      break;
    }

    // 心跳输出：GitHub Actions 里长时间没有日志会让人以为卡住了
    if (Date.now() - lastBeat >= 15000) {
      info(`  · 等待扫码...（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
      lastBeat = Date.now();
    }
  }

  if (cookiePairs.length === 0) {
    appendSummary(
      [
        '---',
        '',
        '### ❌ 等待超时，未完成扫码登录',
        '',
        '- 二维码有效期约 3 分钟，超时后需要重新运行本工作流',
        '- 也可以下载本次运行的 `login-qrcode` artifact，打开图片后扫码（同样有时效）',
        '- 或者在自己电脑上执行 `node scripts/bili-login.js` 扫码，效果一样',
        '',
      ].join('\n')
    );
    die('等待超时，未完成扫码登录。请重新运行本工作流并尽快扫码。');
  }

  // ---- 3. 访问主站补齐设备 Cookie（buvid3 等）----
  let merged = mergeCookiePairs(cookiePairs);
  try {
    const home = await request('https://www.bilibili.com', {
      cookie: merged.join('; '),
      headers: { Accept: 'text/html' },
    });
    merged = mergeCookiePairs(merged, setCookieToPairs(home.headers['set-cookie']));
  } catch (e) {
    warn(`补齐主站 Cookie 失败（通常不影响使用）：${e.message}`);
  }

  const cookieStr = merged.join('; ');

  // ---- 4. 校验登录态 ----
  const nav = await request('https://api.bilibili.com/x/web-interface/nav', {
    cookie: cookieStr,
  });
  let nickname = '';
  let mid = '';
  try {
    const navJson = JSON.parse(nav.body);
    if (navJson.code === 0 && navJson.data && navJson.data.isLogin) {
      nickname = navJson.data.uname;
      mid = navJson.data.mid;
    }
  } catch {
    /* 忽略 */
  }
  if (!nickname) die('登录态校验失败，Cookie 可能不完整，请重试');

  info('');
  info(`✓ 登录成功：${nickname}（UID ${mid}）`);
  info(`  Cookie 摘要：${maskCookie(cookieStr)}`);
  if (refreshToken) info('  已取得 refresh_token（可用于后续 Cookie 续期）');

  // ---- 5. 写入 GitHub Secret ----
  const finalValue = args.extra ? `${cookieStr}|||${args.extra.trim()}` : cookieStr;

  if (args.dryRun) {
    info('');
    info('已按 --dry-run 运行，未写入 Secret。Cookie 内容如下（请妥善保管）：');
    info('');
    console.log(finalValue);
    info('');
    return;
  }

  const repo = args.repo || inferRepo();
  if (!repo) die('未能推断仓库名，请用 --repo owner/name 指定');

  const token = resolveToken(args.token);
  if (!token) {
    console.log('');
    console.log('###############################################################');
    console.log('# 未找到可用的 GitHub 凭据，无法自动写入 Secret。');
    console.log('# 请复制下面这一整行，粘贴到：');
    console.log(`#   仓库 Settings → Secrets and variables → Actions → 更新 ${args.secret}`);
    console.log('#');
    console.log('# 想在云端自动完成，请在仓库里加一个 GH_PAT Secret（详见 README）。');
    console.log('###############################################################');
    console.log('');
    console.log(finalValue);
    console.log('');
    console.log(
      `::warning title=需要手动配置::未能自动写入 Secret，请把上方 Cookie 复制到仓库的 ${args.secret}`
    );
    process.exit(0);
  }

  info('');
  info(`正在写入 ${repo} 的 Secret：${args.secret} ...`);
  const proxy = resolveProxy(args.proxy);
  if (proxy) info(`（通过代理访问 GitHub：${proxy}）`);
  await updateGitHubSecret({
    repo,
    name: args.secret,
    value: finalValue,
    token,
    proxy,
  });

  info('');
  info('✓ 已更新仓库 Secret。定时任务下次运行就会使用新的登录态。');
  info('  小提示：Secret 只能写入不能读回，如需确认可到 Actions 页面跑一次「环境自检」。');
  info('');

  appendSummary(
    [
      '---',
      '',
      `### ✅ 登录成功：${nickname}（UID ${mid}）`,
      '',
      `已更新仓库 Secret \`${args.secret}\`，之后的任务会自动使用这份新的登录态。`,
      '',
      '想确认是否生效，可以再跑一次「环境自检」。',
      '',
    ].join('\n')
  );
}

// 作为脚本直接运行时才执行主流程，被 require 时可单独复用其中的函数
if (require.main === module) {
  main().catch((e) => die(e.message || String(e)));
}

module.exports = {
  updateGitHubSecret,
  inferRepo,
  resolveToken,
  setCookieToPairs,
  mergeCookiePairs,
  maskCookie,
};
