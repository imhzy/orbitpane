async def choose_option(page, label, option):
    """Choose through the same themed menu a user sees."""
    await page.get_by_role('combobox', name=label, exact=True).click()
    await page.get_by_role('option', name=option, exact=True).click()


async def assert_menu_visible(page, label):
    """A menu inside a clipped panel must still be visible and fit the viewport."""
    menu = page.get_by_role('listbox', name=f'{label}选项', exact=True)
    assert await menu.evaluate('''element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight && element.contains(hit);
    }''')
