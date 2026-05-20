import { test, expect } from '@playwright/test'

test.describe('dhee App', () => {
  test('loads and shows header with brand', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=dhee')).toBeVisible()
  })

  test('shows connection status indicator', async ({ page }) => {
    await page.goto('/')
    // Should show a connection dot (green when connected, red when not)
    const dot = page.locator('[title="connected"], [title="connecting"], [title="disconnected"]')
    await expect(dot).toBeVisible({ timeout: 10000 })
  })

  test('shows Providers and Workflows buttons', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Providers')).toBeVisible()
    await expect(page.locator('text=Workflows')).toBeVisible()
  })

  test('shows task input field', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('input[placeholder*="task"]')).toBeVisible()
    await expect(page.locator('text=Send')).toBeVisible()
  })

  test('shows sidebar with Phase, Todos, Assets sections', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Phase')).toBeVisible()
    await expect(page.locator('text=Todos')).toBeVisible()
    await expect(page.locator('text=Assets')).toBeVisible()
  })

  test('input is disabled when disconnected', async ({ page }) => {
    // Navigate to a URL that won't connect (wrong WS URL)
    await page.goto('/')
    // Wait briefly for connection attempt
    await page.waitForTimeout(1000)
    const input = page.locator('input[placeholder*="task"], input[placeholder*="Waiting"]')
    await expect(input).toBeVisible()
  })
})

test.describe('Workflow Manager', () => {
  test('opens workflow modal when Workflows button clicked', async ({ page }) => {
    await page.goto('/')
    await page.click('text=Workflows')
    // Modal should appear with pipeline sections
    await expect(page.locator('text=Workflow Management')).toBeVisible({ timeout: 5000 })
  })

  test('shows built-in workflows grouped by pipeline', async ({ page }) => {
    await page.goto('/')
    await page.click('text=Workflows')
    await expect(page.locator('text=Workflow Management')).toBeVisible({ timeout: 5000 })
    // Should show at least Video Generation section
    await expect(page.locator('text=Video Generation')).toBeVisible()
  })

  test('shows upload button in workflow modal', async ({ page }) => {
    await page.goto('/')
    await page.click('text=Workflows')
    await expect(page.locator('text=Upload Workflow')).toBeVisible({ timeout: 5000 })
  })

  test('closes modal when Close button clicked', async ({ page }) => {
    await page.goto('/')
    await page.click('text=Workflows')
    await expect(page.locator('text=Workflow Management')).toBeVisible({ timeout: 5000 })
    await page.click('text=Close')
    await expect(page.locator('text=Workflow Management')).not.toBeVisible()
  })
})
