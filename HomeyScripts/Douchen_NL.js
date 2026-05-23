// ==========================
// Douchen - duur per douchebeurt en per dag
// Detectie via Watermeter L/min > drempel
// Eénmalig triggeren via Flow (bijv. op Watermeter > 0); script loopt zelf door met 30s interval
// Inclusief Logic-variabelen, log en Timeline-meldingen
// ==========================

// ---------- Configuratie ----------
const WATERMETER_ID = '2c056e24-b4ba-4087-96e3-be9d981e6220'; // Optioneel invullen. Leeg = zoeken op naam hieronder.
const WATERMETER_NAAM = 'Watermeter';
const WATERMETER_CAPABILITEITEN = [
	'measure_water',
	'meter_water',
	'measure_flow',
	'meter_flow',
	'measure_liter_per_minute',
	'meter_liter_per_minute'
];

const DOUCHE_DREMPEL_LPM = 7;
const MIN_BEURT_SEC = 150;       // korter dan dit telt niet als douchebeurt (bijv. wasmachine: 2m30s)
const MAX_STILTE_SEC = 120;      // korte dip in waterverbruik telt nog als dezelfde douchebeurt
const MAX_INTERVAL_SEC = 180;    // voorkomt extreem optellen als het script lang niet draaide
const LOG_MAX_REGELS = 40;

const STUUR_TIJDLIJN_BIJ_START = true;
const STUUR_TIJDLIJN_BIJ_EINDE = true;
const STUUR_TIJDLIJN_BIJ_NIEUWE_DAG = false;

// ---------- Logic-variabelen ----------
const VAR_ACTIEF = 'douchen_actief';
const VAR_START_ISO = 'douchen_start_iso';
const VAR_LAATSTE_RUN_ISO = 'douchen_laatste_run_iso';
const VAR_LAATSTE_BOVEN_DREMPEL_ISO = 'douchen_laatste_boven_drempel_iso';
const VAR_HUIDIGE_BEURT_SEC = 'douchen_huidige_beurt_sec';
const VAR_TOTAAL_VANDAAG_SEC = 'douchen_totaal_vandaag_sec';
const VAR_DAG = 'douchen_dag';
const VAR_LAATSTE_BEURT_SEC = 'douchen_laatste_beurt_sec';
const VAR_LAATSTE_RESULTAAT = 'douchen_laatste_resultaat';
const VAR_LOG = 'douchen_log';

// --------------------------
// Hulpfuncties
// --------------------------
function haalLokaalDatum() {
	return new Date(
		new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
	);
}

function format2(n) {
	return String(n).padStart(2, '0');
}

function haalNuIsoLokaal() {
	const d = haalLokaalDatum();
	return d.getFullYear() + '-' +
		format2(d.getMonth() + 1) + '-' +
		format2(d.getDate()) + ' ' +
		format2(d.getHours()) + ':' +
		format2(d.getMinutes()) + ':' +
		format2(d.getSeconds());
}

function maakDagSleutel(datum) {
	return datum.getFullYear() + '-' + format2(datum.getMonth() + 1) + '-' + format2(datum.getDate());
}

function parseIso(iso) {
	if (!iso) return null;
	const d = new Date(String(iso).replace(' ', 'T'));
	return Number.isNaN(d.getTime()) ? null : d;
}

function afronden(waarde, decimalen) {
	if (decimalen === undefined) decimalen = 2;
	return Number(Number(waarde).toFixed(decimalen));
}

function formatDuur(sec) {
	const totaal = Math.max(0, Math.round(Number(sec) || 0));
	const uren = Math.floor(totaal / 3600);
	const minuten = Math.floor((totaal % 3600) / 60);
	const seconden = totaal % 60;

	if (uren > 0) {
		return uren + 'u ' + format2(minuten) + 'm ' + format2(seconden) + 's';
	}

	return minuten + 'm ' + format2(seconden) + 's';
}

function clampIntervalSec(sec) {
	if (!Number.isFinite(sec) || sec <= 0) return 0;
	return Math.min(sec, MAX_INTERVAL_SEC);
}

function berekenSecondenInDag(startDatum, eindeDatum, dagSleutel) {
	if (!startDatum || !eindeDatum) return 0;

	const startMs = startDatum.getTime();
	const eindMs = eindeDatum.getTime();

	if (!(eindMs > startMs)) return 0;

	const dagStart = new Date(dagSleutel + 'T00:00:00');
	const dagEinde = new Date(dagSleutel + 'T23:59:59');
	dagEinde.setMilliseconds(999);

	const overlapStart = Math.max(startMs, dagStart.getTime());
	const overlapEinde = Math.min(eindMs, dagEinde.getTime());

	if (!(overlapEinde > overlapStart)) return 0;

	return Math.round((overlapEinde - overlapStart) / 1000);
}

async function haalAlleLogicaVariabelen() {
	return await Homey.logic.getVariables();
}

async function zoekLogicaVariabelPerNaam(naam) {
	const variabelen = await haalAlleLogicaVariabelen();
	const alleVariabelen = Object.values(variabelen);

	for (let i = 0; i < alleVariabelen.length; i++) {
		if (alleVariabelen[i].name === naam) {
			return alleVariabelen[i];
		}
	}

	return null;
}

async function haalVariabele(naam, fallback) {
	try {
		const gevonden = await zoekLogicaVariabelPerNaam(naam);
		if (!gevonden) return fallback;

		const waarde = gevonden.value;

		if (typeof fallback === 'number') {
			const getal = Number(waarde);
			return Number.isFinite(getal) ? getal : fallback;
		}

		if (typeof fallback === 'boolean') {
			if (typeof waarde === 'boolean') return waarde;
			if (waarde === 'true' || waarde === 1 || waarde === '1') return true;
			if (waarde === 'false' || waarde === 0 || waarde === '0') return false;
			return fallback;
		}

		return waarde != null ? waarde : fallback;
	} catch (e) {
		return fallback;
	}
}

async function zorgVoorLogicaVariabele(naam, type, beginwaarde) {
	const bestaande = await zoekLogicaVariabelPerNaam(naam);
	if (bestaande) return bestaande;

	return await Homey.logic.createVariable({
		variable: {
			name: naam,
			type: type,
			value: beginwaarde
		}
	});
}

async function stelLogicaVariabeleIn(naam, type, waarde) {
	const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);

	await Homey.logic.updateVariable({
		id: variabele.id,
		variable: { value: waarde }
	});

	return variabele;
}

async function voegLogRegelToe(regel) {
	const huidig = await haalVariabele(VAR_LOG, '');
	const regels = String(huidig || '')
		.split('\n')
		.filter(function(x) { return Boolean(x); });

	regels.push(regel);

	while (regels.length > LOG_MAX_REGELS) {
		regels.shift();
	}

	await stelLogicaVariabeleIn(VAR_LOG, 'string', regels.join('\n'));
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

async function haalWatermeterOp() {
	if (WATERMETER_ID) {
		return await Homey.devices.getDevice({ id: WATERMETER_ID });
	}

	const apparaten = await Homey.devices.getDevices();
	const lijst = Object.values(apparaten);

	for (let i = 0; i < lijst.length; i++) {
		if (lijst[i].name === WATERMETER_NAAM) {
			return lijst[i];
		}
	}

	throw new Error('Watermeter niet gevonden. Vul WATERMETER_ID in of controleer WATERMETER_NAAM.');
}

function haalFlowCapabiliteit(capabilitiesObj) {
	for (let i = 0; i < WATERMETER_CAPABILITEITEN.length; i++) {
		const naam = WATERMETER_CAPABILITEITEN[i];
		const item = capabilitiesObj[naam];

		if (item && item.value != null) {
			const waarde = Number(item.value);
			if (Number.isFinite(waarde)) {
				return {
					naam: naam,
					waarde: waarde
				};
			}
		}
	}

	throw new Error('Geen bruikbare flow-capabiliteit gevonden op de Watermeter. Controleer WATERMETER_CAPABILITEITEN.');
}

// --------------------------
// Begin script
// --------------------------
async function voerIteratieUit() {
const nu = haalLokaalDatum();
const nuIso = haalNuIsoLokaal();
const vandaag = maakDagSleutel(nu);

const watermeter = await haalWatermeterOp();
const flowInfo = haalFlowCapabiliteit(watermeter.capabilitiesObj || {});
const flowLpm = Number(flowInfo.waarde);
const bovenDrempel = flowLpm > DOUCHE_DREMPEL_LPM;

if (!Number.isFinite(flowLpm)) {
	throw new Error('Ongeldige Watermeter waarde.');
}

let actief = await haalVariabele(VAR_ACTIEF, false);
let startIso = await haalVariabele(VAR_START_ISO, '');
let laatsteRunIso = await haalVariabele(VAR_LAATSTE_RUN_ISO, '');
let laatsteBovenDrempelIso = await haalVariabele(VAR_LAATSTE_BOVEN_DREMPEL_ISO, '');
let huidigeBeurtSec = await haalVariabele(VAR_HUIDIGE_BEURT_SEC, 0);
let totaalVandaagSec = await haalVariabele(VAR_TOTAAL_VANDAAG_SEC, 0);
let opgeslagenDag = await haalVariabele(VAR_DAG, vandaag);

const laatsteRun = parseIso(laatsteRunIso);
const laatsteBovenDrempel = parseIso(laatsteBovenDrempelIso);
const nuMs = nu.getTime();

// Nieuwe dag: reset dagteller. Een lopende douchebeurt blijft doorlopen.
if (opgeslagenDag !== vandaag) {
	totaalVandaagSec = 0;
	opgeslagenDag = vandaag;

	if (STUUR_TIJDLIJN_BIJ_NIEUWE_DAG) {
		await voegTijdlijnToe('🚿 Nieuwe douche-dag gestart. Dagteller staat weer op 0.');
	}
}

// Lopende douchebeurt bijtellen sinds vorige run
if (actief && laatsteRun) {
	const laatsteRunMs = laatsteRun.getTime();

	if (nuMs > laatsteRunMs) {
		let telTotMs = laatsteRunMs;

		if (bovenDrempel) {
			telTotMs = nuMs;
		} else if (laatsteBovenDrempel) {
			const grensMs = laatsteBovenDrempel.getTime() + (MAX_STILTE_SEC * 1000);
			telTotMs = Math.min(nuMs, grensMs);
		}

		const deltaSec = clampIntervalSec((telTotMs - laatsteRunMs) / 1000);

		if (deltaSec > 0) {
			huidigeBeurtSec += deltaSec;

			const telTotDatum = new Date(laatsteRunMs + (deltaSec * 1000));
			totaalVandaagSec += berekenSecondenInDag(laatsteRun, telTotDatum, vandaag);
		}
	}
}

let status = 'idle';
let tijdlijnTekst = '';

// Start nieuwe douchebeurt
if (!actief && bovenDrempel) {
	actief = true;
	status = 'gestart';
	startIso = nuIso;
	huidigeBeurtSec = 0;
	laatsteBovenDrempelIso = nuIso;

	tijdlijnTekst = '🚿 Douche gestart · flow ' + afronden(flowLpm, 1) + ' L/min';

	if (STUUR_TIJDLIJN_BIJ_START) {
		await voegTijdlijnToe(tijdlijnTekst);
	}

	await voegLogRegelToe(
		nuIso + ' | START | flow=' + afronden(flowLpm, 1) + ' L/min | cap=' + flowInfo.naam
	);
}

// Tijdens douchebeurt: laatste actieve flow bijwerken
if (actief && bovenDrempel) {
	laatsteBovenDrempelIso = nuIso;
	if (status !== 'gestart') status = 'loopt';
}

// Einde douchebeurt als flow te lang onder drempel blijft
if (actief && !bovenDrempel && laatsteBovenDrempel) {
	const stilteSec = Math.max(0, Math.round((nuMs - laatsteBovenDrempel.getTime()) / 1000));

	if (stilteSec >= MAX_STILTE_SEC) {
		actief = false;

		const beurtSec = Math.round(huidigeBeurtSec);

		if (beurtSec < MIN_BEURT_SEC) {
			// Te kort voor een douchebeurt (bijv. wasmachine) — dagteller terugdraaien
			totaalVandaagSec = Math.max(0, totaalVandaagSec - huidigeBeurtSec);
			status = 'te_kort';

			await voegLogRegelToe(
				nuIso + ' | TE KORT | beurt=' + formatDuur(beurtSec) + ' (min=' + formatDuur(MIN_BEURT_SEC) + ', genegeerd) | flow=' + afronden(flowLpm, 1) + ' L/min'
			);
		} else {
			status = 'gestopt';

			const dagSec = Math.round(totaalVandaagSec);

			tijdlijnTekst = '🚿 Douche klaar · beurt ' + formatDuur(beurtSec) + ' · vandaag ' + formatDuur(dagSec);

			if (STUUR_TIJDLIJN_BIJ_EINDE) {
				await voegTijdlijnToe(tijdlijnTekst);
			}

			await voegLogRegelToe(
				nuIso + ' | STOP | beurt=' + formatDuur(beurtSec) + ' | vandaag=' + formatDuur(dagSec) + ' | flow=' + afronden(flowLpm, 1) + ' L/min'
			);

			await stelLogicaVariabeleIn(VAR_LAATSTE_BEURT_SEC, 'number', beurtSec);
		}

		startIso = '';
		laatsteBovenDrempelIso = '';
		huidigeBeurtSec = 0;
	} else {
		status = 'pauze';
	}
}

const resultaat =
	'status=' + status +
	' | flow=' + afronden(flowLpm, 1) + ' L/min' +
	' | beurt=' + formatDuur(huidigeBeurtSec) +
	' | vandaag=' + formatDuur(totaalVandaagSec) +
	' | cap=' + flowInfo.naam;

// --------------------------
// Status opslaan
// --------------------------
await stelLogicaVariabeleIn(VAR_ACTIEF, 'boolean', actief);
await stelLogicaVariabeleIn(VAR_START_ISO, 'string', startIso);
await stelLogicaVariabeleIn(VAR_LAATSTE_RUN_ISO, 'string', nuIso);
await stelLogicaVariabeleIn(VAR_LAATSTE_BOVEN_DREMPEL_ISO, 'string', laatsteBovenDrempelIso);
await stelLogicaVariabeleIn(VAR_HUIDIGE_BEURT_SEC, 'number', Math.round(huidigeBeurtSec));
await stelLogicaVariabeleIn(VAR_TOTAAL_VANDAAG_SEC, 'number', Math.round(totaalVandaagSec));
await stelLogicaVariabeleIn(VAR_DAG, 'string', vandaag);
await stelLogicaVariabeleIn(VAR_LAATSTE_RESULTAAT, 'string', resultaat);

return {
	status: status,
	actief: actief,
	watermeter: watermeter.name,
	capabiliteit: flowInfo.naam,
	flow_lpm: afronden(flowLpm, 2),
	drempel_lpm: DOUCHE_DREMPEL_LPM,
	huidige_beurt_sec: Math.round(huidigeBeurtSec),
	huidige_beurt_tekst: formatDuur(huidigeBeurtSec),
	totaal_vandaag_sec: Math.round(totaalVandaagSec),
	totaal_vandaag_tekst: formatDuur(totaalVandaagSec),
	laatste_resultaat: resultaat,
	tijdlijn: tijdlijnTekst || null
};
}

// --------------------------
// Hoofdlus - 30 seconden interval
// --------------------------
const MAX_ITERATIES = 50; // maximaal 25 minuten
const INTERVAL_MS = 30000;

let iteratie = 0;
let laatsteResultaat = null;
let oooitActief = false;

while (iteratie < MAX_ITERATIES) {
	if (iteratie > 0) {
		await wait(INTERVAL_MS);
	}

	laatsteResultaat = await voerIteratieUit();
	iteratie++;

	if (laatsteResultaat.actief) oooitActief = true;

	// Stop zodra douche klaar is
	if (laatsteResultaat.status === 'gestopt') break;

	// Te korte sessie (bijv. wasmachine): teller reset maar doorlopen voor echte douche
	if (laatsteResultaat.status === 'te_kort') oooitActief = false;

	// Stop als na 3 pogingen de drempel nooit gehaald is
	if (!oooitActief && iteratie >= 3) break;
}

return laatsteResultaat;
