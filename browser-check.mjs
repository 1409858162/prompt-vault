import { chromium } from 'playwright';

const url = 'http://localhost:3000/app';
const INVITE_CODE = 'QJTRFP5XH3LKWRTYR5HJZ8L37NTTH8C9B6EBALREF369L28ZV7';

console.log('Browser check for', url);
console.log('Browser ID: 2f00bf');

const browser = await chromium.launch({ 
  headless: true,
  executablePath: '/Users/xutingting/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
});
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
});
const page = await context.newPage();
page.setViewportSize({ width: 1280, height: 900 });

const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', err => errors.push(`PageError: ${err.message}`));

try {
  console.log('\n=== 1. NAVIGATING ===');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  console.log('URL:', page.url());
  
  console.log('\n=== 2. CLICKING INVITE CODE LOGIN ===');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.includes('邀请码登录'));
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
  
  console.log('\n=== 3. FILLING CODE ===');
  
  // Fill textarea using JavaScript
  await page.evaluate((code) => {
    const textarea = document.querySelector('textarea');
    if (textarea) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeInputValueSetter.call(textarea, code);
      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
      textarea.dispatchEvent(inputEvent);
    }
  }, INVITE_CODE);
  
  await page.waitForTimeout(500);
  
  console.log('\n=== 4. ENABLING AND SUBMITTING ===');
  
  // Enable the button forcefully
  const result = await page.evaluate(() => {
    const textarea = document.querySelector('textarea');
    const btn = document.querySelector('button[type="submit"]');
    
    // Check textarea value
    const textareaValue = textarea?.value || '';
    
    // Enable button by removing disabled attribute
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('disabled');
    }
    
    // Also try to trigger any validation
    if (textarea) {
      const changeEvent = new Event('change', { bubbles: true });
      textarea.dispatchEvent(changeEvent);
      const blurEvent = new Event('blur', { bubbles: true });
      textarea.dispatchEvent(blurEvent);
    }
    
    return {
      textareaLength: textareaValue.length,
      buttonDisabled: btn?.disabled,
      buttonOpacity: btn ? window.getComputedStyle(btn).opacity : null
    };
  });
  
  console.log('Before click:', JSON.stringify(result));
  
  // Click submit
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) {
      // Dispatch click event
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      btn.dispatchEvent(clickEvent);
    }
  });
  
  console.log('Clicked submit');
  await page.waitForTimeout(3000);
  console.log('URL after submit:', page.url());
  
  // Check if captcha required
  const pageContent = await page.evaluate(() => document.body.innerText);
  if (pageContent.includes('验证') || pageContent.includes('请')) {
    console.log('\n=== CAPTCHA/SOMETHING REQUIRED ===');
    console.log('Page text sample:', pageContent.substring(0, 500));
  }
  
  // Final check
  console.log('\n=== 5. FINAL STATE ===');
  await page.waitForTimeout(2000);
  
  if (!page.url().includes('/login')) {
    console.log('Successfully logged in!');
    
    // Check app page
    await page.waitForTimeout(3000);
    
    console.log('\n=== APP PAGE STATE ===');
    
    const emptyInfo = await page.evaluate(() => {
      const el = document.getElementById('empty');
      if (!el) return { found: false };
      return {
        found: true,
        display: el.style.display,
        text: el.textContent?.trim().substring(0, 100),
        visible: el.offsetParent !== null
      };
    });
    console.log('#empty:', JSON.stringify(emptyInfo));
    
    const cardCount = await page.$$eval('.card', cards => cards.length);
    console.log('Cards:', cardCount);
    
    const pagerInfo = await page.evaluate(() => {
      const pager = document.querySelector('.pager, .pagination, [class*="pager"]');
      return pager ? pager.textContent?.trim().substring(0, 100) : 'Not found';
    });
    console.log('Pager:', pagerInfo);
    
    const filterInfo = await page.evaluate(() => ({
      category: !!document.querySelector('#category, select[name*="category"]'),
      free: !!document.querySelector('#free, select[name*="free"]'),
      text: !!document.querySelector('#search-text, input[name*="text"]')
    }));
    console.log('Filters:', JSON.stringify(filterInfo));
    
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    console.log('\nPage text:\n', bodyText);
    
  } else {
    console.log('Still on login page - login failed');
    
    // Check what's wrong
    const debugInfo = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      const btn = document.querySelector('button[type="submit"]');
      const bodyText = document.body.innerText;
      
      return {
        textareaLength: textarea?.value?.length || 0,
        buttonDisabled: btn?.disabled,
        bodyHasError: bodyText.includes('错误') || bodyText.includes('失败') || bodyText.includes('无效'),
        bodySnippet: bodyText.substring(0, 300)
      };
    });
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
  }
  
  console.log('\n=== CONSOLE ERRORS ===');
  console.log('Count:', errors.length);
  errors.forEach((e, i) => console.log(` ${i + 1}: ${e.substring(0, 150)}`));
  
  console.log('\n=== SUMMARY ===');
  console.log('Final URL:', page.url());
  
} catch (err) {
  console.error('ERROR:', err.message);
} finally {
  await browser.close();
}
