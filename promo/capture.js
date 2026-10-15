#!/usr/bin/env node
/*!
 * 宣传片抓帧器：零依赖，用 Node 自带的 WebSocket 直连 Chrome DevTools Protocol。
 *
 *   node capture.js info                            看当前帧状态
 *   node capture.js log    --out sfx.json           只跑剧本、记录音效事件（不渲染，很快）
 *   node capture.js video  --out promo.mp4 --audio audio.wav [--stride 1] [--review dir]
 *   node capture.js cover  --out cover.png --frame 2658
 *
 * 帧不是"录"出来的，是逐帧渲染后抓的：PNG 直接管道进 ffmpeg，不占用磁盘。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.join(__dirname, 'director.html').replace(/\\/g, '/');

/* ------------------------------ 参数 ------------------------------ */
const argv = process.argv.slice(2);
const mode = argv[0] || 'info';
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes('--' + name);
const W = parseInt(opt('w', '1920'), 10);
const H = parseInt(opt('h', '1080'), 10);
const STRIDE = Math.max(1, parseInt(opt('stride', '1'), 10));
const PORT = parseInt(opt('port', '9333'), 10);
const OUT = opt('out', null);
const AUDIO = opt('audio', null);
const REVIEW = opt('review', null);
const REVIEW_EVERY = Math.max(1, parseInt(opt('reviewEvery', '90'), 10));
const FRAME = parseInt(opt('frame', '2658'), 10);
const CRF = opt('crf', '18');
const PRESET = opt('preset', 'medium');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/* ------------------------------ 小工具 ------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

class CDP {
  constructor(url) {
    this.url = url; this.id = 0; this.pending = new Map(); this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || e.type))));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      });
      this.ws.addEventListener('close', () => { this.closed = true; });
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内异常: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  async shot() {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true
    });
    return Buffer.from(r.data, 'base64');
  }
}

function launchChrome() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--force-color-profile=srgb', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--allow-file-access-from-files',
    '--window-size=' + W + ',' + H,
    '--user-data-dir=' + userData,
    '--remote-debugging-port=' + PORT,
    PAGE
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  return { child, userData };
}

async function waitForTarget(timeoutMs) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
      const page = list.find((t) => t.type === 'page' && /director\.html/.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error('等待 Chrome 调试端口超时' + (lastErr ? '：' + lastErr.message : ''));
}

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    const onErr = (e) => { stream.off('drain', onDrain); reject(e); };
    const onDrain = () => { stream.off('error', onErr); resolve(); };
    stream.once('drain', onDrain);
    stream.once('error', onErr);
  });
}

function fmtTime(s) {
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 CHROME_PATH 环境变量指定）');
  console.log('启动 Chrome（' + W + 'x' + H + '，调试端口 ' + PORT + '）…');
  const { child, userData } = launchChrome();
  let cdp = null;
  let killed = false;
  const cleanup = () => {
    if (killed) return;
    killed = true;
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) { }
    try { child.kill(); } catch (e) { }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) { }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('exit', cleanup);

  const target = await waitForTarget(40000);
  cdp = await new CDP(target.webSocketDebuggerUrl).connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 无头窗口的"客户区"会被边框/标题栏吃掉，用设备尺寸覆盖精确锁定输出分辨率
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false
  });
  await sleep(400);

  // 等页面脚本就绪
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = await cdp.eval('!!(window.__PROMO && window.SINGULARITY && __PROMO.total)'); } catch (e) { }
    if (!ready) await sleep(150);
  }
  if (!ready) throw new Error('导演页没有就绪（检查 director.js 是否有语法错误）');

  const vp = await cdp.eval('window.innerWidth + "x" + window.innerHeight');
  const cv = await cdp.eval('(function(){var c=document.getElementById("c");return c.width+"x"+c.height;})()');
  const total = await cdp.eval('__PROMO.total');
  const fps = await cdp.eval('__PROMO.fps');
  console.log('视口 ' + vp + ' ｜ 画布 ' + cv + ' ｜ 共 ' + total + ' 帧 @ ' + fps + 'fps（' + (total / fps).toFixed(1) + ' 秒）');

  if (mode === 'info') {
    const info = await cdp.eval('JSON.stringify(__PROMO.info())');
    console.log(info);
    return;
  }

  if (mode === 'log') {
    const out = OUT || path.join(__dirname, 'sfx.json');
    const BATCH = 400;
    const t0 = Date.now();
    for (let i = 0; i < total; i += BATCH) {
      const n = Math.min(BATCH, total - i);
      await cdp.eval('for(var i=0;i<' + n + ';i++)__PROMO.stepOnly();');
      if ((i / BATCH) % 3 === 0) process.stdout.write('\r  推进 ' + Math.min(i + n, total) + '/' + total);
    }
    const json = await cdp.eval('JSON.stringify(__PROMO.sfx())');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    const arr = JSON.parse(json);
    const byName = {};
    arr.forEach((e) => { byName[e[1]] = (byName[e[1]] || 0) + 1; });
    console.log('\r  音效事件 ' + arr.length + ' 条 → ' + out + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    console.log('  ' + Object.keys(byName).sort().map((k) => k + '×' + byName[k]).join('  '));
    console.log('  终局：' + (await cdp.eval('JSON.stringify(__PROMO.info())')));
    return;
  }

  if (mode === 'cover') {
    const out = OUT || path.join(__dirname, 'cover.png');
    await cdp.eval('__PROMO.cover(' + FRAME + ')');
    const buf = await cdp.shot();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    console.log('封面已生成 ' + out + '（第 ' + FRAME + ' 帧，' + (buf.length / 1024).toFixed(0) + ' KB）');
    return;
  }

  if (mode === 'video') {
    const out = OUT || path.join(__dirname, 'promo.mp4');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (REVIEW) fs.mkdirSync(REVIEW, { recursive: true });

    const frameRate = fps / STRIDE;
    const ffArgs = ['-y', '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(frameRate), '-i', 'pipe:0'];
    if (AUDIO && fs.existsSync(AUDIO)) ffArgs.push('-i', AUDIO);
    ffArgs.push(
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-level', '4.2', '-r', String(frameRate),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'
    );
    if (AUDIO && fs.existsSync(AUDIO)) ffArgs.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    else ffArgs.push('-an');
    ffArgs.push('-movflags', '+faststart', '-shortest', out);

    console.log('开始抓帧 → ffmpeg 管道（' + (STRIDE === 1 ? '每帧' : '每 ' + STRIDE + ' 帧取 1') + '，输出 ' + frameRate + 'fps）');
    const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = new Promise((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code))));
    });

    const t0 = Date.now();
    let written = 0;
    for (let f = 0; f < total; f += STRIDE) {
      const last = Math.min(f + STRIDE - 1, total - 1);
      const pre = last - f;
      await cdp.eval('for(var i=0;i<' + pre + ';i++)__PROMO.stepOnly();__PROMO.step();');
      const buf = await cdp.shot();
      await writeChunk(ff.stdin, buf);
      written++;
      if (REVIEW && written % REVIEW_EVERY === 0) {
        fs.writeFileSync(path.join(REVIEW, 'r' + String(written).padStart(5, '0') + '.png'), buf);
      }
      if (written % 60 === 0 || f + STRIDE >= total) {
        const el = (Date.now() - t0) / 1000;
        const done = Math.min(f + STRIDE, total);
        const eta = el / Math.max(1, done) * (total - done);
        process.stdout.write('\r  ' + String(Math.round(done / total * 100)).padStart(3) + '%  ' +
          done + '/' + total + ' 帧  已用 ' + fmtTime(el) + '  预计剩余 ' + fmtTime(eta) + '   ');
      }
    }
    ff.stdin.end();
    await ffDone;
    process.stdout.write('\n');
    const st = fs.statSync(out);
    const dur = written / frameRate;
    console.log('完成 ' + out + ' ｜ ' + (st.size / 1048576).toFixed(1) + ' MB ｜ ' +
      written + ' 帧 ｜ ' + dur.toFixed(1) + ' 秒 ｜ 总耗时 ' + fmtTime((Date.now() - t0) / 1000));
    return;
  }

  throw new Error('未知模式：' + mode + '（可用 info / log / video / cover）');
}

main().then(() => { process.exit(0); }).catch((e) => {
  console.error('\n失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
