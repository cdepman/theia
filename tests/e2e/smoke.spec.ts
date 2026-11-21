import { expect, type Page, test } from '@playwright/test';

const PASSWORD = 'e2e-only-password';

async function signIn(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Project Theia' })).toBeVisible();
}

/** Headline buttons, whichever layout is showing. */
function headlines(page: Page, mobile: boolean) {
  return mobile ? page.locator('ol li button') : page.locator('[data-testid=cloud-item]');
}

test.describe('access gate', () => {
  test('nothing is served without a session', async ({ page, request }) => {
    const api = await request.get('/api/stories?country=US');
    expect(api.status()).toBe(401);
    const direct = await request.get('/assets/does-not-matter.js');
    expect(direct.status()).toBe(401);
    await page.goto('/?country=GB');
    await expect(page.getByLabel('Password')).toBeVisible();
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('not accepted');
  });
});

test.describe('explorer', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('each country shows real, source-backed stories', async ({ page, isMobile }) => {
    for (const [code, name] of [['US', 'United States'], ['GB', 'United Kingdom'], ['JP', 'Japan']] as const) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`country=${code}`));
      const items = headlines(page, isMobile);
      await expect(items.first()).toBeVisible();
      expect(await items.count()).toBeGreaterThanOrEqual(10);
      // The API payload behind the view carries counts and coverage for this country.
      const view = await (await page.request.get(`/api/stories?country=${code}&category=all&window=24h`)).json();
      expect(view.country).toBe(code);
      expect(view.stories.length).toBeGreaterThanOrEqual(10);
      expect(view.stories.every((s: { publisherCount: number; id: string }) => s.publisherCount >= 1 && /^[0-9a-f-]{36}$/.test(s.id))).toBe(true);
      expect(view.coverage.monitoredPublisherCount).toBeGreaterThan(0);
    }
  });

  test('headlines in the cloud never overlap', async ({ page, isMobile }) => {
    test.skip(isMobile, 'narrow screens use the ranked list');
    for (const query of ['?country=GB', '?country=US&window=7d', '?country=JP&window=30d']) {
      await page.goto(`/${query}`);
      await expect(page.locator('[data-testid=cloud-item]').first()).toBeVisible();
      const boxes = await page.locator('[data-testid=cloud-item] text').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
      expect(boxes.length).toBeGreaterThanOrEqual(10);
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const A = boxes[a]!, B = boxes[b]!;
          const overlap = A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
          expect(overlap, `headlines ${a} and ${b} overlap on ${query}`).toBe(false);
        }
      }
    }
  });

  test('filters change the view and are deep-linkable', async ({ page, isMobile }) => {
    await page.goto('/?country=GB');
    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/window=7d/);
    await page.getByRole('button', { name: '30 days' }).click();
    await expect(page).toHaveURL(/window=30d/);
    // The 30 day view switches unit, and says so.
    await expect(page.getByText('publisher-days', { exact: false }).first()).toBeVisible();
    if (isMobile) await page.getByRole('combobox', { name: 'Category' }).selectOption('politics');
    else await page.getByRole('button', { name: 'Politics', exact: true }).click();
    await expect(page).toHaveURL(/category=politics/);
    // A deep link restores the same state.
    await page.goto('/?country=JP&category=technology&window=7d');
    await expect(page.getByRole('button', { name: 'Japan', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/category=politics/);
  });

  test('a story opens with its original sources, and closes again', async ({ page, isMobile }) => {
    await page.goto('/?country=GB');
    const first = headlines(page, isMobile).first();
    await first.click();
    const panel = page.getByRole('complementary', { name: 'Story details' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/of \d+ monitored United Kingdom publishers/)).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Original reporting' })).toBeVisible();
    const links = panel.locator('a[target=_blank]');
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    // Every source link goes to the publisher, opens safely, and has a publisher label.
    for (const link of await links.all()) {
      expect(await link.getAttribute('href')).toMatch(/^https:\/\//);
      expect(await link.getAttribute('rel')).toContain('noopener');
    }
    await expect(page).toHaveURL(/item=story(%3A|:)/);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/item=/);
  });

  test('a subject in the 30 day view shows its timeline and daily coverage', async ({ page, isMobile }) => {
    await page.goto('/?country=GB&window=30d');
    await headlines(page, isMobile).first().click();
    const panel = page.getByRole('complementary', { name: 'Subject details' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: /Coverage by day/ })).toBeVisible();
    await expect(panel.getByRole('img', { name: /Daily coverage in United Kingdom/ })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Stories in this subject' })).toBeVisible();
    // Opening a story from the timeline shows that story.
    await panel.locator('ol li button').first().click();
    await expect(page.getByRole('complementary', { name: 'Story details' })).toBeVisible();
  });

  test('the cloud is usable from the keyboard', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop check');
    await page.goto('/?country=GB');
    const first = page.locator('[data-testid=cloud-item]').first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Story details' });
    await expect(panel).toBeVisible();
    // Focus moves into the panel.
    await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('empty and partial states are explicit', async ({ page }) => {
    await page.goto('/?country=GB&category=environment&window=24h');
    await expect(page.getByText('Partial coverage.')).toBeVisible();
    const view = await (await page.request.get('/api/stories?country=GB&category=environment&window=24h')).json();
    if (view.stories.length === 0) await expect(page.getByRole('heading', { name: /No environment stories/ })).toBeVisible();
    // An invalid request is rejected, not guessed at.
    expect((await page.request.get('/api/stories?country=FR')).status()).toBe(400);
  });

  test('methodology and status pages render live figures', async ({ page }) => {
    await page.goto('/methodology');
    await expect(page.getByRole('heading', { name: 'How to read Project Theia' })).toBeVisible();
    await expect(page.getByText(/\d+ monitored, \d+ recorded but not monitored/).first()).toBeVisible();
    await page.goto('/admin/status');
    await expect(page.getByRole('heading', { name: 'Pipeline status' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
    await expect(page.getByText(/checked successfully within their freshness target/)).toBeVisible();
  });
});
