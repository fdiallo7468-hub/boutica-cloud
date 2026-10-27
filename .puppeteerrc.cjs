const { join } = require('path');

/**
 * Configuration Puppeteer pour Render et les environnements cloud.
 * Stocke le cache du navigateur Chrome dans le projet (.cache/puppeteer)
 * pour qu'il soit conservé de manière persistante entre le build et le runtime Render.
 *
 * @type {import('puppeteer').Configuration}
 */
module.exports = {
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(__dirname, '.cache', 'puppeteer'),
};
