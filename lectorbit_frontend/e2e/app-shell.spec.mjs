describe('LectorBit desktop shell', () => {
  before(async () => {
    const mainWindow = await browser.getWindowHandle();
    await browser.switchToWindow(mainWindow);
  });

  it('loads the offline routine and navigates to signed update settings', async () => {
    await $('a[href="/"]').click();
    await waitForPageHeader('Routine');

    await $('a[href="/settings"]').click();
    await waitForPageHeader('AI and app services');
    await expect($('button=Check for updates')).toBeDisplayed();
  });

  it('loads the next focused-study video through the private local stream', async function () {
    this.timeout(180_000);
    await $('a[href="/"]').click();
    await waitForPageHeader('Routine');
    const start = await $('a*=Start focused study');
    if (!(await start.isExisting())) return;

    await start.click();
    await waitForPageHeader('Focused study');
    let playerState;
    await browser.waitUntil(async () => {
      playerState = await browser.execute(() => {
        const video = document.querySelector('video[aria-label^="Playing "]');
        if (video instanceof HTMLVideoElement) {
          if (video.error) {
            return {
              status: 'error',
              message: `media code ${video.error.code}: ${video.error.message}`,
            };
          }
          return {
            status: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? 'ready' : 'loading',
            readyState: video.readyState,
            duration: video.duration,
            errorCode: null,
          };
        }
        const alert = document.querySelector('[role="alert"]');
        if (alert) return { status: 'error', message: alert.textContent?.trim() };
        return { status: 'preparing' };
      });
      if (playerState.status === 'error') {
        throw new Error(`Focused study failed: ${playerState.message}`);
      }
      return playerState.status === 'ready';
    }, {
      timeout: 150_000,
      interval: 250,
      timeoutMsg: () => `The private local video stream never became playable: ${JSON.stringify(playerState)}`,
    });
    expect(playerState.errorCode).toBeNull();
    expect(playerState.duration).toBeGreaterThan(0);
  });
});

async function waitForPageHeader(expectedText) {
  await browser.waitUntil(async () => {
    const pageHeader = await $('main header');
    return (await pageHeader.getText()).includes(expectedText);
  });
}
