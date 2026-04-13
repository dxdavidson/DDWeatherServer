console.log("RUNNING SERVER FROM:", __filename);
require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3000;
app.set('trust proxy', true);

const cors = require('cors');
app.use(cors());

const cacheStore = new Map();
const WEBCAM_CACHE_TTL_MS = 60 * 1000;
const WEBCAM_IMAGE_CACHE_TTL_MS = 30 * 1000;
const WEBCAM_TIME_ZONE = 'Europe/London';
const LONDON_TIME_ZONE = 'Europe/London';
const UTC_ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|\+00:00|\+0000)?$/i;
const ISO_TIMESTAMP_HAS_EXPLICIT_ZONE_REGEX = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const webcamTimestampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: WEBCAM_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const webcamOffsetFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: WEBCAM_TIME_ZONE,
  timeZoneName: 'shortOffset'
});
const londonTimestampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});
const londonOffsetFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  timeZoneName: 'shortOffset'
});

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
    livewind: { url: 'http://88.97.23.70:82/' },
    webcam: {
      url: 'http://88.97.23.70/default.html',
      images: [
        { url: 'http://88.97.23.70/WebCam/craig_1.jpg', description: 'Start Line' },
        { url: 'http://88.97.23.70/WebCam/west_1.jpg', description: 'West Bay View' }
      ]
    }
  },
  northberwick: {
    forecast: { latitude: 56.06, longitude: -2.72 },
    marine: { latitude: 56.06, longitude: -2.72 },
    tides: { station: '0223' }, // Station 0223 is Fidra
    livewind: { url: 'http://88.97.23.70:82/' },
    webcam: {
      url: 'http://88.97.23.70/default.html',
      images: [
        { url: 'http://88.97.23.70/WebCam/craig_1.jpg', description: 'Start Line' },
        { url: 'http://88.97.23.70/WebCam/west_1.jpg', description: 'West Bay View' }
      ]
    }
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
      },
      webcam: {
        url: defaultPreset.webcam.url,
        images: defaultPreset.webcam.images
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

function formatWebcamTimestamp(date) {
  const parts = webcamTimestampFormatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return `${values.day}.${values.month}.${values.year} ${values.hour}:${values.minute}`;
}

function getWebcamOffsetMilliseconds(date) {
  const offsetValue = webcamOffsetFormatter
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')
    ?.value;

  if (!offsetValue) {
    return 0;
  }

  const match = offsetValue.match(/^GMT(?:(\+|-)(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match) {
    return 0;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2] || '0', 10);
  const minutes = Number.parseInt(match[3] || '0', 10);

  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getFormattedOffset(date, offsetFormatter) {
  const offsetValue = offsetFormatter
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')
    ?.value;

  if (!offsetValue) {
    return '+00:00';
  }

  const match = offsetValue.match(/^GMT(?:(\+|-)(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match) {
    return '+00:00';
  }

  const sign = match[1] === '-' ? '-' : '+';
  const hours = String(Number.parseInt(match[2] || '0', 10)).padStart(2, '0');
  const minutes = String(Number.parseInt(match[3] || '0', 10)).padStart(2, '0');

  return `${sign}${hours}:${minutes}`;
}

function formatDateToLondonIso(date) {
  const parts = londonTimestampFormatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  const offset = getFormattedOffset(date, londonOffsetFormatter);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

function convertUtcIsoToLondonIso(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!UTC_ISO_TIMESTAMP_REGEX.test(trimmed)) {
    return value;
  }

  const normalizedValue = ISO_TIMESTAMP_HAS_EXPLICIT_ZONE_REGEX.test(trimmed)
    ? trimmed
    : `${trimmed}Z`;

  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatDateToLondonIso(date);
}

function convertUtcTimesInPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map((item) => convertUtcTimesInPayload(item));
  }

  if (!payload || typeof payload !== 'object') {
    return convertUtcIsoToLondonIso(payload);
  }

  const converted = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      converted[key] = convertUtcIsoToLondonIso(value);
    } else {
      converted[key] = convertUtcTimesInPayload(value);
    }
  }

  return converted;
}

function createWebcamDate(year, monthIndex, day, hours, minutes) {
  let timestampMs = Date.UTC(year, monthIndex, day, hours, minutes, 0, 0);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMilliseconds = getWebcamOffsetMilliseconds(new Date(timestampMs));
    const adjustedTimestampMs = Date.UTC(year, monthIndex, day, hours, minutes, 0, 0) - offsetMilliseconds;

    if (adjustedTimestampMs === timestampMs) {
      break;
    }

    timestampMs = adjustedTimestampMs;
  }

  return new Date(timestampMs);
}

function parseWebcamTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const day = Number.parseInt(match[1], 10);
  const monthIndex = Number.parseInt(match[2], 10) - 1;
  const year = Number.parseInt(match[3], 10);
  const hours = Number.parseInt(match[4], 10);
  const minutes = Number.parseInt(match[5], 10);
  const timestamp = createWebcamDate(year, monthIndex, day, hours, minutes);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getWebcamStatus(lastUpdated) {
  const updatedAt = parseWebcamTimestamp(lastUpdated);
  if (!updatedAt) {
    return 'Inactive';
  }

  const ageMs = Math.abs(Date.now() - updatedAt.getTime());
  return ageMs <= 5 * 60 * 1000 ? 'Active' : 'Inactive';
}

function getFetch() {
  return (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

function sanitizeCameraId(rawValue) {
  return String(rawValue || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getLocationFromRequest(req) {
  const locationConfig = getLocationConfig(req.query.location);
  if (locationConfig.error) {
    return { error: locationConfig };
  }
  return { locationConfig };
}

function buildWebcamImageMap(webcamConfig) {
  const images = Array.isArray(webcamConfig?.images) ? webcamConfig.images : [];
  const map = new Map();

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index] || {};
    const imageUrl = typeof image.url === 'string' ? image.url.trim() : '';
    if (!imageUrl) {
      continue;
    }

    const idBase = sanitizeCameraId(image.description || `camera-${index + 1}`) || `camera-${index + 1}`;
    const uniqueId = map.has(idBase) ? `${idBase}-${index + 1}` : idBase;

    map.set(uniqueId, {
      id: uniqueId,
      url: imageUrl,
      description: image.description || `Camera ${index + 1}`
    });
  }

  return map;
}

function getPublicOrigin(req) {
  const forwardedProtoHeader = req.get('x-forwarded-proto');
  const forwardedHostHeader = req.get('x-forwarded-host');

  const forwardedProto = typeof forwardedProtoHeader === 'string'
    ? forwardedProtoHeader.split(',')[0].trim()
    : '';
  const forwardedHost = typeof forwardedHostHeader === 'string'
    ? forwardedHostHeader.split(',')[0].trim()
    : '';

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const protocol = req.protocol || 'http';
  const host = req.get('host') || '';
  return `${protocol}://${host}`;
}

function getWebcamImageProxyPath(locationLabel, cameraId) {
  const params = new URLSearchParams({ location: locationLabel, cam: cameraId });
  return `/api/webcam/image?${params.toString()}`;
}

function mapWebcamImagesForClient(images, locationLabel, req) {
  const mappedImages = [];
  const imageMap = buildWebcamImageMap({ images });
  const origin = getPublicOrigin(req);

  for (const image of imageMap.values()) {
    const path = getWebcamImageProxyPath(locationLabel, image.id);
    const absoluteUrl = `${origin}${path}`;
    mappedImages.push({
      id: image.id,
      description: image.description,
      url: absoluteUrl,
      absoluteUrl,
      path
    });
  }

  return mappedImages;
}

async function fetchWebcamData(webcamConfig) {
  const webcamUrl = webcamConfig.url;
  const cacheKey = `webcam:${webcamUrl}`;
  const cached = getCachedValue(cacheKey);
  if (cached) {
    console.log('[webcam] Cache hit; serving cached response');
    return cached;
  }

  console.log('[webcam] Cache miss; fetching webcam metadata');
  const fetch = getFetch();
  const { JSDOM } = require('jsdom');

  const response = await fetch(webcamUrl, {
    headers: {
      'Cache-Control': 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Webcam page returned non-OK status ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html);
  const lastupdated = dom.window.document.querySelector('#datetime')?.textContent?.trim() || formatWebcamTimestamp(new Date());
  const webcamData = {
    status: getWebcamStatus(lastupdated),
    lastupdated,
    images: Array.isArray(webcamConfig.images) ? webcamConfig.images : []
  };

  if (lastupdated !== null) {
    setCachedValue(cacheKey, webcamData, WEBCAM_CACHE_TTL_MS);
    console.log(`[webcam] Caching response for ${Math.round(WEBCAM_CACHE_TTL_MS / 1000)} seconds`);
  }

  return webcamData;
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

app.get('/api/webcam', async (req, res) => {
  try {
    const locationResult = getLocationFromRequest(req);
    if (locationResult.error) {
      const details = locationResult.error;
      return res.status(400).json({ error: details.error, details: details.message, supportedLocations: details.supportedLocations });
    }

    const { locationConfig } = locationResult;

    const webcamData = await fetchWebcamData(locationConfig.webcam);
    const responseData = {
      ...webcamData,
      images: mapWebcamImagesForClient(webcamData.images, locationConfig.label, req)
    };

    res.set('Cache-Control', `public, max-age=${Math.round(WEBCAM_CACHE_TTL_MS / 1000)}`);
    return res.json(responseData);
  } catch (error) {
    console.error('Error fetching webcam data:', error);
    return res.status(500).json({ error: 'Failed to fetch webcam data', details: error.message });
  }
});

app.get('/api/webcam/image', async (req, res) => {
  try {
    const locationResult = getLocationFromRequest(req);
    if (locationResult.error) {
      const details = locationResult.error;
      return res.status(400).json({ error: details.error, details: details.message, supportedLocations: details.supportedLocations });
    }

    const { locationConfig } = locationResult;
    const requestedCameraId = sanitizeCameraId(req.query.cam);
    if (!requestedCameraId) {
      return res.status(400).json({ error: 'Missing camera id', details: 'Provide ?cam=<camera-id>' });
    }

    const imageMap = buildWebcamImageMap(locationConfig.webcam);
    const camera = imageMap.get(requestedCameraId);

    if (!camera) {
      return res.status(404).json({ error: 'Camera not found', details: 'Camera id is not valid for the selected location' });
    }

    const cacheKey = `webcam:image:${locationConfig.key}:${camera.id}`;
    const cachedImage = getCachedValue(cacheKey);

    if (cachedImage) {
      res.set('Content-Type', cachedImage.contentType);
      res.set('Cache-Control', `public, max-age=${Math.round(WEBCAM_IMAGE_CACHE_TTL_MS / 1000)}`);
      return res.send(cachedImage.buffer);
    }

    const fetch = getFetch();
    const upstreamResponse = await fetch(camera.url, {
      headers: {
        'Cache-Control': 'no-cache'
      }
    });

    if (!upstreamResponse.ok) {
      return res.status(502).json({ error: 'Upstream webcam image returned non-OK status', status: upstreamResponse.status });
    }

    const contentType = upstreamResponse.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await upstreamResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    setCachedValue(cacheKey, { buffer, contentType }, WEBCAM_IMAGE_CACHE_TTL_MS);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', `public, max-age=${Math.round(WEBCAM_IMAGE_CACHE_TTL_MS / 1000)}`);
    return res.send(buffer);
  } catch (error) {
    console.error('Error fetching webcam image:', error);
    return res.status(500).json({ error: 'Failed to fetch webcam image', details: error.message });
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
    const localizedData = convertUtcTimesInPayload(data);
    setCachedValue(cacheKey, localizedData, cacheTtlMs);
    console.log(`[tides] Caching response for station ${station} for ${Math.round(cacheTtlMs / 60000)} minutes`);
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(localizedData);
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
    
    const fetch = getFetch();
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