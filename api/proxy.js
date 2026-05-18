export const config = { runtime: 'edge' };

let TARGET = 'https://adblock.turtlecute.org';
try {
  if (typeof process !== 'undefined' && process.env.PROXY_TARGET) {
    new URL(process.env.PROXY_TARGET);
    TARGET = process.env.PROXY_TARGET;
  }
} catch (e) { }

const TARGET_ORIGIN = new URL(TARGET).origin;
const TARGET_HOST = new URL(TARGET).host;

const LIST_URL_BASE = 'https://ublockproxy.github.io/filter-lists';

let uboDomains = new Set();
let uboCosmeticCSS = "";
let cachedSwCode = null;
let listsLoaded = false;

const BLOCKED_PATH_PATTERNS = [
  /\/ads[\/.?]/i, /\/ad[\/.?]/i, /\/adserv/i, /\/pagead/i, /\/doubleclick/i,
  /\/analytics\.js/i, /\/gtag\/js/i, /\/gtm\.js/i, /\/pixel\.js/i, /\/tracker/i,
  /\/beacon/i, /\/prebid/i, /\/adsense/i, /\/adsbygoogle/i, /ads\.js$/i
];

async function loadFilterLists() {
  if (listsLoaded) return;
  try {
    const [domainsRes, cssRes] = await Promise.all([
      fetch(`${LIST_URL_BASE}/ubo-domains.json`, { next: { revalidate: 3600 } }),
      fetch(`${LIST_URL_BASE}/ubo-cosmetic.txt`, { next: { revalidate: 3600 } })
    ]);

    if (domainsRes.ok) {
      const domainsArray = await domainsRes.json();
      uboDomains = new Set(domainsArray);
    }

    if (cssRes.ok) {
      uboCosmeticCSS = await cssRes.text();
    }

    listsLoaded = true;
  } catch (error) { }
}

function isBlocked(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();

    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (uboDomains.has(candidate)) return true;
    }

    const pathAndQuery = u.pathname + u.search;
    for (const pat of BLOCKED_PATH_PATTERNS) {
      if (pat.test(pathAndQuery)) return true;
    }
  } catch { }
  return false;
}

const SCRIPTLET_JS = `<script id="proxy-scriptlet-injection">
(function(){
  'use strict';
  
  var AP=['adBlockDetected','blockAdBlock','fuckAdBlock','sniffAdBlock','google_ad_status','__ads','_carbonads','adsbygoogle'];
  AP.forEach(function(p){try{if(typeof window[p]==='undefined')
  Object.defineProperty(window,p,{get:function(){return undefined},set:function(){return true},configurable:false})}catch(e){}});
  
  window.googletag=window.googletag||{cmd:[]};
  window.googletag.pubads=function(){return{addEventListener:function(){},setTargeting:function(){return this},enableSingleRequest:function(){},collapseEmptyDivs:function(){},refresh:function(){},disableInitialLoad:function(){},getSlots:function(){return[]},clear:function(){},set:function(){return this},get:function(){return null},getAttributeKeys:function(){return[]},updateCorrelator:function(){}}};
  window.googletag.enableServices=function(){};
  window.googletag.defineSlot=function(){return{addService:function(){return this},defineSizeMapping:function(){return this},setTargeting:function(){return this}}};
  window.googletag.display=function(){}; window.googletag.destroySlots=function(){};
  window.adsbygoogle=window.adsbygoogle||[];
  try{Object.defineProperty(window.adsbygoogle,'push',{value:function(){return this.length},writable:false})}catch(e){}

  var originalFetch = window.fetch;
  window.fetch = async function(...args) {
    var reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (reqUrl && (reqUrl.includes('/ads') || reqUrl.includes('doubleclick.net') || reqUrl.includes('google-analytics.com'))) {
      return new Response(null, { status: 204 });
    }
    return originalFetch.apply(this, args);
  };

  var originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (url && (url.includes('/ads') || url.includes('doubleclick.net') || url.includes('google-analytics.com'))) {
      this.send = function() { 
        Object.defineProperty(this, 'readyState', {get: function(){return 4}}); 
        if(this.onload) this.onload(); 
      };
      return;
    }
    return originalXHROpen.call(this, method, url, ...rest);
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/__proxy-sw.js', { scope: '/' }).catch(function(){});
    });
  }
})();
</script>`;

function rewriteUrls(chunk) {
  let r = chunk;
  r = r.replaceAll('"' + TARGET_ORIGIN + '/', '"/');
  r = r.replaceAll("'" + TARGET_ORIGIN + '/', "'/");
  r = r.replaceAll('"//' + TARGET_HOST + '/', '"/');
  r = r.replaceAll("'//" + TARGET_HOST + '/', "'/");
  return r;
}

const STRIP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options', 'strict-transport-security',
  'content-encoding', 'content-length', 'transfer-encoding',
]);

function createHtmlTransformStream() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let headInjected = false;
  let bodyInjected = false;
  let tailBuffer = '';

  const cssToInject = uboCosmeticCSS || `<style id="proxy-cosmetic-fallback">.ad-banner,.ad-container { display: none !important; }</style>`;

  return new TransformStream({
    transform(chunk, controller) {
      const raw = tailBuffer + decoder.decode(chunk, { stream: true });
      tailBuffer = '';
      let text = raw;

      if (!headInjected) {
        const idx = text.search(/<\/head\s*>/i);
        if (idx !== -1) {
          text = text.slice(0, idx) + cssToInject + text.slice(idx);
          headInjected = true;
        }
      }
      if (!bodyInjected) {
        const idx = text.search(/<\/body\s*>/i);
        if (idx !== -1) {
          text = text.slice(0, idx) + SCRIPTLET_JS + text.slice(idx);
          bodyInjected = true;
        }
      }

      text = rewriteUrls(text);

      if (text.length > 32) {
        tailBuffer = text.slice(-32);
        text = text.slice(0, -32);
      } else {
        tailBuffer = text;
        text = '';
      }
      if (text.length > 0) controller.enqueue(encoder.encode(text));
    },
    flush(controller) {
      if (tailBuffer.length > 0) {
        let text = tailBuffer;
        if (!headInjected) {
          const idx = text.search(/<\/head\s*>/i);
          if (idx !== -1) text = text.slice(0, idx) + cssToInject + text.slice(idx);
        }
        if (!bodyInjected) {
          const idx = text.search(/<\/body\s*>/i);
          if (idx !== -1) text = text.slice(0, idx) + SCRIPTLET_JS + text.slice(idx);
        }
        text = rewriteUrls(text);
        controller.enqueue(encoder.encode(text));
      }
    },
  });
}

export default async function handler(request) {
  try {
    await loadFilterLists();

    const url = new URL(request.url);

    if (url.pathname === '/__proxy-sw.js') {
      if (!cachedSwCode) {
        const swBlocklist = JSON.stringify(Array.from(uboDomains));
        const swPatterns = JSON.stringify(BLOCKED_PATH_PATTERNS.map(p => p.source));

        cachedSwCode = `
          const BLOCKED_DOMAINS = new Set(${swBlocklist});
          const patterns = ${swPatterns}.map(p => new RegExp(p, 'i'));

          function checkBlock(urlStr) {
            try {
              const u = new URL(urlStr);
              const parts = u.hostname.toLowerCase().split('.');
              for (let i = 0; i < parts.length - 1; i++) {
                if (BLOCKED_DOMAINS.has(parts.slice(i).join('.'))) return true;
              }
              const pathQuery = u.pathname + u.search;
              for (const reg of patterns) {
                if (reg.test(pathQuery)) return true;
              }
            } catch(e) {}
            return false;
          }

          self.addEventListener('install', event => self.skipWaiting());
          self.addEventListener('activate', event => event.waitUntil(clients.claim()));

          self.addEventListener('fetch', event => {
            if (checkBlock(event.request.url)) {
              event.respondWith(new Response(null, { status: 204 }));
            }
          });
        `;
      }

      return new Response(cachedSwCode, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    const upstreamUrl = new URL(url.pathname + url.search, TARGET_ORIGIN);

    if (isBlocked(upstreamUrl.href)) {
      return new Response(null, { status: 204 });
    }

    const upH = new Headers();
    upH.set('host', TARGET_HOST);
    upH.set('accept-encoding', 'gzip');
    for (const h of ['user-agent', 'accept-language', 'cookie', 'accept', 'referer']) {
      const v = request.headers.get(h);
      if (v) upH.set(h, v);
    }
    if (upH.has('referer')) {
      try {
        const ref = new URL(upH.get('referer'));
        ref.host = TARGET_HOST;
        ref.protocol = new URL(TARGET_ORIGIN).protocol;
        upH.set('referer', ref.href);
      } catch { }
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl.href, {
        method: request.method,
        headers: upH,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'manual',
      });
    } catch (err) {
      return new Response('Proxy fetch error', { status: 502 });
    }

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const loc = upstream.headers.get('location');
      if (loc) {
        let newLoc = loc;
        try {
          const lu = new URL(loc, upstreamUrl.href);
          if (lu.host === TARGET_HOST) newLoc = lu.pathname + lu.search + lu.hash;
        } catch { }
        return new Response(null, { status: upstream.status, headers: { location: newLoc } });
      }
    }

    const rH = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) rH.set(k, v);
    }
    rH.set('access-control-allow-origin', '*');

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const isHtml = ct.includes('text/html');

    if (!isHtml || !upstream.body) {
      return new Response(upstream.body, { status: upstream.status, headers: rH });
    }

    const ts = createHtmlTransformStream();
    upstream.body.pipeThrough(ts);
    rH.delete('content-length');

    return new Response(ts.readable, { status: upstream.status, headers: rH });

  } catch (err) {
    return new Response('Proxy internal error', { status: 500 });
  }
}