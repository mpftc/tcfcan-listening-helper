const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { start, readView, isListeningPath, createSoundBank } = require('./tcfcan-listening-helper.user.js');

// Minimal synthetic markup matches the public DOM contract, not TCFcan questions.
const markup = `<!doctype html><html><body><main>
  <section id="player"><audio src="blob:https://tcfcan.com/test-audio"></audio>
  <button aria-label="Pause">Pause</button><input type="range" aria-label="Audio progress" min="0" max="30" value="10" step="any"></section>
  <section id="options">${['A','B','C','D'].map((label,i)=>`<button aria-disabled="false" class="bg-white"><span>${label}</span><div data-module="listening" data-question-id="test-question" data-content-type="option" data-content-index="${i}"><span>Sample option ${label}</span></div></button>`).join('')}</section>
  <button id="submit">提交</button><button id="redo">重做</button><div id="explanation">Example explanation remains here.</div>
</main></body></html>`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, saved = {}, url = 'https://tcfcan.com/practice/listening') {
  const dom = new JSDOM(markup, { url });
  const win = dom.window, doc = win.document;
  const audio = doc.querySelector('audio'), seek = doc.querySelector('input'), toggle = doc.querySelector('#player button');
  let paused = false, boundary = 12;
  const log = { tones: [], pauses: 0, plays: 0, seeks: 0, stored: [], menus: new Map() };
  Object.defineProperty(audio, 'paused', {get:()=>paused});
  audio.currentTime = 10; audio.volume = 0.6; audio.playbackRate = 1.5;
  audio.pause = () => { paused = true; log.pauses++; };
  audio.play = () => { paused = false; log.plays++; return Promise.resolve(); };
  toggle.addEventListener('click', () => {
    boundary = null;
    if (toggle.getAttribute('aria-label') === 'Pause') { audio.pause(); toggle.setAttribute('aria-label','Lecture'); }
    else { audio.play(); toggle.setAttribute('aria-label','Pause'); }
  });
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); boundary = null; log.seeks++; });
  const sounds = { unlock:()=>true, play:(correct,volume)=>{log.tones.push({correct,volume});return {duration:0,blocked:false};}, stop:()=>{}, close:()=>{} };
  let counter = 0;
  const gm = {get:()=>saved,set:(key,value)=>log.stored.push({key,value}),register:(label,fn)=>{log.menus.set(++counter,{label,fn});return counter;},unregister:id=>log.menus.delete(id)};
  const controller = start(win,gm,{sounds,userEvent:()=>true});
  t.after(()=>{controller.stop();win.close();});
  const options = [...doc.querySelectorAll('#options > button')];
  function select(index) { options.forEach((b,i)=>{b.className = i===index?'bg-blue-100 text-blue-900':'bg-white';b.setAttribute('aria-disabled','false');}); }
  function result(correct,choice) { options.forEach((b,i)=>{b.setAttribute('aria-disabled','true');b.className=i===correct?'bg-green-50 text-green-900':i===choice?'bg-red-50 text-red-900':'bg-gray-100';});doc.querySelector('#submit').disabled=true;controller.scan(); }
  function clickSubmit(){doc.querySelector('#submit').dispatchEvent(new win.MouseEvent('click',{bubbles:true}));}
  function enter(repeat=false){win.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true,repeat}));}
  return {win,doc,audio,seek,toggle,log,controller,options,select,result,clickSubmit,enter,boundary:()=>boundary};
}

test('correct answer sounds once without pausing or replaying', async t=>{
  const f=fixture(t);f.select(2);f.clickSubmit();f.result(2,2);f.controller.scan();
  await wait(190);assert.deepEqual(f.log.tones,[{correct:true,volume:0.35}]);
  assert.equal(f.log.pauses,0);assert.equal(f.log.plays,0);assert.equal(f.audio.currentTime,10);
});
test('wrong answer resets sentence playback, replays once and preserves answer/volume/rate', async t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,0);
  assert.equal(f.audio.paused,true);assert.equal(f.log.tones[0].correct,false);
  await wait(200);f.controller.scan();await wait(80);
  assert.equal(f.log.plays,1);assert.equal(f.log.seeks,1);assert.equal(f.audio.currentTime,0);
  assert.equal(f.boundary(),null);assert.equal(f.audio.volume,0.6);assert.equal(f.audio.playbackRate,1.5);
  assert.equal(readView(f.doc).result.wrong,0);assert.match(f.doc.querySelector('#explanation').textContent,/remains/);
});
test('loading saved answers or revealing a correct answer without submission is silent', async t=>{
  const f=fixture(t);f.result(2,0);await wait(190);assert.equal(f.log.tones.length,0);assert.equal(f.log.plays,0);
});
test('selecting an option alone is silent', async t=>{
  const f=fixture(t);f.select(0);f.controller.scan();await wait(60);assert.equal(f.log.tones.length,0);
});
test('keyboard Enter works; repeated Enter and DOM updates do not duplicate feedback', t=>{
  const f=fixture(t);f.select(1);f.enter();f.enter(true);f.result(1,1);f.enter();f.controller.scan();assert.equal(f.log.tones.length,1);
});
test('redo on the same question allows one new feedback', t=>{
  const f=fixture(t);f.select(1);f.clickSubmit();f.result(1,1);f.select(2);f.doc.querySelector('#submit').disabled=false;
  f.controller.scan();f.clickSubmit();f.result(2,2);assert.equal(f.log.tones.length,2);
});
test('changing question during cue cancels old replay', async t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,0);
  f.doc.querySelectorAll('[data-question-id]').forEach(e=>e.setAttribute('data-question-id','next-question'));
  await wait(210);assert.equal(f.log.plays,0);
});
test('changing audio source during cue cancels replay', async t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,0);f.audio.src='blob:https://tcfcan.com/replaced';
  await wait(210);assert.equal(f.log.plays,0);
});
test('manual pointer interaction cancels pending auto replay', async t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,0);
  f.doc.dispatchEvent(new f.win.Event('pointerdown',{bubbles:true}));await wait(210);assert.equal(f.log.plays,0);
});
test('route change out of listening cancels replay', async t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,0);
  f.win.history.pushState({},'', '/practice/reading');await wait(210);assert.equal(f.log.plays,0);
});
test('wrong replay toggle keeps error cue but leaves audio alone', async t=>{
  const f=fixture(t,{replay:false});f.select(0);f.clickSubmit();f.result(2,0);await wait(180);
  assert.equal(f.log.tones.length,1);assert.equal(f.log.plays,0);assert.equal(f.log.pauses,0);
});
test('master off has no effects', t=>{
  const f=fixture(t,{enabled:false});f.select(0);f.clickSubmit();f.result(2,0);assert.equal(f.log.tones.length,0);assert.equal(f.log.pauses,0);
});
test('ambiguous or mismatched result is ignored', t=>{
  const f=fixture(t);f.select(0);f.clickSubmit();f.result(2,1);assert.equal(f.log.tones.length,0);
});
test('memorization mode locked options cannot arm a submission', t=>{
  const f=fixture(t);f.select(2);f.options.forEach(b=>b.setAttribute('aria-disabled','true'));f.clickSubmit();f.result(2,2);assert.equal(f.log.tones.length,0);
});
test('typing Enter in text fields does not arm feedback', t=>{
  const f=fixture(t);f.select(1);f.seek.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));f.result(1,1);assert.equal(f.log.tones.length,0);
});
test('settings are saved and menu IDs are replaced', t=>{
  const f=fixture(t);const entry=[...f.log.menus.values()].find(m=>m.label.startsWith('错题重播'));
  entry.fn();assert.equal(f.controller.settings.replay,false);assert.equal(f.log.stored.length,1);assert.equal(f.log.menus.size,5);
});
test('only listening practice routes are active', ()=>{
  for(const p of ['/practice/listening','/en/practice/listening/']) assert.equal(isListeningPath(p),true);
  for(const p of ['/practice/reading','/mock-exam','/practice/listening-other']) assert.equal(isListeningPath(p),false);
});
test('real tone generator handles suspended audio and produces distinct pitches with envelope', ()=>{
  const oscillators=[];
  class AudioContext {
    constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
    resume(){this.state='running';return Promise.resolve();}
    close(){this.state='closed';return Promise.resolve();}
    createOscillator(){const osc={frequency:{value:0},connect(){},disconnect(){},start(){},stop(){}};oscillators.push(osc);return osc;}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const sound=createSoundBank({AudioContext});assert.equal(sound.play(true,0.35).blocked,true);
  sound.unlock();assert.equal(sound.play(true,0.35).duration,350);assert.equal(sound.play(false,0.35).duration,420);
  assert.deepEqual(oscillators.map(o=>o.frequency.value),[659.25,987.77,220,164.81]);sound.close();
});
