// ==========================
// Thermostaat - Vakantie + Aanwezigheid + Zon + Negatieve prijs + Accu
// Aanwezigheid via Homey users API
// Prijs via Dynamische Energie Prijzen (DEP) apparaat
// Vakantie: iedereen afwezig + vakantie variabele -> minimum temperatuur
//
// Thuis (verwarmen):
// 1. Zonne-overschot of negatieve all-in prijs -> BOOST
// 2. Dure periode binnen VOORVERWARM_UREN (3u) -> BOOST (huis alvast op temperatuur)
// 3. Duur blok -> ECO (ook met volle Accu, het huis is voorverwarmd)
// 4. Accu leeg -> gewone prijsprogramma (goedkoop BOOST / NORMAAL)
// 5. Anders -> NORMAAL (de Accu vangt de rest op)
//
// Zonne-overschot wordt bepaald uit P1 gecorrigeerd voor de Accu (Solarbank):
//   effectief = P1 - accuVermogen   (accuVermogen: + laden, - ontladen)
// Zonder correctie ziet P1 bijna nooit overschot: de Accu slurpt het op, en
// als de warmtepomp draait ontlaadt de Accu zodat P1 rond 0 W blijft.
// Laden uit het net (Accu_Laadplan) valt hierdoor ook netjes weg.
// Zolang de Accu onder ACCU_SOC_VOORRANG_PROCENT zit krijgt de Accu voorrang:
// dan telt Accu-laden NIET als overschot, Accu-ontladen wel als verbruik.
// ==========================

// ---------- Apparaat IDs ----------
const THERMOSTAAT_ID = '295b3cbb-2cc4-4e4d-9996-294cdf6b2cd0';
const P1_APPARAAT_ID = '3755a652-027b-41bb-b188-ab2ac592ee04';
const DYNAMISCHE_ENERGIE_PRIJS_ID = 'adc99ffc-add2-40d0-b664-8ce3b19c28af'; // Power by the Hour: NL_Netherlands (Frank Energie opslag)
const ACCU_APPARAAT_ID = 'd0b80416-826c-4db9-9a4e-163796f60d5a'; // Solarbank ("Accu")

// ---------- Accu ----------
// Onder deze laadtoestand gaat zonnestroom eerst naar de Accu, daarboven
// mag de thermostaat het laadvermogen van de Accu als overschot gebruiken.
const ACCU_SOC_VOORRANG_PROCENT = 70;

// Accu leeg -> gewone prijsprogramma volgen. Hysterese: leeg bij <= LEEG,
// pas weer "niet leeg" bij >= WEER_VOL. Onbekende SoC telt als leeg.
const ACCU_LEEG_PROCENT = 10;
const ACCU_WEER_VOL_PROCENT = 20;

// ---------- Setpoints (vloerverwarming - Verwarming) ----------
const SETPOINT_VAKANTIE = 18.0;
const SETPOINT_WEG = 19.0;
const SETPOINT_THUIS_ECO = 19.0;
const SETPOINT_THUIS_NORMAAL = 19.5;
const SETPOINT_THUIS_BOOST = 20.0;
const SETPOINT_THUIS_EXTRA = 21.0;   // zonne-overschot, negatieve prijs, voorverwarmen

// ---------- Setpoints (Koeling) ----------
const SETPOINT_KOELING_THUIS = 18.0;
const SETPOINT_KOELING_WEG = 21.0;

// ---------- Zonne-drempels met buffer / hysterese ----------
// PRIORITEIT: Buffervat (-2500W) krijgt voorrang, Thermostaat komt erna (-1200W)
const ZONNE_BOOST_AAN_WATT = -800;       // boost INSCHAKELEN (hoger dan Buffervat voor prioriteit)
const ZONNE_BOOST_UIT_WATT = -400;       // boost UITSCHAKELEN als overschot grotendeels weg is

// SURPLUS-logica: Als Buffervat actief is maar veel overschot beschikbaar
const SURPLUS_OVERSCHOT_WATT = -1000;    // Extra overschot beschikbaar voor Thermostaat ook

// ---------- Prijs instellingen ----------
// meter_rank_price_h0_this_day rangschikt op kwartierblokken (96/dag ipv 24 uren),
// dus "aantal uren" wordt hieronder omgerekend naar blokken (x4).
const GOEDKOOPSTE_UREN_AANTAL = 10;
const DUURSTE_UREN_AANTAL = 8;
const BLOKKEN_PER_DAG = 96;

// All-in prijs komt uit de gedeelde logica-variabele 'electra_prijs' (berekend door Electra_Prijs.js)
const PRIJS_VARIABELE = 'electra_prijs';

// ---------- Voorverwarmen ----------
// Komt er binnen VOORVERWARM_UREN een duur blok aan (en is het nu niet duur),
// dan alvast naar BOOST. Het DEP-apparaat geeft geen rang voor komende blokken,
// alleen prijzen (m15/m30/m45/h1/h2/h3). "Duur" = prijs >= dure drempel:
// - geleerd: laagste prijs die vandaag in een duur blok is gezien
// - anders geschat: daggemiddelde + VOORVERWARM_DREMPEL_FACTOR x (dagpiek - gemiddelde)
const VOORVERWARM_UREN = 3;              // max 3: verder kijkt het DEP-apparaat niet vooruit (h3)
const VOORVERWARM_DREMPEL_FACTOR = 0.25;
const VOORUIT_PRIJZEN = [
  { cap: 'meter_price_m15', minuten: 15 },
  { cap: 'meter_price_m30', minuten: 30 },
  { cap: 'meter_price_m45', minuten: 45 },
  { cap: 'meter_price_h1', minuten: 60 },
  { cap: 'meter_price_h2', minuten: 120 },
  { cap: 'meter_price_h3', minuten: 180 }
];

// ---------- Logging ----------
const LOG_MAX_REGELS = 40;
const STUUR_TIJDLIJN_BIJ_WIJZIGING = true;

const LOG_VARIABELE = 'thermostaat_log';
const LAATSTE_REDEN_VARIABELE = 'thermostaat_laatste_reden';
const LAATSTE_MODUS_VARIABELE = 'thermostaat_laatste_modus';
const LAATSTE_DOELTEMP_VARIABELE = 'thermostaat_laatste_doeltemp';
const LAATSTE_RESULTAAT_VARIABELE = 'thermostaat_laatste_resultaat';
const ZONNE_BOOST_ACTIEF_VARIABELE = 'thermostaat_zonne_boost_actief';
const ACCU_LEEG_VARIABELE = 'thermostaat_accu_leeg';
const DUUR_DREMPEL_VARIABELE = 'thermostaat_duur_drempel'; // JSON {datum, prijs}

// --------------------------
// Hulpfuncties
// --------------------------
function haalNuLokaal() {
  const d = new Date();
  const opvullen = function(n) {
    return String(n).padStart(2, '0');
  };

  return d.getFullYear() + '-' +
    opvullen(d.getMonth() + 1) + '-' +
    opvullen(d.getDate()) + ' ' +
    opvullen(d.getHours()) + ':' +
    opvullen(d.getMinutes()) + ':' +
    opvullen(d.getSeconds());
}

function afronding(waarde, decimalen) {
  if (decimalen === undefined) decimalen = 3;
  return Number(Number(waarde).toFixed(decimalen));
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

async function stellogicaVariabeleIn(naam, type, waarde) {
  const variabele = await zorgVoorLogicaVariabele(naam, type, waarde);

  await Homey.logic.updateVariable({
    id: variabele.id,
    variable: { value: waarde }
  });

  return variabele;
}

async function voegLogRegelToe(regel) {
  const huidig = await haalVariabele(LOG_VARIABELE, '');
  const regels = String(huidig || '')
    .split('\n')
    .filter(function(x) { return Boolean(x); });

  regels.push(regel);

  while (regels.length > LOG_MAX_REGELS) {
    regels.shift();
  }

  await stellogicaVariabeleIn(LOG_VARIABELE, 'string', regels.join('\n'));
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

// --------------------------
// Apparaten ophalen
// --------------------------
const thermostaat = await Homey.devices.getDevice({ id: THERMOSTAAT_ID });
const p1 = await Homey.devices.getDevice({ id: P1_APPARAAT_ID });
const dap = await Homey.devices.getDevice({ id: DYNAMISCHE_ENERGIE_PRIJS_ID });

// --------------------------
// Actuele waarden lezen
// --------------------------
const huidigDoeltemperatuur = Number(thermostaat.capabilitiesObj.target_temperature.value);
const thermostaatModus = thermostaat.capabilitiesObj.thermostat_mode
  ? String(thermostaat.capabilitiesObj.thermostat_mode.value || '').toLowerCase()
  : 'heating';
const isKoeling = (thermostaatModus === 'cooling');
const p1Vermogen = Number(p1.capabilitiesObj.measure_power.value);

// ---------- Accu: effectief netwerkvermogen ----------
let accuVermogen = 0;
let accuSoc = NaN;
let accuBron = 'accu';

try {
  const accu = await Homey.devices.getDevice({ id: ACCU_APPARAAT_ID });
  accuVermogen = Number(accu.capabilitiesObj?.measure_power?.value) || 0;
  accuSoc = Number(accu.capabilitiesObj?.measure_battery?.value);
} catch (e) {
  accuBron = 'accu_fout: ' + e.message;
}

const accuHeeftVoorrang = Number.isFinite(accuSoc) && accuSoc < ACCU_SOC_VOORRANG_PROCENT;
const netwerkvermogen = accuHeeftVoorrang
  ? p1Vermogen + Math.max(0, -accuVermogen)   // Accu-laden telt niet als overschot, ontladen wel als verbruik
  : p1Vermogen - accuVermogen;
const uur = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })).getHours();

// ---------- Aanwezigheid via users API ----------
let iemandThuis = false;
let aanwezigheidsBron = 'users_api';
let aanwezigenGebruikers = [];

try {
  const gebruikers = await Homey.users.getUsers();

  aanwezigenGebruikers = Object.values(gebruikers)
    .filter(function(u) {
      return u.present === true && u.enabled !== false;
    })
    .map(function(u) {
      return {
        id: u.id,
        naam: u.name || 'onbekend',
        rol: u.role || 'onbekend'
      };
    });

  iemandThuis = aanwezigenGebruikers.length > 0;
} catch (e) {
  iemandThuis = false;
  aanwezigheidsBron = 'users_api_fout: ' + e.message;
}

// ---------- Prijzen via DEP-apparaat + gedeelde all-in-prijsvariabele ----------
const depCapaciteiten = dap.capabilitiesObj || {};

if (!depCapaciteiten.meter_rank_price_h0_this_day || depCapaciteiten.meter_rank_price_h0_this_day.value == null) {
  throw new Error('DEP capaciteit meter_rank_price_h0_this_day niet gevonden of leeg');
}

const huidigePrijsRang = Number(depCapaciteiten.meter_rank_price_h0_this_day.value);

if (!Number.isFinite(huidigePrijsRang)) {
  throw new Error('Ongeldige prijsrang uit DEP-apparaat');
}

// All-in prijs komt uit de gedeelde variabele (berekend door Electra_Prijs.js)
const huidigePrijs = await haalVariabele(PRIJS_VARIABELE, 0);

// BELANGRIJK:
// rang 1 = goedkoopste blok, rang schaalt over 96 kwartierblokken/dag
const isGoedkoopUurPerRang = huidigePrijsRang <= (GOEDKOOPSTE_UREN_AANTAL * 4);
const isDuurUurPerRang = huidigePrijsRang > (BLOKKEN_PER_DAG - (DUURSTE_UREN_AANTAL * 4));

// Gebruik rang als primaire (en enige) bron
const isGoedkoopUur = isGoedkoopUurPerRang;
const isDuurUur = isDuurUurPerRang;
const isNegatievePrijs = huidigePrijs < 0;

// ---------- Voorverwarmen: komt er een duur blok aan? ----------
function kalePrijs(cap) {
  const c = depCapaciteiten[cap];
  const v = c ? Number(c.value) : NaN;
  return Number.isFinite(v) ? v : null;
}

const vandaag = haalNuLokaal().slice(0, 10);
const kalePrijsNu = kalePrijs('meter_price_h0');

let geleerdeDrempel = null;
try {
  const opgeslagen = JSON.parse(await haalVariabele(DUUR_DREMPEL_VARIABELE, '{}'));
  if (opgeslagen && opgeslagen.datum === vandaag && Number.isFinite(opgeslagen.prijs)) {
    geleerdeDrempel = opgeslagen.prijs;
  }
} catch (e) {
  geleerdeDrempel = null;
}

if (isDuurUur && kalePrijsNu !== null) {
  geleerdeDrempel = geleerdeDrempel === null ? kalePrijsNu : Math.min(geleerdeDrempel, kalePrijsNu);
  await stellogicaVariabeleIn(DUUR_DREMPEL_VARIABELE, 'string',
    JSON.stringify({ datum: vandaag, prijs: geleerdeDrempel }));
}

const dagGemiddelde = kalePrijs('meter_price_this_day_avg');
const dagHoogste = kalePrijs('meter_price_this_day_highest');
const geschatteDrempel = (dagGemiddelde !== null && dagHoogste !== null)
  ? dagGemiddelde + VOORVERWARM_DREMPEL_FACTOR * (dagHoogste - dagGemiddelde)
  : null;
const duurDrempel = geleerdeDrempel !== null ? geleerdeDrempel : geschatteDrempel;
const duurDrempelBron = geleerdeDrempel !== null ? 'geleerd' : 'geschat';

let duurBlokOver = null; // minuten tot eerstvolgende dure blok binnen venster
if (!isDuurUur && duurDrempel !== null) {
  for (let i = 0; i < VOORUIT_PRIJZEN.length; i++) {
    const p = VOORUIT_PRIJZEN[i];
    if (p.minuten > VOORVERWARM_UREN * 60) break;
    const prijs = kalePrijs(p.cap);
    if (prijs !== null && prijs >= duurDrempel) {
      duurBlokOver = p.minuten;
      break;
    }
  }
}
const isVoorverwarmen = duurBlokOver !== null;

// ---------- Vakantie ----------
const opVakantie = await haalVariabele('vakantie', false);

// ---------- Zonne-buffer / hysterese met Buffervat coördinatie + SURPLUS-logica ----------
// PRIORITEIT: Buffervat krijgt voorrang op zonnestroom (energieopslag > comfort)
// SURPLUS: Maar als heel veel overschot → beide kunnen BOOST activeren
const bufferbatZonneActief = await haalVariabele('buffervat_zonne_boost_actief', false);
const vorighZonneBoostActief = await haalVariabele(ZONNE_BOOST_ACTIEF_VARIABELE, false);
let zonneBoostActief = vorighZonneBoostActief;
let zonnebufferReden = '';

// Als Buffervat zonne-boost actief is: controleer surplus
if (bufferbatZonneActief) {
  // Buffervat warmt op. Is er EXTRA overschot beschikbaar?
  if (netwerkvermogen < SURPLUS_OVERSCHOT_WATT) {
    // Veel overschot! Thermostaat mag ook meeprofiteren (SURPLUS-logica)
    zonneBoostActief = true;
    zonnebufferReden = 'Zonne-boost AAN (SURPLUS): Buffervat actief + veel overschot (' + netwerkvermogen + 'W < ' + SURPLUS_OVERSCHOT_WATT + 'W)';
  } else {
    // Normaal: buffervat krijgt voorkeur, thermostaat wacht
    zonneBoostActief = false;
    zonnebufferReden = 'Zonne-boost WACHT: Buffervat prio (overschot ' + netwerkvermogen + 'W > ' + SURPLUS_OVERSCHOT_WATT + 'W drempel)';
  }
} else {
  // Buffervat is niet actief, normale zonne-boost logica voor Thermostaat
  if (vorighZonneBoostActief) {
    if (netwerkvermogen > ZONNE_BOOST_UIT_WATT) {
      zonneBoostActief = false;
      zonnebufferReden = 'Zonne-boost UIT via buffer: netwerk ' + netwerkvermogen + 'W > ' + ZONNE_BOOST_UIT_WATT + 'W';
    } else {
      zonneBoostActief = true;
      zonnebufferReden = 'Zonne-boost blijft AAN via buffer: netwerk ' + netwerkvermogen + 'W <= ' + ZONNE_BOOST_UIT_WATT + 'W';
    }
  } else {
    if (netwerkvermogen < ZONNE_BOOST_AAN_WATT) {
      zonneBoostActief = true;
      zonnebufferReden = 'Zonne-boost AAN via buffer: netwerk ' + netwerkvermogen + 'W < ' + ZONNE_BOOST_AAN_WATT + 'W';
    } else {
      zonneBoostActief = false;
      zonnebufferReden = 'Zonne-boost blijft UIT via buffer: netwerk ' + netwerkvermogen + 'W >= ' + ZONNE_BOOST_AAN_WATT + 'W';
    }
  }
}

// ---------- Accu leeg (met hysterese) ----------
const vorighAccuLeeg = await haalVariabele(ACCU_LEEG_VARIABELE, false);
let accuLeeg;

if (!Number.isFinite(accuSoc)) {
  accuLeeg = true;
} else if (vorighAccuLeeg) {
  accuLeeg = accuSoc < ACCU_WEER_VOL_PROCENT;
} else {
  accuLeeg = accuSoc <= ACCU_LEEG_PROCENT;
}

// ---------- Vorige status ----------
const vorigheModus = await haalVariabele(LAATSTE_MODUS_VARIABELE, 'ONBEKEND');
const vorighDoeltemp = await haalVariabele(LAATSTE_DOELTEMP_VARIABELE, huidigDoeltemperatuur);

// --------------------------
// Logica
// --------------------------
let modus = 'WEG';
let doeltemp = SETPOINT_WEG;
let redenen = [];

redenen.push('Prijs: ' + afronding(huidigePrijs));
redenen.push('Rang: #' + huidigePrijsRang);
redenen.push('Accu: soc=' + (Number.isFinite(accuSoc) ? accuSoc + '%' : 'onbekend') +
  (accuHeeftVoorrang ? ' (Accu voorrang < ' + ACCU_SOC_VOORRANG_PROCENT + '%)' : ''));
redenen.push('Buffervat prio: ' + (bufferbatZonneActief ? 'ACTIEF' : 'inactief'));
redenen.push(zonnebufferReden);

if (isKoeling) {
  // --- Koeling: eenvoudige logica op basis van aanwezigheid ---
  redenen.push('Modus: KOELING (' + thermostaatModus + ')');
  if (!iemandThuis || opVakantie) {
    modus = 'KOELING_WEG';
    doeltemp = SETPOINT_KOELING_WEG;
    redenen.push(!iemandThuis ? 'Niemand thuis' : 'Vakantie');
  } else {
    modus = 'KOELING_THUIS';
    doeltemp = SETPOINT_KOELING_THUIS;
    redenen.push('Aanwezig: ' + aanwezigenGebruikers.length);
  }
} else if (!iemandThuis && opVakantie) {
  modus = 'VAKANTIE';
  doeltemp = SETPOINT_VAKANTIE;
  redenen.push('Vakantie: niemand thuis en op vakantie');
} else if (!iemandThuis) {
  modus = 'WEG';
  doeltemp = SETPOINT_WEG;
  redenen.push('Niemand thuis');
} else {
  redenen.push('Aanwezig: ' + aanwezigenGebruikers.length);

  // Prioriteit:
  // 1. Zonne-overschot -> 21.0
  // 2. Negatieve all-in prijs -> 21.0
  // 3. Dure periode binnen VOORVERWARM_UREN -> 21.0 (voorverwarmen)
  // 4. Duur blok -> 19.0 (ook met volle Accu: anders trekt de warmtepomp de Accu
  //    leeg in de piek en staat hij in de dure uren gewoon te verwarmen)
  // 5. Accu leeg -> gewone prijsprogramma (goedkoop 20.0 / anders 19.5)
  // 6. Accu niet leeg -> 19.5 (Accu vangt de rest op)
  if (zonneBoostActief) {
    modus = 'BOOST_ZONNE';
    doeltemp = SETPOINT_THUIS_EXTRA;
    redenen.push('Zonne-overschot actief');
  } else if (isNegatievePrijs) {
    modus = 'BOOST_NEGATIEF';
    doeltemp = SETPOINT_THUIS_EXTRA;
    redenen.push('Negatieve all-in prijs (' + afronding(huidigePrijs) + ')');
  } else if (isVoorverwarmen) {
    modus = 'BOOST_VOORVERWARMEN';
    doeltemp = SETPOINT_THUIS_EXTRA;
    redenen.push('Voorverwarmen: duur blok over ' + duurBlokOver + ' min (drempel ' +
      afronding(duurDrempel, 4) + ', ' + duurDrempelBron + ')');
  } else if (isDuurUur) {
    modus = 'ECO_DUUR';
    doeltemp = SETPOINT_THUIS_ECO;
    redenen.push('Duur blok (rang #' + huidigePrijsRang + '): ECO');
  } else if (accuLeeg) {
    redenen.push('Accu leeg: gewone prijsprogramma');
    if (isGoedkoopUur) {
      modus = 'BOOST_GOEDKOOP';
      doeltemp = SETPOINT_THUIS_BOOST;
    } else {
      modus = 'NORMAAL';
      doeltemp = SETPOINT_THUIS_NORMAAL;
    }
  } else {
    modus = 'NORMAAL_ACCU';
    doeltemp = SETPOINT_THUIS_NORMAAL;
    redenen.push('Accu niet leeg: prijs genegeerd');
  }
}

// --------------------------
// Hysterese doeltemperatuur
// --------------------------
let hysteriseHoudtAan = false;

if (Math.abs(huidigDoeltemperatuur - doeltemp) < 0.2) {
  hysteriseHoudtAan = true;
  doeltemp = huidigDoeltemperatuur;
}

// --------------------------
// Toepassen
// --------------------------
let gewijzigd = false;
let actie = 'geen';

if (doeltemp !== huidigDoeltemperatuur) {
  await thermostaat.setCapabilityValue('target_temperature', doeltemp);
  gewijzigd = true;
  actie = 'stel doeltemperatuur in ' + huidigDoeltemperatuur + ' -> ' + doeltemp;
  redenen.push('Actie uitgevoerd: ' + actie);
} else {
  redenen.push('Geen wijziging');
}

// Zonne-buffer status opslaan
await stellogicaVariabeleIn(ZONNE_BOOST_ACTIEF_VARIABELE, 'boolean', zonneBoostActief);
await stellogicaVariabeleIn(ACCU_LEEG_VARIABELE, 'boolean', accuLeeg);

// --------------------------
// Logging
// --------------------------
const timestamp = haalNuLokaal();
const redenenTekst = redenen.join(' | ');
const modusGewijzigd = modus !== vorigheModus;
const doeltempGewijzigdTegenVorigeRun = Number(vorighDoeltemp) !== Number(doeltemp);

const samenvatting =
  '[' + timestamp + ']' +
  ' modus=' + modus +
  ', thermostaatModus=' + thermostaatModus +
  ', isKoeling=' + isKoeling +
  ', uur=' + uur +
  ', opVakantie=' + opVakantie +
  ', iemandThuis=' + iemandThuis +
  ', aanwezigenAantal=' + aanwezigenGebruikers.length +
  ', accuSoc=' + (Number.isFinite(accuSoc) ? accuSoc : 'onbekend') +
  ', accuVoorrang=' + accuHeeftVoorrang +
  ', accuLeeg=' + accuLeeg +
  ', isNegatievePrijs=' + isNegatievePrijs +
  ', voorverwarmen=' + isVoorverwarmen +
  ', duurBlokOver=' + duurBlokOver +
  ', duurDrempel=' + (duurDrempel !== null ? afronding(duurDrempel, 4) : 'onbekend') + '(' + duurDrempelBron + ')' +
  ', huidigePrijs=' + afronding(huidigePrijs) +
  ', rangVandaag=' + huidigePrijsRang + '/' + BLOKKEN_PER_DAG +
  ', zonneBoostActief=' + zonneBoostActief +
  ', zonneAanDrempel=' + ZONNE_BOOST_AAN_WATT +
  ', zonneUitDrempel=' + ZONNE_BOOST_UIT_WATT +
  ', isGoedkoopUur=' + isGoedkoopUur +
  ', isDuurUur=' + isDuurUur +
  ', huidigDoeltemp=' + huidigDoeltemperatuur +
  ', doeltemp=' + doeltemp +
  ', gewijzigd=' + gewijzigd +
  ', reden=' + redenenTekst;

await voegLogRegelToe(samenvatting);
await stellogicaVariabeleIn(LAATSTE_REDEN_VARIABELE, 'string', redenenTekst);
await stellogicaVariabeleIn(LAATSTE_MODUS_VARIABELE, 'string', modus);
await stellogicaVariabeleIn(LAATSTE_DOELTEMP_VARIABELE, 'number', doeltemp);
await stellogicaVariabeleIn(LAATSTE_RESULTAAT_VARIABELE, 'string', timestamp);

// --------------------------
// Tijdlijn
// --------------------------
let tijdlijnVerstuurd = false;
let tijdlijnTekst = '';

if (STUUR_TIJDLIJN_BIJ_WIJZIGING && (gewijzigd || modusGewijzigd || doeltempGewijzigdTegenVorigeRun)) {
  tijdlijnTekst =
    'Thermostaat ' + modus +
    ': ' + huidigDoeltemperatuur + '->' + doeltemp +
    ' (uur: ' + uur +
    ', prijs ' + afronding(huidigePrijs) +
    ', rang: ' + huidigePrijsRang +
    ', thuis: ' + iemandThuis +
    ', accu: ' + (Number.isFinite(accuSoc) ? accuSoc + '%' : '?') + ')';

  tijdlijnVerstuurd = await voegTijdlijnToe(tijdlijnTekst);
}

// --------------------------
// Retour
// --------------------------
return {
  modus: modus,
  thermostaatModus: thermostaatModus,
  isKoeling: isKoeling,
  opVakantie: opVakantie,
  iemandThuis: iemandThuis,
  aanwezigheidsBron: aanwezigheidsBron,
  aanwezigenGebruikers: aanwezigenGebruikers,
  aanwezigenAantal: aanwezigenGebruikers.length,
  netwerk: netwerkvermogen,
  p1Vermogen: p1Vermogen,
  accuVermogen: accuVermogen,
  accuSoc: Number.isFinite(accuSoc) ? accuSoc : null,
  accuHeeftVoorrang: accuHeeftVoorrang,
  accuSocVoorrangDrempel: ACCU_SOC_VOORRANG_PROCENT,
  accuBron: accuBron,
  accuLeeg: accuLeeg,
  isNegatievePrijs: isNegatievePrijs,
  isVoorverwarmen: isVoorverwarmen,
  duurBlokOver: duurBlokOver,
  duurDrempel: duurDrempel,
  duurDrempelBron: duurDrempelBron,
  kalePrijsNu: kalePrijsNu,
  huidigePrijs: huidigePrijs,
  rangVandaag: huidigePrijsRang,
  huidigDoeltemp: huidigDoeltemperatuur,
  doeltemp: doeltemp,
  gewijzigd: gewijzigd,
  actie: actie,
  blokkenPerDag: BLOKKEN_PER_DAG,
  isGoedkoopUur: isGoedkoopUur,
  isDuurUur: isDuurUur,
  isGoedkoopUurPerRang: isGoedkoopUurPerRang,
  isDuurUurPerRang: isDuurUurPerRang,
  zonneBoostActief: zonneBoostActief,
  buffervatZonneActief: bufferbatZonneActief,
  vorighZonneBoostActief: vorighZonneBoostActief,
  zonneboostAanDrempel: ZONNE_BOOST_AAN_WATT,
  zonneboostUitDrempel: ZONNE_BOOST_UIT_WATT,
  surplusOverschotDrempel: SURPLUS_OVERSCHOT_WATT,
  modusGewijzigd: modusGewijzigd,
  hysteriseHoudtAan: hysteriseHoudtAan,
  vorigheModus: vorigheModus,
  vorighDoeltemp: vorighDoeltemp,
  reden: redenenTekst,
  redenen: redenen,
  tijdlijnVerstuurd: tijdlijnVerstuurd,
  tijdlijnTekst: tijdlijnTekst,
  logVariabele: LOG_VARIABELE
};
