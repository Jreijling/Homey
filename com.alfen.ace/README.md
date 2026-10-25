# Alfen ACE voor Homey

Leest een Alfen laadpaal (ACE / Eve Pro-line) uit via Modbus TCP en stuurt de laadstroom aan.

## Actueel vermogen

`measure_power` is de som van de drie fasen. Per fase leest de app het werkelijke vermogen
(registers 338-343). Geeft de laadpaal daar 0 of NaN terwijl er stroom loopt, dan wordt het
vermogen berekend uit spanning × stroom × arbeidsfactor (registers 306-333).

## Voorbereiding laadpaal

In de ACE Service Installer:

- Modbus TCP/IP aan (poort 502)
- Active load balancing → Data source: *Energy Management System*, zodat Homey de
  maximale laadstroom mag zetten

## Installeren

```bash
npm install -g homey
homey login
cd com.alfen.ace
homey app install
```

Voeg daarna in Homey een *Alfen laadpaal* toe en vul het IP-adres in.

## Load balancing

Vul bij de instellingen van het apparaat de **Device-ID energiemeter** in (bijvoorbeeld je
HomeWizard P1-meter) en de **hoofdzekering per fase** (standaard 25 A). De app leest elke
poll de stroom per fase van die meter, trekt de stroom van de laadpaal eraf en verlaagt de
laadstroom zodat geen fase boven *hoofdzekering − veiligheidsmarge* uitkomt. Blijft er
minder dan 6 A over, dan pauzeert het laden. Kan de meter niet gelezen worden, dan laadt de
app op de veilige stroom van de laadpaal.

De meter levert ook het netvermogen voor de zonnemodus; de flowkaart is dan niet nodig.

De device-ID vind je op https://tools.developer.homey.app → Devices, of in de URL van het
apparaat in de Homey webapp.

## Zonnemodus

Met zonnemodus aan laadt de auto alleen op overschot. Zonder energiemeter in de instellingen
geef je het netvermogen door met de flowkaart *Geef netvermogen door* (positief = afname, negatief = teruglevering), bijvoorbeeld
elke keer dat je P1-meter verandert. Zonder update in 5 minuten pauzeert het laden.

## Tests

```bash
npm test
```
