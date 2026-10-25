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

## Zonnemodus

Met zonnemodus aan laadt de auto alleen op overschot. Geef het netvermogen door met de
flowkaart *Geef netvermogen door* (positief = afname, negatief = teruglevering), bijvoorbeeld
elke keer dat je P1-meter verandert. Zonder update in 5 minuten pauzeert het laden.

## Tests

```bash
npm test
```
