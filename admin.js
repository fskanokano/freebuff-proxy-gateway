// freebuff-proxy-gateway 管理后台 (iOS 设计语言, 手机优先响应式单页)
// 导出 ADMIN_HTML 由 worker.js 注入。页面本身无敏感数据, 所有 /admin/api/* 需鉴权。
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#F2F2F7">
<title>Proxy Gateway</title>
<style>
:root{
  --bg:#F2F2F7; --card:#FFFFFF; --card2:#F8F8FA; --text:#000000; --text2:rgba(60,60,67,.62);
  --text3:rgba(60,60,67,.36); --sep:rgba(60,60,67,.14); --fill:rgba(120,120,128,.16);
  --blue:#007AFF; --green:#34C759; --orange:#FF9500; --red:#FF3B30; --purple:#AF52DE;
  --navbg:rgba(242,242,247,.82); --shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);
  --radius:14px; --radius-sm:10px; --tabbar-h:56px;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#000000; --card:#1C1C1E; --card2:#2C2C2E; --text:#FFFFFF; --text2:rgba(235,235,245,.6);
    --text3:rgba(235,235,245,.32); --sep:rgba(84,84,88,.5); --fill:rgba(120,120,128,.28);
    --blue:#0A84FF; --green:#30D158; --orange:#FF9F0A; --red:#FF453A; --purple:#BF5AF2;
    --navbg:rgba(28,28,30,.78); --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.4); }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;height:100%}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue","PingFang SC","Segoe UI",sans-serif;
  font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased;overscroll-behavior-y:contain}
body.theme-dark{--bg:#000000;--card:#1C1C1E;--card2:#2C2C2E;--text:#FFFFFF;--text2:rgba(235,235,245,.6);
  --text3:rgba(235,235,245,.32);--sep:rgba(84,84,88,.5);--fill:rgba(120,120,128,.28);
  --blue:#0A84FF;--green:#30D158;--orange:#FF9F0A;--red:#FF453A;--purple:#BF5AF2;--navbg:rgba(28,28,30,.78)}
body.theme-light{--bg:#F2F2F7;--card:#FFFFFF;--card2:#F8F8FA;--text:#000000;--text2:rgba(60,60,67,.62);
  --text3:rgba(60,60,67,.36);--sep:rgba(60,60,67,.14);--fill:rgba(120,120,128,.16);
  --blue:#007AFF;--green:#34C759;--orange:#FF9500;--red:#FF3B30;--purple:#AF52DE;--navbg:rgba(242,242,247,.82)}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit;font-size:inherit}
.app{display:flex;flex-direction:column;height:100dvh;max-width:860px;margin:0 auto}
/* ── 导航栏 (毛玻璃) ── */
.nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;
  padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;background:var(--navbg);
  -webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:0.5px solid var(--sep)}
.nav-title{font-size:19px;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.nav-dot{width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block}
.nav-dot.degraded{background:var(--orange)} .nav-dot.down{background:var(--red)}
.nav-actions{display:flex;gap:6px}
.icon-btn{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:var(--fill);color:var(--blue);font-size:17px;font-weight:600}
.icon-btn:active{opacity:.6}
/* ── 布局: 桌面侧边栏 / 手机底部 tab ── */
.layout{flex:1;display:flex;overflow:hidden}
.sidebar{display:none;width:220px;flex-shrink:0;padding:16px 10px;border-right:0.5px solid var(--sep);overflow-y:auto}
.side-item{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:var(--radius-sm);
  color:var(--text2);font-weight:500;margin-bottom:2px;width:100%;text-align:left}
.side-item.active{background:var(--fill);color:var(--blue)}
.side-item svg{flex-shrink:0}
.content{flex:1;overflow-y:auto;padding:14px 14px calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 20px);
  -webkit-overflow-scrolling:touch}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;justify-content:space-around;
  background:var(--navbg);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);
  border-top:0.5px solid var(--sep);padding-bottom:env(safe-area-inset-bottom);margin:0 auto;max-width:860px}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 0 5px;color:var(--text3);font-size:10px;font-weight:500}
.tab.active{color:var(--blue)}
.tab svg{width:24px;height:24px}
@media (min-width:768px){
  .sidebar{display:block} .tabbar{display:none}
  .content{padding:20px 24px 40px}
}
.view{display:none} .view.active{display:block;animation:fade .18s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
/* ── 卡片 ── */
.card{background:var(--card);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:14px;overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px}
.card-title{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text2)}
.card-body{padding:2px 16px 16px}
.cell{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;min-height:44px;border-top:0.5px solid var(--sep)}
.cell:first-child{border-top:none}
.cell-label{color:var(--text2);font-size:15px}
.cell-value{font-size:15px;font-weight:600;text-align:right;word-break:break-all}
/* ── 状态 pill ── */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.pill.ok{background:rgba(52,199,89,.14);color:var(--green)}
.pill.depleted{background:rgba(255,149,0,.16);color:var(--orange)}
.pill.down{background:rgba(255,59,48,.14);color:var(--red)}
.pill.unknown{background:var(--fill);color:var(--text2)}
.pill.bad_config{background:rgba(175,82,222,.15);color:var(--purple)}
.pill.maint{background:rgba(175,82,222,.15);color:var(--purple)}
.pill.pinned{background:rgba(0,122,255,.14);color:var(--blue)}
/* ── 常驻代理信息条 ── */
.pin-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--card);
  border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 16px;margin-bottom:14px}
.pin-banner .pin-name{font-weight:700;color:var(--blue)}
.pin-banner .pin-sub{font-size:12px;color:var(--text3);margin-top:2px}
.pin-banner .pin-clear{background:var(--fill);color:var(--blue);border-radius:var(--radius-sm);padding:7px 14px;font-size:13px;font-weight:600;min-height:36px}
.proxy.pinned{box-shadow:0 0 0 2px rgba(0,122,255,.35),var(--shadow)}
/* ── proxy 卡片 ── */
.proxy{background:var(--card);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:12px;overflow:hidden}
.proxy-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px 0}
.proxy-name{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;word-break:break-all}
.proxy-url{font-size:12px;color:var(--text3);margin-top:2px;word-break:break-all}
.proxy-actions{display:flex;gap:8px;align-items:center}
.bar{height:6px;border-radius:3px;background:var(--fill);overflow:hidden;margin:10px 0 4px}
.bar > i{display:block;height:100%;border-radius:3px;background:var(--blue);transition:width .4s ease}
.bar.warn > i{background:var(--orange)} .bar.crit > i{background:var(--red)}
.bar-row{display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-bottom:8px}
.proxy-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;padding:8px 0}
.proxy-grid .cell{border:none;padding:6px 0;min-height:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
/* ── 统计卡 ── */
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
@media(min-width:768px){.stats{grid-template-columns:repeat(4,1fr)}}
.stat{background:var(--card);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.stat-num{font-size:26px;font-weight:700;letter-spacing:-.02em}
.stat-num.ok{color:var(--green)} .stat-num.depleted{color:var(--orange)}
.stat-num.down{color:var(--red)} .stat-num.blue{color:var(--blue)}
.stat-label{font-size:12px;color:var(--text2);margin-top:2px}
/* ── iOS switch ── */
.switch{position:relative;width:51px;height:31px;border-radius:16px;background:var(--fill);transition:background .2s;flex-shrink:0}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s}
.switch.on{background:var(--green)} .switch.on::after{transform:translateX(20px)}
/* ── 事件 ── */
.event{display:flex;gap:12px;padding:11px 16px;border-top:0.5px solid var(--sep);align-items:flex-start}
.event:first-child{border-top:none}
.event-ico{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px}
.event-ico.status_change{background:rgba(0,122,255,.14)} .event-ico.failover{background:rgba(255,149,0,.16)}
.event-ico.probe_failed{background:rgba(255,59,48,.14)} .event-ico.maintenance{background:rgba(175,82,222,.15)}
.event-ico.admin_action{background:rgba(120,120,128,.18)} .event-ico.smoke{background:rgba(52,199,89,.14)}
.event-main{flex:1;min-width:0}
.event-title{font-size:14px;font-weight:600}
.event-desc{font-size:12px;color:var(--text2);word-break:break-all;margin-top:1px}
.event-time{font-size:11px;color:var(--text3);margin-top:2px}
.empty{padding:32px 16px;text-align:center;color:var(--text3);font-size:14px}
/* ── 表单 ── */
.field{margin-bottom:12px}
.field label{display:block;font-size:13px;color:var(--text2);margin-bottom:6px;font-weight:500}
.input{width:100%;padding:12px 14px;border-radius:var(--radius-sm);background:var(--card2);color:var(--text);
  border:none;font-size:16px;font-family:inherit;-webkit-appearance:none;appearance:none;outline:none}
.input:focus{box-shadow:0 0 0 3px rgba(0,122,255,.25)}
textarea.input{resize:vertical;min-height:70px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:11px 18px;border-radius:var(--radius-sm);
  background:var(--blue);color:#fff;font-size:16px;font-weight:600;min-height:44px;width:100%}
.btn:active{opacity:.8}
.btn:disabled{opacity:.4}
.btn.secondary{background:var(--fill);color:var(--blue)}
.btn.danger{background:rgba(255,59,48,.14);color:var(--red)}
.seg{display:flex;background:var(--fill);border-radius:var(--radius-sm);padding:2px;margin-bottom:14px}
.seg button{flex:1;padding:7px 0;border-radius:8px;color:var(--text2);font-weight:600;font-size:13px;min-height:32px}
.seg button.active{background:var(--card);color:var(--blue);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.result{background:var(--card2);border-radius:var(--radius-sm);padding:12px;font-size:12px;word-break:break-all;white-space:pre-wrap;margin-top:12px;max-height:280px;overflow-y:auto}
.result .ok{color:var(--green);font-weight:700} .result .bad{color:var(--red);font-weight:700}
/* ── 登录 ── */
.login{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;padding:24px;
  background:rgba(0,0,0,.35);-webkit-backdrop-filter:saturate(180%) blur(12px);backdrop-filter:saturate(180%) blur(12px)}
.login.show{display:flex}
.login-card{width:100%;max-width:340px;background:var(--card);border-radius:20px;padding:24px;box-shadow:var(--shadow)}
.login-card h2{margin:0 0 6px;font-size:20px;text-align:center}
.login-card p{margin:0 0 18px;font-size:13px;color:var(--text2);text-align:center}
.login-err{color:var(--red);font-size:13px;text-align:center;margin-top:10px;min-height:18px}
/* ── toast ── */
.toast{position:fixed;left:50%;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 24px);transform:translateX(-50%) translateY(20px);
  background:rgba(28,28,30,.92);color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:500;
  opacity:0;pointer-events:none;transition:all .25s ease;z-index:60;max-width:88vw;text-align:center}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(min-width:768px){.toast{bottom:40px}}
h2.section{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:2px 0 14px}
.sub{font-size:13px;color:var(--text2);margin:-10px 0 14px}
.spin{display:inline-block;animation:rot 1s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="app">
  <header class="nav">
    <div class="nav-title"><span class="nav-dot" id="navDot"></span>Proxy Gateway</div>
    <div class="nav-actions">
      <button class="icon-btn" id="btnRefresh" title="刷新">&#x21bb;</button>
      <button class="icon-btn" id="btnTheme" title="外观">&#9681;</button>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar" id="sidebar"></aside>
    <main class="content" id="content">
      <section class="view" id="view-overview"></section>
      <section class="view" id="view-proxies"></section>
      <section class="view" id="view-events"></section>
      <section class="view" id="view-test"></section>
      <section class="view" id="view-settings"></section>
    </main>
  </div>
  <nav class="tabbar" id="tabbar"></nav>
</div>
<div class="login" id="login">
  <div class="login-card">
    <h2>Proxy Gateway</h2>
    <p>请输入网关 API_KEY 以进入管理后台</p>
    <input class="input" id="loginKey" type="password" placeholder="API_KEY" autocomplete="off">
    <div style="margin-top:14px"><button class="btn" id="loginBtn">登录</button></div>
    <div class="login-err" id="loginErr"></div>
  </div>
</div>
<div class="login" id="proxyModal">
  <div class="login-card">
    <h2 id="pmTitle">添加代理</h2>
    <p>保存后立即生效 (跨边缘传播可能延迟几秒)</p>
    <div class="field"><label>名称 (可选)</label><input class="input" id="pmName" placeholder="如 proxy-d (留空自动生成)"></div>
    <div class="field"><label>URL *</label><input class="input" id="pmUrl" placeholder="https://xxx.workers.dev"></div>
    <div class="field"><label>API Key * (网关调用该代理的 key)</label><input class="input" id="pmKey" placeholder="该代理 API_KEYS 中配置的 key"></div>
    <div style="margin-top:14px"><button class="btn" id="pmSave">保存</button></div>
    <div style="margin-top:8px"><button class="btn secondary" id="pmCancel">取消</button></div>
    <div class="login-err" id="pmErr"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
"use strict";
var state={key:localStorage.getItem("gwkey")||"",view:localStorage.getItem("gwview")||"overview",theme:localStorage.getItem("gwtheme")||"auto",timer:null};
var ICONS={
  overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  proxies:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 10 10M2 12a10 10 0 0 1 10-10M12 22a10 10 0 0 1-10-10M22 12a10 10 0 0 1-10 10"/></svg>',
  events:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h12"/></svg>',
  test:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v4l5 9a3 3 0 0 1-2.6 4H6.6A3 3 0 0 1 4 16l5-9V3z"/><path d="M9 21v-5"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>'
};
var TABS=[["overview","总览"],["proxies","代理"],["events","日志"],["test","测试"],["settings","设置"]];
var LABELS={ok:"正常",depleted:"额度耗尽",down:"不可用",unknown:"未知",bad_config:"配置错误",maint:"维护中"};
function $(s){return document.querySelector(s)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function toast(msg){var t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("show")},2200)}
function fmtTime(ms){if(!ms)return "-";var d=new Date(ms),p=function(n){return(n<10?"0":"")+n};return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())}
function fmtAgo(ms){if(!ms)return "-";var s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<5)return "刚刚";if(s<60)return s+"s 前";var m=Math.round(s/60);if(m<60)return m+"m 前";return Math.round(m/60)+"h 前"}
function pill(st,maint){return maint?'<span class="pill maint">维护中</span>':'<span class="pill '+st+'">'+(LABELS[st]||st)+"</span>"}
/* ── API ── */
function api(path,opts){
  opts=opts||{};
  var h={"Content-Type":"application/json"};
  if(state.key)h["Authorization"]="Bearer "+state.key;
  if(opts.headers)for(var k in opts.headers)h[k]=opts.headers[k];
  return fetch("/admin/api"+path,{method:opts.method||"GET",headers:h,body:opts.body}).then(function(res){
    if(res.status===401){showLogin("密钥无效或已失效");throw new Error("unauthorized")}
    return res.json().catch(function(){return{}}).then(function(j){
      if(!res.ok)throw new Error((j.error&&j.error.message)||("HTTP "+res.status));
      return j;
    });
  });
}
/* ── 视图切换 ── */
function switchView(v){
  state.view=v;
  localStorage.setItem("gwview",v); // 刷新后停留在当前界面
  document.querySelectorAll(".view").forEach(function(el){el.classList.toggle("active",el.id==="view-"+v)});
  document.querySelectorAll(".side-item").forEach(function(el){el.classList.toggle("active",el.dataset.view===v)});
  document.querySelectorAll(".tab").forEach(function(el){el.classList.toggle("active",el.dataset.view===v)});
  refresh();
}
// 首次加载: 让当前 view 可见 (HTML 里所有 .view 默认 display:none, 不设 active 会整页空白)
function showInitialView(){
  var el=document.getElementById("view-"+state.view);
  if(el)el.classList.add("active");
  document.querySelectorAll(".side-item").forEach(function(el){el.classList.toggle("active",el.dataset.view===state.view)});
  document.querySelectorAll(".tab").forEach(function(el){el.classList.toggle("active",el.dataset.view===state.view)});
}
function buildNav(){
  var sb=$("#sidebar"),tb=$("#tabbar");sb.innerHTML="";tb.innerHTML="";
  TABS.forEach(function(t){
    var a=document.createElement("button");a.className="side-item"+(t[0]===state.view?" active":"");a.dataset.view=t[0];
    a.innerHTML=ICONS[t[0]]+'<span>'+t[1]+"</span>";a.onclick=function(){switchView(t[0])};sb.appendChild(a);
    var b=document.createElement("button");b.className="tab"+(t[0]===state.view?" active":"");b.dataset.view=t[0];
    b.innerHTML=ICONS[t[0]]+"<span>"+t[1]+"</span>";b.onclick=function(){switchView(t[0])};tb.appendChild(b);
  });
}
/* ── 渲染: 总览 ── */
function renderOverview(d){
  var s=d.stats,p=d.proxies;
  var el=$("#view-overview");
  var stat=function(num,label,cls){return '<div class="stat"><div class="stat-num '+cls+'">'+num+'</div><div class="stat-label">'+label+"</div></div>"};
  el.innerHTML=
    '<h2 class="section">总览</h2>'+
    '<div class="stats">'+stat(s.total,"Proxy 总数","blue")+stat(s.ok,"正常","ok")+stat(s.depleted,"额度耗尽","depleted")+stat(s.down,"不可用","down")+"</div>"+
    '<div class="card"><div class="card-head"><div class="card-title">流量</div></div><div class="card-body">'+
      '<div class="cell"><div class="cell-label">成功请求</div><div class="cell-value">'+esc(s.requestsOk)+"</div></div>"+
      '<div class="cell"><div class="cell-label">失败请求</div><div class="cell-value">'+esc(s.requestsFail)+"</div></div>"+
    "</div></div>"+
    '<div class="card"><div class="card-head"><div class="card-title">代理健康度</div></div><div class="card-body" id="ovList"></div></div>';
  var list=$("#ovList");list.innerHTML="";
  p.forEach(function(pr){
    var row=document.createElement("div");row.className="cell";
    var barCls=pr.score>=90?"crit":(pr.score>=70?"warn":"");
    row.innerHTML='<div><div style="font-weight:600;display:flex;align-items:center;gap:8px">'+esc(pr.name)+" "+pill(pr.status,pr.maint)+'</div>'+
      '<div style="font-size:12px;color:var(--text3);margin-top:2px;word-break:break-all">'+esc(pr.url)+"</div>"+
      '<div class="bar '+barCls+'" style="margin-top:8px"><i style="width:'+Math.round(pr.score)+'%"></i></div>'+
      '<div class="bar-row"><span>用量 '+Math.round(pr.score)+"%</span><span>"+(pr.requestsOk||0)+" 成功 / "+(pr.requestsFail||0)+" 失败</span></div>"+
    "</div>";
    row.onclick=function(){switchView("proxies")};
    list.appendChild(row);
  });
}
/* ── 渲染: 代理 ── */
function proxyCard(pr){
  var barCls=pr.score>=90?"crit":(pr.score>=70?"warn":"");
  var quotaHtml="";
  if(pr.quota&&Object.keys(pr.quota).length){
    quotaHtml='<div class="card-head" style="padding-bottom:4px"><div class="card-title">模型额度</div></div><div class="card-body" style="padding-top:0">';
    for(var m in pr.quota){var q=pr.quota[m];
      var used=q.limit>0?Math.min(100,Math.round(q.recent_count/q.limit*100)):0;
      quotaHtml+='<div style="padding:6px 0"><div style="display:flex;justify-content:space-between;font-size:13px">'+
        '<span style="font-weight:600">'+esc(m)+'</span><span style="color:var(--text2)">'+(q.limit?used+"%":"—")+'</span></div>'+
        '<div class="bar '+(used>=90?"crit":used>=70?"warn":"")+'"><i style="width:'+used+'%"></i></div>'+
        '<div style="font-size:11px;color:var(--text3)">'+esc(q.recent_count||0)+" / "+esc(q.limit||0)+" · 重置 "+(q.reset_at?esc(fmtTime(Date.parse(q.reset_at))):"—")+"</div></div>";
    }
    quotaHtml+="</div>";
  }
  return '<div class="proxy" data-name="'+esc(pr.name)+'">'+
    '<div class="proxy-head"><div><div class="proxy-name">'+esc(pr.name)+" "+pill(pr.status,pr.maint)+"</div>"+
    '<div class="proxy-url">'+esc(pr.url)+"</div></div>"+
    '<div class="proxy-actions"><button class="icon-btn p-probe" title="立即探测" style="font-size:15px">&#x21bb;</button>'+
    // 开关语义 = 是否启用: 正常(非维护)=开, 维护=关
    '<div class="switch'+(pr.maint?"":" on")+'" data-maint="1" title="代理启用开关 (关 = 进入维护)"></div>'+
    '<button class="icon-btn p-edit" title="编辑代理" style="font-size:14px">&#x270e;</button>'+
    '<button class="icon-btn p-del" title="删除代理" style="font-size:14px;color:var(--red)">&#x2715;</button>'+
    '</div></div>'+
    '<div class="card-body">'+
    '<div class="bar '+barCls+'"><i style="width:'+Math.round(pr.score)+'%"></i></div>'+
    '<div class="bar-row"><span>估算用量 '+Math.round(pr.score)+"%</span><span>余量 "+(100-Math.round(pr.score))+"%</span></div>"+
    '<div class="proxy-grid">'+
    '<div class="cell"><div class="cell-label">详情</div><div class="cell-value" style="font-size:12px">'+esc(pr.detail||"—")+"</div></div>"+
    '<div class="cell"><div class="cell-label">上次探测</div><div class="cell-value" style="font-size:12px">'+esc(fmtAgo(Date.parse(pr.last_ok||0)))+"</div></div>"+
    '<div class="cell"><div class="cell-label">下次探测</div><div class="cell-value" style="font-size:12px">'+esc(pr.next_probe?fmtAgo(Date.parse(pr.next_probe)):"—")+"</div></div>"+
    '<div class="cell"><div class="cell-label">重置时刻</div><div class="cell-value" style="font-size:12px">'+esc(pr.reset_at?fmtTime(Date.parse(pr.reset_at)):"—")+"</div></div>"+
    '<div class="cell"><div class="cell-label">连续错误</div><div class="cell-value" style="font-size:12px">'+esc(pr.consecutive_errors||0)+"</div></div>"+
    '<div class="cell"><div class="cell-label">风险</div><div class="cell-value" style="font-size:12px">'+esc(pr.risk||"—")+"</div></div>"+
    "</div></div>"+quotaHtml+"</div>";
}
function renderProxies(d){
  var el=$("#view-proxies");
  el.innerHTML='<h2 class="section">代理</h2>'+
    '<div class="sub">开关 = 代理启用状态 (关 = 进入维护, 不参与选路); 支持添加/编辑/删除代理</div>'+
    '<div id="pinBanner"></div>'+
    '<div style="margin-bottom:14px"><button class="btn" id="addProxyBtn" style="min-height:40px">＋ 添加代理</button></div>';
  if(!d.proxies.length)el.insertAdjacentHTML("beforeend",'<div class="card"><div class="empty">未配置任何代理</div></div>');
  d.proxies.forEach(function(pr){el.insertAdjacentHTML("beforeend",proxyCard(pr))});
  // 加载完整配置 (含 apiKey) 供编辑
  api("/config").then(function(cd){
    _cfgProxies=(cd.config&&cd.config.proxies||[]).slice();
  }).catch(function(){});
  // 当前常驻代理 (sticky pin) 状态
  api("/pin").then(function(pd){
    renderPinBanner(pd);
    if(pd&&pd.pinned_proxy){
      var card=el.querySelector('.proxy[data-name="'+pd.pinned_proxy+'"]');
      if(card){
        card.classList.add("pinned");
        card.querySelector(".proxy-name").insertAdjacentHTML("beforeend",' <span class="pill pinned">常驻</span>');
      }
    }
  }).catch(function(){});
  // 直接为每个卡片绑定事件 (比事件委托更可靠, 避免代理名/嵌套导致 closest 失效)
  el.querySelectorAll(".proxy").forEach(function(card){
    var name=card.dataset.name;
    card.querySelector(".p-probe").onclick=function(e){
      e.preventDefault();e.stopPropagation();
      toast("正在探测 "+name+" …");
      api("/probe",{method:"POST",body:JSON.stringify({name:name})}).then(function(){
        toast("探测完成");refresh();
      }).catch(function(e){toast("探测失败: "+e.message)});
    };
    var sw=card.querySelector(".switch");
    sw.onclick=function(e){
      e.preventDefault();e.stopPropagation();
      // 开关开着(=启用中) → 点击进入维护; 开关关着(=维护中) → 点击恢复
      var enterMaint=sw.classList.contains("on");
      sw.style.pointerEvents="none"; // 防连点
      sw.classList.toggle("on",!enterMaint); // 乐观切换
      state.skipProxyRefreshUntil=Date.now()+4000; // 4s 内轮询不重绘代理页
      api("/maintenance",{method:"POST",body:JSON.stringify({name:name,on:enterMaint})}).then(function(){
        toast(enterMaint?"已进入维护模式 (代理暂停)":"已恢复 (代理启用)");
        setTimeout(function(){state.skipProxyRefreshUntil=0;refresh()},1200);
      }).catch(function(e){
        sw.classList.toggle("on",enterMaint); // 失败回滚
        state.skipProxyRefreshUntil=0;
        toast("设置失败: "+e.message);
      }).finally(function(){sw.style.pointerEvents=""});
    };
    card.querySelector(".p-edit").onclick=function(e){
      e.preventDefault();e.stopPropagation();
      var p=_cfgProxies.find(function(x){return x.name===name})||{name:name,url:card.querySelector(".proxy-url").innerText,apiKey:""};
      _pmEditingName=p.name;
      openProxyModal(p);
    };
    card.querySelector(".p-del").onclick=function(e){
      e.preventDefault();e.stopPropagation();
      if(!confirm("确定删除代理 "+name+" ?"))return;
      var list=_cfgProxies.filter(function(x){return x.name!==name});
      saveProxies(list,"代理已删除");
    };
  });
  $("#addProxyBtn").onclick=function(){openProxyModal(null)};
}
// 常驻/最近路由信息条: 优先显示当前会话钉住 (常驻) 的代理, 否则显示最近实际路由到的代理
function renderPinBanner(pd){
  var el=$("#pinBanner");if(!el)return;
  var recent=pd&&pd.recent_proxies&&pd.recent_proxies.length?pd.recent_proxies[0]:null;
  var modeTxt=pd?pd.pin_mode:"-";
  if(pd&&pd.pinned_proxy){
    el.innerHTML='<div class="pin-banner"><div><div>当前常驻代理: <span class="pin-name">'+esc(pd.pinned_proxy)+'</span></div>'+
      '<div class="pin-sub">本会话请求持续路由到该代理, 直到其额度耗尽后自动切换 · 键: '+esc(pd.sticky_key||"-")+'</div></div>'+
      '<button class="pin-clear" id="pinClearBtn">解除常驻</button></div>';
    $("#pinClearBtn").onclick=function(){
      if(!confirm("解除当前会话的常驻代理? 下次请求将按余量重新选路"))return;
      var key=(pd.sticky_key||"").replace(/^[ch]:/,"");
      api("/pin",{method:"POST",body:JSON.stringify({key:key})}).then(function(){toast("已解除常驻");refresh()}).catch(function(e){toast("解除失败: "+e.message)});
    };
    return;
  }
  if(recent&&recent.lastUsed>0){
    el.innerHTML='<div class="pin-banner"><div><div>最近路由到: <span class="pin-name">'+esc(recent.name)+'</span> <span style="font-size:12px;color:var(--text3)">('+esc(fmtAgo(recent.lastUsed))+' · 累计 '+esc(recent.requestsOk)+' 次)</span></div>'+
      '<div class="pin-sub">当前管理会话未钉住 (用与客户端相同的 API_KEY 登录即可看到对应常驻) · PIN_MODE='+esc(modeTxt)+' · 请求成功会自动钉住所选代理</div></div></div>';
    return;
  }
  el.innerHTML='<div class="pin-banner"><div><div>当前会话 <b>未常驻</b>, 暂无路由记录</div>'+
    '<div class="pin-sub">PIN_MODE='+esc(modeTxt)+' · 客户端发起成功请求后会自动钉住所选代理</div></div></div>';
}
/* ── 渲染: 日志 ── */
function renderEvents(d){
  var el=$("#view-events");
  el.innerHTML='<h2 class="section">运行日志</h2><div class="sub">状态变更 / 故障切换 / 探测失败 / 管理操作 (最多 '+200+" 条)</div>";
  if(!d.events.length){el.insertAdjacentHTML("beforeend",'<div class="card"><div class="empty">暂无事件</div></div>');return}
  var icons={status_change:"●",failover:"⇄",probe_failed:"!",maintenance:"◐",admin_action:"⚙",smoke:"✓"};
  var box=document.createElement("div");box.className="card";
  d.events.slice().reverse().forEach(function(ev){
    var e=document.createElement("div");e.className="event";
    var desc=ev.name?esc(ev.name)+" ":"";if(ev.from&&ev.to)desc+="("+esc(ev.from)+" → "+esc(ev.to)+")";
    if(ev.code)desc+=" · "+esc(ev.code);if(ev.err)desc+=" · "+esc(ev.err);if(ev.detail)desc+=" · "+esc(ev.detail);
    e.innerHTML='<div class="event-ico '+(icons[ev.type]?"":ev.type)+'">'+(icons[ev.type]||"·")+"</div>"+
      '<div class="event-main"><div class="event-title">'+esc(ev.type)+'</div><div class="event-desc">'+desc+"</div>"+
      '<div class="event-time">'+esc(fmtTime(ev.t))+" · "+esc(fmtAgo(ev.t))+"</div></div>";
    box.appendChild(e);
  });
  el.appendChild(box);
}
/* ── 渲染: 测试 ── */
var _tModels=[]; // 模型下拉缓存
function renderTest(){
  var el=$("#view-test");
  el.innerHTML='<h2 class="section">测试请求</h2><div class="sub">发一条真实请求走完整路由链路</div>'+
  '<div class="card"><div class="card-body">'+
  '<div class="field"><label>Model</label><select class="input" id="tModel"><option value="">加载中…</option></select></div>'+
  '<div class="field"><label>Prompt</label><textarea class="input" id="tPrompt">ping</textarea></div>'+
  '<div class="seg"><button data-s="0" class="active">非流式</button><button data-s="1">流式</button></div>'+
  '<button class="btn" id="tGo">发送请求</button>'+
  '<div class="result" id="tResult" style="display:none"></div>'+
  "</div></div>";
  // 模型下拉: 优先 /admin/api/models (聚合各代理), 回退 overview 里的模型额度, 最后允许手动输入
  var sel=$("#tModel");
  var opts={};
  api("/models").then(function(j){
    (j.data||[]).forEach(function(m){opts[m.id]=1});
  }).catch(function(){}).then(function(){
    return api("/overview").then(function(d){
      (d.proxies||[]).forEach(function(p){for(var m in (p.quota||{}))opts[m]=1});
    }).catch(function(){});
  }).then(function(){
    var ids=Object.keys(opts);
    _tModels=ids;
    if(!ids.length){sel.innerHTML='<option value="">自定义 (输入)</option>';}
    else{
      var html='';ids.sort().forEach(function(id){html+='<option value="'+esc(id)+'">'+esc(id)+"</option>"});
      html+='<option value="__custom__">自定义…</option>';
      sel.innerHTML=html;
      sel.value=ids.indexOf("freebuff-1")>=0?"freebuff-1":ids[0];
    }
    // 选择"自定义…"时切换为输入框
    sel.onchange=function(){if(sel.value==="__custom__"){toCustomModel(sel)} };
  });
  el.querySelectorAll(".seg button").forEach(function(b){
    b.onclick=function(){el.querySelectorAll(".seg button").forEach(function(x){x.classList.remove("active")});b.classList.add("active")};
  });
  $("#tGo").onclick=function(){
    var btn=$("#tGo"),stream=el.querySelector(".seg button.active").dataset.s==="1";
    var model=$("#tModel").value.trim();
    if(model==="__custom__"||model==="")model="freebuff-1";
    btn.disabled=true;btn.textContent="发送中…";
    var res=$("#tResult");res.style.display="block";res.className="result";res.textContent="请求中…";
    api("/smoke",{method:"POST",body:JSON.stringify({model:model,prompt:$("#tPrompt").value,stream:stream})}).then(function(j){
      var head='HTTP '+j.status+(j.ok?' <span class="ok">成功</span>':' <span class="bad">失败</span>')+
        " · 路由到: "+esc(j.proxy||"—")+" · 尝试 "+esc(j.attempts||1)+" 次 · "+esc(j.ms)+"ms";
      var bodyText="";
      if(j.content)bodyText='<div style="margin-top:10px;font-weight:600">回复内容:</div><div style="color:var(--text2);margin-top:4px">'+esc(j.content)+"</div>";
      if(j.error)bodyText+='<div style="margin-top:10px;font-weight:600">错误信息:</div><div style="color:var(--red);margin-top:4px">'+esc(j.error)+"</div>";
      res.innerHTML=head+bodyText;
    }).catch(function(e){res.className="result";res.textContent="请求失败: "+e.message}).finally(function(){btn.disabled=false;btn.textContent="发送请求"});
  };
}
function toCustomModel(sel){
  var wrap=sel.parentElement;
  var input=document.createElement("input");input.className="input";input.id="tModel";input.placeholder="输入模型名称";
  input.value="";
  wrap.replaceChild(input,sel);
  input.focus();
}
/* ── 渲染: 设置 (参数可编辑) ── */
function renderSettings(d){
  var el=$("#view-settings");
  var c=d.config||{};
  _cfgProxies=(c.proxies||[]).slice();
  var srcNote=c.has_runtime_config
    ? '配置来源: <b>后台运行时配置</b> (用户改动优先; 环境变量为初始值, 部署后仍以这里为准)'
    : '配置来源: <b>环境变量</b> (默认值内置于代码)';
  var authRows='';
  if(c.admin_uses_api_key){
    authRows='<div class="cell"><div class="cell-label">API_KEY / 管理后台鉴权</div><div class="cell-value mono" style="font-size:12px">'+esc(c.api_key_masked)+"</div></div>"+
      '<div class="cell"><div class="cell-label">注</div><div class="cell-value" style="font-size:12px;color:var(--text3)">ADMIN_KEY 未配置, 管理后台与客户端共用 API_KEY</div></div>';
  }else{
    authRows='<div class="cell"><div class="cell-label">API_KEY (客户端)</div><div class="cell-value mono" style="font-size:12px">'+esc(c.api_key_masked)+'</div></div>'+
      '<div class="cell"><div class="cell-label">ADMIN_KEY (管理后台)</div><div class="cell-value mono" style="font-size:12px">'+esc(c.admin_key_masked)+"</div></div>";
  }
  authRows+='<div class="cell"><div class="cell-label">GATEWAY_API_KEYS (下游)</div><div class="cell-value mono" style="font-size:12px">'+esc(c.proxy_keys_masked)+"</div></div>";
  var html='<h2 class="section">设置</h2><div class="sub">'+srcNote+'</div>'+
    '<div class="card"><div class="card-head"><div class="card-title">路由参数 (可修改, 保存后立即生效)</div></div><div class="card-body">'+
    '<div class="field"><label>PIN_MODE 钉住模式</label><select class="input" id="sPinMode">'+
      '<option value="client"'+(c.pin_mode==="client"?" selected":"")+'>client (按客户端 key)</option>'+
      '<option value="header"'+(c.pin_mode==="header"?" selected":"")+'>header (按 X-Sticky-Id)</option>'+
      '<option value="off"'+(c.pin_mode==="off"?" selected":"")+'>off (不钉住)</option></select></div>'+
    '<div class="field"><label>PIN_TTL 钉住有效期 (秒)</label><input class="input" id="sPinTtl" type="number" min="60" value="'+esc(c.pin_ttl)+'"></div>'+
    '<div class="field"><label>STATE_TTL 状态刷新 (秒, ≥60)</label><input class="input" id="sStateTtl" type="number" min="60" value="'+esc(c.state_ttl)+'"></div>'+
    '<div class="field"><label>DEPLETED_PROBE 耗尽探测退避 (秒, ≥60)</label><input class="input" id="sDepletedProbe" type="number" min="60" value="'+esc(c.depleted_probe)+'"></div>'+
    '<div class="field"><label>DOWN_PROBE 故障探测退避 (秒, ≥30)</label><input class="input" id="sDownProbe" type="number" min="30" value="'+esc(c.down_probe)+'"></div>'+
    '<div class="field"><label>PROBE_TIMEOUT 探测超时 (毫秒, ≥500)</label><input class="input" id="sProbeTimeout" type="number" min="500" value="'+esc(c.probe_timeout)+'"></div>'+
    '<div class="field"><label>MAX_ATTEMPTS 最大尝试次数 (1-6)</label><input class="input" id="sMaxAttempts" type="number" min="1" max="6" value="'+esc(c.max_attempts)+'"></div>'+
    '<div style="display:flex;gap:8px"><button class="btn" id="sSave" style="flex:1">保存参数</button>'+
    (c.has_runtime_config?'<button class="btn danger" id="sReset" style="flex:1">恢复环境变量</button>':'')+'</div>'+
    '</div></div>'+
    '<div class="card"><div class="card-head"><div class="card-title">鉴权 (密钥已脱敏)</div></div><div class="card-body">'+authRows+"</div></div>"+
    '<div class="card"><div class="card-head"><div class="card-title">当前代理列表 (编辑在「代理」页)</div></div><div class="card-body" id="sProxies"></div></div>'+
    '<div class="card"><div class="card-head"><div class="card-title">界面</div></div><div class="card-body">'+
    '<div class="cell"><div class="cell-label">外观</div><div class="cell-value" style="display:flex;gap:6px"><button class="btn secondary" style="width:auto;min-height:36px;padding:7px 14px;font-size:14px" id="themeBtn">浅色/深色切换</button><button class="btn secondary" style="width:auto;min-height:36px;padding:7px 14px;font-size:14px" id="themeAutoBtn">跟随系统</button></div></div>'+
    '<div class="cell"><div class="cell-label">清除已保存的密钥</div><div class="cell-value"><button class="btn danger" style="width:auto;min-height:36px;padding:7px 14px;font-size:14px" id="logoutBtn">退出登录</button></div></div>'+
    '</div></div>';
  el.innerHTML=html;
  // 代理列表 (只读展示, 编辑在代理页)
  var pl=$("#sProxies");pl.innerHTML="";
  _cfgProxies.forEach(function(p){
    var row=document.createElement("div");row.className="cell";
    row.innerHTML='<div style="min-width:0"><div style="font-weight:600">'+esc(p.name)+'</div><div style="font-size:12px;color:var(--text3);word-break:break-all">'+esc(p.url)+"</div></div>"+
      '<div class="cell-value mono" style="font-size:12px">'+esc(maskKey(p.apiKey))+"</div>";
    pl.appendChild(row);
  });
  // 保存参数
  $("#sSave").onclick=function(){
    var settings={
      pinMode:$("#sPinMode").value,
      pinTtl:parseInt($("#sPinTtl").value,10),
      stateTtl:parseInt($("#sStateTtl").value,10),
      depletedProbe:parseInt($("#sDepletedProbe").value,10),
      downProbe:parseInt($("#sDownProbe").value,10),
      probeTimeout:parseInt($("#sProbeTimeout").value,10),
      maxAttempts:parseInt($("#sMaxAttempts").value,10)
    };
    api("/config",{method:"POST",body:JSON.stringify({settings:settings})}).then(function(){
      toast("参数已保存");refresh();
    }).catch(function(e){toast("保存失败: "+e.message)});
  };
  if($("#sReset"))$("#sReset").onclick=function(){
    if(!confirm("清除后台运行时配置并恢复为环境变量? (后台改的代理也会还原)"))return;
    api("/config/reset",{method:"POST",body:"{}"}).then(function(){toast("已恢复环境变量");refresh()}).catch(function(e){toast(e.message)});
  };
  $("#themeBtn").onclick=function(){cycleTheme()};
  $("#themeAutoBtn").onclick=function(){state.theme="auto";applyTheme();localStorage.setItem("gwtheme","auto");toast("已跟随系统外观")};
  $("#logoutBtn").onclick=function(){state.key="";localStorage.removeItem("gwkey");showLogin("")};
}
/* ── 刷新 ── */
function renderCurrent(){
  if(!state.key)return;
  var cur=state.view;
  if(cur==="overview")api("/overview").then(renderOverview).catch(function(e){console.error("overview render failed",e)});
  if(cur==="proxies")api("/overview").then(renderProxies).catch(function(e){console.error("proxies render failed",e)});
  if(cur==="events")api("/overview").then(renderEvents).catch(function(e){console.error("events render failed",e)});
  if(cur==="test")renderTest();
  if(cur==="settings")api("/config").then(renderSettings).catch(function(e){console.error("settings render failed",e)});
}
function refresh(){renderCurrent()}
function noop(){}
function maskKey(k){if(!k)return"—";if(String(k).length<=6)return String(k)[0]+"***";var s=String(k);return s.slice(0,3)+"…"+s.slice(-3)}
/* ── 代理管理 (添加/编辑/删除) ── */
var _cfgProxies=[]; // 当前生效代理 (含 apiKey), 来自 /admin/api/config
function openProxyModal(p){
  $("#pmTitle").textContent=p?"编辑代理 "+p.name:"添加代理";
  $("#pmName").value=p?p.name:"";
  $("#pmUrl").value=p?p.url:"";
  $("#pmKey").value=p?p.apiKey:"";
  $("#pmErr").textContent="";
  $("#proxyModal").classList.add("show");
  setTimeout(function(){$("#pmUrl").focus()},100);
}
function closeProxyModal(){$("#proxyModal").classList.remove("show")}
function saveProxies(list,msg){
  api("/config",{method:"POST",body:JSON.stringify({proxies:list})}).then(function(){
    toast(msg||"已保存");_cfgProxies=list.slice();closeProxyModal();refresh();
  }).catch(function(e){toast("保存失败: "+e.message)});
}
function submitProxyForm(){
  var url=$("#pmUrl").value.trim(),key=$("#pmKey").value.trim(),name=$("#pmName").value.trim();
  if(!/^https?:\\/\\/[^/]+/.test(url)){$("#pmErr").textContent="URL 格式不对, 如 https://xxx.workers.dev";return}
  if(!key){$("#pmErr").textContent="请填写该代理的 API Key";return}
  var editing=_cfgProxies.find(function(x){return x.name===_pmEditingName});
  var list;
  if(editing){
    list=_cfgProxies.map(function(x){return x.name===_pmEditingName?{name:name,url:url,apiKey:key}:x});
  }else{
    list=_cfgProxies.concat([{name:name,url:url,apiKey:key}]);
  }
  saveProxies(list,"代理已保存");
}
var _pmEditingName=null;
function updateDot(d){
  var dot=$("#navDot");
  if(!d||!d.proxies)return;
  var down=d.stats.down>0,dep=d.stats.depleted>0;
  dot.className="nav-dot"+(down?" down":(dep?" degraded":""));
}
/* ── 登录 / 主题 ── */
function showLogin(msg){
  $("#login").classList.add("show");
  $("#loginErr").textContent=msg||"";
  setTimeout(function(){$("#loginKey").focus()},100);
}
function hideLogin(){$("#login").classList.remove("show")}
function applyTheme(){
  var dark=state.theme==="dark"||(state.theme==="auto"&&matchMedia("(prefers-color-scheme:dark)").matches);
  document.body.classList.toggle("theme-dark",dark);
  document.body.classList.toggle("theme-light",!dark);
}
// 主题切换: 基于当前视觉状态直接切换亮/暗 (一次点击直达, 不经过 auto 中间态)
function cycleTheme(){
  var dark=document.body.classList.contains("theme-dark");
  state.theme=dark?"light":"dark";
  applyTheme();
  localStorage.setItem("gwtheme",state.theme);
}
(function(){
  buildNav();applyTheme();
  // 首次加载: 显示当前 view (修整页空白), 有 key 则直接渲染
  showInitialView();
  $("#loginBtn").onclick=function(){
    var k=$("#loginKey").value.trim();
    if(!k){$("#loginErr").textContent="请输入密钥";return}
    state.key=k;
    api("/config").then(function(){
      localStorage.setItem("gwkey",k);hideLogin();toast("登录成功");renderCurrent();
    }).catch(function(e){state.key="";$("#loginErr").textContent=e.message});
  };
  $("#loginKey").addEventListener("keydown",function(e){if(e.key==="Enter")$("#loginBtn").click()});
  // 代理编辑模态框
  $("#pmSave").onclick=function(){submitProxyForm()};
  $("#pmCancel").onclick=function(){closeProxyModal()};
  $("#pmUrl").addEventListener("keydown",function(e){if(e.key==="Enter")submitProxyForm()});
  $("#btnRefresh").onclick=function(){refresh()};
  $("#btnTheme").onclick=function(){cycleTheme()};
  if(state.key){
    api("/overview").then(function(d){hideLogin();updateDot(d);renderCurrent()}).catch(function(){showLogin("")});
  }else showLogin("");
  // 自动轮询: 更新状态灯 + 刷新当前视图 (test/settings 由交互触发, 不强制轮询)
  state.timer=setInterval(function(){
    if(!state.key||$("#login").classList.contains("show"))return;
    // 维护开关操作后短暂暂停代理页重绘, 避免旧数据把刚切换的开关弹回去
    if(state.view==="proxies"&&state.skipProxyRefreshUntil&&Date.now()<state.skipProxyRefreshUntil)return;
    api("/overview").then(function(d){
      updateDot(d);
      if(state.view==="overview")renderOverview(d);
      else if(state.view==="proxies")renderProxies(d);
      else if(state.view==="events")renderEvents(d);
    }).catch(noop);
  },5000);
})();
</script>
</body>
</html>`;
