Monitor your Anker SOLIX home battery, solar input and smart meter in Homey through your Anker account, and let Homey Energy control the battery.

How this app differs from the official Anker SOLIX app
The official app by Anker connects over your local network (Modbus TCP) and supports the Solarbank Max AC, Solarbank Max, XE (AC), Solarbank 4 E5000 Pro, Smart Meter Gen 2 and Smart Plug Gen 2. This community app connects through the Anker cloud instead, so it also works with devices the official app does not support:
- Older Solarbanks without Modbus: E1600 (Solarbank 1), Solarbank 2 Pro, 2 AC, 2 Plus and Solarbank 3 E2700 Pro.
- The Anker P1 Meter and the Anker 3-phase Smart Meter (A17X7), which can act as the main meter in Homey Energy.
- A Power System device with the totals of your whole Anker system.
- Flows for charging and discharging starting or stopping, and grid import and export.
Modbus works differently as well. The official app uses only Modbus and needs no cloud. In this app Modbus is optional and only for the Solarbank Max AC: it adds live values every 10 seconds and battery control, while the Anker cloud is still used for login and finding your devices. Don't let both apps control the same battery at the same time, because they would overwrite each other's settings.
If you only have devices that the official app supports, the official app is the simpler choice: it needs no Anker account and works on Homey Cloud.

Supported devices
- Solarbank: E1600, Solarbank 2 Pro, 2 AC, 2 Plus, Solarbank 3 E2700 Pro and Solarbank Max AC. Shows battery level, solar power, charge and discharge power, AC output and total charged and discharged energy.
- Smart Meter: Anker P1 Meter, Anker 3-phase Smart Meter and compatible Shelly meters. Shows grid import and export with updates every few seconds.
- Power System: one overview device per Anker system with total solar power, home load, grid power and average battery level.

Battery control (Solarbank Max AC)
With a Solarbank Max AC on your local network you can set a target power for the battery. Homey Energy and other energy management apps can then charge or discharge the battery, hold it at its current level, or charge it from the grid. Turn on Modbus in the app settings and enter the IP address of the Solarbank. Other Solarbanks are monitored only; their output power and grid export can be set from a Flow.

Flows
Start Flows when the battery starts or stops charging, starts discharging, or when the grid starts importing or exporting. Check the battery level, solar power or grid import in conditions, and set the output power or grid export from a Flow.

Setup
Open the app settings and log in with your Anker account email, password and country. Then add your devices. Anker allows one active session per account, so use a separate Anker account (shared with your main account) to stay logged in on the Anker mobile app at the same time.

This app is made by the community and is not affiliated with or endorsed by Anker. It runs on Homey Pro only.
