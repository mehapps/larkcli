# lark

Control Hollyland Lark wireless mic receivers over USB. Plug in the receiver and run a command; the model is detected automatically.

| Model | USB IDs | Status |
|---|---|---|
| Lark A1 | `3547:0407` | Tested on hardware |
| Lark C1, M1, Mini, M2 | `3547:0001`, `000B`, `000C`, `000D`, `0007`, `0008`; EaglesHero `4417:0020`, `0021` | **Untested** |
| Lark M2S | `3547:0405`, `0406` | **Untested** |
| Lark A2 | `3547:0411`, `8775` | **Untested** |
| Lark M3 | `3547:040C`–`040F` | **Untested** |
| Lark Max 2 (USB receiver) | `3547:0402`, `0403` | **Untested** |

Untested means the protocol was read out of Hollyland's HollyAudio 3.0.6 Android app but has never been run against that device. It may not work at all. If you have one, run `node lark.js status` and open an issue with what you see. See [Untested models](#untested-models) for details.

The MELO P1 isn't supported. It's a mixer with a much larger command set.

```sh
npm install
node lark.js status            # receiver, transmitters, battery, mute, firmware, settings
node lark.js watch             # live battery, Ctrl-C to stop
node lark.js set eq bright     # change a setting, then read it back to confirm
node lark.js mute 1            # mute / unmute a transmitter (1-4)
node lark.js unmute 1
node lark.js raw 1f            # send one read command, print the raw reply
node lark.js --selftest        # checks packet encoding, no device needed
```

Add `--json` to `status`, `set`, `mute` or `raw` for machine-readable output. `lark set` with no arguments lists the settings for the connected model. `raw` only works on the A1.

## Lark A1 settings

`set` takes a name, or the raw bytes shown by `lark status` in decimal.

| Setting | Values | Bytes | Verified on device |
|---|---|---|---|
| `indicator` | `on`, `off` | `0`, `1` | Yes |
| `reverb` | `off`, `small`, `medium`, `large` | `[on, level]`: `off` keeps the level, sizes are `1 0` / `1 1` / `1 2` | Yes |
| `noise_cancel` | `off`, `weak`, `medium`, `strong` | `[on, level]`, same shape as reverb | Read only |
| `eq` | `low`, `bright`, `balanced` | `1`, `2`, `3` | Read only |
| `voice_mode` | `mono`, `stereo` | `0`, `1` | Read only |
| `voice_level` | `0`–`5` | the app's steps 1–6 | Read only |
| `mic_recognition` | `off`, `on` | `0`, `1` | Read only |
| `auto_power_off` | `15min`, `never` | `0`, `1` | Read only |
| `signal_mode` | `normal`, `performance` | `0`, `1` | Shown, not settable |
| `enhanced_mode` | `off`, `on` | `0`, `1` | Shown, not settable |

"Read only" means the value names come from Hollyland's app and match what the device reports, but `set` hasn't been tried on hardware yet. `set` always reads the value back and exits with code 2 if the device didn't take it.

The device refuses most settings while every transmitter is off. The indicator and auto power-off still work.

`signal_mode` is the app's "Performance mode", a radio setting the app only shows when Hollyland's server allows it. `enhanced_mode` is a different radio setting the app sets on its own from your country. Both are left read-only so this tool can't put the radio into a mode that isn't allowed where you are.

To add a setting name: change it with `set`, check what physically changes, then add it to that model's `settings` in `devices.js` and to this table. When you confirm an untested model works, set `tested: true` on it and move its row in the table at the top.

## Lark A1 protocol

Verified on a Lark A1 receiver (USB `3547:0407`, firmware 1.0.2.12) with two paired transmitters. Value meanings come from the decompiled HollyAudio 3.0.6 Android app.

- Commands are HID feature reports, report ID 5, padded to 64 bytes:
  `05 03 AA DD <cmd> <len hi> <len lo> <payload…> EF`. The `03` is required; without it the device returns a stale buffer instead of an error.
- Replies start `05 03 BB DD <cmd> <len hi> <len lo> <payload…>` followed by a checksum byte, which this tool ignores. Requests need no checksum.
- Each setting has a read opcode (even) and a set opcode one below it (odd). A set takes the same payload the read returns and replies with one status byte: `0` is success, `255` means the target is off.

| Opcode | Command | Notes |
|---|---|---|
| `0x02` / `0x01` | voice_mode | read / set |
| `0x04` / `0x03` | voice_level | read / set |
| `0x06` / `0x05` | reverb | read / set |
| `0x08` / `0x07` | eq | read / set |
| `0x14` / `0x13` | noise_cancel | read / set |
| `0x22` / `0x21` | indicator | read / set |
| `0x24` / `0x23` | mic_recognition | read / set |
| `0x28` / `0x27` | auto_power_off | read / set |
| `0x40` / `0x3F` | signal_mode | read / set (set not exposed) |
| `0x46` / `0x45` | enhanced_mode | read / set (set not exposed) |
| `0x26` / `0x25` | speaker_out | Hidden for the A1 in the app. Reads back empty |
| `0x16` | mute | payload `[tx - 1, 1 muted / 0 unmuted]` |
| `0x0D` | firmware | payload `0` receiver, `1`–`4` TX. Returns `FF` for a TX that's off |
| `0x12` | serial | payload `0` receiver, `1`–`4` TX |
| `0x30` | receiver MAC | little-endian |
| `0x31` | TX MAC | payload `0`–`3` for TX1–TX4. Answers even when the TX is off |
| `0x1F` | heartbeat | see below |

Heartbeat (`0x1F`) payload, which is how Hollyland's app reads everything, once a second:

| Byte | Field |
|---|---|
| 0, 1 | TX1, TX2 online |
| 2, 3 | TX1, TX2 battery % |
| 4, 5 | TX1, TX2 muted |
| 6, 7 | noise cancel on, level |
| 8 | voice level |
| 9 | voice mode |
| 10 | auto power-off |
| 11 | indicator (`0` = on) |
| 12 | EQ |
| 13, 14 | reverb on, level |
| 15 | mic recognition |
| 16 | signal mode |
| 17–22 | TX3/TX4 online, battery, muted (4-mic firmware only; untested) |

Not exposed by this tool: `0x0C` reboot, `0x3C` refresh receiver, `0x3D` pairing, and the firmware-update opcodes `0x1C`–`0x1E`, `0x2C`, `0x2D` and `0x3E`. `raw` refuses anything that isn't a known read.

Reads come from the receiver's cached state and take about 0.5 ms, even for transmitters. They also work while the mic is recording.

`node-hid` opens the receiver exclusively, so while one process holds it, others get `exclusive access and device already open`. Open, send and close per operation rather than holding the device.

## Untested models

Everything below comes from reading Hollyland's app. None of it has been run against real hardware, and the tool can't tell if a byte offset or value name is wrong until someone with the device tries it.

To limit the damage a wrong guess can do, these models only get three things:

- **Status:** one heartbeat command, the same one Hollyland's app polls.
- **A short list of settings,** each sent with the exact command and payload the app uses.
- **Mute,** on the M3 only.

`raw` is disabled, and nothing else is ever sent. Command numbers mean different things on different models; on the M3, `0x6003` is factory reset. `set` reads the heartbeat again afterwards and exits with code 2 if the value didn't change as expected.

Unlike the A1, these models use ordinary HID output and input reports rather than feature reports.

### Lark C1 / M1 / Mini / M2 / M2S

Frame: `AA DD <cmd> <target> <len hi> <len lo> <payload…>`, zero-padded to 64 bytes, no checksum. Target is `0x40` for the receiver. Replies echo the command at byte 2 and carry the payload from byte 6. Set commands reply `[1]` on success.

| Setting | Command | Values | Heartbeat byte |
|---|---|---|---|
| `noise_cancel` | `0x06` | `weak` `1`, `strong` `2` (reads `0` when off) | 6 |
| `volume` | `0x05` | `0`–`5`. The C1 and M2S map the app's buttons 1–6 to `5 4 3 0 1 2`; the others to `0`–`5` | 7 |
| `volume_lock` | `0x34` | `unlocked` `0`, `locked` `1` | 8 |
| `voice_mode` (M2S) | `0x18` | `mono` `0`, `stereo` `1` | 9 |
| `auto_power_off` (M2S) | `0x36` | `15min` `0`, `never` `1` | 10 |
| `indicator` (M2S) | `0x39` | `on` `0`, `off` `1` | 13 |

Heartbeat is command `0x10`: bytes 0–1 are TX1/TX2 online and 2–3 their battery %. These models have no mute command. Noise cancelling on/off is a toggle (`0x19`), so it isn't exposed. Pick a level instead.

Hollyland's app hides some settings depending on model and firmware. For example, volume lock needs receiver firmware 2.0.0.31 or later on the M2. The tool shows every setting regardless.

### Lark A2

Same frame as above.

| Setting | Command | Values | Heartbeat byte |
|---|---|---|---|
| `noise_cancel` | `0x06` | `weak` `1`, `medium` `2`, `strong` `3` | 6 |
| `volume` | `0x05` | `0`–`5` (the app's steps 1–6) | 7 |
| `voice_mode` | `0x18` | `mono` `0`, `stereo` `1`, `safety` `2` | 9 |
| `auto_power_off` | `0x36` | `15min` `0`, `never` `1` | 10 |
| `indicator` | `0x39` | `on` `0`, `off` `1` | 13 |
| `voice_preset` | `0x3A` | `off`, `bright` `1 0`, `low` `1 1`, `balanced` `1 2` | 14: bit 0 on, bits 1–7 preset |

Byte 15 of the heartbeat holds mute (bits 0–1) and charging (bits 2–3) per transmitter. The A2 has no USB mute command.

### Lark M3 and Lark Max 2

Frame: `AA DD 06 <target> <ctrl> <count hi> <count lo>` followed by one command, `<id hi> <id lo> 01 <len hi> <len lo> <payload…>`.

- **M3:** report ID `0x08` in front of the frame, target `0x00`, ctrl `0x00`, no checksum.
- **Max 2:** the command is wrapped in `5A FA 00 00 00` … `5E FE 00 00 00`, ctrl `0x07`, and the frame ends with an XOR of every byte. Target is `0x01` for the phone receiver and `0x02` for the camera receiver.

| Model | Setting | Command | Values |
|---|---|---|---|
| M3 | `noise_cancel` | `0x1003` | `off`, `weak`, `medium`, `strong` (payload `[0, level, on]`) |
| M3 | `volume` | `0x100D` | `0`–`5` (payload `[0, level]`) |
| M3 | `voice_mode` | `0x1005` | `mono`, `stereo`, `4track` |
| M3 | mute | `0x1001` | payload `[tx 1–4, 1/0]` |
| Max 2 | `noise_cancel` | `0x6006` | `off`, `weak`, `medium`, `strong` (payload `[on, level]`) |
| Max 2 | `voice_mode` | `0x6008` | `mono`, `stereo`, `safety` |
| Max 2 | `mic_recognition` | `0x6013` | `off`, `on` |

Heartbeats: M3 is `0x6000` (byte 0 online bits, 3–6 battery, 11 mute bits, 12–15 noise on/level, volume, channel mode). Max 2 is `0x600B` (2–3 battery, 6–7 online, 11–12 noise, 17 channel mode, 28 mic recognition). The 4-channel M3 receivers (`040D`, `040F`) show four transmitters.
