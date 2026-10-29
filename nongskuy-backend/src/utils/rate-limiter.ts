// ============================================================
// RATE LIMITER — in-memory token bucket per user
// ============================================================

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Cek rate limit per user.
 * Max `maxPerMinute` request per menit.
 */
export function checkRateLimit(userId: string, maxPerMinute = 100): boolean {
	const now = Date.now();
	const bucket = buckets.get(userId);

	if (!bucket || now > bucket.resetAt) {
		buckets.set(userId, { count: 1, resetAt: now + 60000 });
		return true;
	}

	if (bucket.count >= maxPerMinute) {
		return false;
	}

	bucket.count++;
	return true;
}

/**
 * Reset rate limit untuk user (untuk testing/admin).
 */
export function resetRateLimit(userId: string): void {
	buckets.delete(userId);
}

/**
 * Cleanup bucket lama — dipanggil periodic biar tidak memory leak.
 */
export function cleanupBuckets(): void {
	const now = Date.now();
	for (const [key, bucket] of buckets.entries()) {
		if (now > bucket.resetAt) {
			buckets.delete(key);
		}
	}
}
