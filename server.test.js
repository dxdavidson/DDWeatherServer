const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('Burghead live wind includes the Ecowitt 10-minute average direction', async () => {
  const routes = new Map();
  const app = {
    set() {},
    use() {},
    get(route, handler) { routes.set(route, handler); },
    listen() {}
  };
  const context = vm.createContext({
    __filename: path.join(__dirname, 'server.js'),
    console: { log() {}, error() {} },
    process: { env: { ECOWITT_APPLICATION_KEY: 'test', ECOWITT_API_KEY: 'test', ECOWITT_MAC: 'test' } },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'express') return () => app;
      if (name === 'cors') return () => () => {};
      if (name === 'puppeteer') return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
    URL
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), context);
  vm.runInContext('getFetch = () => mockFetch; wait = async () => {};', context);

  for (const [value, expected] of [['245', 245], ['0', 0], [undefined, null], ['invalid', null]]) {
    const wind = {
      wind_speed: { value: '12' },
      wind_direction: { value: '240' }
    };
    if (value !== undefined) wind['10_minute_average_wind_direction'] = { value };
    const requests = [];
    context.mockFetch = async (url) => {
      requests.push(new URL(url));
      const data = requests.length === 1 ? { wind } : { wind: { wind_speed: { list: {} } } };
      return { ok: true, json: async () => ({ code: 0, data }) };
    };
    let response;
    await routes.get('/api/livewind')({ query: { location: 'burghead' } }, {
      json(body) { response = body; },
      status(code) { throw new Error(`Unexpected status ${code}`); }
    });

    assert.equal(response.windDirection10MinuteAverage, expected);
    assert.equal(response.windDirection, 240);
    assert.equal(response.windSpeed, 12);
    assert.equal(requests[0].searchParams.get('call_back'), 'wind');
  }
});
