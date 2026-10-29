import { FCM, FcmOptions } from 'fcm-cloudflare-workers';

let fcmInstance: FCM | null = null;

export function getFcm(env: Env): FCM {
	if (fcmInstance) return fcmInstance;

	const serviceAccountJson = env.FIREBASE_SERVICE_ACCOUNT;
	if (!serviceAccountJson) {
		throw new Error('FIREBASE_SERVICE_ACCOUNT secret tidak di-set');
	}

	const sa = JSON.parse(serviceAccountJson);

	fcmInstance = new FCM(
		new FcmOptions({
			serviceAccount: sa,
			kvStore: env.NONGSKUY_FCM_CACHE,
		}),
	);

	return fcmInstance;
}

export async function sendToToken(
	env: Env,
	deviceToken: string,
	title: string,
	body: string,
	data?: Record<string, string>,
): Promise<boolean> {
	try {
		const fcm = getFcm(env);

		await fcm.sendToToken(
			{
				token: deviceToken,
				notification: {
					title,
					body,
				},
				data: data || {},
				android: {
					priority: 'high',
					notification: {
						channelId: 'nongskuy_messages',
						sound: 'default',
						icon: 'ic_notification', // ← pakai icon notif kita
					},
				},
			},
			deviceToken,
		);

		return true;
	} catch (e: any) {
		console.error('[FCM] Send error:', e?.message || e);
		return false;
	}
}
