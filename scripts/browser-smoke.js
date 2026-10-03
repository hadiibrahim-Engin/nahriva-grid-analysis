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
    assert([1, 2].includes(catalog.catalog.dummy_qds_version), 'Browser smoke requires the dummy QDS database');
    await page.getByRole('heading', { name: 'Scenario assessment', exact: true }).waitFor();
    assert(await page.locator('#timeseries-panel').count() === 0, 'Optional views are shown by default');
    assert(await page.getByRole('contentinfo').count() === 0, 'Footer remains');
    assert(await page.getByText('Period', { exact: true }).count() === 0, 'Date picker remains');
    assert(await page.getByText('Sign out', { exact: true }).count() === 0, 'Login UI remains');
    assert(await page.locator('.query-sidebar').count() === 0, 'Query Monitor remains');
    assert(await page.locator('header svg[role="img"]').count() === 0, 'Brand icon remains');
    assert(await page.getByRole('button', { name: /^(CSV|PDF|Share)/ }).count() === 0, 'Export/share buttons remain');
    await page.getByRole('button', { name: 'Add database', exact: true }).waitFor();
    for (const kind of ['REF', 'OUTAGE']) {
      await page.getByRole('button', { name: 'Scenario', exact: true }).click();
      await page.getByRole('option', { name: `Outage Line North · ${kind} · Dummy QDS · synthetic test data`, exact: true }).click();
      await page.getByRole('button', { name: 'Equipment', exact: true }).click();
      await page.getByRole('option', { name: 'Line North–West (ElmLne)', exact: true }).click();
      await page.getByRole('button', { name: 'Measurement', exact: true }).click();
      await page.getByRole('option', { name: 'Loading (%)', exact: true }).click();
      const pending = page.waitForResponse(r => r.url().includes('/timeseries/raw/') && r.status() === 200);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const response = await pending;
      const data = await response.json();
      const requestURL = new URL(response.url());
      assert(!requestURL.searchParams.has('start') && !requestURL.searchParams.has('end'), 'Hidden date filter remains');
      assert(data.data.length === 672, 'Complete seven-day QDS series was not displayed');
      assert(data.data[0].timestamp.startsWith('2026-01-31'), 'Old simulation timestamp was excluded');
    }
    await page.getByRole('button', { name: '+ Time series overlay', exact: true }).click();
    await page.getByText(/1[.,]344 points/).waitFor();
    await page.getByRole('link', { name: 'Time series', exact: true }).click();
    await page.waitForFunction(() => { const top = document.getElementById('timeseries-panel').getBoundingClientRect().top; return top >= 0 && top < 400; });
    await page.locator('#timeseries-panel canvas').first().waitFor();
    await page.screenshot({ path: 'output/playwright/outage-assessment.png' });
    assert(errors.length === 0, `Runtime exceptions: ${errors.join('; ')}`);
    console.log('PASS: Outage Assessment, no login/footer/date filter/logo/query monitor/export buttons, summary as the only default view, optional view on demand, complete REF/OUTAGE rows, no runtime exceptions');
  } finally { page.off('pageerror', onError); }
}
