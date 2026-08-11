describe('LectorBit desktop shell', () => {
  it('loads the offline routine and navigates to signed update settings', async () => {
    const heading = await $('h1');
    await heading.waitForDisplayed();
    await expect(heading).toHaveText('Today');

    const settings = await $('a[href="/settings"]');
    await settings.click();
    await expect($('h1')).toHaveText('Local AI models');
    await expect($('button=Check for updates')).toBeDisplayed();
  });
});
