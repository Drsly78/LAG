// Banc de test de la caisse L'Arrêt Gourmand : parcourt tous les chemins de boutons et vérifie la cohérence.
// Usage : node caisse-tests.js [http://localhost:8790/index.html]
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://localhost:8790/index.html';
const results = []; // { scenario, ok, checks:[{ok,msg}], errors:[] }

async function scenario(browser, name, fn, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 440, height: 900 }, isMobile: true, hasTouch: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', async d => { dialogs.push(d.type() + ': ' + d.message()); await d.accept(); });
  // serveur du site simulé
  const envois = [];
  await page.route('**/api/caisse', async route => {
    const body = route.request().postDataJSON();
    envois.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enregistres: 1, ids: [1], tickets: (body.commandes || []).length }) });
  });
  const checks = [];
  const t = {
    page, errors, dialogs, envois,
    check(ok, msg, extra) { checks.push({ ok: !!ok, msg: msg + (ok ? '' : (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')) }); },
    async goto() { await page.goto(URL + '?t=' + Date.now(), { waitUntil: 'load' }); await page.waitForTimeout(150); },
    async state() { return page.evaluate(() => ({
      tab: state.tab, step: state.step, orders: state.orders, orderNum: state.orderNum, items: state.currentItems, pairing: state.friteMenuPairing,
      revenue: state.dailyRevenue, loyalty: state.loyaltyCount, editing: state._editingOrderId || null, stock: Object.fromEntries(Object.entries(state.ingredients).map(([k, v]) => [k, v.qty])),
      rates: state.rates, ratesDetail: state.ratesDetail, text: document.getElementById('content').innerText,
    })); },
    async tap(text, nth = 0) { // bouton dont le texte contient `text`
      const loc = page.locator('button', { hasText: text }).nth(nth);
      await loc.click({ timeout: 4000 }); await page.waitForTimeout(80);
    },
    async tapCard(text) { // carte burger / mini-carte
      await page.locator('.burger-card, .mini-card, .option-card', { hasText: text }).first().click({ timeout: 4000 }); await page.waitForTimeout(80);
    },
    async tab(name) { await page.locator('#tab-' + name).click(); await page.waitForTimeout(80); },
    async visible(text) { return page.locator('#content, .modal-overlay:visible', { hasText: text }).count() > 0; },
    async slot(label) { await page.locator('.slot-btn', { hasText: label }).first().click(); await page.waitForTimeout(60); await page.locator('#slot-confirm-btn').click(); await page.waitForTimeout(120); },
    async evaluate(fn, arg) { return page.evaluate(fn, arg); },
  };
  let fatal = null;
  try { await fn(t); } catch (e) { fatal = e.message; }
  await ctx.close();
  const ok = !fatal && checks.every(c => c.ok) && errors.length === 0;
  results.push({ name, ok, checks, errors, fatal, dialogs });
}

(async () => {
  const browser = await chromium.launch();

  // ───────── S1 : commande simple, paiement, onglets ─────────
  await scenario(browser, 'S1 commande simple → cuisine → paiement', async (t) => {
    await t.goto();
    await t.tapCard("L'Original");
    let s = await t.state(); t.check(s.step === 'options', 'écran options après choix du burger', s.step);
    await t.tapCard('Saignant');
    await t.tap('+ Ajouter au ticket');
    s = await t.state(); t.check(s.items.length === 1 && s.step === 'burger', '1 article au ticket, retour liste', { n: s.items.length, step: s.step });
    await t.tap('Passer aux frites');
    s = await t.state(); t.check(s.step === 'frites', 'étape frites'); t.check(s.items.filter(i => i.type === 'fries-menu').length === 1, 'frites nature pré-remplies');
    await t.tapCard('Cheddar bacon');
    s = await t.state(); t.check(s.step === 'boissons', 'passage automatique aux boissons'); t.check(s.items.filter(i => i.type === 'fries-menu').length === 1 && s.items.find(i => i.type === 'fries-menu').fries.id === 'bfChedBac', 'frites cheddar bacon remplace nature', s.items);
    await t.tapCard('Soft');
    s = await t.state(); t.check(s.items.length === 3, '3 articles (burger, frites, soft)', s.items.length);
    const total = await t.evaluate(() => state.currentItems.reduce((a, i) => a + itemTotal(i), 0));
    t.check(Math.abs(total - (11 + 5.5 + 2)) < 0.001, 'total ticket 18,50 €', total);
    await t.tap('Envoyer en cuisine');
    t.check(await t.page.locator('#modal-slot').isVisible(), 'modale créneau ouverte');
    await t.slot('19h30');
    s = await t.state();
    t.check(s.orders.length === 1 && s.orders[0].id === 1 && s.orders[0].status === 'encours' && s.orders[0].slot === '19h30', 'commande #1 en cours sur 19h30', s.orders[0] && { id: s.orders[0].id, st: s.orders[0].status, slot: s.orders[0].slot });
    t.check(s.orderNum === 2, 'prochain numéro = 2', s.orderNum);
    t.check(s.stock.bun === 69 && s.stock.boeuf === 99 && s.stock.cheddar === 147, 'stock décompté (bun 69, bœuf 99, cheddar 147)', { bun: s.stock.bun, boeuf: s.stock.boeuf, cheddar: s.stock.cheddar });
    t.check(s.items.length === 0 && s.step === 'burger' && s.tab === 'caisse', 'ticket vidé, retour caisse');
    await t.tab('encours');
    s = await t.state(); t.check(s.text.includes('#1') && s.text.includes('19h30') && s.text.includes('Cheddar bacon'), 'En cours affiche #1 avec ses frites');
    await t.tap('💳');
    s = await t.state(); t.check(s.orders[0].status === 'paye' && Math.abs(s.revenue - 18.5) < 0.001, 'payée, CA 18,50 €', { st: s.orders[0].status, ca: s.revenue });
    t.check((await t.page.locator('#header-ca').innerText()).includes('18,50'), 'CA en-tête 18,50');
    await t.tab('historique'); s = await t.state(); t.check(s.text.includes('Réglée'), 'Historique affiche la commande réglée');
    await t.page.locator('.ca-chip').click(); await t.page.waitForTimeout(80);
    t.check(await t.page.locator('#modal-ca').isVisible(), 'modale CA ouverte');
    const ca = await t.page.locator('#ca-content').innerText(); t.check(ca.includes('18,50') && ca.includes('1') , 'détail CA cohérent');
    await t.page.locator('#modal-ca button', { hasText: 'Fermer' }).click(); await t.page.waitForTimeout(80);
    await t.page.locator('.hdr-btn').click(); await t.page.waitForTimeout(80);
    t.check(await t.page.locator('#modal-agenda').isVisible(), 'agenda ouvert');
    await t.page.locator('#modal-agenda .slot-btn', { hasText: '19h30' }).click(); await t.page.waitForTimeout(80);
    const ag = await t.page.locator('#agenda-content').innerText(); t.check(ag.includes("L'Original"), 'agenda liste la commande du créneau');
    await t.page.locator('#modal-agenda button', { hasText: 'Fermer' }).click(); await t.page.waitForTimeout(80);
  });

  // ───────── S2 : double steak & fromage ─────────
  await scenario(browser, 'S2 option double (Montagnard)', async (t) => {
    await t.goto();
    await t.tapCard('Le Montagnard'); await t.tapCard('Double steak'); await t.tap('+ Ajouter au ticket');
    await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    const s = await t.state();
    t.check(s.stock.boeuf === 98 && s.stock.reblochon === 18 && s.stock.cheddar === 150 && s.stock.bun === 69, 'double : −2 bœuf, −2 reblochon, cheddar intact', { boeuf: s.stock.boeuf, reblochon: s.stock.reblochon, cheddar: s.stock.cheddar });
    t.check(Math.abs(s.orders[0].total - 16) < 0.001, 'total 16 € (11 + 5)', s.orders[0].total);
  });

  // ───────── S3 : « Sans frites » puis ajout d'un 2e burger ─────────
  await scenario(browser, 'S3 sans frites conservé après ajout d\'un burger', async (t) => {
    await t.goto();
    await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket');
    await t.tap('Passer aux frites'); await t.tapCard('Sans frites');
    let s = await t.state(); t.check(s.step === 'boissons' && s.items.filter(i => i.type === 'fries-menu').length === 0, 'BBQ sans frites → boissons');
    await t.tap('+ Burger'); await t.tapCard('Le Dragon'); await t.tap('+ Ajouter au ticket');
    await t.tap('Passer aux frites');
    s = await t.state();
    const bbq = s.items.find(i => i.type === 'burger' && i.burger.id === 'bbq');
    t.check(s.pairing[bbq.key] === null, 'le BBQ reste SANS frites (pas de frites nature re-ajoutées)', s.pairing);
    t.check(s.items.filter(i => i.type === 'fries-menu').length === 1, 'une seule frites nature pré-remplie (pour le Dragon)', s.items.filter(i => i.type === 'fries-menu').length);
  });

  // ───────── S4 : annuler la modale créneau ─────────
  await scenario(browser, 'S4 annuler le choix du créneau', async (t) => {
    await t.goto();
    await t.tapCard('Le Cheese'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Nature');
    await t.tap('Envoyer en cuisine');
    await t.page.locator('#modal-slot button', { hasText: 'Annuler' }).click(); await t.page.waitForTimeout(80);
    let s = await t.state();
    t.check(!(await t.page.locator('#modal-slot').isVisible()), 'modale fermée');
    t.check(s.step === 'boissons' && /récapitulatif/i.test(s.text), 'on reste sur le récapitulatif (état et écran cohérents)', { step: s.step });
    await t.tapCard('Heineken');
    s = await t.state(); t.check(s.step === 'boissons' && s.items.length === 3, 'ajout d\'une boisson sans quitter le récap', { step: s.step, n: s.items.length });
    t.check(s.orders.length === 0, 'aucune commande créée');
  });

  // ───────── S5 : modifier une commande (en cours puis réglée) ─────────
  await scenario(browser, 'S5 modification d\'une commande', async (t) => {
    await t.goto();
    await t.tapCard('Le Myko'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Truffées'); await t.tap('Envoyer en cuisine'); await t.slot('19h10');
    await t.tab('encours'); await t.tap('Modifier');
    let s = await t.state();
    t.check(s.tab === 'caisse' && s.step === 'boissons' && s.editing === 1 && s.orders.length === 0, 'commande #1 ouverte en modification', { tab: s.tab, step: s.step, editing: s.editing });
    t.check(s.stock.boeuf === 100 && s.stock.chevre === 20, 'stock restitué pendant la modification', { boeuf: s.stock.boeuf, chevre: s.stock.chevre });
    await t.tapCard('Desperados'); await t.tap('Envoyer en cuisine'); await t.slot('19h20');
    s = await t.state();
    t.check(s.orders.length === 1 && s.orders[0].id === 1 && s.orders[0].items.length === 3 && s.orders[0].slot === '19h20', 'même numéro #1, 3 articles, nouveau créneau', s.orders[0] && { id: s.orders[0].id, n: s.orders[0].items.length, slot: s.orders[0].slot });
    t.check(s.orderNum === 2, 'le compteur n\'a pas avancé', s.orderNum);
    t.check(s.stock.boeuf === 99 && s.stock.chevre === 19, 'stock décompté une seule fois', { boeuf: s.stock.boeuf, chevre: s.stock.chevre });
    await t.tab('encours'); await t.tap('💳');
    s = await t.state(); t.check(Math.abs(s.revenue - (11 + 4.5 + 4)) < 0.001, 'CA 19,50 €', s.revenue);
    // modifier une commande réglée
    await t.tap('Modifier');
    s = await t.state(); t.check(Math.abs(s.revenue) < 0.001 && s.orders.length === 0, 'CA retiré pendant la modification d\'une réglée', s.revenue);
    await t.page.locator('#content .remove-btn').last().click(); await t.page.waitForTimeout(80); // retire la Desperados
    await t.tap('Envoyer en cuisine'); await t.slot('19h20');
    await t.tab('encours'); await t.tap('💳');
    s = await t.state(); t.check(Math.abs(s.revenue - 15.5) < 0.001 && s.orders[0].status === 'paye' && s.orders.length === 1, 'repayée : CA 15,50 €, une seule commande', { ca: s.revenue, n: s.orders.length });
  });

  // ───────── S6 : annuler puis ré-ouvrir ─────────
  await scenario(browser, 'S6 annulation puis ré-ouverture (stock)', async (t) => {
    await t.goto();
    await t.tapCard('Le Poulet'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('20h00');
    let s = await t.state(); t.check(s.stock.poulet === 5, 'poulet 5 après commande', s.stock.poulet);
    await t.tab('encours'); await t.tap('Annuler');
    s = await t.state(); t.check(s.orders[0].status === 'annule' && s.stock.poulet === 6, 'annulée : poulet restitué (6)', s.stock.poulet);
    await t.tap('Ré-ouvrir');
    s = await t.state(); t.check(s.stock.poulet === 6, 'ré-ouverture : stock NON restitué une 2e fois (6)', s.stock.poulet);
    await t.tap('Envoyer en cuisine'); await t.slot('20h00');
    s = await t.state(); t.check(s.stock.poulet === 5 && s.orders.length === 1 && s.orders[0].status === 'encours', 're-confirmée : poulet 5, une seule commande', { poulet: s.stock.poulet, n: s.orders.length });
    // annuler une réglée : CA retiré
    await t.tab('encours'); await t.tap('💳'); s = await t.state(); t.check(Math.abs(s.revenue - 12) < 0.001, 'payée 12 €');
    await t.tap('Annuler'); s = await t.state(); t.check(Math.abs(s.revenue) < 0.001 && s.stock.poulet === 6, 'réglée annulée : CA 0, stock restitué');
  });

  // ───────── S7 : fidélité ─────────
  await scenario(browser, 'S7 cartes fidélité', async (t) => {
    await t.goto();
    await t.tapCard("L'Américain"); await t.tap('+ Ajouter au ticket'); await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket');
    await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tapCard('Nature'); await t.tap('Envoyer en cuisine'); await t.slot('19h40');
    await t.tab('encours');
    let s = await t.state(); const raw = s.orders[0].total; t.check(Math.abs(raw - (12 + 11 + 2.5 + 2.5)) < 0.001, 'total brut 28 €', raw);
    await t.tap('Fidélité'); s = await t.state(); t.check(Math.abs(s.orders[0].total - 18) < 0.001 && s.orders[0].loyaltyCount === 1, '1 carte : 18 €', s.orders[0].total);
    await t.tap('Fidélité'); s = await t.state(); t.check(Math.abs(s.orders[0].total - 8) < 0.001 && s.orders[0].loyaltyCount === 2, '2 cartes : 8 €', s.orders[0].total);
    await t.page.locator('#content span', { hasText: 'Fidélité ×2' }).first().click(); await t.page.waitForTimeout(80);
    s = await t.state(); t.check(Math.abs(s.orders[0].total - 18) < 0.001 && s.orders[0].loyaltyCount === 1, 'retrait d\'une carte : 18 €', s.orders[0].total);
    await t.tap('💳'); s = await t.state(); t.check(Math.abs(s.revenue - 18) < 0.001 && s.loyalty === 1, 'payée 18 €, compteur fidélité 1', { ca: s.revenue, l: s.loyalty });
    // modification d'une réglée avec fidélité : la carte doit être conservée
    await t.tap('Modifier'); await t.tap('Envoyer en cuisine'); await t.slot('19h40');
    await t.tab('encours'); s = await t.state();
    t.check(s.orders[0].loyaltyCount === 1 && Math.abs(s.orders[0].total - 18) < 0.001, 'après modification la carte fidélité est conservée (18 €)', { lc: s.orders[0].loyaltyCount, total: s.orders[0].total });
    await t.tap('💳'); s = await t.state(); t.check(Math.abs(s.revenue - 18) < 0.001 && s.loyalty === 1, 'CA 18 €, fidélité 1 (pas de double comptage)', { ca: s.revenue, l: s.loyalty });
    await t.tap('Annuler'); s = await t.state(); t.check(s.loyalty === 0 && Math.abs(s.revenue) < 0.001, 'annulation : fidélité 0, CA 0', { ca: s.revenue, l: s.loyalty });
  });

  // ───────── S8 : numéros de commande (collision) ─────────
  await scenario(browser, 'S8 numéro de commande déjà utilisé', async (t) => {
    await t.goto();
    for (const b of ["L'Original", 'Le BBQ']) { await t.tapCard(b); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00'); }
    let s = await t.state(); t.check(s.orders.map(o => o.id).join() === '1,2', 'commandes #1 et #2', s.orders.map(o => o.id));
    await t.tab('stocks');
    await t.page.locator('#order-num-input').fill('1'); await t.page.locator('#order-num-input').dispatchEvent('change'); await t.page.waitForTimeout(80);
    s = await t.state(); t.check(s.orderNum === 1, 'prochain numéro forcé à 1');
    await t.tab('caisse'); await t.tapCard('Le Dragon'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state();
    const ids = s.orders.map(o => o.id); t.check(new Set(ids).size === ids.length, 'pas deux commandes avec le même numéro', ids);
    await t.tab('encours'); await t.page.locator('#content .order-card', { hasText: 'Le Dragon' }).locator('button', { hasText: '💳' }).click(); await t.page.waitForTimeout(80);
    s = await t.state(); const dragon = s.orders.find(o => o.items.some(i => i.burger && i.burger.id === 'dragon'));
    t.check(dragon && dragon.status === 'paye' && s.orders.filter(o => o.status === 'paye').length === 1, 'le paiement touche la bonne commande', s.orders.map(o => [o.id, o.status]));
  });

  // ───────── S9 : rechargement de page (ticket et modification en cours) ─────────
  await scenario(browser, 'S9 rechargement en cours de saisie', async (t) => {
    await t.goto();
    await t.tapCard('Le Cheese'); await t.tap('+ Ajouter au ticket'); await t.tapCard('Soft');
    await t.goto();
    let s = await t.state(); t.check(s.items.length === 2, 'le ticket en cours survit à un rechargement', s.items.length);
    await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tap('Envoyer en cuisine'); await t.slot('19h50');
    await t.tab('encours'); await t.tap('Modifier');
    await t.goto();
    s = await t.state();
    t.check(s.orders.length === 1 || (s.editing === 1 && s.items.length === 3), 'une commande en modification n\'est pas perdue au rechargement', { orders: s.orders.length, editing: s.editing, items: s.items.length });
    if (s.editing) { await t.tab('caisse'); await t.tap('Envoyer en cuisine'); await t.slot('19h50'); s = await t.state(); }
    t.check(s.orders.length === 1 && s.orders[0].id === 1 && s.orders[0].status === 'encours', 'commande #1 de retour en cours', s.orders.map(o => [o.id, o.status]));
  });

  // ───────── S10 : stock épuisé ─────────
  await scenario(browser, 'S10 épuisement de stock', async (t) => {
    await t.goto();
    await t.tab('stocks');
    const pouletInput = t.page.locator('.stock-item', { hasText: 'Poulet' }).locator('input');
    await pouletInput.fill('1'); await pouletInput.dispatchEvent('change'); await t.page.waitForTimeout(80);
    await t.tab('caisse'); await t.tapCard('Le Poulet'); await t.tap('+ Ajouter au ticket');
    t.check(await t.page.locator('.burger-card.unavailable', { hasText: 'Le Poulet' }).count() === 1, '2e Poulet marqué ÉPUISÉ (réservé par le ticket)');
    await t.page.locator('.burger-card.unavailable', { hasText: 'Le Poulet' }).click({ force: true }); await t.page.waitForTimeout(60);
    let s = await t.state(); t.check(s.step === 'burger' && s.items.length === 1, 'clic sur un burger épuisé sans effet');
    await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state(); t.check(s.stock.poulet === 0, 'poulet à 0');
    t.check(await t.page.locator('.burger-card.unavailable', { hasText: 'Le Poulet' }).count() === 1, 'Poulet ÉPUISÉ après la commande');
    await t.tab('stocks'); s = await t.state(); t.check(s.text.includes('épuisé'), 'alerte épuisé dans Stocks');
  });

  // ───────── S11 : VIP ─────────
  await scenario(browser, 'S11 commande VIP « Le G »', async (t) => {
    await t.goto();
    await t.tab('vip'); await t.tap('Le G');
    await t.page.waitForTimeout(150);
    t.check(await t.page.locator('#modal-slot').isVisible(), 'modale créneau ouverte directement');
    await t.slot('20h30');
    const s = await t.state();
    const o = s.orders[0];
    t.check(o && o.items.length === 7 && Math.abs(o.total - (16 + 16 + 12 + 5.5 + 5.5 + 2 + 2)) < 0.001, 'commande VIP 7 articles, 59 €', o && { n: o.items.length, total: o.total });
    t.check(s.stock.boeuf === 96 && s.stock.reblochon === 16 && s.stock.poulet === 5 && s.stock.cheddar === 145, 'stock VIP (bœuf 96, reblochon 16, poulet 5, cheddar 145)', { boeuf: s.stock.boeuf, reblochon: s.stock.reblochon, poulet: s.stock.poulet, cheddar: s.stock.cheddar });
    await t.tab('encours'); const txt = (await t.state()).text; t.check(txt.includes('Cheddar bacon') && txt.includes('Double steak'), 'En cours affiche le détail VIP');
  });

  // ───────── S12 : ratés ─────────
  await scenario(browser, 'S12 ratés', async (t) => {
    await t.goto(); await t.tab('stocks');
    await t.page.locator('#rate-burger').selectOption('montagnard'); await t.tap('Compter');
    let s = await t.state(); t.check(s.rates === 1 && s.stock.boeuf === 99 && s.stock.reblochon === 19 && s.stock.bun === 69, 'raté Montagnard : −1 bœuf, −1 reblochon, −1 bun', { r: s.rates, boeuf: s.stock.boeuf, rebl: s.stock.reblochon });
    await t.tap('↶'); s = await t.state(); t.check(s.rates === 0 && s.stock.boeuf === 100 && s.stock.reblochon === 20, 'raté annulé, stock restitué');
  });

  // ───────── S13 : nouveau burger + nouveau composant ─────────
  await scenario(browser, 'S13 créer un burger avec un nouveau composant', async (t) => {
    await t.goto(); await t.tab('stocks');
    await t.tap('+ Ajouter un burger');
    await t.page.locator('#bg-name').fill('Le Comtois'); await t.page.locator('#bg-price').fill('13');
    await t.page.locator('#modal-burger button', { hasText: '+ Nouveau composant' }).click(); await t.page.waitForTimeout(80);
    await t.page.locator('#ing-name').fill('Comté'); await t.page.locator('#ing-cat').selectOption('Composants'); await t.page.locator('#ing-qty').fill('12');
    await t.page.locator('#modal-ingredient button', { hasText: 'Créer' }).click(); await t.page.waitForTimeout(80);
    const txt = await t.page.locator('#burger-modal-content').innerText(); t.check(txt.includes('Comté'), 'Comté listé dans les composants du burger');
    await t.page.locator('#modal-burger button', { hasText: 'Enregistrer' }).click(); await t.page.waitForTimeout(80);
    let s = await t.state(); t.check(s.text.includes('Le Comtois') && s.stock.comte === 12, 'burger créé, stock Comté 12', { comte: s.stock.comte });
    await t.tab('caisse'); await t.tapCard('Le Comtois'); await t.tapCard('Double steak'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state(); t.check(s.stock.comte === 10 && s.stock.boeuf === 98 && s.stock.cheddar === 148, 'Comtois double : −2 comté, −2 bœuf, −2 cheddar (recette bun/bœuf/cheddar/comté)', { comte: s.stock.comte, boeuf: s.stock.boeuf, cheddar: s.stock.cheddar });
    await t.goto(); s = await t.state(); t.check(s.text.includes('Le Comtois'), 'le burger survit au rechargement');
    // suppression
    await t.tab('stocks'); await t.page.locator('.carte-row', { hasText: 'Le Comtois' }).locator('.carte-edit-btn').click(); await t.page.waitForTimeout(80);
    await t.page.locator('#modal-burger button', { hasText: '🗑' }).click(); await t.page.waitForTimeout(80);
    s = await t.state(); t.check(!s.text.includes('Le Comtois'), 'burger supprimé');
    await t.tab('encours'); s = await t.state(); t.check(s.text.includes('Le Comtois'), 'la commande déjà passée garde son nom');
  });

  // ───────── S14 : envoi au site ─────────
  await scenario(browser, 'S14 envoi de la synthèse au site', async (t) => {
    await t.goto(); await t.tab('stocks');
    await t.page.locator('#site-key-input').fill('lag_test'); await t.tap('Enregistrer');
    await t.tap('Tester'); await t.page.waitForTimeout(150);
    t.check(t.dialogs.some(d => d.includes('la clé est acceptée')), 'test de connexion OK', t.dialogs);
    await t.tab('caisse');
    await t.tapCard('Le Montagnard'); await t.tapCard('Double steak'); await t.tap('+ Ajouter au ticket'); await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket');
    await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tapCard('Sans frites'); await t.tapCard('Soft'); await t.tap('Envoyer en cuisine'); await t.slot('19h30');
    await t.tab('encours'); await t.tap('💳');
    await t.page.locator('.ca-chip').click(); await t.page.waitForTimeout(80); await t.tap('Envoyer au site'); await t.page.waitForTimeout(200);
    const envois = t.envois.filter(e => !e.ping);
    t.check(envois.length === 1, 'un envoi parti', envois.length);
    const e = envois[0] || {};
    t.check(e.burgers && e.burgers['Le Montagnard'] === 1 && e.burgers['Le BBQ'] === 1 && e.total_burgers === 2 && e.frites === 1 && e.doubles === 1 && Math.abs(e.ca_ttc - 31.5) < 0.001, 'synthèse : 2 burgers, 1 frites, 1 double, 31,50 €', e);
    t.check(Array.isArray(e.commandes) && e.commandes.length === 1 && e.commandes[0].statut === 'reglee' && e.commandes[0].creneau === '19h30', 'tickets joints', e.commandes);
    t.check(/^\d{4}-\d{2}-\d{2}$/.test(e.date || ''), 'date au format AAAA-MM-JJ', e.date);
    const badge = await t.page.locator('#site-sync-badge').innerText(); t.check(badge.includes('envoyé'), 'badge « envoyé »', badge);
  });

  // ───────── S15 : reset journée ─────────
  await scenario(browser, 'S15 reset journée', async (t) => {
    await t.goto();
    await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); await t.tap('💳');
    await t.page.locator('.ca-chip').click(); await t.page.waitForTimeout(80); await t.tap('Reset journée'); await t.page.waitForTimeout(80);
    await t.page.locator('#modal button', { hasText: 'Réinitialiser' }).click(); await t.page.waitForTimeout(80);
    const s = await t.state();
    t.check(s.orders.length === 0 && s.orderNum === 1 && s.revenue === 0 && s.stock.boeuf === 100 && s.items.length === 0, 'tout remis à zéro', { n: s.orders.length, num: s.orderNum, ca: s.revenue, boeuf: s.stock.boeuf });
    await t.goto(); const s2 = await t.state(); t.check(s2.orders.length === 0 && s2.items.length === 0, 'reset persistant après rechargement');
  });

  // ───────── S16 : données abîmées → l'app doit rester utilisable ─────────
  await scenario(browser, 'S16 commande abîmée en mémoire', async (t) => {
    await t.goto();
    await t.evaluate(() => { localStorage.setItem('ft7_orders', JSON.stringify([{ id: 1, items: [{ type: 'burger', key: 1 }], total: 11, status: 'encours', slot: '19h00' }])); });
    await t.goto();
    await t.tab('encours');
    let s = await t.state();
    t.check(s.text.length > 0 && !s.text.includes('undefined'), 'l\'onglet En cours affiche quelque chose (pas d\'écran vide)', s.text.slice(0, 80));
    await t.tab('caisse'); s = await t.state(); t.check(/burgers/i.test(s.text), 'la caisse fonctionne toujours');
    t.check(t.errors.length === 0, 'aucune erreur JavaScript non gérée', t.errors);
  });

  // ───────── S17 : recherche En cours ─────────
  await scenario(browser, 'S17 recherche par numéro', async (t) => {
    await t.goto();
    for (const b of ["L'Original", 'Le BBQ', 'Le Dragon']) { await t.tapCard(b); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00'); }
    await t.tab('encours');
    await t.page.locator('#encours-search').fill('2'); await t.page.waitForTimeout(100);
    let s = await t.state(); t.check(s.text.includes('#2') && !s.text.includes('#1') && !s.text.includes('#3'), 'seule la #2 est affichée');
    t.check(await t.page.evaluate(() => document.activeElement && document.activeElement.id === 'encours-search'), 'le champ garde le focus');
    await t.page.locator('.search-clear').click(); await t.page.waitForTimeout(80);
    s = await t.state(); t.check(s.text.includes('#1') && s.text.includes('#3'), 'recherche effacée');
  });

  // ───────── S18 : 3 burgers, frites, changement inline, retrait ─────────
  await scenario(browser, 'S18 trois burgers et gestion des frites au récap', async (t) => {
    await t.goto();
    for (const b of ["L'Original", 'Le BBQ', 'Le Dragon']) { await t.tapCard(b); await t.tap('+ Ajouter au ticket'); }
    await t.tap('Passer aux frites');
    let s = await t.state(); t.check(s.text.includes('1/3'), 'frites 1/3');
    await t.tapCard('Truffées'); s = await t.state(); t.check(s.text.includes('2/3'), 'frites 2/3');
    await t.tapCard('Sans frites'); s = await t.state(); t.check(s.text.includes('3/3'), 'frites 3/3');
    await t.tapCard('Cheddar oignons'); s = await t.state(); t.check(s.step === 'boissons', 'récap après le 3e burger');
    let fm = s.items.filter(i => i.type === 'fries-menu'); t.check(fm.length === 2, '2 frites de menu', fm.map(f => f.fries.name));
    const total1 = await t.evaluate(() => state.currentItems.reduce((a, i) => a + itemTotal(i), 0)); t.check(Math.abs(total1 - (33 + 4.5 + 5)) < 0.001, 'total 42,50 €', total1);
    // changer les frites du BBQ (sans frites → cheddar) via le récap
    let bbq = s.items.find(i => i.type === 'burger' && i.burger.id === 'bbq');
    await t.page.locator('#content button', { hasText: '+ Ajouter frites' }).first().click(); await t.page.waitForTimeout(80);
    await t.page.locator(`button[onclick="changeFriteForBurger(${bbq.key},'bfChed')"]`).click(); await t.page.waitForTimeout(80);
    s = await t.state(); fm = s.items.filter(i => i.type === 'fries-menu'); t.check(fm.length === 3 && s.pairing[bbq.key] && s.items.find(i => i.key === s.pairing[bbq.key]).fries.id === 'bfChed', '3 frites après ajout, cheddar sur le BBQ', fm.map(f => f.fries.name));
    // retirer un burger : sa frite part avec
    await t.page.locator(`button[onclick="removeItem(${bbq.key})"]`).first().click(); await t.page.waitForTimeout(80);
    s = await t.state(); t.check(s.items.filter(i => i.type === 'burger').length === 2 && s.items.filter(i => i.type === 'fries-menu').length === 2, 'burger retiré avec sa frite', s.items.map(i => i.type));
    await t.tap('Envoyer en cuisine'); await t.slot('20h10');
    s = await t.state(); const o = s.orders[0]; t.check(o.items.length === 4 && Math.abs(o.total - (11 + 11 + 4.5 + 5)) < 0.001, 'commande 4 articles 31,50 €', { n: o.items.length, total: o.total });
    await t.tab('encours'); s = await t.state(); t.check(s.text.includes('Truffées') && s.text.includes('Cheddar oignons'), 'frites affichées sous leurs burgers');
  });

  // ───────── S19 : sans burger (frites seules / boissons), steak haché ─────────
  await scenario(browser, 'S19 frites seules, boissons, steak haché', async (t) => {
    await t.goto();
    await t.tapCard('Cheddar bacon'); await t.tapCard('Heineken');
    let s = await t.state(); t.check(s.items.length === 2, '2 articles hors burger');
    await t.tap('Passer aux frites'); s = await t.state(); t.check(s.step === 'boissons', 'sans burger : directement aux boissons', s.step);
    await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state(); t.check(s.orders.length === 1 && Math.abs(s.orders[0].total - 10) < 0.001 && s.stock.cheddar === 148, 'commande 10 € (cheddar −2)', { total: s.orders[0] && s.orders[0].total, cheddar: s.stock.cheddar });
    await t.tapCard('Le Steak Haché'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state(); t.check(s.stock.bun === 70 && s.stock.boeuf === 99, 'steak haché : pas de bun, −1 bœuf', { bun: s.stock.bun, boeuf: s.stock.boeuf });
    await t.page.locator('.hdr-btn').click(); await t.page.waitForTimeout(80);
    const ag = await t.page.locator('#agenda-content').innerText(); t.check(ag.includes('🍔 1') && ag.includes('🍟 2'), 'agenda : 1 burger, 2 frites sur 19h00', ag.slice(0, 200));
  });

  // ───────── S20 : modifier un burger du ticket depuis le récap ─────────
  await scenario(browser, 'S20 modifier un burger depuis le récap', async (t) => {
    await t.goto();
    await t.tapCard("L'Original"); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Cheddar bacon');
    await t.page.locator('#content button', { hasText: 'Modifier' }).first().click(); await t.page.waitForTimeout(80);
    let s = await t.state(); t.check(s.step === 'options', 'écran options du burger');
    await t.tapCard('Bacon'); await t.tap('✓ Mettre à jour');
    s = await t.state();
    t.check(s.items.filter(i => i.type === 'burger').length === 1 && s.items.find(i => i.type === 'burger').supplements.length === 1, 'burger mis à jour (pas dupliqué), +bacon', s.items.map(i => i.type));
    t.check(s.step === 'boissons', 'retour au récap après la mise à jour', s.step);
    t.check(s.items.filter(i => i.type === 'fries-menu').length === 1 && s.items.find(i => i.type === 'fries-menu').fries.id === 'bfChedBac', 'les frites cheddar bacon sont conservées', s.items.filter(i => i.type === 'fries-menu').map(f => f.fries.id));
    await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    s = await t.state(); t.check(Math.abs(s.orders[0].total - (11 + 2 + 5.5)) < 0.001, 'total 18,50 €', s.orders[0].total);
  });


  // ───────── S21 : réglée → annulée → ré-ouverte → repayée ─────────
  await scenario(browser, 'S21 réglée, annulée, ré-ouverte, repayée', async (t) => {
    await t.goto();
    await t.tapCard("L'Original");
    await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Nature'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); await t.tap('💳'); await t.tap('Annuler');
    let s = await t.state(); t.check(s.orders[0].status === 'annule' && s.revenue === 0 && s.stock.boeuf === 100, 'annulée après paiement : CA 0, stock rendu');
    await t.tap('Ré-ouvrir'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); await t.tap('💳');
    s = await t.state(); t.check(s.orders.length === 1 && s.orders[0].status === 'paye' && Math.abs(s.revenue - 13.5) < 0.001 && s.stock.boeuf === 99, 'repayée : CA 13,50 €, bœuf 99', { n: s.orders.length, ca: s.revenue, boeuf: s.stock.boeuf });
  });

  // ───────── S22 : retrait d'ingrédient (sans cornichons) ─────────
  await scenario(browser, 'S22 burger personnalisé (sans cornichons, bien cuit)', async (t) => {
    await t.goto();
    await t.tapCard("L'Original"); await t.tapCard('Bien cuit');
    await t.page.locator('#content .btn-chip', { hasText: 'Sans' }).first().click(); await t.page.waitForTimeout(80);
    await t.page.locator('.removal-btn', { hasText: 'Cornichons' }).click(); await t.page.waitForTimeout(80);
    let s = await t.state(); t.check(/sans cornichons/i.test(s.text), 'retrait affiché au récap du burger');
    await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); s = await t.state(); t.check(s.text.includes('SANS CORNICHONS') && s.text.includes('Bien cuit'), 'En cours affiche le retrait et la cuisson');
    await t.page.locator('.hdr-btn').click(); await t.page.waitForTimeout(80);
    await t.page.locator('#modal-agenda .slot-btn', { hasText: '19h00' }).click(); await t.page.waitForTimeout(80);
    const ag = await t.page.locator('#agenda-content').innerText(); t.check(ag.includes('SANS CORNICHONS'), 'agenda affiche le retrait');
  });

  // ───────── S23 : deux soirs non remis à zéro → deux services envoyés ─────────
  await scenario(browser, 'S23 envoi : deux soirs dans la caisse', async (t) => {
    await t.goto();
    await t.evaluate(() => {
      const o = { id: 1, items: [{ type: 'burger', key: 1, burger: BURGERS[0], supplements: [], removals: [], cuisson: null }], rawTotal: 11, total: 11, status: 'paye', loyalty: false, slot: '19h00', date: '27/10/2026', heure: '19:05', friteMenuPairing: { 1: null } };
      localStorage.setItem('ft7_orders', JSON.stringify([o])); localStorage.setItem('ft7_revenue', '11'); localStorage.setItem('ft7_orderNum', '2'); localStorage.setItem('ft7_site_key', 'lag_test');
    });
    await t.goto();
    await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); await t.page.locator('#content .order-card', { hasText: 'Le BBQ' }).locator('button', { hasText: '💳' }).click(); await t.page.waitForTimeout(80);
    await t.tab('stocks'); await t.tap('Envoyer maintenant'); await t.page.waitForTimeout(250);
    const envois = t.envois.filter(e => !e.ping); const e = envois[0] || {};
    t.check(envois.length === 1 && Array.isArray(e.services) && e.services.length === 2, 'un envoi contenant 2 services', e);
    if (e.services) {
      t.check(e.services[0].date === '2026-10-27' && e.services[0].ca_ttc === 11 && e.services[1].ca_ttc === 11 && e.services[1].date !== '2026-10-27', 'chaque soir avec son CA', e.services.map(x => [x.date, x.ca_ttc]));
    }
    t.check(t.dialogs.some(d => d.includes('2 services')), 'message « 2 services envoyés »', t.dialogs);
  });

  // ───────── S24 : app fermée avant l'envoi automatique → envoi au lancement suivant ─────────
  await scenario(browser, 'S24 envoi différé au lancement', async (t) => {
    await t.goto(); await t.tab('stocks'); await t.page.locator('#site-key-input').fill('lag_test'); await t.tap('Enregistrer');
    await t.tab('caisse'); await t.tapCard('Le BBQ'); await t.tap('+ Ajouter au ticket'); await t.tap('Passer aux frites'); await t.tapCard('Sans frites'); await t.tap('Envoyer en cuisine'); await t.slot('19h00');
    await t.tab('encours'); await t.tap('💳');
    t.check(t.envois.filter(e => !e.ping).length === 0, 'rien n\'est parti tout de suite (90 s)');
    await t.goto(); // « fermeture » puis réouverture
    await t.page.waitForTimeout(5600);
    t.check(t.envois.filter(e => !e.ping).length === 1, 'l\'envoi part 5 s après la réouverture', t.envois.length);
    const badge = await t.page.locator('#site-sync-badge').innerText(); t.check(badge.includes('envoyé'), 'badge envoyé', badge);
  });

  await browser.close();
  // ───────── rapport ─────────
  let nOk = 0;
  for (const r of results) {
    const bad = r.checks.filter(c => !c.ok);
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}  (${r.checks.length - bad.length}/${r.checks.length})`);
    for (const c of bad) console.log('     ✗ ' + c.msg);
    for (const e of r.errors) console.log('     ⚠ ' + e);
    if (r.fatal) console.log('     💥 ' + r.fatal);
    if (r.ok) nOk++;
  }
  console.log(`\n${nOk}/${results.length} scénarios OK`);
  process.exit(nOk === results.length ? 0 : 1);
})();
