import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';

const PREFIX = 'MagikRessourcesMonitor.';
const defaults = {Enabled:true, Interval:1, CPU:true, RAM:true, GPU:true, VRAM:true, Temperature:true,
  Disk:false, Mount:'', Width:72, Height:36, Smooth:true, NumbersOnly:false, Position:'Floating'};
const values = {...defaults};
const cards = new Map();
const peaks = new Map();
let root, body, state, mountSelect, timer, controller, running = false, disposed = false, lastData;
let lastSuccess = 0, nextDue = 0;
const gpuSettings = new Set();
const bytes = v => Number.isFinite(v) && v >= 0 ? `${(v / 1073741824).toFixed(2)} GiB` : 'Unavailable';
const valid = v => Number.isFinite(v) && v >= 0;
const get = key => values[key];
const save = (key, value) => { values[key] = value; };

function setStatus(text, bad=false) {
  state.textContent = text;
  state.style.color = bad ? '#ffb65b' : '#c8d7e6';
}
function invalidate(text) {
  for (const card of cards.values()) {
    card.value.textContent = '—';
    card.fill.style.transform = 'scaleX(0)';
    card.node.title = text;
    card.node.classList.add('unavailable');
  }
}
function card(key, label, color) {
  if (cards.has(key)) return cards.get(key);
  const node = document.createElement('div'); node.className='mrm-card';
  const fill = document.createElement('div'); fill.className='mrm-fill'; fill.style.background=color;
  const caption = document.createElement('span'); caption.className='mrm-caption'; caption.textContent=label;
  const value = document.createElement('span'); value.className='mrm-value'; value.textContent='—';
  node.append(fill,caption,value); body.append(node);
  const result={node,fill,value}; cards.set(key,result); return result;
}
function update(key, label, color, percent, unit='%', memory=null, title='') {
  const c=card(key,label,color);
  c.node.classList.toggle('unavailable',!valid(percent));
  if (!valid(percent)) {
    c.value.textContent='—'; c.fill.style.transform='scaleX(0)'; c.node.title=`${title || label}: unavailable`; return;
  }
  const n=Math.floor(percent);
  const text=`${n}${unit}`;
  if (c.value.textContent!==text) c.value.textContent=text;
  const transform=`scaleX(${Math.max(0,Math.min(percent / 100,1))})`;
  if (c.fill.style.transform!==transform) c.fill.style.transform=transform;
  let tooltip=`${title || label}: ${text}`;
  if (memory && valid(memory.used) && valid(memory.total)) {
    // Distinct keys prevent RAM, disks and individual GPUs sharing a peak.
    const old=peaks.get(key);
    const peak=Math.max(old && old.total===memory.total ? old.used : 0,memory.used);
    peaks.set(key,{used:peak,total:memory.total});
    tooltip+=`\n${bytes(memory.used)} / ${bytes(memory.total)}\nObserved peak: ${bytes(peak)} (this browser session)`;
  }
  c.node.title=tooltip;
}
function render(data) {
  const active=new Set();
  const show=(key,...args)=>{active.add(key);update(key,...args);};
  if(get('CPU')) show('cpu','CPU','#249541',data.cpu,'%',null,'Whole-system CPU average');
  if(get('RAM')) show('ram','RAM','#267b46',data.ram?.percent,'%',data.ram,'RAM: total minus available');
  for(const gpu of data.gpus || []) {
    for (const [kind,label] of [['GPU','usage'],['VRAM','VRAM'],['Temperature','temperature']]) {
      const key=`${kind}${gpu.index}`;
      if (!gpuSettings.has(key)) {
        gpuSettings.add(key); values[key]=true;
        app.ui.settings.addSetting({id:PREFIX+key,name:`GPU ${gpu.index} ${label}: ${gpu.name}`,category:['Magik Ressources Monitor','Individual GPUs',key],type:'boolean',defaultValue:true,onChange:v=>{values[key]=v;if(lastData && cards.has(`gpu:${gpu.index}`))render(lastData);}});
        values[key]=app.ui.settings.getSettingValue(PREFIX+key,true);
      }
    }
    const label=(data.gpus.length>1 ? ` ${gpu.index}` : '');
    if(get('GPU') && get(`GPU${gpu.index}`)) show(`gpu:${gpu.index}`,'GPU'+label,'#2388d9',gpu.utilization,'%',null,gpu.name+' — device utilization');
    if(get('VRAM') && get(`VRAM${gpu.index}`)) show(`vram:${gpu.index}`,'VRAM'+label,'#3a61bd',gpu.percent,'%',gpu,gpu.name+' — device VRAM');
    if(get('Temperature') && get(`Temperature${gpu.index}`)) show(`temp:${gpu.index}`,'Temp'+label,'#b67b22',gpu.temperature,'°C',null,gpu.name+' — temperature');
  }
  if(!data.gpu_available && (get('GPU')||get('VRAM')||get('Temperature'))) show('gpu:unavailable','NVIDIA','#2388d9',null);
  if(get('Disk')) show(`disk:${get('Mount')}`,'Disk','#924bb8',data.disk?.percent,'%',data.disk,`Disk capacity: ${get('Mount') || 'select a mount in settings'}`);
  for(const [key,c] of cards) c.node.hidden=!active.has(key);
  root.style.setProperty('--mrm-width',`${get('Width')}px`);
  root.style.setProperty('--mrm-height',`${get('Height')}px`);
  root.style.setProperty('--mrm-duration',get('Smooth') ? `${get('Interval')}s` : '0s');
  root.classList.toggle('numbers-only',get('NumbersOnly'));
  const mounts=data.mounts||[];
  const options=['',...mounts];
  if(JSON.stringify(options)!==mountSelect.dataset.options){
    mountSelect.replaceChildren(...options.map(m=>{const o=document.createElement('option');o.value=m;o.textContent=m||'Select filesystem';return o;}));
    mountSelect.dataset.options=JSON.stringify(options);
  }
  mountSelect.value=get('Mount');
  mountSelect.hidden=!get('Disk');
}
function place() {
  if (!root) return;
  // A self-contained floating fallback keeps monitoring accessible if menu APIs change.
  const mode=get('Position');
  let target=null;
  if(mode==='Top'||mode==='Bottom') target=app.menu?.settingsGroup?.element?.parentElement;
  if(mode==='Legacy') target=document.getElementById('queue-button')?.parentElement;
  if(target && target.isConnected) {
    if(root.parentElement!==target) target.append(root);
    root.classList.add('docked');
  } else {
    if(root.parentElement!==document.body) document.body.append(root);
    root.classList.remove('docked');
  }
}
function schedule(delay=0) {
  clearTimeout(timer);
  if(disposed) return;
  timer=setTimeout(poll,delay);
}
function changed() {
  if(!root) return;
  root.hidden=!get('Enabled');
  place();
  if(lastData) render(lastData);
  if(!get('Enabled') || get('Interval')===0) {
    controller?.abort();
    setStatus(get('Enabled')?'Paused':'Disabled'); invalidate('Monitoring paused');
  }
  nextDue=0;
  schedule();
}
async function poll() {
  if(disposed || running) return;
  if(!get('Enabled') || get('Interval')===0 || document.hidden) return;
  if(performance.now()<nextDue) {schedule(nextDue-performance.now());return;}
  place();
  running=true;
  controller=new AbortController();
  const timeout=setTimeout(()=>controller?.abort(),5000);
  const requestedMount=get('Disk') ? get('Mount') : '';
  const requestedInterval=get('Interval');
  const started=performance.now();
  try {
    const response=await api.fetchApi(`/magik_resources/status?interval=${encodeURIComponent(requestedInterval)}&disk=${encodeURIComponent(requestedMount)}`,{signal:controller.signal,cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    if(!get('Enabled') || get('Interval')===0 || document.hidden) return;
    lastData=data; lastSuccess=performance.now();
    render(data);
    const errors=Object.keys(data.errors||{});
    setStatus(`Updated ${new Date(data.timestamp*1000).toLocaleTimeString()}${errors.length?' · sensor unavailable':''}`,errors.length>0);
    state.title=errors.map(k=>`${k}: ${data.errors[k]}`).join('\n') || 'Live hardware readings';
  } catch(error) {
    if(get('Enabled') && get('Interval')>0 && !document.hidden) {
      setStatus(`Disconnected · ${error.message}`,true);invalidate('No current hardware readings');
      // A removed/unmounted disk must not permanently prevent CPU/GPU monitoring.
      if(requestedMount && /mount points/.test(error.message)) {save('Mount','');mountSelect.value='';}
    }
  } finally {
    clearTimeout(timeout); running=false;controller=null;
    const changedDuringRequest=requestedInterval!==get('Interval') || requestedMount!==(get('Disk')?get('Mount'):'');
    nextDue=changedDuringRequest?0:started+Math.max(.25,get('Interval'))*1000;
    if(get('Enabled') && get('Interval')>0 && !document.hidden) schedule(Math.max(0,nextDue-performance.now()));
  }
}

function createUI() {
  const style=document.createElement('style');
  style.textContent=`
  #magik-resources-monitor{position:fixed;right:18px;bottom:18px;z-index:9999;background:#18202bea;color:#e3edf5;border:1px solid #4c6179;border-radius:8px;padding:8px;box-shadow:0 4px 16px #0005;max-width:calc(100vw - 36px);font:12px sans-serif;box-sizing:border-box}
  #magik-resources-monitor[hidden],#magik-resources-monitor [hidden]{display:none!important}
  #magik-resources-monitor.docked{position:relative;right:auto;bottom:auto;z-index:auto;margin:4px}
  #magik-resources-monitor header{display:flex;gap:12px;align-items:center;cursor:move;touch-action:none;margin-bottom:6px}
  #magik-resources-monitor button,#magik-resources-monitor select{background:#2b394b;color:#e3edf5;border:1px solid #526880;border-radius:4px;padding:3px;cursor:pointer}
  #magik-resources-monitor .mrm-body{display:flex;flex-wrap:wrap;gap:5px;max-height:50vh;overflow:auto}
  #magik-resources-monitor .mrm-card{position:relative;isolation:isolate;overflow:hidden;width:var(--mrm-width,72px);height:var(--mrm-height,36px);background:#263141;contain:layout paint style;border-radius:3px}
  #magik-resources-monitor .mrm-fill{position:absolute;inset:0;transform:scaleX(0);transform-origin:left;transition:transform var(--mrm-duration,1s) linear;z-index:-1}
  #magik-resources-monitor .mrm-caption{position:absolute;left:4px;bottom:3px;font-size:10px}
  #magik-resources-monitor .mrm-value{position:absolute;right:4px;top:3px;font-weight:bold}
  #magik-resources-monitor .unavailable{opacity:.65}
  #magik-resources-monitor.numbers-only .mrm-fill{display:none}
  #magik-resources-monitor footer{margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:10px}
  `;
  document.head.append(style);
  root=document.createElement('section');root.id='magik-resources-monitor';root.setAttribute('aria-label','Magik Ressources Monitor');
  const header=document.createElement('header');
  const title=document.createElement('strong'); title.textContent='Magik Ressources Monitor';
  const reset=document.createElement('button');reset.textContent='Reset peaks';reset.title='Reset observed memory peaks in this browser session';reset.onclick=()=>{peaks.clear();if(lastData)render(lastData);};
  header.append(title,reset);
  body=document.createElement('div');body.className='mrm-body';
  const footer=document.createElement('footer');state=document.createElement('span');state.textContent='Connecting…';
  mountSelect=document.createElement('select');mountSelect.title='Filesystem capacity to monitor (not disk activity)';mountSelect.setAttribute('aria-label','Filesystem');
  mountSelect.onchange=()=>{save('Mount',mountSelect.value);try{app.ui.settings.setSettingValue(PREFIX+'Mount',mountSelect.value);}catch{}changed();};
  footer.append(state,mountSelect);root.append(header,body,footer);document.body.append(root);
  try {
    const pos=JSON.parse(localStorage.getItem(PREFIX+'Location')||'null');
    if(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)){root.style.left=`${Math.max(0,Math.min(pos.x,innerWidth-120))}px`;root.style.top=`${Math.max(0,Math.min(pos.y,innerHeight-60))}px`;root.style.right='auto';root.style.bottom='auto';}
  }catch{}
  let drag;
  header.addEventListener('pointerdown',e=>{if(e.target.closest('button')||root.classList.contains('docked'))return;const r=root.getBoundingClientRect();drag={x:e.clientX-r.x,y:e.clientY-r.y};header.setPointerCapture(e.pointerId);});
  header.addEventListener('pointermove',e=>{if(!drag)return;root.style.left=`${Math.max(0,Math.min(e.clientX-drag.x,innerWidth-root.offsetWidth))}px`;root.style.top=`${Math.max(0,Math.min(e.clientY-drag.y,innerHeight-root.offsetHeight))}px`;root.style.right='auto';root.style.bottom='auto';});
  const end=()=>{if(!drag)return;drag=null;const r=root.getBoundingClientRect();try{localStorage.setItem(PREFIX+'Location',JSON.stringify({x:r.x,y:r.y}));}catch{}};
  header.addEventListener('pointerup',end);header.addEventListener('pointercancel',end);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){controller?.abort();clearTimeout(timer);}else{nextDue=0;schedule();}});
  const health=setInterval(()=>{
    if(get('Enabled') && get('Interval')>0 && !document.hidden && lastSuccess && performance.now()-lastSuccess>Math.max(6000,get('Interval')*2500)) {setStatus('Stale · waiting for current readings',true);invalidate('Readings are stale');}
  },1000);
  window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(timer);clearInterval(health);controller?.abort();});
  window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
}
app.registerExtension({
  name:'Magik.RessourcesMonitor',
  setup(){
    const settings=app.ui.settings;
    function add(key,name,type,extra={}) {
      settings.addSetting({id:PREFIX+key,name,category:['Magik Ressources Monitor',key==='Interval'?'Sampling':'Display',key],type,defaultValue:defaults[key],...extra,onChange:value=>{
        if(key==='Interval' && (!Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>60 || (Number(value)>0 && Number(value)<.25))) return;
        if((key==='Width'||key==='Height') && (!Number.isFinite(Number(value)) || Number(value)<16 || Number(value)>240))return;
        save(key,value);changed();
      }});
      const stored=settings.getSettingValue(PREFIX+key,defaults[key]);
      // Reuse the same validation for persisted settings.
      if(typeof stored===typeof defaults[key]) values[key]=stored;
    }
    add('Enabled','Enable monitor','boolean');
    add('Interval','Seconds between updates (0 = pause)','slider',{attrs:{min:0,max:60,step:.25},tooltip:'0.25 = four updates per second; 2 = one update every two seconds. Hidden browser tabs stop polling.'});
    for(const [key,label] of [['CPU','CPU usage'],['RAM','RAM used'],['GPU','NVIDIA GPU usage'],['VRAM','VRAM used'],['Temperature','GPU temperature'],['Disk','Filesystem capacity']])add(key,label,'boolean');
    add('Mount','Filesystem mount point','text',{tooltip:'Use the filesystem selector on the monitor. Only currently listed mount points are accepted.'});
    add('Width','Bar width (pixels)','slider',{attrs:{min:40,max:160,step:1}});
    add('Height','Bar height (pixels)','slider',{attrs:{min:24,max:80,step:1}});
    add('Smooth','Smooth bar animation','boolean');add('NumbersOnly','Numbers only','boolean');
    add('Position','Monitor placement','combo',{options:['Floating','Top','Bottom','Legacy'],tooltip:'Menu placement falls back to a movable floating panel if the menu is unavailable.'});
    if(!Number.isFinite(values.Interval)||values.Interval<0||values.Interval>60||(values.Interval>0&&values.Interval<.25))values.Interval=1;
    for(const key of ['Width','Height'])if(!Number.isFinite(values[key])||values[key]<16||values[key]>240)values[key]=defaults[key];
    createUI();changed();
  }
});
