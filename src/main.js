/**
 * Browser entry point. All behaviour lives in app.js so it can be tested
 * without a real browser.
 */
import { createApp } from './app.js';

createApp({ document, window, storage: window.localStorage }).start();
