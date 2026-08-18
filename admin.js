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
/* ── 桌面端单独适配 (≥1024px): 紧凑侧边栏 + 双列卡片, 消除大面积空白; 不影响手机/平板 ── */
@media (min-width:1024px){
  .app{max-width:1080px}
  .sidebar{width:190px;padding:14px 8px}
  .side-item{padding:9px 10px;gap:9px;font-size:14px;border-radius:8px}
  .side-item svg{width:22px;height:22px}
  .content{padding:22px 26px 40px}
  h2.section{font-size:24px;margin-bottom:12px}
  .btn{width:auto;padding:10px 20px;min-height:40px}
  .login-card .btn{width:100%}
  /* 卡片加细描边, 告别"白板漂浮", 更精致 */
  .card,.proxy,.stat,.pin-banner{border:0.5px solid var(--sep)}
  .card{margin-bottom:12px}
  /* 总览: 统计整行, 流量与健康度两卡并排 */
  #view-overview.active{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;align-items:start}
  #view-overview.active > h2,#view-overview.active > .stats{grid-column:1/-1}
  #view-overview.active > .stats{margin-bottom:12px}
  #view-overview.active > .card{margin-bottom:12px}
  /* 代理卡片双列 */
  .proxy-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
  .proxy-cards .proxy{margin-bottom:0}
  /* 设置页双列: 参数/鉴权/代理/界面 两两并排 */
  #view-settings.active{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;align-items:start}
  #view-settings.active > h2,#view-settings.active > .sub{grid-column:1/-1}
  #view-settings.active > .card{margin-bottom:12px}
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
/* ── 日志页 (redesigned) ── */
.log-toolbar{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.log-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.log-filters .input{width:auto;min-width:120px;padding:8px 12px;font-size:13px;min-height:0;border-radius:10px}
.log-actions{display:flex;gap:8px;align-items:center}
.log-actions .btn{width:auto;min-height:34px;padding:7px 13px;font-size:13px;border-radius:10px}
.log-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text3);margin-left:auto;font-weight:500}
.log-live .dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:logpulse 1.6s ease infinite}
.log-live.paused .dot{background:var(--text3);animation:none}
@keyframes logpulse{0%,100%{opacity:1}50%{opacity:.35}}
.log-item{display:flex;gap:12px;padding:12px 16px;border-top:0.5px solid var(--sep);align-items:flex-start}
.log-item:first-child{border-top:none}
.log-item .li-ico{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;font-weight:700}
.log-item .li-ico.route-ok{background:rgba(52,199,89,.14);color:var(--green)}
.log-item .li-ico.route-fail{background:rgba(255,59,48,.14);color:var(--red)}
.log-item .li-ico.status_change{background:rgba(0,122,255,.14);color:var(--blue)}
.log-item .li-ico.failover{background:rgba(255,149,0,.16);color:var(--orange)}
.log-item .li-ico.probe_failed{background:rgba(255,59,48,.14);color:var(--red)}
.log-item .li-ico.maintenance{background:rgba(175,82,222,.15);color:var(--purple)}
.log-item .li-ico.admin_action{background:rgba(120,120,128,.18);color:var(--text2)}
.log-item .li-ico.smoke{background:rgba(52,199,89,.14);color:var(--green)}
.log-item .li-main{flex:1;min-width:0}
.log-item .li-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.log-item .li-desc{font-size:12px;color:var(--text2);word-break:break-all;margin-top:2px;line-height:1.5}
.log-item .li-time{font-size:11px;color:var(--text3);margin-top:3px}
.log-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--fill);color:var(--text2)}
@media (max-width:767px){.log-item{padding:12px 14px}.log-actions .btn{flex:1}.log-filters .input{min-width:0;flex:1}}
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


/* ─────────────────────────────────────────────────────────────
   2026 UI redesign: mobile app console + desktop operations console
   Built from apple-design / emil-design-eng principles:
   direct feedback, restrained motion, optical hierarchy, no layout jumps.
───────────────────────────────────────────────────────────── */
:root{
  --ease-ui:cubic-bezier(.23,1,.32,1);
  --ease-move:cubic-bezier(.77,0,.175,1);
  --ink:#101828;--muted:#667085;--line:#e4e7ec;
  --surface:#fff;--surface-soft:#f8fafc;--canvas:#f5f7fb;
  --accent:#2563eb;--accent-soft:#eff6ff;
}
body{background:var(--canvas);color:var(--ink);font-size:15px}
button,.btn,.icon-btn,.side-item,.tab,.switch,.proxy,.card,.stat{transition:transform 160ms var(--ease-ui),background-color 160ms ease-out,border-color 160ms ease-out,box-shadow 160ms ease-out,opacity 160ms ease-out}
button:active,.btn:active,.icon-btn:active,.side-item:active,.tab:active{transform:scale(.97)}
.view.active{animation:view-enter 180ms var(--ease-ui)}
@keyframes view-enter{from{opacity:.75;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.view.active{animation:none}button,.btn,.icon-btn,.side-item,.tab,.switch,.proxy,.card,.stat{transition:none!important}}
/* ── Mobile: app-like operations surface ── */
@media (max-width:767px){
  :root{--canvas:#f4f6fa;--surface:#fff;--surface-soft:#f8fafc;--line:#e7eaf0}
  body{font-size:15px}
  .app{max-width:none;background:var(--canvas)}
  .nav{padding:calc(env(safe-area-inset-top) + 12px) 16px 11px;background:rgba(244,246,250,.86);border-bottom:1px solid rgba(16,24,40,.06)}
  .nav-title{font-size:18px;letter-spacing:-.025em}.nav-dot{width:8px;height:8px}
  .icon-btn{width:38px;height:38px;background:#e9eef7;color:#344054}
  .content{padding:18px 14px calc(74px + env(safe-area-inset-bottom));}
  h2.section{font-size:28px;line-height:1.08;letter-spacing:-.045em;margin:0 0 18px}
  .sub{font-size:13px;line-height:1.5;color:#667085;margin:-10px 2px 16px}
  .card,.proxy,.stat,.pin-banner{border:1px solid rgba(16,24,40,.06);box-shadow:0 2px 12px rgba(16,24,40,.045);border-radius:18px}
  .card{margin-bottom:12px}.card-head{padding:15px 16px 9px}.card-body{padding:3px 16px 16px}
  .stats{gap:9px;margin-bottom:12px}.stat{padding:15px 14px;border-radius:16px}.stat-num{font-size:25px}.stat-label{font-size:11px}
  .cell{min-height:46px;padding:11px 16px}.cell-label{font-size:14px}.cell-value{font-size:14px}
  .proxy{margin-bottom:12px}.proxy-head{padding:15px 14px 0;align-items:flex-start}.proxy-name{font-size:16px;gap:6px}.proxy-url{max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .proxy-actions{gap:5px}.proxy-actions .icon-btn{width:34px;height:34px;font-size:14px!important}.switch{width:48px;height:29px}.switch::after{width:25px;height:25px}.switch.on::after{transform:translateX(19px)}
  .proxy-grid{gap:0 12px}.proxy-grid .cell{padding:7px 0}.proxy-grid .cell-label{font-size:12px}.proxy-grid .cell-value{font-size:11px;max-width:130px}
  .proxy-cards{display:block}.bar{height:7px}.bar-row{font-size:11px}
  .pin-banner{padding:13px 14px;margin-bottom:12px;align-items:flex-start}.pin-banner .pin-sub{font-size:11px;line-height:1.45}.pin-banner .pin-clear{white-space:nowrap;padding:8px 11px}
  .seg{margin-bottom:12px}.seg button{min-height:36px}
  .input{min-height:46px;font-size:16px;border:1px solid #e4e7ec;background:#fff}
  .btn{min-height:46px;border-radius:13px}.btn.secondary{background:#edf2fa}
  .event{padding:12px 14px}.event-ico{width:32px;height:32px}.event-title{font-size:13px}.event-desc{font-size:11px;line-height:1.45}
  #evFilter{position:sticky;top:-18px;z-index:4;padding:3px;background:rgba(244,246,250,.92);backdrop-filter:blur(16px);margin-bottom:12px}
  .login{align-items:flex-end;padding:0}.login-card{max-width:none;border-radius:22px 22px 0 0;padding:25px 20px calc(24px + env(safe-area-inset-bottom));}
  #proxyModal{align-items:flex-end;padding:0}.login-card{max-height:92dvh;overflow-y:auto}
  #sSave,#sReset{min-height:46px}.field{margin-bottom:14px}
  .toast{bottom:calc(72px + env(safe-area-inset-bottom));font-size:13px}
}
/* ── Desktop: compact admin console ── */
@media (min-width:1024px){
  :root{--canvas:#f5f7fb;--surface:#fff;--surface-soft:#f8fafc;--line:#e4e7ec}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;background:var(--canvas)}
  .app{max-width:100%;background:var(--canvas)}
  .nav{height:56px;padding:0 24px;background:var(--surface);border-bottom:1px solid var(--line);backdrop-filter:none}
  .nav-title{font-size:16px;font-weight:600;color:#101828}.nav-dot{box-shadow:none}
  .nav-actions{gap:6px}.icon-btn{width:34px;height:34px;background:#f2f4f7;color:#344054;font-size:15px}
  .layout{min-height:0}
  .sidebar{display:flex;flex-direction:column;width:220px;padding:14px 12px;background:var(--surface);border-right:1px solid var(--line);color:var(--text2)}
  .side-item{color:var(--text2);padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:2px}
  .side-item:hover{background:var(--fill);color:var(--text)}
  .side-item.active{background:var(--accent-soft);color:var(--accent)}
  .content{padding:22px 26px 48px;width:100%}
  h2.section{font-size:24px;line-height:1.12;letter-spacing:-.03em;margin:0 0 14px;color:#101828}
  .sub{font-size:13px;color:#667085;margin:-6px 0 16px}
  .card,.proxy,.stat,.pin-banner{border:1px solid var(--line);box-shadow:0 1px 2px rgba(16,24,40,.04),0 4px 12px rgba(16,24,40,.03);border-radius:14px}
  .card:hover,.proxy:hover{box-shadow:0 2px 6px rgba(16,24,40,.06),0 8px 18px rgba(16,24,40,.045)}
  .stats{gap:10px;margin-bottom:14px}.stat{padding:16px 18px}.stat-num{font-size:26px}.stat-label{font-size:12px;color:#667085}
  #view-overview.active{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
  #view-overview.active>h2,#view-overview.active>.stats{grid-column:1/-1}
  #view-overview.active>.card{margin:0}.card-head{padding:14px 16px 10px}.card-body{padding:3px 16px 16px}
  .proxy-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.proxy-cards .proxy{margin:0}
  .proxy-head{padding:15px 16px 0}.proxy-actions{gap:6px}.proxy-actions .icon-btn{width:32px;height:32px}.proxy-grid{gap:2px 20px}
  .pin-banner{grid-column:1/-1;padding:14px 16px;margin-bottom:0}.btn{width:auto;min-height:40px;padding:9px 18px}.input{min-height:42px}
  #view-events.active{max-width:none;margin:0}.event{padding:12px 16px}.event-title{font-size:14px}.event-desc{font-size:12px}
  #view-test.active{max-width:none;margin:0}.result{font-size:13px;line-height:1.65}
  #view-settings.active{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
  #view-settings.active>h2,#view-settings.active>.sub{grid-column:1/-1;margin-bottom:0}.field{margin-bottom:14px}
  .login{background:rgba(16,24,40,.45)}.login-card{border:1px solid rgba(255,255,255,.4)}
}
/* ── Dark theme completeness ──
   The redesign introduces canvas/surface/ink tokens in addition to the
   original Apple tokens. Override every new token and hard-coded light
   surface so dark mode is a complete visual system, not dark cards on a
   light page. */
body.theme-dark{
  --canvas:#000;
  --ink:#f5f5f7;
  --muted:#a1a1aa;
  --line:#38383a;
  --surface:#1c1c1e;
  --surface-soft:#2c2c2e;
  --accent:#0a84ff;
  --accent-soft:rgba(10,132,255,.18);
}
body.theme-dark,
body.theme-dark .app,
body.theme-dark .content{background:var(--canvas);color:var(--ink)}
body.theme-dark .nav{
  background:rgba(28,28,30,.88);
  border-bottom-color:rgba(235,235,245,.12);
  color:var(--ink);
}
body.theme-dark .nav-title,
body.theme-dark h2.section{color:var(--ink)}
body.theme-dark .icon-btn{background:#2c2c2e;color:#f5f5f7}
body.theme-dark .card,
body.theme-dark .proxy,
body.theme-dark .stat,
body.theme-dark .pin-banner{
  background:var(--surface);
  border-color:rgba(235,235,245,.12);
  box-shadow:0 2px 14px rgba(0,0,0,.28);
}
body.theme-dark .stat-label,
body.theme-dark .sub,
body.theme-dark .cell-label,
body.theme-dark .event-desc,
body.theme-dark .event-time{color:rgba(235,235,245,.62)}
body.theme-dark .input{background:var(--surface-soft);border-color:#48484a;color:var(--ink)}
body.theme-dark .btn.secondary{background:#2c2c2e;color:#64a8ff}
body.theme-dark #evFilter{background:rgba(0,0,0,.88)}
body.theme-dark .side-item{color:#98989d}
body.theme-dark .side-item.active{color:#fff;background:#0a84ff}
body.theme-dark .event{border-top-color:rgba(84,84,88,.55)}
body.theme-dark .pin-banner .pin-sub{color:rgba(235,235,245,.56)}
@media (max-width:767px){
  body.theme-dark .nav{background:rgba(28,28,30,.9)}
  body.theme-dark .icon-btn{background:#2c2c2e}
  body.theme-dark .input{background:#2c2c2e;border-color:#48484a}
  body.theme-dark #evFilter{background:rgba(0,0,0,.9)}
}
@media (min-width:1024px){
  body.theme-dark{--canvas:#000;--surface:#1c1c1e;--surface-soft:#2c2c2e;--line:#38383a}
  body.theme-dark .nav{background:#1c1c1e;border-bottom-color:#38383a}
  body.theme-dark .sidebar{background:#1c1c1e;border-right-color:#38383a}
  body.theme-dark .content{background:#000}
}

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
var state={key:localStorage.getItem("gwkey")||"",view:localStorage.getItem("gwview")||"overview",theme:localStorage.getItem("gwtheme")||"auto",timer:null,logFilter:localStorage.getItem("gwlogfilter")||"all",logProxy:"all",logStatus:"all",logLive:true};
var ICONS={
  overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  proxies:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2a10 10 0 0 1 10 10M2 12a10 10 0 0 1 10-10M12 22a10 10 0 0 1-10-10M22 12a10 10 0 0 1-10 10"/></svg>',
  events:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h12"/></svg>',
  test:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6v4l5 9a3 3 0 0 1-2.6 4H6.6A3 3 0 0 1 4 16l5-9V3z"/><path d="M9 21v-5"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>'
};
var TABS=[["overview","总览"],["proxies","代理"],["events","日志"],["test","测试"],["settings","设置"]];
var LABELS={ok:"正常",depleted:"额度耗尽",down:"不可用",unknown:"未知",bad_config:"配置错误",maint:"维护中"};
var EVT_META={status_change:{label:"状态变更",ico:"\u25CF"},failover:{label:"故障切换",ico:"\u21C4"},probe_failed:{label:"探测失败",ico:"\u26A0"},maintenance:{label:"维护模式",ico:"\u25D0"},admin_action:{label:"管理操作",ico:"\u2699"},smoke:{label:"冒烟测试",ico:"\u2713"}};
var ACTION_LABELS={probe:"立即探测",save_config:"保存配置",reset_config:"恢复环境变量",clear_pin:"解除常驻",clear_logs:"清空日志"};
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
  // 每次进入代理页都作废已缓存的完整配置: 编辑/删除提交必须基于最新列表。
  // 否则多管理员场景下, 另一人新加的代理会因陈旧缓存被静默丢弃 (loadCfgProxies 重新拉取)。
  _cfgProxiesLoaded=false;
  // 防抖: 数据无变化时跳过整页重建 (轮询 5s 触发, 避免界面跳变/闪烁)
  var sig=JSON.stringify((d.proxies||[]).map(function(p){
    return [p.name,p.status,p.maint,p.score,p.requestsOk,p.requestsFail,p.detail,p.last_ok,p.next_probe];
  }));
  if(sig===_proxiesSig){
    refreshPinBanner(); // 仍刷新常驻信息
    return;
  }
  _proxiesSig=sig;
  el.innerHTML='<h2 class="section">代理</h2>'+
    '<div class="sub">开关 = 代理启用状态 (关 = 进入维护, 不参与选路); 支持添加/编辑/删除代理</div>'+
    '<div id="pinBanner"></div>'+
    '<div style="margin-bottom:14px"><button class="btn" id="addProxyBtn" style="min-height:40px">＋ 添加代理</button></div>'+
    '<div class="proxy-cards"></div>';
  // 代理卡片容器: 桌面端 (≥1024px) 双列网格, 手机/平板保持单列
  var cardsEl=el.querySelector(".proxy-cards");
  if(!d.proxies.length)cardsEl.innerHTML='<div class="card"><div class="empty">未配置任何代理</div></div>';
  d.proxies.forEach(function(pr){cardsEl.insertAdjacentHTML("beforeend",proxyCard(pr))});
  // 加载完整配置 (含 apiKey) 供编辑; 失败静默 (编辑/删除时会经 loadCfgProxies 重试)
  loadCfgProxies().catch(function(){});
  refreshPinBanner();
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
      // 编辑必须基于完整配置 (apiKey 回填); /config 未返回时先等它 (竞态保护)
      loadCfgProxies().then(function(list){
        var p=list.find(function(x){return x.name===name})||{name:name,url:card.querySelector(".proxy-url").innerText,apiKey:""};
        _pmEditingName=p.name;
        openProxyModal(p);
      }).catch(function(){
        // /config 都拿不到时用卡片上的展示数据兜底 (apiKey 留空, 保存时需补填)
        var p={name:name,url:card.querySelector(".proxy-url").innerText,apiKey:""};
        _pmEditingName=p.name;
        openProxyModal(p);
      });
    };
    card.querySelector(".p-del").onclick=function(e){
      e.preventDefault();e.stopPropagation();
      if(!confirm("确定删除代理 "+name+" ?"))return;
      // 关键: 删除必须基于完整配置列表。若 /config 尚未返回 (异步竞态), _cfgProxies
      // 为空 → 会提交空列表 → 后端 400 且删除静默失败。loadCfgProxies 保证取到才删。
      loadCfgProxies().then(function(list){
        saveProxies(list.filter(function(x){return x.name!==name}),"代理已删除");
      }).catch(function(){toast("删除失败: 无法加载代理配置")});
    };
  });
  $("#addProxyBtn").onclick=function(){openProxyModal(null)};
}
// 常驻/最近路由信息条: 优先显示当前会话钉住 (常驻) 的代理, 否则显示最近实际路由到的代理
// 常驻/最近路由信息: 独立刷新 (不随代理页重建), 卡片标记同步
function refreshPinBanner(){
  api("/pin").then(function(pd){
    renderPinBanner(pd);
    var pinned=pd&&pd.pinned_proxy?pd.pinned_proxy:null;
    document.querySelectorAll('#view-proxies .proxy').forEach(function(card){
      var nm=card.dataset.name;
      var isPinned=pinned===nm;
      card.classList.toggle("pinned",isPinned);
      var badge=card.querySelector(".pill.pinned");
      if(isPinned&&!badge)card.querySelector(".proxy-name").insertAdjacentHTML("beforeend",' <span class="pill pinned">常驻</span>');
      else if(!isPinned&&badge)badge.remove();
    });
  }).catch(function(){});
}
var _proxiesSig=null; // 代理页渲染签名 (数据无变化不重建, 防跳变)
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
/* ── 渲染: 日志 (路由记录 + 系统事件, 可筛选/暂停/清空) ── */
var _evToolbarBuilt=false,_evProxiesSig="",_evListSig="";
function renderEvents(d){
  var el=$("#view-events");
  var proxyNames=(d.proxies||[]).map(function(p){return p.name}).sort().join(",");
  // 工具栏只在代理列表变化时重建; 轮询重绘只更新列表, 保留筛选与滚动位置
  if(!_evToolbarBuilt||proxyNames!==_evProxiesSig){
    _evToolbarBuilt=true;_evProxiesSig=proxyNames;
    var opts='<option value="all">全部代理</option>';
    (d.proxies||[]).forEach(function(p){opts+='<option value="'+esc(p.name)+'">'+esc(p.name)+"</option>"});
    el.innerHTML='<h2 class="section">日志</h2>'+
      '<div class="sub">路由记录 + 系统事件 (最近 200 条 · 每 1 小时自动清理持久化日志)</div>'+
      '<div class="log-toolbar">'+
        '<div class="seg" id="evFilter">'+
          '<button data-f="all" class="active">全部</button>'+
          '<button data-f="route">路由记录</button>'+
          '<button data-f="system">系统事件</button></div>'+
        '<div class="log-filters">'+
          '<select class="input" id="evProxy">'+opts+'</select>'+
          '<select class="input" id="evStatus">'+
            '<option value="all">全部状态</option>'+
            '<option value="ok">成功</option>'+
            '<option value="fail">失败</option></select>'+
          '<span class="log-live'+(state.logLive?"":" paused")+'" id="evLiveInd"><span class="dot"></span><span>'+(state.logLive?"自动刷新中":"已暂停")+"</span></span>"+
        "</div>"+
        '<div class="log-actions">'+
          '<button class="btn secondary" id="evLiveBtn">'+(state.logLive?"暂停刷新":"继续刷新")+"</button>"+
          '<button class="btn danger" id="evClearBtn">清空日志</button>'+
        "</div>"+
      "</div>"+
      '<div id="evList"></div>';
    bindEventToolbar(el,d);
  }
  renderEventList(d);
}
function bindEventToolbar(el,d){
  var proxySel=$("#evProxy"),statusSel=$("#evStatus");
  if(proxySel){proxySel.value=state.logProxy||"all";proxySel.onchange=function(){state.logProxy=proxySel.value;_evListSig="";renderEventList(d)}};
  if(statusSel){statusSel.value=state.logStatus||"all";statusSel.onchange=function(){state.logStatus=statusSel.value;_evListSig="";renderEventList(d)}};
  el.querySelectorAll("#evFilter button").forEach(function(b){
    if(b.dataset.f===(state.logFilter||"all"))b.classList.add("active");else b.classList.remove("active");
    b.onclick=function(){
      state.logFilter=b.dataset.f;
      localStorage.setItem("gwlogfilter",b.dataset.f);
      el.querySelectorAll("#evFilter button").forEach(function(x){x.classList.remove("active")});
      b.classList.add("active");
      _evListSig="";renderEventList(d);
    };
  });
  var liveBtn=$("#evLiveBtn");
  liveBtn.onclick=function(){
    state.logLive=!state.logLive;
    liveBtn.textContent=state.logLive?"暂停刷新":"继续刷新";
    var ind=$("#evLiveInd");ind.className="log-live"+(state.logLive?"":" paused");
    ind.querySelector("span:last-child").textContent=state.logLive?"自动刷新中":"已暂停";
    if(state.logLive)refresh();
  };
  $("#evClearBtn").onclick=function(){
    if(!confirm("清空所有持久化日志 (路由记录 + 系统事件)?"))return;
    api("/logs/clear",{method:"POST",body:"{}"}).then(function(){toast("日志已清空");_evListSig="";refresh()}).catch(function(e){toast("清空失败: "+e.message)});
  };
}
function logItems(d){
  var routes=(d.routes||[]).slice();
  var events=(d.events||[]).slice();
  var items=[];
  var f=state.logFilter||"all",proxy=state.logProxy||"all",st=state.logStatus||"all";
  function matchRoute(r){
    if(proxy!=="all"&&r.name!==proxy)return false;
    if(st==="ok"&&!r.ok)return false;
    if(st==="fail"&&r.ok)return false;
    return true;
  }
  function matchEv(ev){
    if(proxy!=="all"&&ev.name!==proxy&&ev.proxy!==proxy)return false;
    return true;
  }
  if(f==="all"||f==="system")events.forEach(function(ev){if(matchEv(ev))items.push({t:ev.t,kind:"event",ev:ev})});
  if(f==="all"||f==="route")routes.forEach(function(r){if(matchRoute(r))items.push({t:r.t,kind:"route",r:r})});
  items.sort(function(a,b){return (b.t||0)-(a.t||0)});
  return items;
}
function evDesc(ev){
  if(ev.type==="status_change")return (ev.name?esc(ev.name)+" · ":"")+"状态 "+esc(ev.from||"?")+" → "+esc(ev.to||"?")+(ev.reason?" · "+esc(ev.reason):"");
  if(ev.type==="failover")return (ev.name?esc(ev.name)+" · ":"")+"切换至下一代理 ("+(ev.code?esc(ev.code):esc(ev.status||""))+")";
  if(ev.type==="probe_failed")return (ev.name?esc(ev.name)+" · ":"")+(ev.err?esc(ev.err):"探测失败");
  if(ev.type==="maintenance")return (ev.name?esc(ev.name)+" · ":"")+(ev.on?"进入维护 (暂停)":"恢复服务 (启用)");
  if(ev.type==="admin_action")return (ev.action?(ACTION_LABELS[ev.action]||esc(ev.action)):"管理操作")+(ev.name?" · "+esc(ev.name):"")+(ev.result?" → "+esc(ev.result):"");
  if(ev.type==="smoke")return "model "+esc(ev.model||"—")+(ev.proxy?" · "+esc(ev.proxy):"")+" · HTTP "+esc(ev.status||"—")+(ev.ok?" 成功":" 失败")+(ev.ms?" · "+esc(ev.ms)+"ms":"");
  var d2=(ev.name?esc(ev.name)+" ":"");
  if(ev.from&&ev.to)d2+="("+esc(ev.from)+" → "+esc(ev.to)+")";
  if(ev.code)d2+=" · "+esc(ev.code);
  if(ev.err)d2+=" · "+esc(ev.err);
  if(ev.detail)d2+=" · "+esc(ev.detail);
  return d2;
}
function renderEventList(d){
  var box=$("#evList");if(!box)return;
  var items=logItems(d);
  // 签名去重: 无新增日志时跳过重建, 避免 5s 轮询闪屏/滚动跳动
  var sig=items.length+":"+(items[0]?items[0].t:0)+":"+(items[items.length-1]?items[items.length-1].t:0)+":"+items.map(function(i){return i.t}).join(",");
  if(sig===_evListSig)return;
  _evListSig=sig;
  var content=$("#content");var st0=content?content.scrollTop:0;
  box.innerHTML="";
  if(!items.length){
    box.innerHTML='<div class="card"><div class="empty">暂无记录 — 发起一次请求后这里会显示路由日志</div></div>';
    return;
  }
  var card=document.createElement("div");card.className="card";
  items.forEach(function(it){
    var e=document.createElement("div");e.className="log-item";
    if(it.kind==="route"){
      var r=it.r;
      e.innerHTML='<div class="li-ico '+(r.ok?"route-ok":"route-fail")+'">⇄</div>'+
        '<div class="li-main">'+
          '<div class="li-title">'+esc(r.name||"—")+' <span class="pill '+(r.ok?"ok":"down")+'">'+(r.ok?"成功":"失败")+'</span>'+
            (r.model?' <span class="log-chip">'+esc(r.model)+'</span>':"")+'</div>'+
          '<div class="li-desc">HTTP '+esc(r.status||"—")+' · 尝试 '+esc(r.attempts||1)+' 次 · '+esc(r.ms||0)+'ms</div>'+
          '<div class="li-time">'+esc(fmtTime(r.t))+' · '+esc(fmtAgo(r.t))+'</div>'+
        '</div>';
    }else{
      var ev=it.ev;
      var meta=EVT_META[ev.type]||{label:ev.type,ico:"·"};
      var chip=(ev.name||ev.proxy)?' <span class="log-chip">'+esc(ev.name||ev.proxy)+'</span>':"";
      e.innerHTML='<div class="li-ico '+esc(ev.type)+'">'+meta.ico+'</div>'+
        '<div class="li-main">'+
          '<div class="li-title">'+esc(meta.label)+chip+'</div>'+
          '<div class="li-desc">'+evDesc(ev)+'</div>'+
          '<div class="li-time">'+esc(fmtTime(ev.t))+' · '+esc(fmtAgo(ev.t))+'</div>'+
        '</div>';
    }
    card.appendChild(e);
  });
  box.appendChild(card);
  if(content)content.scrollTop=st0;
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
  _cfgProxies=(c.proxies||[]).slice();_cfgProxiesLoaded=true;
  var srcNote=c.runtime_error
    ? '配置来源: <b>后台运行时配置</b> — 代理校验失败已回退环境变量: <span style="color:var(--red)">'+esc(c.runtime_error)+'</span>'
    : (c.has_runtime_config
      ? '配置来源: <b>后台运行时配置</b> (用户改动优先; 环境变量为初始值, 部署后仍以这里为准)'
      : '配置来源: <b>环境变量</b> (默认值内置于代码)');
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
    '<div class="field"><label>PROBE_MODE 探测策略</label><select class="input" id="sProbeMode">'+
      '<option value="smart"'+(c.probe_mode!=="scan"?" selected":"")+'>smart (只探测常驻/将用代理, 不浪费空闲额度)</option>'+
      '<option value="scan"'+(c.probe_mode==="scan"?" selected":"")+'>scan (无钉住时全量探测选最优, 消耗空闲额度)</option></select></div>'+
    '<div class="field"><label>PIN_TTL 钉住有效期 (秒)</label><input class="input" id="sPinTtl" type="number" min="60" value="'+esc(c.pin_ttl)+'"></div>'+
    '<div class="field"><label>STATE_TTL 状态刷新 (秒, ≥60)</label><input class="input" id="sStateTtl" type="number" min="60" value="'+esc(c.state_ttl)+'"></div>'+
    '<div class="field"><label>DEPLETED_PROBE 耗尽探测退避 (秒, ≥60)</label><input class="input" id="sDepletedProbe" type="number" min="60" value="'+esc(c.depleted_probe)+'"></div>'+
    '<div class="field"><label>DOWN_PROBE 故障探测退避 (秒, ≥30)</label><input class="input" id="sDownProbe" type="number" min="30" value="'+esc(c.down_probe)+'"></div>'+
    '<div class="field"><label>PROBE_TIMEOUT 探测超时 (毫秒, ≥500)</label><input class="input" id="sProbeTimeout" type="number" min="500" value="'+esc(c.probe_timeout)+'"></div>'+
    '<div class="field"><label>CHAT_TIMEOUT 非流式聊天超时 (毫秒, ≥1000; 流式不受限)</label><input class="input" id="sChatTimeout" type="number" min="1000" value="'+esc(c.chat_timeout)+'"></div>'+
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
      probeMode:$("#sProbeMode").value,
      pinTtl:parseInt($("#sPinTtl").value,10),
      stateTtl:parseInt($("#sStateTtl").value,10),
      depletedProbe:parseInt($("#sDepletedProbe").value,10),
      downProbe:parseInt($("#sDownProbe").value,10),
      probeTimeout:parseInt($("#sProbeTimeout").value,10),
      chatTimeout:parseInt($("#sChatTimeout").value,10),
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
var _cfgProxiesLoaded=false; // /config 是否已成功加载过 (编辑/删除依赖完整列表)
// 编辑/删除必须先拿到完整配置 (含 apiKey): 渲染代理页时 /config 是异步填充的,
// 若用户立刻点"编辑/删除"而 /config 未返回, _cfgProxies 为空 → 编辑丢 apiKey、
// 删除提交空列表被后端 400 拒绝 (静默失败)。这里统一保证"取到才继续"。
function loadCfgProxies(){
  if(_cfgProxiesLoaded)return Promise.resolve(_cfgProxies);
  return api("/config").then(function(cd){
    _cfgProxies=(cd.config&&cd.config.proxies||[]).slice();
    _cfgProxiesLoaded=true;
    return _cfgProxies;
  });
}
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
    toast(msg||"已保存");_cfgProxies=list.slice();_cfgProxiesLoaded=true;closeProxyModal();refresh();
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
  var _polling=false;
  state.timer=setInterval(function(){
    if(!state.key||$("#login").classList.contains("show"))return;
    if(_polling)return; // 上一轮轮询未返回则跳过, 防止慢请求堆积放大 DO 压力
    // 维护开关操作后短暂暂停代理页重绘, 避免旧数据把刚切换的开关弹回去
    if(state.view==="proxies"&&state.skipProxyRefreshUntil&&Date.now()<state.skipProxyRefreshUntil)return;
    if(state.view==="events"&&!state.logLive)return; // 日志页暂停自动刷新
    _polling=true;
    api("/overview").then(function(d){
      updateDot(d);
      if(state.view==="overview")renderOverview(d);
      else if(state.view==="proxies")renderProxies(d);
      else if(state.view==="events")renderEvents(d);
    }).catch(noop).finally(function(){_polling=false;});
  },5000);
})();
</script>
</body>
</html>`;
