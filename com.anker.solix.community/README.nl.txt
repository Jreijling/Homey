Volg je Anker SOLIX thuisaccu, zonne-energie en slimme meter in Homey via je Anker-account, en laat Homey Energy de accu aansturen.

Verschil met de officiële Anker SOLIX app
De officiële app van Anker werkt via je lokale netwerk (Modbus TCP) en ondersteunt de Solarbank Max AC, Solarbank Max, XE (AC), Solarbank 4 E5000 Pro, Smart Meter Gen 2 en Smart Plug Gen 2. Deze community-app werkt via de Anker-cloud en ondersteunt daardoor ook apparaten die de officiële app niet kent:
- Oudere Solarbanks zonder Modbus: E1600 (Solarbank 1), Solarbank 2 Pro, 2 AC, 2 Plus en Solarbank 3 E2700 Pro.
- De Anker P1 Meter en de Anker 3-fase Smart Meter (A17X7), die als hoofdmeter in Homey Energy kunnen dienen.
- Een Power System-apparaat met de totalen van je hele Anker-systeem.
- Flows voor het starten of stoppen van laden en ontladen, en voor import en export van het net.
Heb je alleen apparaten die de officiële app ondersteunt, kies dan de officiële app: die heeft geen Anker-account nodig en werkt ook op Homey Cloud.

Ondersteunde apparaten
- Solarbank: E1600, Solarbank 2 Pro, 2 AC, 2 Plus, Solarbank 3 E2700 Pro en Solarbank Max AC. Toont accuniveau, zonnevermogen, laad- en ontlaadvermogen, AC-uitvoer en de totale geladen en ontladen energie.
- Slimme meter: Anker P1 Meter, Anker 3-fase Smart Meter en compatibele Shelly-meters. Toont import en export van het net met updates om de paar seconden.
- Power System: één overzichtsapparaat per Anker-systeem met totaal zonnevermogen, huisverbruik, netvermogen en gemiddeld accuniveau.

Accu aansturen (Solarbank Max AC)
Met een Solarbank Max AC in je lokale netwerk kun je een doelvermogen voor de accu instellen. Homey Energy en andere energiebeheer-apps kunnen de accu dan laden of ontladen, op het huidige niveau vasthouden of vanuit het net laden. Zet Modbus aan in de app-instellingen en vul het IP-adres van de Solarbank in. Andere Solarbanks kun je alleen volgen; hun uitvoervermogen en teruglevering stel je in via een Flow.

Flows
Start Flows wanneer de accu begint of stopt met laden, begint met ontladen, of wanneer het net begint met importeren of exporteren. Controleer accuniveau, zonnevermogen of netimport in voorwaarden, en stel vanuit een Flow het uitvoervermogen of de teruglevering in.

Instellen
Open de app-instellingen en log in met het e-mailadres, wachtwoord en land van je Anker-account. Voeg daarna je apparaten toe. Anker staat één actieve sessie per account toe; gebruik daarom een apart Anker-account (gedeeld met je hoofdaccount) als je tegelijk ingelogd wilt blijven in de Anker-app.

Deze app is gemaakt door de community en is niet verbonden aan of goedgekeurd door Anker. Hij werkt alleen op Homey Pro.
