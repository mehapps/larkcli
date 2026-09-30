#!/usr/bin/env node
import { DRIVERS, findDevice, fmt, writable, selftest } from './devices.js';

const [cmd, ...args] = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter(a => !a.startsWith('--'));
const hex = b => b.map(x => x.toString(16).padStart(2, '0')).join(' ');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function connect() {
  const found = findDevice();
  if (!found) fail(`No supported Hollyland receiver found. Is it plugged in?\nSupported: ${DRIVERS.map(d => d.name).join(', ')}`);
  if (!found.driver.tested && !json) console.error(`${found.driver.name}: support is untested. See README.`);
  return { driver: found.driver, session: found.driver.open(found.info) };
}

function run(fn) {
  const { driver, session } = connect();
  try {
    return fn(driver, session);
  } catch (e) {
    if (e.usage) fail(e.message);
    throw e;
  } finally {
    session.close();
  }
}

function setUsage(driver) {
  const lines = writable(driver).map(k => {
    const s = driver.settings[k];
    return `  ${k.padEnd(16)}${s.names ? Object.keys(s.names).join(' | ') : ''}${s.hint ? `${s.names ? '   ' : ''}${s.hint}` : ''}`;
  });
  fail(`usage: lark set <setting> <name | bytes...>\n\n${driver.name} settings:\n${lines.join('\n')}`);
}

function printStatus(driver, s) {
  const rx = s.receiver ? `  ${s.receiver.mac}  fw ${s.receiver.fw}` : '';
  console.log(`\n${s.model} receiver${rx}${driver.tested ? '' : '  (untested)'}\n`);
  s.units.forEach((u, i) => {
    const state = u.online ? `online  ${String(u.battery).padStart(3)}%` : 'off'.padEnd(12);
    const extra = [u.mac, u.fw && `fw ${u.fw}`].filter(Boolean).join('  ');
    console.log(`  TX${i + 1}  ${state}  ${u.muted ? 'muted' : '     '}  ${extra}`.trimEnd());
  });
  console.log();
  const w = Math.max(...Object.keys(s.settings).map(k => k.length));
  for (const [k, v] of Object.entries(s.settings)) console.log(`  ${k.padEnd(w)}  ${fmt(driver.settings[k], v)}`);
  console.log();
}

if (cmd === '--selftest') {
  selftest();
  console.log('selftest ok');
} else if (cmd === 'status' || cmd === undefined) {
  run((driver, session) => {
    const s = session.status();
    if (json) console.log(JSON.stringify({ ...s, tested: driver.tested }, null, 2));
    else printStatus(driver, s);
  });
} else if (cmd === 'set') {
  const [key, ...vals] = positional;
  run((driver, session) => {
    if (!writable(driver).includes(key) || !vals.length) setUsage(driver);
    const r = session.set(key, vals);
    const s = driver.settings[key];
    if (json) console.log(JSON.stringify(r));
    else console.log(`${key}  ${fmt(s, r.before)} -> ${fmt(s, r.after)}${r.ok ? '' :
      `   (sent ${r.sent.join(' ')}, reply ${hex(r.ack)}. Most settings need at least one transmitter on)`}`);
    if (!r.ok) process.exitCode = 2;
  });
} else if (cmd === 'mute' || cmd === 'unmute') {
  const tx = Number(positional[0]);
  run((driver, session) => {
    if (!session.mute) fail(`${driver.name} has no mute command over USB.`);
    if (![1, 2, 3, 4].includes(tx)) fail(`usage: lark ${cmd} <transmitter 1-4>`);
    const r = session.mute(tx, cmd === 'mute');
    if (json) console.log(JSON.stringify(r));
    else console.log(r.ok ? `TX${tx} ${r.muted ? 'muted' : 'unmuted'}` : `TX${tx} did not change (reply ${hex(r.ack)}). Is it on?`);
    if (!r.ok) process.exitCode = 2;
  });
} else if (cmd === 'watch') {
  connect().session.close();
  const tick = () => {
    const found = findDevice();
    if (!found) return process.stdout.write('\rreceiver unplugged   ');
    const session = found.driver.open(found.info);
    try {
      const line = session.units()
        .map((t, i) => `TX${i + 1} ${t.online ? `${String(t.battery).padStart(3)}%${t.muted ? ' muted' : ''}` : ' off'}`).join('   ');
      process.stdout.write(`\r${line}   `);
    } finally {
      session.close();
    }
  };
  tick();
  setInterval(tick, 2000);
} else if (cmd === 'raw') {
  run((driver, session) => {
    if (!session.raw) fail(`raw is only available for tested models.`);
    const r = session.raw(parseInt(positional[0], 16), positional.slice(1).map(a => parseInt(a, 16)));
    console.log(json ? JSON.stringify(r) : `cmd 0x${r.cmd.toString(16)}  payload ${hex(r.payload)}  trailer 0x${r.trailer.toString(16)}`);
  });
} else {
  fail(`usage: lark [status | watch | set <setting> <value> | mute <tx> | unmute <tx> | raw <op hex> [args]] [--json]\n       lark --selftest`);
}
