# 宣传片流水线（promo/）

给《奇点 SINGULARITY》做一支能直接投 B 站的宣传片。
**不录屏**——游戏是固定步长（1/60）的确定性模拟，所以整支片子是"按剧本驱动游戏本体、逐帧渲染"出来的。

```
node capture.js log   → 跑一遍剧本，记录全部音效事件（不渲染，0.1 秒）
python audio.py       → 按事件时间戳复刻游戏音效 + numpy 现场写配乐 → audio.wav
node capture.js video → 再跑一遍剧本，逐帧截图并管道进 ffmpeg → mp4（音画严格对齐）
node capture.js cover → 跑到指定帧，切成封面构图
```

## 文件

| 文件 | 作用 |
|---|---|
| `director.html` / `director.js` | 导演台：时间轴剧本、镜头推拉、字幕卡、音效日志 |
| `capture.js` | 零依赖 CDP 抓帧器（Node 自带 WebSocket 直连 Chrome，无需 puppeteer） |
| `audio.py` | 音轨合成：游戏音效复刻 + A 小调 120BPM 配乐 + riser/冲击（numpy） |
| `sfx.json` | 剧本跑一遍产出的音效事件表（时间戳 / 名称 / 参数） |
| `audio.wav` | 58 秒立体声 48kHz 音轨 |
| `out/` | 成片与封面 |
| `review/` | 抓帧时顺带抽出的审片静帧（每 1.5 秒一张） |
| `B站投稿文案.md` | 标题 / 简介 / 标签 / 分区 / 置顶评论 / 发布检查清单 |

## 重新生成（需 Chrome + ffmpeg）

```bash
cd promo
node capture.js log --out sfx.json
python audio.py --sfx sfx.json --out audio.wav --duration 58 --drive 2.6
node capture.js video --out out/singularity_promo_1080p60.mp4 --audio audio.wav --review review --reviewEvery 90
node capture.js cover --out out/cover.png --frame 2600
```

低分辨率快速审片（约 1/4 时间，16fps 播放速度不变）：

```bash
node capture.js video --out out/draft.mp4 --w 960 --h 540 --stride 4 --crf 30
```

## 几个关键设计

- **确定性重放**：导演台把 `Math.random` 换成固定种子的 xorshift，于是同一局可以精确重放。
  第一遍只取音效（不渲染，快），第二遍才抓帧——音轨和画面因此天然对齐，不需要事后对齐音频。
- **逐帧而非录屏**：`Page.captureScreenshot` 逐帧截图，PNG 直接管道进 ffmpeg（`-f image2pipe`），
  不落盘。3480 帧 1080p 的抓帧约 6 分钟，峰值磁盘占用只有成片本身。
- **不依赖 rAF**：无头环境下 rAF/PresentFrame 行为不稳定，导演台自己控制"推进一帧 → 绘制"，
  抓帧器通过 `Runtime.evaluate` 驱动，所以不会掉帧也不会重复帧。
- **镜头推拉**：不是对画面做后期缩放，而是改写渲染层的 `view.scale/ox/oy`（围绕焦点缩放），
  所以放大后依然是矢量级清晰。
- **音效复刻**：`audio.py` 里每一条音效都按 `render.js` 中 WebAudio 合成器的配方重写
  （波形、频率扫描、包络、噪声带通），听起来就是游戏本体的声音。
- **配乐**：A 小调 120BPM，Am–F–C–G 循环；按段落（开场/教学/档案/高压/高潮/尾声）
  增减贝斯、底鼓、hi-hat、琶音与 pad 的密度，高潮前 1.15 秒有 riser，爆点有低频冲击。

## 诚实说明

- 片中的走位、放井、坍缩时机都是**剧本编排**（走位由游戏内 AI 驱动，关键镜头由剧本触发），
  不是一次真人操作录像——但**分数、击杀、连锁、伤害全部是游戏真实结算出来的**，没有篡改数值。
- "每 25 秒一波，越往后越密"那一段是通过调试参数直接进入 `WAVE 9`，用来展示后期密度
  （正常游玩约 1~3 分钟能到第 4~7 波）。
- 音效事件被按 30ms 左右的间隔做了去重（`audio.py` 里的 `gap`），否则密集吸收会糊成一片噪音。

## 成片规格

| 项目 | 值 |
|---|---|
| 分辨率 / 帧率 | 1920×1080 / 60fps |
| 编码 | H.264 High@4.2, CRF 18, yuv420p, bt709 |
| 音频 | AAC 192kbps, 48kHz 立体声 |
| 时长 | 58 秒 |
| 其它 | `+faststart`，B 站可直接上传 |
