async (page) => {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const base = new URL(page.url()).origin;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  async function change(action, match = () => true) {
    const pending = page.waitForResponse(r => r.url().includes('/api/analysis/query?') && match(r.url()));
    await action();
    const response = await pending;
    assert(response.status() === 200, `Query failed: ${response.status()}`);
    const data = await response.json();
    await page.getByRole('region', { name: 'Kennzahlen' }).waitFor();
    return data;
  }
  try {
    await page.goto(base + '/');
    await page.getByRole('region', { name: 'Kennzahlen' }).waitFor();
    const compared = await change(() => page.getByRole('combobox', { name: 'Vergleichs-Run', exact: true }).selectOption('demo-reference'), url => url.includes('compare_run_id=demo-reference'));
    assert(compared.comparison.matched_count > 0 && compared.comparison.mean_delta > 0, 'Comparison must use matching pairs');
    await page.getByRole('button', { name: 'Trafo Mitte T2 elm-006', exact: true }).click();
    await page.getByRole('region', { name: 'Ausgewähltes Element' }).waitFor();
    await page.getByText('Elementreferenz anzeigen', { exact: true }).click();
    assert((await page.locator('pre').innerText()).includes('"id": "elm-006"'), 'Stable element ID missing');
    const selected = await change(() => page.getByRole('button', { name: 'Nur dieses Element analysieren', exact: true }).click(), url => url.includes('element_ids=elm-006'));
    assert(selected.meta.element_count === 1 && selected.stats.count === 192, 'Element filter did not affect KPIs');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV exportieren', exact: true }).click();
    const download = await downloadPromise; await download.saveAs('output/playwright/analysis.csv');
    const empty = await change(() => page.getByRole('textbox', { name: 'Element suchen', exact: true }).fill('nicht-vorhanden'), url => url.includes('search=nicht-vorhanden'));
    assert(empty.stats.count === 0 && empty.elements.length === 0, 'Empty filter result is stale');
    await page.getByRole('heading', { name: 'Keine gültigen Messwerte in dieser Auswahl' }).waitFor();
    await change(() => page.getByRole('button', { name: 'Filter zurücksetzen', exact: true }).click(), url => !url.includes('search=') && !url.includes('element_ids='));
    const voltage = await change(() => page.getByRole('combobox', { name: 'Messgröße', exact: true }).selectOption('voltage'), url => url.includes('metric_id=voltage'));
    assert(voltage.metric.unit === 'p.u.' && voltage.stats.count === 384, 'Voltage switch is inconsistent');
    await page.reload();
    await page.getByRole('region', { name: 'Kennzahlen' }).waitFor();
    assert(await page.getByRole('combobox', { name: 'Messgröße', exact: true }).inputValue() === 'voltage', 'URL filters did not survive reload');
    await page.getByRole('link', { name: 'FDWH-Messdaten', exact: true }).click();
    await page.getByRole('heading', { name: 'Oracle ist noch nicht konfiguriert' }).waitFor();
    await page.getByRole('link', { name: 'Datenquellen', exact: true }).click();
    await page.getByRole('heading', { name: 'Datenquellen', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Analyseübersicht', exact: true }).click();
    await page.getByRole('region', { name: 'Kennzahlen' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    const layout = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(layout.content <= layout.viewport, `Mobile page overflow: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: 'output/playwright/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: 'output/playwright/desktop-full.png', fullPage: true });
    assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    console.log('PASS: comparison, element reference, selection filter, CSV, empty state, metric switch, URL persistence, navigation, mobile layout, no runtime exceptions');
  } finally { page.off('pageerror', onError); }
}
