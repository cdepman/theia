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
  return mobile ? page.locator('main > section ol li button') : page.locator('[data-testid=cloud-item]');
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
      // Each entry is its words plus a count pill. Words never overlap another entry's words or pill,
      // pills never overlap each other, and a pill sits clear of the end of its own first line.
      const entries = await page.locator('[data-testid=cloud-item]').evaluateAll((els) => els.map((g) => {
        const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return { words: box(g.querySelector(':scope > text')!), firstLine: box(g.querySelector(':scope > text > tspan')!), pill: box(g.querySelector('.cloud-badge rect')!), marks: [...g.querySelectorAll('[data-testid=cloud-mark]')].map(box) };
      }));
      expect(entries.length).toBeGreaterThanOrEqual(10);
      type Box = { x: number; y: number; w: number; h: number };
      const overlap = (A: Box, B: Box) => A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
      for (let a = 0; a < entries.length; a++) {
        const own = entries[a]!;
        expect(own.pill.x, `pill ${a} touches its own words on ${query}`).toBeGreaterThanOrEqual(own.firstLine.x + own.firstLine.w + 2);
        expect(own.pill.w, `pill ${a} is not pill-shaped on ${query}`).toBeGreaterThan(own.pill.h);
        for (let b = 0; b < entries.length; b++) {
          if (a === b) continue;
          const other = entries[b]!;
          if (a < b) expect(overlap(own.words, other.words), `headlines ${a} and ${b} overlap on ${query}`).toBe(false);
          if (a < b) expect(overlap(own.pill, other.pill), `pills ${a} and ${b} overlap on ${query}`).toBe(false);
          expect(overlap(own.pill, other.words), `pill ${a} overlaps headline ${b} on ${query}`).toBe(false);
          for (const mark of own.marks) expect(overlap(mark, other.words) || overlap(mark, other.pill), `a source mark of ${a} overlaps entry ${b} on ${query}`).toBe(false);
        }
        // Source marks sit in one column to the left of the entry's own words, clear of them and of each other.
        own.marks.forEach((mark, i) => {
          expect(mark.x + mark.w, `a source mark of ${a} touches its own words on ${query}`).toBeLessThanOrEqual(own.words.x - 3);
          if (i === 0) return;
          const above = own.marks[i - 1]!;
          expect(Math.abs(mark.x - above.x), `source marks of ${a} are not in one column on ${query}`).toBeLessThan(0.5);
          expect(mark.y, `source marks of ${a} touch each other on ${query}`).toBeGreaterThanOrEqual(above.y + above.h + 1.5);
        });
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

test.describe('public attention', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Japanese attention includes Hatena with bookmark counts', async ({ page, isMobile }) => {
    await page.goto(isMobile ? '/?country=JP&lane=attention' : '/?country=JP');
    const lane = page.getByTestId('attention-lane');
    await expect(lane.getByRole('heading', { name: 'Hatena popular bookmarks' })).toBeVisible();
    await expect(lane.getByRole('link', { name: '橋の点検報告書が公開' })).toBeVisible();
    await expect(lane.getByText('81 bookmarks, Japanese edition')).toBeVisible();
    await expect(lane.getByRole('button', { name: 'Memeorandum' })).toHaveCount(0);
  });

  test('entries from other origins sit beside the press, attributed and linked', async ({ page, isMobile }) => {
    const signals = await (await page.request.get('/api/signals?country=GB&window=24h')).json();
    expect(signals.origins.map((o: { key: string }) => o.key)).toContain('press');
    expect(signals.items.every((i: { origin: string; originKind: string; score: number }) => i.origin && i.originKind && i.score > 0)).toBe(true);
    expect(signals.items.some((i: { origin: string; scope: string }) => i.origin === 'hackernews' && i.scope === 'global')).toBe(true);

    await page.goto(isMobile ? '/?country=GB&lane=attention' : '/?country=GB');
    const lane = page.getByTestId('attention-lane');
    await expect(lane.getByRole('heading', { name: 'Public attention' })).toBeVisible();
    await expect(lane.getByRole('heading', { name: 'Google Trending Now' })).toBeVisible();
    await expect(lane.getByRole('link', { name: 'harbour bridge closure' })).toBeVisible();
    await expect(lane.getByRole('heading', { name: 'Memeorandum' })).toBeVisible();
    await expect(lane.getByRole('link', { name: 'Lawmakers debate bridge inspection funding' })).toBeVisible();
    await expect(lane.getByRole('heading', { name: 'Lobsters' })).toBeVisible();
    await expect(lane.getByRole('button', { name: 'Hatena popular bookmarks' })).toHaveCount(0);
    // An origin with no data says why, in place of an empty list.
    await expect(lane.getByText('Not collected yet. Set X_BEARER_TOKEN, then run the pipeline.')).toBeVisible();
    // Hidden by default in the configuration, switchable from the lane.
    await expect(lane.getByRole('heading', { name: 'Wikipedia most read, by language' })).toHaveCount(0);
    await lane.getByRole('button', { name: 'Wikipedia most read, by language' }).click();
    await expect(lane.getByRole('heading', { name: 'Wikipedia most read, by language' })).toBeVisible();
    // Blending puts every origin in one list and tags each entry with where it came from.
    await lane.getByRole('button', { name: 'Blend into one list by weight' }).click();
    await expect(lane.locator('ol li').first()).toContainText(/Google Trending Now|X trends|Wikipedia/);
    // The first Google entry points at an article collected from a monitored publisher.
    await lane.getByRole('button', { name: 'Also in the monitored press' }).first().click();
    await expect(page).toHaveURL(/item=story(%3A|:)[0-9a-f-]{36}/);
    await expect(page.getByRole('complementary', { name: 'Story details' })).toBeVisible();
  });

  test('press entries carry small marks for the outside sources that also list them', async ({ page, isMobile }) => {
    // The fixtures point three Google entries, two X trends and others at the country's top stories.
    const signals = await (await page.request.get('/api/signals?country=GB&window=24h')).json();
    const view = await (await page.request.get('/api/stories?country=GB&category=all&window=24h')).json();
    // Expected marks: entries in this view that a source shown by default points at. Worldwide
    // sources also point at other countries' stories, which are not in this view.
    const shownOrigins = new Set(signals.origins.filter((o: { visible: boolean; enabled: boolean }) => o.visible && o.enabled).map((o: { key: string }) => o.key));
    const inView = new Set(view.stories.map((s: { id: string }) => s.id));
    const linked = new Set(signals.items.filter((i: { storyId: string | null; origin: string }) => i.storyId && inView.has(i.storyId) && shownOrigins.has(i.origin)).map((i: { storyId: string }) => i.storyId));
    expect(linked.size).toBeGreaterThanOrEqual(4);

    if (isMobile) {
      await page.goto('/?country=GB');
      const row = page.locator('main > section ol li').filter({ has: page.getByTestId('list-marks') });
      await expect(row.first()).toBeVisible();
      expect(await row.count()).toBe(linked.size);
      await expect(row.first().getByTestId('list-marks')).toContainText('Also listed by');
      return;
    }

    // Marks stay when the lane is hidden: they are part of the press view.
    await page.goto('/?country=GB&attention=hide');
    const marked = page.locator('[data-testid=cloud-item]').filter({ has: page.getByTestId('cloud-mark') });
    await expect(marked.first()).toBeVisible();
    const found = await marked.evaluateAll((els) => els.map((g) => ({
      label: g.getAttribute('aria-label') ?? '',
      fontSize: Number(g.querySelector(':scope > text')!.getAttribute('font-size')),
      marks: [...g.querySelectorAll('[data-testid=cloud-mark]')].map((m) => ({ kind: m.getAttribute('data-kind'), title: m.querySelector('title')?.textContent ?? '', size: m.getBoundingClientRect().width })),
    })));
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.length).toBeLessThanOrEqual(linked.size);
    const order = ['search', 'social', 'reference', 'community', 'aggregator'];
    for (const f of found) {
      // Named for screen readers, named on hover, always in the same order, always small.
      expect(f.label).toContain('Also listed by');
      const kinds = f.marks.map((m) => m.kind!);
      expect(kinds).toEqual([...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const m of f.marks) {
        expect(m.title).toMatch(/: \S/);
        expect(m.size).toBeLessThanOrEqual(13.5);
        expect(m.size).toBeLessThan(f.fontSize);
      }
    }
    // The most widely covered story is listed by a search, a platform and a reference source here.
    expect(found.some((f) => f.marks.length === 3 && f.label.includes('Google Trending Now') && f.label.includes('X trends'))).toBe(true);
    // Entries nobody else lists carry no mark at all.
    expect(await page.locator('[data-testid=cloud-item]').count()).toBeGreaterThan(found.length);
    // The lane shows the same mark beside each source, so it doubles as the key.
    await page.goto('/?country=GB');
    await expect(page.getByTestId('attention-lane').getByRole('img', { name: 'Search trends' })).toBeVisible();
  });

  test('the press and the attention lane do not overlap on a wide screen', async ({ page, isMobile }) => {
    test.skip(isMobile, 'one lane at a time on narrow screens');
    await page.goto('/?country=US');
    await expect(page.getByTestId('attention-lane')).toBeVisible();
    const aside = (await page.getByTestId('attention-lane').boundingBox())!;
    const boxes = await page.locator('[data-testid=cloud-item]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    expect(boxes.length).toBeGreaterThan(5);
    expect(Math.max(...boxes)).toBeLessThanOrEqual(aside.x + 1);
    await page.getByRole('button', { name: 'Hide public attention' }).click();
    await expect(page.getByTestId('attention-lane')).toBeHidden();
  });
});
