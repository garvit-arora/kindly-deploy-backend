const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function takeScreenshot(url, deploymentId) {
    const browser = await chromium.launch({
        headless: true
    });

    try {
        const page = await browser.newPage({
            viewport: {
                width: 1280,
                height: 720
            }
        });

        await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30000
        });

        const screenshotDir = path.join(
            __dirname,
            '../screenshots'
        );

        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, {
                recursive: true
            });
        }

        const screenshotPath = path.join(
            screenshotDir,
            `${deploymentId}.png`
        );

        await page.screenshot({
            path: screenshotPath,
            fullPage: true
        });

        return screenshotPath;

    } finally {
        await browser.close();
    }
}

module.exports = takeScreenshot;