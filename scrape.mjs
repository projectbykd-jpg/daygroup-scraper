// daygroup-scraper — scraper Laporan Harian "Lap Admin" untuk Day-Group Panel.
// Jalan di GitHub Actions (VM Linux, tanpa batas subrequest). Port dari Apps
// Script PANEL AUTO (scrapeStepRegister / scrapeStepReportAgent / scrapeStepCheckCoin).
//
// Alur: ambil kredensial + tanggal dari panel-worker (token sekali-pakai) ->
// scrape -> kirim hasil balik ke panel-worker -> disimpan ke D1.

const JOB_ID = process.env.JOB_ID;
const CALLBACK = String(process.env.CALLBACK || "").replace(/\/+$/, "");
const KEY = process.env.KEY;

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function api(action, body) {
	const r = await fetch(`${CALLBACK}/api`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, jobId: JOB_ID, key: KEY, ...body }),
	});
	const t = await r.text();
	let j;
	try {
		j = JSON.parse(t);
	} catch {
		throw new Error(`callback ${action} bukan JSON: ${t.slice(0, 200)}`);
	}
	if (j && j.success === false) throw new Error(j.message || `callback ${action} gagal`);
	return j;
}

// ---------------------------------------------------------------------------
// HTTP helper (paralel per batch)
// ---------------------------------------------------------------------------
function makeHeaders(cookie) {
	let c = String(cookie || "").trim();
	if (!/phpsessid/i.test(c) && !c.includes("=")) c = "PHPSESSID=" + c;
	return {
		Cookie: c,
		"User-Agent": UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	};
}
async function getText(url, headers) {
	try {
		const r = await fetch(url, { headers, redirect: "manual" });
		return await r.text();
	} catch {
		return "";
	}
}
async function getAll(urls, headers, batch = 25) {
	const out = [];
	for (let i = 0; i < urls.length; i += batch) {
		const chunk = urls.slice(i, i + batch);
		const res = await Promise.allSettled(chunk.map((u) => getText(u, headers)));
		for (const s of res) out.push(s.status === "fulfilled" ? s.value : "");
	}
	return out;
}

/**
 * Halaman 1..N sampai satu halaman tidak menambah data baru.
 * urlOf(p) -> url; parseFn(html) -> array baris; keyOf(row) -> string dedup.
 * firstHtml boleh diberikan (hasil fetch halaman 1) supaya tidak diambil 2x.
 */
async function pagesUntilEmpty(urlOf, headers, parseFn, keyOf, firstHtml, { chunk = 20, max = 5000 } = {}) {
	const rows = [];
	const seen = new Set();
	let pagesScanned = 0;
	const eat = (html) => {
		let added = 0;
		for (const r of parseFn(html)) {
			const k = keyOf(r);
			if (seen.has(k)) continue;
			seen.add(k);
			rows.push(r);
			added++;
		}
		return added;
	};
	let start = 1;
	if (firstHtml != null) {
		eat(firstHtml);
		pagesScanned = 1;
		start = 2;
	}
	let emptyStreak = 0; // halaman berturut yang 0 baris data mentah
	for (let page = start; page <= max; page += chunk) {
		const urls = [];
		for (let p = page; p < page + chunk && p <= max; p++) urls.push(urlOf(p));
		const htmls = await getAll(urls, headers, chunk);
		let addedInChunk = 0;
		let hitEnd = false;
		for (const h of htmls) {
			pagesScanned++;
			if (!h || h.length < 400 || /silakan login|please login|Password<\/label>/i.test(h)) {
				hitEnd = true;
				break;
			}
			const parsed = parseFn(h);
			const a = eat(h);
			addedInChunk += a;
			if (parsed.length === 0) {
				emptyStreak++;
				if (emptyStreak >= 3) { hitEnd = true; break; }
			} else {
				emptyStreak = 0;
			}
		}
		// Berhenti hanya kalau ketemu ujung (login/empty streak) ATAU 1 chunk penuh
		// (20 halaman) tanpa 1 pun baris baru — server benar-benar mengulang / habis.
		if (hitEnd || addedInChunk === 0) break;
	}
	rows._pagesScanned = pagesScanned;
	return rows;
}

// ---------------------------------------------------------------------------
// Parser helpers (port persis)
// ---------------------------------------------------------------------------
function cleanHtmlText(html) {
	return String(html || "")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#39;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();
}
function parseMoneyValue(value) {
	const text = String(value || "").trim();
	if (!text || !/\d/.test(text)) return null;
	const cleaned = text.replace(/[^\d.\-]/g, "");
	if (!cleaned) return null;
	const n = parseFloat(cleaned);
	return Number.isFinite(n) ? n : null;
}
function parseAgentPlayerList(html) {
	const players = [];
	const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
	for (const rowHtml of rows) {
		if (rowHtml.includes("<th") || /sub\s*total/i.test(rowHtml) || /total\s*:/i.test(rowHtml)) continue;
		const cells = [];
		const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
		let m;
		while ((m = re.exec(rowHtml)) !== null) cells.push(m[1]);
		if (cells.length < 6) continue;
		const noText = cleanHtmlText(cells[0]).trim();
		if (!/^\d+$/.test(noText)) continue;
		let userClean = cells[1]
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<br\s*\/?>[\s\S]*/i, "")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/gi, "")
			.trim();
		const um = userClean.match(/[a-zA-Z0-9_.-]+/);
		if (!um) continue;
		const userId = um[0].trim();
		const bl = ["userid", "sub", "total", "show", "noname", "nama", "bank", "tools", "page"];
		if (bl.includes(userId.toLowerCase()) || userId.length < 3) continue;
		let refClean = cleanHtmlText(cells[2]).trim().replace(/&nbsp;/gi, "").trim();
		const isNonRef = !refClean || refClean === "-" || refClean.toLowerCase() === "null" || refClean === "--";
		players.push({
			userId,
			referral: isNonRef ? "-" : refClean,
			type: isNonRef ? "Non Referral" : "With Referral",
		});
	}
	return players;
}
function parseHugoResponse(html) {
	if (!html) return { depo: 0, wd: 0 };
	const year = String(new Date().getFullYear());
	const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
	for (const rowHtml of rows) {
		const cells = [];
		const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
		let m;
		while ((m = re.exec(rowHtml)) !== null) cells.push(cleanHtmlText(m[1]));
		const yi = cells.findIndex((c) => new RegExp("(^|\\D)" + year + "(\\D|$)").test(c));
		if (yi === -1) continue;
		const nums = [];
		for (let j = yi + 1; j < cells.length; j++) {
			const v = parseMoneyValue(cells[j]);
			if (v !== null) nums.push(v);
			if (nums.length === 2) return { depo: nums[0], wd: nums[1] };
		}
	}
	return { depo: 0, wd: 0 };
}
function parseAgentOperatorRows(html, operatorName) {
	const results = [];
	const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
	for (const rowHtml of rows) {
		if (rowHtml.includes("<th")) continue;
		const cells = [];
		const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
		let m;
		while ((m = re.exec(rowHtml)) !== null) cells.push(cleanHtmlText(m[1]));
		if (cells.length >= 7 && /^\d+$/.test(cells[0])) {
			results.push({
				tanggalTerima: cells[1] || "",
				user: cells[2] || "",
				action: cells[3] || "",
				dariBank: cells[4] || "",
				tujuanBank: cells[5] || "",
				jumlah: cells[6] || "",
				status: cells[7] || "ACCEPT",
				operator: operatorName || cells[8] || "",
			});
		}
	}
	return results;
}
function parseCoinHtmlRows(html, filterKata) {
	const list = [];
	const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
	if (!rows || rows.length < 2) return list;
	for (const rowHtml of rows) {
		const cols = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
		if (!cols || cols.length < 7) continue;
		const c = cols.map((x) => cleanHtmlText(x).replace(/&nbsp;/g, " ").trim());
		if (!/^\d+$/.test(c[0])) continue;
		const info = c[2] || "";
		if (filterKata.some((k) => info.toLowerCase().includes(k.toLowerCase()))) continue;
		const isDep = info.toLowerCase().includes("deposit");
		const isWd = info.toLowerCase().includes("withdraw");
		const numVal = Math.abs(parseMoneyValue((c[5] || "0").replace(/-/g, "")) || 0);
		list.push({
			date: c[1] || "",
			info,
			to: c[3] || "",
			by: c[4] || "",
			deposit: isDep ? numVal : 0,
			withdraw: isWd ? numVal : 0,
			lastCoin: parseFloat((c[6] || "0").replace(/,/g, "")) || 0,
		});
	}
	return list;
}
function countCoinRows(html) {
	const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
	let n = 0;
	for (const r of rows) {
		const c = r.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
		if (c && c.length >= 7 && /^\d+$/.test(cleanHtmlText(c[0]).trim())) n++;
	}
	return n;
}
function coinKey(r) {
	return `${r.date}|${r.to}|${r.by}|${r.info}|${r.lastCoin}`;
}
function parseWithdrawPgaIdfRows(html) {
	const list = [];
	const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
	if (!rows || rows.length < 2) return list;
	for (const rowHtml of rows) {
		const cols = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
		if (!cols || cols.length < 7) continue;
		const c = cols.map((x) => cleanHtmlText(x).replace(/&nbsp;/g, " ").trim());
		if (!/^\d+$/.test(c[0])) continue;
		list.push({
			no: list.length + 1,
			date: c[1] || "",
			info: c[2] || "",
			to: c[3] || "",
			by: c[4] || "",
			nominal: Math.abs(parseMoneyValue((c[5] || "0").replace(/-/g, "")) || 0),
		});
	}
	return list;
}
function hitungTargetGrup(group) {
	const total = group.reduce((s, it) => s + it.value, 0);
	if (total === 0) return null;
	let target = group[0];
	const exact = group.find((it) => total - it.value === 0);
	if (exact) target = exact;
	return { id: target.id, total };
}

// ---------------------------------------------------------------------------
// MODUL 1: REGISTER
// ---------------------------------------------------------------------------
async function scrapeRegister(baseUrl, headers, startDate, endDate) {
	const s = startDate.split("-");
	const e = endDate.split("-");
	const d1 = `${s[2]}/${s[1]}/${s[0]}`;
	const d2 = `${e[2]}/${e[1]}/${e[0]}`;
	const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	let dateLabel = `${+s[2]} ${months[+s[1] - 1]} ${s[0]}`;
	if (startDate !== endDate) dateLabel += ` s/d ${+e[2]} ${months[+e[1] - 1]} ${e[0]}`;

	const listUrl = (p) =>
		`${baseUrl}/agentplayerlist.php?page=${p}&typ=1&sort=%5Biduser%5D&by=&bts=300&datecheck=1&date1=${d1}&date2=${d2}&cekparam=1&statusnya=`;
	const nonRefUrl = (p) =>
		`${baseUrl}/agentplayerlist.php?page=${p}&typ=1&sort=%5Biduser%5D&by=&bts=300&cari=Cari&statusnya=0&datecheck=1&date1=${d1}&date2=${d2}&cekparam=1&statusnya=0`;

	const [html1, htmlNR1] = await getAll([listUrl(1), nonRefUrl(1)], headers, 2);
	if (/silakan login|please login/i.test(html1)) throw new Error("Cookie Admin kedaluwarsa (Session Expired).");

	const pk = (r) => r.userId;
	const allPlayers = await pagesUntilEmpty(listUrl, headers, (h) => parseAgentPlayerList(h), pk, html1, { chunk: 20, max: 1500 });
	const rawNonRef = await pagesUntilEmpty(nonRefUrl, headers, (h) => parseAgentPlayerList(h), pk, htmlNR1, { chunk: 20, max: 1500 });

	// detail depo/wd per player
	const detail = {};
	if (allPlayers.length) {
		const urls = allPlayers.map((p) => `${baseUrl}/depo_user_det.php?user=${encodeURIComponent(p.userId)}`);
		const htmls = await getAll(urls, headers, 40);
		htmls.forEach((h, i) => {
			detail[allPlayers[i].userId] = parseHugoResponse(h);
		});
	}

	let daftarWithRef = 0,
		ndpNonRef = 0,
		ndpWithRef = 0;
	const registerData = allPlayers.map((p, idx) => {
		const det = detail[p.userId] || { depo: 0, wd: 0 };
		const isNonRef = p.type === "Non Referral";
		if (isNonRef) {
			if (det.depo > 0) ndpNonRef++;
		} else {
			daftarWithRef++;
			if (det.depo > 0) ndpWithRef++;
		}
		return {
			no: idx + 1,
			username: p.userId,
			deposit: det.depo || 0,
			withdraw: det.wd || 0,
			winLose: (det.depo || 0) - (det.wd || 0),
			type: p.type,
			referral: p.referral,
		};
	});
	let daftarNonRef = 0;
	rawNonRef.forEach((p) => {
		if (p.type === "Non Referral") daftarNonRef++;
	});

	return {
		dateLabel,
		registerData,
		registerSummary: { daftarNonRef, daftarWithRef, ndpNonRef, ndpWithRef },
	};
}

// ---------------------------------------------------------------------------
// MODUL 2: REPORT AGENT
// ---------------------------------------------------------------------------
async function scrapeReportAgent(baseUrl, headers, startDate, endDate) {
	const s = startDate.split("-");
	const e = endDate.split("-");
	const d1 = `${s[2]}-${s[1]}-${s[0]}`;
	const d2 = `${e[2]}-${e[1]}-${e[0]}`;

	const mainRes = await getText(`${baseUrl}/agen_operator.php?action=4&date1=${d1}&date2=${d2}`, headers);
	const rawOps = mainRes.match(/by=([^&"'>\s]+)/g) || [];
	const operators = [...new Set(rawOps.map((o) => o.split("=")[1]))].filter(Boolean);
	if (!operators.length) return { reportAgentData: [], operatorList: [] };

	const statusGroups = ["valstatus=1&valstatus2=3&valstatus3=7&valstatus4=6", "valstatus=2&valstatus2=4"];
	const first = [];
	operators.forEach((op) =>
		statusGroups.forEach((st) =>
			first.push({
				op,
				st,
				u: `${baseUrl}/agen_operatorpop.php?page=1&${st}&sta=ACCEPT&by=${encodeURIComponent(op)}&date1=${d1}&date2=${d2}`,
			}),
		),
	);
	const firstHtmls = await getAll(first.map((x) => x.u), headers, 30);
	let allData = [];
	// per (operator, statusgroup): halaman 1 sudah diambil, lanjut sampai kosong.
	const rowKey = (r) => `${r.tanggalTerima}|${r.user}|${r.action}|${r.jumlah}|${r.operator}`;
	for (let i = 0; i < first.length; i++) {
		const { op, st } = first[i];
		const urlOf = (p) =>
			`${baseUrl}/agen_operatorpop.php?page=${p}&${st}&sta=ACCEPT&by=${encodeURIComponent(op)}&date1=${d1}&date2=${d2}`;
		const rows = await pagesUntilEmpty(
			urlOf,
			headers,
			(h) => parseAgentOperatorRows(h, op),
			rowKey,
			firstHtmls[i],
			{ chunk: 15, max: 120 },
		);
		if (rows.length) allData = allData.concat(rows);
	}
	// dedup lintas statusgroup
	const seen = new Set();
	allData = allData.filter((r) => {
		const k = rowKey(r);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return { reportAgentData: allData, operatorList: operators };
}

// ---------------------------------------------------------------------------
// MODUL 3: CHECK KOIN + WITHDRAW (PGA-IDF)
// ---------------------------------------------------------------------------
async function scrapeCheckCoin(baseUrl, headers, startDate, endDate) {
	const coinUrl = (p) =>
		`${baseUrl}/his_coin.php?page=${p}&bts=500&info=&userto=&datex=${startDate}&datex2=${endDate}&userby=&cekparam=1`;

	const htmlP1 = await getText(coinUrl(1), headers);
	if (/Password|silakan login/i.test(htmlP1) || htmlP1.length < 500) {
		throw new Error("Cookie Admin kedaluwarsa saat menarik History Koin!");
	}
	// Ambil SEMUA halaman his_coin, TANPA filter — biar running-balance lengkap &
	// user lihat sampai baris terakhir. (server abaikan bts -> ~100 baris/halaman)
	const raw = await pagesUntilEmpty(
		coinUrl,
		headers,
		(h) => parseCoinHtmlRows(h, []),
		coinKey,
		htmlP1,
		{ chunk: 20, max: 6000 },
	);
	const pagesScanned = raw._pagesScanned || 0;

	// Baris yang DIKECUALIKAN dari perhitungan running-balance / selisih
	// (transaksi player-gateway & admin action yang tidak menyentuh coin agen).
	const EXCLUDE = ["deposit (pga)", "create master", "withdraw(pga-idf)", "reject(deposit)", "reject(withdraw)"];
	const isExcluded = (info) => EXCLUDE.some((k) => String(info || "").toLowerCase().includes(k));

	raw.reverse();
	const checkCoinData = [];
	const rawDiff = [];
	let prevCalcRow = null; // baris terakhir yang ikut perhitungan
	for (let i = 0; i < raw.length; i++) {
		const cur = raw[i];
		const excl = isExcluded(cur.info);
		let calc = cur.lastCoin;
		let diff = 0;
		if (!excl && prevCalcRow) {
			const prev = prevCalcRow;
			const info = (cur.info || "").toLowerCase();
			if (info.includes("deposit agent")) calc = prev.lastCoin + cur.deposit;
			else if (info.includes("withdraw agent")) calc = prev.lastCoin - cur.withdraw;
			else if (info.includes("deposit")) calc = prev.lastCoin - cur.deposit;
			else if (info.includes("withdraw")) calc = prev.lastCoin + cur.withdraw;
			else calc = prev.lastCoin - cur.deposit + cur.withdraw;
			diff = cur.lastCoin - calc;
			diff = Math.abs(diff) < 0.5 ? 0 : Math.round(diff);
		}
		checkCoinData.push({
			no: i + 1,
			date: cur.date,
			info: cur.info,
			to: cur.to,
			by: cur.by,
			deposit: cur.deposit,
			withdraw: cur.withdraw,
			lastCoin: cur.lastCoin,
			selisih: excl ? 0 : diff,
			calcCoin: excl ? cur.lastCoin : calc,
			excluded: excl,
		});
		if (!excl) {
			prevCalcRow = cur;
			rawDiff.push({ to: cur.to, selisih: diff });
		}
	}
	if (raw.length) {
		const fin = raw[raw.length - 1].lastCoin;
		checkCoinData.push({
			no: checkCoinData.length + 1,
			date: "-",
			info: "FINAL COIN",
			to: "-",
			by: "-",
			deposit: 0,
			withdraw: 0,
			lastCoin: fin,
			selisih: 0,
			calcCoin: fin,
			isFinalRow: true,
		});
	}

	const idList = [];
	let group = [];
	for (let i = 0; i < rawDiff.length; i++) {
		const v = Number(rawDiff[i].selisih || 0);
		if (v !== 0) {
			group.push({ id: i > 0 ? rawDiff[i - 1].to : rawDiff[i].to, value: v });
		} else if (group.length) {
			const g = hitungTargetGrup(group);
			if (g) idList.push(g);
			group = [];
		}
	}
	if (group.length) {
		const g = hitungTargetGrup(group);
		if (g) idList.push(g);
	}
	const idSelisihData = idList.map((it, i) => ({ no: i + 1, userId: it.id || "-", nominal: it.total }));
	const totalSelisih = idSelisihData.reduce((s, x) => s + x.nominal, 0);

	// withdraw PGA-IDF (semua halaman)
	const wdUrl = (p) =>
		`${baseUrl}/his_coin.php?info=Withdraw%28PGA-IDF%29&userto=&userby=&datex=${startDate}&datex2=${endDate}&nominal=&page=${p}`;
	const wdList = await pagesUntilEmpty(
		wdUrl,
		headers,
		(h) => parseWithdrawPgaIdfRows(h),
		(r) => `${r.date}|${r.to}|${r.by}|${r.nominal}`,
		null,
		{ chunk: 20, max: 3000 },
	);
	wdList.forEach((r, i) => (r.no = i + 1));
	const totalNominalWdPgaIdf = wdList.reduce((s, x) => s + x.nominal, 0);

	return {
		checkCoinData,
		idSelisihData,
		totalSelisih,
		withdrawPgaIdfData: wdList,
		totalNominalWdPgaIdf,
		pagesScanned,
		rawTotal: raw.length,
	};
}

// ---------------------------------------------------------------------------
// MODUL MOZART  (port scrapeStepMozart) — dijalankan di GitHub Actions karena
// API Mozart di belakang Cloudflare menolak request dari Cloudflare Worker.
// ---------------------------------------------------------------------------
function mozNum(v) {
	const n = Number(String(v === undefined || v === null ? 0 : v).replace(/[^0-9.\-]/g, ""));
	return isNaN(n) ? 0 : n;
}
function mozFindRows(json) {
	if (Array.isArray(json)) return json;
	let best = [];
	for (const k of Object.keys(json || {})) {
		const v = json[k];
		if (Array.isArray(v) && v.length >= best.length && (v.length === 0 || typeof v[0] === "object")) best = v;
		else if (v && typeof v === "object" && !Array.isArray(v)) {
			const nested = mozFindRows(v);
			if (nested.length > best.length) best = nested;
		}
	}
	return best;
}
function mozPick(obj, keys, fb) {
	for (const k of keys) {
		const v = obj[k];
		if (v !== undefined && v !== null && String(v).trim() !== "") return v;
	}
	return fb;
}
async function scrapeMozart(base, cookie, startDate, endDate) {
	const hm = String(base || "").match(/^(https?:\/\/[^/\s?#]+)/i);
	base = hm ? hm[1] : base.replace(/\/+$/, "");
	const host = base.replace(/^https?:\/\//, "");

	// API Mozart di belakang Cloudflare -> pakai browser asli + stealth untuk
	// melewati challenge, lalu fetch API DARI DALAM konteks browser (punya cf_clearance).
	let chromium;
	try {
		const pe = await import("playwright-extra");
		const stealth = (await import("puppeteer-extra-plugin-stealth")).default;
		chromium = pe.chromium;
		chromium.use(stealth());
	} catch {
		chromium = (await import("playwright")).chromium;
	}
	const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
	const ctx = await browser.newContext({
		userAgent: UA,
		locale: "en-US",
		viewport: { width: 1366, height: 768 },
	});
	// pasang cookie yang dikasih user (atoken, dan cf_clearance kalau ada)
	const cookies = String(cookie || "")
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.includes("="))
		.map((s) => {
			const i = s.indexOf("=");
			return { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim(), domain: host, path: "/" };
		});
	if (cookies.length) await ctx.addCookies(cookies);

	const page = await ctx.newPage();
	let warmed = false;
	const warmUp = async (ref) => {
		if (warmed) return;
		try {
			await page.goto(base + ref, { waitUntil: "domcontentloaded", timeout: 45000 });
		} catch {
			/* ignore */
		}
		// tunggu Cloudflare challenge kelar (maks ~25 detik)
		for (let t = 0; t < 12; t++) {
			const c = await page.content().catch(() => "");
			if (!/just a moment|checking your browser|cf-browser-verification|challenge-platform|enable javascript and cookies/i.test(c)) break;
			await page.waitForTimeout(2200);
		}
		await page.waitForTimeout(1500);
		warmed = true;
	};
	const fetchAll = async (path, ref, body) => {
		await warmUp(ref);
		const PAGE = 100;
		const rows = [];
		for (let pg = 0; pg < 100; pg++) {
			const res = await page.evaluate(
				async ({ url, payload }) => {
					try {
						const r = await fetch(url, {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json, text/plain, */*" },
							body: JSON.stringify(payload),
							credentials: "include",
						});
						const t = await r.text();
						return { status: r.status, text: t };
					} catch (e) {
						return { status: 0, text: String(e && e.message) };
					}
				},
				{ url: base + path, payload: { ...body, page_number: pg, page_size: PAGE } },
			);
			if (res.status === 401) throw new Error("MOZART 401: cookie/atoken ditolak / kedaluwarsa. Perbarui di Setting.");
			if (res.status === 403 || res.status === 503) {
				const title = await page.title().catch(() => "");
				const snip = String(res.text || "").replace(/\s+/g, " ").slice(0, 140);
				throw new Error(`MOZART ${res.status} diblokir Cloudflare walau via browser (stealth). page="${title}" resp="${snip}"`);
			}
			if (res.status >= 400 || res.status === 0) {
				if (pg === 0) throw new Error("MOZART error " + res.status + ": " + String(res.text).slice(0, 120));
				break;
			}
			let j;
			try {
				j = JSON.parse(res.text);
			} catch {
				if (pg === 0) throw new Error("Respons Mozart bukan JSON: " + String(res.text).slice(0, 120));
				break;
			}
			const f = mozFindRows(j);
			rows.push(...f);
			if (f.length < PAGE) break;
		}
		return rows;
	};
	let result;
	try {
		result = await mozartCollect(fetchAll, startDate, endDate);
	} finally {
		await browser.close().catch(() => {});
	}
	return result;
}

async function mozartCollect(fetchAll, startDate, endDate) {
	const depoRows = await fetchAll("/api/transactions/fetchTransaction", "/transactions", {
		panel_id: 0,
		start_date: startDate,
		end_date: endDate,
		not_done_filter: false,
		filter_by: null,
	});
	const wdRows = await fetchAll("/api/wd/fetchWithdrawal", "/wd", {
		panel_id: 0,
		start_date: startDate,
		end_date: endDate,
		filter_by: { minimum_amount: 0 },
	});
	const mozartDepo = depoRows.map((r) => ({
		date: String(mozPick(r, ["created_at", "date", "transaction_date", "trx_date", "waktu", "time"], "-")),
		username: String(mozPick(r, ["username", "user", "player", "user_id", "nama_user"], "-")),
		name: String(mozPick(r, ["name", "sender_name", "recipient", "nama", "account_name"], "-")),
		amount: mozNum(mozPick(r, ["amount", "nominal", "jumlah"], 0)),
		bank: String(mozPick(r, ["bank", "bank_name", "bank_code", "app"], "-")),
		accountNumber: String(mozPick(r, ["account_number", "rekening", "bank_account", "no_rek"], "-")),
		status: String(mozPick(r, ["status", "status_description", "state", "transaction_status"], "SUCCESS")),
	}));
	const mozartWd = wdRows.map((r) => ({
		date: String(mozPick(r, ["created_at", "date", "transaction_date", "trx_date", "waktu", "time"], "-")),
		username: String(mozPick(r, ["username", "user", "player", "user_id"], "-")),
		name: String(mozPick(r, ["name", "recipient", "recipient_name", "nama", "account_name"], "-")),
		amount: mozNum(mozPick(r, ["amount", "nominal", "jumlah"], 0)),
		bank: String(mozPick(r, ["destination", "bank", "bank_name", "bank_code", "app", "to_bank"], "-")),
		accountNumber: String(mozPick(r, ["account_number", "rekening", "bank_account", "no_rek"], "-")),
		status: String(mozPick(r, ["status", "status_description", "state", "transaction_status"], "-")),
	}));
	const sum = (a) => a.reduce((s, x) => s + (x.amount || 0), 0);
	return {
		mozartDepo,
		mozartWd,
		_mozartMeta: [
			{
				summary: {
					totalDepoRecords: mozartDepo.length,
					totalDepoAmount: sum(mozartDepo),
					totalWdRecords: mozartWd.length,
					totalWdAmount: sum(mozartWd),
					netAmount: sum(mozartDepo) - sum(mozartWd),
				},
			},
		],
	};
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
(async () => {
	if (!JOB_ID || !CALLBACK || !KEY) {
		console.error("env JOB_ID/CALLBACK/KEY wajib");
		process.exit(1);
	}
	let start;
	try {
		start = await api("lapJobStart", {});
	} catch (e) {
		console.error("gagal ambil job:", e.message);
		process.exit(1);
	}
	const { creds, params } = start;
	const kind = params.kind || "admin";

	if (kind === "mozart") {
		let mbase = String(creds.linkMozart || "").trim();
		if (!/^https?:\/\//i.test(mbase)) mbase = "https://" + mbase;
		try {
			const data = await scrapeMozart(mbase, String(creds.cookieMozart || "").trim(), params.startDate, params.endDate);
			await api("lapJobResult", { ok: true, data, errors: {} });
			console.log("MOZART SELESAI:", data.mozartDepo.length, "dp,", data.mozartWd.length, "wd");
		} catch (e) {
			await api("lapJobResult", { ok: false, data: {}, errors: { mozart: e.message } });
			console.error("mozart:", e.message);
			process.exit(1);
		}
		return;
	}

	// kind === 'admin'
	let baseUrl = String(creds.linkAdmin || "").trim();
	if (!/^https?:\/\//i.test(baseUrl)) baseUrl = "https://" + baseUrl;
	baseUrl = baseUrl.split("?")[0].split("#")[0].replace(/\/+$/, "");
	const hm = baseUrl.match(/^(https?:\/\/[^/\s]+)/i);
	if (hm) baseUrl = hm[1];
	const headers = makeHeaders(creds.cookieAdmin);
	const { startDate, endDate } = params;

	console.log(`Job ${JOB_ID}: ${baseUrl} ${startDate}..${endDate}`);
	const data = {};
	const errors = {};
	try {
		const reg = await scrapeRegister(baseUrl, headers, startDate, endDate);
		data.register = reg.registerData;
		data.registerMeta = [{ dateLabel: reg.dateLabel, summary: reg.registerSummary }];
		console.log(`register: ${reg.registerData.length} akun`);
	} catch (e) {
		errors.register = e.message;
		console.error("register:", e.message);
	}
	try {
		const ra = await scrapeReportAgent(baseUrl, headers, startDate, endDate);
		data.reportAgent = ra.reportAgentData;
		data.reportAgentMeta = [{ operatorList: ra.operatorList }];
		console.log(`reportAgent: ${ra.reportAgentData.length} baris`);
	} catch (e) {
		errors.reportAgent = e.message;
		console.error("reportAgent:", e.message);
	}
	try {
		const cc = await scrapeCheckCoin(baseUrl, headers, startDate, endDate);
		data.checkCoin = cc.checkCoinData;
		data.idSelisih = cc.idSelisihData;
		data.withdrawPgaIdf = cc.withdrawPgaIdfData;
		data.checkCoinMeta = [
			{
				totalSelisih: cc.totalSelisih,
				totalNominalWdPgaIdf: cc.totalNominalWdPgaIdf,
				pagesScanned: cc.pagesScanned,
				rawTotal: cc.rawTotal,
			},
		];
		console.log(
			`checkCoin: ${cc.checkCoinData.length} baris (${cc.pagesScanned} halaman), ${cc.idSelisihData.length} id selisih, ${cc.withdrawPgaIdfData.length} wd`,
		);
	} catch (e) {
		errors.checkCoin = e.message;
		console.error("checkCoin:", e.message);
	}

	const ok = Object.keys(data).filter((k) => Array.isArray(data[k]) && k !== "registerMeta").length > 0;
	await api("lapJobResult", { ok, data, errors });
	console.log(ok ? "SELESAI" : "GAGAL total");
	if (!ok) process.exit(1);
})();
