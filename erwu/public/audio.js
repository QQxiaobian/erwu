/* 声音模块：背景音乐与音效全部用 Web Audio 实时合成，不依赖任何外部音频文件 */
(function () {
  const STORE = 'erwu.audio';
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE)) || {};
  } catch {
    saved = {};
  }
  // 背景音乐默认关闭（浏览器自动播放策略），音效与语音播报默认开启
  const conf = { music: saved.music === true, sfx: saved.sfx !== false, voice: saved.voice !== false };

  let ctx = null;
  let sfxBus = null;
  let musicBus = null;
  let musicTimer = null;

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(conf));
    } catch {}
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.5;
    sfxBus.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.0001;
    musicBus.connect(ctx.destination);
    return ctx;
  }

  // 浏览器要求用户交互后才能出声，首次点击/按键时解锁
  function unlock() {
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
    if (conf.music) startMusic();
    // iOS / Chrome 需要一次用户手势才能启动语音播报，这里先静音预热一次
    try {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch {}
  }
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  function tone({ freq, dur = 0.15, type = 'sine', vol = 0.2, at = 0, slideTo = 0, bus = null }) {
    const c = ensureCtx();
    if (!c) return;
    const t = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(bus || sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // 噪声用于发牌沙沙声、出牌摩擦声
  function noise({ dur = 0.2, vol = 0.15, at = 0, hp = 1000 }) {
    const c = ensureCtx();
    if (!c) return;
    const t = c.currentTime + at;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f);
    f.connect(g);
    g.connect(sfxBus);
    src.start(t);
  }

  const SFX = {
    // 按钮点击
    click() {
      tone({ freq: 680, dur: 0.05, type: 'sine', vol: 0.1 });
    },
    // 发牌：沙沙声 + 连续轻响
    deal() {
      noise({ dur: 0.4, vol: 0.16, hp: 1100 });
      for (let i = 0; i < 5; i++) {
        tone({ freq: 380 + i * 70, dur: 0.07, type: 'triangle', vol: 0.12, at: 0.05 + i * 0.18 });
      }
    },
    // 出牌
    play() {
      noise({ dur: 0.08, vol: 0.15, hp: 1800 });
      tone({ freq: 540, dur: 0.12, type: 'triangle', vol: 0.15, slideTo: 330 });
    },
    // 收拾本墩
    trick() {
      noise({ dur: 0.16, vol: 0.09, hp: 600 });
    },
    // 轮到你出牌
    turn() {
      tone({ freq: 740, dur: 0.12, type: 'sine', vol: 0.16 });
      tone({ freq: 988, dur: 0.16, type: 'sine', vol: 0.14, at: 0.13 });
    },
    // 亮主 / 反主
    declare() {
      [523.25, 659.25, 783.99].forEach((f, i) =>
        tone({ freq: f, dur: 0.2, type: 'triangle', vol: 0.15, at: i * 0.09 }),
      );
    },
    // 叫分
    bid() {
      [587.33, 783.99, 987.77].forEach((f, i) =>
        tone({ freq: f, dur: 0.16, type: 'sine', vol: 0.15, at: i * 0.08 }),
      );
    },
    // 赢墩/得分
    win() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.16, at: i * 0.1 }),
      );
    },
    // 输了一墩 / 结算失败
    lose() {
      [440, 392, 329.63, 261.63].forEach((f, i) =>
        tone({ freq: f, dur: 0.26, type: 'sine', vol: 0.15, at: i * 0.12 }),
      );
    },
    // 出错
    error() {
      tone({ freq: 220, dur: 0.11, type: 'square', vol: 0.12 });
      tone({ freq: 175, dur: 0.14, type: 'square', vol: 0.1, at: 0.13 });
    },
  };

  function sfx(name) {
    if (!conf.sfx || !ctx) return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      fn();
    } catch {}
  }

  // 五声音阶（C 宫调）：柔和的中式背景旋律
  const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
  const MELODY = [0, 2, 4, 5, 4, 3, 2, 1, 0, 2, 3, 4, 2, 1, 0, 1];
  const STEP = 0.62; // 每个音符 0.62 秒

  function musicLoop() {
    if (!conf.music || !ctx) return;
    MELODY.forEach((idx, i) => {
      const f = SCALE[idx];
      tone({ freq: f, dur: 0.55, type: 'sine', vol: 0.1, at: i * STEP, bus: musicBus });
      tone({ freq: f * 2, dur: 0.3, type: 'triangle', vol: 0.025, at: i * STEP, bus: musicBus });
    });
    // 低音铺底，每 4 拍一个
    [0, 3, 4, 0].forEach((idx, i) =>
      tone({ freq: SCALE[idx] / 2, dur: 2.2, type: 'sine', vol: 0.05, at: i * STEP * 4, bus: musicBus }),
    );
    musicTimer = setTimeout(musicLoop, MELODY.length * STEP * 1000 - 250);
  }

  function startMusic() {
    const c = ensureCtx();
    if (!c || !conf.music || musicTimer) return;
    if (c.state === 'suspended') c.resume();
    const t = c.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    musicBus.gain.linearRampToValueAtTime(0.9, t + 1.5);
    musicLoop();
  }

  function stopMusic() {
    if (musicTimer) {
      clearTimeout(musicTimer);
      musicTimer = null;
    }
    if (!ctx || !musicBus) return;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.5);
  }

  // ---------- 语音播报（点数 / 牌型 / 毙牌）----------
  let zhVoice = null;

  function pickVoice() {
    if (!window.speechSynthesis) return;
    const list = window.speechSynthesis.getVoices() || [];
    zhVoice =
      list.find((v) => /^zh[-_]CN/i.test(v.lang) && /female|女|Ting|Xiao/i.test(v.name)) ||
      list.find((v) => /^zh/i.test(v.lang)) ||
      list.find((v) => /Chinese|中文|普通话/i.test(v.name)) ||
      null;
  }
  if (window.speechSynthesis) {
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
  }

  // 语音播报新内容时打断上一条，避免排队积压
  function say(text) {
    if (!conf.voice || !text) return;
    if (!window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'zh-CN';
      if (zhVoice) u.voice = zhVoice;
      u.rate = 1.3;
      u.pitch = 1;
      u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch {}
  }

  window.GameAudio = {
    sfx,
    say,
    unlock,
    get musicOn() {
      return conf.music;
    },
    get sfxOn() {
      return conf.sfx;
    },
    get voiceOn() {
      return conf.voice;
    },
    setMusic(on) {
      conf.music = !!on;
      save();
      if (conf.music) startMusic();
      else stopMusic();
      return conf.music;
    },
    setSfx(on) {
      conf.sfx = !!on;
      save();
      if (conf.sfx) sfx('click');
      return conf.sfx;
    },
    setVoice(on) {
      conf.voice = !!on;
      save();
      if (!conf.voice && window.speechSynthesis) {
        try {
          window.speechSynthesis.cancel();
        } catch {}
      }
      if (conf.voice) say('语音播报已开启');
      return conf.voice;
    },
  };
})();
