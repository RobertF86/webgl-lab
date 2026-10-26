(function (window) {
	"use strict";
	var J2000 = 2451545.0, TAG_MS = 86400000, ZWEI_PI = Math.PI * 2;
	function jd(ms) { return ms / TAG_MS + 2440587.5; }
	function ms(jd) { return (jd - 2440587.5) * TAG_MS; }
	function T(jd) { return (jd - J2000) / 36525; }
	// Mittlere Greenwich-Sternzeit, IAU 1982 (Meeus 12.4), UT1 = UTC angenommen
	function gmst(jd) {
		var t = T(jd);
		var grad = 280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * t * t - t * t * t / 38710000;
		grad = grad % 360; if (grad < 0) grad += 360;
		return grad * Math.PI / 180;
	}
	function zwei(n) { return (n < 10 ? "0" : "") + n; }
	function formatUTC(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + zwei(d.getUTCMonth() + 1) + "-" + zwei(d.getUTCDate()) + " " + zwei(d.getUTCHours()) + ":" + zwei(d.getUTCMinutes()) + ":" + zwei(d.getUTCSeconds()) + " UTC"; }
	function formatLokal(ms) { var d = new Date(ms); return zwei(d.getHours()) + ":" + zwei(d.getMinutes()) + ":" + zwei(d.getSeconds()) + " local"; }
	function tage(jd, jdEpoche) { return jd - jdEpoche; }
	// Simulationsuhr: sim = echt + versatz. Bei Rate r waechst der Versatz je
	// echter Millisekunde um (r - 1); bei Rate 1 bleibt er, deshalb aendert ein
	// riesiges dt (Tab war verborgen) nichts - die Uhr folgt der echten Zeit.
	// Task 19 (M1): im Zeitraffer ruckt die Simulationszeit je Schritt hoechstens
	// um rate * SCHRITT_MAX_MS - ein riesiges dt (Tab verborgen, Bildschleife
	// stand) liess sie sonst um Rate x Wartezeit springen (1 h verborgen bei x100
	// = +4 Tage). Formel versatz += rate * min(dt, max) - dt: fuer dt <= 1 s genau
	// (r - 1) * dt wie bisher; die Pause (Rate 0) haelt mit -dt weiter exakt.
	// anhalten()/fortsetzen() (visibilitychange in tracker.js): im Zeitraffer steht
	// die Simulationszeit, solange der Tab verborgen ist, und laeuft danach vom
	// selben Punkt weiter; Rate und Anzeige bleiben. Bei Rate 1 (live oder "real
	// time" mit Versatz) und in der Pause tun beide nichts: die Uhr folgt dort
	// Date.now() bzw. haelt ohnehin. Jede Bedienung loest ein Anhalten zuerst.
	var SCHRITT_MAX_MS = 1000;
	function Uhr(echtMs) { this.echtMs = echtMs || Date.now; this.rate = 1; this.versatzMs = 0; this.gehaltenMs = null; }
	Uhr.prototype.jetztMs = function () { return this.gehaltenMs !== null ? this.gehaltenMs : this.echtMs() + this.versatzMs; };
	Uhr.prototype.schritt = function (dtEchtMs) {
		if (this.gehaltenMs !== null || this.rate === 1) return;
		var dt = Math.max(0, +dtEchtMs || 0);
		this.versatzMs += this.rate * Math.min(dt, SCHRITT_MAX_MS) - dt;
	};
	Uhr.prototype.anhalten = function () {
		if (this.gehaltenMs !== null || this.rate === 1 || this.rate === 0) return false;
		this.gehaltenMs = this.echtMs() + this.versatzMs;
		return true;
	};
	Uhr.prototype.fortsetzen = function () {
		if (this.gehaltenMs === null) return false;
		this.versatzMs = this.gehaltenMs - this.echtMs();
		this.gehaltenMs = null;
		return true;
	};
	Uhr.prototype.angehalten = function () { return this.gehaltenMs !== null; };
	Uhr.prototype.live = function () { this.gehaltenMs = null; this.rate = 1; this.versatzMs = 0; };
	Uhr.prototype.pause = function () { this.fortsetzen(); this.rate = 0; };
	Uhr.prototype.setzeRate = function (r) { this.fortsetzen(); this.rate = r; };
	Uhr.prototype.springe = function (deltaMs) { this.fortsetzen(); this.versatzMs += deltaMs; };
	Uhr.prototype.istLive = function () { return this.rate === 1 && this.versatzMs === 0; };
	window.Zeit = { jd: jd, ms: ms, T: T, gmst: gmst, formatUTC: formatUTC, formatLokal: formatLokal, tage: tage, Uhr: Uhr, J2000: J2000, SCHRITT_MAX_MS: SCHRITT_MAX_MS };
})(window);
