// SGP4-Propagator, Nahbereichszweig (Umlaufzeit < 225 min). Port aus Vallados
// Referenz (Vallado, Crawford, Hujsak, Kelso, AIAA 2006-6753; SGP4.cpp
// "SGP4 Version 2020-07-13"): twoline2rv, initl, sgp4init und sgp4 mit den
// WGS-72-Konstanten, ziffergenau in derselben Rechenreihenfolge. Der
// Deep-Space-Zweig (dscom/dsinit/dspace/dpper) ist NICHT portiert: Saetze mit
// Umlaufzeit >= 225 min bekommen deepSpace = true, und propagiere liefert
// fehler 7 mit leeren Vektoren. Position/Geschwindigkeit kommen in TEME (km,
// km/s); temeNachEcef dreht um GMST ins erdfeste System, geodaetisch rechnet
// nach WGS84 in Breite/Laenge/Hoehe.
//
// Fehlercodes (satrec.fehler / ergebnis.fehler):
//   0 ok, 1 Exzentrizitaet ausser Bereich, 2 mittlere Bewegung <= 0,
//   4 Semilatus rectum < 0, 6 Satellit verfallen (Vektoren werden trotzdem
//   geliefert), 7 Deep-Space (nicht portiert), 8 TLE unlesbar.
//   3 und 5 kommen nur im Deep-Space- bzw. im alten Sub-Orbital-Check vor.
(function (window) {
	"use strict";
	var PI = Math.PI, ZWEI_PI = 2 * PI, GRAD = PI / 180;
	var XPDOTP = 1440 / ZWEI_PI;      // Umlaeufe/Tag -> rad/min: n / XPDOTP
	var X2O3 = 2 / 3, TEMP4 = 1.5e-12;

	// getgravconst('wgs72') - die Konstanten, mit denen TLEs erzeugt werden
	var R_ERDE = 6378.135, MU = 398600.8;
	var XKE = 60 / Math.sqrt(R_ERDE * R_ERDE * R_ERDE / MU), TUMIN = 1 / XKE;
	var J2 = 0.001082616, J3 = -0.00000253881, J4 = -0.00000165597, J3OJ2 = J3 / J2;

	// ---- TLE lesen ----------------------------------------------------------

	// Pruefsumme: Ziffern der Spalten 1-68 summieren, jedes Minus zaehlt 1,
	// modulo 10 muss die Ziffer in Spalte 69 herauskommen.
	function pruefsumme(zeile) {
		if (typeof zeile !== "string" || zeile.length < 69) return false;
		var summe = 0;
		for (var i = 0; i < 68; i++) {
			var c = zeile.charCodeAt(i);
			if (c >= 48 && c <= 57) summe += c - 48;
			else if (c === 45) summe += 1;
		}
		var pruef = zeile.charCodeAt(68) - 48;
		return pruef >= 0 && pruef <= 9 && summe % 10 === pruef;
	}

	// Feld mit implizitem Dezimalpunkt und Exponent, z. B. " 11848-3" ->
	// 0.11848e-3 oder "-30915-6" -> -0.30915e-6. Vorzeichen in Spalte `von`,
	// fuenf Ziffern, zwei Zeichen Exponent. Leerstellen gelten als 0 (Vallado).
	function expFeld(zeile, von) {
		var vz = zeile.charAt(von);
		var mant = parseFloat("0." + zeile.slice(von + 1, von + 6).replace(/ /g, "0"));
		var exp = parseInt(zeile.slice(von + 6, von + 8), 10);
		if (isNaN(exp)) exp = 0;
		return (vz === "-" ? -mant : mant) * Math.pow(10, exp);
	}

	// Vallado days2mdhms + jday: Jahr (zweistellig) und Tag des Jahres mit
	// Bruchteil -> Julianisches Datum. Jahre < 57 liegen in 2000..2056.
	function epocheNachJd(jahr2, tage) {
		var jahr = jahr2 < 57 ? 2000 + jahr2 : 1900 + jahr2;
		var monate = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		if (jahr % 4 === 0) monate[2] = 29;   // reicht fuer 1957..2056
		var tagImJahr = Math.floor(tage), i = 1, summe = 0;
		while (tagImJahr > summe + monate[i] && i < 12) { summe += monate[i]; i++; }
		var mon = i, tag = tagImJahr - summe;
		var temp = (tage - tagImJahr) * 24, std = Math.floor(temp);
		temp = (temp - std) * 60;
		var min = Math.floor(temp), sek = (temp - min) * 60;
		var jd = 367 * jahr - Math.floor((7 * (jahr + Math.floor((mon + 9) / 12))) * 0.25) +
		         Math.floor(275 * mon / 9) + tag + 1721013.5;
		var jdFrac = (sek + min * 60 + std * 3600) / 86400;
		return jd + jdFrac;
	}

	// twoline2rv: feste Spalten wie in Vallados Einleseroutine (0-basiert).
	// Unlesbar = fehler 8 (Task 12c: das doppelte Feld 'unlesbar' entfaellt;
	// sgp4init wird dann nicht aufgerufen, fehler bleibt 8).
	var UNLESBAR = 8;
	function leseTle(zeile1, zeile2) {
		var s = { fehler: 0, deepSpace: false };
		if (typeof zeile1 !== "string" || typeof zeile2 !== "string" ||
		    zeile1.length < 61 || zeile2.length < 63 ||
		    zeile1.charAt(0) !== "1" || zeile2.charAt(0) !== "2") {
			s.fehler = UNLESBAR; return s;
		}
		s.satnum = zeile1.slice(2, 7).trim();
		s.klassifikation = zeile1.charAt(7);
		s.intldesg = zeile1.slice(9, 17).trim();
		s.epochJahr = parseInt(zeile1.slice(18, 20), 10);
		s.epochTage = parseFloat(zeile1.slice(20, 32));
		s.ndot = parseFloat(zeile1.slice(33, 43));          // Umlaeufe/Tag^2, Dezimalpunkt steht
		s.nddot = expFeld(zeile1, 44);                       // Umlaeufe/Tag^3, implizit
		s.bstar = expFeld(zeile1, 53);                       // 1/Erdradius, implizit
		s.ephtype = parseInt(zeile1.slice(62, 63), 10);
		s.elnum = parseInt(zeile1.slice(64, 68), 10);
		s.inclo = parseFloat(zeile2.slice(8, 16)) * GRAD;
		s.nodeo = parseFloat(zeile2.slice(17, 25)) * GRAD;
		s.ecco = parseFloat("0." + zeile2.slice(26, 33).replace(/ /g, "0"));
		s.argpo = parseFloat(zeile2.slice(34, 42)) * GRAD;
		s.mo = parseFloat(zeile2.slice(43, 51)) * GRAD;
		s.noKozai = parseFloat(zeile2.slice(52, 63)) / XPDOTP;   // rad/min, wie in der TLE (Kozai)
		s.revnum = parseInt(zeile2.slice(63, 68), 10);
		if (![s.epochJahr, s.epochTage, s.inclo, s.nodeo, s.ecco, s.argpo, s.mo, s.noKozai, s.bstar, s.ndot, s.nddot].every(isFinite)) {
			s.fehler = UNLESBAR; return s;
		}
		// in SGP4-Einheiten: rad/min^2 bzw. rad/min^3 (nur mitgefuehrt)
		s.ndot = s.ndot / (XPDOTP * 1440);
		s.nddot = s.nddot / (XPDOTP * 1440 * 1440);
		s.epocheJd = epocheNachJd(s.epochJahr, s.epochTage);
		return s;
	}

	// ---- sgp4init mit initl (Nahbereich) -------------------------------------

	function sgp4init(s) {
		s.isimp = 0; s.aycof = 0; s.con41 = 0; s.cc1 = 0; s.cc4 = 0; s.cc5 = 0;
		s.d2 = 0; s.d3 = 0; s.d4 = 0; s.delmo = 0; s.eta = 0; s.argpdot = 0;
		s.omgcof = 0; s.sinmao = 0; s.t = 0; s.t2cof = 0; s.t3cof = 0; s.t4cof = 0;
		s.t5cof = 0; s.x1mth2 = 0; s.x7thm1 = 0; s.mdot = 0; s.nodedot = 0;
		s.xlcof = 0; s.xmcof = 0; s.nodecf = 0;
		s.fehler = 0; s.deepSpace = false;
		s.am = s.em = s.im = s.Om = s.om = s.mm = s.nm = 0;

		var ss = 78 / R_ERDE + 1;
		var qzms2ttemp = (120 - 78) / R_ERDE;
		var qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;

		/* initl: Hilfsgroessen zur Epoche und Kozai -> Brouwer */
		var eccsq = s.ecco * s.ecco, omeosq = 1 - eccsq, rteosq = Math.sqrt(omeosq);
		var cosio = Math.cos(s.inclo), cosio2 = cosio * cosio;
		var ak = Math.pow(XKE / s.noKozai, X2O3);
		var d1 = 0.75 * J2 * (3 * cosio2 - 1) / (rteosq * omeosq);
		var del = d1 / (ak * ak);
		var adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81));
		del = d1 / (adel * adel);
		s.no = s.noKozai / (1 + del);            // no_unkozai (Brouwer), rad/min
		var ao = Math.pow(XKE / s.no, X2O3);
		var sinio = Math.sin(s.inclo);
		var po = ao * omeosq;
		var con42 = 1 - 5 * cosio2;
		s.con41 = -con42 - cosio2 - cosio2;
		var posq = po * po;
		var rp = ao * (1 - s.ecco);
		// gsto (Sternzeit zur Epoche) braucht nur der Deep-Space-Zweig - entfaellt.

		s.a = Math.pow(s.no * TUMIN, -2 / 3);
		s.alta = s.a * (1 + s.ecco) - 1;
		s.altp = s.a * (1 - s.ecco) - 1;

		if (omeosq >= 0 || s.no >= 0) {
			s.isimp = 0;
			if (rp < 220 / R_ERDE + 1) s.isimp = 1;
			var sfour = ss, qzms24 = qzms2t;
			var perige = (rp - 1) * R_ERDE;

			/* unter 156 km Perigaeum werden s und qoms2t angepasst */
			if (perige < 156) {
				sfour = perige - 78;
				if (perige < 98) sfour = 20;
				var qzms24temp = (120 - sfour) / R_ERDE;
				qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp;
				sfour = sfour / R_ERDE + 1;
			}
			var pinvsq = 1 / posq;

			var tsi = 1 / (ao - sfour);
			s.eta = ao * s.ecco * tsi;
			var etasq = s.eta * s.eta;
			var eeta = s.ecco * s.eta;
			var psisq = Math.abs(1 - etasq);
			var coef = qzms24 * Math.pow(tsi, 4);
			var coef1 = coef / Math.pow(psisq, 3.5);
			var cc2 = coef1 * s.no * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) +
				0.375 * J2 * tsi / psisq * s.con41 * (8 + 3 * etasq * (8 + etasq)));
			s.cc1 = s.bstar * cc2;
			var cc3 = 0;
			if (s.ecco > 1e-4) cc3 = -2 * coef * tsi * J3OJ2 * s.no * sinio / s.ecco;
			s.x1mth2 = 1 - cosio2;
			s.cc4 = 2 * s.no * coef1 * ao * omeosq *
				(s.eta * (2 + 0.5 * etasq) + s.ecco * (0.5 + 2 * etasq) - J2 * tsi / (ao * psisq) *
				(-3 * s.con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) +
				0.75 * s.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * s.argpo)));
			s.cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
			var cosio4 = cosio2 * cosio2;
			var temp1 = 1.5 * J2 * pinvsq * s.no;
			var temp2 = 0.5 * temp1 * J2 * pinvsq;
			var temp3 = -0.46875 * J4 * pinvsq * pinvsq * s.no;
			s.mdot = s.no + 0.5 * temp1 * rteosq * s.con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
			s.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) +
				temp3 * (3 - 36 * cosio2 + 49 * cosio4);
			var xhdot1 = -temp1 * cosio;
			s.nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
			s.omgcof = s.bstar * cc3 * Math.cos(s.argpo);
			s.xmcof = 0;
			if (s.ecco > 1e-4) s.xmcof = -X2O3 * coef * s.bstar / eeta;
			s.nodecf = 3.5 * omeosq * xhdot1 * s.cc1;
			s.t2cof = 1.5 * s.cc1;
			// Division durch null bei Neigung 180 Grad vermeiden
			if (Math.abs(cosio + 1) > 1.5e-12) s.xlcof = -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / (1 + cosio);
			else s.xlcof = -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / TEMP4;
			s.aycof = -0.5 * J3OJ2 * sinio;
			var delmotemp = 1 + s.eta * Math.cos(s.mo);
			s.delmo = delmotemp * delmotemp * delmotemp;
			s.sinmao = Math.sin(s.mo);
			s.x7thm1 = 7 * cosio2 - 1;

			/* Deep Space: hier nur erkennen, nicht rechnen */
			if (ZWEI_PI / s.no >= 225) {
				s.deepSpace = true;
				s.isimp = 1;
				return s;
			}

			/* hoehere Widerstandsglieder, nur wenn nicht vereinfacht */
			if (s.isimp !== 1) {
				var cc1sq = s.cc1 * s.cc1;
				s.d2 = 4 * ao * tsi * cc1sq;
				var temp = s.d2 * tsi * s.cc1 / 3;
				s.d3 = (17 * ao + sfour) * temp;
				s.d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * s.cc1;
				s.t3cof = s.d2 + 2 * cc1sq;
				s.t4cof = 0.25 * (3 * s.d3 + s.cc1 * (12 * s.d2 + 10 * cc1sq));
				s.t5cof = 0.2 * (3 * s.d4 + 12 * s.cc1 * s.d3 + 6 * s.d2 * s.d2 + 15 * cc1sq * (2 * s.d2 + cc1sq));
			}
		}

		/* einmal zur Epoche rechnen - setzt fehler wie im Original */
		sgp4(s, 0);
		return s;
	}

	// ---- sgp4 (Nahbereich) ----------------------------------------------------
	// Liefert { r, v } in km und km/s (TEME) oder null; s.fehler traegt den Code.

	function sgp4(s, tsince) {
		var vkmpersec = R_ERDE * XKE / 60;
		s.t = tsince;
		s.fehler = 0;

		/* saekulare Stoerungen durch Schwerefeld und Widerstand */
		var xmdf = s.mo + s.mdot * s.t;
		var argpdf = s.argpo + s.argpdot * s.t;
		var nodedf = s.nodeo + s.nodedot * s.t;
		var argpm = argpdf, mm = xmdf;
		var t2 = s.t * s.t;
		var nodem = nodedf + s.nodecf * t2;
		var tempa = 1 - s.cc1 * s.t;
		var tempe = s.bstar * s.cc4 * s.t;
		var templ = s.t2cof * t2;
		var temp;

		if (s.isimp !== 1) {
			var delomg = s.omgcof * s.t;
			var delmtemp = 1 + s.eta * Math.cos(xmdf);
			var delm = s.xmcof * (delmtemp * delmtemp * delmtemp - s.delmo);
			temp = delomg + delm;
			mm = xmdf + temp;
			argpm = argpdf - temp;
			var t3 = t2 * s.t, t4 = t3 * s.t;
			tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
			tempe = tempe + s.bstar * s.cc5 * (Math.sin(mm) - s.sinmao);
			templ = templ + s.t3cof * t3 + t4 * (s.t4cof + s.t * s.t5cof);
		}

		var nm = s.no, em = s.ecco, inclm = s.inclo;
		if (nm <= 0) { s.fehler = 2; return null; }
		var am = Math.pow(XKE / nm, X2O3) * tempa * tempa;
		nm = XKE / Math.pow(am, 1.5);
		em = em - tempe;
		if (em >= 1 || em < -0.001) { s.fehler = 1; return null; }
		if (em < 1e-6) em = 1e-6;
		mm = mm + s.no * templ;
		var xlm = mm + argpm + nodem;
		var emsq = em * em;
		temp = 1 - emsq;

		nodem = nodem % ZWEI_PI;
		argpm = argpm % ZWEI_PI;
		xlm = xlm % ZWEI_PI;
		mm = (xlm - argpm - nodem) % ZWEI_PI;

		// einfach gemittelte Bahnelemente merken (Diagnose)
		s.am = am; s.em = em; s.im = inclm; s.Om = nodem; s.om = argpm; s.mm = mm; s.nm = nm;

		var sinim = Math.sin(inclm), cosim = Math.cos(inclm);

		/* im Nahbereich keine Mond-Sonne-Periodik */
		var ep = em, xincp = inclm, argpp = argpm, nodep = nodem, mp = mm;
		var sinip = sinim, cosip = cosim;

		/* langperiodische Glieder */
		var axnl = ep * Math.cos(argpp);
		temp = 1 / (am * (1 - ep * ep));
		var aynl = ep * Math.sin(argpp) + temp * s.aycof;
		var xl = mp + argpp + nodep + temp * s.xlcof * axnl;

		/* Kepler-Gleichung; sin/cos stammen wie im Original aus dem letzten
		   Durchlauf vor der letzten Korrektur */
		var u = (xl - nodep) % ZWEI_PI;
		var eo1 = u, tem5 = 9999.9, ktr = 1, sineo1 = 0, coseo1 = 1;
		while (Math.abs(tem5) >= 1e-12 && ktr <= 10) {
			sineo1 = Math.sin(eo1);
			coseo1 = Math.cos(eo1);
			tem5 = 1 - coseo1 * axnl - sineo1 * aynl;
			tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
			if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
			eo1 = eo1 + tem5;
			ktr = ktr + 1;
		}

		/* kurzperiodische Vorbereitung */
		var ecose = axnl * coseo1 + aynl * sineo1;
		var esine = axnl * sineo1 - aynl * coseo1;
		var el2 = axnl * axnl + aynl * aynl;
		var pl = am * (1 - el2);
		if (pl < 0) { s.fehler = 4; return null; }
		var rl = am * (1 - ecose);
		var rdotl = Math.sqrt(am) * esine / rl;
		var rvdotl = Math.sqrt(pl) / rl;
		var betal = Math.sqrt(1 - el2);
		temp = esine / (1 + betal);
		var sinu = am / rl * (sineo1 - aynl - axnl * temp);
		var cosu = am / rl * (coseo1 - axnl + aynl * temp);
		var su = Math.atan2(sinu, cosu);
		var sin2u = (cosu + cosu) * sinu;
		var cos2u = 1 - 2 * sinu * sinu;
		temp = 1 / pl;
		var temp1 = 0.5 * J2 * temp;
		var temp2 = temp1 * temp;

		/* kurzperiodische Glieder */
		var mrt = rl * (1 - 1.5 * temp2 * betal * s.con41) + 0.5 * temp1 * s.x1mth2 * cos2u;
		su = su - 0.25 * temp2 * s.x7thm1 * sin2u;
		var xnode = nodep + 1.5 * temp2 * cosip * sin2u;
		var xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
		var mvt = rdotl - nm * temp1 * s.x1mth2 * sin2u / XKE;
		var rvdot = rvdotl + nm * temp1 * (s.x1mth2 * cos2u + 1.5 * s.con41) / XKE;

		/* Richtungsvektoren */
		var sinsu = Math.sin(su), cossu = Math.cos(su);
		var snod = Math.sin(xnode), cnod = Math.cos(xnode);
		var sini = Math.sin(xinc), cosi = Math.cos(xinc);
		var xmx = -snod * cosi, xmy = cnod * cosi;
		var ux = xmx * sinsu + cnod * cossu;
		var uy = xmy * sinsu + snod * cossu;
		var uz = sini * sinsu;
		var vx = xmx * cossu - cnod * sinsu;
		var vy = xmy * cossu - snod * sinsu;
		var vz = sini * cossu;

		/* Position und Geschwindigkeit in km und km/s */
		var r = [(mrt * ux) * R_ERDE, (mrt * uy) * R_ERDE, (mrt * uz) * R_ERDE];
		var v = [(mvt * ux + rvdot * vx) * vkmpersec, (mvt * uy + rvdot * vy) * vkmpersec, (mvt * uz + rvdot * vz) * vkmpersec];

		// verfallen: unter der Erdoberflaeche
		if (mrt < 1) s.fehler = 6;
		return { r: r, v: v };
	}

	// ---- oeffentliche Schnittstelle --------------------------------------------

	function init(zeile1, zeile2) {
		var s = leseTle(zeile1, zeile2);
		if (s.fehler === UNLESBAR) return s;
		return sgp4init(s);
	}

	// Minuten seit der Epoche -> { r, v, fehler }. Bei fehler 6 (verfallen)
	// bleiben die Vektoren erhalten, bei allen anderen Fehlern sind sie leer.
	function propagiereMinuten(satrec, tsince) {
		if (satrec.fehler === UNLESBAR) return { r: [], v: [], fehler: UNLESBAR };   // sgp4 setzt nie 8, nur leseTle
		if (satrec.deepSpace) return { r: [], v: [], fehler: 7 };
		var rv = sgp4(satrec, tsince);
		if (!rv) return { r: [], v: [], fehler: satrec.fehler };
		return { r: rv.r, v: rv.v, fehler: satrec.fehler };
	}
	function propagiere(satrec, jd) {
		return propagiereMinuten(satrec, (jd - satrec.epocheJd) * 1440);
	}

	// ECI/TEME -> ECEF: Drehung um +GMST um die z-Achse (wie in den Constraints)
	function temeNachEcef(r, gmst) {
		var c = Math.cos(gmst), s = Math.sin(gmst);
		return [r[0] * c + r[1] * s, -r[0] * s + r[1] * c, r[2]];
	}

	// ECEF (km) -> geodaetische Breite, Laenge (rad) und Hoehe (km), WGS84,
	// iterativ mit Bowring-Startwert; fuenf Schritte reichen fuer < 1 mm.
	function geodaetisch(p) {
		var a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
		var lon = Math.atan2(p[1], p[0]), rho = Math.hypot(p[0], p[1]);
		var lat = Math.atan2(p[2], rho * (1 - e2)), N = a;
		for (var i = 0; i < 5; i++) {
			N = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
			lat = Math.atan2(p[2] + e2 * N * Math.sin(lat), rho);
		}
		var hoehe = Math.abs(Math.cos(lat)) > 1e-8 ? rho / Math.cos(lat) - N
		                                            : Math.abs(p[2]) / Math.abs(Math.sin(lat)) - N * (1 - e2);
		return { lat: lat, lon: lon, hoehe: hoehe };
	}

	// Bodenpunkt zu einem Julianischen Datum: propagieren, um GMST drehen,
	// geodaetisch umrechnen. Braucht Zeit.gmst aus zeit.js.
	function bodenpunkt(satrec, jd) {
		var e = propagiere(satrec, jd);
		if (e.r.length !== 3) return { lat: NaN, lon: NaN, hoehe: NaN, fehler: e.fehler };
		var g = geodaetisch(temeNachEcef(e.r, window.Zeit.gmst(jd)));
		g.fehler = e.fehler;
		return g;
	}

	function umlaufzeitMin(satrec) { return ZWEI_PI / satrec.no; }
	function neigungGrad(satrec) { return satrec.inclo / GRAD; }

	window.SGP4 = {
		pruefsumme: pruefsumme, init: init,
		propagiere: propagiere, propagiereMinuten: propagiereMinuten,
		temeNachEcef: temeNachEcef, geodaetisch: geodaetisch, bodenpunkt: bodenpunkt,
		umlaufzeitMin: umlaufzeitMin, neigungGrad: neigungGrad,
		R_ERDE: R_ERDE
	};
})(window);
