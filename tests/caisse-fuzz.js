// Test « singe » de la caisse : enchaîne des appuis au hasard sur tout ce qui est cliquable et vérifie après chaque appui
// qu'aucune erreur n'est levée et que les chiffres restent cohérents (stock, CA, fidélité, numéros de commande).
// Usage : node caisse-fuzz.js [url] [nbParcours] [nbAppuisParParcours] [graine]
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://localhost:8790/index.html';
const RUNS = Number(process.argv[3] || 8), STEPS = Number(process.argv[4] || 120), SEED0 = Number(process.argv[5] || 1);

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// boutons dangereux ou qui demandent une saisie : hors du jeu
const EXCL = /adjustStock|updateStock|resetDay|exportExcel|envoyerService|testerSite|saveSiteConfig|setTheme|deleteBurger|deleteIngredient|deleteVip|adjustOrderNum|setOrderNum|openIngredientModal|saveIngredient|editVipItems|openVipModal|saveVipInfos/;
const EXCL_TXT = /Reset|Export|Envoyer au site|Envoyer maintenant|Tester|Supprimer|🗑|Ajouter un burger|Nouveau composant|\+ composant/;

async function run(browser, seed) {
  const rand = rng(seed);
  const ctx = await browser.newContext({ viewport: { width: 440, height: 900 }, isMobile: true, hasTouch: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = [], trace = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', async d => { await d.accept(d.type() === 'prompt' ? (d.defaultValue() || 'Client test') : undefined); });
  await page.route('**/api/caisse', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"enregistres":1,"ids":[1],"tickets":0}' }));
  await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'load' });
  const initial = await page.evaluate(() => Object.fromEntries(Object.entries(state.ingredients).map(([k, v]) => [k, v.qty])));

  const invariants = () => page.evaluate((initial) => {
    const pb = [];
    const cnt = (list) => { const c = {}; for (const k of (list || [])) c[k] = (c[k] || 0) + 1; return c; };
    const used = {};
    for (const it of state.currentItems) for (const [k, q] of Object.entries(cnt(it.ingUsed))) used[k] = (used[k] || 0) + q;
    for (const o of state.orders) if (o.status !== 'annule') for (const it of o.items) for (const [k, q] of Object.entries(cnt(it.ingUsed))) used[k] = (used[k] || 0) + q;
    for (const [k, v] of Object.entries(state.ingredients)) {
      if (v.qty < 0) pb.push(`stock négatif ${k}=${v.qty}`);
      if (initial[k] !== undefined && v.qty + (used[k] || 0) !== initial[k]) pb.push(`stock ${k} : ${v.qty} en réserve + ${used[k] || 0} engagés ≠ ${initial[k]} au départ`);
    }
    const ca = state.orders.filter(o => o.status === 'paye').reduce((s, o) => s + o.total, 0);
    if (Math.abs(ca - state.dailyRevenue) > 0.001) pb.push(`CA ${state.dailyRevenue} ≠ somme des réglées ${ca}`);
    const fid = state.orders.filter(o => o.status !== 'annule').reduce((s, o) => s + (o.loyaltyCount || (o.loyalty ? 1 : 0)), 0);
    if (fid !== state.loyaltyCount) pb.push(`fidélité ${state.loyaltyCount} ≠ ${fid}`);
    const ids = state.orders.map(o => o.id); if (new Set(ids).size !== ids.length) pb.push('numéros de commande en double : ' + ids.join(','));
    for (const it of state.currentItems) if (it.type === 'burger' && !it.ingUsed && !state._vipEdit) pb.push('article au ticket non débité : ' + it.burger.name);
    if (!document.getElementById('content').innerText.trim()) pb.push('écran vide');
    return pb;
  }, initial);

  let fatal = null, problems = [];
  try {
    for (let i = 0; i < STEPS; i++) {
      // ce qui est cliquable : la fenêtre ouverte s'il y en a une, sinon l'écran + onglets + en-tête
      const cands = await page.evaluate((args) => {
        const [EXCL, EXCL_TXT] = args.map(s => new RegExp(s));
        const modals = [...document.querySelectorAll('.modal-overlay')].filter(m => m.style.display !== 'none' && m.offsetParent !== null);
        const root = modals.length ? modals[modals.length - 1] : document;
        const sel = modals.length ? 'button, .slot-btn, .vip-card' : '#content button, #content .burger-card, #content .mini-card, #content .option-card, #content .vip-card, #content .carte-toggle, #content summary, .tabs button, .hdr-btn, .ca-chip';
        const els = [...root.querySelectorAll(sel)];
        const out = [];
        els.forEach((el, idx) => {
          if (el.disabled || el.offsetParent === null) return;
          const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return;
          const oc = el.getAttribute('onclick') || '', txt = (el.innerText || '').trim().slice(0, 40);
          if (EXCL.test(oc) || EXCL_TXT.test(txt)) return;
          if (el.closest('.stock-inline') || el.closest('.theme-seg')) return;
          el.dataset.fz = idx; out.push({ idx, txt: txt.replace(/\s+/g, ' '), oc: oc.slice(0, 50) });
        });
        return out;
      }, [EXCL.source, EXCL_TXT.source]);
      if (!cands.length) { trace.push('(rien de cliquable)'); await page.keyboard.press('Escape'); continue; }
      if (rand() < 0.03) { trace.push('(app relancée)'); await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'load' }); await page.waitForTimeout(60); const pb0 = await invariants(); if (pb0.length) { problems.push({ step: i, action: trace.slice(-4).join(' → '), pb: pb0 }); break; } continue; }
      const c = cands[Math.floor(rand() * cands.length)];
      trace.push(c.txt || c.oc);
      // clic direct (sans attente d'actionnabilité : l'élément est déjà filtré visible et dans la fenêtre du dessus)
      const done = await page.evaluate((idx) => { const el = document.querySelector(`[data-fz="${idx}"]`); if (!el) return false; el.click(); return true; }, c.idx);
      if (!done) trace[trace.length - 1] += ' (disparu)';
      await page.waitForTimeout(40);
      const pb = await invariants();
      if (pb.length) { problems.push({ step: i, action: trace.slice(-4).join(' → '), pb }); break; }
      if (errors.length) break;
    }
  } catch (e) { fatal = e.message; }
  await ctx.close();
  return { seed, errors, problems, fatal, steps: trace.length, trace };
}

(async () => {
  const browser = await chromium.launch();
  let ok = 0;
  for (let r = 0; r < RUNS; r++) {
    const res = await run(browser, SEED0 + r);
    const good = !res.fatal && !res.errors.length && !res.problems.length;
    if (good) ok++;
    console.log(`${good ? '✅' : '❌'} parcours ${res.seed} : ${res.steps} appuis`);
    for (const p of res.problems) console.log(`     ✗ appui ${p.step} (${p.action}) : ${p.pb.join(' ; ')}`);
    for (const e of res.errors) console.log('     ⚠ ' + e);
    if (res.fatal) console.log('     💥 ' + res.fatal);
    if (!good) console.log('     chemin : ' + res.trace.slice(-12).join(' → '));
  }
  await browser.close();
  console.log(`\n${ok}/${RUNS} parcours sans problème`);
  process.exit(ok === RUNS ? 0 : 1);
})();
