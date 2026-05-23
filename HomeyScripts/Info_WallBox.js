const deviceName = 'Wallbox';

const devices = await Homey.devices.getDevices();
const wallbox = Object.values(devices).find(d => d.name === deviceName);

if (!wallbox) {
  throw new Error(`Device '${deviceName}' niet gevonden`);
}

const result = {
  name: wallbox.name,
  id: wallbox.id,
  driverId: wallbox.driverId,
  available: wallbox.available,
  lastSeenAt: wallbox.lastSeenAt,
  variables: {}
};

for (const cap of wallbox.capabilities) {
  const obj = wallbox.capabilitiesObj[cap];
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

log(JSON.stringify(result, null, 2));
return result;
