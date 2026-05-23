const deviceName = 'Buffervat';

const devices = await Homey.devices.getDevices();
const device = Object.values(devices).find(d => d.name === deviceName);

if (!device) {
  throw new Error(`Device '${deviceName}' niet gevonden`);
}

const result = {
  name: device.name,
  id: device.id,
  driverId: device.driverId,
  available: device.available,
  lastSeenAt: device.lastSeenAt,
  variables: {}
};

for (const cap of device.capabilities) {
  const obj = device.capabilitiesObj[cap];
  result.variables[cap] = {
    value: obj?.value ?? null,
    title: obj?.title ?? cap,
    type: obj?.type ?? null,
    units: obj?.units ?? null,
    lastUpdated: obj?.lastUpdated ?? null
  };

  if (obj?.type === 'enum' && Array.isArray(obj.values)) {
    result.variables[cap].possibleValues = obj.values.map(v => ({
      id: v.id,
      title: v.title
    }));
  }
}

result.settings = device.settings ?? null;
result.store     = device.store    ?? null;
result.location  = device.location ?? null;

log(JSON.stringify(result, null, 2));
return result;