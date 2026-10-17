# Anker Solix – Homey App

Monitor and control your **Anker Solix** solar battery system from Homey.

## Supported devices

| Driver | Models |
|--------|--------|
| **Solarbank** | E1600 (SB1 · A17C0), Solarbank 2 Pro (A17C1), Solarbank 2 AC (A17C2), Solarbank 2 Plus (A17C3), Solarbank 3 E2700 Pro (A17C5), **Solarbank Max AC (A17E2)** |
| **Smart Meter** | Anker 3-phase Smart Meter (A17X7 / A17X7US) and compatible Shelly meters |
| **Power System** | The overall site / virtual system view |

## Features

### Solarbank
| Capability | Read | Write |
|-----------|------|-------|
| Battery SOC (%) | ✅ | — |
| Solar power input (W) | ✅ | — |
| Battery charge power (W) | ✅ | — |
| Battery discharge power (W) | ✅ | — |
| AC output power (W) | ✅ | — |
| Output power target (W) | ✅ | ✅ slider |
| Min battery SOC (%) | ✅ | ✅ slider |
| Grid export enable | ✅ | ✅ toggle |

### Smart Meter
| Capability | Read |
|-----------|------|
| Net grid power (W, + import / − export) | ✅ |
| Grid import power (W) | ✅ |
| Grid export power (W) | ✅ |
| Total imported / exported (kWh, cumulative) | ✅ MQTT |
| Imported / exported today (kWh) | ✅ MQTT |

Power values update every ~5 s over Anker's cloud MQTT realtime channel (P1 Meter AE1R0, Smart Meter A17X7, Shelly Pro 3EM), with the REST poll as fallback. The meter registers as a cumulative main meter in Homey Energy, like a HomeWizard or Pulse P1 meter (device setting, on by default).

### Power System
| Capability | Read |
|-----------|------|
| Total solar power (W) | ✅ |
| Home load (W) | ✅ |
| Net grid power (W) | ✅ |
| Grid import / export (W) | ✅ |
| Average battery SOC (%) | ✅ |
| Today's solar production (kWh) | ✅ |

## Setup

### 1 · Configure credentials
Open the Homey app → **More** → **Apps** → **Anker Solix** → **Configure**.  
Enter your Anker account email, password, and 2-letter country code (e.g. `NL`, `DE`, `US`).

> The country code selects the correct regional API server (EU for most of Europe, COM for the US, AU, etc.).

### 2 · Add devices
Go to **Devices** → **+** → **Anker Solix** and choose the driver you want:

- **Solarbank** – the pairing wizard asks for credentials and then lists all Solarbanks found in your account.
- **Smart Meter** – lists grid meters found in any Power System.
- **Power System** – lists each system/site as a single overview device.

## Flows

### Triggers
- Battery started / stopped charging
- Battery started discharging
- Grid import / export started

### Conditions
- Battery SOC is above _X_ %
- Solar power is above _X_ W
- Grid is importing power

### Actions
- Set output power target (W)
- Set grid export (on / off)

## Technical notes

- Data is polled from the **Anker Power Cloud API** (default: every 60 s, configurable).
- Authentication uses ECDH key exchange + AES-256-CBC, mirroring the official Anker app protocol.
- Only **one active session per account** is allowed by Anker. If you are logged in on the Anker mobile app at the same time, the integration may be kicked out.
- No local/LAN communication – a cloud connection is required.

## Development

```bash
npm install -g homey
cd com.anker.solix
homey app run        # run on Homey over local network
homey app validate   # validate app.json
```

You need the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started) and Node.js ≥ 18.

## License

MIT
