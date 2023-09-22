#!/usr/bin/env node
import express, { Express } from 'express';
import yargs = require('yargs');
import client, { register } from 'prom-client';
import fetch from 'node-fetch';
import { hex2float } from './utils';
import { Payload, ResponsePayload } from './types';

const DEFAULT_https_PORT = 9898;
const expr: Express = express();
expr.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

interface ClientOptions {
  host: string;
  port?: number;
  interval?: number;
  debug?: boolean;
  wallbox?: boolean;
}

const options: ClientOptions = yargs
  .options({
    host: {
      alias: 'h',
      description: 'Specify SENEC System HOST or IP',
      type: 'string',
      demandOption: true,
    },
    port: { description: 'Used https port', default: DEFAULT_https_PORT },
    wallbox: {
      alias: 'w',
      description: 'Scrape info about wallbox',
      boolean: true,
      default: false,
    },
    interval: { alias: 'i', description: 'Scraping interval in seconds', default: 60 },
    debug: { alias: 'd', description: 'Debug mode', boolean: true, default: false },
  })
  .help().argv;

function generatePayload(options: ClientOptions): Payload {
  const payload: Payload = {
    ENERGY: {
      GUI_BAT_DATA_POWER: '',
      GUI_INVERTER_POWER: '',
      GUI_HOUSE_POW: '',
      GUI_GRID_POW: '',
      GUI_BAT_DATA_FUEL_CHARGE: '',
    },
  };
  if (options.wallbox) {
    payload.WALLBOX = {
      HW_TYPE: '',
      APPARENT_CHARGING_POWER: '',
      UTMP: '',
      L1_CHARGING_CURRENT: '',
      L2_CHARGING_CURRENT: '',
      L3_CHARGING_CURRENT: '',
      MAX_CHARGING_CURRENT_IC: '',
      MAX_CHARGING_CURRENT_RATED: '',
      MAX_CHARGING_CURRENT_DEFAULT: '',
      MAX_CHARGING_CURRENT_ICMAX: '',
      PROHIBIT_USAGE: '',
      STATE: '',
    };
  }
  return payload;
}

const metrics = {
  batteryLevel: new client.Gauge({
    name: 'senec_battery_level',
    help: 'Current Battery Level (percentage)',
  }),

  batteryChargingPower: new client.Gauge({
    name: 'senec_battery_charging_power',
    help: 'Current Battery Charging Power',
  }),

  batteryDischargingPower: new client.Gauge({
    name: 'senec_battery_discharging_power',
    help: 'Current Battery Discharging Power',
  }),

  housePower: new client.Gauge({
    name: 'senec_house_consumption',
    help: 'Current House Consumption',
  }),

  gridPower: new client.Gauge({
    name: 'senec_grid_consumption',
    help: 'Current Consumption from the Drid',
  }),

  gridPowerEmission: new client.Gauge({
    name: 'senec_grid_emission',
    help: 'Current power emitted to the Drid',
  }),

  solarPower: new client.Gauge({
    name: 'senec_solar_power',
    help: 'Current Solar Production Power',
  }),

  wallboxPower: new client.Gauge({
    name: 'senec_wallbox_power',
    help: 'Current Wallbox Consumption Power',
  }),

  wallboxState: new client.Gauge({
    name: 'senec_wallbox_state',
    help: 'Current Wallbox State',
  }),
};

function exposeSolarPanelsMetrics(data: ResponsePayload) {
  const batteryChargingPower = hex2float(data.ENERGY.GUI_BAT_DATA_POWER.replace('fl_', ''));
  const solarPower = hex2float(data.ENERGY.GUI_INVERTER_POWER.replace('fl_', ''));
  const housePower = hex2float(data.ENERGY.GUI_HOUSE_POW.replace('fl_', ''));
  const gridPower = hex2float(data.ENERGY.GUI_GRID_POW.replace('fl_', ''));
  const batteryLevel = hex2float(data.ENERGY.GUI_BAT_DATA_FUEL_CHARGE.replace('fl_', ''));

  metrics.batteryChargingPower.set(batteryChargingPower > 0 ? batteryChargingPower : 0);
  metrics.batteryDischargingPower.set(batteryChargingPower < 0 ? -batteryChargingPower : 0);
  metrics.batteryLevel.set(batteryLevel);
  metrics.solarPower.set(solarPower);
  metrics.housePower.set(housePower);
  metrics.gridPower.set(gridPower > 0 ? gridPower : 0);
  metrics.gridPowerEmission.set(gridPower < 0 ? -gridPower : 0);

  if (options.debug) {
    console.log(`batteryChargingPower: ${batteryChargingPower > 0 ? batteryChargingPower : 0}`);
    console.log(`batteryDischargingPower: ${batteryChargingPower < 0 ? -batteryChargingPower : 0}`);
    console.log(`solarPower: ${solarPower}`);
    console.log(`housePower: ${housePower}`);
    console.log(`gridPower: ${gridPower > 0 ? gridPower : 0}`);
    console.log(`gridPowerEmission: ${gridPower < 0 ? -gridPower : 0}`);
    console.log(`batteryLevel: ${batteryLevel}`);
  }
}

function exposeWallboxMetrics(data: ResponsePayload) {
  if (data.WALLBOX) {
    const wallboxState = parseInt(data.WALLBOX.APPARENT_CHARGING_POWER[0].replace('u8_', ''), 16);

    const wallboxPowerConsumption = hex2float(
      data.WALLBOX.APPARENT_CHARGING_POWER[0].replace('fl_', '')
    );

    metrics.wallboxPower.set(wallboxPowerConsumption);
    metrics.wallboxState.set(wallboxState);

    if (options.debug) {
      console.log(`wallboxPowerConsumption: ${wallboxPowerConsumption}`);
      console.log(`wallboxState: ${wallboxState}`);
    }
  }
}

async function readSenecData(options: ClientOptions) {
  try {
    const response = await fetch(`https://${options.host}/lala.cgi`, {
      method: 'POST',
      body: JSON.stringify(generatePayload(options)),
    });
    const data: ResponsePayload = await response.json();
    exposeSolarPanelsMetrics(data);
    exposeWallboxMetrics(data);
  } catch (error) {
    console.log(error);
  }
}

async function run() {
  if (options.debug) {
    console.log(options);
  }
  try {
    const server = expr.listen(options.port);
    console.log(`Exporter listening on port ${options.port}...(press CTRL+c to interrupt)`);
    const timeout = setInterval(async () => await readSenecData(options), options.interval * 1000);
    await readSenecData(options);
    return new Promise<void>(resolve => {
      process.stdin.on('keypress', async (str, key) => {
        if (key.ctrl && key.name === 'c') {
          clearInterval(timeout);
          server.close();
          resolve();
        }
      });
    });
  } catch (e) {
    console.error(e.message, e);
    throw e;
  }
}

run()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch(e => {
    console.error(`Exiting...${e.message}`);
    process.exit(1);
  });
