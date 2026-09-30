import HID from 'node-hid';
import assert from 'node:assert';

const HOLLYLAND = 0x3547, EAGLESHERO = 0x4417;

const resolve = (x, cur) => typeof x === 'function' ? x(cur) : x;
export function toBytes(setting, vals, cur = []) {
  const names = setting?.names ?? {};
  return vals.length === 1 && Object.hasOwn(names, vals[0]) ? resolve(names[vals[0]], cur) : vals.map(Number);
}
export function fmt(setting, v) {
  const name = Object.entries(setting?.names ?? {}).find(([, x]) => resolve(x, v).join() === v.join())?.[0];
  return name ? `${name} (${v.join(' ')})` : v.join(' ') || '(empty)';
}
const validBytes = b => b.length > 0 && b.every(x => Number.isInteger(x) && x >= 0 && x <= 255);
const usageError = msg => Object.assign(new Error(msg), { usage: true });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pad = (b, n) => [...b, ...Array(Math.max(0, n - b.length)).fill(0)];
const offKeepLevel = b => [0, b[1] ?? 0];
const onOff = { off: [0], on: [1] };

const A1_OPS = {
  voice_mode: 0x02, voice_level: 0x04, reverb: 0x06, eq: 0x08,
  fw: 0x0d, serial: 0x12, noise_cancel: 0x14, heartbeat: 0x1f,
  indicator: 0x22, mic_recognition: 0x24, speaker_out: 0x26,
  auto_power_off: 0x28, rx_mac: 0x30, tx_mac: 0x31, signal_mode: 0x40, enhanced_mode: 0x46,
};
const A1_MUTE = 0x16;

export function a1Frame(cmd, payload = []) {
  return pad([0x05, 0x03, 0xaa, 0xdd, cmd, payload.length >> 8, payload.length & 0xff, ...payload, 0xef], 64);
}

export function a1Parse(r) {
  if (r[2] !== 0xbb || r[3] !== 0xdd) throw new Error(`bad reply header ${r[2]?.toString(16)} ${r[3]?.toString(16)}`);
  const len = (r[5] << 8) | r[6];
  return { cmd: r[4], payload: [...r.slice(7, 7 + len)], trailer: r[7 + len] };
}

const A1_HB = { online: [0, 1, 17, 18], battery: [2, 3, 19, 20], muted: [4, 5, 21, 22] };
export const a1Units = hb => A1_HB.online.slice(0, hb.length >= 23 ? 4 : 2).map((_, i) => ({
  online: hb[A1_HB.online[i]] === 1, battery: hb[A1_HB.battery[i]], muted: hb[A1_HB.muted[i]] === 1,
}));

const mac = b => [...b].reverse().map(x => x.toString(16).padStart(2, '0')).join(':');
const version = b => b.join('.');

const A1 = {
  name: 'Lark A1',
  tested: true,
  ids: [[HOLLYLAND, 0x0407]],
  settings: {
    voice_mode: { names: { mono: [0], stereo: [1] } },
    voice_level: { hint: "0-5 (the app's steps 1-6)" },
    reverb: { names: { off: offKeepLevel, small: [1, 0], medium: [1, 1], large: [1, 2] } },
    eq: { names: { low: [1], bright: [2], balanced: [3] } },
    noise_cancel: { names: { off: offKeepLevel, weak: [1, 0], medium: [1, 1], strong: [1, 2] } },
    indicator: { names: { on: [0], off: [1] } },
    mic_recognition: { names: onOff },
    auto_power_off: { names: { '15min': [0], never: [1] } },
    signal_mode: { names: { normal: [0], performance: [1] }, readOnly: true },
    enhanced_mode: { names: onOff, readOnly: true },
  },
  open(info) {
    const dev = new HID.HID(info.path);
    const send = (cmd, payload = []) => {
      dev.sendFeatureReport(a1Frame(cmd, payload));
      return a1Parse(dev.getFeatureReport(0x05, 64));
    };
    const read = k => send(A1_OPS[k]).payload;
    return {
      units: () => a1Units(read('heartbeat')),
      status() {
        const units = a1Units(read('heartbeat')).map((t, i) => {
          const m = send(A1_OPS.tx_mac, [i]).payload;
          const f = send(A1_OPS.fw, [i + 1]).payload;
          return { ...t, mac: m.length === 7 ? mac(m.slice(1)) : null, fw: f.length === 5 ? version(f.slice(1)) : null };
        });
        const settings = Object.fromEntries(Object.keys(A1.settings).map(k => [k, read(k)]));
        const receiver = { mac: mac(read('rx_mac')), fw: version(send(A1_OPS.fw, [0]).payload.slice(1)) };
        return { model: A1.name, receiver, units, settings };
      },
      set(key, vals) {
        const before = read(key);
        const sent = toBytes(A1.settings[key], vals, before);
        if (!validBytes(sent)) throw usageError(`bad value for ${key}`);
        const ack = send(A1_OPS[key] - 1, sent).payload;
        const after = read(key);
        return { setting: key, before, sent, ack, after, ok: ack[0] === 0 && after.join() === sent.join() };
      },
      mute(tx, on) {
        const ack = send(A1_MUTE, [tx - 1, on ? 1 : 0]).payload;
        const muted = a1Units(read('heartbeat'))[tx - 1]?.muted ?? null;
        return { tx, muted, ack, ok: ack[0] === 0 && muted === on };
      },
      raw(op, payload) {
        if (!Object.values(A1_OPS).includes(op)) throw usageError(`refusing 0x${op.toString(16)}: not a known read opcode`);
        return send(op, payload);
      },
      close: () => dev.close(),
    };
  },
};

const headerAt = d => [0, 1].find(i => (d[i] === 0xaa || d[i] === 0xbb) && d[i + 1] === 0xdd) ?? -1;

export const legacyFrame = (cmd, payload, target = 0x40) =>
  pad([0x00, 0xaa, 0xdd, cmd, target, payload.length >> 8, payload.length & 0xff, ...payload], 65);

export function legacyParse(d) {
  const i = headerAt(d);
  if (i < 0) return [];
  const len = (d[i + 4] << 8) | d[i + 5];
  return [{ cmd: d[i + 2], payload: [...d.slice(i + 6, i + 6 + len)] }];
}

export const tlvFrame = ({ reportId = 0, ctrl, wrap = false, size = 65 }) => (cmd, payload, target) => {
  const body = [0xaa, 0xdd, 0x06, target, ctrl, 0, wrap ? 3 : 1,
    ...(wrap ? [0x5a, 0xfa, 0, 0, 0] : []),
    cmd >> 8, cmd & 0xff, 0x01, payload.length >> 8, payload.length & 0xff, ...payload,
    ...(wrap ? [0x5e, 0xfe, 0, 0, 0] : [])];
  if (ctrl & 0x04) body.push(body.reduce((a, b) => a ^ b, reportId));
  return pad([reportId, ...body], size);
};

export function tlvParse(d) {
  const i = headerAt(d);
  if (i < 0) return [];
  const count = (d[i + 5] << 8) | d[i + 6];
  const out = [];
  for (let n = 0, p = i + 7; n < count && p + 5 <= d.length; n++) {
    if ((d[p] === 0x5a && d[p + 1] === 0xfa) || (d[p] === 0x5e && d[p + 1] === 0xfe)) { p += 5; continue; }
    const len = (d[p + 3] << 8) | d[p + 4];
    out.push({ cmd: (d[p] << 8) | d[p + 1], payload: [...d.slice(p + 5, p + 5 + len)] });
    p += 5 + len;
  }
  return out;
}

const bit = (b, i) => ((b >> i) & 1) === 1;
const byteAt = i => hb => [hb[i]];

const V1_BASE = {
  frame: legacyFrame, parse: legacyParse, target: 0x40, heartbeat: 0x10,
  units: hb => [0, 1].map(i => ({ online: hb[i] === 1, battery: hb[2 + i], muted: null })),
};
const V1_SETTINGS = {
  noise_cancel: { cmd: 0x06, read: byteAt(6), names: { weak: [1], strong: [2] } },
  volume: { cmd: 0x05, read: byteAt(7), hint: '0-5 raw; step order differs by model' },
  volume_lock: { cmd: 0x34, read: byteAt(8), names: { unlocked: [0], locked: [1] } },
};

const V1 = {
  ...V1_BASE,
  name: 'Lark C1 / M1 / Mini / M2',
  ids: [[HOLLYLAND, 0x01], [HOLLYLAND, 0x0b], [HOLLYLAND, 0x0c], [HOLLYLAND, 0x0d],
        [HOLLYLAND, 0x07], [HOLLYLAND, 0x08], [EAGLESHERO, 0x20], [EAGLESHERO, 0x21]],
  settings: V1_SETTINGS,
};

const M2S = {
  ...V1_BASE,
  name: 'Lark M2S',
  ids: [[HOLLYLAND, 0x0405], [HOLLYLAND, 0x0406]],
  settings: {
    ...V1_SETTINGS,
    voice_mode: { cmd: 0x18, read: byteAt(9), names: { mono: [0], stereo: [1] } },
    auto_power_off: { cmd: 0x36, read: byteAt(10), names: { '15min': [0], never: [1] } },
    indicator: { cmd: 0x39, read: byteAt(13), names: { on: [0], off: [1] } },
  },
};

const A2 = {
  ...V1_BASE,
  name: 'Lark A2',
  ids: [[HOLLYLAND, 0x0411], [HOLLYLAND, 0x8775]],
  units: hb => [0, 1].map(i => ({ online: hb[i] === 1, battery: hb[2 + i], muted: bit(hb[15], i) })),
  settings: {
    noise_cancel: { cmd: 0x06, read: byteAt(6), names: { weak: [1], medium: [2], strong: [3] } },
    volume: { cmd: 0x05, read: byteAt(7), hint: "0-5 (the app's steps 1-6)" },
    voice_mode: { cmd: 0x18, read: byteAt(9), names: { mono: [0], stereo: [1], safety: [2] } },
    auto_power_off: { cmd: 0x36, read: byteAt(10), names: { '15min': [0], never: [1] } },
    indicator: { cmd: 0x39, read: byteAt(13), names: { on: [0], off: [1] } },
    voice_preset: {
      cmd: 0x3a, read: hb => [hb[14] & 1, hb[14] >> 1],
      names: { off: offKeepLevel, bright: [1, 0], low: [1, 1], balanced: [1, 2] },
    },
  },
};

const M3_4CH = [0x040d, 0x040f];
const M3 = {
  name: 'Lark M3',
  ids: [0x040c, 0x040d, 0x040e, 0x040f].map(p => [HOLLYLAND, p]),
  frame: tlvFrame({ reportId: 0x08, ctrl: 0x00, size: 64 }), parse: tlvParse, target: 0x00, heartbeat: 0x6000,
  units: (hb, pid) => Array.from({ length: M3_4CH.includes(pid) ? 4 : 2 }, (_, i) => ({
    online: bit(hb[0], i), battery: hb[3 + i], muted: bit(hb[11], i),
  })),
  settings: {
    noise_cancel: {
      cmd: 0x1003, read: hb => [0, hb[13], hb[12]],
      names: { off: b => [0, b[1] ?? 0, 0], weak: [0, 0, 1], medium: [0, 1, 1], strong: [0, 2, 1] },
    },
    volume: {
      cmd: 0x100d, read: hb => [0, hb[14]],
      names: Object.fromEntries([0, 1, 2, 3, 4, 5].map(n => [String(n), [0, n]])), hint: "0-5 (the app's steps 1-6)",
    },
    voice_mode: { cmd: 0x1005, read: hb => [0, hb[15]], names: { mono: [0, 0], stereo: [0, 1], '4track': [0, 2] } },
  },
  mute: 0x1001,
};

const MAX2 = {
  name: 'Lark Max 2',
  ids: [[HOLLYLAND, 0x0402], [HOLLYLAND, 0x0403]],
  frame: tlvFrame({ ctrl: 0x07, wrap: true }), parse: tlvParse, target: pid => (pid === 0x0402 ? 0x01 : 0x02), heartbeat: 0x600b,
  units: hb => [0, 1].map(i => ({ online: hb[6 + i] === 1, battery: hb[2 + i], muted: null })),
  settings: {
    noise_cancel: { cmd: 0x6006, read: hb => [hb[11], hb[12]], names: { off: offKeepLevel, weak: [1, 0], medium: [1, 1], strong: [1, 2] } },
    voice_mode: { cmd: 0x6008, read: byteAt(17), names: { mono: [0], stereo: [1], safety: [2] } },
    mic_recognition: { cmd: 0x6013, read: byteAt(28), names: onOff },
  },
};

function heartbeatDriver(d) {
  return {
    ...d,
    tested: false,
    open(info) {
      const dev = new HID.HID(info.path);
      const target = typeof d.target === 'function' ? d.target(info.productId) : d.target;
      const request = (cmd, payload = []) => {
        dev.write(d.frame(cmd, payload, target));
        const end = Date.now() + 1000;
        while (Date.now() < end) {
          const r = d.parse(dev.readTimeout(250)).find(x => x.cmd === cmd);
          if (r) return r;
        }
        throw new Error(`no reply to command 0x${cmd.toString(16)}`);
      };
      const heartbeat = () => request(d.heartbeat).payload;
      const readAfterWrite = () => { sleep(200); return heartbeat(); };
      return {
        units: () => d.units(heartbeat(), info.productId),
        status() {
          const hb = heartbeat();
          const settings = Object.fromEntries(Object.entries(d.settings).map(([k, s]) => [k, s.read(hb)]));
          return { model: d.name, receiver: null, units: d.units(hb, info.productId), settings };
        },
        set(key, vals) {
          const s = d.settings[key];
          const before = s.read(heartbeat());
          const sent = toBytes(s, vals, before);
          if (!validBytes(sent)) throw usageError(`bad value for ${key}`);
          const ack = request(s.cmd, sent).payload;
          const after = s.read(readAfterWrite());
          return { setting: key, before, sent, ack, after, ok: after.join() === sent.join() };
        },
        mute: d.mute && ((tx, on) => {
          const ack = request(d.mute, [tx, on ? 1 : 0]).payload;
          const muted = d.units(readAfterWrite(), info.productId)[tx - 1]?.muted ?? null;
          return { tx, muted, ack, ok: muted === on };
        }),
        close: () => dev.close(),
      };
    },
  };
}

export const DRIVERS = [A1, ...[V1, M2S, A2, M3, MAX2].map(heartbeatDriver)];

export function findDevice() {
  for (const info of HID.devices()) {
    const driver = DRIVERS.find(d => d.ids.some(([v, p]) => v === info.vendorId && p === info.productId));
    if (driver) return { driver, info };
  }
  return null;
}

export const writable = driver => Object.keys(driver.settings).filter(k => !driver.settings[k].readOnly);

export function selftest() {
  const f = a1Frame(0x0d, [0x02]);
  assert.deepEqual(f.slice(0, 9), [0x05, 0x03, 0xaa, 0xdd, 0x0d, 0x00, 0x01, 0x02, 0xef]);
  assert.equal(f.length, 64);
  const hb = a1Parse([0x05, 0x03, 0xbb, 0xdd, 0x1f, 0x00, 0x11,
    0x01, 0x01, 0x47, 0x37, 0, 0, 0, 0x02, 0x05, 0, 0x01, 0, 0x03, 0, 0x02, 0x01, 0x00, 0x1f]);
  assert.equal(hb.payload.length, 17);
  assert.equal(hb.trailer, 0x1f);
  assert.deepEqual(a1Units(hb.payload), [
    { online: true, battery: 71, muted: false }, { online: true, battery: 55, muted: false }]);
  const hb4 = [1, 0, 50, 0, 1, 0, ...Array(11).fill(0), 1, 1, 40, 30, 0, 1];
  assert.deepEqual(a1Units(hb4).map(t => [t.online, t.battery, t.muted]),
    [[true, 50, true], [false, 0, false], [true, 40, false], [true, 30, true]]);
  assert.equal(mac([0x6b, 0x97, 0x40, 0x28, 0x22, 0x38]), '38:22:28:40:97:6b');
  assert.throws(() => a1Parse([0, 0, 0xaa, 0xdd, 0, 0, 0]), /bad reply header/);

  const S = A1.settings;
  assert.deepEqual(toBytes(S.indicator, ['off']), [1]);
  assert.deepEqual(toBytes(S.indicator, ['0']), [0]);
  assert.deepEqual(toBytes(S.eq, ['on']), [NaN]);
  assert.deepEqual(toBytes(S.indicator, ['toString']), [NaN]);
  assert.deepEqual(toBytes(S.reverb, ['off'], [1, 2]), [0, 2]);
  assert.equal(fmt(S.reverb, [0, 2]), 'off (0 2)');
  assert.equal(fmt(S.reverb, [1, 2]), 'large (1 2)');
  assert.equal(fmt(S.voice_level, [5]), '5');
  assert.deepEqual(writable(A1).filter(k => S[k].readOnly), []);
  assert.ok(!writable(A1).includes('signal_mode'));

  assert.deepEqual(legacyFrame(0x10, []).slice(0, 7), [0x00, 0xaa, 0xdd, 0x10, 0x40, 0x00, 0x00]);
  assert.deepEqual(legacyFrame(0x06, [0x02]).slice(0, 8), [0x00, 0xaa, 0xdd, 0x06, 0x40, 0x00, 0x01, 0x02]);
  assert.equal(legacyFrame(0x10, []).length, 65);
  assert.deepEqual(legacyParse([0xbb, 0xdd, 0x06, 0x80, 0x00, 0x02, 0x01, 0x02, 0xff]), [{ cmd: 0x06, payload: [1, 2] }]);
  assert.deepEqual(legacyParse([0x00, 0xbb, 0xdd, 0x10, 0x80, 0x00, 0x01, 0x07]), [{ cmd: 0x10, payload: [7] }]);
  assert.deepEqual(legacyParse([]), []);
  const a2hb = [1, 1, 0x55, 0x3c, 0, 0, 2, 3, 0, 1, 0, 0, 0, 0, 3, 5];
  assert.deepEqual(A2.units(a2hb), [{ online: true, battery: 85, muted: true }, { online: true, battery: 60, muted: false }]);
  assert.equal(fmt(A2.settings.voice_preset, A2.settings.voice_preset.read(a2hb)), 'low (1 1)');

  const m3 = M3.frame(0x1000, [0x01], 0x00);
  assert.deepEqual(m3.slice(0, 14), [0x08, 0xaa, 0xdd, 0x06, 0x00, 0x00, 0x00, 0x01, 0x10, 0x00, 0x01, 0x00, 0x01, 0x01]);
  assert.equal(m3.length, 64);
  assert.deepEqual(tlvParse([0x08, 0xbb, 0xdd, 0x00, 0x06, 0x00, 0x00, 0x01, 0x10, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01]),
    [{ cmd: 0x1000, payload: [1, 1] }]);
  assert.deepEqual(M3.units([0b0101, 0, 0, 80, 0, 60, 0, 0, 0, 0, 0, 0b0100], 0x040f).map(u => [u.online, u.battery, u.muted]),
    [[true, 80, false], [false, 0, false], [true, 60, true], [false, 0, false]]);

  const max2 = MAX2.frame(0x600b, [], MAX2.target(0x0402));
  assert.deepEqual(max2.slice(1, 24), [0xaa, 0xdd, 0x06, 0x01, 0x07, 0x00, 0x03, 0x5a, 0xfa, 0x00, 0x00, 0x00,
    0x60, 0x0b, 0x01, 0x00, 0x00, 0x5e, 0xfe, 0x00, 0x00, 0x00, 0x1e]);
  assert.deepEqual(tlvParse(max2.slice(1).map((b, i) => (i === 0 ? 0xbb : b))), [{ cmd: 0x600b, payload: [] }]);

  for (const d of DRIVERS.filter(x => !x.tested)) {
    for (const [k, s] of Object.entries(d.settings)) {
      assert.ok(Number.isInteger(s.cmd) && typeof s.read === 'function', `${d.name} ${k}`);
    }
  }
}
