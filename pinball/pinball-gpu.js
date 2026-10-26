/*
 * FRIDAYVFX Pinball - Modelle, Darstellung, Bedienung (WebGPU-Fassung)
 *
 * Die Simulation steht in physik.js, der Grundriss in tisch.js, die Regeln in
 * spiel.js, die Flaechengrafik in spielfeld.js. Hier wird daraus ein Bild und
 * eine Bedienung - und sonst nichts.
 *
 * Diese Datei ist die Portierung von pinball.js auf WebGPU und WGSL. Modelle,
 * Kamera, Eingabe und Anzeige sind unveraendert uebernommen; neu ist alles,
 * was in pinball.js an gl.* hing: Puffer, Texturen mit selbst erzeugten
 * Mipmaps, Wuerfelkarten, die Render-Paesse fuer Szene und Glanzschleier und
 * die Uniform-Puffer je Objekt. pinball.js bleibt fuer webgl.html erhalten.
 *
 * Koordinaten: auf dem Tisch wird in (x quer, y laengs, h ueber dem Feld)
 * gerechnet, alles in Metern. Beim Zeichnen kippt `welt()` die Ebene um die
 * Neigung. Richtungen muessen mit `weltRichtung()` umgerechnet werden, nicht
 * mit `welt()` - sonst wandern Normalen mit der Verschiebung mit.
 */
(function () {
	"use strict";

	// ------------------------------------------------- Licht und Belichtung
	/*
	 * Stellschrauben fuer den dunklen Raum (Pinball-Look Stufe 1, Task 4).
	 * Die Umgebung ist ein dunkler Innenraum mit wenigen Lampen ("Colorful
	 * Studio", Poly Haven, CC0), gebaut von tmp/baue_umgebung.js. Stand
	 * Task 3: Spiegelwuerfel im Mittel 0.13 (Task 4: 0.18) mit Lampen bis 60
	 * (30), Farbsaettigung 0.65; Kuppellicht unveraendert im Mittel 0.35.
	 * Spiegel- und Kuppelwuerfel sind bewusst ENTKOPPELT (Task 4: Faktor
	 * 3.19, env 1.2527 zu kuppel 0.3933; jetzt 0.6912 zu 0.3933): die
	 * Spiegelung soll Waende zeigen und Lampen deckeln, das Kuppellicht die
	 * volle Lampenenergie tragen. Begruendung der Task-3-Werte (1920x1080):
	 * Rohr-Oberseiten (Raum im Chrom) 70-84 unter dem bedruckten Feldmittel
	 * 103; Inlane-Rohre R/B 1.01-1.23 (vorher 1.47-1.90, Ziel <= 1.25);
	 * Kugel im Spiel Mittel 117 bei Grund 44-60 (>= 1.6x), Glanzpunkt 255.
	 * Gemessen am 1920x1080-Startbild (tmp/pinball/t4-*.png, Luma 0-255);
	 * Ziel: unbedruckter Feldgrund 35-70, Chromposten-Spitze ueber 180.
	 *
	 * BELICHTUNG    Faktor vor der ACES-Kurve, fuer alles in fsNetz (vorher
	 *               fest im Shader). Feldgrund bei 1.0 / 0.85 / 0.8 / 0.7:
	 *               51-84 / 44-64 / 43-69 / 39-63, Postenspitzen 202-218 /
	 *               187-231 / 181-231 / 180-200 (je nach Attract-Phase).
	 *               0.85 haelt den Grund im Ziel und die Posten mit Abstand
	 *               ueber 180; bei 1.0 wird das Blau des Felds warmgrau, ab
	 *               0.8 abwaerts kratzen die Posten an der Grenze. (Die
	 *               Lampen-Sprites liegen nach der Kurve, sie haengen nicht
	 *               an diesem Wert.)
	 * LICHT_DIFFUS  Diffusanteil des warmen Fuehrungslichts (vorher 0.14).
	 *               Das Kuppellicht nach oben sank mit dem dunklen Raum nur
	 *               von 0.87 auf 0.78 - das Feld saeuft nicht ab. Der hoehere
	 *               Anteil gibt dem gerichteten Licht mehr Gewicht neben dem
	 *               Kuppellicht, Rundungen und Schatten lesen sich.
	 * GLAS_SPIEGEL  Blendkonstante der Deckglas-Spiegelung (vorher 0.16 vor
	 *               der Studio-Softbox: grauer Schleier, Feldgrund unten 96).
	 *               Im dunklen Raum spiegelt das Glas nur noch Lampen.
	 * HG_*          Hintergrundverlauf in Anzeigewerten (rgba8unorm, ohne
	 *               Gamma): oben, unten, dazu ein warmer Saum am oberen Rand,
	 *               als fiele dort Licht einer Deckenlampe ein. Im Bild 2
	 *               unten bis 6-8 oben (vorher 23 bis 37).
	 */
	var BELICHTUNG = 0.85;
	var LICHT_DIFFUS = 0.22;
	var GLAS_SPIEGEL = 0.10;
	var HG_OBEN = 0.012, HG_UNTEN = 0.004;
	var HG_SAUM = [0.040, 0.026, 0.014];
	// Zahl als WGSL-Gleitkommaliteral, fuer die Stellschrauben in den Shadern
	function wf(x) { return x.toFixed(5); }

	// ------------------------------------- Lampen und Inserts (Look Stufe 1, Task 2)
	/*
	 * Die Lampen-Sprites (pipeLampe) wurden in der WebGPU-Fassung bis Task 2
	 * nie gezeichnet (Rueckseitenentfernung, siehe Task-1-Bericht); alles,
	 * was vorher als Lampenhof zu sehen war, kam aus den sechs Punktlichtern
	 * in fsNetz. Jetzt zeichnet jedes Sprite zwei Dinge additiv im
	 * Anzeigeraum (nach der Tonkurve):
	 *
	 *   emission = farbe * (maske * an * K_INSERT + hof * an^2 * K_HOF)
	 *
	 * K_INSERT      Hinterleuchtetes Insert: die Maske (einsatzMaske aus
	 *               spielfeld.js, 512 x 1024 rg8unorm, gleiche uv wie das
	 *               Feldbild; r = Form ohne Druck, g = Form mit Druck) laesst
	 *               nur die Kunststoffform leuchten. Look-Entscheidung
	 *               (Fix-Runde 1): beleuchteter Kunststoff, kein Blob -
	 *               0.55 statt 0.9. Gemessen Bonus 1, an = 1 (Lampen-Punkt-
	 *               licht auf der Form gedaempft, s. LAMPE_UEBER_INSERT):
	 *               Mitte 167, Rand 133-139, Ziffer 54, R 203 unter der
	 *               Bloom-Schwelle 219; an = 0.6: 127 / 104 / 45. Luma 200
	 *               waere nur mit R-Clipping (K >= 0.72) zu haben - Gelb hat
	 *               im Rot den Kopf, nicht in der Luminanz.
	 * INSERT_RAND   Birnen-Gefaelle der Emission: Mitte 1.0, am Rand des
	 *               Inserts 0.6 (ueber das Glimmbild am ganzen Quad) - der
	 *               Umriss bleibt lesbar, der Hotspot sitzt ueber der Birne.
	 * K_HOF         Weicher Hof um die Lampe (Glimmbild), quadratisch in an,
	 *               damit die 29 Attract-Lampen bei 0.05 keinen Schleier
	 *               legen. Ueber der ganzen Form (g, auch im Druck) um
	 *               HOF_UEBER_MASKE = 1 gedaempft. A/B mit und ohne Sprites,
	 *               Bonus 1 an = 1: Umriss +31, 1 mm +21, 5 mm +9, 10 mm +3
	 *               (Ziel +25-30 / +8 / +3); Grund 10 mm daneben 86 (<= 90),
	 *               das ist das Punktlicht.
	 * HOF_RADIUS    Hof ueber das ganze Quad (Lampenradius); 0.6 reichte nur
	 *               1.5 mm ueber die Scheibe hinaus.
	 * LAMPE_UEBER_INSERT  Im Feld-Shader entfaellt das Punktlicht ueber den
	 *               Insert-Flaechen (Maske g, nur Inneres ab Deckung 0.6):
	 *               die Birne sitzt unter dem Insert, sie strahlt es nicht von
	 *               oben an. Ohne das lag die eigene Lichtpfuetze auf der
	 *               Form: Bonus 1 bei K 0.55 trotzdem 245 (gesaettigt), der
	 *               Auslaufpfeil lachsfarben (255,140,94) statt rot (215,61,44).
	 * LAMPE_H       Lampen-Quad 0.1 mm ueber dem Feld. 1.2 mm gaben bei der
	 *               flachen Sicht 2 mm Parallaxe (heller Saum ueber, dunkler
	 *               Streifen unter dem Umriss), 0.3 mm noch 0.5 mm; mit 0.1 mm
	 *               trifft die Leuchtkante den gemalten Umriss im Laengsprofil
	 *               auf 1 mm Messraster.
	 * LAMPE_GLANZ   Glanzpunkt der Lampen auf Chrom und Lack: GGX-Keule
	 *               (alpha = max(r^2, LAMPE_ALPHA)) x F0 x N.L. Task 2 hatte
	 *               0.03 / 0.9: ein subpixelgrosser Funke auf dem Posten
	 *               (216,204,153), auf duennem Chrom (Banden, Rohre) gar
	 *               nichts. Die Quelle ist eine 27-mm-Scheibe in 22 mm
	 *               Abstand, also eine breite Keule: LAMPE_ALPHA 0.15 und
	 *               LAMPE_GLANZ 1.6 (Pruefung Task 2, 0.12-0.20 / 1.5-2.0).
	 *               Gemessen Task 3 (1920x1080, nach der Feldspiegelung und
	 *               dem Windungs-Fix der Rohre/Kugel): Posten neben den
	 *               Bumperlampen (an = 1) Spitzen 248 / 234 / 226 (der
	 *               hintere Posten bei y 0.905 ist kleiner), waermster Pixel
	 *               (240,229,104) und (232,206,35) - gelber Reflex, R > G > B;
	 *               Sling-Posten mit Sling-Lampe 0.98: 245 / 255, (236,223,94).
	 *               Auf der Kugel liegt der Spiegelpunkt einer 22-mm-Lampe von
	 *               der Kamera aus am Rand (N.V 0.37) - die Kugel bekommt ihre
	 *               Lampen durch die Feldspiegelung (unten), nicht hier.
	 * LAMPE_DIFFUS  Diffuses Lampenlicht auf dem Feld und den Teilen; die
	 *               sechs Punktlichter legen die Lichtpfuetzen, der Hof-Sprite
	 *               kommt obendrauf - Doppelzaehlung vermeiden. 1.0 hob den
	 *               Grund 10 mm neben dem Insert auf 114 und das Feld
	 *               zwischen den Slings um +45; 0.5 gibt 85 und +30. Auf
	 *               Metall zusaetzlich x (1 - metall) (Task 5, vorher
	 *               1 - 0.7 metall): Chrom spiegelt, es schimmert nicht milchig.
	 * EMISSION_GRAU Der neutrale Zuschlag der Emission (+0.22, gegen Gruenstich
	 *               am Flippergummi) gilt nur noch fuer helle Grundfarben
	 *               (Luminanz 0.1 -> 0.3 eingeblendet): Schwarz auf Bumper-
	 *               kappe und Backglas bleibt schwarz.
	 * BUMPER_*      Koerper leuchtet von innen (0.22 Grund + Blitz 0.75), die
	 *               Kappe schwach (0.12) mit hellerer Mitte im Teileblatt.
	 */
	var K_INSERT = 0.55, K_HOF = 0.55, HOF_RADIUS = 1.0, HOF_UEBER_MASKE = 1.0;
	var INSERT_RAND = 0.6;                     // Emission am Insert-Rand relativ zur Mitte (Birne unter der Mitte)
	var LAMPE_UEBER_INSERT = 1.0;              // Punktlicht-Anteil, der auf Insert-Flaechen des Felds entfaellt
	var LAMPE_H = 0.0001;                      // Hoehe der Lampen-Quads ueber dem Feld
	var LAMPE_GLANZ = 1.9, LAMPE_DIFFUS = 0.5, LAMPE_ALPHA = 0.15;   // GLANZ 1.6 -> 1.9 (Task 5, s. LAMPE_GLANZ_H)
	var EMISSION_GRAU = 0.22, EMISSION_GRAU_AB = 0.10, EMISSION_GRAU_BIS = 0.30;
	var BUMPER_KOERPER_LEUCHT = 0.22, BUMPER_KOERPER_BLITZ = 0.75;   // 0.30 -> 0.22 (Task 5)
	var BUMPER_KAPPE_LEUCHT = 0.12, BUMPER_KAPPE_BLITZ = 0.35;

	// ------------------------- Feldspiegelung und Lichtkarte (Look Stufe 1, Task 3)
	/*
	 * Chrom und Kugel spiegelten bis Task 3 nur die Umgebungskarte: die
	 * Kugel zeigte unten den grauen Glanzboden des Raums (milchig), nie das
	 * Feld. Jetzt schneidet fsNetz bei Metallteilen mit spiegelFeld = 1 den
	 * Spiegelstrahl R = reflect(-V, N) mit der Feldebene (Welt: feldP,
	 * feldN) und liest an der Trefferstelle das Feldbild (texBild, gleiche
	 * uv-Abbildung wie baueSpielfeldNetz ueber feldUv = [xr, y0, y1]) und die
	 * Lichtkarte. Ausserhalb des Felds oder bei einem Strahl nach oben bleibt
	 * die Umgebungskarte; am Feldrand blendet ein 4-mm-smoothstep.
	 *
	 * Die Lichtkarte (texLicht, LICHT_B x LICHT_H rgba8unorm, mit Mipmaps)
	 * wird je Bild VOR der Szene gezeichnet: alle 29 Lampen in EINEM
	 * instanzierten Draw, je Lampe Insert-Form (Maske R) x an x Farbe plus
	 * ein schwacher Hof x an^2. Die sechs Punktlichter der Szene reichen nicht
	 * - im Attract sind viele Lampen an. Und: das Punktlicht ueber einem
	 * leuchtenden Insert ist im Feld abgeschaltet (LAMPE_UEBER_INSERT), die
	 * Spiegelung nimmt es ebenfalls nicht mit - gespiegelte Inserts leuchten
	 * nur aus Maske x Lampenzustand, sonst saettigen sie wie in Task 2.
	 *
	 * SPIEGEL_RAUH    Mip-Bias des Feldbilds je Rauheit (texEnv nimmt 7).
	 * SPIEGEL_WEITE   Weichzeichnung mit dem Abstand t des Treffers:
	 *                 Bias + log2(1 + t * SPIEGEL_WEITE). Die Keule einer
	 *                 Rauheit von 0.035 ist bei 1 m etwa 3 cm breit, 60 Texel
	 *                 des Feldbilds; mit 8 liegt das Fernfeld in der Kugel
	 *                 vier Stufen weicher als das Feld direkt darunter.
	 * SPIEGEL_KANTE   Blende am Feldrand, 4 mm.
	 * SPIEGEL_AO      Das Feld unter einem Teil liegt in dessen eigenem
	 *                 Kontaktschatten; im Feldbild steht der nicht (Kugel-
	 *                 schatten ist ein eigener Draw). Abdunklung des Treffers
	 *                 nahe der Beruehrung, laeuft bis SPIEGEL_AO_R aus - ohne
	 *                 sie ist die Kugelunterseite heller als der Grund.
	 * K_SPIEGEL_INSERT  Leuchten der Inserts im Spiegelbild, linear vor der
	 *                 Kurve. Kalibriert am gespiegelten Bonus-Insert 1 (an = 1)
	 *                 in der Kugel daneben: 0.45 gab (255,255,249), weiss und
	 *                 ausgebrannt, das Insert selbst misst 140-162; mit 0.28
	 *                 bleibt der Reflex gelb und unter der Bloom-Schwelle.
	 * Lampenpfuetzen  Das gezeichnete Feld bekommt von den sechs Punktlichtern
	 *                 Lichtpfuetzen (Wrap-Lambert, LAMPE_DIFFUS); der Treffer
	 *                 der Spiegelung bekommt dieselben, sonst ist der
	 *                 gespiegelte Grund neben einer Lampe dunkler als der
	 *                 gezeichnete. Ueber Insert-Flaechen entfallen sie wie im
	 *                 Feld (LAMPE_UEBER_INSERT) - die Deckung steht im Alpha
	 *                 der Lichtkarte.
	 * LICHT_INSERT / LICHT_HOF  Gewichte in der Lichtkarte (Form x an bzw.
	 *                 Glimmbild x an^2); die Karte ist auf 1 begrenzt.
	 * LICHT_B/H       Aufloesung der Lichtkarte: 256 x 512 sind 2.1 x 2.6 mm
	 *                 je Texel, ein Bonus-Insert (r 13.5 mm) ist 6 Texel gross.
	 *                 LICHT_STUFEN Mipmaps bis 4 x 8, sonst flimmern ferne
	 *                 Inserts in der 20-px-Kugel.
	 * RINNE_FARBE     Unter der Abschussrinne zeigt das Feldbild nur Grund; die
	 *                 Rinne selbst (Holz, 0.6 mm darueber) ist ein eigenes Netz.
	 *                 Im Spiegelbild bekommt das Rinnenrechteck deshalb den
	 *                 Mittelwert der Holztextur (linear, gemessen an holz.jpg:
	 *                 sRGB 203/162/119) - die Kugel in der Rinne sieht Holz.
	 */
	var SPIEGEL_RAUH = 6.0, SPIEGEL_WEITE = 8.0, SPIEGEL_KANTE = 0.004;
	var SPIEGEL_AO = 0.55, SPIEGEL_AO_R = 0.030;
	var K_SPIEGEL_INSERT = 0.28;
	var LICHT_INSERT = 1.0, LICHT_HOF = 0.25;
	var LICHT_B = 256, LICHT_H = 512, LICHT_STUFEN = 7;
	var RINNE_FARBE = [0.60, 0.37, 0.19];
	var spiegelFaktor = 1;                        // Pruefstand: pinballDebug.spiegel(0) fuer A/B

	// -------------------------------------------- Finish (Look Stufe 1, Task 5)
	/*
	 * FLIPPER_*       Schlaeger als Kunststoff statt Metall 0.70 (das spiegelte
	 *                 das Feld flach grau, Pruefung Task 3): Farbe .93/.94/.96,
	 *                 Metall 0.05, Rauheit 0.32, keine Feldspiegelung. Netz mit
	 *                 gemittelten Normalen an den Rundungen und einer 1.5-mm-
	 *                 Fase als Zusatzring (prisma, opt.glatt / opt.fase); die
	 *                 Deckkante bleibt hart. Der Kapselschatten nutzt weiter
	 *                 FLIPPER_R1/R2 - die Fase rueckt nur den Deckel ein.
	 * ZIEL_FASE       Fallziele 1 mm Fase (die Sling-Platten sind plattenNetz
	 *                 mit eigenen Texturkoordinaten, dort keine).
	 * PLUNGER_*       Stange laengs der Rinne (Tisch +y) statt senkrecht (der
	 *                 Drehkoerper baut um lokal y, modellFuer legt lokal y auf
	 *                 die Tischnormale; eine Drehung um lokal x um -90 Grad
	 *                 davor legt die Achse auf Tisch +y). Spitze in Ruhe bei
	 *                 y = PLUNGER_SPITZE, 3 mm vor der ruhenden Kugel (deren
	 *                 Unterkante liegt bei 0.049); Stange bis vor die Vorder-
	 *                 wand (y -0.090), der Knauf davor aussen; Hub PLUNGER_HUB
	 *                 nach -y; Achse auf Kugelmitte (h = KUGEL_R). Seit Task
	 *                 5b liegt die Stirn im Bild (Zeile 1058-1064 von 1080,
	 *                 vorher 1095) und das Anschlag-Segment der Rinne
	 *                 (tisch.js, `unsichtbar`) hat kein Chromrohr mehr: die
	 *                 Kugel ruht 3 mm vor der Stirn direkt am Stoessel; der
	 *                 Hub geht von ihr weg, nur der Rueckschlag (12 mm) nach
	 *                 vorn, wenn sie laengst abgeschossen ist.
	 * BACKGLAS_*      Hinterleuchtete Anzeige: Rauheit 0.12 -> 0.04, Emission
	 *                 ohne Grauterm und ohne Punktlicht (texAn 3 im Shader:
	 *                 nur leucht * basis - Schwarz bleibt schwarz, Gruen bleibt
	 *                 gruen), Textur mit Mipmaps, nach jedem Neuzeichnen
	 *                 erneuert (Schrift flimmerte sonst aus der Entfernung).
	 *                 BACKGLAS_STUFEN 6 (Fix-Runde 1): die Scheibe ist im Bild
	 *                 etwa 390 px breit (Mip 1.4 am Desktop, 3 mobil), Stufen
	 *                 unter 32 px werden nie abgetastet; die 5 Blits laufen im
	 *                 Bild-Encoder nur bei Standaenderung (Draws dann 138,
	 *                 vorher 10 Blits mit eigenem Submit, 143 > 140).
	 *                 leucht 0.55: Ziffern Median 204 / Max 218 (vorher 190),
	 *                 Schwarz 10-11 (vorher 10-12), Logo 246; Ziffern im Canvas
	 *                 mit Canvas-Schatten (spielfeld.js). Der "Lampenfleck"
	 *                 unten im Backglas (Plateau 31 auf Grund 12, Pruefung
	 *                 Task 4) haengt NICHT an Rauheit oder Punktlicht: er ist
	 *                 die Softbox-Spiegelung im DECKGLAS, dessen Hinterkante
	 *                 (y L+0.075, h 0.108) im Bild 68 px ueber dem Backglas-
	 *                 Fuss (h 0.016) lag und das untere Viertel der Scheibe
	 *                 ueberlagerte - behoben in Task 5b (BACKBOX_SOCKEL, die
	 *                 Scheibe sitzt auf dem Deckglas): Schwarz unter der
	 *                 Lampenreihe 10 sRGB, Ziffern Max 207 unveraendert.
	 * BLOOM_*         Schwelle und Staerke des Glanzschleiers (vorher fest im
	 *                 Shader, 0.86 / 0.38). fsHell liest alle 16 Quellpixel
	 *                 des 4x4-Blocks mit Schwelle je Pixel statt eines
	 *                 bilinearen Abgriffs ueber 4: kleine Glanzpunkte fallen
	 *                 beim Verkleinern nicht mehr durch das Raster (Nachweis
	 *                 am Startbild, um 0-3 px verschoben: Bloom-Eingang der
	 *                 Kugel schwankte mit einem Abgriff um 271 %, mit vier
	 *                 bilinearen Abgriffen um 52 %, mit 16 Loads um 0 %).
	 * LAMPE_LICHT_H   Lichtort der sechs Punktlichter fuer den DIFFUS-Anteil,
	 *                 22 mm ueber dem Feld: breite Lichtpfuetzen (unveraendert).
	 * LAMPE_GLANZ_H   Lichtort fuer den GLANZ-Anteil: die Birne liegt im Feld
	 *                 unter dem Insert. Mit 3 mm fallen der GGX-Glanzpunkt und
	 *                 das gespiegelte Insert aus der Lichtkarte an dieselbe
	 *                 Stelle; auf den Posten sitzt der Reflex tiefer und wird
	 *                 heller: Posten mit Bumperlampen (an = 1, drei Kamera-
	 *                 phasen) Spitzen 221-238 / 237-238 / 229-235 bei 3 mm,
	 *                 202-234 bei 22 mm (LAMPE_GLANZ 1.9); 2.2 brachte nichts
	 *                 Systematisches (Streuung ist die Kameraschwankung).
	 *                 LAMPE_ALPHA 0.18 (Fix-Runde 1, breitere Keule) senkt die
	 *                 Spitze: 214/230/221, 227/230/229, 230/229/225 (3 von 9)
	 *                 gegen 221/239/230, 234/237/235, 236/235/229 bei 0.15
	 *                 (7 von 9, min 221, Median 235) - 0.15 bleibt. Toleranz:
	 *                 min >= 220, Median >= 230, der Glanzpunkt wandert mit
	 *                 der Kameraschwankung ueber die 6-px-Rundung des Postens.
	 * KUGEL_LAMPE_GLANZ  Lampen-Glanzpunkt je Teil (obj.lampGlanz, Byte 228):
	 *                 Kugel 0 - sie bekommt ihre Lampe aus der Feldspiegelung
	 *                 (EIN warmer Reflex, Luma 157-186, keine Aequator-Blobs
	 *                 > 220 mehr), das uebrige Chrom behaelt den Glanz (1).
	 *                 Eine pauschale Daempfung auf allen Teilen mit Feld-
	 *                 spiegelung, ggxL x (1 - 0.6 spiegelFeld) (Vorschlag der
	 *                 Pruefung Task 3), trifft Posten und Kugel gleich: die
	 *                 Posten fielen auf 197-218, der Kugelreflex blieb mit 244
	 *                 ausgebrannt - die Ziele (Posten >= 230, Kugelreflex
	 *                 140-170) widersprechen sich bei gleicher Daempfung.
	 *                 Lampen-Diffus auf Metall (1 - metall): Chrom schimmert
	 *                 nicht milchig (Kugel neben Insert Mittel 73 bei Grund 43,
	 *                 1.7x; vorher 101 mit 51 Pixeln >= 220).
	 * HOLZKANTE_*     Farbe [0.92,0.90,0.86] -> [0.66,0.62,0.56], Rauheit 0.46
	 *                 -> 0.35: die Holzleisten waren die hellsten Flaechen im
	 *                 Bild. Innerer Holzstreifen neben der Leiste 157-177 ->
	 *                 108-126 sRGB (Grund 48-68, Ziel um 120 und <= 2.3x).
	 * BUMPER_KOERPER_LEUCHT 0.30 -> 0.22 (Pruefung Task 2): Koerpermitte
	 *                 222 -> 209 sRGB bei Lampen aus.
	 * Flipper-Deck misst 232 sRGB (vorher Metall 177): die hellste matte
	 *                 Flaeche im Bild. FLIPPER_FARBE 0.86/0.87/0.90 gibt 222
	 *                 (gemessen, Fix-Runde 1, tmp/pinball/t5-f1-flipper-231-
	 *                 vs-215.png) - die Kurve drueckt oben; Entscheidung am
	 *                 Bild (Robert).
	 */
	var FLIPPER_FARBE = [0.93, 0.94, 0.96], FLIPPER_METALL = 0.05, FLIPPER_RAUHEIT = 0.32;
	var FLIPPER_FASE = 0.0015, ZIEL_FASE = 0.0010;
	var PLUNGER_SPITZE = 0.046, PLUNGER_LAENGE = 0.138, PLUNGER_HUB = 0.055;
	var BACKGLAS_RAUHEIT = 0.04, BACKGLAS_LEUCHT = 0.55, BACKGLAS_STUFEN = 6;
	var BLOOM_SCHWELLE = 0.86, BLOOM_STAERKE = 0.38;
	var LAMPE_LICHT_H = 0.022, LAMPE_GLANZ_H = 0.003;
	var KUGEL_LAMPE_GLANZ = 0.0;                 // Lampen-Glanzpunkt auf der Kugel (Spiegel zeigt die Lampe)
	var HOLZKANTE_FARBE = [0.66, 0.62, 0.56], HOLZKANTE_RAUHEIT = 0.35;
	var kameraVersatz = [0, 0, 0, 0, 0, 0];       // Pruefstand: pinballDebug.kamera(...), Weltversatz Auge und Ziel

	// ---------------------------------------------------------------- Masse
	var W = 0.26, L = 1.15;                    // halbe Schrankbreite, Laenge
	var NEIGUNG = 6.5 * Math.PI / 180;
	var KUGEL_R = 0.0135, KUGEL_M = 0.080;     // 27 mm, 80 g - Normmasse
	var SCHACHT_X = 0.206;
	var BANDE_R = 0.007;
	// Schrank: Wandstaerke, Unter-/Oberkante, Laenge (Flaechen: baueSchrankNetz)
	var SCHRANK_D = 0.034, SCHRANK_H0 = -0.060, SCHRANK_H1 = 0.093;
	var SCHRANK_Y0 = -0.090, SCHRANK_Y1 = L + 0.060;

	// ------------------------------------------- Backbox (Look Stufe 1, Task 5b)
	/*
	 * Bis Task 5 stand der Fuss der Anzeige-Scheibe auf h 0.016, 9 cm UNTER
	 * der Deckglas-Oberkante (GLAS_H 0.108): das additiv gezeichnete Deckglas
	 * ueberlagerte das untere Viertel der Anzeige mit der Softbox-Spiegelung
	 * (Plateau 25-35 sRGB zwischen BONUS und Lampenreihe, Zeilen 259-287 bei
	 * 1920x1080, Pruefung Task 5). Seit Task 5b sitzt die Backbox auf dem
	 * Schrank, ueber dem Glas; der Schrank hat dafuer eine Lederrueckwand
	 * (baueSchrankNetz).
	 * GLAS_HOCH, GLAS_KIPP  Hoehe und Rueckneigung der Scheibe. 0.335 -> 0.300
	 *                       (Task 5b): mit dem Fuss auf dem Glas passten
	 *                       Rahmenoberkante und Kugel in der Rinne sonst nicht
	 *                       beide in den 60-Grad-Bildwinkel (Kamera, RUHE_*).
	 * BACKBOX_SOCKEL        Fuss der Scheibe ueber dem Deckglas (Rahmenleiste,
	 *                       in die das Glas einschiebt): h = GLAS_H + 0.012.
	 * BACKBOX_RAHMEN_UNTEN  Rahmen 30 mm unter den Scheibenfuss, auf h 0.088
	 *                       bei y L+0.057 - knapp unter die Schrank-Oberkante
	 *                       (SCHRANK_H1 0.093): kein Spalt zwischen Schrank
	 *                       und Backbox.
	 * BACKBOX_RAHMEN_SEITE/OBEN  Rahmenbreite seitlich und oben, 22 mm (vorher
	 *                       22 seitlich, 30 oben, 0 unten).
	 * GLAS_HALB             halbe Scheibenbreite aus der Schrankbreite: der
	 *                       Rahmen (GLAS_HALB + BACKBOX_RAHMEN_SEITE) steht
	 *                       buendig mit der Schrank-Aussenkante W + SCHRANK_D
	 *                       (Fix-Runde 1; vorher W + 0.030, die Backbox
	 *                       ueberragte den Schrank je Seite 18 mm und hing mit
	 *                       den unteren Ecken in der Luft). Scheibe 0.544 m
	 *                       breit, Verhaeltnis 1.81 (spielfeld.js,
	 *                       backglasKunst legt die Zeilen danach aus).
	 * LEISTE_ENDE           Ende der Chrom-Seitenleisten am Kopfstueck, L+0.047
	 *                       (vorher 0.060): die Rahmenebene liegt in Rohrhoehe
	 *                       (h 0.084-0.102) bei y L+0.055..0.059; die Kappe
	 *                       (R 0.009) endet 1,8 mm vor der Rahmenebene, Fuge
	 *                       vom Rahmen und der Holzkante verdeckt.
	 */
	var GLAS_HOCH = 0.300, GLAS_KIPP = 0.16;
	var BACKBOX_SOCKEL = 0.012;
	var BACKBOX_RAHMEN_SEITE = 0.022, BACKBOX_RAHMEN_OBEN = 0.022, BACKBOX_RAHMEN_UNTEN = 0.030;
	var GLAS_HALB = W + (SCHRANK_D - BACKBOX_RAHMEN_SEITE);
	var LEISTE_ENDE = L + 0.047;

	// ------------------------------- Drahtfuehrungen (Look Stufe 1b, Task 8)
	/*
	 * Die beiden Gassenfuehrungen (die Trenner zwischen Rueckgasse und
	 * Auslaufgasse) sind Drahtschleifen aus Federstahl statt 12-mm-Rohren:
	 * zwei Draehte in Kugelmittenhoehe, oben eine Haarnadel, unten Beine in
	 * die Spielflaeche, am Knick der Trenner ein Mittelbuegel. Keine
	 * Unterlegscheiben (Fix-Runde 1: ihr flacher Deckel spiegelte nur eine
	 * warme Richtung, braune Ellipse 2.5x Drahtbreite). Achsen und Beinfuesse
	 * kommen aus tisch.js (T.draehte; Radius DRAHT_R 1.6 mm und Hoehe 12 mm
	 * stehen dort, Feldbild und Renderer lesen dieselben Zahlen). Netz:
	 * baueDrahtNetz / drahtEntlang3D (Rohr mit mitgefuehrtem Rahmen, keine
	 * Verdrehung an den Boegen). Draw: eigener Draw, Metall 1, Lampen-Glanz
	 * an, Feldspiegelung AUS (die Beine sahen das Feld wenige mm unter sich,
	 * SPIEGEL_AO dunkelte sie auf L 18-25 bei Feld 40-44; ohne: 86-105).
	 *
	 * DRAHT_BIEGUNG   Biegeradius, mit dem die Draehte unten in die Beine
	 *                 abknicken, 4 mm (2.5 Drahtradien - enger sieht nach
	 *                 Knick aus, weiter frisst die Laufstrecke).
	 * DRAHT_SEITEN    8 Seiten je Ring: der Draht ist im 1920x1080-Startbild
	 *                 5.6-8 px breit (1.75-2.54 px/mm quer), mehr Seiten sind
	 *                 unsichtbar (Rohre: 14).
	 * DRAHT_RAUHEIT   0.25: von Hand gesetztes Specular-AA fuer duenne
	 *                 Geometrie. Bei 0.04 (Task 8) war der GGX-Glanz des
	 *                 Fuehrungslichts kleiner als ein Pixel, und der 5-8 px
	 *                 duenne Draht zeigte den Mittelwert einer hohen Hardware-
	 *                 Mip der warmen Studio-Umgebung: kupferbraun, Drahtpixel
	 *                 R/B 1.33-1.49. Ein fester Mip-Level hilft nicht (Pruefung:
	 *                 Level 3 gibt weisse Funken) und ist nicht eingebaut.
	 *                 Gemessen Fix-Runde 1 (1920x1080, Startbild 6000 und
	 *                 8000 ms, alle vier Fuehrungen, Fenster +-4 px quer zur
	 *                 Drahtachse): hellste Zeile quer Median 106-138 bei
	 *                 Feldgrund 38-42 = 2.7-3.3x (Ziel >= 1.3x), Drahtpixel
	 *                 R/B 1.11-1.24 (Ziel <= 1.25). A/B 0.20: R/B bis 1.30;
	 *                 0.30: kaum anders als 0.25, etwas matter
	 *                 (tmp/pinball/t8-f1-rauheit3x.png).
	 * DRAHT_FARBE     F0 des Drahts, fast neutral weiss.
	 */
	var DRAHT_BIEGUNG = 0.004, DRAHT_SEITEN = 8;
	var DRAHT_RAUHEIT = 0.25, DRAHT_FARBE = [0.97, 0.97, 0.98];

	// ---------------------------------------- Schatten (Look Stufe 1, Task 1)
	/*
	 * Stellschrauben fuer die Schatten der bewegten Teile. Die festen Teile
	 * tragen ihre Schatten gebacken im Feldbild (spielfeld.js, Abschnitt 13).
	 *
	 * SCHATTEN_RICHTUNG  aus spielfeld.js: Versatz auf dem Feld je Meter Hoehe,
	 *                    [0.28, 0.40] aus dem Fuehrungslicht in fsNetz - nach
	 *                    rechts und zum Kopfende. Gebackene und bewegte
	 *                    Schatten fallen so in dieselbe Richtung.
	 * SCHATTEN_H         Hoehe der Schattenflaechen: 0.8 mm, ueber Feld (0) und
	 *                    Rinne (0.6 mm), unter der Flipperunterkante.
	 * KUGEL_SCHATTEN_*   Quad 60 x 60 mm (HALB 30 mm). Kern alpha 0.75 bis
	 *                    0.8 R - dort sieht der Boden nur noch die Kugel -, Hof
	 *                    bis 2.0 R auf 0 mit Exponent HOF_EXP (2.0 statt 1.5,
	 *                    Task 2: auf dem hellen Holz der Rinne lag sonst ein
	 *                    grosser Fleck). Mitte um R * Richtung versetzt (die
	 *                    Kugelmitte liegt R ueber dem Feld, ≈ +3.8 x, +5.4 y mm),
	 *                    in Lichtrichtung um 1.3 gestreckt: der Halbschatten
	 *                    wird zur Spitze hin laenger.
	 * FLIPPER_HOEHE      1.5 mm Luft unter dem Flipper statt 4 mm - echte
	 *                    Flipper schleifen fast; 4 mm lasen sich als Schweben.
	 * FLIPPER_R1/R2      Umriss des Flippers (Achse/Spitze), Netz und Schatten.
	 * FLIPPER_SCHATTEN_* Kapsel in Flipperform. Nachkalibriert in Task 2 (die
	 *                    Vorderkante mass Delta 8, Ziel 25-35): Rand 3 mm,
	 *                    innerer Auslauf INNEN -0.5 mm (vorher -1.5: der Kern
	 *                    begann erst 1.5 mm innerhalb der Kontur, die
	 *                    Kontaktkante war weich). Der Kontaktschatten (die
	 *                    Fuge, alpha 0.8) sitzt mit nur 1 mm Versatz fast
	 *                    unter dem Flipper - mit 4 mm Versatz lag er ganz
	 *                    hinter der Vorderkante (Delta 0 gemessen), mit 1 mm
	 *                    Delta 24 vorn und 33 an der Spitze (Grund 42). Dazu
	 *                    ein zweiter, weicher Schlagschatten um Richtung *
	 *                    10 mm mit alpha 0.35 (FLIPPER_SCHLAG_*); beide drehen
	 *                    ueber dieselbe Modellmatrix mit wie der Flipper.
	 */
	var SCHATTEN_RICHTUNG = (window.Spielfeld && window.Spielfeld.schattenRichtung) || [0.28, 0.40];
	var SCHATTEN_WINKEL = Math.atan2(SCHATTEN_RICHTUNG[1], SCHATTEN_RICHTUNG[0]);
	var SCHATTEN_H = 0.0008;
	var KUGEL_SCHATTEN_HALB = 0.030, KUGEL_SCHATTEN_KERN = 0.75, KUGEL_SCHATTEN_KERN_R = 0.8;
	var KUGEL_SCHATTEN_HOF_R = 2.0, KUGEL_SCHATTEN_HOF_EXP = 2.0, KUGEL_SCHATTEN_STRECKUNG = 1.3, KUGEL_SCHATTEN_ALPHA = 1.0;
	var FLIPPER_HOEHE = 0.0015, FLIPPER_R1 = 0.0118, FLIPPER_R2 = 0.0072;
	var FLIPPER_SCHATTEN_RAND = 0.003, FLIPPER_SCHATTEN_INNEN = -0.0005;
	var FLIPPER_SCHATTEN_VERSATZ = 0.001, FLIPPER_SCHATTEN_ALPHA = 0.8;
	var FLIPPER_SCHLAG_VERSATZ = 0.010, FLIPPER_SCHLAG_ALPHA = 0.35;
	var schattenFaktor = 1;                       // Pruefstand: pinballDebug.schatten(0) fuer A/B
	var kugelFest = null;                         // Pruefstand: pinballDebug.kugel(x, y)
	var spriteFaktor = 1;                         // Pruefstand: pinballDebug.sprites(0) fuer A/B

	var SIN = Math.sin(NEIGUNG), COS = Math.cos(NEIGUNG);

	// Abdeckung der Spielfeldtextur. Sie muss die obere Rundung einschliessen:
	// die Bande laeuft im Bogen um (0, L-0.20) mit Radius W und reicht damit
	// bis y = L + 0.06. Netz und Grafik lesen dieselben drei Zahlen.
	var FELD_XR = W + 0.012, FELD_Y0 = -0.075, FELD_Y1 = L + 0.085;

	// Raumabbildung und Matrizen kommen aus raum.js - dort sind sie pruefbar,
	// und genau dort steckte der Fehler, der alle Bauteile gespiegelt zeichnete.
	var RAUM = window.macheRaum(NEIGUNG);
	var welt = RAUM.welt, weltRichtung = RAUM.weltRichtung;
	var modellFuer = RAUM.modellFuer, normalMatrix = RAUM.normalMatrix;
	var m4 = RAUM.m4, ident = RAUM.ident, mul = RAUM.mul;
	var perspektive = RAUM.perspektive, blickAuf = RAUM.blickAuf;

	// ---------------------------------------------------------------- Tisch
	// Slingshots zum Vergleich (Spielgefuehl Paket 2a, Werte in tisch.js
	// SLING_*): ?sling_kick=<m/s>, ?sling_schwelle=<m/s>, ?sling_profil=0|1,
	// ?sling_sperre=<s>, ?sling_alt=1 (altes Verhalten 2.9/0/aus/0). Weicht
	// etwas vom Start ab, haengt das HUD "sling <kick>/<schwelle>" an.
	var SLING = window.slingAusAdresse(location.search);
	var T = window.baueTisch({ W: W, L: L, kugelR: KUGEL_R, bandeR: BANDE_R,
	                           schachtX: SCHACHT_X, sling: SLING });
	var XM = T.XM, SEG = T.segmente, SCHEIBE = T.scheiben, FL = T.flipper;
	var ZIELE = T.ziele, ROLL = T.rollover, MASS = T.masse;
	var BOGEN_Y = T.bogenY;
	var DRAHT_R = MASS.drahtR;                          // Drahtfuehrungen (tisch.js, Task 8); Hoehe je Draht in T.draehte[i].h

	// -------------------------------------------------------------- Physik
	// ?alt=1: altes Kontaktverhalten (vor Spielgefuehl Paket 1) zum Vergleich -
	// Kugel klebt am Flipper, Zusatzstoss auch beim Entfernen. Das HUD zeigt
	// dann "physik alt".
	var PHYSIK_ALT = new URLSearchParams(location.search).get("alt") === "1";
	var ph = new window.Physik({
		kugelR: KUGEL_R, kugelM: KUGEL_M,
		g: 9.81 * SIN,
		rollmu: 0.55,
		luft: 0.02,
		kontaktAlt: PHYSIK_ALT
	});
	ph.scheiben = SCHEIBE; ph.flipper = FL;

	function baueKollision() { ph.segmente = spiel.segmenteFuer(SEG); }

	// --------------------------------------------------------------- Spiel
	var spiel = window.macheSpiel({ ziele: ZIELE, rollover: ROLL });
	baueKollision();
	// Rinne, Abfluss, neue Kugel: spiel.js, in beiden Renderern derselbe Zyklus
	var zyklus = window.macheKugelZyklus({ ph: ph, spiel: spiel, schachtX: SCHACHT_X, bogenY: BOGEN_Y,
	                                       grenze: SCHACHT_X + KUGEL_R + BANDE_R, neueKugel: kugelInSchacht });
	var plunger = { zug: 0, laedt: false, rueck: 0 };
	var ruettel = 0;

	// `gefeuert`: hat der Kicker gestossen? Nur dann Punkte und Blitz (spiel.js)
	ph.beiTreffer = function (art, staerke, x, y, objekt, gefeuert) {
		if (spiel.beruehrung(art, objekt, gefeuert)) baueKollision();
	};

	function kugelInSchacht() {
		// Direkt auf dem Anschlag: 0.042 Wandmitte + 0.007 Bandenradius +
		// Kugelradius. So liegt sie ruhig, statt erst hineinzufallen.
		ph.setzeKugel((SCHACHT_X + W) / 2, 0.042 + BANDE_R + KUGEL_R + 0.001);
		ph.v = [0, 0]; ph.w = 0;
		zyklus.imSchacht = true;
		plunger.zug = 0;
	}

	function starteSpiel() {
		spiel.starte();
		baueKollision();
		kugelInSchacht();
	}

	function abschuss() {
		if (!plunger.laedt) return;
		plunger.laedt = false;
		if (zyklus.imSchacht && ph.aktiv) {
			// 3,2 bis 6,6 m/s - darunter kommt die Kugel nicht ueber den Bogen
			ph.v[1] = 3.2 + plunger.zug * 3.4;
			plunger.rueck = plunger.zug;
		}
		plunger.zug = 0;
	}

	function spielSchritt(dt) {
		for (var i = 0; i < FL.length; i++) {
			var f = FL[i], ziel = f.ziel ? f.voll : f.ruhe, vorher = f.w;
			var diff = ziel - f.w, max = 30 * dt;
			f.w = Math.abs(diff) <= max ? ziel : f.w + Math.sign(diff) * max;
			f.wv = (f.w - vorher) / dt;
		}
		ph.stoss[0] = ruettel; ruettel *= Math.exp(-14 * dt);
		ph.schritt(dt);
		// Pruefstand: pinballDebug.kugel(x, y) haelt die Kugel an einem Ort
		if (kugelFest) { ph.p[0] = kugelFest[0]; ph.p[1] = kugelFest[1]; ph.v[0] = 0; ph.v[1] = 0; ph.w = 0; zyklus.imSchacht = false; }

		// Abschussrinne (auch nach Rueckfall aus dem Feld), Rollover, Abfluss und
		// neue Kugel nach Wartezeit und Bonus - spiel.js, macheKugelZyklus
		zyklus.schritt(dt);
		plunger.rueck *= Math.exp(-9 * dt);
	}

	// ------------------------------------------------------------- Bilder
	function zeichneGlimmbild() {
		// Heller Kern, weicher Hof. Die Farbe kommt aus dem Shader, hier steht
		// nur die Verteilung - so genuegt ein Bild fuer alle Lampen.
		var N = 128, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		var rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
		rg.addColorStop(0.00, "rgba(255,255,255,1.00)");
		rg.addColorStop(0.16, "rgba(255,255,255,0.92)");
		rg.addColorStop(0.34, "rgba(255,255,255,0.42)");
		rg.addColorStop(0.62, "rgba(255,255,255,0.12)");
		rg.addColorStop(1.00, "rgba(255,255,255,0.00)");
		g.fillStyle = rg; g.fillRect(0, 0, N, N);
		return cv;
	}

	function glatt(a, b, x) {
		var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
		return t * t * (3 - 2 * t);
	}

	// Schattenbild aus einer Funktion des Ortes: schwarz, nur Alpha. Je Texel
	// gerechnet statt mit Canvas-Verlaeufen - Kern und Hof sollen genau dort
	// liegen, wo die Stellschrauben sagen.
	function schattenAusFunktion(b, h, alphaVon) {
		var cv = document.createElement("canvas");
		cv.width = b; cv.height = h;
		var g = cv.getContext("2d"), bild = g.createImageData(b, h), d = bild.data;
		for (var j = 0; j < h; j++) for (var i = 0; i < b; i++) {
			var a = alphaVon((i + 0.5) / b, (j + 0.5) / h);
			d[(j * b + i) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
		}
		g.putImageData(bild, 0, 0);
		return cv;
	}

	// Kugel: dunkler Kern bis 0.8 R, weicher Hof bis 2.0 R. Das Bild deckt
	// das Quad (Halbbreite KUGEL_SCHATTEN_HALB) ab; gemessen wird in R.
	function zeichneSchattenbild() {
		var halbInR = KUGEL_SCHATTEN_HALB / KUGEL_R;
		return schattenAusFunktion(128, 128, function (u, v) {
			var d = Math.hypot(u - 0.5, v - 0.5) * 2 * halbInR;
			var hof = 1 - glatt(KUGEL_SCHATTEN_KERN_R, KUGEL_SCHATTEN_HOF_R, d);
			return KUGEL_SCHATTEN_KERN * Math.pow(hof, KUGEL_SCHATTEN_HOF_EXP);
		});
	}

	/*
	 * Abstand zum Flipperumriss (konvexe Huelle zweier Kreise, Achse laengs x
	 * von 0 mit r1 bis l mit r2), negativ innen. Nach I. Quilez,
	 * "sdUnevenCapsule".
	 */
	function kapselAbstand(px, pz, r1, r2, l) {
		var qx = Math.abs(pz), qy = px;
		var b = (r1 - r2) / l, a = Math.sqrt(1 - b * b);
		var k = -b * qx + a * qy;
		if (k < 0) return Math.hypot(qx, qy) - r1;
		if (k > a * l) return Math.hypot(qx, qy - l) - r2;
		return qx * a + qy * b - r1;
	}

	// Flipperschatten: die Flipperform, voll deckend innen, weich auslaufend
	// ueber den Rand. 128 x 64 auf dem Rechteck von baueFlipperSchattenNetz.
	function flipperSchattenMasse() {
		var rand = FLIPPER_SCHATTEN_RAND;
		return { x0: -(FLIPPER_R1 + rand), x1: MASS.flipperL + FLIPPER_R2 + rand, z: FLIPPER_R1 + rand };
	}
	function zeichneFlipperSchattenbild() {
		var m = flipperSchattenMasse();
		return schattenAusFunktion(128, 64, function (u, v) {
			var x = m.x0 + u * (m.x1 - m.x0), z = -m.z + v * 2 * m.z;
			var s = kapselAbstand(x, z, FLIPPER_R1, FLIPPER_R2, MASS.flipperL);
			return 1 - glatt(FLIPPER_SCHATTEN_INNEN, FLIPPER_SCHATTEN_RAND, s);
		});
	}

	// --------------------------------------------------------------- WebGPU
	/*
	 * Der Renderer haelt dieselbe Reihenfolge ein wie die WebGL-Fassung: Szene
	 * in einen Puffer, dann der Glanzschleier in Viertelgroesse, zuletzt die
	 * Zusammenfuehrung auf die Leinwand. Zwei Dinge sind grundsaetzlich anders
	 * geloest, weil WebGPU sie nicht kennt:
	 *
	 * 1. UNIFORMS JE OBJEKT. gl.uniform* vor jedem Draw gibt es nicht. Alle
	 *    Objektwerte eines Bildes liegen in EINEM Puffer, 256 Byte je Eintrag
	 *    (die Ausrichtung fuer dynamische Versaetze), und werden einmal je Bild
	 *    hochgeladen; jeder Draw bindet seinen Eintrag ueber den Versatz.
	 *
	 * 2. ZEILE 0 LIEGT OBEN. Eine gerenderte Textur beginnt in WebGPU oben,
	 *    in WebGL unten. Die Vollbild-Paesse tragen deshalb ein v, das oben 0
	 *    ist - sonst kippt jede Stufe der Schleierkette das Bild, und bei drei
	 *    Stufen stuende die Szene auf dem Kopf, der Schleier aber nicht.
	 */
	var leinwand = document.getElementById("gl");
	var device = null, context = null, leinwandFormat = null;
	var pass = null;                            // laufender Render-Pass in zeichne()

	// Objekt-Uniform: 256 Byte je Eintrag, die Byte-Versaetze stehen im Struct.
	var SLOT_BYTES = 256, SLOT_FLOATS = 64, SLOTS = 512;
	var objDaten = new Float32Array(SLOTS * SLOT_FLOATS);
	var slot = 0, slotWarnung = false;
	var objBuf = null, bgObjekt = null;
	// Bild-Uniform: Auge, Lampenzahl, bis zu sechs Lampen (Ort und Farbe),
	// dazu die Feldebene und die Feld-uv-Abbildung fuer die Spiegelung
	var rahmenDaten = new ArrayBuffer(304);
	var rahmenF = new Float32Array(rahmenDaten), rahmenI = new Int32Array(rahmenDaten);
	var rahmenBuf = null, bgRahmen = null;

	var WGSL_OBJEKT = `
struct Objekt {                    // Byte-Versatz
	mvp: mat4x4<f32>,              //   0
	modell: mat4x4<f32>,           //  64
	normM: mat3x3<f32>,            // 128  (drei Spalten zu je 16 Byte)
	farbe: vec3<f32>,              // 176
	texAn: f32,                    // 188
	uvFeld: vec4<f32>,             // 192  Ausschnitt im Teileblatt: xy Ecke, zw Groesse
	rauheit: f32,                  // 208
	leucht: f32,                   // 212
	metall: f32,                   // 216
	alpha: f32,                    // 220  bei Schatten und Lampen: die Staerke
	spiegelFeld: f32,              // 224  1: Metallteil spiegelt das Feld (Task 3)
	lampGlanz: f32,                // 228  Staerke des Lampen-Glanzpunkts am Teil (Task 5; Kugel 0)
};                                 // Groesse 240 (232 auf 16 gerundet)
@group(1) @binding(0) var<uniform> obj: Objekt;
@group(2) @binding(0) var texBild: texture_2d<f32>;
@group(2) @binding(1) var sampBild: sampler;
`;

	var WGSL_NETZ = WGSL_OBJEKT + `
struct Rahmen {                    // Byte-Versatz
	auge: vec3<f32>,               //   0
	lampN: i32,                    //  12
	lampP: array<vec4<f32>, 6>,    //  16
	lampC: array<vec4<f32>, 6>,    // 112
	feldP: vec3<f32>,              // 208  Feldebene in Welt: Punkt welt(0,0,0)
	feldN: vec3<f32>,              // 224  ... und Normale weltRichtung(0,0,1)
	tischX: vec3<f32>,             // 240  Tisch-x in Welt
	tischY: vec3<f32>,             // 256  Tisch-y in Welt (den Tisch hinauf)
	feldUv: vec4<f32>,             // 272  xr, y0, y1 der Feldtextur (FELD_XR/Y0/Y1)
	rinne: vec4<f32>,              // 288  Rechteck der Abschussrinne: x0, x1, y0, y1 (Tisch)
};                                 // Groesse 304
@group(0) @binding(0) var<uniform> rahmen: Rahmen;
@group(0) @binding(1) var texEnv: texture_cube<f32>;
@group(0) @binding(2) var texKuppel: texture_cube<f32>;
@group(0) @binding(3) var sampWuerfel: sampler;
@group(0) @binding(4) var texMaske: texture_2d<f32>;    // Insert-Maske (g: Form mit Druck), nur fuer das Feld
@group(0) @binding(5) var sampMaske: sampler;
@group(0) @binding(6) var texLicht: texture_2d<f32>;    // Lichtkarte des Tisches (Inserts x an), Feld-uv
@group(0) @binding(7) var sampLicht: sampler;

struct VAus {
	@builtin(position) pos: vec4<f32>,
	@location(0) vN: vec3<f32>,
	@location(1) vP: vec3<f32>,
	@location(2) vUv: vec2<f32>,
};

@vertex fn vsNetz(@location(0) aPos: vec3<f32>, @location(1) aNrm: vec3<f32>,
                  @location(2) aUv: vec2<f32>) -> VAus {
	var o: VAus;
	let wp = obj.modell * vec4<f32>(aPos, 1.0);
	o.vP = wp.xyz;
	o.vN = obj.normM * aNrm;
	// So teilen sich Kappen, Ziele und Blende eine einzige Textur.
	o.vUv = obj.uvFeld.xy + aUv * obj.uvFeld.zw;
	o.pos = obj.mvp * vec4<f32>(aPos, 1.0);
	return o;
}

// Die Umgebung liegt als x = c/(c+1) vor. Hier zurueckgerechnet; nur so
// bleiben die Deckenkaesten heller als 1 und Chrom sieht aus wie Chrom.
fn hdr(x: vec4<f32>) -> vec3<f32> {
	return x.rgb / max(vec3<f32>(1.0) - x.rgb, vec3<f32>(0.0039));
}
// Filmische Kurve statt c/(c+0.9): sie laesst Schatten Schatten sein und
// faengt die Lampen oben weich ab.
fn kurve(c: vec3<f32>) -> vec3<f32> {
	return clamp((c * (2.51 * c + vec3<f32>(0.03))) / (c * (2.43 * c + vec3<f32>(0.59)) + vec3<f32>(0.14)),
	             vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment fn fsNetz(v: VAus) -> @location(0) vec4<f32> {
	let N = normalize(v.vN);
	let V = normalize(rahmen.auge - v.vP);
	let NdV = max(dot(N, V), 1e-4);
	let Rf = reflect(-V, N);
	let texAn = obj.texAn > 0.5;
	// texAn 2: das Spielfeld selbst - dort liegt v.vUv im Feld-uv und die
	// Insert-Maske sagt, wo transluzenter Kunststoff statt Druck liegt.
	// texAn 3: Backglas - Emission ohne Grauterm (Task 5).
	let feld = obj.texAn > 1.5 && obj.texAn < 2.5;
	let ohneGrau = obj.texAn > 2.5;
	// Nur das Innere der Form (Deckung ab 0.6) zaehlt: die gefilterte Maske
	// laeuft 1-2 mm ueber den Umriss hinaus, sonst entstuende dort ein
	// dunkler Ring in der Lichtpfuetze.
	let insertG = select(0.0, smoothstep(0.6, 1.0, textureSample(texMaske, sampMaske, v.vUv).g), feld);
	let tex = select(vec4<f32>(obj.farbe, 1.0), textureSample(texBild, sampBild, v.vUv), texAn);
	// Leinwandtexturen und Farbangaben stehen in sRGB, die Beleuchtung rechnet
	// linear und codiert am Ende zurueck. Bei Textur wird zusaetzlich mit der
	// Farbe eingefaerbt - dieselbe Zielflaeche wird so rot oder orange.
	let basis = pow(select(obj.farbe, tex.rgb * obj.farbe, texAn), vec3<f32>(2.2));
	// Kuppellicht aus der vorberechneten Bestrahlungskarte
	let kuppel = hdr(textureSample(texKuppel, sampWuerfel, N));
	let diff = basis * kuppel * (1.0 - obj.metall);
	// Spiegelung; rauere Flaechen greifen auf unschaerfere Mipmaps
	var spiegel = hdr(textureSampleBias(texEnv, sampWuerfel, Rf, obj.rauheit * 7.0));
	let L1 = normalize(vec3<f32>(-0.25, 0.90, 0.36));
	// Feldspiegelung (Task 3): Metallteile auf dem Tisch sehen unten das
	// Feld, nicht den Raum. Strahl p + t R mit der Feldebene schneiden,
	// Treffer in Tischkoordinaten, uv wie das Feldnetz. Die Abfrage ist
	// uniform (obj), die Texturabgriffe duerfen also hier stehen; alles
	// Weitere (Treffer ja/nein, Feldrand) ist eine Blende, kein Zweig.
	if (obj.spiegelFeld > 0.5 && obj.metall > 0.5) {
		let nF = rahmen.feldN;
		let steil = dot(Rf, nF);                          // < 0: der Strahl laeuft zum Feld
		let hoehe = dot(v.vP - rahmen.feldP, nF);         // Hoehe des Punkts ueber dem Feld
		let t = max(hoehe, 0.0) / max(-steil, 1e-4);
		let hit = v.vP + Rf * t - rahmen.feldP;
		let tx = dot(hit, rahmen.tischX);
		let ty = dot(hit, rahmen.tischY);
		let xr = rahmen.feldUv.x;
		let y0 = rahmen.feldUv.y;
		let y1 = rahmen.feldUv.z;
		let uv = clamp(vec2<f32>((tx + xr) / (2.0 * xr), (y1 - ty) / (y1 - y0)), vec2<f32>(0.0), vec2<f32>(1.0));
		let k = ${wf(SPIEGEL_KANTE)};
		let innen = smoothstep(0.0, k, tx + xr) * smoothstep(0.0, k, xr - tx)
		          * smoothstep(0.0, k, ty - y0) * smoothstep(0.0, k, y1 - ty)
		          * select(0.0, 1.0, steil < -1e-4) * obj.spiegelFeld;
		// Weicher mit der Rauheit und mit dem Abstand (die Keule wird breiter)
		let bias = obj.rauheit * ${wf(SPIEGEL_RAUH)} + log2(1.0 + t * ${wf(SPIEGEL_WEITE)});
		var feldTex = pow(textureSampleBias(texBild, sampBild, uv, bias).rgb, vec3<f32>(2.2));
		// Unter der Abschussrinne liegt Holz, nicht das Feldbild
		let rn = rahmen.rinne;
		let inRinne = step(rn.x, tx) * step(tx, rn.y) * step(rn.z, ty) * step(ty, rn.w);
		feldTex = mix(feldTex, vec3<f32>(${wf(RINNE_FARBE[0])}, ${wf(RINNE_FARBE[1])}, ${wf(RINNE_FARBE[2])}), inRinne);
		// Feldlicht wie beim gezeichneten Feld (Metall 0.02): Kuppel an der
		// Feldnormale plus Fuehrungslicht-Lambert. Die Inserts kommen aus der
		// Lichtkarte (Maske x an x Farbe), ihr Alpha ist die Insert-Deckung.
		let feldLicht = hdr(textureSample(texKuppel, sampWuerfel, nF))
		              + vec3<f32>(1.00, 0.90, 0.74) * max(dot(nF, L1), 0.0) * ${wf(LICHT_DIFFUS)};
		let licht = textureSampleBias(texLicht, sampLicht, uv, bias);
		// Lichtpfuetzen der sechs Punktlichter am Treffer, wie im Feld-Shader
		// (Wrap-Lambert an der Feldnormale), ueber Inserts abgeschaltet: das
		// eigene Punktlicht auf dem Insert saettigte es (Task 2, Fix-Runde 1).
		let hitW = v.vP + Rf * t;
		var pfuetze = vec3<f32>(0.0);
		for (var k: i32 = 0; k < 6; k++) {
			if (k >= rahmen.lampN) { break; }
			let dl = rahmen.lampP[k].xyz - hitW;
			let q = dot(dl, dl);
			let lam = max(dot(nF, dl * inverseSqrt(max(q, 1e-6))), 0.0) * 0.75 + 0.25;
			pfuetze += rahmen.lampC[k].xyz * lam / (1.0 + 900.0 * q);
		}
		pfuetze *= (feldTex * 0.6 + vec3<f32>(0.4)) * ${wf(LAMPE_DIFFUS)} * (1.0 - ${wf(LAMPE_UEBER_INSERT)} * licht.a);
		// Kontaktschatten des Teils auf dem Feld unter ihm
		let ao = mix(1.0 - ${wf(SPIEGEL_AO)}, 1.0, smoothstep(0.0, ${wf(SPIEGEL_AO_R)}, t));
		let feld = (feldTex * feldLicht * 0.98 + pfuetze) * ao + licht.rgb * ${wf(K_SPIEGEL_INSERT)};
		spiegel = mix(spiegel, feld, innen);
	}
	let F0 = mix(vec3<f32>(0.045), basis, obj.metall);
	let F = F0 + (max(vec3<f32>(1.0 - obj.rauheit), F0) - F0) * pow(1.0 - NdV, 5.0);
	let spek = spiegel * F;
	// Ein warmes Fuehrungslicht bleibt zusaetzlich: die Kuppel allein macht
	// keine harten Glanzpunkte, und ohne die liest sich keine Rundung.
	let H = normalize(L1 + V);
	let NdL = max(dot(N, L1), 0.0);
	var a2 = max(obj.rauheit * obj.rauheit, 0.0016);
	a2 = a2 * a2;
	let nh = max(dot(N, H), 0.0);
	let d = nh * nh * (a2 - 1.0) + 1.0;
	let ggx = a2 / (3.14159 * d * d + 1e-6);
	var c = diff + spek
	      + vec3<f32>(1.00, 0.90, 0.74) * NdL * (basis * (1.0 - obj.metall) * ${wf(LICHT_DIFFUS)} + F0 * ggx * 1.1);
	// Bis zu sechs Lampen des Tisches. Sie faerben die Kugel, waehrend sie
	// darueber rollt - genau das macht ein beleuchtetes Spielfeld aus.
	// Diffus (Wrap-Lambert, auf Metall gedaempft) plus ein GGX-Glanzpunkt
	// mit eigener, breiterer Keule (LAMPE_ALPHA): die Birne unter dem Insert
	// ist eine kleine Flaeche, und so faengt Chrom die Lampen farbig.
	let aL = max(obj.rauheit * obj.rauheit, ${wf(LAMPE_ALPHA)});
	let a2L = aL * aL;
	// Auf Metall kein Diffus-Schimmer (Task 5: 1 - metall statt 1 - 0.7 metall)
	let lampDiffus = ${wf(LAMPE_DIFFUS)} * (1.0 - obj.metall);
	// Die Birne sitzt UNTER dem Insert: das Punktlicht (22 mm ueber dem
	// Feld) darf die Kunststoffflaeche nicht von oben anstrahlen - sonst
	// liegt die eigene Lichtpfuetze auf dem Insert, es saettigt und bloomt
	// (gemessen 245 statt ~170 bei K_INSERT 0.55; Fix-Runde 1).
	// Das Backglas (texAn 3) bekommt kein Punktlicht: die Birnen sitzen unter
	// den Inserts, die Scheibe steht dahinter im Kopfkasten; der Wrap-Term
	// (0.25) und der Grundterm (0.4) legten sonst einen grauen Fleck ueber die
	// Bahn-Lampen auf das Schwarz (Task 5, 31 sRGB auf Grund 12).
	let lampFaktor = select(1.0 - ${wf(LAMPE_UEBER_INSERT)} * insertG, 0.0, ohneGrau);
	// Glanz-Lichtort (Task 5): die Birne liegt im Feld, der Glanzpunkt kommt
	// von LAMPE_GLANZ_H statt von den 22 mm des Diffus-Lichts - auf der Kugel
	// fallen Glanzpunkt und gespiegeltes Insert so zusammen. Staerke je Teil
	// (obj.lampGlanz: Kugel 0, der Spiegel zeigt dort die Lampe).
	let glanzAb = rahmen.feldN * ${wf(LAMPE_LICHT_H - LAMPE_GLANZ_H)};
	let glanzStaerke = ${wf(LAMPE_GLANZ)} * obj.lampGlanz;
	for (var k: i32 = 0; k < 6; k++) {
		if (k >= rahmen.lampN) { break; }
		let dl = rahmen.lampP[k].xyz - v.vP;
		let q = dot(dl, dl);
		let Ld = dl * inverseSqrt(max(q, 1e-6));
		let abfall = 1.0 / (1.0 + 900.0 * q);
		let lam = max(dot(N, Ld), 0.0) * 0.75 + 0.25;
		let Lg = normalize(dl - glanzAb);
		let Hl = normalize(Lg + V);
		let nhl = max(dot(N, Hl), 0.0);
		let dL = nhl * nhl * (a2L - 1.0) + 1.0;
		let ggxL = a2L / (3.14159 * dL * dL + 1e-6);
		c += rahmen.lampC[k].xyz * abfall * lampFaktor
		   * ((basis * 0.6 + vec3<f32>(0.4)) * lam * lampDiffus
		      + F0 * ggxL * max(dot(N, Lg), 0.0) * glanzStaerke);
	}
	// Emission: Grundfarbe plus ein neutraler Zuschlag gegen Farbstich -
	// den aber nur auf hellen Flaechen, Schwarz bleibt schwarz; das Backglas
	// (texAn 3) bekommt keinen Zuschlag, seine Farben bleiben gesaettigt.
	let lumaB = dot(basis, vec3<f32>(0.2126, 0.7152, 0.0722));
	let grau = select(${wf(EMISSION_GRAU)} * smoothstep(${wf(EMISSION_GRAU_AB)}, ${wf(EMISSION_GRAU_BIS)}, lumaB), 0.0, ohneGrau);
	c += obj.leucht * (basis * 1.6 + vec3<f32>(grau));
	// Belichtung: Stellschraube BELICHTUNG oben in der Datei
	c = kurve(c * ${wf(BELICHTUNG)});
	return vec4<f32>(pow(c, vec3<f32>(0.4545)), obj.alpha * select(1.0, tex.a, texAn));
}
`;

	// Schatten unter der Kugel und die Lampen: dieselbe Geometrie, nur Alpha
	// aus dem Bild - beim Schatten schwarz, bei der Lampe eingefaerbt und
	// additiv (der Blend-Zustand steckt in der Pipeline).
	var WGSL_FLACH = WGSL_OBJEKT + `
struct VAusF {
	@builtin(position) pos: vec4<f32>,
	@location(0) vUv: vec2<f32>,
};
@vertex fn vsFlach(@location(0) aPos: vec3<f32>, @location(2) aUv: vec2<f32>) -> VAusF {
	var o: VAusF;
	o.vUv = aUv;
	o.pos = obj.mvp * vec4<f32>(aPos, 1.0);
	return o;
}
@fragment fn fsSchatten(v: VAusF) -> @location(0) vec4<f32> {
	return vec4<f32>(0.0, 0.0, 0.0, textureSample(texBild, sampBild, v.vUv).a * obj.alpha);
}
`;
	/*
	 * Lampe: das Quad liegt am Lampenradius ueber dem Feld. texBild ist das
	 * Glimmbild (Hof, auf HOF_RADIUS des Quads gestaucht - ausserhalb liefert
	 * der Rand des Bilds Alpha 0), texEinsatz die Insert-Maske im Feld-uv
	 * (obj.uvFeld = Ausschnitt des Quads im Feldbild). obj.alpha ist der
	 * Lampenzustand `an`. Additiv im Anzeigeraum: Stellschrauben K_INSERT,
	 * K_HOF oben in der Datei.
	 */
	var WGSL_LAMPE = WGSL_FLACH + `
@group(2) @binding(2) var texEinsatz: texture_2d<f32>;
@group(2) @binding(3) var sampEinsatz: sampler;
@fragment fn fsLampe(v: VAusF) -> @location(0) vec4<f32> {
	let an = obj.alpha;
	let hof = textureSample(texBild, sampBild, (v.vUv - vec2<f32>(0.5)) / ${wf(HOF_RADIUS)} + vec2<f32>(0.5)).a;
	// Birnen-Gefaelle: dasselbe Glimmbild ueber das ganze Quad - unter der
	// Mitte sitzt die Birne, zum Rand des Inserts faellt die Emission auf
	// INSERT_RAND ab (Umriss und Hotspot bleiben lesbar, kein Blob).
	let birne = textureSample(texBild, sampBild, v.vUv).a;
	// Maske zweikanalig: r = Form ohne Druck (leuchtet), g = Form mit Druck
	// (der Hof ist der Lichtsaum UM das Insert und wird ueber der ganzen
	// Form gedaempft - auch in der Druckaussparung, sonst fuellt er die Ziffer).
	// obj.texAn 0: Lampe ohne eigenes Insert (Sling) - sie liest die Maske
	// nicht, sonst leuchten fremde Inserts in ihrem Quad mit.
	let maske = textureSample(texEinsatz, sampEinsatz, obj.uvFeld.xy + v.vUv * obj.uvFeld.zw).rg * obj.texAn;
	let e = maske.r * an * ${wf(K_INSERT)} * mix(${wf(INSERT_RAND)}, 1.0, birne)
	      + hof * (1.0 - ${wf(HOF_UEBER_MASKE)} * maske.g) * an * an * ${wf(K_HOF)};
	return vec4<f32>(obj.farbe * e, e);
}
`;

	/*
	 * Vollbild-Streifen aus vier Ecken, ohne Vertex-Puffer. v laeuft von oben
	 * (0) nach unten (1): in WebGPU liegt Zeile 0 einer gerenderten Textur
	 * oben, so bleibt die Kette Szene -> hell -> weich -> weich -> Leinwand
	 * aufrecht. Der Hintergrund rechnet das fuer seinen Verlauf zurueck.
	 */
	var WGSL_VOLL = `
struct VAusV {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
};
@vertex fn vsVoll(@builtin(vertex_index) vi: u32) -> VAusV {
	var p = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
	                            vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
	var o: VAusV;
	let q = p[vi];
	o.pos = vec4<f32>(q, 0.0, 1.0);
	o.uv = vec2<f32>(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
	return o;
}
`;
	/*
	 * Hintergrund: der dunkle Raum. Fast schwarzer Verlauf (HG_OBEN nach
	 * HG_UNTEN, linear), oben in der Mitte ein warmer Saum, als haenge ueber
	 * dem Tisch eine Lampe ausserhalb des Bildes. Bewusst KEINE Umgebungs-
	 * karte - die spiegelt sich im Chrom, ist aber keine Kulisse. So dunkle
	 * Verlaeufe zeigen im 8-Bit-Ziel Stufen; ein halbes Bit Rauschen
	 * verwischt sie.
	 */
	var WGSL_BG = WGSL_VOLL + `
@fragment fn fsBg(v: VAusV) -> @location(0) vec4<f32> {
	// wie in WebGL: y nach oben, 1 ist der obere Rand
	let vUv = vec2<f32>(v.uv.x, 1.0 - v.uv.y);
	var c = vec3<f32>(mix(${wf(HG_UNTEN)}, ${wf(HG_OBEN)}, clamp(vUv.y, 0.0, 1.0)));
	let dy = 1.0 - vUv.y;
	let dx = (vUv.x - 0.5) * 1.4;
	c += vec3<f32>(${wf(HG_SAUM[0])}, ${wf(HG_SAUM[1])}, ${wf(HG_SAUM[2])}) * exp(-dy * dy / 0.02 - dx * dx / 0.18);
	let rausch = fract(sin(dot(v.pos.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
	return vec4<f32>(max(c + vec3<f32>(rausch / 255.0), vec3<f32>(0.0)), 1.0);
}
`;
	/*
	 * Glanzschleier (Bloom). Echte Flipper stehen im Dunkeln, und jede helle
	 * Lampe, jeder Chromreflex traegt vor dem Auge einen Hof - im Foto ebenso.
	 * Ablauf: die hellen Stellen bei Viertelgroesse herausziehen, waagerecht
	 * und senkrecht weichzeichnen, additiv darueber. Getrennte Achsen statt
	 * eines quadratischen Kerns: 2 x 5 Proben statt 25.
	 */
	var WGSL_HELL = WGSL_VOLL + `
@group(0) @binding(0) var tBild: texture_2d<f32>;
@group(0) @binding(1) var sBild: sampler;
// Schwelle BLOOM_SCHWELLE (0.86), hoch angesetzt: der Schleier soll die
// Lampen und die Glanzpunkte auf dem Chrom fassen, nicht ganze Farbfelder.
// Weicher Einsatz statt harter Kante, sonst flackern bewegte Glanzpunkte.
fn hell(c: vec3<f32>) -> vec3<f32> {
	let h = max(c.r, max(c.g, c.b));
	let f = clamp((h - ${wf(BLOOM_SCHWELLE)}) / (1.0 - ${wf(BLOOM_SCHWELLE)} + 1e-4), 0.0, 1.0);
	return c * f * f;
}
@fragment fn fsHell(v: VAusV) -> @location(0) vec4<f32> {
	// Alle 16 Quellpixel des 4x4-Blocks einzeln laden, Schwelle JE PIXEL,
	// dann Mittel (Task 5). Vorher ein bilinearer Abgriff in der Blockmitte:
	// 12 von 16 Pixeln fielen weg, ein kleiner Glanzpunkt bloomte je nach
	// Lage im Raster voll oder gar nicht (Nachweis am Startbild, um 0-3 px
	// verschoben: Bloom-Eingang der Kugel schwankte um 271 %). Vier
	// bilineare 2x2-Abgriffe mit Schwelle je Abgriff liessen noch 52 %, weil
	// die Boxen einen 1-2 px grossen Punkt je nach Lage teilen; mit der
	// Schwelle je Pixel ist die Summe von der Lage unabhaengig (0 %). Kosten:
	// ein Load je Vollbildpixel, wie ein Vollbild-Pass.
	let dim = vec2<i32>(textureDimensions(tBild));
	let p = vec2<i32>(v.pos.xy) * 4;
	var s = vec3<f32>(0.0);
	for (var j: i32 = 0; j < 4; j++) {
		for (var i: i32 = 0; i < 4; i++) {
			s += hell(textureLoad(tBild, min(p + vec2<i32>(i, j), dim - vec2<i32>(1)), 0).rgb);
		}
	}
	return vec4<f32>(s / 16.0, 1.0);
}
`;
	var WGSL_WEICH = WGSL_VOLL + `
@group(0) @binding(0) var tBild: texture_2d<f32>;
@group(0) @binding(1) var sBild: sampler;
@group(0) @binding(2) var<uniform> schritt: vec4<f32>;
@fragment fn fsWeich(v: VAusV) -> @location(0) vec4<f32> {
	let s1 = schritt.xy * 1.3846;
	let s2 = schritt.xy * 3.2308;
	var s = textureSample(tBild, sBild, v.uv).rgb * 0.2270;
	s += (textureSample(tBild, sBild, v.uv + s1).rgb + textureSample(tBild, sBild, v.uv - s1).rgb) * 0.3162;
	s += (textureSample(tBild, sBild, v.uv + s2).rgb + textureSample(tBild, sBild, v.uv - s2).rgb) * 0.0703;
	return vec4<f32>(s, 1.0);
}
`;
	var WGSL_ZUSAMMEN = WGSL_VOLL + `
@group(0) @binding(0) var tBild: texture_2d<f32>;
@group(0) @binding(1) var sBild: sampler;
@group(0) @binding(2) var tSchleier: texture_2d<f32>;
@fragment fn fsZusammen(v: VAusV) -> @location(0) vec4<f32> {
	let c = textureSample(tBild, sBild, v.uv).rgb;
	return vec4<f32>(c + textureSample(tSchleier, sBild, v.uv).rgb * ${wf(BLOOM_STAERKE)}, 1.0);
}
`;
	// Mipmap-Stufe aus der naechstgroesseren: WebGPU erzeugt keine Mipmaps.
	// Linear abgetastet in der Mitte von je 2 x 2 Bildpunkten - ein Kastenfilter.
	var WGSL_BLIT = WGSL_VOLL + `
@group(0) @binding(0) var tBild: texture_2d<f32>;
@group(0) @binding(1) var sBild: sampler;
@fragment fn fsBlit(v: VAusV) -> @location(0) vec4<f32> {
	return textureSampleLevel(tBild, sBild, v.uv, 0.0);
}
`;
	/*
	 * Mipmaps der Spiegelkarte (Task 3): die Karte liegt als x = c/(c+1)
	 * vor. Im kodierten Raum gemittelt brach jede Lampe ab Stufe 1 ein (eine
	 * Lampe 30 neben drei Texeln 0.1: kodiert 0.97 und 0.09 -> Mittel 0.31
	 * -> 0.45 statt 7.6), die Kugel im Spiel (20 px, hohe Stufe) hatte keinen
	 * Glanzpunkt (max 191). Hier werden die vier Quelltexel dekodiert, linear
	 * gemittelt und wieder kodiert. textureLoad statt Sampler: der Mittelwert
	 * muss VOR dem Kodieren gebildet werden.
	 */
	var WGSL_BLIT_HDR = WGSL_VOLL + `
@group(0) @binding(0) var tBild: texture_2d<f32>;
@fragment fn fsBlitHdr(v: VAusV) -> @location(0) vec4<f32> {
	let dim = vec2<i32>(textureDimensions(tBild));
	let p = vec2<i32>(v.pos.xy) * 2;
	var s = vec3<f32>(0.0);
	for (var j: i32 = 0; j < 2; j++) {
		for (var i: i32 = 0; i < 2; i++) {
			let x = textureLoad(tBild, min(p + vec2<i32>(i, j), dim - vec2<i32>(1)), 0).rgb;
			s += x / max(vec3<f32>(1.0) - x, vec3<f32>(0.0039));
		}
	}
	s *= 0.25;
	return vec4<f32>(s / (s + vec3<f32>(1.0)), 1.0);
}
`;
	/*
	 * Lichtkarte des Tisches (Task 3): alle Lampen in einem instanzierten
	 * Draw in eine Textur in Feld-uv. Je Instanz [x, y, r, an] und [Farbe,
	 * Maske an]. Das Quad liegt am Lampenradius wie das Sprite; die Maske
	 * (R = Form ohne Druck) wird an der Feld-uv gelesen - nicht bei Lampen
	 * ohne eigenes Insert (Maske an 0, wie obj.texAn in fsLampe) -, der Hof
	 * aus dem Glimmbild. Additiv, auf 1 begrenzt (rgba8unorm).
	 */
	var WGSL_LICHT = `
struct Licht { feldUv: vec4<f32> };          // xr, y0, y1, 0
@group(0) @binding(0) var<uniform> licht: Licht;
@group(0) @binding(1) var texMaskeL: texture_2d<f32>;
@group(0) @binding(2) var sampMaskeL: sampler;
@group(0) @binding(3) var texGlimm: texture_2d<f32>;
@group(0) @binding(4) var sampGlimm: sampler;
struct VAusL {
	@builtin(position) pos: vec4<f32>,
	@location(0) uvFeld: vec2<f32>,
	@location(1) uvQuad: vec2<f32>,
	@location(2) farbe: vec3<f32>,
	@location(3) an: f32,
	@location(4) maskeAn: f32,
};
@vertex fn vsLicht(@builtin(vertex_index) vi: u32, @location(0) lampe: vec4<f32>,
                   @location(1) farbe: vec4<f32>) -> VAusL {
	var e = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
	                            vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
	let q = e[vi];
	let x = lampe.x + q.x * lampe.z;
	let y = lampe.y + q.y * lampe.z;
	let xr = licht.feldUv.x;
	let u = (x + xr) / (2.0 * xr);
	let w = (licht.feldUv.z - y) / (licht.feldUv.z - licht.feldUv.y);
	var o: VAusL;
	// Zeile 0 liegt oben: v = 0 ist der obere Rand, clip y = +1
	o.pos = vec4<f32>(u * 2.0 - 1.0, 1.0 - w * 2.0, 0.0, 1.0);
	o.uvFeld = vec2<f32>(u, w);
	o.uvQuad = q * 0.5 + vec2<f32>(0.5);
	o.farbe = farbe.rgb;
	o.an = lampe.w;
	o.maskeAn = farbe.w;
	return o;
}
@fragment fn fsLicht(v: VAusL) -> @location(0) vec4<f32> {
	let maske = textureSample(texMaskeL, sampMaskeL, v.uvFeld).rg * v.maskeAn;
	let hof = textureSample(texGlimm, sampGlimm, v.uvQuad).a;
	let e = maske.r * v.an * ${wf(LICHT_INSERT)} + hof * v.an * v.an * ${wf(LICHT_HOF)};
	// Alpha: Deckung der Insert-Form (mit Druck, Inneres ab 0.6 wie im
	// Feld-Shader), unabhaengig vom Lampenzustand - dort entfallen die Lampenpfuetzen
	return vec4<f32>(v.farbe * e, smoothstep(0.6, 1.0, maske.g));
}
`;

	// ------------------------------------------------------------- Netze
	function Netz(pos, nrm, uv, idx) {
		this.n = idx.length;
		function puffer(daten, Typ, nutzung) {
			var arr = new Typ(daten);
			var b = device.createBuffer({ size: Math.max(4, arr.byteLength),
			                              usage: nutzung | GPUBufferUsage.COPY_DST });
			device.queue.writeBuffer(b, 0, arr);
			return b;
		}
		this.bPos = puffer(pos, Float32Array, GPUBufferUsage.VERTEX);
		this.bNrm = puffer(nrm, Float32Array, GPUBufferUsage.VERTEX);
		this.bUv  = puffer(uv,  Float32Array, GPUBufferUsage.VERTEX);
		// Immer 32-Bit-Indizes: WebGPU kennt sie ohne Erweiterung
		this.bIdx = puffer(idx, Uint32Array, GPUBufferUsage.INDEX);
	}
	// Alle Netz-Pipelines lesen dieselben drei Puffer; Schatten und Lampen
	// lassen die Normale einfach ungenutzt.
	Netz.prototype.zeichne = function () {
		pass.setVertexBuffer(0, this.bPos);
		pass.setVertexBuffer(1, this.bNrm);
		pass.setVertexBuffer(2, this.bUv);
		pass.setIndexBuffer(this.bIdx, "uint32");
		pass.drawIndexed(this.n);
	};

	// ============================================================ Bausteine
	/*
	 * Drehkoerper aus einem Profil. Das Profil laeuft von unten nach oben als
	 * [Radius, Hoehe]-Paare; gedreht wird um die Tischnormale. Damit entstehen
	 * Bumper, Posten, Knaeufe und Kappen aus einer einzigen Funktion - jedes
	 * dieser Teile von Hand zu schreiben waere nur mehr Gelegenheit fuer Fehler.
	 */
	function drehkoerper(profil, seiten, opt) {
		opt = opt || {};
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		// Normale je Profilpunkt aus den angrenzenden Abschnitten mitteln
		var n2 = [];
		for (i = 0; i < profil.length; i++) {
			var vx = 0, vy = 0;
			if (i > 0) {
				var dr = profil[i][0] - profil[i-1][0], dh = profil[i][1] - profil[i-1][1];
				var l = Math.hypot(dr, dh) || 1; vx += dh / l; vy += -dr / l;
			}
			if (i < profil.length - 1) {
				var dr2 = profil[i+1][0] - profil[i][0], dh2 = profil[i+1][1] - profil[i][1];
				var l2 = Math.hypot(dr2, dh2) || 1; vx += dh2 / l2; vy += -dr2 / l2;
			}
			var ln = Math.hypot(vx, vy) || 1;
			n2.push([vx / ln, vy / ln]);
		}
		for (i = 0; i < profil.length; i++) {
			for (k = 0; k <= seiten; k++) {
				var t = k / seiten * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
				pos.push(profil[i][0] * c, profil[i][1], profil[i][0] * s);
				nrm.push(n2[i][0] * c, n2[i][1], n2[i][0] * s);
				uv.push(k / seiten, i / (profil.length - 1));
			}
		}
		var breit = seiten + 1;
		for (i = 0; i < profil.length - 1; i++) {
			for (k = 0; k < seiten; k++) {
				var a = i * breit + k, b = a + 1, c2 = a + breit, d = c2 + 1;
				idx.push(a, c2, d, a, d, b);
			}
		}
		// Deckel unten und oben, wenn das Profil dort nicht auf null laeuft
		function deckel(hoehe, radius, richtung) {
			if (radius <= 1e-6) return;
			var basis = pos.length / 3;
			pos.push(0, hoehe, 0); nrm.push(0, richtung, 0); uv.push(0.5, 0.5);
			for (k = 0; k <= seiten; k++) {
				var t2 = k / seiten * Math.PI * 2;
				pos.push(radius * Math.cos(t2), hoehe, radius * Math.sin(t2));
				nrm.push(0, richtung, 0);
				uv.push(0.5 + 0.5 * Math.cos(t2), 0.5 + 0.5 * Math.sin(t2));
			}
			for (k = 0; k < seiten; k++) {
				if (richtung > 0) idx.push(basis, basis + 1 + k, basis + 2 + k);
				else idx.push(basis, basis + 2 + k, basis + 1 + k);
			}
		}
		if (opt.unten !== false) deckel(profil[0][1], profil[0][0], -1);
		if (opt.oben !== false) deckel(profil[profil.length-1][1], profil[profil.length-1][0], 1);
		return new Netz(pos, nrm, uv, idx);
	}

	// Gummiring - fuer Posten und Flipper
	function ringkoerper(gross, klein, hoehe, nG, nK) {
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		for (i = 0; i <= nG; i++) {
			var u = i / nG * Math.PI * 2, cu = Math.cos(u), su = Math.sin(u);
			for (k = 0; k <= nK; k++) {
				var v = k / nK * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
				pos.push((gross + klein * cv) * cu, hoehe + klein * sv, (gross + klein * cv) * su);
				nrm.push(cv * cu, sv, cv * su);
				uv.push(i / nG, k / nK);
			}
		}
		for (i = 0; i < nG; i++) for (k = 0; k < nK; k++) {
			var a = i * (nK + 1) + k, b = a + 1, c = a + nK + 1, d = c + 1;
			idx.push(a, c, d, a, d, b);
		}
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Prisma aus einem geschlossenen Umriss: Mantel plus Deckel. Damit entstehen
	 * Flipper, Fallziele, Slingshot-Koerper und die Blende - alles, was eine
	 * flache Grundflaeche und eine feste Hoehe hat.
	 */
	/*
	 * Flaeche eines geschlossenen Umrisses mit Vorzeichen. Sie sagt, in welche
	 * Richtung der Umriss laeuft - und davon haengt ab, wohin die Aussenseite
	 * zeigt. Beide Prisma-Funktionen richten den Umlaufsinn damit selbst; sich
	 * auf den Aufrufer zu verlassen ging schief, sobald ein Koerper gespiegelt
	 * wurde: die gespiegelte Haelfte war dann von aussen unsichtbar.
	 */
	function flaecheMitVorzeichen(u) {
		var f = 0;
		for (var i = 0; i < u.length; i++) {
			var j = (i + 1) % u.length;
			f += u[i][0] * u[j][1] - u[j][0] * u[i][1];
		}
		return f / 2;
	}

	/*
	 * opt.glatt  Normalen an den Umrisspunkten aus den beiden angrenzenden
	 *            Kanten gemittelt: Rundungen lesen sich rund statt facettiert
	 *            (Flipper, Task 5). Ohne glatt hat jede Mantelflaeche ihre
	 *            eigene Normale - richtig fuer Kaesten wie die Fallziele.
	 *            Die Deckkante bleibt in beiden Faellen hart.
	 * opt.fase   Fase am oberen Rand: der Mantel endet fase unter `oben`, ein
	 *            Zusatzring laeuft von dort unter 45 Grad nach innen auf den
	 *            um fase eingerueckten Deckel (Gehrung an den Ecken). Der Ring
	 *            hat eigene Normalen (Mantelnormale + oben) - zwei harte
	 *            Kanten, eine Lichtlinie am Rand. Der Fuss bleibt unveraendert.
	 */
	function prisma(umriss, unten, oben, opt) {
		opt = opt || {};
		// Der Umriss liegt in der lokalen xz-Ebene, hochgezogen wird nach +y.
		// Damit der Deckel nach oben zeigt, muss die Flaeche negativ sein.
		if (flaecheMitVorzeichen(umriss) > 0) umriss = umriss.slice().reverse();
		var pos = [], nrm = [], uv = [], idx = [], i, n = umriss.length;
		var fase = opt.fase || 0, mantelOben = oben - fase;
		// Kantennormalen (nach aussen) je Abschnitt i -> i+1
		var kn = [];
		for (i = 0; i < n; i++) {
			var p0 = umriss[i], q0 = umriss[(i + 1) % n];
			var dx = q0[0] - p0[0], dz = q0[1] - p0[1], l = Math.hypot(dx, dz) || 1;
			kn.push([-dz / l, dx / l]);
		}
		// Punktnormalen als Mittel der beiden angrenzenden Kanten; daraus auch
		// die Gehrung des eingerueckten Deckels (beide Kanten ruecken um fase ein)
		var pn = [], innen = [];
		for (i = 0; i < n; i++) {
			var a = kn[(i + n - 1) % n], b0 = kn[i];
			var mx = a[0] + b0[0], mz = a[1] + b0[1], ml = Math.hypot(mx, mz) || 1;
			mx /= ml; mz /= ml;
			pn.push([mx, mz]);
			var g = fase / Math.max(mx * b0[0] + mz * b0[1], 0.3);
			innen.push([umriss[i][0] - mx * g, umriss[i][1] - mz * g]);
		}
		function fasenNormale(nx, nz) {
			var l = Math.hypot(nx, 1, nz);
			return [nx / l, 1 / l, nz / l];
		}
		for (i = 0; i < n; i++) {
			var j = (i + 1) % n, p = umriss[i], q = umriss[j];
			var np = opt.glatt ? pn[i] : kn[i], nq = opt.glatt ? pn[j] : kn[i];
			var b = pos.length / 3;
			[[p, unten, 0, 0, np], [q, unten, 1, 0, nq], [q, mantelOben, 1, 1, nq], [p, mantelOben, 0, 1, np]]
				.forEach(function (e) {
					pos.push(e[0][0], e[1], e[0][1]); nrm.push(e[4][0], 0, e[4][1]); uv.push(e[2], e[3]);
				});
			idx.push(b, b+1, b+2, b, b+2, b+3);
			if (fase > 0) {
				var fp = fasenNormale(np[0], np[1]), fq = fasenNormale(nq[0], nq[1]);
				var b1 = pos.length / 3;
				[[p, mantelOben, 0, fp], [q, mantelOben, 1, fq], [innen[j], oben, 1, fq], [innen[i], oben, 0, fp]]
					.forEach(function (e) {
						pos.push(e[0][0], e[1], e[0][1]); nrm.push(e[3][0], e[3][1], e[3][2]); uv.push(e[2], 1);
					});
				idx.push(b1, b1+1, b1+2, b1, b1+2, b1+3);
			}
		}
		// Deckel als Faecher vom Schwerpunkt - die Umrisse sind alle konvex
		function kappe(ring, hoehe, richtung) {
			var mx = 0, mz = 0;
			ring.forEach(function (p2) { mx += p2[0]; mz += p2[1]; });
			mx /= n; mz /= n;
			var b2 = pos.length / 3;
			pos.push(mx, hoehe, mz); nrm.push(0, richtung, 0); uv.push(0.5, 0.5);
			for (i = 0; i < n; i++) {
				pos.push(ring[i][0], hoehe, ring[i][1]);
				nrm.push(0, richtung, 0); uv.push(i / n, 0);
			}
			for (i = 0; i < n; i++) {
				var j = (i + 1) % n;
				if (richtung > 0) idx.push(b2, b2 + 1 + i, b2 + 1 + j);
				else idx.push(b2, b2 + 1 + j, b2 + 1 + i);
			}
		}
		if (opt.oben !== false) kappe(fase > 0 ? innen : umriss, oben, 1);
		if (opt.unten !== false) kappe(umriss, unten, -1);
		return new Netz(pos, nrm, uv, idx);
	}

	// Rohr entlang eines Linienzugs - fuer Banden und Gummis
	function rohrEntlangZug(pos, nrm, uv, idx, punkte, R, seiten, hoehe) {
		var n = punkte.length, ringe = [], i, k, H0 = hoehe || 0;
		for (i = 0; i < n; i++) {
			var vor = punkte[Math.max(0, i - 1)], nach = punkte[Math.min(n - 1, i + 1)];
			var dx = nach[0] - vor[0], dy = nach[1] - vor[1], l = Math.hypot(dx, dy) || 1;
			ringe.push({ p: punkte[i], t: [dx / l, dy / l] });
		}
		for (i = 0; i < n; i++) {
			var r = ringe[i], qx = -r.t[1], qy = r.t[0], b = pos.length / 3;
			for (k = 0; k <= seiten; k++) {
				var a = k / seiten * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
				var ox = qx * R * ca, oy = qy * R * ca, oh = R * sa;
				var wp = welt(r.p[0] + ox, r.p[1] + oy, H0 + R + oh);
				var wn = weltRichtung(qx * ca, qy * ca, sa);
				pos.push(wp[0], wp[1], wp[2]); nrm.push(wn[0], wn[1], wn[2]);
				uv.push(i / (n - 1), k / seiten);
			}
			if (i > 0) {
				var vorB = b - (seiten + 1);
				// Umlaufsinn von aussen gegen den Uhrzeiger (frontFace ccw). Bis
				// Task 3 lief er andersherum: die Rueckseitenentfernung nahm die
				// dem Betrachter zugewandte Wand weg, zu sehen war die Innenseite
				// der hinteren Wand mit abgewandter Normale - die Spiegelung stand
				// auf dem Kopf (Decke unten, Boden oben), Fresnel und Glanzpunkte
				// liefen ins Leere. Mit der Umgebungskarte allein fiel das nicht
				// auf, mit dem gespiegelten Feld sofort (Debug-Normalen, Task 3).
				for (k = 0; k < seiten; k++) idx.push(vorB+k, b+k+1, b+k, vorB+k, vorB+k+1, b+k+1);
			}
		}
		// Halbkugeln als Abschluss
		[[0, -1], [n - 1, 1]].forEach(function (kap) {
			var r2 = ringe[kap[0]], vz = kap[1], b2 = pos.length / 3, ri, kk;
			var qx2 = -r2.t[1], qy2 = r2.t[0];
			for (ri = 0; ri <= 4; ri++) {
				var phi = ri / 4 * Math.PI / 2;
				for (kk = 0; kk <= seiten; kk++) {
					var aa = kk / seiten * Math.PI * 2;
					var rr = Math.cos(phi), tt = Math.sin(phi) * vz;
					var lx = qx2 * rr * Math.cos(aa) + r2.t[0] * tt;
					var ly = qy2 * rr * Math.cos(aa) + r2.t[1] * tt;
					var lh = rr * Math.sin(aa);
					var wp2 = welt(r2.p[0] + lx * R, r2.p[1] + ly * R, H0 + R + lh * R);
					var wn2 = weltRichtung(lx, ly, lh);
					pos.push(wp2[0], wp2[1], wp2[2]); nrm.push(wn2[0], wn2[1], wn2[2]);
					uv.push(ri / 4, kk / seiten);
				}
			}
			// Kappen im selben (korrigierten) Umlaufsinn wie der Mantel
			for (ri = 0; ri < 4; ri++) for (kk = 0; kk < seiten; kk++) {
				var a2 = b2 + ri*(seiten+1) + kk, b3 = a2+1, c2 = a2+seiten+1, d2 = c2+1;
				if (vz > 0) idx.push(a2, d2, c2, a2, b3, d2);
				else idx.push(a2, c2, d2, a2, d2, b3);
			}
		});
	}

	/*
	 * Rohr entlang eines Linienzugs im Raum (Tischkoordinaten x, y, h) - fuer
	 * die Drahtfuehrungen (Task 8), deren Weg Beine, Boegen und die Haarnadel
	 * in einer Kurve verbindet. Der Rahmen (Normale, Binormale) wird von Ring
	 * zu Ring mitgefuehrt (Paralleltransport: die alte Normale wird auf die
	 * Ebene senkrecht zur neuen Tangente projiziert), so verdreht sich der
	 * Mantel an Boegen nicht und Beine und Draht gehen ohne Knick ineinander
	 * ueber. Umlaufsinn und Indexmuster wie rohrEntlangZug (ccw von aussen,
	 * Task 3), geprueft mit den Dreiecksnormalen gegen die Scheitelnormalen.
	 * kappen {anfang, ende}: Halbkugeln an offenen Enden - die Beine enden im
	 * Feld und brauchen keine.
	 */
	function drahtEntlang3D(pos, nrm, uv, idx, punkte, R, seiten, kappen) {
		var n = punkte.length, i, k, tang = [], rN = [], rB = [];
		function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
		function kreuz(a, b) { return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
		for (i = 0; i < n; i++) {
			var vor = punkte[Math.max(0, i - 1)], nach = punkte[Math.min(n - 1, i + 1)];
			tang.push(norm([nach[0] - vor[0], nach[1] - vor[1], nach[2] - vor[2]]));
		}
		// Startrahmen: irgendeine Senkrechte zur ersten Tangente, danach mitgefuehrt
		var N = norm(kreuz(Math.abs(tang[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], tang[0]));
		for (i = 0; i < n; i++) {
			var t = tang[i], d = N[0]*t[0] + N[1]*t[1] + N[2]*t[2];
			N = norm([N[0] - t[0]*d, N[1] - t[1]*d, N[2] - t[2]*d]);
			rN.push(N); rB.push(kreuz(t, N));
		}
		function punkt(i, lx, ly, lh, uu, vv) {
			var p = punkte[i], wp = welt(p[0] + lx * R, p[1] + ly * R, p[2] + lh * R), wn = weltRichtung(lx, ly, lh);
			pos.push(wp[0], wp[1], wp[2]); nrm.push(wn[0], wn[1], wn[2]); uv.push(uu, vv);
		}
		for (i = 0; i < n; i++) {
			var b = pos.length / 3, Ni = rN[i], Bi = rB[i];
			for (k = 0; k <= seiten; k++) {
				var a = k / seiten * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
				punkt(i, Ni[0]*ca + Bi[0]*sa, Ni[1]*ca + Bi[1]*sa, Ni[2]*ca + Bi[2]*sa, i / (n - 1), k / seiten);
			}
			if (i > 0) {
				var vorB = b - (seiten + 1);
				for (k = 0; k < seiten; k++) idx.push(vorB+k, b+k+1, b+k, vorB+k, vorB+k+1, b+k+1);
			}
		}
		[[0, -1, kappen && kappen.anfang], [n - 1, 1, kappen && kappen.ende]].forEach(function (kap) {
			if (!kap[2]) return;
			var i2 = kap[0], vz = kap[1], b2 = pos.length / 3, ri, kk;
			var N2 = rN[i2], B2 = rB[i2], T2 = tang[i2];
			for (ri = 0; ri <= 4; ri++) {
				var phi = ri / 4 * Math.PI / 2, rr = Math.cos(phi), tt = Math.sin(phi) * vz;
				for (kk = 0; kk <= seiten; kk++) {
					var aa = kk / seiten * Math.PI * 2, c2 = rr * Math.cos(aa), s2 = rr * Math.sin(aa);
					punkt(i2, N2[0]*c2 + B2[0]*s2 + T2[0]*tt, N2[1]*c2 + B2[1]*s2 + T2[1]*tt,
					      N2[2]*c2 + B2[2]*s2 + T2[2]*tt, ri / 4, kk / seiten);
				}
			}
			for (ri = 0; ri < 4; ri++) for (kk = 0; kk < seiten; kk++) {
				var a2 = b2 + ri*(seiten+1) + kk, b3 = a2+1, c3 = a2+seiten+1, d2 = c3+1;
				if (vz > 0) idx.push(a2, d2, c3, a2, b3, d2);
				else idx.push(a2, c3, d2, a2, d2, b3);
			}
		});
	}

	// Zusammenhaengende Segmente zu Linienzuegen verketten. Wuerde jedes Segment
	// als eigene Kapsel gezeichnet, schnuerte die Bande an jedem Gelenk ein und
	// der Bogen oben saehe aus wie eine Perlenkette.
	function verketteSegmente(liste) {
		var offen = liste.slice(), zuege = [];
		function gleich(p, q) { return Math.abs(p[0]-q[0]) < 1e-6 && Math.abs(p[1]-q[1]) < 1e-6; }
		while (offen.length) {
			var s = offen.shift();
			var zug = { punkte: [s.a, s.b], r: s.r, art: s.art };
			var weiter = true;
			while (weiter) {
				weiter = false;
				for (var i = 0; i < offen.length; i++) {
					var t = offen[i];
					if (t.r !== zug.r || t.art !== zug.art) continue;
					var letzte = zug.punkte[zug.punkte.length - 1], erste = zug.punkte[0];
					if (gleich(t.a, letzte))      { zug.punkte.push(t.b); }
					else if (gleich(t.b, letzte)) { zug.punkte.push(t.a); }
					else if (gleich(t.b, erste))  { zug.punkte.unshift(t.a); }
					else if (gleich(t.a, erste))  { zug.punkte.unshift(t.b); }
					else continue;
					offen.splice(i, 1); weiter = true; break;
				}
			}
			zuege.push(zug);
		}
		return zuege;
	}

	// ========================================================= Tischmodelle
	function baueSpielfeldNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1);
		[[-FELD_XR, FELD_Y0, 0, 1], [FELD_XR, FELD_Y0, 1, 1],
		 [ FELD_XR, FELD_Y1, 1, 0], [-FELD_XR, FELD_Y1, 0, 0]].forEach(function (e) {
			var w = welt(e[0], e[1], 0);
			pos.push(w[0],w[1],w[2]); nrm.push(n[0],n[1],n[2]); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	function baueBandenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		// `unsichtbar` (tisch.js): reine Physik-Anschlaege ohne Rohr, etwa der
		// Anschlag der Kugel unten in der Rinne (Task 5b); `draht`: die
		// Gassenfuehrungen sind Drahtschleifen (baueDrahtNetz, Task 8)
		verketteSegmente(SEG.filter(function (s) { return s.art === "wand" && !s.unsichtbar && !s.draht; }))
			.forEach(function (zug) {
				rohrEntlangZug(pos, nrm, uv, idx, zug.punkte, zug.r, 14);
			});
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Drahtschleifen der Gassenfuehrungen (Task 8), ein Netz fuer beide Trenner.
	 * Je Fuehrung EIN Draht als Raumkurve: Bein links aus dem Feld herauf,
	 * Bogen (DRAHT_BIEGUNG) auf Drahthoehe, die 2D-Achse aus tisch.js (links
	 * hinauf, Haarnadel, rechts zurueck), Bogen, Bein rechts hinab. Die Beine
	 * enden 1 mm im Feld - keine Kappen. Mittelbuegel: senkrechte Beine bis
	 * zur Drahtachse (ihr offenes Ende liegt im Draht). Keine Unterlegscheiben
	 * (Fix-Runde 1): ihr flacher Deckel spiegelte eine einzige warme Richtung
	 * und las sich als braune Ellipse; die Fusspunkte im Feldbild (drahtSaum)
	 * bleiben als kleiner Kontaktschatten (spielfeld.js, DRAHT_BEIN_*).
	 */
	function baueDrahtNetz() {
		var pos = [], nrm = [], uv = [], idx = [], UNTER = -0.001;
		function bein(fuss, oben) {
			drahtEntlang3D(pos, nrm, uv, idx, [[fuss[0], fuss[1], UNTER], [fuss[0], fuss[1], oben]], DRAHT_R, DRAHT_SEITEN);
		}
		T.draehte.forEach(function (d) {
			var A = d.achse, m = A.length, H = d.h, B = DRAHT_BIEGUNG, pfad = [], k;
			var d0 = richtung(A[0], A[1]), dl = richtung(A[m - 2], A[m - 1]);
			// Bein links herauf, Bogen von senkrecht auf die Drahtrichtung
			pfad.push([A[0][0], A[0][1], UNTER], [A[0][0], A[0][1], H - B]);
			for (k = 1; k <= 5; k++) {
				var w = Math.PI - Math.PI / 2 * k / 5;
				pfad.push([A[0][0] + B * (d0[0] + Math.cos(w) * d0[0]), A[0][1] + B * (d0[1] + Math.cos(w) * d0[1]),
				           H - B + B * Math.sin(w)]);
			}
			for (k = 1; k < m - 1; k++) pfad.push([A[k][0], A[k][1], H]);
			// Bogen von der Drahtrichtung nach unten, Bein rechts hinab
			for (k = 0; k <= 5; k++) {
				var w2 = Math.PI / 2 * (1 - k / 5);
				pfad.push([A[m - 1][0] - B * (dl[0] - Math.cos(w2) * dl[0]), A[m - 1][1] - B * (dl[1] - Math.cos(w2) * dl[1]),
				           H - B + B * Math.sin(w2)]);
			}
			pfad.push([A[m - 1][0], A[m - 1][1], UNTER]);
			drahtEntlang3D(pos, nrm, uv, idx, pfad, DRAHT_R, DRAHT_SEITEN);
			d.beine.slice(2).forEach(function (f) { bein(f, H); });
		});
		return new Netz(pos, nrm, uv, idx);
	}
	function richtung(p, q) {
		var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
		return [dx / l, dy / l];
	}

	/*
	 * Flipperumriss: die konvexe Huelle zweier Kreise - genau die Form eines
	 * echten Flipperfingers. Die Physik rechnet mit einer Kapsel konstanten
	 * Radius; sichtbar wird die Verjuengung zur Spitze.
	 */
	function flipperUmriss(laenge, r1, r2, n) {
		var al = Math.asin((r1 - r2) / laenge);
		var a1 = Math.PI / 2 + al, punkte = [], k;
		for (k = 0; k <= n; k++) {
			var t = a1 + (2 * Math.PI - 2 * a1) * k / n;
			punkte.push([Math.cos(t) * r1, Math.sin(t) * r1]);
		}
		for (k = 0; k <= n; k++) {
			var t2 = -a1 + 2 * a1 * k / n;
			punkte.push([laenge + Math.cos(t2) * r2, Math.sin(t2) * r2]);
		}
		return punkte;
	}

	function baueApronNetz() {
		// Die Blende unten: eine geneigte Blechplatte, die den Abfluss verdeckt
		var pos = [], nrm = [], uv = [], idx = [];
		var kanten = [[-W + 0.004, 0.052, 0.004], [SCHACHT_X - 0.004, 0.052, 0.004],
		              [SCHACHT_X - 0.030, -0.055, 0.030], [-W + 0.030, -0.055, 0.030]];
		var w = kanten.map(function (e) { return welt(e[0], e[1], e[2]); });
		var ux = [w[1][0]-w[0][0], w[1][1]-w[0][1], w[1][2]-w[0][2]];
		var uy = [w[3][0]-w[0][0], w[3][1]-w[0][1], w[3][2]-w[0][2]];
		var n = [ux[1]*uy[2]-ux[2]*uy[1], ux[2]*uy[0]-ux[0]*uy[2], ux[0]*uy[1]-ux[1]*uy[0]];
		var ln = Math.hypot(n[0],n[1],n[2]) || 1;
		w.forEach(function (p, i) {
			pos.push(p[0], p[1], p[2]); nrm.push(n[0]/ln, n[1]/ln, n[2]/ln);
			uv.push(i === 1 || i === 2 ? 1 : 0, i > 1 ? 1 : 0);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Der Schrank. Drei Waende - links, rechts, vorn - jede mit Innenseite,
	 * Aussenseite und Holzoberkante als eigene Flaechen mit eigener Normale.
	 *
	 * Die alte Fassung gab allen Flaechen die Normale (0,1,0). Die Waende wurden
	 * dadurch beleuchtet wie ein Fussboden und sahen aus wie Pappe; dazu waren
	 * sie nur 34 mm hoch statt bis unter die Glasleiste. Jetzt reichen sie bis
	 * 93 mm, die Chromleiste sitzt direkt auf der Holzkante.
	 */
	// SCHRANK_D/H0/H1/Y0/Y1 stehen oben im Block "Masse" (GLAS_HALB haengt daran).

	/*
	 * Holz wird in Metern angesetzt. Die Kachel ist je Flaeche so gewaehlt, dass
	 * quer zur schmalen Seite ein guter Teil der Textur sichtbar wird: bei
	 * 30 cm zeigte die 34 mm breite Kante nur 11 % der Textur - ein einziges
	 * Farbband, keine Maserung. Mit 10 cm ist es ein Drittel.
	 */
	var HOLZ_KACHEL_KANTE = 0.10, HOLZ_KACHEL_RINNE = 0.16;
	// Leder auf den Innenwaenden: 20 cm Kachel, die Wand ist 15 cm hoch - so
	// ist die Narbung in voller Groesse zu sehen.
	var LEDER_KACHEL = 0.20;

	function baueSchrankNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var K = { pos: [], nrm: [], uv: [], idx: [] };   // Holzkanten, eigenes Netz
		var I = { pos: [], nrm: [], uv: [], idx: [] };   // Innenwaende, Leder
		var F = window.SCHRANK_FELD;

		// Vier Tischpunkte [x, y, h], Normale in Tischrichtung, Ausschnitt und
		// je Ecke (fu, fv) im Ausschnitt. Der Umlaufsinn wird an der Normalen
		// gerichtet - sonst schneidet die Rueckseitenentfernung die Flaeche weg.
		function flaeche(ecken, n, feld, fuv) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = pos.length / 3;
			reihenfolge.forEach(function (i) {
				pos.push(w[i][0], w[i][1], w[i][2]);
				nrm.push(wn[0], wn[1], wn[2]);
				uv.push(feld[0] + fuv[i][0] * feld[2], feld[1] + fuv[i][1] * feld[3]);
			});
			idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		/*
		 * Holzflaeche: Texturkoordinaten in Metern statt 0..1. Vorher lagen 1024
		 * Bildpunkte auf 1,3 m Laenge, aber 64 auf 34 mm Breite - die Maserung
		 * wurde laengs um das 2,4-fache gestreckt. Jetzt ist die Kachel ueberall
		 * 30 cm gross, egal wie lang oder breit die Flaeche ist.
		 */
		function holzflaeche(ecken, n) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = K.pos.length / 3;
			reihenfolge.forEach(function (i) {
				K.pos.push(w[i][0], w[i][1], w[i][2]);
				K.nrm.push(wn[0], wn[1], wn[2]);
				K.uv.push(ecken[i][1] / HOLZ_KACHEL_KANTE, ecken[i][0] / HOLZ_KACHEL_KANTE);
			});
			K.idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		/*
		 * Lederflaeche: wie holzflaeche, aber die Koordinaten laufen laengs der
		 * Wand (y oder x) und die Hoehe (h) - in Metern, damit die Narbung auf
		 * allen Waenden gleich gross ist.
		 */
		function lederflaeche(ecken, n, laengs) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = I.pos.length / 3;
			reihenfolge.forEach(function (i) {
				I.pos.push(w[i][0], w[i][1], w[i][2]);
				I.nrm.push(wn[0], wn[1], wn[2]);
				I.uv.push(ecken[i][laengs] / LEDER_KACHEL, ecken[i][2] / LEDER_KACHEL);
			});
			I.idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		var Y0 = SCHRANK_Y0, Y1 = SCHRANK_Y1, H0 = SCHRANK_H0, H1 = SCHRANK_H1, D = SCHRANK_D;
		var LAENGE = Y1 - Y0;

		// Seitenwaende
		[-1, 1].forEach(function (seite) {
			var xi = seite * W, xo = seite * (W + D);
			// Innenseite - zum Feld hin, Leder
			lederflaeche([[xi, Y0, H0], [xi, Y1, H0], [xi, Y1, H1], [xi, Y0, H1]], [-seite, 0, 0], 1);
			// Aussenseite mit der Seitengrafik. Links gespiegelt, damit die
			// Schrift von vorn lesbar bleibt.
			var l = seite < 0 ? [[1, 1], [0, 1], [0, 0], [1, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
			flaeche([[xo, Y0, H0], [xo, Y1, H0], [xo, Y1, H1], [xo, Y0, H1]],
					[seite, 0, 0], F.aussen, l);
			// Holzkante oben
			holzflaeche([[xo, Y0, H1], [xo, Y1, H1], [xi, Y1, H1], [xi, Y0, H1]], [0, 0, 1]);
			// Stirnseite hinten (am Kopfstueck)
			lederflaeche([[xo, Y1, H0], [xi, Y1, H0], [xi, Y1, H1], [xo, Y1, H1]], [0, 1, 0], 0);
		});

		// Vorderwand
		var xa = -(W + D), xb = W + D, yv = Y0, yh = Y0 + D;
		flaeche([[xa, yv, H0], [xb, yv, H0], [xb, yv, H1], [xa, yv, H1]],
				[0, -1, 0], F.front, [[0, 1], [1, 1], [1, 0], [0, 0]]);
		lederflaeche([[xa, yh, H0], [xb, yh, H0], [xb, yh, H1], [xa, yh, H1]], [0, 1, 0], 0);
		holzflaeche([[xa, yv, H1], [xb, yv, H1], [xb, yh, H1], [xa, yh, H1]], [0, 0, 1]);

		// Rueckwand am Kopfende (Task 5b), Leder wie innen, zum Spieler
		// gerichtet, ueber die volle Schrankbreite. Bis Task 5 stand das
		// Backglas mit dem Fuss auf h 0.016 selbst an dieser Stelle; seit es
		// auf dem Deckglas sitzt, saehe man hier 9 cm Raumhintergrund unter
		// der Backbox (Zeilen 262-313 bei 1920x1080, Luma 3-6). Das Feldbild
		// backt den Schatten dieser Wand schon bei L + KOPF_WAND_Y (0.060 =
		// Y1) ein. Die Oberkante liegt hinter dem Backbox-Rahmen (Fuss h 0.088
		// bei y L+0.057), eine Holzkante braucht sie darum nicht.
		lederflaeche([[xa, Y1, H0], [xb, Y1, H0], [xb, Y1, H1], [xa, Y1, H1]], [0, -1, 0], 0);

		return { wand: new Netz(pos, nrm, uv, idx), kante: new Netz(K.pos, K.nrm, K.uv, K.idx),
				 innen: new Netz(I.pos, I.nrm, I.uv, I.idx) };
	}

	/*
	 * Modellmatrix fuer Teile, die seitlich aus der Wand ragen - die
	 * Flipperknoepfe. Lokal y zeigt nach aussen (Tisch-x), lokal x den Tisch
	 * hinauf, lokal z ergibt sich als Kreuzprodukt, damit es eine Drehung ist.
	 */
	function seitwaerts(x, y, h, seite) {
		var c1 = [seite, 0, 0];
		var c0 = weltRichtung(0, 1, 0);
		var c2 = [c0[1]*c1[2] - c0[2]*c1[1], c0[2]*c1[0] - c0[0]*c1[2], c0[0]*c1[1] - c0[1]*c1[0]];
		var o = ident(m4());
		o[0] = c0[0]; o[1] = c0[1]; o[2]  = c0[2];
		o[4] = c1[0]; o[5] = c1[1]; o[6]  = c1[2];
		o[8] = c2[0]; o[9] = c2[1]; o[10] = c2[2];
		var wp = welt(x, y, h);
		o[12] = wp[0]; o[13] = wp[1]; o[14] = wp[2];
		return o;
	}

	function baueKugelNetz(r, ringe, seiten) {
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		for (i = 0; i <= ringe; i++) {
			var phi = i / ringe * Math.PI;
			for (k = 0; k <= seiten; k++) {
				var th = k / seiten * Math.PI * 2;
				var x = Math.sin(phi)*Math.cos(th), y = Math.cos(phi), z = Math.sin(phi)*Math.sin(th);
				pos.push(x*r, y*r, z*r); nrm.push(x, y, z); uv.push(k/seiten, i/ringe);
			}
		}
		// Die Ringe laufen von oben (phi 0) nach unten; damit die Dreiecke von
		// aussen gegen den Uhrzeiger liegen, muss die Reihenfolge anders sein
		// als bei drehkoerper (dort steigt das Profil). Bis Task 3 war die
		// Kugel von innen zu sehen: die hintere Halbkugel mit abgewandten
		// Normalen - Raum kopfueber, kein Fresnel, kein Glanzpunkt des
		// Fuehrungslichts, Lampenlicht auf der falschen Seite.
		for (i = 0; i < ringe; i++) for (k = 0; k < seiten; k++) {
			var a = i*(seiten+1)+k, b = a+1, c = a+seiten+1, d = c+1;
			idx.push(a, d, c, a, b, d);
		}
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Flipperschatten: Rechteck in der lokalen xz-Ebene des Flippers, so gross
	 * wie sein Umriss plus Rand. Lokal, nicht in Weltkoordinaten - die
	 * Modellmatrix des Flippers dreht es mit. (Der alte Kugelschatten war in
	 * Weltkoordinaten gebaut UND durch modellFuer geschickt: die Neigung kam
	 * doppelt, die vordere Haelfte lag bis 3 mm unter dem Feld und wurde vom
	 * Tiefentest abgeschnitten. Die Kugel nimmt jetzt das lokale Glimmquadrat.)
	 */
	function baueFlipperSchattenNetz() {
		var m = flipperSchattenMasse(), pos = [], uv = [], idx = [], nrm = [];
		[[m.x0, -m.z, 0, 0], [m.x1, -m.z, 1, 0], [m.x1, m.z, 1, 1], [m.x0, m.z, 0, 1]].forEach(function (e) {
			pos.push(e[0], 0, e[1]); nrm.push(0, 1, 0); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	// Stellschrauben der Backbox (GLAS_*, BACKBOX_*) stehen oben im Block
	// "Backbox (Look Stufe 1, Task 5b)".
	function baueBackglasNetz(halbB, hoehe, tiefer, unten) {
		// Steht aufrecht am Kopfende, leicht nach hinten gekippt. In
		// Weltkoordinaten gebaut: die Scheibe folgt der Feldneigung gerade NICHT.
		// `tiefer` rueckt das Viereck nach hinten, `unten` zieht seinen Fuss um
		// diesen Betrag unter den Scheibenfuss (Rahmen bis auf den Schrank).
		var fuss = welt(0, L + 0.055, GLAS_H + BACKBOX_SOCKEL);
		var c = Math.cos(GLAS_KIPP), si = Math.sin(GLAS_KIPP);
		var auf = [0, c, -si], n = [0, si, c], u = unten || 0;
		var pos = [], nrm = [], uv = [], idx = [];
		var mitte = [fuss[0] - n[0]*tiefer - auf[0]*u, fuss[1] - n[1]*tiefer - auf[1]*u, fuss[2] - n[2]*tiefer - auf[2]*u];
		[[-halbB, 0, 0, 1], [halbB, 0, 1, 1], [halbB, hoehe, 1, 0], [-halbB, hoehe, 0, 0]]
			.forEach(function (e) {
				pos.push(mitte[0] + e[0], mitte[1] + auf[1]*e[1], mitte[2] + auf[2]*e[1]);
				nrm.push(n[0], n[1], n[2]);
				uv.push(e[2], e[3]);
			});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Boden unter dem Geraet - eine grosse Platte tief unter dem Schrank. Sie
	 * traegt den Kontaktschatten als dunklen Fleck in der Textur, damit das
	 * Geraet steht und nicht schwebt.
	 */
	var BODEN_Y = -0.78;
	function baueBodenNetz() {
		var pos = [], nrm = [], uv = [], idx = [], S = 3.0;
		[[-S, -S, 0, 0], [S, -S, 1, 0], [S, S, 1, 1], [-S, S, 0, 1]].forEach(function (e) {
			pos.push(e[0], BODEN_Y, e[1]); nrm.push(0, 1, 0); uv.push(e[2], e[3]);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}
	function zeichneBodenbild() {
		// Schattenfleck unter dem Schrank, weich auslaufend
		var N = 256, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, N, N);
		var rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.34);
		rg.addColorStop(0.00, "rgba(0,0,0,0.78)");
		rg.addColorStop(0.55, "rgba(0,0,0,0.40)");
		rg.addColorStop(1.00, "rgba(0,0,0,0.00)");
		g.save(); g.translate(N / 2, N / 2); g.scale(0.55, 1.15); g.translate(-N / 2, -N / 2);
		g.fillStyle = rg; g.fillRect(0, 0, N, N);
		g.restore();
		return cv;
	}

	// Verschiebung ohne Drehung - fuer Teile, die senkrecht im Raum stehen
	function verschiebung(x, y, z) {
		var o = ident(m4());
		o[12] = x; o[13] = y; o[14] = z;
		return o;
	}

	// Rinne: eigenes Netz mit der Holztextur, Koordinaten in Metern. Die
	// Maserung laeuft laengs der Rinne, wie bei einem echten Holzbrett.
	function baueRinnenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1);
		var x0 = SCHACHT_X + 0.003, x1 = W - 0.002, ya = -0.02, yb = BOGEN_Y + 0.02;
		[[x0, ya], [x1, ya], [x1, yb], [x0, yb]].forEach(function (e) {
			var w = welt(e[0], e[1], 0.0006);
			pos.push(w[0], w[1], w[2]); nrm.push(n[0], n[1], n[2]);
			uv.push(e[1] / HOLZ_KACHEL_RINNE, e[0] / HOLZ_KACHEL_RINNE);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	// Glasscheibe ueber dem Feld. Nur Spiegelung, kein Koerper.
	var GLAS_H = 0.108;
	function baueScheibenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1), xr = W + 0.028;
		[[-xr, -0.075], [xr, -0.075], [xr, L + 0.075], [-xr, L + 0.075]].forEach(function (e) {
			var w = welt(e[0], e[1], GLAS_H);
			pos.push(w[0], w[1], w[2]); nrm.push(n[0], n[1], n[2]); uv.push(0, 0);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	// Chromleisten: Seitenleisten und der Riegel vorn, auf Glashoehe
	function baueLeistenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var xr = W + SCHRANK_D / 2;
		// Ende am Kopfstueck LEISTE_ENDE (Task 5b): die Kappe endet 1,8 mm vor
		// der Backbox-Rahmenebene, die Fuge ist vom Rahmen und der Holzkante
		// verdeckt (Herleitung im Stellschraubenblock "Backbox").
		rohrEntlangZug(pos, nrm, uv, idx, [[-xr, -0.075], [-xr, LEISTE_ENDE]], 0.009, 12, SCHRANK_H1 - 0.009);
		rohrEntlangZug(pos, nrm, uv, idx, [[ xr, -0.075], [ xr, LEISTE_ENDE]], 0.009, 12, SCHRANK_H1 - 0.009);
		// Riegel vorn: dicker, leicht tiefer
		rohrEntlangZug(pos, nrm, uv, idx, [[-xr - 0.006, -0.082], [xr + 0.006, -0.082]], 0.014, 14, GLAS_H - 0.012);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Flache Platte in der Feldebene mit planaren Texturkoordinaten auf der
	 * Oberseite. Umriss und uv kommen aus spielfeld.js (slingPlatte: die
	 * Bounding-Box des Umrisses auf 0..1) - teileKunst zeichnet den Druck in
	 * dieselben uv, so passt er zur Form. `spiegeln` dreht u um, damit die
	 * gespiegelte rechte Platte dieselbe Grafik zeigt. Die Seiten zeigen auf
	 * (0,0) des Ausschnitts - dort liegt eine neutrale Farbe.
	 */
	function plattenNetz(platte, unten, oben, spiegeln) {
		var umriss = platte.umriss;
		if (flaecheMitVorzeichen(umriss) < 0) umriss = umriss.slice().reverse();
		var pos = [], nrm = [], uv = [], idx = [], i, n = umriss.length;
		for (i = 0; i < n; i++) {
			var p = umriss[i], q = umriss[(i + 1) % n];
			var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
			var wn = weltRichtung(dy / l, -dx / l, 0);
			var b = pos.length / 3;
			[[p, unten], [q, unten], [q, oben], [p, oben]].forEach(function (e) {
				var w = welt(e[0][0], e[0][1], e[1]);
				pos.push(w[0], w[1], w[2]); nrm.push(wn[0], wn[1], wn[2]); uv.push(0.01, 0.01);
			});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		}
		function tex(q) {
			var t = platte.uv(q);
			return [spiegeln ? 1 - t[0] : t[0], t[1]];
		}
		var mx = 0, my = 0;
		umriss.forEach(function (q) { mx += q[0]; my += q[1]; });
		mx /= n; my /= n;
		var wnO = weltRichtung(0, 0, 1), b2 = pos.length / 3;
		var wm = welt(mx, my, oben), tm = tex([mx, my]);
		pos.push(wm[0], wm[1], wm[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(tm[0], tm[1]);
		for (i = 0; i < n; i++) {
			var w2 = welt(umriss[i][0], umriss[i][1], oben), t2 = tex(umriss[i]);
			pos.push(w2[0], w2[1], w2[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(t2[0], t2[1]);
		}
		for (i = 0; i < n; i++) idx.push(b2, b2 + 1 + i, b2 + 1 + ((i + 1) % n));
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Slingshot-Baugruppe wie beim Vorbild: drei Chrompfosten mit
	 * Sechskantmuttern, darum der geschlossene Gummi, obenauf die bedruckte,
	 * hinterleuchtete Platte. Das rote Prisma von vorher war ein Klotz.
	 */
	function baueSlingshot(seite) {
		var SL = T.slingshot;
		function fx(x) { return seite < 0 ? x : 2 * XM - x; }
		var ecken = [[fx(SL.a[0]), SL.a[1]], [fx(SL.b[0]), SL.b[1]], [fx(SL.c[0]), SL.c[1]]];
		var pos = [], nrm = [], uv = [], idx = [];
		rohrEntlangZug(pos, nrm, uv, idx, ecken.concat([ecken[0]]), 0.0045, 10, 0.011);
		// Die Platte ragt etwas ueber die Pfosten hinaus, wie beim Vorbild:
		// Umriss (x1,22, Ecken gerundet) und uv aus spielfeld.js, dieselben,
		// in die teileKunst den Druck legt
		return {
			ecken: ecken,
			gummi: new Netz(pos, nrm, uv, idx),
			platte: plattenNetz(window.slingPlatte(ecken), 0.0265, 0.0295, seite > 0),
			gummiSeg: SEG.filter(function (sg) { return sg.art === "sling"; })[seite < 0 ? 0 : 1] || null
		};
	}

	function baueGlimmNetz() {
		// Einheitsquadrat in der Tischebene. modellFuer() skaliert es je Lampe;
		// die Hoehe kommt aus der Verschiebung und bleibt unskaliert.
		var pos = [], uv = [], idx = [], nrm = [];
		[[-1,-1,0,0],[1,-1,1,0],[1,1,1,1],[-1,1,0,1]].forEach(function (e) {
			pos.push(e[0], 0, e[1]); nrm.push(0,1,0); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	// --------------------------------------------------------------- Lauf
	var netzFeld, netzBanden, netzDraht, netzKugel, netzApron, netzFlipperSchatten, matFlipperSchatten;
	var slingshots = [], netzPfosten, netzMutter;
	var netzBumperFuss, netzBumperKoerper, netzBumperKappe;
	var netzPost, netzPostGummi, netzFlipper, netzFlipperGummi, netzZiel;
	var netzPlunger, netzPlungerKnauf;
	var matFeld, matSchatten, matGlimm, matEinsatz, matLampe, netzGlimm;
	var matGlas, netzGlas, netzGlasRahmen, glas, glasStand = null;
	var texEnv, texKuppel;
	var netzBoden, matBoden, netzBein, netzRinne, netzScheibe, netzLeisten;
	var netzSchrank, netzSchrankKante, netzSchrankInnen, matSchrank, matHolz, matLeder, netzKnopfRing, netzKnopfKappe, netzSchraube;
	var matTeile, FELD;
	// Ein Material ist eine Bindgruppe aus 2D-Textur und Sampler; `binde`
	// entspricht dem gl.bindTexture der alten Fassung.
	var matAktuell = null;
	var LAMPEN = [];
	var spielzeit = 0;
	var proj = m4(), projGpu = m4(), ansicht = m4(), mvp = m4(), tmp = m4();
	// Drehung um lokal x um -90 Grad (Spalten: x -> x, y -> -z, z -> y). Nach
	// modellFuer liegt lokal z auf -Tisch-y, die Drehkoerperachse (lokal y)
	// also auf Tisch +y: der Plunger liegt in der Rinne (Task 5).
	var ROT_X_M90 = new Float32Array([1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1]);
	var mPlunger = m4();
	/*
	 * Kamera: ein Mensch am Geraet, keine Stativkamera. Er schwankt leicht im
	 * Stand, atmet, folgt der Kugel traege mit dem Kopf, beugt sich vor, wenn
	 * sie unten bei den Flippern ist, und zuckt beim Ruetteln.
	 *
	 * Alle Bewegungen sind klein - Millimeter - und mit Zeitkonstanten um eine
	 * Sekunde geglaettet. Die beiden Schwankperioden sind so gewaehlt, dass sie
	 * nie zusammenfallen, sonst entstuende ein erkennbarer Takt.
	 *
	 * Ruhelage (Task 5b): Auge y 0.300 -> 0.285, z 0.190 -> 0.210, Ziel y
	 * 0.030 -> 0.040, dazu GLAS_HOCH 0.335 -> 0.300. Gemessen bei 1920x1080
	 * (Startbild 6000 ms und Schwankphasen 5000/6500/8000 ms): Backbox-Rahmen
	 * oben Zeile 24-27 (vorher 43; nach dem Umbau der Backbox allein -38),
	 * Kugel in der Rinne unten 1049 (vorher 1086, 6 px unter dem Rand),
	 * Plunger-Stirn 1058-1064 (vorher 1095), Flipper-Achsabstand 450 px
	 * (vorher 460, 97.8 %). Neigung allein reicht nicht: Kugel-Stirn und
	 * Rahmenoberkante spannen mehr als die 60 Grad Bildwinkel; mit Abstand
	 * allein braeuchte es 3 cm (Feldbreite < 95 %), darum 1.5 cm tieferes
	 * Auge.
	 *
	 * Beugung und Folgen (Fix-Runde 1 zu Task 5b): mit der alten Beugung
	 * (Auge -0.012 y / -0.022 z, Ziel -0.006 y) und dem Folge-Versatz des
	 * Ziels bis +0.030 z (Kugel unten) stand der Rahmen oben bei Zeile -1 bis
	 * -5, sobald die Kugel unter y 0.36 lag (Rinne, Hub, Flipperspiel).
	 * Gemessen am Modell je Millimeter: Vorwaertsweg des Auges kostet oben
	 * 1.2 px, das Kippen des Ziels 1.3 px, das Absenken des Auges bringt
	 * oben 0.6 px (der Blick hebt sich). Darum:
	 * KAMERA_BEUGUNG     [Auge -y, Auge -z, Ziel -y] = [0.012, 0.014, 0]:
	 *                    Absenken bleibt, Naeherkommen 22 -> 14 mm, kein
	 *                    Kippen. Flipper-Spreizung bei Beugung 14.7 px
	 *                    (vorher 18.3); die Kugel in der Rinne rueckt attract
	 *                    -> Beugung nur etwa 1 px nach links und 7 px nach
	 *                    unten (Pruefung 5b, Schwankung herausgerechnet) - das
	 *                    Folgen nach rechts (Folge-dx) sieht man am Posten der
	 *                    Bumpergruppe, 28 px. Rahmen oben Rinne 18 px,
	 *                    Flipperbereich 19 px (Modell; Schwankung -4.5).
	 * KAMERA_FOLGE_Z     Ziel-z je Meter Kugelabstand von y 0.56, 0.06 -> 0.04;
	 * KAMERA_FOLGE_Z_MAX Klemme zum Spieler hin (+z) bei 0.012 (Kugel in der
	 *                    Rinne gab vorher +0.030 = 15 px oben). Nach oben
	 *                    (Kugel am Kopfende, -z) ungeklemmt: dort gewinnt der
	 *                    Rahmen Rand.
	 */
	var RUHE_AUGE = [XM, 0.285, 0.210], RUHE_ZIEL = [XM, 0.040, -0.560];
	var KAMERA_BEUGUNG = [0.012, 0.014, 0.0];
	var KAMERA_FOLGE_Z = 0.04, KAMERA_FOLGE_Z_MAX = 0.012;
	var augePos = RUHE_AUGE.slice();
	var kamera = { auge: RUHE_AUGE.slice(), ziel: RUHE_ZIEL.slice(),
				   dx: 0, dz: 0, beugung: 0, stoss: 0 };

	function kameraSchritt(dt) {
		var t = spielzeit;
		var sx = Math.sin(t * 0.37) * 0.006 + Math.sin(t * 0.91 + 1.3) * 0.0025;
		var sy = Math.sin(t * 0.53 + 0.7) * 0.004;
		var sz = Math.sin(t * 1.57) * 0.0022;                  // Atmen
		var kugelDa = ph.aktiv && spiel.zustand === "spiel";
		var zielX = kugelDa ? (ph.p[0] - XM) * 0.10 : 0;
		var zielZ = kugelDa ? Math.min(KAMERA_FOLGE_Z_MAX, -(ph.p[1] - 0.56) * KAMERA_FOLGE_Z) : 0;
		var beugen = kugelDa && ph.p[1] < 0.36 ? 1 : 0;
		var k = Math.min(1, dt * 1.6);
		kamera.dx += (zielX - kamera.dx) * k;
		kamera.dz += (zielZ - kamera.dz) * k;
		kamera.beugung += (beugen - kamera.beugung) * Math.min(1, dt * 1.1);
		// Ruetteln: `ruettel` klingt in spielSchritt selbst ab, die Kamera
		// nimmt es direkt als seitlichen Versatz
		kamera.stoss += (ruettel * 0.0035 - kamera.stoss) * Math.min(1, dt * 18);

		kamera.auge[0] = RUHE_AUGE[0] + sx + kamera.dx * 0.5 + kamera.stoss + kameraVersatz[0];
		kamera.auge[1] = RUHE_AUGE[1] + sy - kamera.beugung * KAMERA_BEUGUNG[0] + kameraVersatz[1];
		kamera.auge[2] = RUHE_AUGE[2] + sz - kamera.beugung * KAMERA_BEUGUNG[1] + kameraVersatz[2];
		kamera.ziel[0] = RUHE_ZIEL[0] + kamera.dx + kamera.stoss * 0.6 + sx * 0.3 + kameraVersatz[3];
		kamera.ziel[1] = RUHE_ZIEL[1] - kamera.beugung * KAMERA_BEUGUNG[2] + kameraVersatz[4];
		kamera.ziel[2] = RUHE_ZIEL[2] + kamera.dz + kameraVersatz[5];
		augePos = kamera.auge;
	}

	/*
	 * Projektion fuer WebGPU: raum.js liefert die WebGL-Matrix mit Tiefe in
	 * [-1, 1], WebGPU erwartet [0, 1]. Nur die dritte Zeile aendert sich; das
	 * gemeinsame Modul bleibt unangetastet, die Umrechnung passiert hier.
	 */
	function gpuProjektion(q, p) {
		q.set(p);
		q[2]  = 0.5 * p[2]  + 0.5 * p[3];
		q[6]  = 0.5 * p[6]  + 0.5 * p[7];
		q[10] = 0.5 * p[10] + 0.5 * p[11];
		q[14] = 0.5 * p[14] + 0.5 * p[15];
		return q;
	}

	// ---------------------------------------------------- Sampler, Pipelines
	var sampLinear, sampMipRand, sampMipSpiegel, sampWuerfel;
	var bglRahmen, bglObjekt, bglMaterial, bglLampe, bglBlit, bglWeich, bglZusammen, bglLicht;
	var pipeOpak, pipeAlpha, pipeGlas, pipeSchatten, pipeLampe, pipeLicht;
	var pipeBg, pipeHell, pipeWeich, pipeZusammen, pipeBlit, pipeBlitRG, pipeBlitHdr;
	var schrittXBuf, schrittYBuf;
	// Lichtkarte: Textur mit Mipmaps, je Stufe Ansicht und Blit-Bindgruppe
	// (einmal angelegt, nicht je Bild), Instanzpuffer der Lampen, Uniform
	var texLicht = null, lichtAnsichten = [], lichtBlits = [], lichtBuf = null, lichtUniBuf = null, bgLicht = null;
	var lichtDaten = null;

	// Nach jedem createShaderModule die Meldungen abwarten: sie enthalten
	// Zeile und Spalte im WGSL, ein Validierungsfehler spaeter nicht.
	async function ladeShader(quelle, name) {
		var mod = device.createShaderModule({ label: name, code: quelle });
		var info = await mod.getCompilationInfo();
		info.messages.forEach(function (m) {
			var text = "WGSL " + name + " " + m.lineNum + ":" + m.linePos + " " + m.message;
			if (m.type === "error") console.error(text);
			else if (m.type === "warning") console.warn(text);
		});
		return mod;
	}

	var NETZ_PUFFER = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
		{ arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
		{ arrayStride: 8,  attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] }
	];
	// Blend-Zustaende eins zu eins aus der WebGL-Fassung
	var BLEND_ALPHA = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
	                    alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" } };
	var BLEND_ADDITIV = { color: { srcFactor: "one", dstFactor: "one", operation: "add" },
	                      alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } };
	// gl.blendFunc(CONSTANT_ALPHA, ONE): WebGPU kennt fuer die Farbe nur
	// "constant" (das RGB der Blendkonstante), deshalb wird die Konstante als
	// Grauwert GLAS_SPIEGEL gesetzt - siehe setBlendConstant vor der Glasscheibe.
	var BLEND_KONSTANT = { color: { srcFactor: "constant", dstFactor: "one", operation: "add" },
	                       alpha: { srcFactor: "constant", dstFactor: "one", operation: "add" } };
	// Lichtkarte: Farbe additiv, Alpha (Insert-Deckung) als Maximum - additiv
	// schalteten ueberlappende Hoefe die Lampenpfuetzen doppelt ab (Task 5)
	var BLEND_LICHT = { color: { srcFactor: "one", dstFactor: "one", operation: "add" },
	                    alpha: { srcFactor: "one", dstFactor: "one", operation: "max" } };

	async function baueGrafik() {
		var VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, F = GPUShaderStage.FRAGMENT;
		var U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

		sampLinear = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		// Das Spielfeld wird flach und stark verkuerzt gesehen. Ohne anisotrope
		// Filterung greift schon nahe am Auge eine hohe Mipmap-Stufe, die
		// Sterne und Linien ins Blau mittelt.
		sampMipRand = device.createSampler({ magFilter: "linear", minFilter: "linear",
		                                     mipmapFilter: "linear", maxAnisotropy: 16 });
		// Gespiegelte Wiederholung: kachelt auch Bilder, die nicht nahtlos sind
		sampMipSpiegel = device.createSampler({ magFilter: "linear", minFilter: "linear",
		                                        mipmapFilter: "linear", maxAnisotropy: 16,
		                                        addressModeU: "mirror-repeat", addressModeV: "mirror-repeat" });
		sampWuerfel = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

		bglRahmen = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: { type: "uniform" } },
			{ binding: 1, visibility: F, texture: { viewDimension: "cube" } },
			{ binding: 2, visibility: F, texture: { viewDimension: "cube" } },
			{ binding: 3, visibility: F, sampler: {} },
			{ binding: 4, visibility: F, texture: {} },
			{ binding: 5, visibility: F, sampler: {} },
			{ binding: 6, visibility: F, texture: {} },
			{ binding: 7, visibility: F, sampler: {} } ] });
		bglObjekt = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 240 } } ] });
		// Lichtkarte: Feld-uv-Uniform, Insert-Maske, Glimmbild
		bglLicht = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: VF, buffer: { type: "uniform" } },
			{ binding: 1, visibility: F, texture: {} },
			{ binding: 2, visibility: F, sampler: {} },
			{ binding: 3, visibility: F, texture: {} },
			{ binding: 4, visibility: F, sampler: {} } ] });
		bglMaterial = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: F, texture: {} },
			{ binding: 1, visibility: F, sampler: {} } ] });
		// Lampen: Glimmbild plus Insert-Maske (zweikanalig R/G, mit Mipmaps)
		bglLampe = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: F, texture: {} },
			{ binding: 1, visibility: F, sampler: {} },
			{ binding: 2, visibility: F, texture: {} },
			{ binding: 3, visibility: F, sampler: {} } ] });
		bglBlit = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: F, texture: {} },
			{ binding: 1, visibility: F, sampler: {} } ] });
		bglWeich = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: F, texture: {} },
			{ binding: 1, visibility: F, sampler: {} },
			{ binding: 2, visibility: F, buffer: { type: "uniform" } } ] });
		bglZusammen = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: F, texture: {} },
			{ binding: 1, visibility: F, sampler: {} },
			{ binding: 2, visibility: F, texture: {} } ] });

		objBuf = device.createBuffer({ size: SLOTS * SLOT_BYTES, usage: U });
		rahmenBuf = device.createBuffer({ size: rahmenDaten.byteLength, usage: U });
		schrittXBuf = device.createBuffer({ size: 16, usage: U });
		schrittYBuf = device.createBuffer({ size: 16, usage: U });
		bgObjekt = device.createBindGroup({ layout: bglObjekt, entries: [
			{ binding: 0, resource: { buffer: objBuf, offset: 0, size: SLOT_BYTES } } ] });

		var modNetz = await ladeShader(WGSL_NETZ, "netz");
		var modFlach = await ladeShader(WGSL_FLACH, "flach");
		var modLampe = await ladeShader(WGSL_LAMPE, "lampe");
		var modBg = await ladeShader(WGSL_BG, "hintergrund");
		var modHell = await ladeShader(WGSL_HELL, "hell");
		var modWeich = await ladeShader(WGSL_WEICH, "weich");
		var modZusammen = await ladeShader(WGSL_ZUSAMMEN, "zusammen");
		var modBlit = await ladeShader(WGSL_BLIT, "blit");
		var modBlitHdr = await ladeShader(WGSL_BLIT_HDR, "blitHdr");
		var modLicht = await ladeShader(WGSL_LICHT, "licht");

		// Szene: 4x MSAA auf Farbe und Tiefe (WebGL hatte antialias:true),
		// Tiefe depth24plus mit LESS, depthWriteEnabled entspricht depthMask.
		var layoutNetz = device.createPipelineLayout({ bindGroupLayouts: [bglRahmen, bglObjekt, bglMaterial] });
		var layoutLampe = device.createPipelineLayout({ bindGroupLayouts: [bglRahmen, bglObjekt, bglLampe] });
		function netzPipeline(mod, vs, fs, o) {
			return device.createRenderPipeline({
				layout: o.layout || layoutNetz,
				vertex: { module: mod, entryPoint: vs, buffers: NETZ_PUFFER },
				fragment: { module: mod, entryPoint: fs, targets: [{ format: "rgba8unorm", blend: o.blend }] },
				primitive: { topology: "triangle-list", frontFace: "ccw",
				             cullMode: o.cull === undefined ? "back" : o.cull },
				depthStencil: { format: "depth24plus", depthCompare: "less",
				                depthWriteEnabled: o.tiefeSchreiben !== false },
				multisample: { count: 4 }
			});
		}
		pipeOpak     = netzPipeline(modNetz, "vsNetz", "fsNetz", {});
		pipeAlpha    = netzPipeline(modNetz, "vsNetz", "fsNetz", { blend: BLEND_ALPHA, tiefeSchreiben: false });
		pipeGlas     = netzPipeline(modNetz, "vsNetz", "fsNetz", { blend: BLEND_KONSTANT, tiefeSchreiben: false, cull: "none" });
		// Schatten und Lampen ohne Rueckseitenentfernung: flache Quads. Das
		// lokale Glimmquadrat (und das Flipperschatten-Rechteck) laeuft von
		// oben gesehen im Uhrzeigersinn - mit "back" fielen Schatten UND
		// Lampen-Sprites vollstaendig weg (im Bild nachgewiesen, Task 1; die
		// Sprites waren in WebGPU bis Task 2 nie zu sehen).
		pipeSchatten = netzPipeline(modFlach, "vsFlach", "fsSchatten", { blend: BLEND_ALPHA, tiefeSchreiben: false, cull: "none" });
		pipeLampe    = netzPipeline(modLampe, "vsFlach", "fsLampe", { blend: BLEND_ADDITIV, tiefeSchreiben: false, cull: "none", layout: layoutLampe });

		// Hintergrund: im selben MSAA-Pass, ohne Tiefe (Vergleich "always")
		pipeBg = device.createRenderPipeline({
			layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
			vertex: { module: modBg, entryPoint: "vsVoll" },
			fragment: { module: modBg, entryPoint: "fsBg", targets: [{ format: "rgba8unorm" }] },
			primitive: { topology: "triangle-strip" },
			depthStencil: { format: "depth24plus", depthCompare: "always", depthWriteEnabled: false },
			multisample: { count: 4 }
		});
		function vollPipeline(mod, fs, bgl, format) {
			return device.createRenderPipeline({
				layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
				vertex: { module: mod, entryPoint: "vsVoll" },
				fragment: { module: mod, entryPoint: fs, targets: [{ format: format }] },
				primitive: { topology: "triangle-strip" }
			});
		}
		pipeHell     = vollPipeline(modHell, "fsHell", bglBlit, "rgba8unorm");
		pipeWeich    = vollPipeline(modWeich, "fsWeich", bglWeich, "rgba8unorm");
		pipeZusammen = vollPipeline(modZusammen, "fsZusammen", bglZusammen, leinwandFormat);
		pipeBlit     = vollPipeline(modBlit, "fsBlit", bglBlit, "rgba8unorm");
		pipeBlitRG   = vollPipeline(modBlit, "fsBlit", bglBlit, "rg8unorm");  // Mipmaps der Insert-Maske
		pipeBlitHdr  = vollPipeline(modBlitHdr, "fsBlitHdr", bglBlit, "rgba8unorm");  // Spiegelkarte, linear gemittelt
		// Lichtkarte: ein Quad je Lampe als Instanz, additiv, ohne Tiefe
		pipeLicht = device.createRenderPipeline({
			layout: device.createPipelineLayout({ bindGroupLayouts: [bglLicht] }),
			vertex: { module: modLicht, entryPoint: "vsLicht", buffers: [
				{ arrayStride: 32, stepMode: "instance", attributes: [
					{ shaderLocation: 0, offset: 0, format: "float32x4" },
					{ shaderLocation: 1, offset: 16, format: "float32x4" } ] } ] },
			fragment: { module: modLicht, entryPoint: "fsLicht", targets: [{ format: "rgba8unorm", blend: BLEND_LICHT }] },
			primitive: { topology: "triangle-strip", cullMode: "none" }
		});
	}

	// ----------------------------------------------------------- Texturen
	// Bildquelle auf eine Leinwand fester Groesse bringen. Leinwaende gehen
	// direkt in copyExternalImageToTexture; Bilder werden umgezeichnet, damit
	// alle sechs Seiten einer Wuerfelkarte dieselbe Groesse haben - auch die
	// 4 x 4 grosse Ersatzseite aus umgebung.js.
	function alsLeinwand(bild, n) {
		if (bild instanceof HTMLCanvasElement && bild.width === n && bild.height === n) return bild;
		var cv = document.createElement("canvas");
		cv.width = cv.height = n;
		cv.getContext("2d").drawImage(bild, 0, 0, n, n);
		return cv;
	}

	// Mipmaps: je Stufe und Lage ein Render-Pass, der die naechstgroessere
	// Stufe linear abtastet (bei Wuerfelkarten je Seite). `pipe` wahlweise
	// pipeBlitRG (zwei Kanaele) oder pipeBlitHdr (kodierte Spiegelkarte,
	// linear gemittelt).
	function erzeugeMipmaps(tex, stufen, lagen, pipe) {
		var enc = device.createCommandEncoder();
		for (var l = 1; l < stufen; l++) {
			for (var i = 0; i < lagen; i++) {
				var quelle = tex.createView({ dimension: "2d", baseMipLevel: l - 1, mipLevelCount: 1,
				                              baseArrayLayer: i, arrayLayerCount: 1 });
				var ziel = tex.createView({ dimension: "2d", baseMipLevel: l, mipLevelCount: 1,
				                            baseArrayLayer: i, arrayLayerCount: 1 });
				var bg = device.createBindGroup({ layout: bglBlit, entries: [
					{ binding: 0, resource: quelle }, { binding: 1, resource: sampLinear } ] });
				var p = enc.beginRenderPass({ colorAttachments: [{ view: ziel, loadOp: "clear", storeOp: "store" }] });
				p.setPipeline(pipe || pipeBlit); p.setBindGroup(0, bg); p.draw(4); p.end();
			}
		}
		device.queue.submit([enc.finish()]);
	}
	function stufenFuer(n) { return 1 + Math.floor(Math.log2(n)); }

	// Leinwand -> 2D-Textur. Zurueck kommt das Material: Textur, Ansicht und
	// die Bindgruppe mit dem passenden Sampler. `format` wahlweise "rg8unorm"
	// (zwei Kanaele, z. B. die Insert-Maske - die Haelfte des Speichers).
	// `maxStufen` kappt die Mip-Kette (Backglas: BACKGLAS_STUFEN - die Scheibe
	// ist im Bild etwa 390 px breit, Stufen unter 32 px werden nie abgetastet).
	function macheTextur(cv, mip, kacheln, format, maxStufen) {
		var b = cv.width, h = cv.height;
		var stufen = mip ? Math.min(stufenFuer(Math.max(b, h)), maxStufen || 99) : 1;
		var fmt = format || "rgba8unorm";
		// RENDER_ATTACHMENT immer: copyExternalImageToTexture verlangt es am
		// Ziel, nicht nur die Mipmap-Paesse.
		var nutzung = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
		var tex = device.createTexture({ size: [b, h], format: fmt, mipLevelCount: stufen, usage: nutzung });
		// Kein flipY: die alte Fassung setzte kein UNPACK_FLIP_Y, v=0 ist die
		// oberste Bildzeile - in beiden Fassungen.
		device.queue.copyExternalImageToTexture({ source: cv }, { texture: tex }, [b, h]);
		if (mip) erzeugeMipmaps(tex, stufen, 1, fmt === "rg8unorm" ? pipeBlitRG : pipeBlit);
		var ansicht2 = tex.createView();
		var samp = mip ? (kacheln ? sampMipSpiegel : sampMipRand) : sampLinear;
		return { tex: tex, b: b, h: h, stufen: stufen, ansicht: ansicht2, samp: samp,
		         bg: device.createBindGroup({ layout: bglMaterial, entries: [
		             { binding: 0, resource: ansicht2 }, { binding: 1, resource: samp } ] }) };
	}

	// Wuerfelkarte: sechs Lagen, Ansicht "cube". Reihenfolge px nx py ny pz nz
	// wie in umgebung.js; die Seitenbilder liegen in beiden APIs gleich herum.
	function macheWuerfel(seiten, mip) {
		var n = 0;
		seiten.forEach(function (s) { n = Math.max(n, s.width || s.naturalWidth || 0); });
		n = Math.max(1, n);
		var stufen = mip ? stufenFuer(n) : 1;
		// RENDER_ATTACHMENT immer: copyExternalImageToTexture verlangt es am
		// Ziel, nicht nur die Mipmap-Paesse.
		var nutzung = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
		var tex = device.createTexture({ size: [n, n, 6], format: "rgba8unorm", mipLevelCount: stufen, usage: nutzung });
		for (var i = 0; i < 6; i++) {
			device.queue.copyExternalImageToTexture({ source: alsLeinwand(seiten[i], n) },
			                                        { texture: tex, origin: [0, 0, i] }, [n, n]);
		}
		// Die Wuerfel sind hdr-kodiert: linear gemittelte Mipmaps (Task 3)
		if (mip) erzeugeMipmaps(tex, stufen, 6, pipeBlitHdr);
		return { tex: tex, view: tex.createView({ dimension: "cube" }) };
	}

	/*
	 * Lichtkarte anlegen: Textur mit LICHT_STUFEN Mipmaps, je Stufe eine
	 * Ansicht und die Blit-Bindgruppe (Stufe l liest l-1), der Instanzpuffer
	 * fuer die Lampen und das kleine Uniform mit der Feld-uv-Abbildung.
	 */
	function macheLichtkarte() {
		var nutzung = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
		var tex = device.createTexture({ size: [LICHT_B, LICHT_H], format: "rgba8unorm",
		                                 mipLevelCount: LICHT_STUFEN, usage: nutzung });
		lichtAnsichten = []; lichtBlits = [];
		for (var l = 0; l < LICHT_STUFEN; l++) {
			lichtAnsichten.push(tex.createView({ dimension: "2d", baseMipLevel: l, mipLevelCount: 1 }));
			if (l > 0) lichtBlits.push(device.createBindGroup({ layout: bglBlit, entries: [
				{ binding: 0, resource: lichtAnsichten[l - 1] }, { binding: 1, resource: sampLinear } ] }));
		}
		lichtDaten = new Float32Array(Math.max(1, LAMPEN.length) * 8);
		lichtBuf = device.createBuffer({ size: lichtDaten.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		lichtUniBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(lichtUniBuf, 0, new Float32Array([FELD_XR, FELD_Y0, FELD_Y1, 0]));
		bgLicht = device.createBindGroup({ layout: bglLicht, entries: [
			{ binding: 0, resource: { buffer: lichtUniBuf } },
			{ binding: 1, resource: matEinsatz.ansicht }, { binding: 2, resource: matEinsatz.samp },
			{ binding: 3, resource: matGlimm.ansicht }, { binding: 4, resource: matGlimm.samp } ] });
		texLicht = { tex: tex, view: tex.createView() };
	}

	// Lichtkarte zeichnen: alle Lampen in einem Draw, dann die Mipmaps.
	// Laeuft im Kommandopuffer des Bildes VOR der Szene.
	function zeichneLichtkarte(enc) {
		for (var i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i], o = i * 8;
			lichtDaten[o] = lp.x; lichtDaten[o + 1] = lp.y; lichtDaten[o + 2] = lp.r; lichtDaten[o + 3] = lp.an * spriteFaktor;
			lichtDaten[o + 4] = lp.farbe[0]; lichtDaten[o + 5] = lp.farbe[1]; lichtDaten[o + 6] = lp.farbe[2];
			lichtDaten[o + 7] = lp.ohneInsert ? 0 : 1;      // Maske an (Sling: kein eigenes Insert)
		}
		device.queue.writeBuffer(lichtBuf, 0, lichtDaten);
		var p = enc.beginRenderPass({ colorAttachments: [{ view: lichtAnsichten[0], loadOp: "clear", storeOp: "store",
		                                                   clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
		p.setPipeline(pipeLicht); p.setBindGroup(0, bgLicht); p.setVertexBuffer(0, lichtBuf);
		p.draw(4, LAMPEN.length); p.end();
		for (var l = 1; l < LICHT_STUFEN; l++) {
			var q = enc.beginRenderPass({ colorAttachments: [{ view: lichtAnsichten[l], loadOp: "clear", storeOp: "store" }] });
			q.setPipeline(pipeBlit); q.setBindGroup(0, lichtBlits[l - 1]); q.draw(4); q.end();
		}
	}

	/*
	 * Backglas-Mipmaps (Task 5, Fix-Runde 1): Ansichten und Blit-Bindgruppen
	 * einmal angelegt wie bei der Lichtkarte; die Blits laufen nur in Bildern
	 * mit Standaenderung, als Paesse im Bild-Encoder vor der Lichtkarte - kein
	 * eigener Submit. erzeugeMipmaps bleibt fuer das einmalige Laden.
	 */
	var glasAnsichten = [], glasBlits = [], glasNeu = false, glasBlitsBild = 0;
	function macheGlasBlits() {
		glasAnsichten = []; glasBlits = [];
		for (var l = 0; l < matGlas.stufen; l++) {
			glasAnsichten.push(matGlas.tex.createView({ dimension: "2d", baseMipLevel: l, mipLevelCount: 1 }));
			if (l > 0) glasBlits.push(device.createBindGroup({ layout: bglBlit, entries: [
				{ binding: 0, resource: glasAnsichten[l - 1] }, { binding: 1, resource: sampLinear } ] }));
		}
	}
	function zeichneGlasMipmaps(enc) {
		for (var l = 1; l < matGlas.stufen; l++) {
			var q = enc.beginRenderPass({ colorAttachments: [{ view: glasAnsichten[l], loadOp: "clear", storeOp: "store" }] });
			q.setPipeline(pipeBlit); q.setBindGroup(0, glasBlits[l - 1]); q.draw(4); q.end();
		}
	}

	function binde(mat) { matAktuell = mat; }

	// ------------------------------------------------------- Render-Ziele
	/*
	 * Szene in eine Textur (ueber MSAA aufgeloest), der Schleier in
	 * Viertelgroesse je Achse - derselbe Faktor wie in der WebGL-Fassung
	 * (b >> 2), damit der Hof gleich breit bleibt. Bei Groessenaenderung
	 * werden die Texturen neu angelegt und die alten freigegeben.
	 */
	var msaa = null, tiefe = null, zielSzene = null, zielHell = null, zielWeich = null;
	var bgHell = null, bgWeichH = null, bgWeichV = null, bgZusammen = null;

	function macheZiel(b, h) {
		var t = device.createTexture({ size: [b, h], format: "rgba8unorm",
		                               usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		return { tex: t, view: t.createView(), b: b, h: h };
	}

	function pruefePuffer(b, h) {
		if (zielSzene && zielSzene.b === b && zielSzene.h === h) return;
		[msaa, tiefe, zielSzene, zielHell, zielWeich].forEach(function (z) { if (z) z.tex.destroy(); });
		var tm = device.createTexture({ size: [b, h], format: "rgba8unorm", sampleCount: 4,
		                                usage: GPUTextureUsage.RENDER_ATTACHMENT });
		msaa = { tex: tm, view: tm.createView() };
		var tt = device.createTexture({ size: [b, h], format: "depth24plus", sampleCount: 4,
		                                usage: GPUTextureUsage.RENDER_ATTACHMENT });
		tiefe = { tex: tt, view: tt.createView() };
		var kb = Math.max(1, b >> 2), kh = Math.max(1, h >> 2);
		zielSzene = macheZiel(b, h);
		zielHell  = macheZiel(kb, kh);
		zielWeich = macheZiel(kb, kh);
		device.queue.writeBuffer(schrittXBuf, 0, new Float32Array([1 / kb, 0, 0, 0]));
		device.queue.writeBuffer(schrittYBuf, 0, new Float32Array([0, 1 / kh, 0, 0]));
		bgHell = device.createBindGroup({ layout: bglBlit, entries: [
			{ binding: 0, resource: zielSzene.view }, { binding: 1, resource: sampLinear } ] });
		bgWeichH = device.createBindGroup({ layout: bglWeich, entries: [
			{ binding: 0, resource: zielHell.view }, { binding: 1, resource: sampLinear },
			{ binding: 2, resource: { buffer: schrittXBuf } } ] });
		bgWeichV = device.createBindGroup({ layout: bglWeich, entries: [
			{ binding: 0, resource: zielWeich.view }, { binding: 1, resource: sampLinear },
			{ binding: 2, resource: { buffer: schrittYBuf } } ] });
		bgZusammen = device.createBindGroup({ layout: bglZusammen, entries: [
			{ binding: 0, resource: zielSzene.view }, { binding: 1, resource: sampLinear },
			{ binding: 2, resource: zielHell.view } ] });
	}

	// Schleier: hell -> waagerecht -> senkrecht, dann Szene plus Schleier
	// (Staerke 0.38) auf die Leinwand.
	function schleierUeberlagern(enc) {
		function vollPass(ziel, pipe, bg) {
			var p = enc.beginRenderPass({ colorAttachments: [{ view: ziel, loadOp: "clear", storeOp: "store" }] });
			p.setPipeline(pipe); p.setBindGroup(0, bg); p.draw(4); p.end();
		}
		vollPass(zielHell.view, pipeHell, bgHell);
		vollPass(zielWeich.view, pipeWeich, bgWeichH);
		vollPass(zielHell.view, pipeWeich, bgWeichV);
		vollPass(context.getCurrentTexture().createView(), pipeZusammen, bgZusammen);
	}

	// ------------------------------------------------------------ Zeichnen
	var UV_GANZ = [0, 0, 1, 1];

	// Objektwerte in den naechsten Eintrag schreiben; zurueck kommt der
	// Byte-Versatz fuer die Bindgruppe. Die Indizes sind die Byte-Versaetze
	// des WGSL-Structs geteilt durch vier.
	function schreibeObjekt(m, farbe, rauheit, leucht, metall, texAn, uvFeld, alpha, spiegelFeld, lampGlanz) {
		var o = slot * SLOT_FLOATS;
		mul(tmp, ansicht, m); mul(mvp, projGpu, tmp);
		objDaten.set(mvp, o);
		objDaten.set(m, o + 16);
		var n = normalMatrix(m);
		objDaten[o+32] = n[0]; objDaten[o+33] = n[1]; objDaten[o+34] = n[2];
		objDaten[o+36] = n[3]; objDaten[o+37] = n[4]; objDaten[o+38] = n[5];
		objDaten[o+40] = n[6]; objDaten[o+41] = n[7]; objDaten[o+42] = n[8];
		objDaten[o+44] = farbe[0]; objDaten[o+45] = farbe[1]; objDaten[o+46] = farbe[2];
		objDaten[o+47] = texAn === true ? 1 : (texAn ? +texAn : 0);   // 2 = Spielfeld (Insert-Maske im Shader)
		var f = uvFeld || UV_GANZ;
		objDaten[o+48] = f[0]; objDaten[o+49] = f[1]; objDaten[o+50] = f[2]; objDaten[o+51] = f[3];
		objDaten[o+52] = rauheit; objDaten[o+53] = leucht || 0;
		objDaten[o+54] = metall || 0; objDaten[o+55] = alpha === undefined ? 1 : alpha;
		objDaten[o+56] = spiegelFeld ? spiegelFaktor : 0;   // Feldspiegelung (Task 3), Pruefstand skaliert
		objDaten[o+57] = lampGlanz === undefined ? 1 : lampGlanz;   // Lampen-Glanzpunkt am Teil (Task 5)
		return (slot++) * SLOT_BYTES;
	}

	function zeichneObjekt(netz, m, farbe, rauheit, leucht, metall, texAn, uvFeld, alpha, spiegelFeld, lampGlanz) {
		if (slot >= SLOTS) {
			if (!slotWarnung) { slotWarnung = true; console.warn("Pinball: zu viele Objekte je Bild, Rest ausgelassen"); }
			return;
		}
		var versatz = schreibeObjekt(m, farbe, rauheit, leucht, metall, texAn, uvFeld, alpha, spiegelFeld, lampGlanz);
		pass.setBindGroup(1, bgObjekt, [versatz]);
		pass.setBindGroup(2, matAktuell.bg);
		netz.zeichne();
	}
	// Metallteil auf dem Tisch: ohne Textur, spiegelt unten das Feld (matFeld
	// muss gebunden sein - texBild ist dort das Feldbild). lampGlanz: Staerke
	// des Lampen-Glanzpunkts (1; die Kugel 0, s. KUGEL_LAMPE_GLANZ)
	function zeichneChrom(netz, m, farbe, rauheit, metall, lampGlanz) {
		zeichneObjekt(netz, m, farbe, rauheit, 0, metall === undefined ? 1.0 : metall, false, null, 1, 1, lampGlanz);
	}

	function lampenSchritt(dt) {
		for (var i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			var ziel = spiel.lampeZiel(lp, spielzeit, i);
			// Rollt die Kugel darueber, zieht die Lampe voll durch. Nicht beim
			// Sling: dessen Lampe liegt unter der Platte, die Kugel kann sie nicht
			// ueberrollen - sonst glueht sie voll, solange die Kugel gefangen an
			// der Sling-Kappe ruht (Paket 2a). Der Sling blitzt nur beim Feuern.
			if (ph.aktiv && lp.art !== "sling" && Math.hypot(ph.p[0] - lp.x, ph.p[1] - lp.y) < lp.r * 1.3) ziel = 1;
			// Pruefstand: pinballDebug.lampe() haelt eine Lampe fest
			if (lp.fest !== undefined && lp.fest !== null) ziel = lp.fest;
			lp.an += (ziel - lp.an) * Math.min(1, dt * 15);
		}
		for (i = 0; i < SCHEIBE.length; i++) {
			if (SCHEIBE[i].blitz > 0) SCHEIBE[i].blitz = Math.max(0, SCHEIBE[i].blitz - dt * 3.0);
		}
		for (i = 0; i < SEG.length; i++) {
			if (SEG[i].blitz > 0) SEG[i].blitz = Math.max(0, SEG[i].blitz - dt * 3.0);
		}
	}

	function waehleLichter() {
		// Der Shader nimmt hoechstens sechs Lampen. Es zaehlt, was die Kugel
		// sieht: Helligkeit geteilt durch Abstand - quadratisch in `an`
		// (Pruefung Task 2): sind mehr als sechs Lampen hell, sollen die
		// hellen gewinnen, nicht die nahen Glimmlampen, sonst laufen
		// Lichtpfuetze und Sprite auseinander.
		var bx = ph.p[0], by = ph.p[1], beste = [], i, j;
		for (i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			if (lp.an < 0.06) continue;
			var dx = bx - lp.x, dy = by - lp.y;
			beste.push({ lp: lp, wert: lp.an * lp.an / (0.02 + dx * dx + dy * dy) });
		}
		beste.sort(function (a, b) { return b.wert - a.wert; });
		var n = Math.min(6, beste.length);
		for (j = 0; j < n; j++) {
			var q = beste[j].lp, wp = welt(q.x, q.y, LAMPE_LICHT_H);
			rahmenF[4 + j*4] = wp[0]; rahmenF[5 + j*4] = wp[1]; rahmenF[6 + j*4] = wp[2];
			var k = q.an * 0.85;
			rahmenF[28 + j*4] = q.farbe[0]*k; rahmenF[29 + j*4] = q.farbe[1]*k; rahmenF[30 + j*4] = q.farbe[2]*k;
		}
		rahmenI[3] = n;
	}

	/*
	 * Lampen-Sprites: ein Quad je Lampe am Lampenradius, LAMPE_H = 0.1 mm
	 * ueber dem Feld (1.2 mm gaben bei flacher Sicht einen hellen Saum ueber
	 * und einen dunklen Streifen unter dem gemalten Umriss - Parallaxe,
	 * Fix-Runde 1). uvFeld ist der Ausschnitt dieses Quads im Feldbild, damit der
	 * Shader die Insert-Maske an derselben Stelle liest: das lokale Quad hat
	 * u nach Tisch +x und v nach Tisch -y (lokal z = -Tisch-y, raum.js), das
	 * Feldbild v = 0 am Kopfende - beide laufen also gleich. Kommt nach Kugel-
	 * und Flipperschatten, sonst dunkeln die Schatten hinterleuchtete Inserts
	 * ab (Uebergabe Task 1, Punkt 7).
	 */
	function lampenUvFeld(lp) {
		return [(lp.x - lp.r + FELD_XR) / (2 * FELD_XR), (FELD_Y1 - lp.y - lp.r) / (FELD_Y1 - FELD_Y0),
		        lp.r / FELD_XR, 2 * lp.r / (FELD_Y1 - FELD_Y0)];
	}
	function zeichneLampen() {
		pass.setPipeline(pipeLampe);
		binde(matLampe);
		for (var i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			if (lp.an < 0.02) continue;
			if (!lp.uvFeld) lp.uvFeld = lampenUvFeld(lp);
			var m = modellFuer(lp.x, lp.y, LAMPE_H, 0, lp.r);
			// texAn: Insert-Maske lesen - nicht bei Lampen ohne eigenes Insert
			zeichneObjekt(netzGlimm, m, lp.farbe, 0, 0, 0, lp.ohneInsert ? 0 : 1, lp.uvFeld, lp.an * spriteFaktor);
		}
		pass.setPipeline(pipeOpak);
	}

	function groesse() {
		var dpr = Math.min(devicePixelRatio || 1, 2);
		var b = Math.max(1, Math.floor(leinwand.clientWidth * dpr));
		var h = Math.max(1, Math.floor(leinwand.clientHeight * dpr));
		if (leinwand.width !== b || leinwand.height !== h) {
			leinwand.width = b; leinwand.height = h;
		}
		return b / h;
	}

	var lesefeld = document.getElementById("readout");
	var bilder = 0, fpsZeit = 0, fps = 0, zuletzt = 0;

	function zeichne(jetzt) {
		var dt = Math.min((jetzt - zuletzt) / 1000, 0.05);
		zuletzt = jetzt;
		spielzeit += dt;

		if (plunger.laedt) plunger.zug = Math.min(1, plunger.zug + dt * 1.7);

		var unter = 12, h = dt / unter, i;
		for (i = 0; i < unter; i++) spielSchritt(h);
		spiel.schritt(dt);
		lampenSchritt(dt);
		kameraSchritt(dt);

		var ar = groesse();
		perspektive(proj, 60 * Math.PI / 180, ar, 0.02, 12);
		gpuProjektion(projGpu, proj);
		blickAuf(ansicht, kamera.auge, kamera.ziel, [0, 1, 0]);
		pruefePuffer(leinwand.width, leinwand.height);

		// Kopfstueck. Die Anzeige wird nur bei Aenderung neu gezeichnet und
		// hochgeladen - sie steht die meiste Zeit still.
		var stand = [spiel.punkte, spiel.ball, spiel.bonus, spiel.multi(), spiel.zustand,
		             spiel.meldung, spiel.bahnen.V, spiel.bahnen.F, spiel.bahnen.X].join("|");
		if (stand !== glasStand) {
			glasStand = stand;
			glas.aktualisiere({ punkte: spiel.punkte, ball: spiel.ball, bonus: spiel.bonus,
			                    multi: spiel.multi(), bahnen: spiel.bahnen,
			                    zustand: spiel.zustand, meldung: spiel.meldung });
			device.queue.copyExternalImageToTexture({ source: glas.canvas }, { texture: matGlas.tex },
			                                        [matGlas.b, matGlas.h]);
			// Mipmaps nachziehen (Task 5): die Scheibe steht weit hinten, ohne
			// sie flimmert die Schrift; die Blits laufen unten im Bild-Encoder.
			glasNeu = true;
		}

		rahmenF[0] = augePos[0]; rahmenF[1] = augePos[1]; rahmenF[2] = augePos[2];
		waehleLichter();

		slot = 0;
		var enc = device.createCommandEncoder();
		// Backglas-Mipmaps nur in Bildern mit Standaenderung (5 Blits, in den
		// Draws des Bilds mitgezaehlt - stand().glasBlits)
		glasBlitsBild = 0;
		if (glasNeu) { zeichneGlasMipmaps(enc); glasNeu = false; glasBlitsBild = matGlas.stufen - 1; }
		// Lichtkarte des Tisches (Inserts x an) vor der Szene - die
		// Feldspiegelung in Kugel und Chrom liest sie
		zeichneLichtkarte(enc);
		pass = enc.beginRenderPass({
			colorAttachments: [{ view: msaa.view, resolveTarget: zielSzene.view,
			                     clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "discard" }],
			depthStencilAttachment: { view: tiefe.view, depthClearValue: 1.0,
			                          depthLoadOp: "clear", depthStoreOp: "discard" }
		});
		// Verlauf hinter allem, ohne Tiefe
		pass.setPipeline(pipeBg);
		pass.draw(4);

		pass.setPipeline(pipeOpak);
		pass.setBindGroup(0, bgRahmen);

		var einheit = ident(m4());
		// Schrank mit Seitengrafik und Front; die Holzkanten mit der Holztextur
		binde(matSchrank);
		zeichneObjekt(netzSchrank, einheit, [1, 1, 1], 0.38, 0, 0.06, true);
		binde(matHolz);
		zeichneObjekt(netzSchrankKante, einheit, HOLZKANTE_FARBE, HOLZKANTE_RAUHEIT, 0, 0.04, true);
		// Innenwaende: Leder, glatt genug, dass sich die Umgebung darin zeigt.
		// Die Waende werden fast streifend gesehen - dort greift der Fresnel-
		// Anteil und legt den Spiegelglanz von selbst ueber die Narbung.
		binde(matLeder);
		zeichneObjekt(netzSchrankInnen, einheit, [0.92, 0.92, 0.92], 0.24, 0, 0.0, true);
		binde(matFeld);

		// Flipperknoepfe aussen an den Waenden, Schrauben laengs der Holzkante
		[-1, 1].forEach(function (seite) {
			var mk = seitwaerts(seite * (W + SCHRANK_D), 0.060, 0.030, seite);
			zeichneObjekt(netzKnopfRing, mk, [0.95, 0.96, 0.97], 0.08, 0, 1.0, false);
			zeichneObjekt(netzKnopfKappe, mk, [0.86, 0.14, 0.16], 0.28, 0.04, 0.05, false);
			for (var yS = SCHRANK_Y0 + 0.08; yS < SCHRANK_Y1 - 0.04; yS += 0.16) {
				var ms = modellFuer(seite * (W + SCHRANK_D / 2), yS, SCHRANK_H1, 0, 1);
				zeichneObjekt(netzSchraube, ms, [0.90, 0.91, 0.93], 0.12, 0, 1.0, false);
			}
		});

		// Boden mit Kontaktschatten, Beine senkrecht im Raum
		binde(matBoden);
		zeichneObjekt(netzBoden, einheit, [0.125, 0.188, 0.227], 0.75, 0, 0.0, true);
		binde(matFeld);
		[[-W - 0.012, -0.06], [W + 0.012, -0.06], [-W - 0.012, L + 0.02], [W + 0.012, L + 0.02]]
			.forEach(function (e) {
				var fuss = welt(e[0], e[1], -0.040);
				zeichneObjekt(netzBein, verschiebung(fuss[0], BODEN_Y, fuss[2]),
				              [0.12, 0.13, 0.15], 0.35, 0, 0.55, false);
			});

		// Kopfstueck: Rahmen, dann die Scheibe mit der Anzeige
		zeichneObjekt(netzGlasRahmen, einheit, [0.16, 0.17, 0.20], 0.30, 0, 0.65, false);
		// texAn 3: Textur, Emission ohne Grauterm (Task 5)
		binde(matGlas);
		zeichneObjekt(netzGlas, einheit, [1, 1, 1], BACKGLAS_RAUHEIT, BACKGLAS_LEUCHT, 0.04, 3);
		binde(matFeld);

		// Matter als zuvor: bei 0.26 spiegelte sich die grosse Softbox als
		// breiter Schleier ueber das halbe Brett und nahm der Grafik alle Farbe.
		zeichneObjekt(netzFeld, einheit, [1,1,1], 0.44, 0, 0.02, 2);
		// Lackiertes Holz in der Rinne: glatter als das Feld
		binde(matHolz);
		zeichneObjekt(netzRinne, einheit, [1,1,1], 0.17, 0, 0.04, true);
		binde(matFeld);
		// Chromteile auf dem Tisch spiegeln unten das Feld (zeichneChrom)
		zeichneChrom(netzBanden, einheit, [0.95, 0.96, 0.97], 0.075);
		// Drahtfuehrungen: eigener Draw, Federstahl (Task 8). Ohne Feld-
		// spiegelung (Fix-Runde 1): die senkrechten Beine spiegeln das Feld
		// wenige mm unter sich, SPIEGEL_AO dunkelte sie auf L 18-25 (Feld 40-44);
		// der waagrechte Draht sieht dort ohnehin die Umgebung.
		zeichneObjekt(netzDraht, einheit, DRAHT_FARBE, DRAHT_RAUHEIT, 0, 1.0, false, null, 1, 0);

		binde(matTeile);
		zeichneObjekt(netzApron, einheit, [0.66, 0.70, 0.76], 0.22, 0, 0.92, true, FELD.blende);
		binde(matFeld);

		// Slingshots: Pfosten, Muttern und Gummi. Die Platte kommt spaeter,
		// nach der Kugel - sie ist durchscheinend.
		slingshots.forEach(function (sl) {
			sl.ecken.forEach(function (e) {
				var mp = modellFuer(e[0], e[1], 0, 0, 1);
				zeichneChrom(netzPfosten, mp, [0.95, 0.96, 0.97], 0.09);
				zeichneChrom(netzMutter,  mp, [0.90, 0.91, 0.93], 0.16);
			});
			zeichneObjekt(sl.gummi, einheit, [0.94, 0.93, 0.90], 0.55, 0, 0.0, false);
		});

		// Bumper: Fuss, Koerper, Kappe - drei Teile mit eigenen Farben. Die
		// Stange (Chrom, 6 mm) lag vollstaendig im Koerper und ist entfallen.
		// Koerper und Kappe leuchten von innen (Stellschrauben BUMPER_*).
		SCHEIBE.forEach(function (q) {
			var m = modellFuer(q.p[0], q.p[1], 0, 0, 1);
			if (q.art === "bumper") {
				var blitz = q.blitz;
				zeichneObjekt(netzBumperFuss, m, [0.16, 0.18, 0.24], 0.28, 0, 0.30, false);
				zeichneObjekt(netzBumperKoerper, m, [0.95, 0.80, 0.20], 0.34,
				              BUMPER_KOERPER_LEUCHT + blitz * BUMPER_KOERPER_BLITZ, 0.0, false);
				binde(matTeile);
				zeichneObjekt(netzBumperKappe, m, [0.84, 0.16, 0.20], 0.18,
				              BUMPER_KAPPE_LEUCHT + blitz * BUMPER_KAPPE_BLITZ, 0.04, true, FELD.bumperKappe);
				binde(matFeld);
			} else {
				zeichneChrom(netzPost, m, [0.95, 0.96, 0.97], 0.09);
				if (q.gummi) zeichneObjekt(netzPostGummi, m, [0.90, 0.92, 0.94], 0.50, 0, 0.0, false);
			}
		});

		// Fallziele - sie sinken sichtbar ins Feld
		binde(matTeile);
		ZIELE.forEach(function (z) {
			var m = modellFuer(z.x, z.y, -0.028 * z.sinken, Math.atan2(z.ny, z.nx), 1);
			var steh = z.gruppe === "steh";
			var f = steh ? (z.an ? [0.98, 0.80, 0.14] : [0.62, 0.52, 0.20])
			      : z.farbe === "#C8202B" ? [0.86, 0.16, 0.20] : [0.95, 0.50, 0.12];
			zeichneObjekt(netzZiel, m, f, 0.20, z.unten ? 0 : 0.10, 0.04, true,
			              steh ? FELD.stehziel : FELD.fallziel);
		});
		binde(matFeld);

		// Flipper: zuerst die Schatten, um die Achse mitgedreht und in
		// Lichtrichtung versetzt; sie schreiben keine Tiefe, der Koerper deckt
		// sie. Zwei Lagen: der Kontaktschatten dicht am Fuss und ein weiterer,
		// schwaecherer Schlagschatten (Flipper 17 mm hoch -> Richtung * 10 mm).
		pass.setPipeline(pipeSchatten);
		binde(matFlipperSchatten);
		FL.forEach(function (f) {
			[[FLIPPER_SCHATTEN_VERSATZ, FLIPPER_SCHATTEN_ALPHA], [FLIPPER_SCHLAG_VERSATZ, FLIPPER_SCHLAG_ALPHA]]
				.forEach(function (lage) {
					var ms = modellFuer(f.p[0] + SCHATTEN_RICHTUNG[0] * lage[0],
					                    f.p[1] + SCHATTEN_RICHTUNG[1] * lage[0],
					                    SCHATTEN_H, f.w, 1);
					zeichneObjekt(netzFlipperSchatten, ms, [0, 0, 0], 0, 0, 0, false, null, lage[1] * schattenFaktor);
				});
		});
		pass.setPipeline(pipeOpak);
		binde(matFeld);
		FL.forEach(function (f) {
			var m = modellFuer(f.p[0], f.p[1], FLIPPER_HOEHE, f.w, 1);
			var anteil = Math.abs(f.w - f.ruhe) / Math.abs(f.voll - f.ruhe);
			// Heller Kunststoff-Schlaeger (Task 5, vorher Metall 0.70 mit
			// Feldspiegelung), dunkler Gummi als schmales Band
			zeichneObjekt(netzFlipper, m, FLIPPER_FARBE, FLIPPER_RAUHEIT, 0, FLIPPER_METALL, false);
			zeichneObjekt(netzFlipperGummi, m,
			              [0.20 + 0.28*anteil, 0.62 + 0.24*anteil, 0.24], 0.55, anteil * 0.22, 0.0, false);
		});

		// Abschussstange: laengs der Rinne (Task 5). Ursprung an der
		// Stangenwurzel am Knauf, lokal y zeigt nach der Drehung ROT_X_M90
		// den Tisch hinauf; Spitze PLUNGER_LAENGE weiter, in Ruhe bei
		// PLUNGER_SPITZE, beim Ziehen um PLUNGER_HUB zum Spieler.
		var pz = plunger.zug * PLUNGER_HUB + plunger.rueck * -0.012;
		var mp = mul(mPlunger, modellFuer((SCHACHT_X + W) / 2, PLUNGER_SPITZE - PLUNGER_LAENGE - pz, KUGEL_R, 0, 1), ROT_X_M90);
		zeichneChrom(netzPlunger, mp, [0.95, 0.96, 0.97], 0.06);
		zeichneObjekt(netzPlungerKnauf, mp, [0.72, 0.14, 0.16], 0.26, 0, 0.05, false);

		if (ph.aktiv) {
			// Schatten zuerst, damit die Kugel darueber liegt. Mitte um R in
			// Lichtrichtung versetzt, laengs dieser Richtung gestreckt: die
			// erste Spalte der Modellmatrix ist die gedrehte lokale x-Achse.
			pass.setPipeline(pipeSchatten);
			binde(matSchatten);
			var ms = modellFuer(ph.p[0] + SCHATTEN_RICHTUNG[0] * KUGEL_R,
			                    ph.p[1] + SCHATTEN_RICHTUNG[1] * KUGEL_R,
			                    SCHATTEN_H, SCHATTEN_WINKEL, KUGEL_SCHATTEN_HALB);
			ms[0] *= KUGEL_SCHATTEN_STRECKUNG; ms[1] *= KUGEL_SCHATTEN_STRECKUNG; ms[2] *= KUGEL_SCHATTEN_STRECKUNG;
			zeichneObjekt(netzGlimm, ms, [0, 0, 0], 0, 0, 0, false, null, KUGEL_SCHATTEN_ALPHA * schattenFaktor);

			pass.setPipeline(pipeOpak);
			binde(matFeld);
			var mk = modellFuer(ph.p[0], ph.p[1], KUGEL_R, 0, 1);
			zeichneChrom(netzKugel, mk, [0.96, 0.97, 0.98], 0.035, undefined, KUGEL_LAMPE_GLANZ);
		}

		// Lampen und Inserts: nach allen Schatten und nach der Kugel (sie
		// deckt die Sprites unter sich ueber die Tiefe), vor den Platten.
		zeichneLampen();
		binde(matFeld);

		// Slingshot-Platten: bedruckt, leicht durchscheinend, von unten
		// beleuchtet - beim Treffer glueht die ganze Platte auf.
		pass.setPipeline(pipeAlpha);
		binde(matTeile);
		slingshots.forEach(function (sl) {
			var blitz = sl.gummiSeg && sl.gummiSeg.blitz ? sl.gummiSeg.blitz : 0;
			zeichneObjekt(sl.platte, einheit, [1, 1, 1], 0.10, 0.10 + blitz * 0.9, 0.04, true,
			              FELD.slingPlatte, 0.90);
		});

		// Chromleisten auf Glashoehe
		pass.setPipeline(pipeOpak);
		binde(matFeld);
		zeichneChrom(netzLeisten, einheit, [0.95, 0.96, 0.97], 0.08);

		/*
		 * Glasscheibe: nur die Spiegelung der Umgebung, additiv ueber das Bild,
		 * stark gedaempft (Stellschraube GLAS_SPIEGEL), ohne Koerperfarbe, ohne
		 * Rueckseitenentfernung und ohne Tiefenschreiben - wie
		 * gl.blendColor(0,0,0,k) mit blendFunc(CONSTANT_ALPHA, ONE).
		 */
		pass.setPipeline(pipeGlas);
		pass.setBlendConstant({ r: GLAS_SPIEGEL, g: GLAS_SPIEGEL, b: GLAS_SPIEGEL, a: GLAS_SPIEGEL });
		zeichneObjekt(netzScheibe, einheit, [0, 0, 0], 0.03, 0, 0.0, false, null, 1.0);
		pass.end();
		pass = null;

		schleierUeberlagern(enc);

		// Uniforms erst jetzt hochladen: writeBuffer steht in der Warteschlange
		// vor dem Kommandopuffer, die Draws sehen die frischen Werte.
		device.queue.writeBuffer(rahmenBuf, 0, rahmenDaten);
		device.queue.writeBuffer(objBuf, 0, objDaten, 0, slot * SLOT_FLOATS);
		device.queue.submit([enc.finish()]);

		bilder++; fpsZeit += dt;
		if (fpsZeit >= 0.4) { fps = Math.round(bilder / fpsZeit); bilder = 0; fpsZeit = 0; }
		zeigeStand();
		requestAnimationFrame(zeichne);
	}

	function zeigeStand() {
		var geschw = Math.hypot(ph.v[0], ph.v[1]);
		// Auf Beruehrungsgeraeten gibt es keine Leertaste - dort heisst es LAUNCH
		var beruehrung = matchMedia("(pointer: coarse)").matches;
		var kopf = spiel.zustand === "attract" ? "<b>" + (beruehrung ? "TAP LAUNCH" : "PRESS SPACE") + " TO START</b>"
		         : spiel.zustand === "aus" ? "<b>GAME OVER</b> &middot; " + (beruehrung ? "launch" : "space") + " for a new game"
		         : "score <b>" + spiel.punkte.toLocaleString("en-US") + "</b> · ball <b>" +
		           spiel.ball + "/" + (spiel.baelle + spiel.ball - 1) + "</b> · bonus <b>" +
		           spiel.bonus + "×" + spiel.multi() + "</b>";
		lesefeld.innerHTML =
			kopf + (spiel.meldung ? "  ·  <b>" + spiel.meldung + "</b>" : "") + "\n" +
			"ball " + geschw.toFixed(2) + " m/s · spin " + Math.abs(ph.w).toFixed(0) + " rad/s · " +
			ph.segmente.length + " segments · " + SCHEIBE.length + " discs · " +
			"720 Hz swept solver · <i>" + fps + " fps</i>" + (PHYSIK_ALT ? " · physik alt" : "") +
			(SLING.abweichend ? " · " + SLING.kurz : "") +
			(plunger.laedt ? "  ·  plunger " + Math.round(plunger.zug * 100) + "%" : "");
	}

	// ------------------------------------------------------------- Eingabe
	function setzeFlipper(seite, an) {
		FL.forEach(function (f) { if (f.seite === seite) f.ziel = an ? 1 : 0; });
	}
	function starttaste() {
		if (spiel.zustand !== "attract" && spiel.zustand !== "aus") return false;
		starteSpiel();
		// Sofort anzeigen statt aufs naechste Bild zu warten: der Start ist die
		// eine Stelle, an der eine Verzoegerung wie ein verschluckter
		// Tastendruck wirkt.
		zeigeStand();
		return true;
	}

	addEventListener("keydown", function (e) {
		if (e.repeat) return;
		if (e.key === "ArrowLeft")  { setzeFlipper(-1, true); e.preventDefault(); }
		if (e.key === "ArrowRight") { setzeFlipper( 1, true); e.preventDefault(); }
		if (e.key === " ") {
			e.preventDefault();
			if (!starttaste()) plunger.laedt = true;
		}
		if (e.key === "n" || e.key === "N") ruettel = (Math.random() - 0.5) * 3.4;
		if (e.key === "r" || e.key === "R") starteSpiel();
	});
	addEventListener("keyup", function (e) {
		if (e.key === "ArrowLeft")  setzeFlipper(-1, false);
		if (e.key === "ArrowRight") setzeFlipper( 1, false);
		if (e.key === " ") abschuss();
	});

	var beruehrung = document.getElementById("touch");
	if (matchMedia("(pointer: coarse)").matches) {
		beruehrung.hidden = false;
		function knopf(id, an, aus) {
			var el = document.getElementById(id);
			el.addEventListener("pointerdown", function (e) { e.preventDefault(); an(); });
			el.addEventListener("pointerup", function (e) { e.preventDefault(); aus(); });
			el.addEventListener("pointercancel", aus);
		}
		knopf("tLeft",  function () { setzeFlipper(-1, true); }, function () { setzeFlipper(-1, false); });
		knopf("tRight", function () { setzeFlipper( 1, true); }, function () { setzeFlipper( 1, false); });
		knopf("tPlunge", function () { if (!starttaste()) plunger.laedt = true; }, abschuss);
	}

	// -------------------------------------------------------------- Start
	/*
	 * Aufbau. Logo, Umgebungskarten, Holz und Leder werden gleichzeitig
	 * geladen, WebGPU faehrt parallel hoch; gebaut wird, wenn alles da ist.
	 * Die Umgebung besteht aus zwoelf Bildern - sie nacheinander zu holen
	 * kostete unnoetig Zeit beim Start.
	 */
	var UMGEBUNG_MARKE = "40";
	var bild = new Image(), logo = null, umgebung = null, holzBild = null, lederBild = null, offen = 5;

	/*
	 * Oberflaechenbilder aus umgebung/: der erste Name, der laedt, gewinnt.
	 * Jedes Bild wird auf 512 x 512 gebracht - so bleiben Kachel und Mipmaps
	 * wie in der WebGL-Fassung.
	 */
	function ladeBild(namen, fertig) {
		var i = 0;
		function versuch() {
			if (i >= namen.length) { fertig(null); return; }
			var b = new Image();
			b.onload = function () { fertig(b); };
			b.onerror = function () { i++; versuch(); };
			b.src = namen[i] + "?v=" + UMGEBUNG_MARKE;
		}
		versuch();
	}
	function quadrat(quelle) {
		var cv = document.createElement("canvas");
		cv.width = cv.height = 512;
		var g = cv.getContext("2d");
		g.drawImage(quelle, 0, 0, 512, 512);
		return cv;
	}
	function flaecheEinfarbig(farbe) {
		var cv = document.createElement("canvas");
		cv.width = cv.height = 4;
		var g = cv.getContext("2d");
		g.fillStyle = farbe; g.fillRect(0, 0, 4, 4);
		return cv;
	}
	ladeBild(["umgebung/holz.jpg", "umgebung/holz.png"], function (b) { holzBild = b; vielleichtBauen(); });
	ladeBild(["umgebung/leder.jpg", "umgebung/leder.png"], function (b) { lederBild = b; vielleichtBauen(); });
	function vielleichtBauen() {
		if (--offen > 0) return;
		baueAlles();
	}
	bild.onload = bild.onerror = function () {
		logo = bild.complete && bild.naturalWidth ? bild : null;
		vielleichtBauen();
	};
	bild.src = "logo.png";
	window.ladeUmgebung({ marke: UMGEBUNG_MARKE }, function (u) {
		umgebung = u;
		if (u.fehlend.length) {
			// Nicht stillschweigend flau weiterleuchten - wer die Karten
			// vergisst, soll es in der Konsole sehen.
			console.warn("Umgebungskarten fehlen:", u.fehlend.join(", "));
		}
		vielleichtBauen();
	});

	/*
	 * WebGPU hochfahren (starteWebGPU steht in index.html, mit dem Rueckfall
	 * auf webgl.html). Pipelines und Shader entstehen in einem Validierungs-
	 * Scope: ein Fehler geht in die Konsole und fuehrt zur WebGL-Fassung.
	 */
	(async function () {
		var g = await starteWebGPU(leinwand);
		if (!g) return;                          // Rueckfall laeuft bereits
		device = g.device; context = g.context; leinwandFormat = g.format;
		device.pushErrorScope("validation");
		await baueGrafik();
		var fehler = await device.popErrorScope();
		if (fehler) { console.error("WebGPU:", fehler.message); rueckfall("validation error"); return; }
		vielleichtBauen();
	})().catch(function (e) {
		console.error("WebGPU:", e && e.message ? e.message : String(e));
		rueckfall("init failed");
	});

	async function baueAlles() {
		device.pushErrorScope("validation");

		var kunst = window.spielfeldKunst({ tisch: T, logo: logo,
		                                    xRand: FELD_XR, y0: FELD_Y0, y1: FELD_Y1 });
		LAMPEN      = kunst.lampen;
		matFeld     = macheTextur(kunst.canvas, true);
		matSchatten = macheTextur(zeichneSchattenbild(), false);
		matFlipperSchatten = macheTextur(zeichneFlipperSchattenbild(), false);
		matGlimm    = macheTextur(zeichneGlimmbild(), false);
		// Insert-Maske: halbe Feldaufloesung, zwei Kanaele (R Form, G Form mit
		// Druck), mit Mipmaps (1.3 MiB)
		var maskeCv = document.createElement("canvas");
		maskeCv.width = 512; maskeCv.height = 1024;
		matEinsatz  = macheTextur(kunst.einsatzMaske(maskeCv), true, false, "rg8unorm");
		matLampe    = { bg: device.createBindGroup({ layout: bglLampe, entries: [
			{ binding: 0, resource: matGlimm.ansicht }, { binding: 1, resource: matGlimm.samp },
			{ binding: 2, resource: matEinsatz.ansicht }, { binding: 3, resource: matEinsatz.samp } ] }) };
		glas        = window.backglasKunst({ logo: logo, verhaeltnis: 2 * GLAS_HALB / GLAS_HOCH });
		// Mit Mipmaps (Task 5, BACKGLAS_STUFEN); nach jedem Neuzeichnen in
		// zeichne() im Bild-Encoder erneuert (macheGlasBlits)
		matGlas     = macheTextur(glas.canvas, true, false, undefined, BACKGLAS_STUFEN);
		macheGlasBlits();
		matTeile    = macheTextur(window.teileKunst({ tisch: T }), true);
		texEnv      = macheWuerfel(umgebung.seiten, true);
		texKuppel   = macheWuerfel(umgebung.diffus, false);
		macheLichtkarte();
		// Die Wuerfel liegen fest in der Bild-Bindgruppe - sie wechseln nie
		bgRahmen = device.createBindGroup({ layout: bglRahmen, entries: [
			{ binding: 0, resource: { buffer: rahmenBuf } },
			{ binding: 1, resource: texEnv.view },
			{ binding: 2, resource: texKuppel.view },
			{ binding: 3, resource: sampWuerfel },
			{ binding: 4, resource: matEinsatz.ansicht }, { binding: 5, resource: matEinsatz.samp },
			{ binding: 6, resource: texLicht.view }, { binding: 7, resource: sampWuerfel } ] });
		// Feldebene und Feld-uv fuer die Spiegelung, einmal gesetzt (Versaetze
		// aus dem Rahmen-Struct geteilt durch vier)
		rahmenF.set(welt(0, 0, 0), 52);
		rahmenF.set(weltRichtung(0, 0, 1), 56);
		rahmenF.set(weltRichtung(1, 0, 0), 60);
		rahmenF.set(weltRichtung(0, 1, 0), 64);
		rahmenF.set([FELD_XR, FELD_Y0, FELD_Y1, 0], 68);
		// Rinnenrechteck wie baueRinnenNetz, links um das Rohr der Rinnenwand
		// erweitert: das Rohr selbst wird nicht gespiegelt, und unter ihm ist
		// Holz die bessere Naeherung als Feldgrund (sonst traegt die Kugel in
		// der Rinne links unten eine navyblaue Sichel). Rechts bis zum Rand
		// der Feldtextur (Task 5: sonst navyblauer Keil rechts unten in der
		// Kugel, zwischen Rinnenbrett und Aussenwand).
		rahmenF.set([SCHACHT_X - 2 * BANDE_R, FELD_XR, -0.02, BOGEN_Y + 0.02], 72);
		FELD        = window.TEILE_FELD;

		netzFeld     = baueSpielfeldNetz();
		netzBanden   = baueBandenNetz();
		netzDraht    = baueDrahtNetz();
		netzApron    = baueApronNetz();
		var schrank  = baueSchrankNetz();
		netzSchrank  = schrank.wand;
		netzSchrankKante = schrank.kante;
		matSchrank   = macheTextur(window.schrankKunst({ logo: logo }), true);
		matHolz      = macheTextur(holzBild ? quadrat(holzBild) : window.holzKunst(), true, true);
		matLeder     = macheTextur(lederBild ? quadrat(lederBild) : flaecheEinfarbig("#1E2130"), true, true);
		netzSchrankInnen = schrank.innen;
		netzKnopfRing  = drehkoerper([[0.0170, 0.000], [0.0170, 0.0045], [0.0125, 0.0065]], 20);
		netzKnopfKappe = drehkoerper([[0.0000, 0.0045], [0.0115, 0.0050], [0.0105, 0.0105], [0.0000, 0.0135]], 20, { unten: false });
		netzSchraube   = drehkoerper([[0.0040, 0.000], [0.0040, 0.0022], [0.0026, 0.0038], [0.0000, 0.0044]], 12);
		netzKugel    = baueKugelNetz(KUGEL_R, 20, 30);
		netzFlipperSchatten = baueFlipperSchattenNetz();
		netzGlimm    = baueGlimmNetz();
		netzBoden    = baueBodenNetz();
		matBoden     = macheTextur(zeichneBodenbild(), false);
		netzBein     = drehkoerper([[0.017, 0.000], [0.017, 0.700], [0.021, 0.720]], 12);
		netzRinne    = baueRinnenNetz();
		netzScheibe  = baueScheibenNetz();
		netzLeisten  = baueLeistenNetz();
		netzGlas       = baueBackglasNetz(GLAS_HALB, GLAS_HOCH, 0, 0);
		netzGlasRahmen = baueBackglasNetz(GLAS_HALB + BACKBOX_RAHMEN_SEITE,
		                                  GLAS_HOCH + BACKBOX_RAHMEN_OBEN + BACKBOX_RAHMEN_UNTEN,
		                                  0.010, BACKBOX_RAHMEN_UNTEN);

		// Pop-Bumper: Teller, Kegelkoerper, Kappe und Stange - vier Teile,
		// damit jedes seine eigene Farbe und sein eigenes Leuchten bekommt.
		netzBumperFuss = drehkoerper([[0.0000, 0.0000], [0.0290, 0.0020], [0.0290, 0.0055],
		                              [0.0230, 0.0075]], 26);
		netzBumperKoerper = drehkoerper([[0.0230, 0.0075], [0.0200, 0.0130], [0.0170, 0.0290],
		                                 [0.0175, 0.0340]], 26, { unten: false, oben: false });
		netzBumperKappe = drehkoerper([[0.0000, 0.0335], [0.0140, 0.0345], [0.0195, 0.0390],
		                               [0.0170, 0.0455], [0.0000, 0.0490]], 26, { unten: false });

		netzPost      = drehkoerper([[0.0055, 0.0000], [0.0055, 0.0330], [0.0038, 0.0360]], 16);
		netzPostGummi = ringkoerper(0.0075, 0.0040, 0.0155, 20, 10);

		// Flipper (Task 5): Rundungen geglaettet, Fase am oberen Rand; der
		// Gummi geglaettet ohne Fase
		var umriss = flipperUmriss(MASS.flipperL, FLIPPER_R1, FLIPPER_R2, 12);
		netzFlipper      = prisma(umriss, 0.0000, 0.0170, { glatt: true, fase: FLIPPER_FASE });
		netzFlipperGummi = prisma(flipperUmriss(MASS.flipperL, 0.0124, 0.0078, 12), 0.0050, 0.0125, { glatt: true });

		// Fallziel: eine Platte quer zur Anspielrichtung, dahinter der Halter;
		// Kasten mit harten Kanten und 1 mm Fase oben
		netzZiel = prisma([[-0.0030, -0.0170], [0.0030, -0.0170], [0.0030, 0.0170],
		                   [-0.0030, 0.0170]], 0.0000, 0.0250, { fase: ZIEL_FASE });

		slingshots  = [baueSlingshot(-1), baueSlingshot(1)];
		netzPfosten = drehkoerper([[0.0045, 0.000], [0.0045, 0.0300]], 12);
		netzMutter  = drehkoerper([[0.0058, 0.0300], [0.0058, 0.0345], [0.0042, 0.0358]], 6);

		// Plunger: Stange entlang lokal y von der Wurzel (0) zur Spitze, der
		// Knauf dahinter (lokal y < 0, zum Spieler); gedreht in zeichne()
		netzPlunger      = drehkoerper([[0.0040, 0.0000], [0.0040, PLUNGER_LAENGE]], 12);
		netzPlungerKnauf = drehkoerper([[0.0000, -0.0180], [0.0110, -0.0140], [0.0110, -0.0020],
		                                [0.0060, 0.0000]], 16);

		var fehler = await device.popErrorScope();
		if (fehler) { console.error("WebGPU:", fehler.message); rueckfall("validation error"); return; }

		// Die Kugel liegt schon im Attract-Modus in der Rinne, wie an jedem
		// echten Geraet - und sie ist das einzige Stueck poliertes Chrom, an dem
		// man die Umgebung wirklich ablesen kann.
		kugelInSchacht();
		// Erstes Bild sofort zeichnen, nicht erst beim naechsten Bildwechsel.
		// `zeichne` meldet sich am Ende selbst wieder an.
		zuletzt = performance.now();
		zeichne(zuletzt);
	}

	// Lesezugriff fuer den Pruefstand: Spielzustand und Kugel in Zahlen.
	window.pinballDebug = {
		stand: function () {
			return { zustand: spiel.zustand, punkte: spiel.punkte, ball: spiel.ball,
			         aktiv: ph.aktiv, p: ph.p.slice(), v: ph.v.slice(),
			         geschwindigkeit: Math.hypot(ph.v[0], ph.v[1]),
			         spielzeit: spielzeit, fps: fps, lampen: LAMPEN.length, slots: slot,
			         // Draws je Bild: Objekte + Hintergrund + Lichtkarte samt Mipmaps + 4 Vollbild
			         // + Backglas-Blits (nur in Bildern mit Standaenderung)
			         draws: slot + 1 + LICHT_STUFEN + 4 + glasBlitsBild,
			         glasBlits: glasBlitsBild,
			         auge: augePos.slice(),
			         lichter: Array.prototype.slice.call(rahmenF, 4, 4 + 4 * rahmenI[3]),
			         feld: Array.prototype.slice.call(rahmenF, 52, 72) };
		},
		// Schatten von Kugel und Flippern skalieren (0 = aus) - fuer Bildpaare
		// mit und ohne, bei sonst gleichem Licht
		schatten: function (f) { schattenFaktor = f === undefined ? 1 : +f; return schattenFaktor; },
		// Lampen-Sprites (Insert und Hof) samt Lichtkarte (Inserts im
		// Spiegelbild) skalieren (0 = aus), die Punktlichter in fsNetz
		// bleiben - trennt die beiden Anteile im Bild
		sprites: function (f) { spriteFaktor = f === undefined ? 1 : +f; return spriteFaktor; },
		// Feldspiegelung in Kugel und Chrom: f <= 0.5 schaltet sie ab (nur
		// Umgebungskarte), darueber wirkt f als Faktor auf den Feldanteil
		spiegel: function (f) { spiegelFaktor = f === undefined ? 1 : +f; return spiegelFaktor; },
		// Lampen festhalten: id ist ein Index, "art", "art:nr" (einsatz:0),
		// "art:buchstabe" (bahn:V) oder "*" fuer alle; an = 0..1, null gibt
		// die Lampe wieder frei. Zurueck kommt die Zahl der betroffenen Lampen.
		lampe: function (id, an) {
			var n = 0;
			LAMPEN.forEach(function (lp, i) {
				var schl = lp.art + ":" + (lp.nr !== undefined ? lp.nr : lp.buchstabe !== undefined ? lp.buchstabe
			                        : lp.objekt && lp.objekt.id !== undefined ? lp.objekt.id : i);
				if (id === "*" || id === i || id === lp.art || id === schl) { lp.fest = an === undefined ? null : an; n++; }
			});
			return n;
		},
		lampen: function () {
			return LAMPEN.map(function (lp, i) {
				return { i: i, art: lp.art, nr: lp.nr, buchstabe: lp.buchstabe, x: lp.x, y: lp.y, r: lp.r, an: lp.an };
			});
		},
		// Kugel an einem Tischpunkt festhalten (null gibt sie frei) - fuer
		// Bilder der Kugel neben einer bestimmten Lampe
		kugel: function (x, y) { kugelFest = (x === null || x === undefined) ? null : [+x, +y]; return kugelFest; },
		// Kamera um einen Weltversatz verschieben: Auge (dx, dy, dz) und
		// Ziel (tx, ty, tz; ohne Angabe wie das Auge, die Blickrichtung
		// bleibt dann) - fuer Bilder von Stellen ausserhalb des Normalbilds,
		// etwa dem Plunger am Spielerende. Ohne Argumente zurueck auf 0.
		kamera: function (dx, dy, dz, tx, ty, tz) {
			kameraVersatz = [+dx || 0, +dy || 0, +dz || 0,
			                 tx === undefined ? +dx || 0 : +tx, ty === undefined ? +dy || 0 : +ty, tz === undefined ? +dz || 0 : +tz];
			return kameraVersatz;
		},
		// Tischpunkt (x, y, h) -> Bildpunkt der Leinwand, fuer Pixelmessungen
		bildpunkt: function (x, y, h) {
			var w = welt(x, y, h || 0), p = mul(m4(), projGpu, ansicht);
			var cx = p[0]*w[0] + p[4]*w[1] + p[8]*w[2] + p[12];
			var cy = p[1]*w[0] + p[5]*w[1] + p[9]*w[2] + p[13];
			var cw = p[3]*w[0] + p[7]*w[1] + p[11]*w[2] + p[15];
			return [(cx / cw * 0.5 + 0.5) * leinwand.width, (0.5 - cy / cw * 0.5) * leinwand.height];
		}
	};
})();
