async (page) => {
  const errors = [];
  const onError = error => errors.push(error.message);
  const heatmapResponses = [];
  const onResponse = response => {
    if (new URL(response.url()).pathname.endsWith('/heatmap') && response.status() === 200) heatmapResponses.push(response);
  };
  page.on('pageerror', onError);
  page.on('response', onResponse);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    await page.evaluate(() => {
      localStorage.removeItem('powerfactoryDashboardView');
      sessionStorage.removeItem('pf_simulation_cache_v1');
    });
    await page.goto(new URL(page.url()).origin);
    await page.getByRole('heading', { name: 'Outage Assessment', exact: true }).waitFor();
    const catalog = await (await page.request.get(new URL('/api/simulation/outage-management', page.url()).href)).json();
    assert([1, 2].includes(catalog.catalog.dummy_qds_version), 'Browser smoke requires the dummy QDS database');
    await page.getByRole('heading', { name: 'Freigabe-Bewertung der Szenarien', exact: true }).waitFor();
    assert(await page.locator('#timeseries-panel, #heatmap-panel, #peak-demand-chart-panel').count() === 0, 'Optional views are shown by default');
    assert(await page.getByRole('contentinfo').count() === 0, 'Footer remains');
    assert(await page.getByText('Zeitraum', { exact: true }).count() === 0, 'Date picker remains');
    assert(await page.getByText('Abmelden', { exact: true }).count() === 0, 'Login UI remains');
    assert(await page.locator('.query-sidebar').count() === 0, 'Query Monitor remains');
    assert(await page.locator('header svg[role="img"]').count() === 0, 'Brand icon remains');
    assert(await page.getByRole('button', { name: /^(CSV|PDF|Teilen)/ }).count() === 0, 'Export/share buttons remain');
    await page.getByRole('button', { name: 'Datenbank hinzufügen', exact: true }).waitFor();
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
    await page.getByRole('button', { name: '+ Zeitreihen-Overlay', exact: true }).click();
    await page.getByRole('link', { name: 'Zeitreihe', exact: true }).click();
    await page.waitForFunction(() => { const top = document.getElementById('timeseries-panel').getBoundingClientRect().top; return top >= 0 && top < 400; });
    await page.locator('#timeseries-panel canvas').first().waitFor();
    await page.screenshot({ path: 'output/playwright/outage-assessment.png' });
    // Scrolling can prefetch the heatmap before its navigation link is clicked.
    const heatmap = heatmapResponses.length ? Promise.resolve() : page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/heatmap') && r.status() === 200);
    await page.getByRole('button', { name: '+ Heatmap', exact: true }).click();
    await page.getByRole('link', { name: 'Heatmap', exact: true }).click();
    await heatmap;
    assert(errors.length === 0, `Runtime exceptions: ${errors.join('; ')}`);
    await page.locator('#heatmap-panel canvas').first().waitFor();
    console.log('PASS: Outage Assessment, no login/footer/date filter/logo/query monitor/export buttons, summary as the only default view, optional views on demand, complete REF/OUTAGE rows, original charts and heatmap, no runtime exceptions');
  } finally { page.off('pageerror', onError); page.off('response', onResponse); }
}
