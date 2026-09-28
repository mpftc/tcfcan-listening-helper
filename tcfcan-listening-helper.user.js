// ==UserScript==
// @name         TCFcan 听力答题提示
// @namespace    https://github.com/mpftc/tcfcan-listening-helper
// @version      1.0.0
// @description  听力练习答对/答错短音效；答错后保留解析并从头重播一次。
// @author       mpftc
// @match        https://tcfcan.com/*
// @match        https://www.tcfcan.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @homepageURL  https://github.com/mpftc/tcfcan-listening-helper
// @supportURL   https://github.com/mpftc/tcfcan-listening-helper/issues
// @downloadURL  https://raw.githubusercontent.com/mpftc/tcfcan-listening-helper/main/tcfcan-listening-helper.user.js
// @updateURL    https://raw.githubusercontent.com/mpftc/tcfcan-listening-helper/main/tcfcan-listening-helper.user.js
// @license      MIT
// ==/UserScript==

(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.start(window, {
    get: typeof GM_getValue === 'function' ? GM_getValue : (_key, fallback) => fallback,
    set: typeof GM_setValue === 'function' ? GM_setValue : () => {},
    register: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null,
    unregister: typeof GM_unregisterMenuCommand === 'function' ? GM_unregisterMenuCommand : null,
  });
})(function () {
  'use strict';

  const OPTION = '[data-module="listening"][data-content-type="option"][data-question-id]';
  const HOST_ID = 'tcfcan-listening-helper';
  const DEFAULTS = { enabled: true, replay: true, volume: 0.35 };
  const isListeningPath = path => /^(?:\/(?:en|fr|zh|zh-cn))?\/practice\/listening\/?$/.test(path);
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  // These attributes and exact state classes were inspected on TCFcan on 2026-09-28.
  // Do not use computed colors, sidebar statistics, or hidden framework state.
  function readView(doc) {
    const buttons = new Map();
    for (const el of doc.querySelectorAll(OPTION)) {
      const button = el.closest('button');
      if (!button || button.closest('[hidden], [aria-hidden="true"]')) continue;
      const id = el.getAttribute('data-question-id');
      const index = Number(el.getAttribute('data-content-index'));
      if (!id || !Number.isInteger(index) || index < 0 || index > 3) continue;
      buttons.set(button, { button, id, index });
    }
    const options = [...buttons.values()];
    if (options.length !== 4 || new Set(options.map(o => o.id)).size !== 1 ||
        new Set(options.map(o => o.index)).size !== 4) return null;
    const selected = options.filter(o => o.button.classList.contains('bg-blue-100'));
    const green = options.filter(o => o.button.classList.contains('bg-green-50'));
    const red = options.filter(o => o.button.classList.contains('bg-red-50'));
    const locked = options.every(o => o.button.getAttribute('aria-disabled') === 'true');
    const editable = options.every(o => !o.button.disabled && o.button.getAttribute('aria-disabled') === 'false');
    return { id: options[0].id, options, editable,
      selected: editable && selected.length === 1 ? selected[0].index : null,
      result: locked && green.length === 1 && red.length <= 1 ? {
        correct: green[0].index, wrong: red.length ? red[0].index : null,
      } : null };
  }

  function getPlayer(doc) {
    for (const audio of doc.querySelectorAll('audio')) {
      for (let root = audio.parentElement, depth = 0; root && depth < 5; root = root.parentElement, depth++) {
        const seek = root.querySelector('input[type="range"][aria-label="Audio progress"]');
        const toggle = root.querySelector('button[aria-label="Pause"],button[aria-label="Lecture"],button[aria-label="Play"]');
        if (seek && toggle && root.querySelectorAll('audio').length === 1) return { audio, root, seek, toggle };
      }
    }
    return null;
  }

  function createSoundBank(win) {
    let context;
    const active = new Set();
    function unlock() {
      try {
        const AudioContext = win.AudioContext || win.webkitAudioContext;
        if (!AudioContext) return false;
        if (!context || context.state === 'closed') context = new AudioContext();
        if (context.state !== 'running') Promise.resolve(context.resume()).catch(() => {});
        return context.state === 'running';
      } catch { return false; }
    }
    function stop() {
      for (const osc of active) { try { osc.stop(); } catch { /* Already ended. */ } }
      active.clear();
    }
    function play(correct, volume) {
      if (!context || context.state !== 'running') return { blocked: true, duration: 0 };
      stop();
      if (volume <= 0) return { blocked: false, duration: 0 };
      const notes = correct ? [[659.25, 0, 0.12], [987.77, 0.13, 0.20]] : [[220, 0, 0.16], [164.81, 0.18, 0.22]];
      const start = context.currentTime + 0.01;
      for (const [frequency, offset, duration] of notes) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.type = correct ? 'sine' : 'triangle';
        osc.frequency.value = frequency;
        const at = start + offset;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(volume * 0.22, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        osc.connect(gain); gain.connect(context.destination);
        active.add(osc);
        osc.onended = () => { active.delete(osc); osc.disconnect(); gain.disconnect(); };
        osc.start(at); osc.stop(at + duration + 0.01);
      }
      return { blocked: false, duration: correct ? 350 : 420 };
    }
    return { unlock, play, stop, close() { stop(); if (context) Promise.resolve(context.close()).catch(() => {}); } };
  }

  function start(win, gm, test = {}) {
    const doc = win.document;
    if (doc.getElementById(HOST_ID)) return null;
    const stored = gm.get('settings', DEFAULTS);
    const settings = { enabled: stored?.enabled !== false, replay: stored?.replay !== false,
      volume: typeof stored?.volume === 'number' && Number.isFinite(stored.volume) ? Math.max(0, Math.min(1, stored.volume)) : DEFAULTS.volume };
    const sounds = test.sounds || createSoundBank(win);
    const userEvent = test.userEvent || (event => event.isTrusted);
    let pending = null, job = null, scanTimer = 0, hideTimer = 0, stopped = false;
    let knownId = null;
    const menus = [];
    const host = doc.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:78px;z-index:2147483647;max-width:min(320px,90vw);display:none';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = ':host{font-family:system-ui,sans-serif}section{padding:12px 14px;background:#fff;color:#172033;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 4px 24px #0002;font-size:14px}button{margin-top:8px;background:#2b579a;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}';
    const box = doc.createElement('section');
    const message = doc.createElement('div'); message.setAttribute('role', 'status');
    const action = doc.createElement('button'); action.type = 'button'; action.hidden = true;
    box.append(message, action); shadow.append(style, box); doc.documentElement.append(host);

    function notice(value, callback = null) {
      win.clearTimeout(hideTimer); host.style.display = 'block'; message.textContent = value;
      action.hidden = !callback; action.textContent = '点击启用声音';
      action.onclick = callback;
      if (!callback) hideTimer = win.setTimeout(() => { host.style.display = 'none'; }, 4500);
    }
    function cancel() {
      pending = null;
      if (job) win.clearTimeout(job.timer);
      job = null; sounds.stop();
    }
    function valid(currentJob) {
      if (stopped || job !== currentJob || !settings.enabled || !settings.replay || !isListeningPath(win.location.pathname)) return false;
      const view = readView(doc);
      const player = getPlayer(doc);
      return view?.id === currentJob.id && view.result?.wrong === currentJob.choice &&
        player?.audio === currentJob.audio && player.audio.isConnected &&
        player.audio.getAttribute('src') === currentJob.src;
    }
    function replay(currentJob) {
      if (!valid(currentJob)) { if (job === currentJob) job = null; return; }
      const player = getPlayer(doc);
      job = null;
      if (player.toggle.disabled || player.seek.disabled || !player.audio.getAttribute('src')) {
        notice('听力尚未就绪，请点播放器从头重播。'); return;
      }
      // Use the site's controls so sentence playback limits and React's play state reset too.
      // Native value setter ensures React sees the range change rather than its value tracker swallowing it.
      try {
        Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(player.seek, '0');
        player.seek.dispatchEvent(new win.Event('input', { bubbles: true }));
        player.seek.dispatchEvent(new win.Event('change', { bubbles: true }));
        player.audio.currentTime = 0;
        if (player.audio.paused) player.toggle.click();
        win.setTimeout(() => {
          if (!stopped && readView(doc)?.id === currentJob.id && player.audio.isConnected && player.audio.paused) {
            notice('浏览器未能自动播放，请点播放器重播。');
          }
        }, 700);
      } catch { notice('自动重播未成功，请点播放器重播。'); }
    }
    function feedback(correct, attempt) {
      const player = !correct && settings.replay ? getPlayer(doc) : null;
      if (player) {
        job = { id: attempt.id, choice: attempt.choice, audio: player.audio,
          src: player.audio.getAttribute('src'), timer: 0 };
        if (player.toggle.getAttribute('aria-label') === 'Pause' && !player.toggle.disabled) player.toggle.click();
        if (!player.audio.paused) player.audio.pause();
      }
      const sound = sounds.play(correct, settings.volume);
      if (sound.blocked) notice('提示音被浏览器暂停，点一下启用。', () => {
        sounds.unlock();
        win.setTimeout(() => {
          const check = sounds.play(true, settings.volume);
          notice(check.blocked ? '请先点击网页，再从油猴菜单试听。' : '声音已启用。');
        }, 80);
      });
      if (!correct && settings.replay && !player) notice('未找到本题播放器，请手动重播。');
      if (job) {
        const currentJob = job;
        currentJob.timer = win.setTimeout(() => replay(currentJob), sound.duration + 150);
      }
    }
    function scan() {
      scanTimer = 0;
      if (stopped) return;
      if (!isListeningPath(win.location.pathname)) { cancel(); knownId = null; host.style.display = 'none'; return; }
      const view = readView(doc);
      if (view?.id !== knownId) { cancel(); knownId = view?.id || null; }
      if (job && (!view?.result || !valid(job))) cancel();
      if (!pending) return;
      if (!settings.enabled || Date.now() > pending.until || view?.id !== pending.id) { pending = null; return; }
      if (!view.result) return;
      const attempt = pending; pending = null;
      const correct = view.result.correct === attempt.choice;
      if ((correct && view.result.wrong !== null) || (!correct && view.result.wrong !== attempt.choice)) return;
      feedback(correct, attempt);
    }
    function scheduleScan() { if (!stopped && !scanTimer) scanTimer = win.setTimeout(scan, 25); }
    function arm() {
      if (!settings.enabled || !isListeningPath(win.location.pathname)) return;
      const view = readView(doc);
      if (!view?.editable || view.selected === null) return;
      cancel(); knownId = view.id;
      pending = { id: view.id, choice: view.selected, until: Date.now() + 5000 };
      scheduleScan();
    }
    function onPointer(event) {
      if (!userEvent(event) || !isListeningPath(win.location.pathname)) return;
      if (job) cancel();
      if (settings.enabled) sounds.unlock();
    }
    function onClick(event) {
      if (!userEvent(event) || !isListeningPath(win.location.pathname)) return;
      const button = event.target?.closest?.('button');
      if (button && !button.disabled && /^(提交(?:答案)?|Submit(?: answer)?)$/i.test(text(button))) arm();
    }
    function onKey(event) {
      if (!userEvent(event) || !isListeningPath(win.location.pathname) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (job) cancel();
      if (settings.enabled) sounds.unlock();
      if (event.key === 'Enter') arm();
    }
    function save() { cancel(); gm.set('settings', { ...settings }); registerMenus(); }
    function preview(correct) {
      cancel(); sounds.unlock();
      win.setTimeout(() => {
        const result = sounds.play(correct, settings.volume);
        if (result.blocked) notice('请点击网页启用声音。', () => preview(correct));
      }, 80);
    }
    function registerMenus() {
      if (!gm.register) return;
      if (gm.unregister) for (const id of menus.splice(0)) gm.unregister(id);
      else if (menus.length) return;
      const add = (label, callback) => menus.push(gm.register(label, callback));
      add(`听力助手：${settings.enabled ? '开启' : '关闭'}（点击切换）`, () => { settings.enabled = !settings.enabled; save(); });
      add(`错题重播：${settings.replay ? '开启' : '关闭'}（点击切换）`, () => { settings.replay = !settings.replay; save(); });
      add(`提示音音量：${Math.round(settings.volume * 100)}%`, () => {
        const value = win.prompt('提示音音量：0–100（不改变题目音量）', String(Math.round(settings.volume * 100)));
        if (value === null || value.trim() === '') return;
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 100) { notice('请输入 0–100 的数字。'); return; }
        settings.volume = number / 100; save();
      });
      add('试听：答对音效', () => preview(true));
      add('试听：答错音效', () => preview(false));
    }
    const observer = new win.MutationObserver(records => {
      if (records.some(record => record.target !== host && !host.contains(record.target))) scheduleScan();
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'aria-disabled', 'data-question-id', 'data-content-index', 'src'] });
    doc.addEventListener('pointerdown', onPointer, true);
    doc.addEventListener('click', onClick, true);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('popstate', scheduleScan);
    win.addEventListener('pagehide', cancel);
    registerMenus(); scan();
    return { scan, settings, stop() {
      stopped = true; cancel(); observer.disconnect(); sounds.close();
      win.clearTimeout(scanTimer); win.clearTimeout(hideTimer);
      doc.removeEventListener('pointerdown', onPointer, true); doc.removeEventListener('click', onClick, true);
      win.removeEventListener('keydown', onKey, true); win.removeEventListener('popstate', scheduleScan); win.removeEventListener('pagehide', cancel);
      if (gm.unregister) for (const id of menus) gm.unregister(id);
      host.remove();
    } };
  }
  return { readView, getPlayer, createSoundBank, isListeningPath, start };
});
