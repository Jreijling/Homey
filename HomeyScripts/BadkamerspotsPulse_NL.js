// ==========================
// Lamp pulse - even naar 0 en terug
// Bedoeld om elke 5 minuten via een Flow te draaien
// ==========================

const LAMP_ID = '2f0685c3-73f4-496f-9b7f-d8b844a9d4f9';
const WACHTTIJD_MS = 1000;
const STUUR_TIJDLIJN = false;

function slaap(ms) {
	return wait(ms);
}

async function voegTijdlijnToe(tekst) {
	try {
		await Homey.flow.runFlowCardAction({
			uri: 'homey:flowcardaction:homey:manager:notifications:create_notification',
			id: 'homey:manager:notifications:create_notification',
			args: { text: tekst }
		});
		return true;
	} catch (e) {
		return false;
	}
}

const lamp = await Homey.devices.getDevice({ id: LAMP_ID });
const capabilities = lamp.capabilitiesObj || {};

if (!capabilities.dim || capabilities.dim.value == null) {
	throw new Error('Dit apparaat heeft geen dim-capability.');
}

const huidigeDimWaarde = Number(capabilities.dim.value);
const heeftAanUit = Boolean(capabilities.onoff);
const huidigeAanUitWaarde = heeftAanUit ? Boolean(capabilities.onoff.value) : null;

if (!Number.isFinite(huidigeDimWaarde)) {
	throw new Error('Ongeldige huidige dim-waarde.');
}

await lamp.setCapabilityValue('dim', 0);
await slaap(WACHTTIJD_MS);

if (heeftAanUit && huidigeAanUitWaarde === true) {
	await lamp.setCapabilityValue('onoff', true);
}

await lamp.setCapabilityValue('dim', huidigeDimWaarde);

const resultaat = {
	apparaat: lamp.name,
	id: lamp.id,
	dim_voor: huidigeDimWaarde,
	dim_na: huidigeDimWaarde,
	wacht_ms: WACHTTIJD_MS,
	status: 'ok'
};

if (STUUR_TIJDLIJN) {
	await voegTijdlijnToe(
		'💡 Lamp pulse uitgevoerd voor ' + lamp.name + ' · dim ' + huidigeDimWaarde
	);
}

return resultaat;
