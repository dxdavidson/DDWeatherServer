# DDWeatherServer

Express proxy server for weather, wave, tide, and live wind data.

## Data sources by endpoint

- `/api/weatherforecast`
   - Source: Open-Meteo Forecast API (`https://api.open-meteo.com/v1/forecast`)
   - Data returned: hourly wind speed/direction, precipitation probability, temperature, weather code, plus daily sunrise/sunset
- `/api/waves`
   - Source: Open-Meteo Marine API (`https://marine-api.open-meteo.com/v1/marine`)
   - Data returned: daily maximum wave height and dominant wave direction
- `/api/tides`
   - Source: UK Admiralty Tidal API (`https://admiraltyapi.azure-api.net/uktidalapi/api/V1/...`)
   - Data returned: tidal events for the selected station
   - Auth: requires `ADMIRALTY_API_KEY`
- `/api/livewind`
   - Source: live wind station webpage configured in `LOCATION_PRESETS.northberwick.livewind.url`
   - Retrieval method: page scrape via Puppeteer (not a JSON API)
   - Data returned: latest wind speed/direction/time and min/mean/max values for 5/30/60-minute intervals

## Prerequisites

- Node.js 18+ (includes npm)
- Internet access to external APIs/services
- Admiralty API subscription key for tides (`ADMIRALTY_API_KEY`)

## New install setup

1. Clone the repository and open it:
   - `git clone <your-repo-url>`
   - `cd DDWeatherServer`
2. Install dependencies:
   - `npm install`
3. Create your local environment file from the example:
   - PowerShell: `Copy-Item .env.example .env`
4. Edit `.env` and set your real key:
   - `ADMIRALTY_API_KEY=your_real_admiralty_key`

## Run the server

- Start:
  - `npm start`
- Expected output:
  - `Proxy server running on port 3000`

The server uses `dotenv`, so values in `.env` are loaded automatically when `npm start` runs.

## Quick API checks

Open these in your browser or use curl:

- `http://localhost:3000/api/weatherforecast`
- `http://localhost:3000/api/waves`
- `http://localhost:3000/api/tides`
- `http://localhost:3000/api/livewind`

Optional location query examples:

- `http://localhost:3000/api/weatherforecast?location=northberwick`
- `http://localhost:3000/api/waves?location=56.06,-2.72`

## Notes

- `.env` is gitignored and should never be committed.
- If `ADMIRALTY_API_KEY` is missing, `/api/tides` returns a server misconfiguration error.
- On Windows/macOS, Puppeteer uses the bundled browser path under `chrome/` in this repo.
