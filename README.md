# lark

Control a Hollyland Lark A1 wireless mic receiver over USB.

```sh
npm install
node lark.js status            # receiver, transmitters, battery, firmware, settings
node lark.js watch             # live battery, Ctrl-C to stop
node lark.js set indicator off # change a setting, then read it back to confirm
node lark.js raw 1f            # send one read command, print the raw reply
node lark.js --selftest        # checks packet encoding, no device needed
```

Add `--json` to `status`, `set` or `raw` for machine-readable output.

## Settings

Values are the bytes shown by `lark status`, in decimal. `set` takes the same bytes, or a name where one is known.

| Setting | Values | Status |
|---|---|---|
| `indicator` | `on` (`0`), `off` (`1`) | Confirmed on device |
| `voice_mode` | seen: `0` | Unknown |
| `voice_level` | seen: `5` | Unknown |
| `reverb` | seen: `0 2` | Unknown (app offers small / medium / large) |
| `eq` | seen: `3` | Unknown (app offers equalization / low / bright) |
| `noise_cancel` | seen: `0 2` | Unknown |
| `mic_recognition` | seen: `1` | Unknown |
| `speaker_out` | reads back empty | Unknown, read probably needs a unit index |
| `auto_power_off` | seen: `1` | Unknown |
| `perf_mode` | seen: `0` | Read only. Radio setting the official app sets per country |

To decode a setting: change it with `set`, note what physically changes, then add it to this table and to `NAMES` in `lark.js`.

## Protocol

Verified on a Lark A1 receiver (USB `3547:0407`, firmware 1.0.2.12) with two paired transmitters.

- Commands are HID feature reports, report ID 5, padded to 64 bytes:
  `05 03 AA DD <cmd> <len hi> <len lo> <payload…> EF`. The `03` is required; without it the device returns a stale buffer instead of an error.
- Replies start `05 03 BB DD <cmd> <len hi> <len lo> <payload…>` followed by a checksum byte, which this tool ignores. Requests need no checksum.
- Each setting has a read opcode (even) and a set opcode one below it (odd). A set takes the same payload the read returns.

| Opcode | Read | Notes |
|---|---|---|
| `0x02` / `0x01` | voice_mode | read / set |
| `0x04` / `0x03` | voice_level | read / set |
| `0x06` / `0x05` | reverb | read / set |
| `0x08` / `0x07` | eq | read / set |
| `0x14` / `0x13` | noise_cancel | read / set |
| `0x22` / `0x21` | indicator | read / set |
| `0x24` / `0x23` | mic_recognition | read / set |
| `0x26` / `0x25` | speaker_out | read / set |
| `0x28` / `0x27` | auto_power_off | read / set |
| `0x46` / `0x45` | perf_mode | read / set (set not exposed) |
| `0x0D` | firmware | payload `0` receiver, `1` TX1, `2` TX2. Returns `FF` for a TX that's off |
| `0x12` | serial | |
| `0x1F` | heartbeat | byte 0 TX1 online, 1 TX2 online, 2 TX1 battery %, 3 TX2 battery % |
| `0x30` | receiver MAC | little-endian |
| `0x31` | TX MAC | payload `0` TX1, `1` TX2. Answers even when the TX is off |

Not exposed by this tool: `0x16` mute, `0x0C` reboot, `0x3C` refresh receiver, `0x3D` pairing, and the firmware-update opcodes `0x1C`–`0x1E` and `0x3E`. `raw` refuses anything that isn't a known read.

Reads come from the receiver's cached state and take about 0.5 ms, even for transmitters. They also work while the mic is recording.

`node-hid` opens the receiver exclusively, so while one process holds it, others get `exclusive access and device already open`. Open, send and close per operation rather than holding the device.
