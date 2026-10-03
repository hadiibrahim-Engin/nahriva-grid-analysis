async (page) => {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    await page.evaluate(() => {
      localStorage.removeItem('powerfactoryDashboardView');
      sessionStorage.removeItem('pf_simulation_cache_v1');
    });
    await page.goto(new URL(page.url()).origin);
    await page.getByRole('heading', { name: 'Outage Assessment', exact: true }).waitFor();
    const catalog = await (await page.request.get(new URL('/api/simulation/outage-management', page.url()).href)).json();
    assert(catalog.catalog.dummy_qds_version === 1, 'Browser smoke requires the dummy QDS database');
    assert(await page.getByRole('contentinfo').count() === 0, 'Footer remains');
    assert(await page.getByText('Zeitraum', { exact: true }).count() === 0, 'Date picker remains');
    assert(await page.getByText('Abmelden', { exact: true }).count() === 0, 'Login UI remains');
    for (const kind of ['REF', 'OUTAGE']) {
      await page.getByRole('button', { name: 'Szenario', exact: true }).click();
      await page.getByRole('option', { name: `Freischaltung Leitung Nord · ${kind} · Dummy QDS · synthetische Testdaten`, exact: true }).click();
      await page.getByRole('button', { name: 'Betriebsmittel', exact: true }).click();
      await page.getByRole('option', { name: 'Leitung Nord–West (ElmLne)', exact: true }).click();
      await page.getByRole('button', { name: 'Messgröße', exact: true }).click();
      await page.getByRole('option', { name: 'Auslastung (%)', exact: true }).click();
      const pending = page.waitForResponse(r => r.url().includes('/timeseries/raw/') && r.status() === 200);
      await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
      const response = await pending;
      const data = await response.json();
      const requestURL = new URL(response.url());
      assert(!requestURL.searchParams.has('start') && !requestURL.searchParams.has('end'), 'Hidden date filter remains');
      assert(data.data.length === 672, 'Complete seven-day QDS series was not displayed');
      assert(data.data[0].timestamp.startsWith('2026-01-31'), 'Old simulation timestamp was excluded');
    }
    await page.getByText(/1[.,]344 Punkte/).waitFor();
    await page.getByRole('link', { name: 'Zeitreihe', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('timeseries-panel').getBoundingClientRect().top < 400);
    await page.locator('#timeseries-panel canvas').first().waitFor();
    await page.screenshot({ path: 'output/playwright/outage-assessment.png' });
    const heatmap = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/heatmap') && r.status() === 200);
    await page.getByRole('link', { name: 'Heatmap', exact: true }).click();
    await heatmap;
    assert(errors.length === 0, `Runtime exceptions: ${errors.join('; ')}`);
    console.log('PASS: Outage Assessment, no login/footer/date filter, complete REF/OUTAGE rows, original charts and heatmap, no runtime exceptions');
  } finally { page.off('pageerror', onError); }
}
