#!/usr/bin/env node
import HID from 'node-hid';
import assert from 'node:assert';

const VID = 0x3547, PID = 0x0407;

const READ_OPS = {
  voice_mode: 0x02, voice_level: 0x04, reverb: 0x06, eq: 0x08,
  fw: 0x0d, serial: 0x12, noise_cancel: 0x14, heartbeat: 0x1f,
  indicator: 0x22, mic_recognition: 0x24, speaker_out: 0x26,
  auto_power_off: 0x28, rx_mac: 0x30, tx_mac: 0x31, perf_mode: 0x46,
};

const SETTINGS = ['voice_mode', 'voice_level', 'reverb', 'eq', 'noise_cancel', 'indicator',
                  'mic_recognition', 'speaker_out', 'auto_power_off', 'perf_mode'];
const WRITABLE = SETTINGS.filter(k => k !== 'perf_mode');
const setOp = k => READ_OPS[k] - 1;

const NAMES = { indicator: { on: [0], off: [1] } };
const toBytes = (k, vals) => vals.length === 1 && Object.hasOwn(NAMES[k] ?? {}, vals[0]) ? NAMES[k][vals[0]] : vals.map(Number);
const fmt = (k, v) => {
  const name = Object.entries(NAMES[k] ?? {}).find(([, b]) => b.join() === v.join())?.[0];
  return name ? `${name} (${v.join(' ')})` : v.join(' ') || '(empty)';
};

function frame(cmd, payload = []) {
  const f = [0x05, 0x03, 0xaa, 0xdd, cmd, payload.length >> 8, payload.length & 0xff, ...payload, 0xef];
  while (f.length < 64) f.push(0);
  return f;
}

function parse(r) {
  if (r[2] !== 0xbb || r[3] !== 0xdd) throw new Error(`bad reply header ${r[2].toString(16)} ${r[3].toString(16)}`);
  const len = (r[5] << 8) | r[6];
  return { cmd: r[4], payload: r.slice(7, 7 + len), trailer: r[7 + len] };
}

function open() {
  const info = HID.devices().find(d => d.vendorId === VID && d.productId === PID);
  if (!info) {
    console.error('No Lark A1 receiver found. Is it plugged in?');
    process.exit(1);
  }
  return new HID.HID(info.path);
}

function send(dev, cmd, payload = []) {
  dev.sendFeatureReport(frame(cmd, payload));
  return parse(dev.getFeatureReport(0x05, 64));
}

const mac = b => [...b].reverse().map(x => x.toString(16).padStart(2, '0')).join(':');
const version = b => b.join('.');

function snapshot(dev) {
  const hb = send(dev, READ_OPS.heartbeat).payload;
  const units = [0, 1].map(i => {
    const m = send(dev, READ_OPS.tx_mac, [i]).payload;
    const f = send(dev, READ_OPS.fw, [i + 1]).payload;
    return {
      name: `TX${i + 1}`,
      online: hb[i] === 1,
      battery: hb[i + 2],
      mac: m.length === 7 ? mac(m.slice(1)) : null,
      fw: f.length === 5 ? version(f.slice(1)) : null,
    };
  });
  const settings = {};
  for (const k of SETTINGS) {
    settings[k] = [...send(dev, READ_OPS[k]).payload];
  }
  return {
    receiver: { mac: mac(send(dev, READ_OPS.rx_mac).payload), fw: version(send(dev, READ_OPS.fw, [0]).payload.slice(1)) },
    units, settings,
  };
}

function printStatus(s) {
  console.log(`\nLark A1 receiver  ${s.receiver.mac}  fw ${s.receiver.fw}\n`);
  for (const u of s.units) {
    const state = u.online ? `online  ${String(u.battery).padStart(3)}%` : 'off        ';
    console.log(`  ${u.name}  ${state}  ${u.mac ?? '(unpaired)'}  ${u.fw ? `fw ${u.fw}` : ''}`);
  }
  console.log();
  const w = Math.max(...Object.keys(s.settings).map(k => k.length));
  for (const [k, v] of Object.entries(s.settings)) {
    console.log(`  ${k.padEnd(w)}  ${fmt(k, v)}`);
  }
  console.log();
}

function selftest() {
  const f = frame(0x0d, [0x02]);
  assert.deepEqual(f.slice(0, 8), [0x05, 0x03, 0xaa, 0xdd, 0x0d, 0x00, 0x01, 0x02]);
  assert.equal(f[8], 0xef);
  assert.equal(f.length, 64);

  const hb = parse([0x05, 0x03, 0xbb, 0xdd, 0x1f, 0x00, 0x11,
    0x01, 0x01, 0x47, 0x37, 0, 0, 0, 0x02, 0x05, 0, 0x01, 0, 0x03, 0, 0x02, 0x01, 0x00, 0x1f]);
  assert.equal(hb.cmd, 0x1f);
  assert.equal(hb.payload.length, 17);
  assert.equal(hb.payload[2], 71);
  assert.equal(hb.payload[3], 55);
  assert.equal(hb.trailer, 0x1f);

  assert.equal(mac([0x6b, 0x97, 0x40, 0x28, 0x22, 0x38]), '38:22:28:40:97:6b');
  assert.throws(() => parse([0, 0, 0xaa, 0xdd, 0, 0, 0]), /bad reply header/);

  assert.equal(setOp('indicator'), 0x21);
  assert.equal(setOp('noise_cancel'), 0x13);
  assert.ok(!WRITABLE.includes('perf_mode'));

  assert.deepEqual(toBytes('indicator', ['off']), [1]);
  assert.deepEqual(toBytes('indicator', ['0']), [0]);
  assert.deepEqual(toBytes('eq', ['on']), [NaN]);
  assert.deepEqual(toBytes('indicator', ['toString']), [NaN]);
  assert.equal(fmt('indicator', [0]), 'on (0)');
  assert.equal(fmt('reverb', [0, 2]), '0 2');
  console.log('selftest ok');
}

const [cmd, ...args] = process.argv.slice(2);
const json = args.includes('--json') || process.argv.includes('--json');

if (cmd === '--selftest') { selftest(); process.exit(0); }

if (cmd === 'raw') {
  const op = parseInt(args[0], 16);
  if (!Object.values(READ_OPS).includes(op)) {
    console.error(`Refusing 0x${args[0]}: not a known read opcode. Writes and DFU are not supported by this tool.`);
    process.exit(1);
  }
  const dev = open();
  const r = send(dev, op, args.slice(1).filter(a => !a.startsWith('--')).map(a => parseInt(a, 16)));
  console.log(json ? JSON.stringify(r) : `cmd 0x${r.cmd.toString(16)}  payload ${r.payload.map(b => b.toString(16).padStart(2, '0')).join(' ')}  trailer 0x${r.trailer.toString(16)}`);
  dev.close();
} else if (cmd === 'set') {
  const [key, ...vals] = args.filter(a => !a.startsWith('--'));
  const bytes = toBytes(key, vals);
  if (!WRITABLE.includes(key) || !bytes.length || !bytes.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
    const named = Object.entries(NAMES).map(([k, n]) => `${k} ${Object.keys(n).join('|')}`).join(', ');
    console.error(`usage: lark set <setting> <byte> [byte...]   (decimal, as shown by lark status)\nsettings: ${WRITABLE.join(', ')}\nnamed values: ${named}`);
    process.exit(1);
  }
  const dev = open();
  const before = [...send(dev, READ_OPS[key]).payload];
  const ack = send(dev, setOp(key), bytes);
  const after = [...send(dev, READ_OPS[key]).payload];
  dev.close();
  const ok = after.join() === bytes.join();
  if (json) console.log(JSON.stringify({ setting: key, before, sent: bytes, ack: ack.payload, after, ok }));
  else console.log(`${key}  ${fmt(key, before)} -> ${fmt(key, after)}${ok ? '' : `   (sent ${bytes.join(' ')}, device reads back differently)`}`);
  if (!ok) process.exit(2);
} else if (cmd === 'watch') {
  const dev = open();
  const tick = () => {
    const hb = send(dev, READ_OPS.heartbeat).payload;
    const line = [0, 1].map(i => `TX${i + 1} ${hb[i] === 1 ? `${String(hb[i + 2]).padStart(3)}%` : ' off'}`).join('   ');
    process.stdout.write(`\r${line}   `);
  };
  tick();
  setInterval(tick, 2000);
} else if (cmd === 'status' || cmd === undefined) {
  const dev = open();
  const s = snapshot(dev);
  console.log(json ? JSON.stringify(s, null, 2) : '');
  if (!json) printStatus(s);
  dev.close();
} else {
  console.error(`usage: lark [status|watch|set <setting> <bytes>|raw <op hex> [args]] [--json]\n       lark --selftest`);
  process.exit(1);
}
