console.log("RUNNING SERVER FROM:", __filename);
require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;

const cors = require('cors');
app.use(cors());

const cacheStore = new Map();

function getCachedValue(key) {
  const entry = cacheStore.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedValue(key, value, ttlMs) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

const DEFAULT_LOCATION_KEY = 'northberwick';

//To find list of locations, enter the following Curl command, e.g. into Git Bash 
//curl -v -X GET "https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations" -H "Cache-Control: no-cache" -H "Ocp-Apim-Subscription-Key: $ADMIRALTY_API_KEY"

const LOCATION_PRESETS = {
  burghead: {
    forecast: { latitude: 57.70, longitude: -3.49 },
    marine: { latitude: 57.70, longitude: -3.49 },
    tides: { station: '0250' }, //Burghead
    livewind: { url: 'http://88.97.23.70:82/' }
  },
  northberwick: {
    forecast: { latitude: 56.06, longitude: -2.72 },
    marine: { latitude: 56.06, longitude: -2.72 },
    tides: { station: '0223' }, // Station 0223 is Fidra
    livewind: { url: 'http://88.97.23.70:82/' }
  }
};

function parseCoordinatesLocation(rawLocation) {
  if (typeof rawLocation !== 'string') {
    return null;
  }

  const trimmed = rawLocation.trim();
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }

  const latitude = Number.parseFloat(match[1]);
  const longitude = Number.parseFloat(match[2]);
  const validLatitude = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
  const validLongitude = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;

  if (!validLatitude || !validLongitude) {
    return null;
  }

  return {
    latitude,
    longitude,
    cacheKey: `coords:${latitude.toFixed(4)},${longitude.toFixed(4)}`
  };
}

function getLocationConfig(rawLocation) {
  const defaultPreset = LOCATION_PRESETS[DEFAULT_LOCATION_KEY];

  if (typeof rawLocation !== 'string' || rawLocation.trim() === '') {
    return {
      key: DEFAULT_LOCATION_KEY,
      label: DEFAULT_LOCATION_KEY,
      ...defaultPreset
    };
  }

  const trimmed = rawLocation.trim();
  const presetKey = trimmed.toLowerCase();
  const preset = LOCATION_PRESETS[presetKey];
  if (preset) {
    return {
      key: presetKey,
      label: presetKey,
      ...preset
    };
  }

  const coordinates = parseCoordinatesLocation(trimmed);
  if (coordinates) {
    return {
      key: coordinates.cacheKey,
      label: trimmed,
      forecast: {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude
      },
      marine: {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude
      },
      tides: {
        station: defaultPreset.tides.station
      },
      livewind: {
        url: defaultPreset.livewind.url
      }
    };
  }

  return {
    error: 'Invalid location',
    message: 'Use a known location name (for example: northberwick) or coordinates in the format latitude,longitude',
    supportedLocations: Object.keys(LOCATION_PRESETS)
  };
}

function convertKnotsToMph(value) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return (numeric * 1.15078).toFixed(1);
}

function parseNumericValue(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// Require each shorter averaging window to differ by at least 5% before calling the trend directional.
const TREND_THRESHOLD_RATIO = 0.05;

function meetsIncreaseThreshold(shorterIntervalMean, longerIntervalMean) {
  if (longerIntervalMean <= 0) {
    return shorterIntervalMean > longerIntervalMean;
  }

  return shorterIntervalMean >= longerIntervalMean * (1 + TREND_THRESHOLD_RATIO);
}

function meetsDecreaseThreshold(shorterIntervalMean, longerIntervalMean) {
  if (longerIntervalMean <= 0) {
    return shorterIntervalMean < longerIntervalMean;
  }

  return shorterIntervalMean <= longerIntervalMean * (1 - TREND_THRESHOLD_RATIO);
}

// Override to Dropping if 5-minute mean is at least 15% below 60-minute mean,
// or to Strengthening if 5-minute mean is at least 15% above 60-minute mean.
// Otherwise use 5% step changes between 60->30 and 30->5 to classify trends.
function determineWindTrend(meanMaxByInterval) {
  const meansByInterval = new Map(
    (Array.isArray(meanMaxByInterval) ? meanMaxByInterval : []).map((entry) => [
      String(entry.intervalMinutes),
      parseNumericValue(entry.mean)
    ])
  );

  const mean5 = meansByInterval.get('5');
  const mean30 = meansByInterval.get('30');
  const mean60 = meansByInterval.get('60');

  if (mean5 === null || mean30 === null || mean60 === null) {
    return 'Stable';
  }

  if (mean5 <= mean60 * 0.85) {
    return 'Dropping';
  }

  if (mean5 >= mean60 * 1.15) {
    return 'Strengthening';
  }

  if (meetsIncreaseThreshold(mean5, mean30) && meetsIncreaseThreshold(mean30, mean60)) {
    return 'Strengthening';
  }

  if (meetsDecreaseThreshold(mean5, mean30) && meetsDecreaseThreshold(mean30, mean60)) {
    return 'Dropping';
  }

  return 'Stable';
}

async function getLaunchOptions() {
  const isLinux = process.platform === 'linux';

  const options = {
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ],
    timeout: 30000
  };

  if (isLinux) {
    try {
      const chromium = require('@sparticuz/chromium');
      const execPath = await chromium.executablePath();
      options.executablePath = execPath;
      options.args = chromium.args;
    } catch (e) {
      console.warn('Linux environment but @sparticuz/chromium not available:', e.message);
    }
  } else {
    // Windows/macOS: use the browser installed by @puppeteer/browsers
    const path = require('path');
    options.executablePath = path.join(
      __dirname,
      'chrome',
      'win64-146.0.7667.0',
      'chrome-win64',
      'chrome.exe'
    );
  }

  return options;
}

// NorthBerwick-only endpoint: intentionally fixed source and ignores query param location.
app.get('/api/livewind', async (req, res) => {
  let browser;
  try {
    const livewindConfig = LOCATION_PRESETS.northberwick.livewind;
    const meanMaxCacheKey = 'livewind:meanMax:northberwick';
    const meanMaxCacheTtlMs = 5 * 60 * 1000;
    const cachedMeanMax = getCachedValue(meanMaxCacheKey);
    if (cachedMeanMax) {
      console.log(`[livewind] Mean/max cache hit; using cached 5/30/60 values (refresh every ${Math.round(meanMaxCacheTtlMs / 60000)} minutes)`);
    } else {
      console.log(`[livewind] Mean/max cache miss; fetching 5/30/60 values from site (refresh every ${Math.round(meanMaxCacheTtlMs / 60000)} minutes)`);
    }

    const launchOptions = await getLaunchOptions();
    //console.log('Launching Puppeteer with options', { headless: launchOptions.headless, hasExecutable: !!launchOptions.executablePath, executablePath: typeof launchOptions.executablePath === 'string' ? launchOptions.executablePath : undefined });
    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.goto(livewindConfig.url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait until the table cells update from '---' to actual values (timeout after 10 seconds)
    await page.waitForFunction(() => {
      const latestVariable2 = document.querySelector('#latestVariable2');
      const latestVariable1 = document.querySelector('#latestVariable1');
      const latestTimestampEl = document.querySelector('#latestTimestamp');
      const speed = latestVariable2 ? latestVariable2.textContent.trim() : '---';
      const direction = latestVariable1 ? latestVariable1.textContent.trim() : '---';
      const timestamp = latestTimestampEl ? latestTimestampEl.textContent.trim() : '---';
      return speed !== '---' && direction !== '---' && timestamp !== '---';
    }, { timeout: 10000 });

    const windSpeedKnots = await page.$eval('#latestVariable2', el => el.textContent.trim());
    const windDirection = await page.$eval('#latestVariable1', el => el.textContent.trim());
    const latestTimestamp = await page.$eval('#latestTimestamp', el => el.textContent.trim());
    const windSpeed = convertKnotsToMph(windSpeedKnots);

    let meanMaxByInterval = cachedMeanMax || [];
    if (!cachedMeanMax) {
      const timeIntervals = ['5', '30', '60'];
      meanMaxByInterval = [];
      for (const interval of timeIntervals) {
        await page.evaluate((value) => {
          const radio = document.querySelector(`input[type="radio"][name="timeInterval"][value="${value}"]`);
          if (radio) {
            radio.click();
          }
        }, interval);

        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

        console.log(`[livewind] Reading mean/max row for ${interval} minute interval from site`);

        const rowValues = await page.evaluate(() => {
          const table = document.querySelector('#meanMaxTable');
          if (!table) {
            return null;
          }
          const row = table.querySelector('tbody tr') || table.querySelector('tr');
          if (!row) {
            return null;
          }
          const cells = Array.from(row.querySelectorAll('td, th')).slice(1, 4);
          if (cells.length < 3) {
            return null;
          }
          return cells.map(cell => cell.textContent.trim());
        });

        meanMaxByInterval.push({
          intervalMinutes: interval,
          min: rowValues ? convertKnotsToMph(rowValues[0]) : null,
          mean: rowValues ? convertKnotsToMph(rowValues[1]) : null,
          max: rowValues ? convertKnotsToMph(rowValues[2]) : null
        });
      }

      setCachedValue(meanMaxCacheKey, meanMaxByInterval, meanMaxCacheTtlMs);
      console.log(`[livewind] Mean/max cached for ${Math.round(meanMaxCacheTtlMs / 60000)} minutes`);
    }

    // Calculate windFrom based on windDirection
    const directionDegrees = parseInt(windDirection, 10);
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(directionDegrees / 45) % 8;
    const windFrom = directions[index];
  

    const trend = determineWindTrend(meanMaxByInterval);

    res.json({ windSpeed, windDirection, latestTimestamp, windFrom, trend, meanMaxByInterval, units: 'mph' });
  } catch (error) {
    //console.error('Error fetching or parsing wind data with Puppeteer:', error, { env: process.env.NODE_ENV, hasChromium: !!chromium });
    console.error('Error fetching or parsing wind data with Puppeteer:', error, { env: process.env.NODE_ENV });
    if (error && error.message && error.message.includes('Failed to launch the browser')) {
      return res.status(500).json({ error: 'Browser failed to launch', details: error.message });
    }
    res.status(500).json({ error: 'Failed to fetch wind data', details: error.message });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
  }
});

app.get('/api/tides', async (req, res) => {
  // Calls Admiralty API for tidal events. Defaults to station 0223 but can be overridden with ?station=XXXX
  const locationConfig = getLocationConfig(req.query.location);
  if (locationConfig.error) {
    return res.status(400).json({ error: locationConfig.error, details: locationConfig.message, supportedLocations: locationConfig.supportedLocations });
  }

  const station = req.query.station || locationConfig.tides.station;
  const cacheKey = `tides:${locationConfig.key}:station:${station}`;
  const cacheTtlMs = 10 * 60 * 1000;
  const cached = getCachedValue(cacheKey);
  if (cached) {
    console.log(`[tides] Cache hit for station ${station}; serving cached response`);
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(cached);
  }
  console.log(`[tides] Cache miss for station ${station}; fetching from API`);
  const admiraltyKey = process.env.ADMIRALTY_API_KEY;
  if (!admiraltyKey) {
    return res.status(500).json({ error: 'Server misconfiguration', details: 'ADMIRALTY_API_KEY is not set' });
  }
  const url = `https://admiraltyapi.azure-api.net/uktidalapi/api/V1/Stations/${encodeURIComponent(station)}/TidalEvents`;

  // node-fetch v3 is ESM only, so dynamically import it in CommonJS
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

  const controller = new AbortController();
  const timeoutMs = 15000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`[tides] Requesting Admiralty API for station ${station}`);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': admiraltyKey,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const bodyText = await response.text();
      return res.status(502).json({ error: 'Admiralty API returned non-OK status', status: response.status, body: bodyText });
    }

    const data = await response.json();
    setCachedValue(cacheKey, data, cacheTtlMs);
    console.log(`[tides] Caching response for station ${station} for ${Math.round(cacheTtlMs / 60000)} minutes`);
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(data);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Admiralty API request timed out' });
    }
    console.error('Error fetching tides from Admiralty API:', err);
    return res.status(500).json({ error: 'Failed to fetch tides', details: err.message });
  }
});

app.get('/api/weatherforecast', async (req, res) => {
  try {
    const locationConfig = getLocationConfig(req.query.location);
    if (locationConfig.error) {
      return res.status(400).json({ error: locationConfig.error, details: locationConfig.message, supportedLocations: locationConfig.supportedLocations });
    }

    const { latitude, longitude } = locationConfig.forecast;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=wind_speed_10m,wind_direction_10m,precipitation_probability,temperature_2m,weather_code&daily=sunrise,sunset&wind_speed_unit=mph&timezone=Europe%2FLondon`;
    const cacheKey = `weatherforecast:${locationConfig.key}`;
    const cacheTtlMs = 10 * 60 * 1000;
    const cached = getCachedValue(cacheKey);
    if (cached) {
      console.log('[weatherforecast] Cache hit; serving cached response');
      res.set('Cache-Control', 'public, max-age=600');
      return res.json(cached);
    }
    console.log('[weatherforecast] Cache miss; fetching from API');
    
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    console.log('[weatherforecast] Requesting Open-Meteo API');
    const response = await fetch(url);

    if (!response.ok) {
      const bodyText = await response.text();
      return res.status(502).json({ error: 'Open-Meteo API returned non-OK status', status: response.status, body: bodyText });
    }

    const data = await response.json();
    setCachedValue(cacheKey, data, cacheTtlMs);
    console.log(`[weatherforecast] Caching response for ${Math.round(cacheTtlMs / 60000)} minutes`);
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(data);
  } catch (error) {
    console.error('Error fetching weather forecast:', error);
    res.status(500).json({ error: 'Failed to fetch weather forecast', details: error.message });
  }
});

app.get('/api/waves', async (req, res) => {
  try {
    const locationConfig = getLocationConfig(req.query.location);
    if (locationConfig.error) {
      return res.status(400).json({ error: locationConfig.error, details: locationConfig.message, supportedLocations: locationConfig.supportedLocations });
    }

    const { latitude, longitude } = locationConfig.marine;
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${latitude}&longitude=${longitude}&daily=wave_height_max,wave_direction_dominant&timezone=Europe%2FLondon`;
    const cacheKey = `waves:${locationConfig.key}`;
    const cacheTtlMs = 10 * 60 * 1000;
    const cached = getCachedValue(cacheKey);
    if (cached) {
      console.log('[waves] Cache hit; serving cached response');
      res.set('Cache-Control', 'public, max-age=600');
      return res.json(cached);
    }
    console.log('[waves] Cache miss; fetching from API');

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    console.log('[waves] Requesting Open-Meteo marine API');
    const response = await fetch(url);

    if (!response.ok) {
      const bodyText = await response.text();
      return res.status(502).json({ error: 'Open-Meteo marine API returned non-OK status', status: response.status, body: bodyText });
    }

    const data = await response.json();
    setCachedValue(cacheKey, data, cacheTtlMs);
    console.log(`[waves] Caching response for ${Math.round(cacheTtlMs / 60000)} minutes`);
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(data);
  } catch (error) {
    console.error('Error fetching wave data:', error);
    res.status(500).json({ error: 'Failed to fetch wave data', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});