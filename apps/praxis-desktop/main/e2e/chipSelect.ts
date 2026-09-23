import { expect, type Locator } from '@playwright/test';

/**
 * Drives the renderer's `ChipSelect` (ui/ChipSelect.tsx) — the themed stand-in for a
 * native <select>. The chip is a button carrying its value as `data-value`; its menu is
 * portalled into <body> and linked by `aria-controls`, and each option carries `data-value`.
 *
 * Assert a chip's value with `toHaveAttribute('data-value', …)`.
 */

/** Narrow a label-based locator to the chip itself: an open menu's listbox ("X options")
 *  and filter box ("Filter X") match the same `getByLabel` text. */
function chipOnly(chip: Locator): Locator {
  return chip.and(chip.page().locator('button.chip-select'));
}

async function openMenu(target: Locator): Promise<Locator> {
  const chip = chipOnly(target);
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  const id = await chip.getAttribute('aria-controls');
  if (!id) throw new Error('ChipSelect menu did not open');
  const menu = chip.page().locator(`[id="${id}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

/** Choose an option by its value, or by its exact visible label. */
export async function chooseOption(target: Locator, choice: string | { label: string }): Promise<void> {
  const chip = chipOnly(target);
  const menu = await openMenu(chip);
  const option =
    typeof choice === 'string'
      ? menu.locator(`[role="option"][data-value="${choice.replace(/["\\]/g, '\\$&')}"]`)
      : menu
          .locator('[role="option"]')
          .filter({ has: chip.page().locator('.chip-select-option-label', { hasText: new RegExp(`^${choice.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  await option.click();
  // Closed — or gone, when the choice swaps the chip for another control (e.g. "Other model id…").
  await expect
    .poll(async () => (await chip.count()) === 0 || (await chip.getAttribute('aria-expanded')) === 'false')
    .toBe(true);
}

/** The values a chip offers, in order. Opens the menu and closes it again. */
export async function chipOptionValues(target: Locator): Promise<string[]> {
  const chip = chipOnly(target);
  const menu = await openMenu(chip);
  const values = await menu.locator('[role="option"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-value') ?? ''));
  await chip.page().keyboard.press('Escape');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  return values;
}

/** The visible labels a chip offers, in order. Opens the menu and closes it again. */
export async function chipOptionLabels(target: Locator): Promise<string[]> {
  const chip = chipOnly(target);
  const menu = await openMenu(chip);
  const labels = await menu.locator('[role="option"] .chip-select-option-label').allTextContents();
  await chip.page().keyboard.press('Escape');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  return labels;
}
