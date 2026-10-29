// ============================================================
// SECURITY UTILITIES — XSS, SSTI, SSRF, Validation
// ============================================================

/**
 * Sanitasi text — hapus tag HTML, karakter kontrol, trim.
 */
export function sanitizeText(input: string, maxLength = 500): string {
	if (typeof input !== 'string') return '';
	let cleaned = input
		.replace(/<[^>]*>/g, '')
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
		.trim();

	if (cleaned.length > maxLength) {
		cleaned = cleaned.substring(0, maxLength);
	}
	return cleaned;
}

/**
 * Deteksi SSTI pattern.
 */
const SSTI_PATTERNS = [/\{\{.*\}\}/, /\{%.*%\}/, /\$\{.*\}/, /<%.*%>/];

export function containsSsti(text: string): boolean {
	return SSTI_PATTERNS.some((p) => p.test(text));
}

/**
 * Validasi NIM — hanya angka, 6-15 digit.
 */
export function isValidNim(nim: any): { ok: boolean; error?: string } {
	if (!nim || typeof nim !== 'string') {
		return { ok: false, error: 'NIM wajib diisi' };
	}
	if (!/^\d+$/.test(nim)) {
		return { ok: false, error: 'NIM hanya boleh berisi angka' };
	}
	if (nim.length < 6 || nim.length > 15) {
		return { ok: false, error: 'NIM harus 6-15 digit' };
	}
	return { ok: true };
}

/**
 * Validasi URL — blokir SSRF ke internal.
 */
export function isSafeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') return false;
		const h = parsed.hostname.toLowerCase();
		if (
			h === 'localhost' ||
			h === '127.0.0.1' ||
			h === '0.0.0.0' ||
			h.startsWith('10.') ||
			h.startsWith('192.168.') ||
			h.startsWith('169.254.') ||
			/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h) ||
			h.endsWith('.internal') ||
			h.endsWith('.local')
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Validasi payload pesan chat.
 */
export function validateMessage(data: any): {
	ok: boolean;
	data?: { sender: string; content: string; type: string };
	error?: string;
} {
	if (!data || typeof data !== 'object') {
		return { ok: false, error: 'Payload tidak valid' };
	}
	const { sender, content, type } = data;

	if (typeof sender !== 'string' || sender.trim().length === 0) {
		return { ok: false, error: 'Sender wajib diisi' };
	}
	if (sender.length > 50) {
		return { ok: false, error: 'Sender terlalu panjang' };
	}
	if (typeof content !== 'string' || content.trim().length === 0) {
		return { ok: false, error: 'Pesan tidak boleh kosong' };
	}
	if (content.length > 1000) {
		return { ok: false, error: 'Pesan terlalu panjang (max 1000 karakter)' };
	}

	const cleaned = sanitizeText(content, 1000);
	if (cleaned.length === 0) {
		return { ok: false, error: 'Pesan tidak valid' };
	}
	if (containsSsti(cleaned)) {
		return { ok: false, error: 'Pesan mengandung karakter terlarang' };
	}

	const msgType = ['text', 'image'].includes(type) ? type : 'text';

	return {
		ok: true,
		data: {
			sender: sanitizeText(sender, 50),
			content: cleaned,
			type: msgType,
		},
	};
}

/**
 * Validasi payload lokasi.
 */
export function validateLocation(data: any): {
	ok: boolean;
	data?: any;
	error?: string;
} {
	if (!data || typeof data !== 'object') {
		return { ok: false, error: 'Payload tidak valid' };
	}
	const { user_id, name, faculty, latitude, longitude } = data;

	const nimCheck = isValidNim(user_id);
	if (!nimCheck.ok) return { ok: false, error: nimCheck.error };

	if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
		return { ok: false, error: 'Latitude tidak valid' };
	}
	if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
		return { ok: false, error: 'Longitude tidak valid' };
	}

	return {
		ok: true,
		data: {
			user_id: sanitizeText(user_id, 15),
			name: sanitizeText(name || 'Unknown', 100),
			faculty: sanitizeText(faculty || 'Unknown', 100),
			latitude,
			longitude,
		},
	};
}

/**
 * Validasi payload grup.
 */
export function validateGroupName(name: any): { ok: boolean; value?: string; error?: string } {
	if (!name || typeof name !== 'string') {
		return { ok: false, error: 'Nama grup wajib diisi' };
	}
	const cleaned = sanitizeText(name, 50);
	if (cleaned.length === 0) {
		return { ok: false, error: 'Nama grup tidak boleh kosong' };
	}
	if (containsSsti(cleaned)) {
		return { ok: false, error: 'Nama grup mengandung karakter terlarang' };
	}
	return { ok: true, value: cleaned };
}

/**
 * Validasi daftar anggota grup.
 */
export function validateMembers(members: any): { ok: boolean; value?: string[]; error?: string } {
	if (!Array.isArray(members)) {
		return { ok: false, error: 'Members harus berupa array' };
	}
	if (members.length > 50) {
		return { ok: false, error: 'Maksimal 50 anggota' };
	}
	for (const m of members) {
		const check = isValidNim(m);
		if (!check.ok) {
			return { ok: false, error: `NIM tidak valid: ${m}` };
		}
	}
	return { ok: true, value: members.map((m) => sanitizeText(m, 15)) };
}
