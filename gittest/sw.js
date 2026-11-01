const N="gittest",C=N+'-'+"mvy1szjh",SHELL=['./','./index.html','./manifest.webmanifest','./logo.jpg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.startsWith(N+'-')&&x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
const shell=u.origin===location.origin&&SHELL.some(p=>new URL(p,self.registration.scope).href===u.origin+u.pathname);
if(shell){e.respondWith(caches.match(r,{ignoreSearch:true}).then(h=>h||fetch(r).then(n=>{if(n.ok){const cp=n.clone();caches.open(C).then(c=>c.put(r,cp))}return n})))}
else{e.respondWith(fetch(r).then(n=>{if(n.ok){const cp=n.clone();caches.open(C).then(c=>c.put(r,cp))}return n}).catch(()=>caches.match(r)))}});