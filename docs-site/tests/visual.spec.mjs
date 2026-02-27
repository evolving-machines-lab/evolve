/**
 * Playwright visual tests for docs-site.
 * Screenshots + DOM assertions.
 *
 * Prerequisites:
 *   npm run build
 *   npx playwright install chromium
 *
 * Usage: npx playwright test
 */
import { test, expect } from '@playwright/test';

test('landing page renders with navbar', async ({ page }) => {
  await page.goto('/');
  // Use the banner/header nav (first nav, not the TOC nav)
  const headerNav = page.locator('nav').first();
  await expect(headerNav).toBeVisible();
  await expect(page.getByRole('link', { name: /TypeScript SDK/i }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Python SDK/i }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Changelog/i }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Cookbooks/i }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/landing-light.png', fullPage: true });
});

test('typescript overview renders with sidebar', async ({ page }) => {
  await page.goto('/typescript');
  // Verify sidebar navigation links are visible (avoid `aside` which may match hidden mobile overlay)
  const sidebarLinks = ['Getting Started', 'Configuration', 'Runtime', 'Streaming'];
  for (const name of sidebarLinks) {
    await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /Swarm/i }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/ts-overview-light.png', fullPage: true });
});

test('python getting started has expected content', async ({ page }) => {
  await page.goto('/python/01-getting-started');
  // Code blocks render
  const codeBlocks = page.locator('pre code');
  await expect(codeBlocks.first()).toBeVisible();
  await page.screenshot({ path: 'test-results/py-getting-started-light.png', fullPage: true });
});

test('changelog renders', async ({ page }) => {
  await page.goto('/changelog');
  await expect(page.locator('main').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/changelog-light.png', fullPage: true });
});

test('dark mode renders', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/typescript');
  await page.screenshot({ path: 'test-results/ts-overview-dark.png', fullPage: true });
});

test('mobile viewport renders', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/typescript');
  // Header nav should still be present on mobile
  const headerNav = page.locator('nav').first();
  await expect(headerNav).toBeVisible();
  await page.screenshot({ path: 'test-results/ts-overview-mobile.png', fullPage: true });
});

test('tables render on typescript overview', async ({ page }) => {
  await page.goto('/typescript');
  const tables = page.locator('table');
  const count = await tables.count();
  expect(count).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/ts-tables.png', fullPage: true });
});

test('footer is present', async ({ page }) => {
  await page.goto('/typescript/01-getting-started');
  const footer = page.locator('footer');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText('Apache-2.0');
  await expect(footer).toContainText('Evolving Machines');
});

test('cookbooks link has correct href', async ({ page }) => {
  await page.goto('/');
  // Use the banner/header nav cookbooks link specifically
  const link = page.getByRole('banner').getByRole('link', { name: /Cookbooks/i });
  await expect(link).toHaveAttribute(
    'href',
    /github\.com\/evolving-machines-lab\/evolve\/tree\/main\/cookbooks/
  );
});

test('code blocks have syntax highlighting', async ({ page }) => {
  await page.goto('/typescript/01-getting-started');
  const codeBlocks = page.locator('pre code');
  await expect(codeBlocks.first()).toBeVisible();
  // Check that syntax highlighting classes are present
  const hasHighlighting = await codeBlocks.first().evaluate((el) => {
    return el.querySelectorAll('span').length > 0;
  });
  expect(hasHighlighting).toBeTruthy();
});
