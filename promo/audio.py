#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
宣传片音轨合成器（零素材：没有一个音频文件，全部现场算出来）

两路声音：
  1) 游戏音效 —— 按 capture.js 记录的事件时间戳，用和 render.js 里同一套配方复刻
     （振荡器 + 噪声带通 + 指数包络），所以听起来就是游戏本体的声音，且音画严格对齐
  2) 背景音乐 —— A 小调，120BPM，按段落增减密度，高潮前有 riser，爆点有低频冲击

用法：python audio.py --sfx sfx.json --out audio.wav [--duration 58]
"""
import argparse
import json
import math
import wave

import numpy as np

SR = 48000


# ----------------------------------------------------------------- 基础波形
def env(n, atk=0.01, dec=6.0):
    t = np.arange(n) / SR
    e = np.exp(-dec * t)
    na = max(1, int(atk * SR))
    if na < n:
        e[:na] *= np.linspace(0.0, 1.0, na)
    return e


def tone(f0, f1, dur, kind='sine', atk=0.01, dec=6.0):
    n = max(2, int(dur * SR))
    t = np.arange(n) / SR
    if f1 and abs(f1 - f0) > 1e-6:
        f = f0 * (f1 / f0) ** (t / dur)
    else:
        f = np.full(n, float(f0))
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == 'sine':
        w = np.sin(ph)
    elif kind == 'tri':
        w = 2 / np.pi * np.arcsin(np.sin(ph))
    elif kind == 'saw':
        w = 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    else:  # square
        w = np.sign(np.sin(ph))
    return w * env(n, atk, dec)


def noise_band(dur, fc, q=1.0, sweep_to=None, atk=0.008, dec=6.0):
    n = max(2, int(dur * SR))
    x = np.random.randn(n)
    X = np.fft.rfft(x)
    fr = np.fft.rfftfreq(n, 1.0 / SR)
    fr[0] = 20.0

    def band(c):
        s = 0.62 / max(0.3, q)
        return np.exp(-((np.log(fr) - math.log(max(c, 25.0))) ** 2) / (2 * s * s))

    if sweep_to:
        w = np.linspace(0.0, 1.0, len(fr))
        b = band(fc) * (1 - w) + band(sweep_to) * w
    else:
        b = band(fc)
    y = np.fft.irfft(X * b, n)
    m = np.max(np.abs(y))
    if m > 1e-9:
        y = y / m
    return y * env(n, atk, dec)


def hz(semi):
    return 110.0 * (2.0 ** (semi / 12.0))


def add(buf, sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i < 0:
        sig = sig[-i:]
        i = 0
    if i >= len(buf):
        return
    n = min(len(sig), len(buf) - i)
    if n <= 0:
        return
    l = math.sqrt((1.0 - pan) / 2.0)
    r = math.sqrt((1.0 + pan) / 2.0)
    buf[i:i + n, 0] += sig[:n] * gain * l
    buf[i:i + n, 1] += sig[:n] * gain * r


# ----------------------------------------------------------------- 游戏音效复刻
def render_sfx(events, total):
    buf = np.zeros((int(total * SR), 2))
    rng = np.random.default_rng(7)
    last = {}
    # 同一种音效太密就丢掉一部分，避免糊成一片
    gap = {'absorb': 0.035, 'chain': 0.022, 'spawn': 0.06, 'place': 0.06}
    kept = 0
    for t, name, arg in events:
        g = gap.get(name)
        if g is not None:
            if t - last.get(name, -9) < g:
                continue
            last[name] = t
        kept += 1
        pan = 0.0
        if name in ('absorb', 'chain', 'spawn'):
            pan = float(rng.uniform(-0.32, 0.32))
        if name == 'place':
            add(buf, tone(620, 96, 0.24, 'tri', 0.004, 5.5), t, 0.20, 0.0)
            add(buf, noise_band(0.14, 500, 0.9, 180), t, 0.07, 0.0)
        elif name == 'absorb':
            add(buf, tone(430 + 55 * arg, 1080 + 70 * arg, 0.075, 'square', 0.004, 9.0), t, 0.05, pan)
        elif name == 'nova':
            add(buf, tone(190 + 12 * arg, 30, 0.55, 'sine', 0.004, 4.0), t, 0.34, 0.0)
            add(buf, noise_band(0.70, 900, 0.8, 140), t, 0.20, 0.0)
            add(buf, tone(1000, 110, 0.30, 'saw', 0.004, 7.0), t, 0.055, 0.0)
        elif name == 'chain':
            add(buf, tone(620 + 130 * arg, 1500 + 130 * arg, 0.06, 'tri', 0.003, 10.0),
                t + min(arg, 6) * 0.035, 0.055, pan)
        elif name == 'hit':
            add(buf, tone(220, 46, 0.35, 'saw', 0.004, 5.0), t, 0.26, 0.0)
            add(buf, noise_band(0.30, 500, 0.9, 150), t, 0.16, 0.0)
        elif name == 'dash':
            add(buf, noise_band(0.20, 1200, 0.7, 320), t, 0.12, 0.0)
        elif name == 'death':
            for i, s in enumerate((0, -3, -7, -12)):
                add(buf, tone(hz(s), hz(s - 5), 0.60, 'tri', 0.01, 4.0), t + i * 0.13, 0.18, 0.0)
            add(buf, noise_band(1.10, 700, 0.7, 120), t, 0.18, 0.0)
        elif name == 'wave':
            add(buf, tone(hz(0), hz(0), 0.50, 'tri', 0.01, 4.0), t, 0.13, 0.0)
            add(buf, tone(hz(7), hz(7), 0.50, 'sine', 0.01, 4.0), t + 0.04, 0.10, 0.0)
        elif name == 'spawn':
            add(buf, tone(170, 300, 0.09, 'sine', 0.004, 9.0), t, 0.035, pan)
        elif name == 'ui':
            add(buf, tone(720, 1180, 0.07, 'tri', 0.004, 9.0), t, 0.09, 0.0)
    return buf, kept


# ----------------------------------------------------------------- 背景音乐
PROG = [  # Am - F - C - G，每个和弦 2 秒
    (0, [0, 3, 7]),
    (-4, [-4, 0, 3]),
    (3, [3, 7, 10]),
    (-2, [-2, 2, 5]),
]
BEAT = 0.5


def density(t):
    if t < 7.2:
        return 0.30
    if t < 25.6:
        return 0.62
    if t < 42.2:
        return 0.88
    if t < 47.8:
        return 1.0
    return 0.40


def render_music(total):
    n = int(total * SR)
    buf = np.zeros((n, 2))
    rng = np.random.default_rng(11)
    bars = int(math.ceil(total / (BEAT * 4)))
    for bar in range(bars):
        t0 = bar * BEAT * 4
        if t0 >= total:
            break
        root, notes = PROG[bar % 4]
        d = density(t0)
        # 铺底 pad：每个小节一个长和弦，两把失谐锯齿
        if d >= 0.3:
            for k, s in enumerate(notes):
                for det in (-6.0, 6.0):
                    seg = tone(hz(root + s - 12) + det, hz(root + s - 12) + det, 1.9, 'saw', 0.5, 1.6)
                    add(buf, seg, t0 + 0.02 + k * 0.012, 0.028 * (0.5 + d * 0.5), (-1) ** k * 0.35)
        for b in range(4):
            tb = t0 + b * BEAT
            if tb >= total:
                break
            db = density(tb)
            # 底鼓：每拍 0/2 加重
            if db >= 0.5 and b % 2 == 0:
                add(buf, tone(120, 44, 0.20, 'sine', 0.002, 9.0), tb, 0.34, 0.0)
            # 贝斯
            if db >= 0.3:
                add(buf, tone(hz(root - 24), hz(root - 24), 0.42, 'saw', 0.006, 5.0), tb, 0.16, 0.0)
                add(buf, tone(hz(root - 12), hz(root - 12), 0.30, 'sine', 0.006, 7.0), tb, 0.10, 0.0)
            # hi-hat
            if db >= 0.55:
                add(buf, noise_band(0.045, 7200, 0.7, None, 0.002, 26.0), tb, 0.055, 0.18)
                add(buf, noise_band(0.030, 8800, 0.7, None, 0.002, 30.0), tb + BEAT * 0.5, 0.038, -0.18)
            # 琶音
            if db >= 0.6:
                for e in range(2):
                    te = tb + e * BEAT * 0.5
                    if te >= total:
                        continue
                    semi = notes[(bar + b + e) % len(notes)] + 12 + (12 if d >= 0.85 else 0)
                    add(buf, tone(hz(semi), hz(semi), 0.22, 'tri', 0.004, 9.0), te, 0.05, 0.30 if e else -0.30)
            # 16 分音符高速琶音（高压段）
            if db >= 0.95:
                for e in range(4):
                    te = tb + e * BEAT * 0.25
                    if te >= total:
                        continue
                    semi = notes[(bar + b + e) % len(notes)] + 24
                    add(buf, tone(hz(semi), hz(semi), 0.10, 'square', 0.003, 16.0), te, 0.022, 0.42 if e % 2 else -0.42)
    return buf


def render_extras(total):
    """高潮前的 riser + 爆点低频冲击 + 结尾收束音"""
    buf = np.zeros((int(total * SR), 2))
    # 42.2 -> 43.35 拉升
    t0, t1 = 42.20, 43.35
    dur = t1 - t0
    n = int(dur * SR)
    t = np.arange(n) / SR
    sweep = np.sin(2 * np.pi * np.cumsum(60 * (2 ** (t / dur * 3.2))) / SR)
    riser = sweep * (t / dur) ** 2 * 0.20
    noise = noise_band(dur, 400, 0.6, 6000, atk=0.3, dec=0.0)
    add(buf, riser, t0, 1.0, 0.0)
    add(buf, noise * np.linspace(0.05, 1.0, len(noise)), t0, 0.26, 0.0)
    # 43.35 大爆炸：低频冲击 + 反向镲
    add(buf, tone(90, 26, 1.30, 'sine', 0.002, 3.0), t1, 0.42, 0.0)
    add(buf, noise_band(0.90, 1200, 0.7, 120, atk=0.002, dec=4.0), t1, 0.24, 0.0)
    add(buf, noise_band(1.20, 3000, 0.6, 400, atk=0.5, dec=2.0), t1 - 1.2, 0.16, 0.0)
    # 结尾：47.8 阵亡一声闷响，56.5 收束
    add(buf, tone(150, 40, 1.60, 'sine', 0.004, 3.0), 47.9, 0.30, 0.0)
    add(buf, tone(hz(0 - 12), hz(0 - 24), 3.2, 'saw', 0.4, 0.9), 55.6, 0.16, 0.0)
    add(buf, tone(hz(7 - 12), hz(7 - 24), 3.2, 'tri', 0.4, 0.9), 55.6, 0.10, 0.0)
    return buf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sfx', required=True, help='capture.js log 生成的音效事件 json')
    ap.add_argument('--out', default='audio.wav')
    ap.add_argument('--duration', type=float, default=58.0)
    ap.add_argument('--music-gain', type=float, default=0.85)
    ap.add_argument('--sfx-gain', type=float, default=1.0)
    ap.add_argument('--drive', type=float, default=2.4, help='限制器驱动，越大越响')
    args = ap.parse_args()

    np.random.seed(3)
    events = json.load(open(args.sfx, encoding='utf-8'))
    total = args.duration
    print('音效事件 %d 条，音轨时长 %.1f 秒' % (len(events), total))

    sfx, kept = render_sfx(events, total)
    music = render_music(total)
    extra = render_extras(total)

    mix = sfx * args.sfx_gain + music * args.music_gain + extra
    # 简易限制器：软削波抬高整体响度，再归一化到 -0.4dB
    mix = np.tanh(mix * args.drive)
    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * 0.955

    pcm = (np.clip(mix, -1.0, 1.0) * 32767.0).astype('<i2')
    with wave.open(args.out, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())

    # 分段响度概览，方便判断段落强弱
    def db(x):
        r = float(np.sqrt(np.mean(x ** 2)))
        return -99.0 if r < 1e-9 else 20 * math.log10(r)

    print('已写出 %s（保留音效 %d 条）' % (args.out, kept))
    for a in range(0, int(total), 7):
        b = min(a + 7, int(total))
        seg = mix[a * SR:b * SR]
        print('  %5.1fs - %5.1fs   %6.1f dB' % (a, b, db(seg)))
    print('  峰值 %.3f  总 RMS %.1f dB' % (float(np.max(np.abs(mix))), db(mix)))


if __name__ == '__main__':
    main()
