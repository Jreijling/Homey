const deviceName = 'Mini';

const devices = await Homey.devices.getDevices();
const mini = Object.values(devices).find(d => d.name === deviceName);

if (!mini) {
  throw new Error(`Device '${deviceName}' niet gevonden`);
}

const result = {
  name: mini.name,
  id: mini.id,
  driverId: mini.driverId,
  available: mini.available,
  lastSeenAt: mini.lastSeenAt,
  variables: {}
};

for (const cap of mini.capabilities) {
  const obj = mini.capabilitiesObj[cap];
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

result.settings = mini.settings ?? null;
result.store     = mini.store    ?? null;
result.location  = mini.location ?? null;

log(JSON.stringify(result, null, 2));
return result;