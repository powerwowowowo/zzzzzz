#!/usr/bin/env node
'use strict';

/**
 * B站 Cookie 有效性校验（只读）
 * ---------------------------------------------------------------
 * 调用 https://api.bilibili.com/x/web-interface/nav 检查登录态，
 * 不执行任何写操作，不会投币、不会关注、不会转发。
 *
 * 用途：在正式任务跑之前确认账号配置是否可用；
 *       未配置 BILI_COOKIES 时直接跳过，不会让流程失败。
 */

const https = require('https');

const raw = process.env.BILI_COOKIES || process.env.BILI_COOKIE || '';
const cookies = raw
  .split('|||')
  .map((s) => s.replace(/\r?\n/g, '').trim())
  .filter(Boolean);

if (cookies.length === 0) {
  console.log('::warning title=未配置账号::BILI_COOKIES 未配置，跳过 Cookie 校验');
  process.exit(0);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

function checkOne(ck, index) {
  return new Promise((resolve) => {
    const uid = (ck.match(/DedeUserID=(\d+)/) || [])[1] || '未知';
    const req = https.get(
      {
        hostname: 'api.bilibili.com',
        path: '/x/web-interface/nav',
        headers: { Cookie: ck, 'User-Agent': UA },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.code === 0 && j.data && j.data.isLogin) {
              console.log(`账号${index} UID:${j.data.mid} 昵称:${j.data.uname} —— 有效`);
              resolve(true);
            } else {
              console.log(
                `账号${index} UID:${uid} —— 失效（code=${j.code} ${j.message || ''}）`
              );
              resolve(false);
            }
          } catch {
            console.log(`账号${index} —— 响应解析失败`);
            resolve(false);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      console.log(`账号${index} —— 请求失败：${e.message}`);
      resolve(false);
    });
  });
}

(async () => {
  const results = [];
  // 逐个检查，避免并发请求被风控
  for (let i = 0; i < cookies.length; i++) {
    results.push(await checkOne(cookies[i], i + 1));
  }
  const bad = results.filter((r) => !r).length;
  console.log(`校验完成：共 ${cookies.length} 个账号，有效 ${cookies.length - bad} 个，失效 ${bad} 个`);
  if (bad > 0) {
    console.log(`::warning title=Cookie失效::有 ${bad} 个账号 Cookie 已失效，请更新 BILI_COOKIES`);
  }
})();
