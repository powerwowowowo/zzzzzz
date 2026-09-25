#!/usr/bin/env node
'use strict';

/**
 * BlBl 统一配置下发脚本
 * ---------------------------------------------------------------
 * 把仓库 Secrets 里的一套账号/推送配置，翻译成两个引擎各自认识的
 * 环境变量，并写入 GitHub Actions 的 GITHUB_ENV 文件。
 *
 *   node scripts/prepare-env.js bili-tool   ->  Ray_BiliBiliCookies__N 等
 *   node scripts/prepare-env.js lottery     ->  COOKIE / MULTIPLE_ACCOUNT_PARM 等
 *
 * 输入（全部来自 Secrets，按需配置，未配置的项目整段跳过）：
 *   BILI_COOKIES      必填，多账号用 ||| 分隔（Cookie 本身不会出现连续三条竖线）
 *   BILI_COOKIE       可选，单账号简写；BILI_COOKIES 未设置时生效
 *   PUSH_PLUS_TOKEN   可选，PushPlus
 *   SERVERCHAN_KEY    可选，Server 酱 Turbo
 *   TG_BOT_TOKEN      可选，Telegram Bot Token
 *   TG_CHAT_ID        可选，Telegram Chat ID
 *   QYWX_KEY          可选，企业微信群机器人 key 或完整 webhook
 *   DINGTALK_TOKEN    可选，钉钉机器人 access_token 或完整 webhook
 *   DINGTALK_SECRET   可选，钉钉机器人加签密钥
 *   WEB_PROXY         可选，访问 B 站接口的代理，形如 http://host:port
 *                     （带鉴权为 http://user:pass@host:port）
 */

const fs = require('fs');

const ENGINE = process.argv[2];
if (!['bili-tool', 'lottery'].includes(ENGINE)) {
  console.error('[prepare-env] 用法: node scripts/prepare-env.js <bili-tool|lottery>');
  process.exit(1);
}

const GITHUB_ENV = process.env.GITHUB_ENV;
if (!GITHUB_ENV) {
  console.error('[prepare-env] 未检测到 GITHUB_ENV，本脚本仅用于 GitHub Actions');
  process.exit(1);
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

/** 待写入 GITHUB_ENV 的键值对 */
const lines = [];
/** 日志展示用的启用项摘要 */
const summary = [];

/** 写入一条环境变量，空值自动跳过 */
function setEnv(key, value) {
  if (value === undefined || value === null) return;
  const v = String(value).trim();
  if (!v) return;
  // GITHUB_ENV 逐行解析，值里不能出现换行
  lines.push(`${key}=${v.replace(/\r?\n/g, ' ')}`);
}

/** 掩码展示 Cookie，避免日志泄露凭据 */
function mask(cookie) {
  const uid = (cookie.match(/DedeUserID=(\d+)/) || [])[1] || 'unknown';
  return `UID:${uid}`;
}

/** 解析代理地址，失败返回 null */
function parseProxy(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      user: u.username ? decodeURIComponent(u.username) : '',
      pass: u.password ? decodeURIComponent(u.password) : '',
    };
  } catch {
    console.warn(`[prepare-env] WEB_PROXY 格式无法解析，已忽略：${raw}`);
    return null;
  }
}

// ---------------------------------------------------------------
// 1. 解析账号
// ---------------------------------------------------------------
const raw = process.env.BILI_COOKIES || process.env.BILI_COOKIE || '';
const cookies = raw
  .split('|||')
  .map((s) => s.replace(/\r?\n/g, '').trim())
  .filter(Boolean);

if (cookies.length === 0) {
  console.error(
    [
      '',
      '::error title=缺少账号配置::未配置 BILI_COOKIES，任务无法运行。',
      '',
      '  解决办法（任选其一）：',
      '    1. 在 Actions 页面运行「扫码登录（更新 Cookie）」工作流，手机扫码即可',
      '    2. 本地执行 node scripts/bili-login.js 扫码，会自动写入仓库 Secret',
      '    3. 手动到 Settings → Secrets and variables → Actions 新建 BILI_COOKIES',
      '',
      '  详细说明见仓库 README 的「获取登录凭据」一节。',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const proxy = parseProxy(process.env.WEB_PROXY);

// ---------------------------------------------------------------
// 2. 按引擎下发账号配置
// ---------------------------------------------------------------
if (ENGINE === 'bili-tool') {
  // BiliBiliToolPro 读取 BiliBiliCookies 配置节（List<string>）
  // Console 端环境变量前缀为 Ray_，序号从 1 开始
  cookies.forEach((ck, i) => setEnv(`Ray_BiliBiliCookies__${i + 1}`, ck));

  // 标记运行平台，影响 Cookie 登录态提示与写回行为
  setEnv('PlatformType', 'GitHubActions');
  setEnv('Ray_PlatformType', 'GitHubActions');

  // 代理配置节为 Security:WebProxy
  if (proxy) {
    setEnv('Security__WebProxy', process.env.WEB_PROXY);
    summary.push('代理: 已启用');
  }
} else {
  // LotteryAutoScript 支持两种形态：
  //   单账号且无代理 -> COOKIE
  //   多账号或需要代理 -> ENABLE_MULTIPLE_ACCOUNT + MULTIPLE_ACCOUNT_PARM(JSON)
  //   （单账号形态不支持代理，因为代理只在多账号分支里被读取）
  if (cookies.length === 1 && !proxy) {
    setEnv('COOKIE', cookies[0]);
    setEnv('NUMBER', '1');
    setEnv('NOTE', 'account1');
  } else {
    const parm = cookies.map((ck, i) => {
      const item = {
        COOKIE: ck,
        NOTE: `account${i + 1}`,
        NUMBER: i + 1,
        CLEAR: true,
        ACCOUNT_UA: DEFAULT_UA,
        // 多账号之间留出间隔，降低风控概率
        WAIT: cookies.length > 1 ? 60 * 1000 : 0,
      };
      if (proxy) {
        item.PROXY_HOST = proxy.host;
        item.PROXY_PORT = proxy.port;
        if (proxy.user) {
          item.PROXY_USER = proxy.user;
          item.PROXY_PASS = proxy.pass;
        }
      }
      return item;
    });
    setEnv('ENABLE_MULTIPLE_ACCOUNT', 'true');
    setEnv('MULTIPLE_ACCOUNT_PARM', JSON.stringify(parm));
    if (proxy) summary.push('代理: 已启用（注入多账号配置）');
  }

  setEnv('CLEAR', 'true');
}

// ---------------------------------------------------------------
// 3. 下发推送配置
// ---------------------------------------------------------------
const push = [];
if (process.env.PUSH_PLUS_TOKEN) push.push('PushPlus');
if (process.env.SERVERCHAN_KEY) push.push('Server酱');
if (process.env.TG_BOT_TOKEN) push.push('Telegram');
if (process.env.QYWX_KEY) push.push('企业微信');
if (process.env.DINGTALK_TOKEN) push.push('钉钉');

if (ENGINE === 'bili-tool') {
  // 对应 appsettings.json 里 Serilog:WriteTo 数组的下标
  if (process.env.PUSH_PLUS_TOKEN) {
    setEnv('Serilog__WriteTo__9__Args__token', process.env.PUSH_PLUS_TOKEN);
    setEnv('Serilog__WriteTo__9__Args__channel', 'wechat');
  }
  setEnv('Serilog__WriteTo__6__Args__turboScKey', process.env.SERVERCHAN_KEY);
  setEnv('Serilog__WriteTo__3__Args__botToken', process.env.TG_BOT_TOKEN);
  setEnv('Serilog__WriteTo__3__Args__chatId', process.env.TG_CHAT_ID);
  if (process.env.QYWX_KEY) {
    setEnv(
      'Serilog__WriteTo__4__Args__webHookUrl',
      process.env.QYWX_KEY.startsWith('http')
        ? process.env.QYWX_KEY
        : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${process.env.QYWX_KEY}`
    );
  }
  if (process.env.DINGTALK_TOKEN) {
    setEnv(
      'Serilog__WriteTo__5__Args__webHookUrl',
      process.env.DINGTALK_TOKEN.startsWith('http')
        ? process.env.DINGTALK_TOKEN
        : `https://oapi.dingtalk.com/robot/send?access_token=${process.env.DINGTALK_TOKEN}`
    );
  }
} else {
  setEnv('SENDKEY', process.env.SERVERCHAN_KEY);
  setEnv('PUSH_PLUS_TOKEN', process.env.PUSH_PLUS_TOKEN);
  setEnv('TG_BOT_TOKEN', process.env.TG_BOT_TOKEN);
  setEnv('TG_USER_ID', process.env.TG_CHAT_ID);
  setEnv('QYWX_KEY', process.env.QYWX_KEY);
  setEnv('DD_BOT_TOKEN', process.env.DINGTALK_TOKEN);
  setEnv('DD_BOT_SECRET', process.env.DINGTALK_SECRET);
}

// ---------------------------------------------------------------
// 4. 落盘
// ---------------------------------------------------------------
fs.appendFileSync(GITHUB_ENV, lines.join('\n') + '\n', 'utf8');

console.log(`[prepare-env] 引擎: ${ENGINE}`);
console.log(`[prepare-env] 账号: ${cookies.length} 个 -> ${cookies.map(mask).join(', ')}`);
console.log(`[prepare-env] 推送: ${push.length ? push.join(', ') : '未配置（保持静默）'}`);
summary.forEach((s) => console.log(`[prepare-env] ${s}`));
console.log(`[prepare-env] 已写入 ${lines.length} 项环境变量`);
